// OUTGOING attachments. Messages with attachments do not go through sendMessage: Discord's
// uploadLocalFiles({ channelId, uploads, parsedMessage, ... }) uploads the files and posts the
// caption itself. If encryption is on for the channel we, before calling the original:
//   - read each file, encrypt it (iv || AES-GCM || tag), write the result to a temp file and
//     point the upload at it, renamed "x.enc.ext" with a neutral MIME type (Aegires format);
//   - put "[sz:W,H]" in front of the caption for images, then encrypt the caption.
// FAIL CLOSED: if any step fails, or the upload object has an unknown shape, nothing is sent.
import { findFns, instead, noteFound, selectedChannelId } from "../patch.ts";
import { notify } from "../notify.ts";
import { storage } from "@vendetta/plugin";
import { RN } from "../rt.ts";
import { encryptBytes } from "../crypto/wire.ts";
import { MAX_FILE_BYTES, encryptedFileName, extOf, imageMimeFor, makeSizeTag } from "../crypto/files.ts";
import { getSendKey, isEncryptionOn } from "../state.ts";
import { readUri, tempName, writeCacheFile } from "../native.ts";
import { diag } from "../diag.ts";
import { BLOCK, prepare } from "./send.ts";

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

/** Encrypts one upload in place; returns the image size for the caption tag, if any. */
async function encryptUpload(u: any, key: Uint8Array): Promise<{ w: number; h: number } | null> {
  const d = descriptorOf(u);
  if (!d) throw new Error("unknown upload shape: " + Object.keys(u ?? {}).join(","));
  const name: string = d.filename ?? d.name ?? u.filename ?? "file";
  const mime: string = d.mimeType ?? d.type ?? u.mimeType ?? "";
  const src: string = d.originalUri ?? d.uri;

  const bytes = await readUri(src, MAX_FILE_BYTES);
  const size = mime.startsWith("image/") || imageMimeFor(name) ? await imageSize(src) : null;

  const enc = encryptBytes(bytes, key);
  const tmp = await writeCacheFile(tempName(extOf(name)), enc);
  const encName = encryptedFileName(name);

  setExisting(d, { uri: tmp, originalUri: tmp, filename: encName, name: encName, mimeType: ENC_MIME, type: ENC_MIME, contentType: ENC_MIME, size: enc.length, fileSize: enc.length });
  // Never let Discord re-compress the ciphertext as if it were a photo or video.
  if (d !== u) setExisting(u, { filename: encName, mimeType: ENC_MIME, isImage: false, isVideo: false, currentSize: enc.length, preCompressionSize: enc.length });
  if (d.uri !== tmp) throw new Error("could not swap upload uri");
  if ((d.filename ?? d.name ?? u.filename) !== encName) throw new Error("could not swap file name");
  diag.attEncrypted++;
  return size;
}

/** Encrypts the caption (with optional size tag) wherever this Discord version keeps it. */
function encryptCaption(channelId: string, opts: any, tag: string): void {
  for (const holder of [opts?.parsedMessage, opts?.message]) {
    if (!holder || typeof holder.content !== "string") continue;
    const out = prepare(channelId, tag + holder.content, true);
    if (out === BLOCK) throw new Error("caption could not be encrypted");
    if (out !== null) holder.content = out;
  }
}

export function installUploadPatch(): () => void {
  const mod = findFns("uploadLocalFiles");
  noteFound("upload module", mod);
  if (!mod) throw new Error("uploadLocalFiles not found - attachments are NOT encrypted");

  return instead("uploadLocalFiles", mod, (args, orig) => {
    const opts = args[0];
    const channelId: string = String(opts?.channelId ?? opts?.channel?.id ?? selectedChannelId() ?? "");
    if (!channelId || !isEncryptionOn(channelId)) return orig(...args);

    if (!storage.attachments) {
      notify("Encrypted attachments are turned off in the plugin settings - upload cancelled so nothing is sent unencrypted.");
      return Promise.resolve();
    }
    const key = getSendKey(channelId);
    if (!key) {
      notify("E2EE is on for this chat but no key is set - upload cancelled");
      return Promise.resolve();
    }
    const uploads: any[] = Array.isArray(opts?.uploads) ? opts.uploads : Array.isArray(opts?.files) ? opts.files : [];
    if (!uploads.length) {
      notify("Unknown upload format - upload cancelled so nothing is sent unencrypted");
      console.log("[aegires-e2ee] uploadLocalFiles args", Object.keys(opts ?? {}));
      return Promise.resolve();
    }
    return (async () => {
      try {
        let tag = "";
        for (const u of uploads) {
          const s = await encryptUpload(u, key);
          if (s && !tag) tag = makeSizeTag(s.w, s.h);
        }
        encryptCaption(channelId, opts, tag);
      } catch (e) {
        diag.lastAttError = String((e as any)?.message ?? e).slice(0, 80);
        console.log("[aegires-e2ee] attachment encrypt failed", e);
        notify("Attachment encryption failed - upload cancelled (" + diag.lastAttError + ")");
        return;
      }
      return orig(...args);
    })();
  });
}
