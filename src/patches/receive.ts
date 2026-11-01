// INCOMING: turn "§<base64>" back into readable text (and encrypted attachments back into
// viewable files) before Discord's message store and UI see it.
//
// Every message that reaches the app (new message, edit, history load, search, pins) is
// announced on Discord's internal event bus, FluxDispatcher, as an event such as
//   { type: "MESSAGE_CREATE", message: {...} }  or  { type: "LOAD_MESSAGES_SUCCESS", messages: [...] }
// We run `before` dispatch and rewrite the message objects IN PLACE. No UI component is
// patched (Discord's chat list is rendered natively), so this is the sturdiest hook point.
// Nothing is written back to Discord: the server only ever sees ciphertext.
import { before, findFlux, noteFound } from "../patch.ts";
import { storage } from "@vendetta/plugin";
import { decryptText, looksEncrypted } from "../crypto/wire.ts";
import { splitSizeTag } from "../crypto/files.ts";
import { LOCK, getReceiveKeys } from "../state.ts";
import { diag } from "../diag.ts";
import { clearMedia, handleAttachments, setDispatcher } from "./media.ts";

/** Ids of messages we decrypted, so edits of them stay encrypted (see send.ts). */
const encryptedIds = new Set<string>();

export function wasEncrypted(messageId: string): boolean {
  return encryptedIds.has(messageId);
}

function remember(id: unknown): void {
  if (typeof id !== "string" && typeof id !== "number") return;
  encryptedIds.add(String(id));
  if (encryptedIds.size > 5000) encryptedIds.delete(encryptedIds.values().next().value as string);
}

function tryDecrypt(content: string, channelId: string | undefined): string | null {
  for (const key of getReceiveKeys(channelId)) {
    const plain = decryptText(content, key);
    if (plain !== null) return plain;
  }
  return null;
}

function decryptMessage(m: any, fallbackChannelId?: string): void {
  if (!m || typeof m !== "object") return;
  const channelId: string | undefined = m.channel_id ?? m.channelId ?? fallbackChannelId;
  let size: { w: number; h: number } | null = null;

  if (looksEncrypted(m.content)) {
    diag.encSeen++;
    const hasKeys = getReceiveKeys(channelId).length > 0;
    const plain = hasKeys ? tryDecrypt(m.content, channelId) : null;
    if (plain !== null) {
      diag.decrypted++;
      remember(m.id);
      // Aegires puts "[sz:W,H]" in front of image captions; hide it from the visible text.
      const sp = splitSizeTag(plain);
      if (sp.width && sp.height) size = { w: sp.width, h: sp.height };
      m.content = sp.text || sp.width === null ? (storage.showLock ? LOCK : "") + sp.text : "";
    } else if (hasKeys) {
      diag.wrongKey++;
    } else {
      diag.noKey++;
    }
  }
  if (Array.isArray(m.attachments) && m.attachments.length) handleAttachments(m, channelId, size);
  // Reply previews ("replying to ...") carry their own copy of the original message.
  if (m.referenced_message) decryptMessage(m.referenced_message, channelId);
  // Forwarded messages carry snapshots of the original.
  if (Array.isArray(m.message_snapshots)) {
    for (const s of m.message_snapshots) decryptMessage(s?.message, channelId);
  }
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
  const flux = findFlux();
  noteFound("FluxDispatcher", flux);
  if (!flux || typeof flux.dispatch !== "function") throw new Error("FluxDispatcher.dispatch not found");
  setDispatcher((e) => flux.dispatch(e));
  const unpatch = before("dispatch", flux, (args) => {
    try {
      handleEvent(args[0]);
    } catch (e) {
      // Never let a bug here break Discord's own event handling.
      console.log("[aegires-e2ee] receive error", e);
    }
  });
  return () => {
    unpatch();
    setDispatcher(null);
    clearMedia();
    encryptedIds.clear();
  };
}
