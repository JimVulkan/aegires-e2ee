// Your own Discord user id. Aegires binds every ciphertext to (channel id, sender id), so to
// encrypt we must know who WE are. Sources, in order:
//   1. a value already captured from Discord's CONNECTION_OPEN / CURRENT_USER_UPDATE events,
//   2. Discord's UserStore.getCurrentUser() (found by scanning the module registry).
import { findFns } from "./patch.ts";

let cached = "";
let lastLookup = 0;

export function noteSelfId(id: unknown): void {
  if ((typeof id === "string" || typeof id === "number") && /^\d{5,25}$/.test(String(id))) cached = String(id);
}

export function getSelfId(): string | null {
  if (cached) return cached;
  const now = Date.now();
  if (now - lastLookup < 3000) return null; // the registry scan is not free; do not repeat it per keystroke
  lastLookup = now;
  try {
    const store = findFns("getCurrentUser", "getUser");
    noteSelfId(store?.getCurrentUser?.()?.id);
  } catch {}
  return cached || null;
}
