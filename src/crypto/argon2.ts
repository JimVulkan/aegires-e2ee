// Argon2id v1.3 (RFC 9106), one lane, tuned for Hermes.
//
// Hermes (Discord's JS engine) has no JIT and no WebAssembly, and a plugin cannot load native code,
// so speed has to come from the JS itself. @noble/hashes' argon2 allocates several objects and
// makes ~25 function calls per G step (25M G steps for 64 MiB x 3 passes); on an interpreter that
// overhead dominates. Here the whole BlaMka round runs inline on locals with no allocation and no
// calls: every 64-bit word is a (lo, hi) pair of doubles, and the 32x32->64 multiply is done with
// exact double arithmetic (Hermes numbers are doubles anyway). Output is bit-identical.
// BLAKE2b (H0 and the H' expansions, a few KB) still comes from @noble/hashes.
import { blake2b } from "@noble/hashes/blake2";

const SYNC = 4;
const TYPE_ID = 2;
const VERSION = 0x13;

// Word offsets (2 * 64-bit index) of the 4 words of each G call: 16 P rounds x 8 G x 4 words.
const GI = (() => {
  const t = new Uint16Array(512);
  let k = 0;
  const P = (v: number[]) => {
    const q = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 0, 5, 10, 15, 1, 6, 11, 12, 2, 7, 8, 13, 3, 4, 9, 14];
    for (const i of q) t[k++] = 2 * v[i];
  };
  for (let i = 0; i < 128; i += 16) P(Array.from({ length: 16 }, (_, j) => i + j));
  for (let i = 0; i < 16; i += 2) P([0, 1, 16, 17, 32, 33, 48, 49, 64, 65, 80, 81, 96, 97, 112, 113].map((j) => i + j));
  return t;
})();

const R = new Uint32Array(256);
const Z = new Uint32Array(256);

/** dst[o..] (^)= G(src[x..] ^ src[y..]); x, y, o are u32 offsets of 1 KiB blocks. */
function compress(src: Uint32Array, x: number, y: number, dst: Uint32Array, o: number, xor: boolean): void {
  for (let i = 0; i < 256; i++) {
    const v = src[x + i] ^ src[y + i];
    R[i] = v;
    Z[i] = v;
  }
  let al, ah, bl, bh, cl, ch, dl, dh, t, q, v, hi, lo, s;
  for (let k = 0; k < 512; k += 4) {
    const a = GI[k], b = GI[k + 1], c = GI[k + 2], d = GI[k + 3];
    al = R[a]; ah = R[a + 1]; bl = R[b]; bh = R[b + 1];
    cl = R[c]; ch = R[c + 1]; dl = R[d]; dh = R[d + 1];

    // a = a + b + 2 * lo(a) * lo(b)
    t = (al & 0xffff) * bl; q = (t / 65536) >>> 0; v = (al >>> 16) * bl + q;
    hi = (v / 65536) >>> 0; lo = (v - hi * 65536) * 65536 + (t - q * 65536);
    s = al + bl + 2 * lo; ah = (ah + bh + 2 * hi + ((s / 4294967296) >>> 0)) >>> 0; al = s >>> 0;
    // d = rotr32(d ^ a)
    t = (dl ^ al) >>> 0; dl = (dh ^ ah) >>> 0; dh = t;
    // c = c + d + 2 * lo(c) * lo(d)
    t = (cl & 0xffff) * dl; q = (t / 65536) >>> 0; v = (cl >>> 16) * dl + q;
    hi = (v / 65536) >>> 0; lo = (v - hi * 65536) * 65536 + (t - q * 65536);
    s = cl + dl + 2 * lo; ch = (ch + dh + 2 * hi + ((s / 4294967296) >>> 0)) >>> 0; cl = s >>> 0;
    // b = rotr24(b ^ c)
    bl ^= cl; bh ^= ch;
    t = ((bl >>> 24) | (bh << 8)) >>> 0; bh = ((bh >>> 24) | (bl << 8)) >>> 0; bl = t;
    // a = a + b + 2 * lo(a) * lo(b)
    t = (al & 0xffff) * bl; q = (t / 65536) >>> 0; v = (al >>> 16) * bl + q;
    hi = (v / 65536) >>> 0; lo = (v - hi * 65536) * 65536 + (t - q * 65536);
    s = al + bl + 2 * lo; ah = (ah + bh + 2 * hi + ((s / 4294967296) >>> 0)) >>> 0; al = s >>> 0;
    // d = rotr16(d ^ a)
    dl ^= al; dh ^= ah;
    t = ((dl >>> 16) | (dh << 16)) >>> 0; dh = ((dh >>> 16) | (dl << 16)) >>> 0; dl = t;
    // c = c + d + 2 * lo(c) * lo(d)
    t = (cl & 0xffff) * dl; q = (t / 65536) >>> 0; v = (cl >>> 16) * dl + q;
    hi = (v / 65536) >>> 0; lo = (v - hi * 65536) * 65536 + (t - q * 65536);
    s = cl + dl + 2 * lo; ch = (ch + dh + 2 * hi + ((s / 4294967296) >>> 0)) >>> 0; cl = s >>> 0;
    // b = rotr63(b ^ c) = rotl1
    bl ^= cl; bh ^= ch;
    t = (bl << 1) | (bh >>> 31); bh = (bh << 1) | (bl >>> 31); bl = t;

    R[a] = al; R[a + 1] = ah; R[b] = bl; R[b + 1] = bh;
    R[c] = cl; R[c + 1] = ch; R[d] = dl; R[d + 1] = dh;
  }
  if (xor) for (let i = 0; i < 256; i++) dst[o + i] ^= R[i] ^ Z[i];
  else for (let i = 0; i < 256; i++) dst[o + i] = R[i] ^ Z[i];
}

