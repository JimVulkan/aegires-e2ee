// Encrypted attachments (images). See docs/FRIEND_TASK.md.
//
// RECEIVE (3 small patches that cooperate)
//   1. before FluxDispatcher.dispatch: for messages with "x.enc.png"-style attachments we set
//      content_type + width/height (from the "[sz:W,H]" tag receive.ts stashed). Discord then
//      draws them with its normal IMAGE component instead of a file row, reserving the space.
//   2. before jsx/jsxs/createElement: any <Image source={{uri}}> whose uri is an encrypted
//      attachment is swapped for <DecryptedMedia>, which downloads, decrypts and shows it
//      (placeholders: Decrypting / Key missing / Decrypt failed). No component name needed.
// SEND
//   3. instead uploadLocalFiles: if encryption is on, read the file, encrypt, write a temp
//      file, swap uri/name/mime. FAIL CLOSED: any problem cancels the upload.
//   4. before sendMessage: puts "[sz:W,H]" in front of the caption (send.ts then encrypts it).
import { before, instead, findFns, findFlux, selectedChannelId } from "../patch.ts";
import { React, RN as ReactNative } from "../rt.ts";
import { storage } from "@vendetta/plugin";
import { notify as showToast } from "../notify.ts";
import { base64Decode, base64Encode } from "../crypto/base64.ts";
import { decryptBytes, encryptBytes, looksEncrypted } from "../crypto/wire.ts";
import { encryptedFileName, isEncryptedFileName, makeSizeTag } from "../crypto/files.ts";
import { getReceiveKeys, getSendKey, isEncryptionOn } from "../state.ts";
import { diag } from "../diag.ts";
import { MAX_FILE_BYTES, imageMimeFor, parseAttachmentUrl, rawCdnUrl } from "./attachments-util.ts";

const log = (...a: any[]) => { if (storage.debug) console.log("[aegires-e2ee:att]", ...a); };

// ---------------------------------------------------------------- shared: size hints
/** message id -> pixel size from the decrypted "[sz:W,H]" tag (filled by receive.ts). */
const sizeHints = new Map<string, { w: number; h: number }>();
export function recordSizeHint(messageId: string | undefined, w: number | null, h: number | null): void {
  if (!messageId || !w || !h) return;
  sizeHints.set(messageId, { w, h });
  if (sizeHints.size > 300) sizeHints.delete(sizeHints.keys().next().value as string);
}

// ---------------------------------------------------------------- RECEIVE 1: mark as image
function fixMessage(m: any): void {
  if (!m || !Array.isArray(m.attachments)) return;
  for (const a of m.attachments) {
    if (!a || !isEncryptedFileName(a.filename)) continue;
    const mime = imageMimeFor(a.filename.replace(".enc", ""));
    if (!mime) continue; // non-image: stays a normal file row (Part C)
    const hint = sizeHints.get(m.id);
    a.content_type = mime;
    a.width = hint?.w ?? a.width ?? 480;
    a.height = hint?.h ?? a.height ?? 360;
  }
  if (m.referenced_message) fixMessage(m.referenced_message);
}

function installMarkPatch(): () => void {
  const FluxDispatcher = findFlux();
  if (!FluxDispatcher) throw new Error("FluxDispatcher not found");
  return before("dispatch", FluxDispatcher, (args: any[]) => {
    try {
      const e = args[0];
      if (!e || typeof e !== "object") return;
      if (e.message) fixMessage(e.message);
      if (Array.isArray(e.messages)) {
        for (const m of e.messages) Array.isArray(m) ? m.forEach(fixMessage) : fixMessage(m);
      }
    } catch (err) {
      log("mark error", err);
    }
  });
}

// ---------------------------------------------------------------- RECEIVE 2: render
const cache = new Map<string, string>(); // attachmentId -> data URI (last 20)
const inflight = new Map<string, Promise<string>>();

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("http " + res.status);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_FILE_BYTES + 64) throw new Error("too big");
  return new Uint8Array(buf);
}

/** Resolves to a data URI, or rejects with "nokey" / "fail". */
function loadDecrypted(url: string): Promise<string> {
  const ref = parseAttachmentUrl(url)!;
  const hit = cache.get(ref.attachmentId);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(ref.attachmentId);
  if (running) return running;

  const keys = getReceiveKeys(ref.channelId);
  if (!keys.length) return Promise.reject("nokey");

  const p = (async () => {
    const blob = await fetchBytes(rawCdnUrl(url));
    for (const k of keys) {
      const plain = decryptBytes(blob, k);
      if (plain) {
        const mime = imageMimeFor(ref.filename.replace(".enc", "")) ?? "application/octet-stream";
        const uri = `data:${mime};base64,${base64Encode(plain)}`;
        cache.set(ref.attachmentId, uri);
        if (cache.size > 20) cache.delete(cache.keys().next().value as string);
        return uri;
      }
    }
    throw "fail";
  })().finally(() => inflight.delete(ref.attachmentId));
  inflight.set(ref.attachmentId, p);
  return p;
}

