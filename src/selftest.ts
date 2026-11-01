// On-device self-test. Run it from the plugin settings the first time you install the plugin:
// it answers the two questions that decide whether everything else can work on your phone.
//   1. Does Discord's JS runtime have a secure random source?  (needed to encrypt)
//   2. Can we decrypt messages that Aegires' real Java code produced? (needed to interoperate)
import { deriveKey } from "./crypto/keys.ts";
import { decryptBytes, decryptText, encryptBytes, encryptText } from "./crypto/wire.ts";
import { fileModule } from "./native.ts";
import { hasSecureRandom } from "./crypto/random.ts";
import { VECTORS } from "./selftest-vectors.ts";

export async function runSelfTest(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const check = (pass: boolean, text: string) => {
    lines.push((pass ? "PASS  " : "FAIL  ") + text);
    if (!pass) ok = false;
  };

  const rng = hasSecureRandom();
  check(rng, "secure random (crypto.getRandomValues) available");

  for (const v of VECTORS) {
    try {
      const key = await deriveKey(v.password);
      const got = decryptText(v.wire, key);
      check(got === v.plain, "decrypt Aegires vector: " + v.label);
      if (rng) {
        const again = decryptText(encryptText(v.plain, key), key);
        check(again === v.plain, "encrypt+decrypt round trip: " + v.label);
      }
    } catch (e) {
      check(false, v.label + " threw: " + String(e));
    }
  }
  if (rng) {
    try {
      const key = await deriveKey("selftest");
      const bytes = new Uint8Array(4096).map((_, i) => (i * 31) & 255);
      const back = decryptBytes(encryptBytes(bytes, key), key);
      check(!!back && back.length === bytes.length && back.every((v, i) => v === bytes[i]), "attachment encrypt+decrypt round trip");
    } catch (e) {
      check(false, "attachment round trip threw: " + String(e));
    }
  }
  // Not fatal: without it attachments cannot be encrypted (uploads are then blocked).
  lines.push((fileModule() ? "PASS  " : "WARN  ") + "native file module (needed for attachments)");
  return { ok, lines };
}
