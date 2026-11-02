// Plugin settings + key management.
//
// Two Aegires formats are supported side by side:
//   v1: PBKDF2-SHA1 key, AES-256-GCM. Old messages and older Aegires clients.
//   v2: Argon2id master key (64 MiB, slow), per-message HKDF keys bound to (channel, author),
//       AES-128/192/256-GCM presets. Default for sending.
// One password gives both keys. They are derived ONCE when you type the password and only the
// derived keys are stored (hex); the password itself is never saved. The derived keys are still
// secrets: anyone who can read this plugin's storage can read your chats.
import { storage } from "@vendetta/plugin";
import { deriveKey } from "./crypto/keys.ts";
import { deriveMasterKey } from "./crypto/kdf2.ts";
import { fromHex, toHex } from "./crypto/hex.ts";
import { AES128, AES256, PRESETS, presetFromIndex, type Preset } from "./crypto/v2.ts";
import { FORCED_CHANNELS } from "./forced.ts";
import { diag } from "./diag.ts";

export type Format = "v1" | "v2";

interface ChannelConfig {
  keyHex?: string; // v1 channel key; falls back to the global key
  keyV2?: string; // v2 channel key; falls back to the global key
  enabled?: boolean; // encrypt outgoing messages here? (falls back to encryptByDefault)
}

export function initStorage(): void {
  storage.globalKeyHex ??= "";
  storage.keyV2 ??= "";
  storage.format ??= "v2";
  storage.preset ??= AES256.index;
  storage.padme ??= true;
  storage.channels ??= {};
  storage.encryptByDefault ??= false;
  storage.showLock ??= true;
  storage.attachments ??= true;
  storage.debug ??= false;
}

/** Shown in front of decrypted messages (if enabled). */
export const LOCK = "🔒 ";

const keyCache = new Map<string, Uint8Array>();

function keyFromHex(hex: string | undefined): Uint8Array | null {
  if (!hex) return null;
  const hit = keyCache.get(hex);
  if (hit) return hit;
  const parsed = fromHex(hex);
  if (parsed && parsed.length === 32) {
    keyCache.set(hex, parsed);
    return parsed;
  }
  return null;
}

function cfg(channelId: string): ChannelConfig | undefined {
  return storage.channels?.[channelId];
}

// ------------------------------------------------------------------ forced (built-in) channels

/** Aegires channels with a built-in key (ForcedKeys.java): always encrypted, v2, AES-128. */
export function isForced(channelId: string | undefined): boolean {
  return !!channelId && Object.prototype.hasOwnProperty.call(FORCED_CHANNELS, channelId);
}

function forcedKey(channelId: string | undefined): Uint8Array | null {
  return channelId && isForced(channelId) ? keyFromHex(FORCED_CHANNELS[channelId].keyHex) : null;
}

// ------------------------------------------------------------------------------- keys

function collect(...ks: Array<Uint8Array | null>): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const k of ks) if (k && out.indexOf(k) < 0) out.push(k);
  return out;
}

/** v1 key we ENCRYPT with in this channel (channel key wins over global). */
export function getSendKey(channelId: string): Uint8Array | null {
  return keyFromHex(cfg(channelId)?.keyHex) ?? keyFromHex(storage.globalKeyHex);
}

/** v2 master key we ENCRYPT with: built-in (forced) > channel key > global key. */
export function getSendKeyV2(channelId: string): Uint8Array | null {
  return forcedKey(channelId) ?? keyFromHex(cfg(channelId)?.keyV2) ?? keyFromHex(storage.keyV2);
}

/** v1 keys worth trying when DECRYPTING in this channel, most specific first. */
export function getReceiveKeys(channelId: string | undefined): Uint8Array[] {
  return collect(channelId ? keyFromHex(cfg(channelId)?.keyHex) : null, keyFromHex(storage.globalKeyHex));
}

/** v2 master keys worth trying when DECRYPTING in this channel, most specific first. */
export function getReceiveKeysV2(channelId: string | undefined): Uint8Array[] {
  return collect(forcedKey(channelId), channelId ? keyFromHex(cfg(channelId)?.keyV2) : null, keyFromHex(storage.keyV2));
}

