// Runs INSIDE a hidden WebView (Chrome's V8: JIT, WebAssembly, WebCrypto), not in Hermes.
// Built separately (build.mjs) and embedded into the plugin as an HTML string; the plugin side is
// src/engine/engine.tsx.
//
//   argon2   Argon2id via hash-wasm (WebAssembly); our JS Argon2 if WebAssembly is missing.
//   sealFile / openFile
//            whole attachments, so Hermes only passes base64 strings around (Discord's native file
//            module reads and writes base64 directly). openFile can fetch the CDN URL itself.
//            AES-GCM runs on WebCrypto (native, hardware AES). WebCrypto has no AES-192, so those
//            keys use our JS AES-GCM, which is JIT-compiled here.
//
// Messages are JSON strings; bytes are base64. Every request has an id that the reply echoes.
import { argon2id as wasmArgon2id } from "hash-wasm";
import { argon2id as jsArgon2id } from "../crypto/argon2.ts";
import { gcmOpen, gcmSeal } from "../crypto/aead.ts";
import { base64Decode, base64Encode } from "../crypto/base64.ts";
import { decryptFileWith, encryptFileWith, presetFromIndex, type GcmBatch, type GcmJob } from "../crypto/v2.ts";
import { imageDims, videoDims } from "../crypto/files.ts";
import { randomBytes } from "../crypto/random.ts";

const rn = (globalThis as any).ReactNativeWebView;
const send = (o: unknown) => rn?.postMessage(JSON.stringify(o));
const subtle: any = (globalThis as any).crypto?.subtle;
const b = (s: string): Uint8Array => {
  const r = base64Decode(String(s ?? ""));
  if (!r) throw new Error("bad base64");
  return r;
};

/** GCM jobs on WebCrypto, falling back to JS per job. Keys are imported once per key object. */
function webCryptoBatch(): GcmBatch {
  const keys = new Map<Uint8Array, Promise<any>>();
  const imported = (k: Uint8Array) => {
    if (!subtle || (k.length !== 16 && k.length !== 32)) return Promise.resolve(null);
    let p = keys.get(k);
    if (!p) keys.set(k, (p = subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]).catch(() => null)));
    return p;
  };
  const params = (j: GcmJob) => ({ name: "AES-GCM", iv: j.nonce, additionalData: j.aad, tagLength: 8 * j.tagLen });
  return {
    seal: (jobs) => Promise.all(jobs.map(async (j) => {
      const ck = await imported(j.key);
      if (ck) {
        try { return new Uint8Array(await subtle.encrypt(params(j), ck, j.data)); } catch {}
      }
      return gcmSeal(j.key, j.nonce, j.aad, j.data, j.tagLen);
    })),
    open: (jobs) => Promise.all(jobs.map(async (j) => {
      const ck = await imported(j.key);
      if (ck) {
        try {
          return new Uint8Array(await subtle.decrypt(params(j), ck, j.data));
        } catch (e) {
          if ((e as any)?.name === "OperationError") return null; // authentication failed
        }
      }
      return gcmOpen(j.key, j.nonce, j.aad, j.data, j.tagLen);
    })),
  };
}

/** v1 attachment: iv[12] || AES-256-GCM || tag[16], no AAD. */
const V1_IV = 12, V1_TAG = 16;

async function argon2(m: any): Promise<string> {
  const password = b(m.p), salt = b(m.s);
  if (typeof WebAssembly === "object") {
    try {
      return base64Encode(await wasmArgon2id({ password, salt, parallelism: 1, iterations: m.t, memorySize: m.m, hashLength: m.len, outputType: "binary" }));
    } catch {}
  }
  return base64Encode(await jsArgon2id(password, salt, { t: m.t, m: m.m, dkLen: m.len, yieldMs: 1e9 }));
}

async function sealFile(m: any): Promise<{ data: string; size: number }> {
  const plain = b(m.data), key = b(m.key);
  let out: Uint8Array;
  if (m.fmt === "v2") {
    const preset = presetFromIndex(m.preset);
    if (!preset) throw new Error("bad preset");
    out = await encryptFileWith(webCryptoBatch(), plain, key, preset, m.ch, m.sender);
  } else {
    const iv = randomBytes(V1_IV);
    const [ct] = await webCryptoBatch().seal([{ key, nonce: iv, aad: new Uint8Array(0), data: plain, tagLen: V1_TAG }]);
    out = new Uint8Array(V1_IV + ct.length);
    out.set(iv);
    out.set(ct, V1_IV);
  }
  return { data: base64Encode(out), size: out.length };
}

async function openFile(m: any): Promise<{ data: string; size: number; w?: number; h?: number } | null> {
  let blob: Uint8Array;
  if (typeof m.data === "string") blob = b(m.data);
  else {
    try {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error("http " + res.status);
      blob = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new Error("fetch: " + String((e as any)?.message ?? e));
    }
  }
  if (m.max && blob.length > m.max) throw new Error("file too large");
  const batch = webCryptoBatch();
  let plain: Uint8Array | null = null;
  if (blob.length && blob[0] >> 4 === 3 && m.ch && m.author) {
    for (const k of m.v2 ?? []) if ((plain = await decryptFileWith(batch, blob, b(k), m.ch, m.author))) break;
  }
  if (!plain && blob.length >= V1_IV + V1_TAG) {
    for (const k of m.v1 ?? []) {
      const [p] = await batch.open([{ key: b(k), nonce: blob.subarray(0, V1_IV), aad: new Uint8Array(0), data: blob.subarray(V1_IV), tagLen: V1_TAG }]);
      if ((plain = p)) break;
    }
  }
  if (!plain) return null;
  const dims = m.kind === "image" ? imageDims(plain) : m.kind === "video" ? videoDims(plain) : null;
  return { data: base64Encode(plain), size: plain.length, w: dims?.w, h: dims?.h };
}

const OPS: Record<string, (m: any) => Promise<unknown>> = {
  argon2,
  sealFile,
  openFile,
  ping: async () => "pong",
};

async function handle(raw: unknown): Promise<void> {
  let msg: any;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return;
  }
  if (!msg || typeof msg.id !== "number") return;
  try {
    const op = OPS[msg.op];
    if (!op) throw new Error("unknown op " + msg.op);
    send({ id: msg.id, ok: true, out: await op(msg) });
  } catch (e) {
    send({ id: msg.id, ok: false, err: String((e as any)?.message ?? e) });
  }
}

const onMessage = (e: any) => void handle(e?.data);
document.addEventListener("message", onMessage as any); // Android WebView delivers here
window.addEventListener("message", onMessage);
send({ ready: true, caps: { wasm: typeof WebAssembly === "object", subtle: !!subtle } });

// Test hook (Node): the same handlers without a WebView.
(globalThis as any).__aegiresEngine = { handle: (m: any) => OPS[m.op](m) };