function DecryptedMedia(p: { orig: any; origProps: any; url: string; where: string }) {
  const [state, setState] = React.useState(cache.get(parseAttachmentUrl(p.url)!.attachmentId) ?? "loading");
  React.useEffect(() => {
    let dead = false;
    if (!state.startsWith("data:")) {
      loadDecrypted(p.url).then(
        (uri) => !dead && setState(uri),
        (why) => !dead && setState(why === "nokey" ? "nokey" : "fail"),
      );
    }
    return () => { dead = true; };
  }, [p.url]);

  if (state.startsWith("data:")) {
    const props = { ...p.origProps };
    if (p.where === "uri") props.uri = state;
    else if (p.where === "array") props.source = [{ ...props.source[0], uri: state }, ...props.source.slice(1)];
    else props.source = { ...props.source, uri: state };
    return React.createElement(p.orig, props);
  }
  const { View, Text } = ReactNative;
  const label = state === "loading" ? "🔒 Decrypting…" : state === "nokey" ? "🔒 Key missing" : "🔒 Decrypt failed";
  return React.createElement(
    View,
    { style: [p.origProps.style, { minHeight: 60, alignItems: "center", justifyContent: "center", backgroundColor: "#2b2d31", borderRadius: 8 }] },
    React.createElement(Text, { style: { color: "#b5bac1" } }, label),
  );
}

function encInfo(props: any): { url: string; where: string } | null {
  if (!props || typeof props !== "object") return null;
  const s = props.source;
  let uri: any, where = "";
  if (s && typeof s === "object" && !Array.isArray(s)) { uri = s.uri; where = "source"; }
  else if (Array.isArray(s) && s[0] && typeof s[0] === "object") { uri = s[0].uri; where = "array"; }
  else if (typeof props.uri === "string") { uri = props.uri; where = "uri"; }
  if (typeof uri !== "string" || uri.indexOf(".enc") === -1) return null;
  const ref = parseAttachmentUrl(uri);
  return ref && isEncryptedFileName(ref.filename) ? { url: uri, where } : null;
}

function installRenderPatch(): () => void {
  const undo: Array<() => void> = [];
  const hook = (name: string, parent: any, isJsx: boolean) => {
    if (!parent || typeof parent[name] !== "function") return;
    undo.push(
      before(name, parent, (args: any[]) => {
        try {
          const [type, props] = args;
          if (type === DecryptedMedia || typeof type === "string") return;
          const info = encInfo(props);
          if (!info) return;
          const origProps = isJsx ? props : args.length > 2 ? { ...props, children: args.length === 3 ? args[2] : args.slice(2) } : props;
          const next = [DecryptedMedia, { orig: type, origProps, url: info.url, where: info.where }];
          if (isJsx && args.length > 2) next.push(args[2]); // key
          return next;
        } catch (e) {
          log("render hook error", e);
        }
      }),
    );
  };
  const jsxRt = findFns("jsx", "jsxs");
  hook("jsx", jsxRt, true);
  hook("jsxs", jsxRt, true);
  hook("createElement", React, false);
  if (!undo.length) throw new Error("could not hook rendering - encrypted images will not display");
  return () => undo.forEach((u) => u());
}

// ---------------------------------------------------------------- SEND helpers
const FM: any = (globalThis as any).nativeModuleProxy?.DCDFileManager ?? (globalThis as any).nativeModuleProxy?.RTNFileManager;

async function readBytes(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri);
  const blob: any = await res.blob();
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const b = base64Decode(String(r.result).split(",")[1] ?? "");
      b ? resolve(b) : reject(new Error("decode"));
    };
    r.onerror = () => reject(new Error("read"));
    r.readAsDataURL(blob);
  });
}

async function writeTemp(bytes: Uint8Array): Promise<string> {
  if (!FM || typeof FM.writeFile !== "function") throw new Error("no native file module");
  const rel = `aegires_${Date.now()}_${Math.floor(Math.random() * 1e9)}.bin`;
  const b64 = base64Encode(bytes);
  const consts = (typeof FM.getConstants === "function" ? FM.getConstants() : FM) ?? {};
  let lastErr: any;
  for (const [dirName, dirPath] of [["cache", consts.CacheDirPath], ["documents", consts.DocumentsDirPath]] as const) {
    try {
      const ret = await FM.writeFile(dirName, rel, b64, "base64");
      let path: string = typeof ret === "string" && ret ? ret : dirPath ? `${dirPath}/${rel}` : "";
      if (!path) continue;
      if (path.startsWith("/")) path = "file://" + path;
      return path;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("write failed");
}

function imageSize(uri: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    try {
      ReactNative.Image.getSize(uri, (w: number, h: number) => { clearTimeout(t); resolve({ w, h }); }, () => { clearTimeout(t); resolve(null); });
    } catch { clearTimeout(t); resolve(null); }
  });
}

