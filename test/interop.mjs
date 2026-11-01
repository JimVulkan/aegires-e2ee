// Run with:  npm test      (Node 22.18+ runs the .ts files directly, no build needed)
//
// Checks the plugin's real crypto code (src/crypto/*.ts) against:
//   1. test/fixtures.json  - vectors produced by Aegires' own Java Crypto.java
//   2. test/reference.mjs  - an independent implementation using only Node built-ins
import fs from "node:fs";
import assert from "node:assert/strict";
import { deriveKey, toHex, fromHex } from "../src/crypto/keys.ts";
import { encryptText, decryptText, encryptBytes, decryptBytes, looksEncrypted, PREFIX } from "../src/crypto/wire.ts";
import { base64Encode, base64Decode } from "../src/crypto/base64.ts";
import { utf8Encode, utf8Decode } from "../src/crypto/utf8.ts";
import { encryptedFileName, isEncryptedFileName, originalFileName, makeSizeTag, splitSizeTag } from "../src/crypto/files.ts";
import * as ref from "./reference.mjs";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
let passed = 0;
const ok = (name) => { passed++; console.log("  ok  " + name); };

// --- primitives -----------------------------------------------------------------------
const samples = ["", "a", "hi there", "éè 日本語", "emoji 🔒😀 mix", "x".repeat(5000)];
for (const s of samples) {
  assert.deepEqual(Buffer.from(utf8Encode(s)), Buffer.from(s, "utf8"));
  assert.equal(utf8Decode(new Uint8Array(Buffer.from(s, "utf8"))), s);
}
for (let n = 0; n < 40; n++) {
  const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
  assert.equal(base64Encode(b), Buffer.from(b).toString("base64"));
  assert.deepEqual(Buffer.from(base64Decode(Buffer.from(b).toString("base64"))), Buffer.from(b));
}
assert.equal(base64Decode("!!!!"), null);
ok("utf8 + base64 codecs match Node's");

assert.equal(toHex(fromHex("00ff10ab")), "00ff10ab");
assert.equal(fromHex("zz"), null);
ok("hex helpers");

// --- key derivation -------------------------------------------------------------------
const keyPw = await deriveKey("pw");
assert.equal(toHex(keyPw), fx.password_pw_key_hex);
ok("PBKDF2 key == Java's key");

// --- Java -> plugin -------------------------------------------------------------------
for (const [i, c] of fx.cases.entries()) {
  const pw = Buffer.from(c.password_b64, "base64").toString("utf8");
  const want = Buffer.from(c.plain_b64, "base64").toString("utf8");
  const key = await deriveKey(pw);
  assert.equal(decryptText(c.wire, key), want, `Java vector ${i}`);
}
ok(`decrypts all ${fx.cases.length} text vectors made by Aegires' Java (incl. gzip, unicode password, 1300 chars)`);

const javaFile = decryptBytes(new Uint8Array(Buffer.from(fx.file_vector_pw_b64, "base64")), keyPw);
assert.ok(javaFile && javaFile.length === 1024 && javaFile.every((v, i) => v === (i & 255)));
ok("decrypts attachment bytes made by Aegires' Java");

// --- plugin -> reference (and plugin round trip) --------------------------------------
const refKey = ref.deriveKey("pw");
for (const s of samples.concat(["hello world ".repeat(40), "[sz:640,480]caption"])) {
  const wire = encryptText(s, keyPw);
  assert.ok(wire.startsWith(PREFIX) && looksEncrypted(wire));
  assert.equal(decryptText(wire, keyPw), s);
  assert.equal(ref.decrypt(wire, refKey), s, "reference must read plugin output");
}
ok("plugin output decrypts with the independent reference (same bytes Aegires would accept)");

const bytes = new Uint8Array(3000).map((_, i) => (i * 7) & 255);
assert.deepEqual(Buffer.from(ref.decryptBytes(Buffer.from(encryptBytes(bytes, keyPw)), refKey)), Buffer.from(bytes));
assert.deepEqual(Buffer.from(decryptBytes(new Uint8Array(ref.encryptBytes(Buffer.from(bytes), refKey)), keyPw)), Buffer.from(bytes));
ok("attachment bytes round-trip both ways");

// --- compression behaves like Aegires -------------------------------------------------
const compressible = "hello world ".repeat(40);
assert.ok(encryptText(compressible, keyPw).length < compressible.length, "long repetitive text must be compressed");
ok("compression kicks in for long repetitive text");

// --- failure modes never throw --------------------------------------------------------
const wire = encryptText("secret", keyPw);
const otherKey = await deriveKey("not the password");
assert.equal(decryptText(wire, otherKey), null);
const flipped = wire.slice(0, 20) + (wire[20] === "A" ? "B" : "A") + wire.slice(21);
assert.equal(decryptText(flipped, keyPw), null);
assert.equal(decryptText("plain text", keyPw), null);
assert.equal(decryptText(PREFIX + "%%%", keyPw), null);
assert.equal(decryptText(PREFIX, keyPw), null);
ok("wrong key / tampered / malformed input -> null, no exception");

// --- IVs are unique -------------------------------------------------------------------
const seen = new Set();
for (let i = 0; i < 500; i++) seen.add(encryptText("same message", keyPw).slice(0, 20));
assert.equal(seen.size, 500);
ok("500 encryptions of the same text produced 500 distinct IVs");

// --- attachment helpers ---------------------------------------------------------------
assert.equal(encryptedFileName("photo.png"), "photo.enc.png");
assert.equal(encryptedFileName("archive.tar.gz"), "archive.tar.enc.gz");
assert.equal(encryptedFileName("notes"), "notes.enc");
assert.equal(encryptedFileName(""), "file.enc");
assert.equal(isEncryptedFileName("photo.enc.png"), true);
assert.equal(isEncryptedFileName("photo.png"), false);
assert.equal(originalFileName("photo.enc.png"), "photo.png");
assert.equal(originalFileName("notes.enc"), "notes");
assert.deepEqual(splitSizeTag(makeSizeTag(640, 480) + "hey"), { width: 640, height: 480, text: "hey" });
assert.deepEqual(splitSizeTag("no tag"), { width: null, height: null, text: "no tag" });
ok("filename + [sz:W,H] helpers match Aegires' conventions");

console.log(`\nAll ${passed} groups passed.`);
