// Cryptographically secure random bytes. AES-GCM breaks completely if an IV is ever reused
// with the same key, so we NEVER fall back to Math.random: if the platform has no secure
// source, we throw and the caller refuses to send (fail closed).

export function hasSecureRandom(): boolean {
  const c = (globalThis as any).crypto;
  return !!c && typeof c.getRandomValues === "function";
}

export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as any).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("No secure random source: crypto.getRandomValues is missing in this runtime");
  }
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}
