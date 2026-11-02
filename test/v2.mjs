// Run with:  node test/v2.mjs      (Node 22.18+ runs the .ts files directly)
// Checks src/crypto/{kdf2,aead,v2}.ts against test/reference2.mjs (node:crypto only).
import assert from "node:assert/strict";
import { argon2id as nobleArgon } from "@noble/hashes/argon2";
import { deriveMasterKey, forcedContext } from "../src/crypto/kdf2.ts";
import { gcmOpen, gcmSeal } from "../src/crypto/aead.ts";
import { base64Encode } from "../src/crypto/base64.ts";
import * as v2 from "../src/crypto/v2.ts";
import * as ref from "./reference2.mjs";

let passed = 0;
const ok = (n) => { passed++; console.log("  ok  " + n); };
const hex = (b) => Buffer.from(b).toString("hex");

// 1. Argon2id implementation sanity: RFC 9106 section 5.3 test vector
const rfc = nobleArgon(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2),
  { t: 3, m: 32, p: 4, dkLen: 32, key: new Uint8Array(8).fill(3), personalization: new Uint8Array(12).fill(4) });
assert.equal(hex(rfc), "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
ok("Argon2id matches the RFC 9106 test vector");

// 2. base64 without padding
for (let n = 0; n < 20; n++) {
  const b = new Uint8Array(n).map((_, i) => i * 11 + n);
  assert.equal(base64Encode(b, false), Buffer.from(b).toString("base64").replace(/=+$/, ""));
}
ok("base64 no-padding matches Android NO_PADDING");

// 3. sizes
assert.deepEqual(v2.PRESETS.map(v2.maxPlaintextBytes), [1455, 1439, 1407]);
ok("max plaintext bytes per preset: 1455 / 1439 / 1407");

// 4. AEAD with short tags + 192-bit keys vs node:crypto
import * as nc from "node:crypto";
for (const p of ref.PRESETS) {
  for (const len of [0, 1, 15, 16, 17, 100, 1000]) {
    const key = nc.randomBytes(p.keyBytes), nonce = nc.randomBytes(12), aad = nc.randomBytes(20), pt = nc.randomBytes(len);
    const c = nc.createCipheriv(`aes-${p.bits}-gcm`, key, nonce, { authTagLength: p.tagBytes });
    c.setAAD(aad);
    const want = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    assert.equal(hex(gcmSeal(key, nonce, aad, pt, p.tagBytes)), hex(want), `seal ${p.bits}/${len}`);
    assert.equal(hex(gcmOpen(key, nonce, aad, want, p.tagBytes)), hex(pt), `open ${p.bits}/${len}`);
    const bad = Buffer.from(want); bad[bad.length - 1] ^= 1;
    assert.equal(gcmOpen(key, nonce, aad, bad, p.tagBytes), null, "tag flip rejected");
    assert.equal(gcmOpen(key, nonce, Buffer.from("x"), want, p.tagBytes), null, "aad mismatch rejected");
  }
}
ok("AES-GCM 128/192/256 with 12/14/16-byte tags == node:crypto, tampering rejected");

// 5. key derivation vs reference (real 64 MiB Argon2id)
console.log("  .. Argon2id reference source:", ref.argonSource);
const t0 = Date.now();
const mk = await deriveMasterKey("correct horse battery staple");
console.log(`  .. plugin Argon2id (pure JS, this machine): ${Date.now() - t0} ms`);
assert.equal(hex(mk), hex(ref.master("correct horse battery staple", "dcenc2|user-key|v1")));
ok("user-key derivation matches reference");
const ctxKey = await deriveMasterKey("mojoen", { context: forcedContext("1562876012675465326") });
assert.equal(hex(ctxKey), hex(ref.master("mojoen", "dcenc2|ctx|forced|1562876012675465326")));
ok("forced-channel key derivation matches reference");
const uni = await deriveMasterKey("ﬁ①２３ pass wörd", { memoryKiB: 1024 });
assert.equal(hex(uni), hex(ref.master("ﬁ①２３ pass wörd", "dcenc2|user-key|v1", 1024)));
ok("NFKC password normalisation matches");

// 6. messages, both directions, all presets
const CH = "1562876012675465326", ME = "123456789012345678";
const texts = ["", "a", "hello", "éè 日本語", "emoji 🔒😀 mix", "x".repeat(60), "y".repeat(63), "z".repeat(64)];
for (const p of v2.PRESETS) {
  const rp = ref.PRESETS[p.index];
  const all = texts.concat(["m".repeat(v2.maxPlaintextBytes(p))]);
  for (const s of all) {
    const w = v2.encryptMessage(s, mk, p, CH, ME);
    assert.ok(w.length <= 2000, "fits in Discord");
    assert.equal(v2.decryptMessage(w, mk, CH, ME), s);
    assert.equal(ref.decMsg(w, Buffer.from(mk), CH, ME), s, "reference reads plugin output");
    const rw = ref.encMsg(s, Buffer.from(mk), rp, CH, ME);
    assert.equal(v2.decryptMessage(rw, mk, CH, ME), s, "plugin reads reference output");
    assert.equal(v2.messagePreset(w).index, p.index);
  }
  assert.throws(() => v2.encryptMessage("m".repeat(v2.maxPlaintextBytes(p) + 1), mk, p, CH, ME));
}
ok("messages round-trip with reference for AES-128/192/256 (empty .. max length, unicode)");

const w = v2.encryptMessage("secret", mk, v2.AES256, CH, ME);
assert.equal(v2.decryptMessage(w, mk, "999", ME), null, "wrong channel");
assert.equal(v2.decryptMessage(w, mk, CH, "999"), null, "wrong sender");
assert.equal(v2.decryptMessage(w, ctxKey, CH, ME), null, "wrong key");
assert.equal(v2.decryptMessage(w.slice(0, 30) + (w[30] === "A" ? "B" : "A") + w.slice(31), mk, CH, ME), null, "tampered");
assert.equal(v2.decryptMessage("plain", mk, CH, ME), null);
assert.equal(v2.decryptMessage("§", mk, CH, ME), null);
assert.equal(v2.decryptMessage("§%%%%", mk, CH, ME), null);
ok("wrong channel / sender / key / tamper / garbage -> null, no throw");
const seen = new Set();
for (let i = 0; i < 300; i++) seen.add(v2.encryptMessage("same", mk, v2.AES256, CH, ME));
assert.equal(seen.size, 300);
ok("300 encryptions of the same text are all different");

// 7. files
for (const p of v2.PRESETS) {
  const rp = ref.PRESETS[p.index];
  for (const n of [0, 1, 65535, 65536, 65537, 131072, 200001]) {
    const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    const enc = v2.encryptFile(data, mk, p, CH, ME);
    assert.equal(enc.length, n + v2.fileOverhead(p, n), `overhead ${p.label} ${n}`);
    assert.equal(hex(v2.decryptFile(enc, mk, CH, ME)), hex(data));
    assert.equal(hex(ref.decFile(Buffer.from(enc), Buffer.from(mk), CH, ME)), hex(data), "reference reads plugin file");
    assert.equal(hex(v2.decryptFile(new Uint8Array(ref.encFile(Buffer.from(data), Buffer.from(mk), rp, CH, ME)), mk, CH, ME)), hex(data), "plugin reads reference file");
  }
}
ok("files round-trip with reference for all presets (0 B .. 200 KB, chunk boundaries)");
const big = v2.encryptFile(new Uint8Array(150000).fill(7), mk, v2.AES128, CH, ME);
const chunkCt = 65536 + 12;
assert.equal(v2.decryptFile(big.subarray(0, big.length - 5), mk, CH, ME), null, "truncated");
const dropLast = big.subarray(0, 17 + chunkCt * 2);
assert.equal(v2.decryptFile(dropLast, mk, CH, ME), null, "dropped final chunk");
const swapped = new Uint8Array(big); swapped.set(big.subarray(17 + chunkCt, 17 + 2 * chunkCt), 17); swapped.set(big.subarray(17, 17 + chunkCt), 17 + chunkCt);
assert.equal(v2.decryptFile(swapped, mk, CH, ME), null, "reordered");
assert.equal(v2.decryptFile(big, mk, "other", ME), null, "wrong channel");
ok("file truncation / dropped chunk / reordering / wrong channel rejected");

// 8. Padmé padding (our improvement) stays readable by the upstream/reference decoder
assert.deepEqual([1, 2, 9, 100, 1000, 1455].map(v2.padme), [1, 2, 10, 104, 1024, 1472]);
for (const p of v2.PRESETS) {
  const max = v2.maxPlaintextBytes(p);
  for (let n = 0; n <= max; n += 7) {
    const L = v2.paddedLength(n + 1, p);
    assert.ok(L % p.padBlock === 0 && L >= n + 1 && L <= max + 1, `padded length ${p.label} ${n}`);
  }
  for (const s of ["hi", "m".repeat(300), "m".repeat(max)]) {
    const wp = v2.encryptMessage(s, mk, p, CH, ME);
    assert.ok(wp.length <= 2000);
    assert.equal(ref.decMsg(wp, Buffer.from(mk), CH, ME), s, "reference decoder reads Padmé-padded output");
    assert.ok(wp.length >= v2.encryptMessage(s, mk, p, CH, ME, { padme: false }).length);
  }
}
ok("Padmé padding: multiple of padBlock, within Discord limit, readable by the reference decoder");

console.log(`\nAll ${passed} groups passed.`);
