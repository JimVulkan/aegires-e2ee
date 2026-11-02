// Aegires v2 key derivation (Crypto.deriveKey):
//   Argon2id v1.3, t=3 passes, m=64 MiB, p=1, 32-byte output.
//   password = NFKC-normalised, UTF-8.
//   salt     = "dcenc2|user-key|v1"            (session-wide password)
//            = "dcenc2|ctx|" + context          (e.g. context "forced|<channelId>" for preset channels)
// The 32-byte result is the "master" key; per-message keys come from HKDF (see v2.ts).
// Slow by design (64 MiB of memory work): always call it once and cache the result.
import { utf8Encode } from "./utf8.ts";

export const ARGON_T = 3;
export const ARGON_M_KIB = 64 * 1024;
export const MASTER_LEN = 32;

const USER_KEY_SALT = "dcenc2|user-key|v1";

export function forcedContext(channelId: string): string {
  return "forced|" + channelId;
}

function normalize(password: string): string {
  try {
    return password.normalize("NFKC");
  } catch {
    return password; // runtime without String.prototype.normalize
  }
}

export type KdfOptions = {
  context?: string;
  onProgress?: (fraction: number) => void;
  /** Test hook only: lower memory. Real keys must use the default. */
  memoryKiB?: number;
};

export async function deriveMasterKey(password: string, opts: KdfOptions = {}): Promise<Uint8Array> {
  if (!password) throw new Error("empty password");
  const salt = utf8Encode(opts.context === undefined ? USER_KEY_SALT : "dcenc2|ctx|" + opts.context);
  // Lazy import: Argon2/BLAKE2b use BigInt at module load. Loading them only when a key is derived
  // means a runtime without BigInt can still decrypt/encrypt with stored keys.
  const { argon2idAsync } = await import("@noble/hashes/argon2");
  return argon2idAsync(utf8Encode(normalize(password)), salt, {
    t: ARGON_T,
    m: opts.memoryKiB ?? ARGON_M_KIB,
    p: 1,
    dkLen: MASTER_LEN,
    asyncTick: 10, // yield to the event loop every ~10 ms so Discord's UI stays alive
    onProgress: opts.onProgress,
  });
}
