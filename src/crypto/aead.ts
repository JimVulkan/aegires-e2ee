// AES-GCM with a configurable tag length (Aegires v2 uses 12/14/16-byte tags) and 128/192/256-bit
// keys. @noble/ciphers only produces full 16-byte tags, but a GCM tag of length t is simply the first
// t bytes of the full tag.
//
//   seal: encrypt normally, cut the tag down.
//   open: verify FIRST, then decrypt. The tag is computed directly as
//           T = E(K, J0) xor GHASH_H(aad || ct || lengths),  H = E(K, 0^128), J0 = nonce || 00000001
//         and compared in constant time; only then is the ciphertext CTR-decrypted from counter 2.
//         (Upstream decrypted with CTR and then re-ran a full GCM encryption to recompute the tag:
//         twice the AES work, and it produced plaintext before authenticating.)
import { ctr, ecb, gcm } from "@noble/ciphers/aes";
import { ghash } from "@noble/ciphers/_polyval";

export function gcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array, tagLen: number): Uint8Array {
  if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  const sealed = gcm(key, nonce, aad).encrypt(plain); // ct || 16-byte tag
  return sealed.slice(0, plain.length + tagLen);
}

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

/** Full 16-byte GCM tag of (aad, ct) without touching the plaintext. */
function gcmTag(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const block = ecb(key, { disablePadding: true });
  const h = block.encrypt(new Uint8Array(16));
  const j0 = new Uint8Array(16);
  j0.set(nonce, 0);
  j0[15] = 1;
  const ej0 = ecb(key, { disablePadding: true }).encrypt(j0);
  const g = ghash.create(h, aad.length + ct.length);
  if (aad.length) g.update(aad);
  if (ct.length) g.update(ct);
  g.update(lengthsBlock(aad.length, ct.length));
  const s = g.digest();
  for (let i = 0; i < 16; i++) s[i] ^= ej0[i];
  return s;
}

/** Returns the plaintext, or null if authentication fails. Never throws. */
export function gcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array, tagLen: number): Uint8Array | null {
  try {
    if (nonce.length !== 12 || data.length < tagLen || tagLen < 12 || tagLen > 16) return null;
    const ct = data.subarray(0, data.length - tagLen);
    const tag = data.subarray(data.length - tagLen);
    const want = gcmTag(key, nonce, aad, ct);
    let diff = 0;
    for (let i = 0; i < tagLen; i++) diff |= want[i] ^ tag[i];
    if (diff !== 0) return null;
    const counter = new Uint8Array(16);
    counter.set(nonce, 0);
    counter[15] = 2;
    return ct.length ? ctr(key, counter).decrypt(ct) : new Uint8Array(0);
  } catch {
    return null;
  }
}
