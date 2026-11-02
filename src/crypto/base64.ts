// Standard Base64 (RFC 4648 alphabet, with '=' padding, no line breaks) - the same thing
// Android's Base64.NO_WRAP produces. Hand-written so we do not depend on atob/btoa existing.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i;

/** pad=false drops the trailing '=' (Android's Base64.NO_PADDING, used by Aegires v2 messages). */
export function base64Encode(bytes: Uint8Array, pad = true): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)] : pad ? "=" : "";
    out += i + 2 < bytes.length ? ALPHABET[c & 63] : pad ? "=" : "";
  }
  return out;
}

/** Returns null on any character outside the alphabet (whitespace is ignored). */
export function base64Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]+/g, "");
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v: number[] = [];
    for (let k = 0; k < 4; k++) {
      if (i + k >= clean.length) { v.push(0); continue; }
      const x = LOOKUP[clean[i + k]];
      if (x === undefined) return null;
      v.push(x);
    }
    const n = clean.length - i;
    if (o < out.length) out[o++] = (v[0] << 2) | (v[1] >> 4);
    if (n > 2 && o < out.length) out[o++] = ((v[1] & 15) << 4) | (v[2] >> 2);
    if (n > 3 && o < out.length) out[o++] = ((v[2] & 3) << 6) | v[3];
  }
  return out;
}
