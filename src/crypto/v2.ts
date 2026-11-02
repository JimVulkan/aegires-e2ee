// Aegires v2 wire format (Crypto.java, "dcenc2"). All integers big-endian.
//
// Per message / per file, a fresh 16-byte salt and HKDF-SHA256(master, salt, info) give the AES key
// and nonce. info = "dcenc2/<kind>" | preset(1) | len16(channelId) | channelId | len16(senderId) | senderId
// so a ciphertext only opens in the same channel from the same author.
//
// Text : "§" + base64nopad( header | salt[16] | AES-GCM(padded) | tag )
//        header = (2 << 4) | presetIndex ; padded = data | 0x80 | zeros up to a multiple of padBlock
//        AAD = header | salt | info ; key/nonce = HKDF(keyBytes + 12) ; no compression
// File : header = (3 << 4) | presetIndex, salt[16], then 64 KiB plaintext chunks, each AES-GCM'd with
//        key = HKDF(...)[0..keyBytes], nonce = HKDF(...)[keyBytes..+7] | counter(4) | lastFlag(1),
//        same AAD for every chunk. Truncation / reordering fails authentication.
//
// Improvement over upstream (still readable by every v2 decoder, which only requires the padded
// length to be a multiple of padBlock): messages are padded with Padmé (Nikitin et al. 2019)
// on top of padBlock, so the ciphertext length reveals at most ~O(log log n) bits about the
// text length instead of its length rounded to 16/32/64 bytes. Cost: at most ~12% extra bytes,
// never past the Discord size limit.
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcmOpen, gcmSeal } from "./aead.ts";
import { base64Decode, base64Encode } from "./base64.ts";
import { randomBytes } from "./random.ts";
import { utf8Decode, utf8Encode } from "./utf8.ts";

export type Preset = { index: number; label: string; keyBytes: number; tagBytes: number; padBlock: number };

export const AES128: Preset = { index: 0, label: "AES-128-GCM", keyBytes: 16, tagBytes: 12, padBlock: 16 };
export const AES192: Preset = { index: 1, label: "AES-192-GCM", keyBytes: 24, tagBytes: 14, padBlock: 32 };
export const AES256: Preset = { index: 2, label: "AES-256-GCM", keyBytes: 32, tagBytes: 16, padBlock: 64 };
export const PRESETS: Preset[] = [AES128, AES192, AES256];

export function presetFromIndex(i: number): Preset | null {
  for (const p of PRESETS) if (p.index === i) return p;
  return null;
}

export const PREFIX = "§"; // "§"
export const DISCORD_CONTENT_LIMIT = 2000;
const VERSION_MESSAGE = 2;
const VERSION_FILE = 3;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const FILE_CHUNK = 64 * 1024;
const FILE_PREFIX_LEN = 7;

export function looksEncrypted(s: unknown): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

// ------------------------------------------------------------------ sizes

function maxRawBytesForChars(chars: number): number {
  let n = Math.floor((chars * 3) / 4) + 1;
  while (Math.floor((4 * n + 2) / 3) > chars) n--;
  return n;
}

/** Largest UTF-8 byte length that still fits in one Discord message for this preset. */
export function maxPlaintextBytes(p: Preset): number {
  const raw = maxRawBytesForChars(DISCORD_CONTENT_LIMIT - PREFIX.length);
  const payloadCap = raw - 1 - SALT_LEN - p.tagBytes;
  return Math.floor(payloadCap / p.padBlock) * p.padBlock - 1;
}

export function utf8Length(s: string): number {
  return utf8Encode(s).length;
}

export function fileOverhead(p: Preset, plainSize: number): number {
  const chunks = Math.max(1, Math.ceil(plainSize / FILE_CHUNK));
  return 1 + SALT_LEN + chunks * p.tagBytes;
}

