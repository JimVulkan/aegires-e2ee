// Aegires "v1" wire format for text messages (see app/.../util/Crypto.java in Aegires):
//
//   "§" + base64( iv[12] || AES-256-GCM( flag[1] || data ) || tag[16] )
//
//   flag 0 -> data is the raw UTF-8 text
//   flag 1 -> data is raw DEFLATE (no zlib header) of the UTF-8 text
//   Compression is only tried when the text is >= 100 bytes, and only kept if it is smaller.
//
// Attachments use a simpler framing (no flag byte, no compression): iv[12] || ct || tag[16].
import { gcm } from "@noble/ciphers/aes";
import { deflateSync, inflateSync } from "fflate";
import { base64Decode, base64Encode } from "./base64.ts";
import { randomBytes } from "./random.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

export const PREFIX = "§"; // "§"
/** Aegires refuses to encrypt longer text so the base64 form fits in Discord's 2000-char limit. */
export const MAX_PLAINTEXT_LEN = 1300;

const IV_LEN = 12;
const TAG_LEN = 16;
const COMPRESS_THRESHOLD = 100;
const MAX_INFLATED_BYTES = 1 << 20;
const FLAG_RAW = 0;
const FLAG_DEFLATE = 1;

export function looksEncrypted(s: unknown): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Throws if there is no secure RNG (caller must treat that as "do not send"). */
export function encryptText(plain: string, key: Uint8Array): string {
  const raw = utf8Encode(plain);
  let data = raw;
  let flag = FLAG_RAW;
  if (raw.length >= COMPRESS_THRESHOLD) {
    const z = deflateSync(raw, { level: 1 });
    if (z.length < raw.length) {
      data = z;
      flag = FLAG_DEFLATE;
    }
  }
  const payload = concat(Uint8Array.of(flag), data);
  const iv = randomBytes(IV_LEN);
  const sealed = gcm(key, iv).encrypt(payload); // ciphertext || 16-byte tag
  return PREFIX + base64Encode(concat(iv, sealed));
}

/** Returns null for: not our format, wrong key, tampered data, or garbage. Never throws. */
export function decryptText(wire: string, key: Uint8Array): string | null {
  if (!looksEncrypted(wire)) return null;
  try {
    const all = base64Decode(wire.slice(PREFIX.length));
    if (!all || all.length < IV_LEN + TAG_LEN) return null;
    const payload = gcm(key, all.subarray(0, IV_LEN)).decrypt(all.subarray(IV_LEN));
    if (payload.length === 0) return null;
    const data = payload.subarray(1);
    // Aegires treats every flag other than 1 as "raw"; mirror that exactly.
    if (payload[0] === FLAG_DEFLATE) {
      const out = inflateSync(data);
      return out.length > MAX_INFLATED_BYTES ? null : utf8Decode(out);
    }
    return utf8Decode(data);
  } catch {
    return null; // GCM auth failure (wrong key) lands here
  }
}

/** Attachment framing: iv[12] || AES-256-GCM(bytes) || tag[16]. */
export function encryptBytes(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_LEN);
  return concat(iv, gcm(key, iv).encrypt(plain));
}

export function decryptBytes(blob: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (blob.length < IV_LEN + TAG_LEN) return null;
  try {
    return gcm(key, blob.subarray(0, IV_LEN)).decrypt(blob.subarray(IV_LEN));
  } catch {
    return null;
  }
}
