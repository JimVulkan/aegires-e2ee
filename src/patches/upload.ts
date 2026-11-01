// OUTGOING attachments. Depending on the Discord version, files are sent by one of several
// upload functions ({ channelId, uploads | files, parsedMessage, ... }) instead of sendMessage.
// We wrap every one we can find; when encryption is on for the channel the files and the
// caption are encrypted first (see outgoing.ts), and nothing is sent if that fails.
//
// Discord initialises modules lazily, so the upload module usually does not exist yet when the
// plugin loads. We retry in the background and whenever an upload-related event shows up
// (receive.ts). Wrapping Metro's module factories to catch it earlier broke Discord's startup,
// so don't do that. Files themselves are already encrypted when attached
// (receive.ts), so this hook mainly takes care of the caption and its "[sz:W,H]" tag.
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

function hook(mod: any, n: string): void {
  if (!mod || typeof mod[n] !== "function" || hooked.includes(n)) return;
  try {
    undo.push(instead(n, mod, wrap(n)));
    hooked.push(n);
  } catch (e) {
    console.log("[aegires-e2ee] could not hook " + n, e);
  }
}

function report(): void {
  noteFound("upload module", uploadHooked());
  diag.installed["upload hooks"] = hooked.length ? hooked.join(",") : `none yet (try ${tries})`;
  if (!uploadHooked()) {
    try { diag.installed["upload candidates"] = uploadCandidates(); } catch {}
  }
}

/** Hooks every upload function not hooked yet. Safe to call repeatedly. */
export function retryUploadPatch(): void {
  if (!active) return;
  for (const n of NAMES) {
    if (hooked.includes(n)) continue;
    try { hook(findFns(n), n); } catch {}
  }
  report();
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