// ---------------------------------------------------------------- helpers

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function info(kind: string, preset: Preset, channelId: string, senderId: string): Uint8Array {
  const label = utf8Encode("dcenc2/" + kind);
  const ch = utf8Encode(channelId);
  const se = utf8Encode(senderId);
  return concat(
    label,
    Uint8Array.of(preset.index),
    Uint8Array.of((ch.length >>> 8) & 255, ch.length & 255), ch,
    Uint8Array.of((se.length >>> 8) & 255, se.length & 255), se,
  );
}

function aadOf(header: number, salt: Uint8Array, inf: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(header), salt, inf);
}

function chunkNonce(prefix: Uint8Array, counter: number, last: boolean): Uint8Array {
  const n = new Uint8Array(NONCE_LEN);
  n.set(prefix, 0);
  n[7] = (counter >>> 24) & 255;
  n[8] = (counter >>> 16) & 255;
  n[9] = (counter >>> 8) & 255;
  n[10] = counter & 255;
  n[11] = last ? 1 : 0;
  return n;
}

/** Padmé: round L up so that only its top ~log2(log2 L)+1 bits may be non-zero. */
export function padme(L: number): number {
  if (L < 2) return L;
  const e = Math.floor(Math.log2(L));
  const s = Math.floor(Math.log2(e)) + 1;
  const mask = 2 ** (e - s) - 1;
  return Math.floor((L + mask) / (mask + 1)) * (mask + 1);
}

/** Payload length for `n` bytes (data + 0x80 marker): a multiple of padBlock, capped at the max. */
export function paddedLength(n: number, preset: Preset, usePadme = true): number {
  const block = (x: number) => Math.ceil(x / preset.padBlock) * preset.padBlock;
  const plain = block(n);
  if (!usePadme) return plain;
  const cap = maxPlaintextBytes(preset) + 1; // a multiple of padBlock
  return Math.max(plain, Math.min(block(padme(n)), cap));
}

// --------------------------------------------------------------- messages

/** Throws if the text is too long or there is no secure RNG. Caller must then NOT send plaintext. */
export function encryptMessage(plain: string, master: Uint8Array, preset: Preset, channelId: string, senderId: string, opts: { padme?: boolean } = {}): string {
  if (!channelId || !senderId) throw new Error("channel/sender id missing");
  const data = utf8Encode(plain);
  const max = maxPlaintextBytes(preset);
  if (data.length > max) throw new Error(`message too long for ${preset.label}: ${data.length} > ${max} bytes`);

  const padded = paddedLength(data.length + 1, preset, opts.padme !== false);
  const payload = new Uint8Array(padded);
  payload.set(data, 0);
  payload[data.length] = 0x80;

  const header = (VERSION_MESSAGE << 4) | preset.index;
  const salt = randomBytes(SALT_LEN);
  const inf = info("msg", preset, channelId, senderId);
  const okm = hkdf(sha256, master, salt, inf, preset.keyBytes + NONCE_LEN);
  const ct = gcmSeal(okm.subarray(0, preset.keyBytes), okm.subarray(preset.keyBytes), aadOf(header, salt, inf), payload, preset.tagBytes);
  return PREFIX + base64Encode(concat(Uint8Array.of(header), salt, ct), false);
}

/** Returns null for: not v2, wrong key/channel/sender, tampering, garbage. Never throws. */
export function decryptMessage(wire: string, master: Uint8Array, channelId: string, senderId: string): string | null {
  try {
    if (!looksEncrypted(wire) || !master || !channelId || !senderId) return null;
    const raw = base64Decode(wire.slice(PREFIX.length));
    if (!raw || raw.length < 1 + SALT_LEN + 1) return null;
    const header = raw[0];
    if (header >> 4 !== VERSION_MESSAGE) return null;
    const preset = presetFromIndex(header & 0x0f);
    if (!preset) return null;
    const ctLen = raw.length - 1 - SALT_LEN;
    if (ctLen < preset.tagBytes + preset.padBlock || (ctLen - preset.tagBytes) % preset.padBlock !== 0) return null;

    const salt = raw.subarray(1, 1 + SALT_LEN);
    const inf = info("msg", preset, channelId, senderId);
    const okm = hkdf(sha256, master, salt, inf, preset.keyBytes + NONCE_LEN);
    const payload = gcmOpen(okm.subarray(0, preset.keyBytes), okm.subarray(preset.keyBytes), aadOf(header, salt, inf), raw.subarray(1 + SALT_LEN), preset.tagBytes);
    if (!payload) return null;

    let end = payload.length;
    while (end > 0 && payload[end - 1] === 0) end--;
    if (end === 0 || payload[end - 1] !== 0x80) return null;
    return utf8Decode(payload.subarray(0, end - 1));
  } catch {
    return null;
  }
}

