// Shared encryption steps for everything we send: message text and attachments.
//
// Rule #1 is FAIL CLOSED: if encryption is switched on for a channel and anything goes wrong
// (no key, text too long, no secure RNG, unreadable file), we do NOT send. Silently sending
// plaintext to a channel where the user believes encryption is on would be the worst bug.
import { notify } from "./notify.ts";
import { RN } from "./rt.ts";
import { MAX_PLAINTEXT_LEN, encryptBytes, encryptText, looksEncrypted } from "./crypto/wire.ts";
import { MAX_FILE_BYTES, encryptedFileName, extOf, imageMimeFor, makeSizeTag } from "./crypto/files.ts";
import { storage } from "@vendetta/plugin";
import { encryptFile, encryptMessage, maxPlaintextBytes, utf8Length } from "./crypto/v2.ts";
import { getSendFormat, getSendKey, getSendKeyV2, getSendPreset, isEncryptionOn } from "./state.ts";
import { getSelfId } from "./self.ts";
import { readUri, readUriBase64, tempName, writeCacheFile, writeCacheFileBase64 } from "./native.ts";
import { base64Encode } from "./crypto/base64.ts";
import { call, engineReady } from "./engine/engine.tsx";
import { diag } from "./diag.ts";

export const BLOCK = Symbol("block");

/**
 * Returns the new content, null to leave the message alone, or BLOCK to cancel the send.
 * `force` encrypts even where encryption is off (edits of encrypted messages, captions).
 */
export function prepare(channelId: string, content: unknown, force = false): string | null | typeof BLOCK {
  if (typeof content !== "string" || content.length === 0) return null;
  if (looksEncrypted(content)) return null; // already encrypted (e.g. our own re-send)
  if (!force && !isEncryptionOn(channelId)) return null;

  try {
    if (getSendFormat(channelId) === "v2") {
      const key = getSendKeyV2(channelId);
      if (!key) {
        notify("E2EE is on for this chat but no v2 key is set (set the password again in the plugin settings) - message not sent");
        return BLOCK;
      }
      const self = getSelfId();
      if (!self) {
        notify("Your Discord user id is not known yet, so the message cannot be encrypted - not sent. Try again in a moment.");
        return BLOCK;
      }
      const preset = getSendPreset(channelId);
      const max = maxPlaintextBytes(preset);
      const len = utf8Length(content);
      if (len > max) {
        notify(`Too long to encrypt with ${preset.label} (${len}/${max} bytes) - message not sent`);
        return BLOCK;
      }
      return encryptMessage(content, key, preset, channelId, self, { padme: storage.padme !== false });
    }
    const key = getSendKey(channelId);
    if (!key) {
      notify("E2EE is on for this chat but no key is set - message not sent");
      return BLOCK;
    }
    if (content.length > MAX_PLAINTEXT_LEN) {
      notify(`Too long to encrypt (${content.length}/${MAX_PLAINTEXT_LEN}) - message not sent`);
      return BLOCK;
    }
    return encryptText(content, key);
  } catch (e) {
    notify("Encryption failed - message not sent");
    console.log("[aegires-e2ee] encrypt error", e);
    return BLOCK;
  }
}

// ---------------------------------------------------------------- attachments

const ENC_MIME = "application/octet-stream";

function imageSize(uri: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    try {
      RN.Image.getSize(uri, (w: number, h: number) => { clearTimeout(t); resolve({ w, h }); }, () => { clearTimeout(t); resolve(null); });
    } catch { clearTimeout(t); resolve(null); }
  });
}

/** The object holding the local file info ({ uri, filename/name, mimeType }) of an upload. */
function descriptorOf(u: any): any | null {
  for (const c of [u?.item?.file, u?.item, u?.file, u]) {
    if (c && typeof c === "object" && typeof c.uri === "string") return c;
  }
  return null;
}

/** Sets only fields the object already has (we must not invent a shape Discord doesn't use). */
function setExisting(o: any, fields: Record<string, any>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (o && k in o) {
      try { o[k] = v; } catch {}
    }
  }
}

/** Encrypted temp file uri -> image size of the original (files encrypted when attached). */
const sizes = new Map<string, { w: number; h: number } | null>();

/** JS sealing (Hermes), plus the same job as arguments for the WebView engine's sealFile. */
type Seal = { local: (plain: Uint8Array) => Uint8Array; engine: Record<string, unknown> };