const le32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer);

/** H' (variable-length BLAKE2b), RFC 9106 3.3. */
function hPrime(input: Uint8Array, len: number): Uint8Array {
  const head = new Uint8Array(4 + input.length);
  head.set(le32(len));
  head.set(input, 4);
  if (len <= 64) return blake2b(head, { dkLen: len });
  const out = new Uint8Array(len);
  let V = blake2b(head);
  out.set(V.subarray(0, 32));
  let pos = 32;
  for (; len - pos > 64; pos += 32) {
    V = blake2b(V);
    out.set(V.subarray(0, 32), pos);
  }
  out.set(blake2b(V, { dkLen: len - pos }), pos);
  return out;
}

const tick = (): Promise<void> => new Promise((r) => ((globalThis as any).setImmediate ?? setTimeout)(r, 0));

export type Argon2Opts = { t: number; m: number; dkLen: number; onProgress?: (fraction: number) => void; yieldMs?: number };

/** Argon2id with p = 1. Yields to the event loop every `yieldMs` so the UI stays responsive. */
export async function argon2id(password: Uint8Array, salt: Uint8Array, opts: Argon2Opts): Promise<Uint8Array> {
  const { t, m, dkLen, onProgress } = opts;
  const yieldMs = opts.yieldMs ?? 100;
  if (m < 8 || t < 1 || dkLen < 4) throw new Error("bad argon2 params");

  // H0 = H(p, T, m, t, v, y, |P|, P, |S|, S, |K|, K, |X|, X)
  const parts = [le32(1), le32(dkLen), le32(m), le32(t), le32(VERSION), le32(TYPE_ID), le32(password.length), password, le32(salt.length), salt, le32(0), le32(0)];
  const h0in = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((n, p) => (h0in.set(p, n), n + p.length), 0);
  const seed = new Uint8Array(72);
  seed.set(blake2b(h0in));

  const lane = 4 * Math.floor(m / 4);
  const seg = lane / SYNC;
  const B = new Uint32Array(lane * 256);
  const wordsOf = (b: Uint8Array) => new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  B.set(wordsOf(hPrime(seed, 1024)), 0); // seed[64..72] = LE32(0) || LE32(lane 0)
  seed[64] = 1;
  B.set(wordsOf(hPrime(seed, 1024)), 256);

  // [address block | input block | zero block] for Argon2i-style addressing.
  const addr = new Uint32Array(768);
  addr[256 + 6] = lane;
  addr[256 + 8] = t;
  addr[256 + 10] = TYPE_ID;
  const nextAddresses = () => {
    addr[256 + 12]++;
    compress(addr, 512, 256, addr, 0, false);
    compress(addr, 512, 0, addr, 0, false);
  };

  const total = t * lane - 2;
  let done = 0;
  let last = Date.now();
  for (let r = 0; r < t; r++) {
    addr[256] = r;
    for (let s = 0; s < SYNC; s++) {
      addr[256 + 4] = s;
      addr[256 + 12] = 0;
      const indep = r === 0 && s < 2;
      const start = r === 0 && s === 0 ? 2 : 0;
      if (indep && start) nextAddresses();
      for (let i = start; i < seg; i++) {
        const cur = s * seg + i;
        const prev = cur === 0 ? lane - 1 : cur - 1;
        let rand: number;
        if (indep) {
          if (i % 128 === 0) nextAddresses();
          rand = addr[2 * (i % 128)];
        } else rand = B[256 * prev];
        // Reference area (RFC 9106 3.4.1.2), single lane.
        const area = r === 0 ? s * seg + i - 1 : lane - seg + i - 1;
        const startPos = r !== 0 && s !== SYNC - 1 ? (s + 1) * seg : 0;
        // x = rand^2 >> 32; y = area * x >> 32 (exact via 16-bit halves)
        const x = mulHi(rand, rand);
        const ref = (startPos + area - 1 - mulHi(area, x)) % lane;
        compress(B, 256 * prev, 256 * ref, B, 256 * cur, r !== 0);
        if ((++done & 31) === 0) {
          const now = Date.now();
          if (now - last >= yieldMs || now < last) {
            onProgress?.(done / total);
            await tick();
            last = Date.now();
          }
        }
      }
    }
  }
  onProgress?.(1);

  const fin = new Uint8Array(B.buffer, (lane - 1) * 1024, 1024).slice();
  const out = hPrime(fin, dkLen);
  B.fill(0);
  R.fill(0);
  Z.fill(0);
  return out;
}

/** High 32 bits of a * b for u32 a, b. */
function mulHi(a: number, b: number): number {
  const t = (a & 0xffff) * b;
  return (((a >>> 16) * b + ((t / 65536) >>> 0)) / 65536) >>> 0;
}
