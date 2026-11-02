// INCOMING: turn "§<base64>" back into readable text (and encrypted attachments back into
// viewable files) before Discord's message store and UI see it.
//
// Every message that reaches the app (new message, edit, history load, search, pins) is
// announced on Discord's internal event bus, FluxDispatcher, as an event such as
//   { type: "MESSAGE_CREATE", message: {...} }  or  { type: "LOAD_MESSAGES_SUCCESS", messages: [...] }
// We run `before` dispatch and rewrite the message objects IN PLACE. No UI component is
// patched (Discord's chat list is rendered natively), so this is the sturdiest hook point.
// Nothing is written back to Discord: the server only ever sees ciphertext.
import { before, findFlux, noteFound, selectedChannelId } from "../patch.ts";
import { storage } from "@vendetta/plugin";
import { decryptText, looksEncrypted } from "../crypto/wire.ts";
import { splitSizeTag } from "../crypto/files.ts";
import { decryptMessage as decryptV2, messagePreset } from "../crypto/v2.ts";
import { LOCK, getReceiveKeys, getReceiveKeysV2, isEncryptionOn } from "../state.ts";
import { noteSelfId } from "../self.ts";
import { notify } from "../notify.ts";
import { retryUploadPatch, uploadHooked } from "./upload.ts";
import { encryptAttachments } from "../outgoing.ts";
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

// v2 binds each ciphertext to (channel id, AUTHOR id). Partial MESSAGE_UPDATE events can omit
// the author, so remember who wrote what from earlier events.
const authorById = new Map<string, string>();

function authorOf(m: any): string | undefined {
  const id = m.author?.id;
  if (id && m.id) {
    authorById.set(String(m.id), String(id));
    if (authorById.size > 5000) authorById.delete(authorById.keys().next().value as string);
  }
  return id ? String(id) : m.id ? authorById.get(String(m.id)) : undefined;
}

type Outcome = { plain: string } | "nokey" | "noauthor" | "wrong";

/** Tries v2 (when the header says so and the author is known), then v1. */
function tryDecrypt(content: string, channelId: string | undefined, authorId: string | undefined): Outcome {
  const v2keys = getReceiveKeysV2(channelId);
  const v1keys = getReceiveKeys(channelId);
  if (!v2keys.length && !v1keys.length) return "nokey";
  const isV2 = !!messagePreset(content);
  if (isV2 && channelId && authorId) {
    for (const key of v2keys) {
      const plain = decryptV2(content, key, channelId, authorId);
      if (plain !== null) return { plain };
    }
  }
  // A v1 ciphertext starts with a random IV, so it can look like a v2 header by chance.
  for (const key of v1keys) {
    const plain = decryptText(content, key);
    if (plain !== null) return { plain };
  }
  return isV2 && v2keys.length && (!channelId || !authorId) ? "noauthor" : "wrong";
}

function decryptMessage(m: any, fallbackChannelId?: string): void {
  if (!m || typeof m !== "object") return;
  const channelId: string | undefined = m.channel_id ?? m.channelId ?? fallbackChannelId;
  const authorId = authorOf(m);
  let size: { w: number; h: number } | null = null;

  if (looksEncrypted(m.content)) {
    diag.encSeen++;
    const r = tryDecrypt(m.content, channelId, authorId);
    if (typeof r === "object") {
      const plain = r.plain;
      diag.decrypted++;
      remember(m.id);
      // Aegires puts "[sz:W,H]" in front of image captions; hide it from the visible text.
      const sp = splitSizeTag(plain);
      if (sp.width && sp.height) size = { w: sp.width, h: sp.height };
      m.content = sp.text || sp.width === null ? (storage.showLock ? LOCK : "") + sp.text : "";
    } else if (r === "nokey") {
      diag.noKey++;
    } else if (r === "noauthor") {
      diag.noAuthor++;
    } else {
      diag.wrongKey++;
    }
  }
  if (Array.isArray(m.attachments) && m.attachments.length) handleAttachments(m, channelId, size, authorId);
  // Reply previews ("replying to ...") carry their own copy of the original message.
  if (m.referenced_message) decryptMessage(m.referenced_message, channelId);
  // Forwarded messages carry snapshots of the original.
  if (Array.isArray(m.message_snapshots)) {
    for (const s of m.message_snapshots) decryptMessage(s?.message, channelId);
  }
}

let redispatch: ((e: any) => void) | null = null;
const MARK = "__aegiresEncrypted";

/**
 * Files being attached in an encrypted chat are encrypted right away, before any upload code
 * sees them: the event is held back, every file is replaced by its encrypted copy
 * ("x.enc.ext", Aegires format) and the event is dispatched again. So whatever upload path
 * this Discord version uses, only ciphertext can leave the phone. Returns true to drop the
 * original event.
 */
function interceptAttach(event: any, type: string): boolean {
  if (!/UPLOAD|ATTACH/.test(type)) return false;
  if (!diag.uploadEvents.includes(type) && diag.uploadEvents.length < 10) diag.uploadEvents.push(type);
  retryUploadPatch();
  if (!/ADD/.test(type) || event[MARK]) return false;
  const channelId = String(event.channelId ?? event.channel_id ?? selectedChannelId() ?? "");
  if (!channelId || !isEncryptionOn(channelId)) return false;

  const files = [event.files, event.uploads, event.items, event.attachments].find((x) => Array.isArray(x) && x.length);
  if (!files) {
    if (uploadHooked()) return false; // the upload hook will encrypt them at send time
    notify("Unknown attachment format, so it cannot be encrypted - file not attached. Turn encryption off for this chat to send it unencrypted, and report the Diagnostics output.");
    return true;
  }
  if (!storage.attachments) {
    notify("Encrypted attachments are turned off in the plugin settings - file not attached so nothing is sent unencrypted.");
    return true;
  }
  encryptAttachments(channelId, files).then((ok) => {
    if (ok && redispatch) redispatch({ ...event, [MARK]: true });
  });
  return true;
}

function handleEvent(event: any): boolean {
  diag.events++;
  if (!event || typeof event !== "object") return false;
  // Learn our own user id (v2 binds what we send to it) from login / profile events.
  if (event.type === "CONNECTION_OPEN" || event.type === "CURRENT_USER_UPDATE") noteSelfId(event.user?.id);
  if (interceptAttach(event, String(event.type))) return true;
  if (!event.message && !event.messages) return false;
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
  return false;
}

export function installReceivePatch(): () => void {
  const flux = findFlux();
  noteFound("FluxDispatcher", flux);
  if (!flux || typeof flux.dispatch !== "function") throw new Error("FluxDispatcher.dispatch not found");
  redispatch = (e) => flux.dispatch(e);
  setDispatcher(redispatch);
  const unpatch = before("dispatch", flux, (args) => {
    try {
      if (handleEvent(args[0])) return [{ type: "AEGIRES_E2EE_HELD_UPLOAD" }];
    } catch (e) {
      // Never let a bug here break Discord's own event handling.
      console.log("[aegires-e2ee] receive error", e);
    }
  });
  return () => {
    unpatch();
    setDispatcher(null);
    redispatch = null;
    clearMedia();
    encryptedIds.clear();
    authorById.clear();
  };
}
