// Slash command: /e2ee <on|off|status|selftest|aes-128|aes-192|aes-256|v1>
//
// Deliberately has NO password option. If the command ever failed to register as a built-in
// command, Discord would send the text you typed as a normal chat message, and a password in
// it would be leaked to the channel. Passwords are only ever entered in the plugin settings.
//
// Commands are the least certain part of the plugin API across Kettu/Revenge versions, so
// registration is wrapped in try/catch: if it fails the plugin still works via Settings.
import { registerCommand } from "@vendetta/commands";
import { notify as showToast } from "./notify.ts";
import { storage } from "@vendetta/plugin";
import { PRESETS, canSend, getSendFormat, getSendPreset, isEncryptionOn, isForced, setChannelEnabled, setPreset } from "./state.ts";
import { getSelfId } from "./self.ts";
import { runSelfTest } from "./selftest.ts";

const choice = (v: string) => ({ name: v, displayName: v, value: v });

export function installCommands(): () => void {
  try {
    return registerCommand({
      name: "e2ee",
      displayName: "e2ee",
      description: "Aegires E2EE: encryption on/off for this chat, status, or the format / AES strength",
      displayDescription: "Aegires E2EE: encryption on/off for this chat, status, or the format / AES strength",
      applicationId: "-1",
      type: 1, // CHAT
      inputType: 1, // BUILT_IN_TEXT
      options: [
        {
          name: "action",
          displayName: "action",
          description: "on, off, status, selftest, aes-128 / aes-192 / aes-256 (v2), or v1 (legacy)",
          displayDescription: "on, off, status, selftest, aes-128 / aes-192 / aes-256 (v2), or v1 (legacy)",
          type: 3, // STRING
          required: true,
          choices: ["on", "off", "status", "selftest", "aes-128", "aes-192", "aes-256", "v1"].map(choice),
        },
      ],
      execute: async (args: any[], ctx: any) => {
        const action = args?.find((a) => a.name === "action")?.value;
        const channelId: string | undefined = ctx?.channel?.id;
        if (!channelId) return showToast("E2EE: no channel in context");

        if (action === "aes-128" || action === "aes-192" || action === "aes-256") {
          const p = PRESETS.find((x) => x.label.toLowerCase().startsWith(action))!;
          storage.format = "v2";
          setPreset(p.index);
          return showToast(`Sending with v2 ${p.label}` + (isForced(channelId) ? " (this built-in channel always uses AES-128-GCM)" : ""));
        }
        if (action === "v1") {
          storage.format = "v1";
          return showToast("Sending with the legacy v1 format" + (isForced(channelId) ? " (this built-in channel always uses v2)" : ""));
        }
        if (action === "on") {
          if (isForced(channelId)) return showToast("Built-in channel: encryption is always on");
          if (!canSend(channelId)) return showToast("Set a key in the plugin settings first");
          setChannelEnabled(channelId, true);
          return showToast("E2EE ON for this chat");
        }
        if (action === "off") {
          if (isForced(channelId)) return showToast("Built-in channel: encryption cannot be turned off");
          setChannelEnabled(channelId, false);
          return showToast("E2EE OFF for this chat");
        }
        if (action === "status") {
          return showToast(`E2EE ${isEncryptionOn(channelId) ? "ON" : "OFF"}${isForced(channelId) ? " (built-in channel)" : ""} - key ${canSend(channelId) ? "set" : "missing"} - ${getSendFormat(channelId) === "v2" ? "v2 " + getSendPreset(channelId).label : "v1"} - own id ${getSelfId() ? "known" : "UNKNOWN"} - attachments ${storage.attachments ? "on" : "off"}`);
        }
        if (action === "selftest") {
          showToast("Running self-test...");
          const r = await runSelfTest();
          return showToast(r.ok ? "Self-test passed" : "Self-test FAILED - open plugin settings for details");
        }
      },
    });
  } catch (e) {
    console.log("[aegires-e2ee] could not register /e2ee (use the settings page instead)", e);
    return () => {};
  }
}
