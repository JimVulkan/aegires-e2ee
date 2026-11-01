// Plugin settings + key management.
//
// Why keys are stored (not passwords): deriving a key takes a while (15000 PBKDF2 rounds),
// so we derive ONCE when you type the password, then keep only the derived 32-byte key as hex.
// Message sending/receiving then never has to wait. The password itself is never saved.
// (The derived key is still a secret: anyone who can read this plugin's storage can read your
// chats. That is the same trust level as the Aegires app keeping its key in memory.)
import { storage } from "@vendetta/plugin";
import { deriveKey, fromHex, toHex } from "./crypto/keys.ts";

interface ChannelConfig {
  keyHex?: string; // channel-specific key; falls back to the global key
  enabled?: boolean; // encrypt outgoing messages here? (falls back to encryptByDefault)
}

export function initStorage(): void {
  storage.globalKeyHex ??= "";
  storage.channels ??= {};
  storage.encryptByDefault ??= false;
  storage.showLock ??= true;
  storage.debug ??= false;
}

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

/** The key we ENCRYPT with in this channel (channel key wins over global). */
export function getSendKey(channelId: string): Uint8Array | null {
  return keyFromHex(cfg(channelId)?.keyHex) ?? keyFromHex(storage.globalKeyHex);
}

/** Every key worth trying when DECRYPTING in this channel, most specific first. */
export function getReceiveKeys(channelId: string | undefined): Uint8Array[] {
  const keys: Uint8Array[] = [];
  const chan = channelId ? keyFromHex(cfg(channelId)?.keyHex) : null;
  const glob = keyFromHex(storage.globalKeyHex);
  if (chan) keys.push(chan);
  if (glob && glob !== chan) keys.push(glob);
  return keys;
}

export function hasGlobalKey(): boolean {
  return !!keyFromHex(storage.globalKeyHex);
}

/** Should outgoing messages in this channel be encrypted? */
export function isEncryptionOn(channelId: string): boolean {
  const c = cfg(channelId);
  if (c && typeof c.enabled === "boolean") return c.enabled;
  return !!storage.encryptByDefault;
}

export function setChannelEnabled(channelId: string, enabled: boolean): void {
  storage.channels[channelId] = { ...(storage.channels[channelId] ?? {}), enabled };
}

export async function setGlobalPassword(password: string): Promise<void> {
  storage.globalKeyHex = toHex(await deriveKey(password));
}

export function clearGlobalKey(): void {
  storage.globalKeyHex = "";
}

export async function setChannelPassword(channelId: string, password: string): Promise<void> {
  const keyHex = toHex(await deriveKey(password));
  storage.channels[channelId] = { ...(storage.channels[channelId] ?? {}), keyHex };
}

export function removeChannelConfig(channelId: string): void {
  delete storage.channels[channelId];
}

export function listChannelConfigs(): Array<{ id: string; hasKey: boolean; enabled: boolean | undefined }> {
  const out: Array<{ id: string; hasKey: boolean; enabled: boolean | undefined }> = [];
  for (const id of Object.keys(storage.channels ?? {})) {
    const c = storage.channels[id] as ChannelConfig;
    out.push({ id, hasKey: !!c?.keyHex, enabled: c?.enabled });
  }
  return out;
}
