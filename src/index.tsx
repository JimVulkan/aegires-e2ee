// Plugin entry point. The loader calls onLoad() when the plugin is enabled and onUnload()
// when it is disabled; our job is to undo EVERYTHING we did in onLoad.
import { showToast } from "@vendetta/ui/toasts";
import { initStorage } from "./state.ts";
import { installSendPatch } from "./patches/send.ts";
import { installReceivePatch } from "./patches/receive.ts";
import { installAttachmentPatches } from "./patches/attachments.ts";
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
    else showToast(`Aegires E2EE: ${name} failed: ${msg.slice(0, 60)}`);
  }
}

export default {
  onLoad() {
    initStorage();
    try { diag.installed["env"] = envSummary(); } catch {}
    if (!hasSecureRandom()) {
      showToast("Aegires E2EE: no secure random source - encrypting is impossible. Run the self-test in settings.");
    }
    safely("send patch", installSendPatch);
    safely("receive patch", installReceivePatch);
    safely("attachment patches", installAttachmentPatches);
    safely("commands", installCommands);
  },
  onUnload() {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
    undo.slice().reverse().forEach((u) => {
      try { u(); } catch (e) { console.log("[aegires-e2ee] unpatch error", e); }
    });
    undo = [];
  },
  settings: Settings,
};