/** Preset a v2 message was sent with (for display), or null if it is not a v2 message. */
export function messagePreset(wire: string): Preset | null {
  try {
    if (!looksEncrypted(wire)) return null;
    const raw = base64Decode(wire.slice(PREFIX.length, PREFIX.length + 4));
    if (!raw || raw.length < 1 || raw[0] >> 4 !== VERSION_MESSAGE) return null;
    return presetFromIndex(raw[0] & 0x0f);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ files

export function encryptFile(plain: Uint8Array, master: Uint8Array, preset: Preset, channelId: string, senderId: string): Uint8Array {
  if (!channelId || !senderId) throw new Error("channel/sender id missing");
  const header = (VERSION_FILE << 4) | preset.index;
  const salt = randomBytes(SALT_LEN);
  const inf = info("file", preset, channelId, senderId);
  const okm = hkdf(sha256, master, salt, inf, preset.keyBytes + FILE_PREFIX_LEN);
  const key = okm.subarray(0, preset.keyBytes);
  const noncePrefix = okm.subarray(preset.keyBytes);
  const aad = aadOf(header, salt, inf);

  const chunks = Math.max(1, Math.ceil(plain.length / FILE_CHUNK));
  const out = new Uint8Array(1 + SALT_LEN + plain.length + chunks * preset.tagBytes);
  out[0] = header;
  out.set(salt, 1);
  let o = 1 + SALT_LEN;
  for (let c = 0; c < chunks; c++) {
    const part = plain.subarray(c * FILE_CHUNK, Math.min(plain.length, (c + 1) * FILE_CHUNK));
    const sealed = gcmSeal(key, chunkNonce(noncePrefix, c, c === chunks - 1), aad, part, preset.tagBytes);
    out.set(sealed, o);
    o += sealed.length;
  }
  return out;
}

export function decryptFile(wire: Uint8Array, master: Uint8Array, channelId: string, senderId: string): Uint8Array | null {
  try {
    if (!wire || wire.length < 1 + SALT_LEN || !master || !channelId || !senderId) return null;
    const header = wire[0];
    if (header >> 4 !== VERSION_FILE) return null;
    const preset = presetFromIndex(header & 0x0f);
    if (!preset) return null;
    const salt = wire.subarray(1, 1 + SALT_LEN);
    const inf = info("file", preset, channelId, senderId);
    const okm = hkdf(sha256, master, salt, inf, preset.keyBytes + FILE_PREFIX_LEN);
    const key = okm.subarray(0, preset.keyBytes);
    const noncePrefix = okm.subarray(preset.keyBytes);
    const aad = aadOf(header, salt, inf);

    const body = wire.subarray(1 + SALT_LEN);
    const chunkCt = FILE_CHUNK + preset.tagBytes;
    if (body.length < preset.tagBytes) return null;
    const chunks = Math.ceil(body.length / chunkCt);
    const out = new Uint8Array(body.length - chunks * preset.tagBytes); // no per-chunk copies + concat
    for (let c = 0; c < chunks; c++) {
      const piece = body.subarray(c * chunkCt, Math.min(body.length, (c + 1) * chunkCt));
      if (piece.length < preset.tagBytes) return null;
      const plain = gcmOpen(key, chunkNonce(noncePrefix, c, c === chunks - 1), aad, piece, preset.tagBytes);
      if (!plain) return null;
      out.set(plain, c * FILE_CHUNK);
    }
    return out;
  } catch {
    return null;
  }
}