export function hasGlobalKey(): boolean {
  return !!keyFromHex(storage.globalKeyHex) || !!keyFromHex(storage.keyV2);
}

// ------------------------------------------------------------------------ format + preset

/** Format for OUTGOING messages/files here. Built-in channels are always v2. */
export function getSendFormat(channelId: string): Format {
  return isForced(channelId) || storage.format !== "v1" ? "v2" : "v1";
}

export function getPreset(): Preset {
  return presetFromIndex(Number(storage.preset)) ?? AES256;
}

/** v2 preset for OUTGOING messages. Built-in channels are always AES-128 (like Aegires). */
export function getSendPreset(channelId: string): Preset {
  return isForced(channelId) ? AES128 : getPreset();
}

export function setPreset(index: number): void {
  if (presetFromIndex(index)) storage.preset = index;
}

export { PRESETS };

/** True when the key needed for this channel's send format exists. */
export function canSend(channelId: string): boolean {
  return getSendFormat(channelId) === "v2" ? !!getSendKeyV2(channelId) : !!getSendKey(channelId);
}

// ------------------------------------------------------------------------ on / off

/** Should outgoing messages in this channel be encrypted? Built-in channels: always. */
export function isEncryptionOn(channelId: string): boolean {
  if (isForced(channelId)) return true;
  const c = cfg(channelId);
  if (c && typeof c.enabled === "boolean") return c.enabled;
  return !!storage.encryptByDefault;
}

export function setChannelEnabled(channelId: string, enabled: boolean): void {
  storage.channels[channelId] = { ...(storage.channels[channelId] ?? {}), enabled };
}

// ------------------------------------------------------------------------ password -> keys

/** Same limits as the Aegires app, so any password that works there works here. */
export function checkPassword(password: string): string | null {
  if (password.length < 8) return "Use at least 8 characters";
  if (password.length > 256) return "Password too long (max 256)";
  return null;
}

let deriving = false;

export function isDeriving(): boolean {
  return deriving;
}

/** Derives the v1 and v2 keys for a password. Argon2id is the slow part (progress 0..1). */
async function derive(password: string, onProgress?: (fraction: number) => void): Promise<{ v1: string; v2: string }> {
  const problem = checkPassword(password);
  if (problem) throw new Error(problem);
  if (deriving) throw new Error("A key is already being derived - wait for it to finish");
  deriving = true;
  const t0 = Date.now();
  try {
    const v1 = toHex(await deriveKey(password));
    const v2 = toHex(await deriveMasterKey(password, { onProgress }));
    diag.lastKdfMs = Date.now() - t0;
    return { v1, v2 };
  } finally {
    deriving = false;
  }
}

export async function setGlobalPassword(password: string, onProgress?: (fraction: number) => void): Promise<void> {
  const k = await derive(password, onProgress);
  storage.globalKeyHex = k.v1;
  storage.keyV2 = k.v2;
}

export function clearGlobalKey(): void {
  storage.globalKeyHex = "";
  storage.keyV2 = "";
}

export async function setChannelPassword(channelId: string, password: string, onProgress?: (fraction: number) => void): Promise<void> {
  const k = await derive(password, onProgress);
  storage.channels[channelId] = { ...(storage.channels[channelId] ?? {}), keyHex: k.v1, keyV2: k.v2 };
}

export function removeChannelConfig(channelId: string): void {
  delete storage.channels[channelId];
}

export function listChannelConfigs(): Array<{ id: string; hasKey: boolean; enabled: boolean | undefined }> {
  const out: Array<{ id: string; hasKey: boolean; enabled: boolean | undefined }> = [];
  for (const id of Object.keys(storage.channels ?? {})) {
    const c = storage.channels[id] as ChannelConfig;
    out.push({ id, hasKey: !!(c?.keyHex || c?.keyV2), enabled: c?.enabled });
  }
  return out;
}
