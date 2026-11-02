// WebView engine page (src/engine/page.ts) run in Node, which has the same WebAssembly + WebCrypto
// the page gets in Chrome: results must be byte-compatible with the JS code used in Hermes.
import assert from "node:assert/strict";
import { argon2id as nobleArgon } from "@noble/hashes/argon2";
import * as v2 from "../src/crypto/v2.ts";
import { decryptBytes, encryptBytes } from "../src/crypto/wire.ts";
import { base64Decode, base64Encode } from "../src/crypto/base64.ts";

const posted = [];
const listeners = [];
globalThis.document = { addEventListener: (_t, f) => listeners.push(f) };
globalThis.window = globalThis;
globalThis.window.addEventListener = (_t, f) => listeners.push(f);
globalThis.ReactNativeWebView = { postMessage: (s) => posted.push(JSON.parse(s)) };
await import("../src/engine/page.ts");
const E = globalThis.__aegiresEngine;

assert.equal(posted[0].ready, true);
assert.equal(posted[0].caps.wasm, true);
assert.equal(posted[0].caps.subtle, true);
console.log("  ok  page announces itself with WebAssembly + WebCrypto");

const enc = (s) => new TextEncoder().encode(s);
const out = await E.handle({ op: "argon2", p: base64Encode(enc("hunter22 pass")), s: base64Encode(enc("dcenc2|user-key|v1")), t: 3, m: 4096, len: 32 });
assert.deepEqual(base64Decode(out), nobleArgon(enc("hunter22 pass"), enc("dcenc2|user-key|v1"), { t: 3, m: 4096, p: 1, dkLen: 32 }));
console.log("  ok  WebAssembly Argon2id matches @noble/hashes");

const master = new Uint8Array(32).map((_, i) => i * 3 + 1);
const big = new Uint8Array(200000).map((_, i) => (i * 13) & 255);
for (const p of v2.PRESETS) {
  const r = await E.handle({ op: "sealFile", fmt: "v2", data: base64Encode(big), key: base64Encode(master), preset: p.index, ch: "11", sender: "22" });
  const file = base64Decode(r.data);
  assert.equal(r.size, file.length);
  assert.deepEqual(v2.decryptFile(file, master, "11", "22"), big, "JS decrypts engine file " + p.label);
  const js = v2.encryptFile(big, master, p, "11", "22");
  const o = await E.handle({ op: "openFile", data: base64Encode(js), v2: [base64Encode(new Uint8Array(32)), base64Encode(master)], v1: [], ch: "11", author: "22", kind: "" });
  assert.deepEqual(base64Decode(o.data), big, "engine decrypts JS file " + p.label);
  assert.equal(await E.handle({ op: "openFile", data: base64Encode(js), v2: [base64Encode(master)], v1: [], ch: "11", author: "23" }), null, "wrong author rejected");
  js[js.length - 1] ^= 1;
  assert.equal(await E.handle({ op: "openFile", data: base64Encode(js), v2: [base64Encode(master)], v1: [], ch: "11", author: "22" }), null, "tamper rejected");
}
console.log("  ok  v2 files (AES-128/192/256, multi-chunk) interchangeable with the JS code; wrong author / tamper -> null");

const k1 = new Uint8Array(32).fill(9);
const r1 = await E.handle({ op: "sealFile", fmt: "v1", data: base64Encode(big), key: base64Encode(k1) });
assert.deepEqual(decryptBytes(base64Decode(r1.data), k1), big);
const png = new Uint8Array(64);
png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 32, 0, 0, 1, 144]);
const v1file = encryptBytes(png, k1);
globalThis.fetch = async (url) => (url === "https://cdn/x" ? { ok: true, arrayBuffer: async () => v1file.slice().buffer } : { ok: false, status: 404 });
const o1 = await E.handle({ op: "openFile", url: "https://cdn/x", v2: [], v1: [base64Encode(k1)], ch: "1", author: "2", kind: "image" });
assert.deepEqual(base64Decode(o1.data), png);
assert.deepEqual([o1.w, o1.h], [800, 400]);
await assert.rejects(E.handle({ op: "openFile", url: "https://cdn/missing", v2: [], v1: [base64Encode(k1)] }), /^Error: fetch/);
await assert.rejects(E.handle({ op: "openFile", url: "https://cdn/x", v2: [], v1: [base64Encode(k1)], max: 10 }), /too large/);
console.log("  ok  v1 files both ways; engine fetches the CDN URL itself, reports fetch failures and size limit; image size");

posted.length = 0;
listeners[0]({ data: JSON.stringify({ id: 7, op: "ping" }) });
listeners[0]({ data: JSON.stringify({ id: 8, op: "nope" }) });
await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(posted.find((m) => m.id === 7), { id: 7, ok: true, out: "pong" });
assert.equal(posted.find((m) => m.id === 8).ok, false);
console.log("  ok  message protocol (ids echoed, errors reported)");
console.log("Engine page tests passed.");
