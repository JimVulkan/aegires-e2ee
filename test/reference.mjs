// Independent reference implementation of the Aegires wire format, using ONLY Node built-ins
// (node:crypto + node:zlib). It exists so the real plugin crypto (src/crypto/*.ts, which uses
// @noble/* and fflate) can be cross-checked against something that shares no code with it.
//
// Aegires v1 wire format (from app/src/main/java/a/b/util/Crypto.java):
//   key      = PBKDF2-HMAC-SHA1(password as UTF-8, salt "pwc", 15000 iterations, 32 bytes)
//   text     = "§" + base64( iv[12] || AES-256-GCM( flag[1] || data ) || tag[16] )
//              flag 0 = data is raw UTF-8, flag 1 = data is raw DEFLATE of the UTF-8
//              (compression is only used when plaintext >= 100 bytes AND it gets smaller)
//   file     = iv[12] || AES-256-GCM(file bytes) || tag[16]      (no flag byte, no compression)
import { pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const PREFIX = "§";
const SALT = Buffer.from("pwc", "utf8");
const IV_LEN = 12;
const TAG_LEN = 16;

export function deriveKey(password) {
  return pbkdf2Sync(Buffer.from(password, "utf8"), SALT, 15000, 32, "sha1");
}

export function encrypt(plaintext, key) {
  const raw = Buffer.from(plaintext, "utf8");
  const zipped = raw.length >= 100 ? deflateRawSync(raw, { level: 1 }) : null;
  const useZip = zipped !== null && zipped.length < raw.length;
  const payload = Buffer.concat([Buffer.from([useZip ? 1 : 0]), useZip ? zipped : raw]);
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(payload), c.final(), c.getAuthTag()]);
  return PREFIX + Buffer.concat([iv, ct]).toString("base64");
}

export function decrypt(wire, key) {
  if (!wire.startsWith(PREFIX)) return null;
  try {
    const all = Buffer.from(wire.slice(PREFIX.length), "base64");
    if (all.length < IV_LEN + TAG_LEN) return null;
    const d = createDecipheriv("aes-256-gcm", key, all.subarray(0, IV_LEN));
    d.setAuthTag(all.subarray(all.length - TAG_LEN));
    const payload = Buffer.concat([d.update(all.subarray(IV_LEN, all.length - TAG_LEN)), d.final()]);
    if (payload.length === 0) return null;
    const data = payload.subarray(1);
    return (payload[0] === 1 ? inflateRawSync(data) : data).toString("utf8");
  } catch {
    return null; // wrong key or tampered
  }
}

export function encryptBytes(bytes, key) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([iv, c.update(bytes), c.final(), c.getAuthTag()]);
}

export function decryptBytes(all, key) {
  try {
    if (all.length < IV_LEN + TAG_LEN) return null;
    const d = createDecipheriv("aes-256-gcm", key, all.subarray(0, IV_LEN));
    d.setAuthTag(all.subarray(all.length - TAG_LEN));
    return Buffer.concat([d.update(all.subarray(IV_LEN, all.length - TAG_LEN)), d.final()]);
  } catch {
    return null;
  }
}
