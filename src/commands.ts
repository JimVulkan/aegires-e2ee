// Slash command: /e2ee <on|off|status|selftest>
//
// Deliberately has NO password option. If the command ever failed to register as a built-in
// command, Discord would send the text you typed as a normal chat message, and a password in
// it would be leaked to the channel. Passwords are only ever entered in the plugin settings.
//
// Commands are the least certain part of the plugin API across Kettu/Revenge versions, so
// registration is wrapped in try/catch: if it fails the plugin still works via Settings.
import { registerCommand } from "@vendetta/commands";
import { notify as showToast } from "./notify.ts";
import { getSendKey, isEncryptionOn, setChannelEnabled } from "./state.ts";
import { runSelfTest } from "./selftest.ts";

const choice = (v: string) => ({ name: v, displayName: v, value: v });

export function installCommands(): () => void {
  try {
    return registerCommand({
      name: "e2ee",
      displayName: "e2ee",
      description: "Aegires E2EE: turn encryption on/off for this chat, or show status",
      displayDescription: "Aegires E2EE: turn encryption on/off for this chat, or show status",
      applicationId: "-1",
      type: 1, // CHAT
      inputType: 1, // BUILT_IN_TEXT
      options: [
        {
          name: "action",
          displayName: "action",
          description: "on, off, status or selftest",
          displayDescription: "on, off, status or selftest",
          type: 3, // STRING
          required: true,
          choices: ["on", "off", "status", "selftest"].map(choice),
        },
      ],
      execute: async (args: any[], ctx: any) => {
        const action = args?.find((a) => a.name === "action")?.value;
        const channelId: string | undefined = ctx?.channel?.id;
        if (!channelId) return showToast("E2EE: no channel in context");

        if (action === "on") {
          if (!getSendKey(channelId)) return showToast("Set a key in the plugin settings first");
          setChannelEnabled(channelId, true);
          return showToast("E2EE ON for this chat");
        }
        if (action === "off") {
          setChannelEnabled(channelId, false);
          return showToast("E2EE OFF for this chat");
        }
        if (action === "status") {
          return showToast(`E2EE ${isEncryptionOn(channelId) ? "ON" : "OFF"} - key ${getSendKey(channelId) ? "set" : "missing"}`);
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
