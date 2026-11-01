// Pure helpers for attachments (no Discord imports, so node tests can run them).

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const ATT_RE = /\/attachments\/(\d+)\/(\d+)\/([^/?#]+)/;
const DROP_PARAMS = new Set(["width", "height", "format", "quality", "size", "animated"]);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
};

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

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Image mime for a file name, or null if it is not an image type we display. */
export function imageMimeFor(name: string): string | null {
  return MIME[extOf(name)] ?? null;
}