/** Finds the object holding the local file info ({uri, name, mimeType}) inside an upload item. */
function descriptorOf(u: any): any | null {
  for (const c of [u?.item?.file, u?.file, u?.item, u]) {
    if (c && typeof c === "object" && typeof c.uri === "string") return c;
  }
  return null;
}
function setAll(o: any, fields: Record<string, any>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (o && k in o) { try { o[k] = v; } catch {} }
  }
}

const pendingTag = new Map<string, { tag: string; t: number }>();

async function encryptUpload(u: any, key: Uint8Array, channelId: string): Promise<void> {
  const d = descriptorOf(u);
  if (!d) throw new Error("unknown upload shape: " + Object.keys(u ?? {}).join(","));
  const name: string = d.name ?? d.filename ?? u.filename ?? "file";
  const mime: string = d.mimeType ?? d.type ?? u.mimeType ?? "";

  const bytes = await readBytes(d.uri);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("file over 8 MB");

  if (mime.startsWith("image/") || imageMimeFor(name)) {
    const s = await imageSize(d.uri);
    if (s) pendingTag.set(channelId, { tag: makeSizeTag(s.w, s.h), t: Date.now() });
  }

  const enc = encryptBytes(bytes, key);
  const tmp = await writeTemp(enc);
  const encName = encryptedFileName(name);
  const fields = { uri: tmp, name: encName, filename: encName, mimeType: "application/octet-stream", type: "application/octet-stream", contentType: "application/octet-stream" };
  setAll(d, fields);
  if (d !== u) setAll(u, { filename: encName, mimeType: "application/octet-stream" });
  if (d.uri !== tmp) throw new Error("could not swap upload uri"); // plaintext would go out
  const finalName = d.name ?? d.filename ?? u.filename;
  if (finalName !== encName) throw new Error("could not swap file name");
}

// ---------------------------------------------------------------- SEND 3: upload
function installUploadPatch(): () => void {
  const mod = findFns("uploadLocalFiles");
  if (!mod) {
    throw new Error("upload hook not found - attachments are NOT encrypted");
  }
  return instead("uploadLocalFiles", mod, (args: any[], orig: (...a: any[]) => any) => {
    const opts = args[0];
    let channelId: string | undefined = opts?.channelId ?? opts?.channel?.id;
    if (!channelId) channelId = selectedChannelId() || undefined;
    if (!channelId || !isEncryptionOn(channelId)) return orig(...args);

    const key = getSendKey(channelId);
    if (!key) {
      showToast("E2EE is on but no key is set - upload cancelled");
      return Promise.resolve();
    }
    const uploads: any[] = Array.isArray(opts?.uploads) ? opts.uploads : Array.isArray(opts?.files) ? opts.files : [];
    if (!uploads.length) {
      showToast("Aegires E2EE: unknown upload format - upload cancelled to stay safe");
      log("uploadLocalFiles args", Object.keys(opts ?? {}));
      return Promise.resolve();
    }
    return (async () => {
      try {
        for (const u of uploads) await encryptUpload(u, key, channelId!);
      } catch (e) {
        console.log("[aegires-e2ee] attachment encrypt failed", e);
        showToast("Attachment encryption failed - upload cancelled");
        return;
      }
      return orig(...args);
    })();
  });
}

// ---------------------------------------------------------------- SEND 4: size tag in caption
function installTagPatch(): () => void {
  const MessageActions = findFns("sendMessage", "receiveMessage");
  if (!MessageActions) throw new Error("sendMessage module not found");
  // `before` runs ahead of send.ts's `instead`, so the tag gets encrypted with the caption.
  return before("sendMessage", MessageActions, (args: any[]) => {
    const [channelId, message] = args;
    const p = typeof channelId === "string" ? pendingTag.get(channelId) : undefined;
    if (!p || !message) return;
    pendingTag.delete(channelId);
    if (Date.now() - p.t > 120000) return;
    if (typeof message.content === "string" && !looksEncrypted(message.content) && isEncryptionOn(channelId)) {
      message.content = p.tag + message.content;
    }
  });
}

// ---------------------------------------------------------------- entry
export function installAttachmentPatches(): () => void {
  const unpatches: Array<() => void> = [];
  const timers: any[] = [];
  let stopped = false;
  const add = (name: string, f: () => () => void, retry = 2) => {
    if (stopped) return;
    try {
      unpatches.push(f());
      diag.installed["att: " + name] = "ok";
    } catch (e) {
      const msg = String((e as any)?.message ?? e).slice(0, 80);
      diag.installed["att: " + name] = "FAILED: " + msg + (retry > 0 ? " (retrying)" : "");
      console.log(`[aegires-e2ee] ${name} failed`, e);
      if (retry > 0) timers.push(setTimeout(() => add(name, f, retry - 1), 5000));
    }
  };
  add("attachment marker", installMarkPatch);
  add("attachment renderer", installRenderPatch);
  add("upload patch", installUploadPatch);
  add("caption size tag", installTagPatch);
  return () => {
    stopped = true;
    timers.forEach((t) => clearTimeout(t));
    unpatches.slice().reverse().forEach((u) => { try { u(); } catch {} });
    cache.clear(); inflight.clear(); sizeHints.clear(); pendingTag.clear();
  };
}
