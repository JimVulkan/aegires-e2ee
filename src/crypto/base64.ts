// Standard Base64 (RFC 4648 alphabet, with '=' padding, no line breaks) - the same thing
// Android's Base64.NO_WRAP produces. Hand-written so we do not depend on atob/btoa existing.
// Byte-table based and string-building in large chunks: it also carries whole files to and from
// the WebView crypto engine, so it has to be fast on an interpreter.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENC = new Uint8Array(64);
const DEC = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  ENC[i] = ALPHABET.charCodeAt(i);
  DEC[ENC[i]] = i;
}

function ascii(codes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < codes.length; i += 8192) out += String.fromCharCode.apply(null, codes.subarray(i, i + 8192) as unknown as number[]);
  return out;
}

/** pad=false drops the trailing '=' (Android's Base64.NO_PADDING, used by Aegires v2 messages). */
export function base64Encode(bytes: Uint8Array, pad = true): string {
  const n = bytes.length, full = n - (n % 3), rest = n - full;
  const out = new Uint8Array(4 * Math.ceil(n / 3));
  let o = 0;
  for (let i = 0; i < full; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o] = ENC[v >>> 18]; out[o + 1] = ENC[(v >>> 12) & 63]; out[o + 2] = ENC[(v >>> 6) & 63]; out[o + 3] = ENC[v & 63];
    o += 4;
  }
  if (rest) {
    const v = (bytes[full] << 16) | (rest === 2 ? bytes[full + 1] << 8 : 0);
    out[o] = ENC[v >>> 18];
    out[o + 1] = ENC[(v >>> 12) & 63];
    out[o + 2] = rest === 2 ? ENC[(v >>> 6) & 63] : 61; // '='
    out[o + 3] = 61;
  }
  const s = ascii(out);
  return pad || !rest ? s : s.slice(0, s.length - (3 - rest));
}

/** Returns null on any character outside the alphabet (whitespace and '=' are ignored). */
export function base64Decode(text: string): Uint8Array | null {
  const clean = /[\s=]/.test(text) ? text.replace(/[\s=]+/g, "") : text;
  const len = clean.length;
  if (len % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  const full = len - (len % 4);
  let o = 0, bad = 0;
  for (let i = 0; i < full; i += 4) {
    const c0 = clean.charCodeAt(i), c1 = clean.charCodeAt(i + 1), c2 = clean.charCodeAt(i + 2), c3 = clean.charCodeAt(i + 3);
    const a = c0 < 128 ? DEC[c0] : -1, b = c1 < 128 ? DEC[c1] : -1, c = c2 < 128 ? DEC[c2] : -1, d = c3 < 128 ? DEC[c3] : -1;
    bad |= a | b | c | d;
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o] = v >>> 16; out[o + 1] = v >>> 8; out[o + 2] = v;
    o += 3;
  }
  if (len > full) {
    let v = 0;
    for (let i = full; i < len; i++) {
      const c = clean.charCodeAt(i);
      const x = c < 128 ? DEC[c] : -1;
      bad |= x;
      v = (v << 6) | (x & 63);
    }
    const r = len - full; // 2 or 3 chars -> 1 or 2 bytes
    v <<= 6 * (4 - r);
    out[o++] = v >>> 16;
    if (r === 3) out[o++] = v >>> 8;
  }
  return bad < 0 ? null : out;
}
