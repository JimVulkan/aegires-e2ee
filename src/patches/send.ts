// OUTGOING: encrypt the text of a message right before Discord sends it.
//
// Discord's mobile app funnels every chat message through
// MessageActions.sendMessage(channelId, message, waitForChannelReady?, options?) (and
// editMessage for edits). We wrap both: rewrite message.content into "§<base64>" and call the
// real function, or refuse to call it at all. Newer Discord versions also pass attachments to
// sendMessage (options.attachmentsToUpload); those are encrypted here too.
import { findFns, instead, noteFound } from "../patch.ts";
import { notify } from "../notify.ts";
import { storage } from "@vendetta/plugin";
import { diag } from "../diag.ts";
import { LOCK, getSendKey, isEncryptionOn } from "../state.ts";
import { BLOCK, encryptOutgoing, prepare } from "../outgoing.ts";
import { wasEncrypted } from "./receive.ts";

/** Attachments riding along with sendMessage, if any. */
function attachmentsOf(message: any, options: any): any[] {
  for (const list of [options?.attachmentsToUpload, options?.uploads, message?.attachmentsToUpload]) {
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

export function installSendPatch(): () => void {
  const MessageActions = findFns("sendMessage", "receiveMessage");
  noteFound("sendMessage module", MessageActions);
  if (!MessageActions) throw new Error("sendMessage module not found - sending is NOT encrypted");
  const undo: Array<() => void> = [];

  undo.push(
    instead("sendMessage", MessageActions, (args, orig) => {
      const [channelId, message, , options] = args;
      diag.sendCalls++;
      if (!message || typeof channelId !== "string") {
        diag.lastSend = "hook hit but unexpected args";
        return orig(...args);
      }
      const files = attachmentsOf(message, options);
      if (files.length && isEncryptionOn(channelId)) {
        diag.lastSend = `with ${files.length} attachment(s) -> encrypting`;
        if (!storage.attachments) {
          notify("Encrypted attachments are turned off in the plugin settings - message not sent so nothing goes out unencrypted.");
          return Promise.resolve();
        }
        return encryptOutgoing(channelId, files, [message]).then((ok) => (ok ? orig(...args) : undefined));
      }
      const out = prepare(channelId, message.content);
      diag.lastSend = `on=${isEncryptionOn(channelId)} key=${!!getSendKey(channelId)} -> ${out === BLOCK ? "BLOCKED" : out === null ? "sent unchanged" : "encrypted"}`;
      if (storage.debug) console.log("[aegires-e2ee] sendMessage", channelId, diag.lastSend, options ? Object.keys(options) : "");
      if (out === BLOCK) return Promise.resolve();
      if (out !== null) message.content = out;
      return orig(...args);
    }),
  );

  if (typeof MessageActions.editMessage === "function") {
    undo.push(
      instead("editMessage", MessageActions, (args, orig) => {
        // args = [channelId, messageId, message]
        const [channelId, messageId, message] = args;
        if (message && typeof channelId === "string" && typeof message.content === "string") {
          // The edit box is pre-filled with the DECRYPTED text, which may start with our lock
          // marker. Remove it so we do not encrypt the marker itself.
          if (message.content.startsWith(LOCK)) message.content = message.content.slice(LOCK.length);
          // An edit of an encrypted message stays encrypted, even if the chat was switched off
          // since: otherwise the edit would publish the secret text in plaintext.
          const out = prepare(channelId, message.content, wasEncrypted(String(messageId)));
          if (out === BLOCK) return Promise.resolve();
          if (out !== null) message.content = out;
        }
        return orig(...args);
      }),
    );
  }

  return () => undo.slice().reverse().forEach((u) => u());
}
