// INCOMING attachments: "photo.enc.png" files sent by Aegires (or by this plugin).
//
// Discord renders the chat list natively, so we cannot swap image components in JS. Instead:
//   1. receive.ts calls handleAttachments() for every message passing through FluxDispatcher.
//   2. Attachments we already decrypted are rewritten synchronously: url/proxy_url point at
//      the decrypted file in Discord's cache dir, filename/content_type/size are the real ones.
//   3. New ones are queued: download, decrypt, write to cache, then dispatch a partial
//      MESSAGE_UPDATE so the message store picks up the rewritten attachment (the same kind
//      of partial update the gateway sends when an embed unfurls).
import { storage } from "@vendetta/plugin";
import { decryptBytes } from "../crypto/wire.ts";
import { MAX_FILE_BYTES, extOf, imageDims, imageMimeFor, videoDims, isEncryptedFileName, mimeFor, originalFileName, rawCdnUrl } from "../crypto/files.ts";
import { base64Encode } from "../crypto/base64.ts";
import { decryptFile } from "../crypto/v2.ts";
import { getReceiveKeys, getReceiveKeysV2 } from "../state.ts";
import { readUri, removeCacheFiles, writeCacheFile, writeCacheFileBase64 } from "../native.ts";
import { call, engineReady } from "../engine/engine.tsx";
import { diag } from "../diag.ts";

const log = (...a: any[]) => { if (storage.debug) console.log("[aegires-e2ee:media]", ...a); };

interface Decrypted { uri: string; name: string; mime: string; size: number; w?: number; h?: number }

const done = new Map<string, Decrypted>(); // attachment id -> decrypted file
const failed = new Set<string>(); // attachment ids that did not decrypt (no retry until reload)
const queued = new Set<string>();
const written: string[] = []; // cache file names, removed on unload

let dispatch: ((e: any) => void) | null = null;
export function setDispatcher(d: ((e: any) => void) | null): void {
  dispatch = d;
}

// ---------------------------------------------------------------- work queue
const MAX_PARALLEL = 2;
let running = 0;
const jobs: Array<() => Promise<void>> = [];

function pump(): void {
  while (running < MAX_PARALLEL && jobs.length) {
    const job = jobs.shift()!;
    running++;
    job().finally(() => { running--; pump(); });
  }
}

/** Runs fn through the queue; the promise settles (never rejects) when fn has finished. */
function enqueue(fn: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    jobs.push(() => fn().catch(() => {}).finally(resolve));
    pump();
  });
}

// ---------------------------------------------------------------- rewriting
function apply(a: any, d: Decrypted, size: { w: number; h: number } | null): void {
  a.url = d.uri;
  a.proxy_url = d.uri;
  a.filename = d.name;
  a.content_type = d.mime;
  a.size = d.size;
  // Discord only draws images and videos inline when it knows their size.
  if (d.mime.startsWith("image/")) {
    a.width = d.w ?? size?.w ?? a.width ?? 480;
    a.height = d.h ?? size?.h ?? a.height ?? 360;
  } else if (d.mime.startsWith("video/")) {
    a.width = d.w ?? size?.w ?? a.width ?? 640;
    a.height = d.h ?? size?.h ?? a.height ?? 360;
  }
}

/** Attachments that are ours to handle: "x.enc.ext" names on Discord's CDN. */
function isEncAttachment(a: any): boolean {
  return !!a && typeof a === "object" && isEncryptedFileName(a.filename) && typeof (a.url ?? a.proxy_url) === "string" && !String(a.url).startsWith("file:") && !String(a.url).startsWith("data:");
}

interface Keys { v1: Uint8Array[]; v2: Uint8Array[]; channelId?: string; authorId?: string }

/** v2 file (header 0x3N, bound to channel + author) first, then v1 (iv || gcm). */
function openFile(blob: Uint8Array, k: Keys): Uint8Array | null {
  if (blob.length && blob[0] >> 4 === 3 && k.channelId && k.authorId) {
    for (const key of k.v2) {
      const plain = decryptFile(blob, key, k.channelId, k.authorId);
      if (plain) return plain;
    }
  }
  for (const key of k.v1) {
    const plain = decryptBytes(blob, key);
    if (plain) return plain;
  }
  return null;
}

type EngineOpen = { data: string; size: number; w?: number; h?: number } | null;

/**
 * Downloads and decrypts in the WebView engine (fetching the CDN URL itself when it can), so the
 * plaintext only crosses into Hermes as base64 for the file write. Undefined: use the JS path.
 */
