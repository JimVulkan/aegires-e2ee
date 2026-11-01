// Byte I/O for attachments: reading local/remote files into memory and writing decrypted or
// encrypted copies to Discord's cache directory through its native file module.
//
// Discord's runtime has no Node `fs` and an incomplete Blob/FileReader, so every step has a
// fallback. Large binary data crosses the JS <-> native bridge as base64 strings.
import { base64Decode, base64Encode } from "./crypto/base64.ts";

const DIR = "aegires";

/** Discord's native file module (name differs between Discord versions). */
export function fileModule(): any {
  const g: any = globalThis as any;
  const tries: Array<() => any> = [
    () => g.nativeModuleProxy?.NativeFileModule,
    () => g.nativeModuleProxy?.RTNFileManager,
    () => g.nativeModuleProxy?.DCDFileManager,
    () => g.__turboModuleProxy?.("NativeFileModule"),
    () => g.__turboModuleProxy?.("RTNFileManager"),
  ];
  for (const t of tries) {
    try {
      const m = t();
      if (m && typeof m.writeFile === "function") return m;
    } catch {}
  }
  return null;
}

function cacheDir(fm: any): string {
  let c: any = fm;
  try { if (typeof fm.getConstants === "function") c = fm.getConstants() ?? fm; } catch {}
  return String(c.CacheDirPath ?? c.cacheDirPath ?? "");
}

const toPath = (uri: string) => decodeURI(uri.replace(/^file:\/\//, ""));

async function blobBytes(blob: any): Promise<Uint8Array> {
  if (typeof blob?.arrayBuffer === "function") {
    try { return new Uint8Array(await blob.arrayBuffer()); } catch {}
  }
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const b = base64Decode(String(r.result).split(",")[1] ?? "");
      b ? resolve(b) : reject(new Error("bad data URL"));
    };
    r.onerror = () => reject(new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });
}

/** Reads a file:// / content:// / https:// URI into memory. Rejects if it exceeds maxBytes. */
export async function readUri(uri: string, maxBytes: number): Promise<Uint8Array> {
  let bytes: Uint8Array | null = null;
  let err: any;
  try {
    const res = await fetch(uri);
    if (!res.ok && res.status !== 0) throw new Error("http " + res.status);
    bytes = await blobBytes(await res.blob());
  } catch (e) {
    err = e;
  }
  if (!bytes && /^(file:\/\/|\/)/.test(uri)) {
    const fm = fileModule();
    if (fm && typeof fm.readFile === "function") {
      bytes = base64Decode(String(await fm.readFile(toPath(uri), "base64")));
    }
  }
  if (!bytes) throw err ?? new Error("could not read " + uri);
  if (bytes.length > maxBytes) throw new Error("file too large");
  return bytes;
}

/** Writes bytes to <cache>/aegires/<name>; resolves to a file:// URI. */
export async function writeCacheFile(name: string, bytes: Uint8Array): Promise<string> {
  const fm = fileModule();
  if (!fm) throw new Error("no native file module");
  const rel = `${DIR}/${name}`;
  const ret = await fm.writeFile("cache", rel, base64Encode(bytes), "base64");
  let path = typeof ret === "string" && ret.startsWith("/") ? ret : "";
  if (!path) {
    const dir = cacheDir(fm);
    if (!dir) throw new Error("unknown cache directory");
    path = `${dir}/${rel}`;
  }
  return "file://" + path;
}

/** Best-effort delete of files written by writeCacheFile. */
export function removeCacheFiles(names: string[]): void {
  const fm = fileModule();
  if (!fm || typeof fm.removeFile !== "function") return;
  for (const n of names) {
    try { Promise.resolve(fm.removeFile("cache", `${DIR}/${n}`)).catch(() => {}); } catch {}
  }
}

/** Unique-enough temp name (not security relevant: it only has to avoid collisions). */
export function tempName(ext: string): string {
  return `up_${Date.now()}_${Math.floor(Math.random() * 1e9)}${ext ? "." + ext : ""}`;
}
