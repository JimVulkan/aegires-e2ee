// OUTGOING attachments. Depending on the Discord version, files are sent by one of several
// upload functions ({ channelId, uploads | files, parsedMessage, ... }) instead of sendMessage.
// We wrap every one we can find; when encryption is on for the channel the files and the
// caption are encrypted first (see outgoing.ts), and nothing is sent if that fails.
//
// Discord's module system initialises modules lazily, so the upload module may not exist yet
// when the plugin loads. We keep retrying in the background, and receive.ts calls
// retryUploadPatch() as soon as an upload-related event shows up. Until the hook is in place,
// receive.ts drops "file added" events in encrypted chats so nothing goes out in plaintext.
import { findFns, instead, noteFound, selectedChannelId, uploadCandidates } from "../patch.ts";
import { notify } from "../notify.ts";
import { storage } from "@vendetta/plugin";
import { isEncryptionOn } from "../state.ts";
import { encryptOutgoing } from "../outgoing.ts";
import { diag } from "../diag.ts";

const NAMES = ["uploadLocalFiles", "uploadFiles", "instantBatchUpload"];

let undo: Array<() => void> = [];
let hooked: string[] = [];
let timer: any = null;
let tries = 0;
let active = false;

export function uploadHooked(): boolean {
  return hooked.length > 0;
}

function wrap(name: string) {
  return (args: any[], orig: (...a: any[]) => any) => {
    const opts = args[0];
    const channelId: string = String(opts?.channelId ?? opts?.channel?.id ?? selectedChannelId() ?? "");
    if (storage.debug) console.log("[aegires-e2ee] " + name, channelId, Object.keys(opts ?? {}));
    if (!channelId || !isEncryptionOn(channelId)) return orig(...args);

    if (!storage.attachments) {
      notify("Encrypted attachments are turned off in the plugin settings - upload cancelled so nothing is sent unencrypted.");
      return Promise.resolve();
    }
    const uploads: any[] = Array.isArray(opts?.uploads) ? opts.uploads : Array.isArray(opts?.files) ? opts.files : [];
    if (!uploads.length) {
      notify("Unknown upload format - upload cancelled so nothing is sent unencrypted");
      console.log("[aegires-e2ee] " + name + " args", Object.keys(opts ?? {}));
      return Promise.resolve();
    }
    return encryptOutgoing(channelId, uploads, [opts?.parsedMessage, opts?.message]).then((ok) => (ok ? orig(...args) : undefined));
  };
}

/** Hooks every upload function not hooked yet. Safe to call repeatedly. */
export function retryUploadPatch(): void {
  if (!active) return;
  for (const n of NAMES) {
    if (hooked.includes(n)) continue;
    let mod: any;
    try { mod = findFns(n); } catch {}
    if (!mod) continue;
    try {
      undo.push(instead(n, mod, wrap(n)));
      hooked.push(n);
    } catch (e) {
      console.log("[aegires-e2ee] could not hook " + n, e);
    }
  }
  noteFound("upload module", uploadHooked());
  diag.installed["upload hooks"] = hooked.length ? hooked.join(",") : `none yet (try ${tries})`;
  if (!uploadHooked()) {
    try { diag.installed["upload candidates"] = uploadCandidates(); } catch {}
  }
}

export function installUploadPatch(): () => void {
  active = true;
  retryUploadPatch();
  // Keep looking for the modules that appear later (each check is a cheap property scan).
  timer = setInterval(() => {
    tries++;
    retryUploadPatch();
    if (hooked.length === NAMES.length || tries > 120) { clearInterval(timer); timer = null; }
  }, 5000);
  return () => {
    active = false;
    if (timer) clearInterval(timer);
    timer = null;
    undo.slice().reverse().forEach((u) => { try { u(); } catch {} });
    undo = [];
    hooked = [];
    tries = 0;
  };
}
