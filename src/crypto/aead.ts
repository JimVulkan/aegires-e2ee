// AES-GCM with a configurable tag length (Aegires v2 uses 12/14/16-byte tags) and 128/192/256-bit
// keys. A GCM tag of length t is simply the first t bytes of the full tag.
//
//   T = E(K, J0) xor GHASH_H(aad || ct || lengths),  H = E(K, 0^128), J0 = nonce || 00000001,
//   ct = AES-CTR from counter 2.
//
//   seal: CTR-encrypt, then compute the tag and cut it down.
//   open: verify FIRST (tag over the ciphertext, constant-time compare), only then CTR-decrypt.
//         (Upstream decrypted with CTR and then re-ran a full GCM encryption to recompute the tag:
//         twice the AES work, and it produced plaintext before authenticating.)
// AES-CTR is our flat Hermes-friendly one (aesfast.ts); GHASH is @noble/ciphers'.
import { ghash } from "@noble/ciphers/_polyval";
import { ctr32, expandKey } from "./aesfast.ts";

function lengthsBlock(aadLen: number, ctLen: number): Uint8Array {
  const b = new Uint8Array(16);
  const put = (off: number, bytes: number) => {
    const bits = bytes * 8; // < 2^53, fine for Discord-sized data
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    b[off] = hi >>> 24; b[off + 1] = (hi >>> 16) & 255; b[off + 2] = (hi >>> 8) & 255; b[off + 3] = hi & 255;
    b[off + 4] = lo >>> 24; b[off + 5] = (lo >>> 16) & 255; b[off + 6] = (lo >>> 8) & 255; b[off + 7] = lo & 255;
  };
  put(0, aadLen);
  put(8, ctLen);
  return b;
}

/** Full 16-byte GCM tag of (aad, ct). */
function gcmTag(rk: Uint32Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const zero = new Uint8Array(16);
  const h = new Uint8Array(16);
  ctr32(rk, zero, 0, zero, h); // E(K, 0^128)
  const ej0 = new Uint8Array(16);
  ctr32(rk, nonce, 1, zero, ej0);
  const g = ghash.create(h, aad.length + ct.length);
  if (aad.length) g.update(aad);
  if (ct.length) g.update(ct);
  g.update(lengthsBlock(aad.length, ct.length));
  const s = g.digest();
  for (let i = 0; i < 16; i++) s[i] ^= ej0[i];
  return s;
}

export function gcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array, tagLen: number): Uint8Array {
  if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  if (tagLen < 12 || tagLen > 16) throw new Error("bad tag length");
  const rk = expandKey(key);
  const out = new Uint8Array(plain.length + tagLen);
  const ct = out.subarray(0, plain.length);
  ctr32(rk, nonce, 2, plain, ct);
  out.set(gcmTag(rk, nonce, aad, ct).subarray(0, tagLen), plain.length);
  return out;
}

/** Returns the plaintext, or null if authentication fails. Never throws. */
export function gcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array, tagLen: number): Uint8Array | null {
  try {
    if (nonce.length !== 12 || data.length < tagLen || tagLen < 12 || tagLen > 16) return null;
    const rk = expandKey(key);
    const ct = data.subarray(0, data.length - tagLen);
    const tag = data.subarray(data.length - tagLen);
    const want = gcmTag(rk, nonce, aad, ct);
    let diff = 0;
    for (let i = 0; i < tagLen; i++) diff |= want[i] ^ tag[i];
    if (diff !== 0) return null;
    const out = new Uint8Array(ct.length);
    ctr32(rk, nonce, 2, ct, out);
    return out;
  } catch {
    return null;
  }
}
