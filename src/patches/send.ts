// OUTGOING: encrypt the text of a message right before Discord sends it.
//
// How it works: Discord's mobile app funnels every chat message through
// MessageActions.sendMessage(channelId, message, ...) (and editMessage for edits). We wrap
// those two functions with the patcher's `instead`, which lets us (a) rewrite message.content
// into "§<base64>" and then call the real function, or (b) refuse to call it at all.
//
// Rule #1 is FAIL CLOSED: if encryption is switched on for a channel and anything goes wrong
// (no key, text too long, no secure RNG), we do NOT send. Silently sending plaintext to a
// channel where the user believes encryption is on would be the worst possible bug.
import { findFns, instead, noteFound } from "../patch.ts";
import { showToast } from "@vendetta/ui/toasts";
import { storage } from "@vendetta/plugin";
import { diag } from "../diag.ts";
import { MAX_PLAINTEXT_LEN, encryptText, looksEncrypted } from "../crypto/wire.ts";
import { getSendKey, isEncryptionOn } from "../state.ts";

export const LOCK = "🔒 "; // "🔒 " shown in front of decrypted messages (if enabled)

const BLOCK = Symbol("block");

/** Returns the new content, null to leave the message alone, or BLOCK to cancel the send. */
function prepare(channelId: string, content: unknown): string | null | typeof BLOCK {
  if (typeof content !== "string" || content.length === 0) return null;
  if (looksEncrypted(content)) return null; // already encrypted (e.g. our own re-send)
  if (!isEncryptionOn(channelId)) return null;

  const key = getSendKey(channelId);
  if (!key) {
    showToast("E2EE is on for this chat but no key is set - message not sent");
    return BLOCK;
  }
  if (content.length > MAX_PLAINTEXT_LEN) {
    showToast(`Too long to encrypt (${content.length}/${MAX_PLAINTEXT_LEN}) - message not sent`);
    return BLOCK;
  }
  try {
    return encryptText(content, key);
  } catch (e) {
    showToast("Encryption failed - message not sent");
    console.log("[aegires-e2ee] encrypt error", e);
    return BLOCK;
  }
}

export function installSendPatch(): () => void {
  const MessageActions = findFns("sendMessage", "receiveMessage");
  noteFound("sendMessage module", MessageActions);
  if (!MessageActions) {
    diag.installed["sendMessage lookup"] = "NOT FOUND";
    showToast("Aegires E2EE: could not find Discord's sendMessage - sending is NOT encrypted");
    return () => {};
  }
  const undo: Array<() => void> = [];

  undo.push(
    instead("sendMessage", MessageActions, (args, orig) => {
      // args = [channelId, message, waitForChannelReady?, extra?]
      const [channelId, message] = args;
      diag.sendCalls++;
      if (!message || typeof channelId !== "string") diag.lastSend = "hook hit but unexpected args";
      if (storage.debug) {
        console.log("[aegires-e2ee] sendMessage hook hit", {
          channelId,
          hasMessage: !!message,
          contentType: typeof message?.content,
          encryptionOn: typeof channelId === "string" ? isEncryptionOn(channelId) : null,
          hasKey: typeof channelId === "string" ? !!getSendKey(channelId) : null,
        });
        if (typeof channelId === "string") showToast(`E2EE hook: on=${isEncryptionOn(channelId)} key=${!!getSendKey(channelId)}`);
      }
      if (message && typeof channelId === "string") {
        const out = prepare(channelId, message.content);
        diag.lastSend = `on=${isEncryptionOn(channelId)} key=${!!getSendKey(channelId)} text=${typeof message.content === "string" && message.content.length > 0} -> ${out === BLOCK ? "BLOCKED" : out === null ? "sent unchanged" : "encrypted"}`;
        if (out === BLOCK) return Promise.resolve();
        if (out !== null) message.content = out;
      }
      return orig(...args);
    }),
  );

  if (typeof MessageActions.editMessage === "function") {
    undo.push(
      instead("editMessage", MessageActions, (args, orig) => {
        // args = [channelId, messageId, message]
        const [channelId, , message] = args;
        if (message && typeof channelId === "string" && typeof message.content === "string") {
          // The edit box is pre-filled with the DECRYPTED text, which may start with our lock
          // marker. Remove it so we do not encrypt the marker itself.
          if (message.content.startsWith(LOCK)) message.content = message.content.slice(LOCK.length);
          const out = prepare(channelId, message.content);
          if (out === BLOCK) return Promise.resolve();
          if (out !== null) message.content = out;
        }
        return orig(...args);
      }),
    );
  }

  return () => undo.forEach((u) => u());
}
