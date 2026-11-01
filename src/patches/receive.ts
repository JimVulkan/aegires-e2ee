// INCOMING: turn "§<base64>" back into readable text before Discord's UI sees it.
//
// How it works: every message that reaches the app (new message, edit, history load) is
// announced on Discord's internal event bus, FluxDispatcher, as an event object such as
//   { type: "MESSAGE_CREATE", message: {...} }  or  { type: "LOAD_MESSAGES_SUCCESS", messages: [...] }
// We run `before` dispatch: if a message's content is ciphertext and we hold a key that opens
// it, we overwrite content with the plaintext IN PLACE. The message store and UI then simply
// show the plaintext - no UI component needs to be patched, which makes this the sturdiest
// part of the plugin. Nothing is written back to Discord: the server only ever sees ciphertext.
//
// If we cannot decrypt (no key / wrong key) we leave the message untouched. Messages that
// were already loaded stay as they were; after you change keys, switch channel or restart
// Discord so history is fetched again.
import { before, findFlux, noteFound } from "../patch.ts";
import { storage } from "@vendetta/plugin";
import { decryptText, looksEncrypted } from "../crypto/wire.ts";
import { splitSizeTag } from "../crypto/files.ts";
import { getReceiveKeys } from "../state.ts";
import { LOCK } from "./send.ts";
import { diag } from "../diag.ts";
import { recordSizeHint } from "./attachments.ts";

// Event types known to carry messages. If a view in the app still shows ciphertext, turn on
// "Debug logging" in settings: it logs the type names of events that contain a "§" message
// which is not in this list, and you just add the name here.
const MESSAGE_EVENTS = new Set([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "LOAD_MESSAGES_SUCCESS",
  "LOAD_MESSAGES_SUCCESS_CACHED",
  "LOAD_PINNED_MESSAGES_SUCCESS",
  "LOAD_RECENT_MENTIONS_SUCCESS",
  "SEARCH_FINISH",
]);

function tryDecrypt(content: string, channelId: string | undefined): string | null {
  for (const key of getReceiveKeys(channelId)) {
    const plain = decryptText(content, key);
    if (plain !== null) return plain;
  }
  return null;
}

function decryptMessage(m: any, fallbackChannelId?: string): boolean {
  if (!m || typeof m !== "object") return false;
  const channelId: string | undefined = m.channel_id ?? m.channelId ?? fallbackChannelId;
  let changed = false;

  if (looksEncrypted(m.content)) {
    diag.encSeen++;
    const hasKeys = getReceiveKeys(channelId).length > 0;
    if (!hasKeys) diag.noKey++;
    const plain = tryDecrypt(m.content, channelId);
    if (plain !== null) {
      diag.decrypted++;
      // Aegires puts "[sz:W,H]" in front of image captions; hide it from the visible text.
      const sp = splitSizeTag(plain);
      recordSizeHint(m.id, sp.width, sp.height);
      const text = sp.text;
      m.content = (storage.showLock ? LOCK : "") + text;
      changed = true;
    } else if (hasKeys) {
      diag.wrongKey++;
    }
  }
  // Reply previews ("replying to ...") carry their own copy of the original message.
  if (m.referenced_message && decryptMessage(m.referenced_message, channelId)) changed = true;
  return changed;
}

function handleEvent(event: any): void {
  diag.events++;
  if (!event || typeof event !== "object") return;
  if (!event.message && !event.messages) return;
  // Any event that carries message(s) is processed, whatever its name, so a renamed event
  // type in a new Discord version cannot silently disable decryption.
  diag.msgEvents++;
  const type = String(event.type);
  if (Object.keys(diag.types).length < 12 || diag.types[type]) diag.types[type] = (diag.types[type] ?? 0) + 1;

  if (event.message) decryptMessage(event.message, event.channelId);
  if (Array.isArray(event.messages)) {
    for (const m of event.messages) {
      if (Array.isArray(m)) m.forEach((x) => decryptMessage(x, event.channelId)); // SEARCH_FINISH groups
      else decryptMessage(m, event.channelId);
    }
  }
}

export function installReceivePatch(): () => void {
  const FluxDispatcher = findFlux();
  noteFound("FluxDispatcher", FluxDispatcher);
  if (!FluxDispatcher || typeof FluxDispatcher.dispatch !== "function") throw new Error("FluxDispatcher.dispatch not found");
  return before("dispatch", FluxDispatcher, (args) => {
    try {
      handleEvent(args[0]);
    } catch (e) {
      // Never let a bug here break Discord's own event handling.
      console.log("[aegires-e2ee] receive error", e);
    }
  });
}
