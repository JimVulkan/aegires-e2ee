// OUTGOING: encrypt the text of a message right before Discord sends it.
//
// Discord's mobile app funnels every chat message through
// MessageActions.sendMessage(channelId, message, ...) (and editMessage for edits). We wrap
// both: rewrite message.content into "§<base64>" and call the real function, or refuse to
// call it at all.
//
// Rule #1 is FAIL CLOSED: if encryption is switched on for a channel and anything goes wrong
// (no key, text too long, no secure RNG), we do NOT send. Silently sending plaintext to a
// channel where the user believes encryption is on would be the worst possible bug.
import { findFns, instead, noteFound } from "../patch.ts";
import { notify } from "../notify.ts";
import { storage } from "@vendetta/plugin";
import { diag } from "../diag.ts";
import { MAX_PLAINTEXT_LEN, encryptText, looksEncrypted } from "../crypto/wire.ts";
import { LOCK, getSendKey, isEncryptionOn } from "../state.ts";
import { wasEncrypted } from "./receive.ts";


export const BLOCK = Symbol("block");

/**
 * Returns the new content, null to leave the message alone, or BLOCK to cancel the send.
 * `force` encrypts even where encryption is off (used when editing an encrypted message).
 */
export function prepare(channelId: string, content: unknown, force = false): string | null | typeof BLOCK {
  if (typeof content !== "string" || content.length === 0) return null;
  if (looksEncrypted(content)) return null; // already encrypted (e.g. our own re-send)
  if (!force && !isEncryptionOn(channelId)) return null;

  const key = getSendKey(channelId);
  if (!key) {
    notify("E2EE is on for this chat but no key is set - message not sent");
    return BLOCK;
  }
  if (content.length > MAX_PLAINTEXT_LEN) {
    notify(`Too long to encrypt (${content.length}/${MAX_PLAINTEXT_LEN}) - message not sent`);
    return BLOCK;
  }
  try {
    return encryptText(content, key);
  } catch (e) {
    notify("Encryption failed - message not sent");
    console.log("[aegires-e2ee] encrypt error", e);
    return BLOCK;
  }
}

export function installSendPatch(): () => void {
  const MessageActions = findFns("sendMessage", "receiveMessage");
  noteFound("sendMessage module", MessageActions);
  if (!MessageActions) throw new Error("sendMessage module not found - sending is NOT encrypted");
  const undo: Array<() => void> = [];

  undo.push(
    instead("sendMessage", MessageActions, (args, orig) => {
      // args = [channelId, message, waitForChannelReady?, extra?]
      const [channelId, message] = args;
      diag.sendCalls++;
      if (!message || typeof channelId !== "string") {
        diag.lastSend = "hook hit but unexpected args";
        return orig(...args);
      }
      const out = prepare(channelId, message.content);
      diag.lastSend = `on=${isEncryptionOn(channelId)} key=${!!getSendKey(channelId)} -> ${out === BLOCK ? "BLOCKED" : out === null ? "sent unchanged" : "encrypted"}`;
      if (storage.debug) console.log("[aegires-e2ee] sendMessage", channelId, diag.lastSend);
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
