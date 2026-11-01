// Plugin entry point. The loader calls onLoad() when the plugin is enabled and onUnload()
// when it is disabled; our job is to undo EVERYTHING we did in onLoad.
import { quiet } from "./notify.ts";
import { initStorage } from "./state.ts";
import { installSendPatch } from "./patches/send.ts";
import { installReceivePatch } from "./patches/receive.ts";
import { installUploadPatch } from "./patches/upload.ts";
import { installCommands } from "./commands.ts";
import { hasSecureRandom } from "./crypto/random.ts";
import Settings from "./ui/Settings.tsx";
import { diag } from "./diag.ts";
import { envSummary } from "./patch.ts";

let undo: Array<() => void> = [];

// Each installer is isolated: if one fails (Discord changed something, or Discord has not
// finished loading its modules yet), the others still work. Failed installers are retried
// a few times; the reason is shown in the settings Diagnostics card.
let timers: any[] = [];
function safely(name: string, install: () => () => void, retry = 3): void {
  try {
    undo.push(install());
    diag.installed[name] = "ok";
  } catch (e) {
    const msg = String((e as any)?.message ?? e).slice(0, 80);
    diag.installed[name] = "FAILED: " + msg + (retry > 0 ? " (retrying)" : "");
    console.log(`[aegires-e2ee] ${name} failed to install`, e);
    if (retry > 0) timers.push(setTimeout(() => safely(name, install, retry - 1), 4000));
    else quiet(`${name} failed: ${msg}`);
  }
}

// Remove everything this instance installed.
function unloadAll(): void {
  timers.forEach((t) => clearTimeout(t));
  timers = [];
  undo.slice().reverse().forEach((u) => {
    try { u(); } catch (e) { console.log("[aegires-e2ee] unpatch error", e); }
  });
  undo = [];
}

// If an older copy of this plugin is still active (Kettu updated the plugin without calling
// its onUnload, or it was loaded twice), it leaves behind a second /e2ee command and double
// patches. Every instance registers its unloader here so the next one can clean up first.
const SLOT = "__aegiresE2EEUnload";

export default {
  onLoad() {
    const g: any = globalThis as any;
    try { g[SLOT]?.(); } catch (e) { console.log("[aegires-e2ee] cleanup of previous instance failed", e); }
    g[SLOT] = unloadAll;

    initStorage();
    try { diag.installed["env"] = envSummary(); } catch {}
    if (!hasSecureRandom()) {
      quiet("no secure random source - encrypting is impossible. Run the self-test in settings.");
    }
    safely("send patch", installSendPatch);
    safely("receive patch", installReceivePatch);
    safely("upload patch", installUploadPatch);
    safely("commands", installCommands);
  },
  onUnload() {
    unloadAll();
    const g: any = globalThis as any;
    if (g[SLOT] === unloadAll) delete g[SLOT];
  },
  settings: Settings,
};
