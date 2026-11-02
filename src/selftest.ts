// On-device self-test (plugin settings > Self-test). It proves, on THIS phone's JS engine, that
// everything both Aegires formats need gives the right bytes:
//   v1: PBKDF2 + AES-256-GCM vectors made by Aegires' real Java code.
//   v2: secure random, BigInt (Argon2), AES-128/192/256 + short GCM tags, HKDF, file chunks and
//       Argon2id itself (small-memory vectors; "Measure key derivation" runs the real 64 MiB one).
import { deriveKey } from "./crypto/keys.ts";
import { decryptBytes, decryptText, encryptBytes, encryptText } from "./crypto/wire.ts";
import { decryptFile, decryptMessage, encryptFile, encryptMessage, messagePreset, presetFromIndex } from "./crypto/v2.ts";
import { deriveMasterKey } from "./crypto/kdf2.ts";
import { fromHex, toHex } from "./crypto/hex.ts";
import { hasSecureRandom } from "./crypto/random.ts";
import { fileModule } from "./native.ts";
import { VECTORS_V1 } from "./selftest-vectors-v1.ts";
import { CHANNEL_ID, FILE, KDF, MASTER_HEX, MESSAGES, SENDER_ID } from "./selftest-vectors.ts";

export async function runSelfTest(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const check = (pass: boolean, text: string) => {
    lines.push((pass ? "PASS  " : "FAIL  ") + text);
    if (!pass) ok = false;
  };
  const guard = async (label: string, fn: () => Promise<void> | void) => {
    try { await fn(); } catch (e) { check(false, label + " threw: " + String(e)); }
  };

  const rng = hasSecureRandom();
  check(rng, "secure random (crypto.getRandomValues) available");
  check(typeof (globalThis as any).BigInt === "function", "BigInt available (needed for Argon2id)");

  // ---- v1
  for (const v of VECTORS_V1) {
    await guard("v1 " + v.label, async () => {
      const key = await deriveKey(v.password);
      check(decryptText(v.wire, key) === v.plain, "v1 decrypt Aegires vector: " + v.label);
      if (rng) check(decryptText(encryptText(v.plain, key), key) === v.plain, "v1 round trip: " + v.label);
    });
  }
  if (rng) {
    await guard("v1 file", async () => {
      const key = await deriveKey("selftest");
      const bytes = new Uint8Array(4096).map((_, i) => (i * 31) & 255);
      const back = decryptBytes(encryptBytes(bytes, key), key);
      check(!!back && toHex(back) === toHex(bytes), "v1 attachment round trip");
    });
  }

  // ---- v2
  const master = fromHex(MASTER_HEX)!;
  for (const v of MESSAGES) {
    await guard("v2 " + v.label, () => {
      check(decryptMessage(v.wire, master, CHANNEL_ID, SENDER_ID) === v.plain, "v2 decrypt vector: " + v.label);
      check(messagePreset(v.wire)?.index === v.preset, "v2 preset detected from header: " + v.label);
      check(decryptMessage(v.wire, master, CHANNEL_ID, "999") === null, "v2 wrong sender rejected: " + v.label);
      if (rng) {
        const again = decryptMessage(encryptMessage(v.plain, master, presetFromIndex(v.preset)!, CHANNEL_ID, SENDER_ID), master, CHANNEL_ID, SENDER_ID);
        check(again === v.plain, "v2 round trip (Padmé padded): " + v.label);
      }
    });
  }
  await guard("v2 file", () => {
    const got = decryptFile(fromHex(FILE.wireHex)!, master, CHANNEL_ID, SENDER_ID);
    check(!!got && toHex(got) === FILE.plainHex, "v2 decrypt file vector: " + FILE.label);
    if (rng) {
      const big = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
      const back = decryptFile(encryptFile(big, master, presetFromIndex(2)!, CHANNEL_ID, SENDER_ID), master, CHANNEL_ID, SENDER_ID);
      check(!!back && back.length === big.length && toHex(back.subarray(65530, 65545)) === toHex(big.subarray(65530, 65545)), "v2 file round trip across a chunk boundary (70000 B)");
    }
  });
  for (const v of KDF) {
    await guard("Argon2id " + v.label, async () => {
      const t0 = Date.now();
      const key = await deriveMasterKey(v.password, { context: v.context ?? undefined, memoryKiB: v.memoryKiB });
      check(toHex(key) === v.key, `Argon2id vector: ${v.label} (${Date.now() - t0} ms)`);
    });
  }

  // Not fatal: without it attachments cannot be encrypted (uploads are then blocked).
  lines.push((fileModule() ? "PASS  " : "WARN  ") + "native file module (needed for attachments)");
  return { ok, lines };
}

/** Real-size derivation (64 MiB, 3 passes) so you can see how long a key takes on this phone. */
export async function measureKdf(onProgress?: (fraction: number) => void): Promise<number> {
  const t0 = Date.now();
  await deriveMasterKey("benchmark-password", { onProgress });
  return Date.now() - t0;
}
