// Pure helpers for Aegires' encrypted-attachment conventions (no Discord imports, so the node
// tests can run them directly).

/** Largest attachment we encrypt or decrypt (Discord's free upload limit). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** "photo.png" -> "photo.enc.png", "notes" -> "notes.enc", "" -> "file.enc" (same as Aegires). */
export function encryptedFileName(original: string | null | undefined): string {
  if (!original) return "file.enc";
  const dot = original.lastIndexOf(".");
  if (dot > 0 && dot < original.length - 1) return original.slice(0, dot) + ".enc" + original.slice(dot);
  return original + ".enc";
}

/** True for names Aegires would have produced: "x.enc.png" or "x.enc". */
export function isEncryptedFileName(name: string | null | undefined): boolean {
  return !!name && (name.includes(".enc.") || name.endsWith(".enc"));
}

/** Inverse of encryptedFileName, for display / saving: "photo.enc.png" -> "photo.png". */
export function originalFileName(name: string): string {
  if (name.endsWith(".enc")) return name.slice(0, -4);
  const i = name.lastIndexOf(".enc.");
  return i >= 0 ? name.slice(0, i) + name.slice(i + 4) : name;
}

// Aegires prefixes the (encrypted) message text of an image upload with "[sz:W,H]" so the
// receiver can reserve the right space before the image is downloaded and decrypted.
const SIZE_TAG = /^\[sz:(\d+),(\d+)\]/;

export function makeSizeTag(width: number, height: number): string {
  return `[sz:${Math.round(width)},${Math.round(height)}]`;
}

/** Splits a decrypted message body into its optional size tag and the text the user typed. */
export function splitSizeTag(body: string): { width: number; height: number; text: string } | { width: null; height: null; text: string } {
  const m = SIZE_TAG.exec(body);
  if (!m) return { width: null, height: null, text: body };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10), text: body.slice(m[0].length) };
}

// ---------------------------------------------------------------- Discord CDN URLs

const ATT_RE = /\/attachments\/(\d+)\/(\d+)\/([^/?#]+)/;
const DROP_PARAMS = new Set(["width", "height", "format", "quality", "size", "animated"]);

export interface AttachmentRef {
  channelId: string;
  attachmentId: string;
  filename: string;
}

/** Parses a Discord CDN/media-proxy attachment URL. Null if it is not one. */
export function parseAttachmentUrl(url: string): AttachmentRef | null {
  const m = ATT_RE.exec(url);
  if (!m) return null;
  let filename = m[3];
  try { filename = decodeURIComponent(filename); } catch {}
  return { channelId: m[1], attachmentId: m[2], filename };
}

/** Raw-file URL: cdn host, resize params removed, signature params (ex/is/hm) kept. */
export function rawCdnUrl(url: string): string {
  const q = url.indexOf("?");
  const base = (q >= 0 ? url.slice(0, q) : url).replace(/^(https?:\/\/)media\.discordapp\.net/, "$1cdn.discordapp.com");
  if (q < 0) return base;
  const kept = url
    .slice(q + 1)
    .split("&")
    .filter((p) => p && !DROP_PARAMS.has(p.split("=")[0]));
  return kept.length ? base + "?" + kept.join("&") : base;
}

// ---------------------------------------------------------------- MIME types

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  zip: "application/zip",
};

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** MIME type for a (plaintext) file name; application/octet-stream if unknown. */
export function mimeFor(name: string): string {
  return MIME[extOf(name)] ?? "application/octet-stream";
}

/** Image mime for a file name, or null if it is not an image type we display. */
export function imageMimeFor(name: string): string | null {
  const m = MIME[extOf(name)];
  return m && m.startsWith("image/") ? m : null;
}
