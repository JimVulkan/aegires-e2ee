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

// ---------------------------------------------------------------- image dimensions

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...Array.from(b.subarray(i, i + n)));

/** EXIF orientation (1-8) from a JPEG APP1 segment, or 1. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (ascii(b, start, 4) !== "Exif") return 1;
  const t = start + 6; // TIFF header
  const le = b[t] === 0x49; // "II" little endian, "MM" big endian
  const r16 = (i: number) => (le ? u16le(b, i) : u16be(b, i));
  const r32 = (i: number) => (le ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = r16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 1;
}

/**
 * Pixel size of a PNG / JPEG / GIF / WebP / BMP from its header, as displayed (JPEG EXIF
 * rotation applied). Null if the format is unknown. Used to give decrypted images the right
 * aspect ratio, since Discord crops images into the box their width/height describe.
 */
export function imageDims(b: Uint8Array): { w: number; h: number } | null {
  try {
    if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { w: u32be(b, 16), h: u32be(b, 20) };
    if (b.length >= 10 && ascii(b, 0, 3) === "GIF") return { w: u16le(b, 6), h: u16le(b, 8) };
    if (b.length >= 26 && ascii(b, 0, 2) === "BM") return { w: Math.abs(u16le(b, 18) | (u16le(b, 20) << 16)), h: Math.abs(u16le(b, 22) | (u16le(b, 24) << 16)) };
    if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
      const kind = ascii(b, 12, 4);
      if (kind === "VP8X") return { w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
      if (kind === "VP8 ") return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
      if (kind === "VP8L") return { w: 1 + (b[21] | ((b[22] & 0x3f) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
      return null;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let orientation = 1;
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker === 0xff) { i++; continue; }
        const len = u16be(b, i + 2);
        if (marker === 0xe1) orientation = exifOrientation(b, i + 4, Math.min(b.length, i + 2 + len));
        // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = u16be(b, i + 5);
          const w = u16be(b, i + 7);
          return orientation >= 5 && orientation <= 8 ? { w: h, h: w } : { w, h };
        }
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

/**
 * Display size of an MP4 / MOV video from the first video track's "tkhd" box (16.16 fixed-point
 * width/height, swapped when the track matrix rotates by 90 degrees). Null if not found.
 */
export function videoDims(b: Uint8Array): { w: number; h: number } | null {
  const CONTAINERS = new Set(["moov", "trak"]);
  const walk = (start: number, end: number, depth: number): { w: number; h: number } | null => {
    let i = start;
    while (i + 8 <= end && depth < 6) {
      let size = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      let header = 8;
      if (size === 1 && i + 16 <= end) { size = u32be(b, i + 8) * 0x100000000 + u32be(b, i + 12); header = 16; }
      else if (size === 0) size = end - i;
      if (size < header || i + size > end) return null;
      if (type === "tkhd") {
        const v = b[i + header];
        const body = i + header + 4 + (v === 1 ? 32 : 20) + 8 + 8; // matrix: after flags, times/ids, reserved, layer..volume+reserved
        if (body + 36 + 8 <= i + size) {
          const w = u32be(b, body + 36) / 65536;
          const h = u32be(b, body + 40) / 65536;
          if (w > 0 && h > 0) {
            const rotated = u32be(b, body) === 0 && u32be(b, body + 4) !== 0; // matrix a = 0, b != 0
            return rotated ? { w: Math.round(h), h: Math.round(w) } : { w: Math.round(w), h: Math.round(h) };
          }
        }
      } else if (CONTAINERS.has(type)) {
        const r = walk(i + header, i + size, depth + 1);
        if (r) return r;
      }
      i += size;
    }
    return null;
  };
  try {
    return walk(0, b.length, 0);
  } catch {
    return null;
  }
}