async function decryptInEngine(a: any, keys: Keys, url: string, name: string, mime: string): Promise<Decrypted | undefined> {
  if (!engineReady()) return undefined;
  const max = MAX_FILE_BYTES + 64 * 1024;
  const args = {
    v2: keys.v2.map((k) => base64Encode(k)),
    v1: keys.v1.map((k) => base64Encode(k)),
    ch: keys.channelId,
    author: keys.authorId,
    kind: imageMimeFor(name) ? "image" : mime.startsWith("video/") ? "video" : "",
    max,
  };
  let r: EngineOpen;
  try {
    try {
      r = await call<EngineOpen>("openFile", { ...args, url });
    } catch (e) {
      if (!String((e as any)?.message).startsWith("fetch")) throw e;
      r = await call<EngineOpen>("openFile", { ...args, data: base64Encode(await readUri(url, max)) });
    }
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    if (msg === "file too large") throw e;
    diag.engineFallbacks++;
    diag.engineLastError = msg.slice(0, 80);
    return undefined;
  }
  diag.engineJobs++;
  if (!r) throw new Error("wrong key or corrupted file");
  let uri: string;
  try {
    const file = `${a.id}.${extOf(name) || "bin"}`;
    uri = await writeCacheFileBase64(file, r.data);
    written.push(file);
  } catch (e) {
    if (!imageMimeFor(name) || r.size > 2 * 1024 * 1024) throw e;
    uri = `data:${mime};base64,${r.data}`;
  }
  return { uri, name, mime, size: r.size, w: r.w, h: r.h };
}

async function decryptOne(a: any, keys: Keys, size: { w: number; h: number } | null): Promise<Decrypted> {
  const url = rawCdnUrl(String(a.url ?? a.proxy_url));
  const fast = await decryptInEngine(a, keys, url, originalFileName(String(a.filename)), mimeFor(originalFileName(String(a.filename))));
  if (fast) return { ...fast, w: fast.w ?? size?.w, h: fast.h ?? size?.h };
  const blob = await readUri(url, MAX_FILE_BYTES + 64 * 1024);
  const plain = openFile(blob, keys);
  if (!plain) throw new Error("wrong key or corrupted file");
  const name = originalFileName(String(a.filename));
  const mime = mimeFor(name);
  let uri: string;
  try {
    const file = `${a.id}.${extOf(name) || "bin"}`;
    uri = await writeCacheFile(file, plain);
    written.push(file);
  } catch (e) {
    // No writable file system: small images can still be shown from a data: URI.
    if (!imageMimeFor(name) || plain.length > 2 * 1024 * 1024) throw e;
    uri = `data:${mime};base64,${base64Encode(plain)}`;
  }
  // Real pixel size from the file itself; the sender's [sz:W,H] tag is only a fallback.
  const dims = (imageMimeFor(name) && imageDims(plain)) || (mime.startsWith("video/") && videoDims(plain)) || size;
  return { uri, name, mime, size: plain.length, w: dims?.w, h: dims?.h };
}

export function handleAttachments(m: any, channelId: string | undefined, size: { w: number; h: number } | null, authorId?: string): void {
  if (!storage.attachments) return;
  const pending: Array<Promise<void>> = [];
  for (const a of m.attachments) {
    if (!isEncAttachment(a)) continue;
    const id = String(a.id);
    const hit = done.get(id);
    if (hit) { apply(a, hit, size); continue; }
    diag.attSeen++;
    if (failed.has(id) || queued.has(id)) continue;
    const keys: Keys = { v1: getReceiveKeys(channelId), v2: getReceiveKeysV2(channelId), channelId, authorId };
    if (!keys.v1.length && !keys.v2.length) continue;
    queued.add(id);
    const snapshot = { ...a };
    pending.push(enqueue(async () => {
      try {
        done.set(id, await decryptOne(snapshot, keys, size));
        diag.attDecrypted++;
      } catch (e) {
        failed.add(id);
        diag.attFailed++;
        diag.lastAttError = String((e as any)?.message ?? e).slice(0, 80);
        log("decrypt failed", id, e);
      } finally {
        queued.delete(id);
      }
    }));
  }
  if (!pending.length) return;
  // After this message's jobs finish, push the rewritten attachments into the message store.
  const msgId = m.id;
  const chan = m.channel_id ?? channelId;
  const atts: any[] = m.attachments.map((a: any) => ({ ...a }));
  Promise.all(pending).then(() => {
    let changed = false;
    for (const a of atts) {
      const d = isEncAttachment(a) ? done.get(String(a.id)) : undefined;
      if (d) { apply(a, d, size); changed = true; }
    }
    if (!changed || !dispatch || !msgId || !chan) return;
    try {
      dispatch({ type: "MESSAGE_UPDATE", message: { id: msgId, channel_id: chan, attachments: atts } });
    } catch (e) {
      log("update dispatch failed", e);
    }
  });
}

export function clearMedia(): void {
  jobs.length = 0;
  removeCacheFiles(written.splice(0));
  done.clear();
  failed.clear();
  queued.clear();
}