/** Encrypts the file in the WebView engine; null if the engine is unavailable or failed. */
async function sealInEngine(src: string, seal: Seal, ext: string): Promise<{ uri: string; size: number } | null> {
  if (!engineReady()) return null;
  try {
    const data = await readUriBase64(src, MAX_FILE_BYTES);
    const r = await call<{ data: string; size: number }>("sealFile", { ...seal.engine, data });
    const uri = await writeCacheFileBase64(tempName(ext), r.data);
    diag.engineJobs++;
    return { uri, size: r.size };
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    if (msg === "file too large") throw e;
    diag.engineFallbacks++;
    diag.engineLastError = msg.slice(0, 80);
    return null;
  }
}

/** Encrypts one upload in place; returns the image size for the caption tag, if any. */
async function encryptUpload(u: any, seal: Seal): Promise<{ w: number; h: number } | null> {
  const d = descriptorOf(u);
  if (!d) throw new Error("unknown upload shape: " + Object.keys(u ?? {}).join(","));
  const name: string = d.filename ?? d.name ?? u.filename ?? "file";
  if (sizes.has(d.uri)) return sizes.get(d.uri) ?? null; // already encrypted when attached
  const mime: string = d.mimeType ?? d.type ?? u.mimeType ?? "";
  const src: string = d.originalUri ?? d.uri;

  const size = mime.startsWith("image/") || imageMimeFor(name) ? await imageSize(src) : null;

  let sealed = await sealInEngine(src, seal, extOf(name));
  if (!sealed) {
    const enc = seal.local(await readUri(src, MAX_FILE_BYTES));
    sealed = { uri: await writeCacheFile(tempName(extOf(name)), enc), size: enc.length };
  }
  const tmp = sealed.uri;
  const encSize = sealed.size;
  const encName = encryptedFileName(name);

  setExisting(d, { uri: tmp, originalUri: tmp, filename: encName, name: encName, mimeType: ENC_MIME, type: ENC_MIME, contentType: ENC_MIME, size: encSize, fileSize: encSize });
  // Never let Discord re-compress the ciphertext as if it were a photo or video.
  if (d !== u) setExisting(u, { filename: encName, mimeType: ENC_MIME, isImage: false, isVideo: false, currentSize: encSize, preCompressionSize: encSize });
  if (d.uri !== tmp) throw new Error("could not swap upload uri");
  if ((d.filename ?? d.name ?? u.filename) !== encName) throw new Error("could not swap file name");
  sizes.set(tmp, size);
  if (sizes.size > 200) sizes.delete(sizes.keys().next().value as string);
  diag.attEncrypted++;
  return size;
}

/** Encrypts files in place as they are attached (no caption yet). Resolves false on failure. */
export function encryptAttachments(channelId: string, files: any[]): Promise<boolean> {
  return encryptOutgoing(channelId, files, []);
}

/**
 * Encrypts every upload in place, then the caption(s) with the "[sz:W,H]" tag of the first
 * image. Resolves true when it is safe to send; on any failure tells the user and resolves
 * false (the caller must then NOT send).
 */
export async function encryptOutgoing(channelId: string, uploads: any[], captions: any[]): Promise<boolean> {
  let seal: Seal;
  if (getSendFormat(channelId) === "v2") {
    // v2 file format: per-file HKDF key bound to (channel, sender), 64 KiB authenticated chunks.
    const key = getSendKeyV2(channelId);
    const self = getSelfId();
    if (!key || !self) {
      notify(key ? "Your Discord user id is not known yet - upload cancelled. Try again in a moment." : "E2EE is on for this chat but no v2 key is set - upload cancelled");
      return false;
    }
    const preset = getSendPreset(channelId);
    seal = { local: (b) => encryptFile(b, key, preset, channelId, self), engine: { fmt: "v2", key: base64Encode(key), preset: preset.index, ch: channelId, sender: self } };
  } else {
    const key = getSendKey(channelId);
    if (!key) {
      notify("E2EE is on for this chat but no key is set - upload cancelled");
      return false;
    }
    seal = { local: (b) => encryptBytes(b, key), engine: { fmt: "v1", key: base64Encode(key) } };
  }
  try {
    let tag = "";
    for (const u of uploads) {
      const s = await encryptUpload(u, seal);
      if (s && !tag) tag = makeSizeTag(s.w, s.h);
    }
    for (const holder of captions) {
      if (!holder || typeof holder.content !== "string") continue;
      const out = prepare(channelId, tag + holder.content, true);
      if (out === BLOCK) return false;
      if (out !== null) holder.content = out;
    }
    return true;
  } catch (e) {
    diag.lastAttError = String((e as any)?.message ?? e).slice(0, 80);
    console.log("[aegires-e2ee] attachment encrypt failed", e);
    notify("Attachment encryption failed - upload cancelled (" + diag.lastAttError + ")");
    return false;
  }
}
