// Small pure helpers for Aegires' encrypted-attachment conventions. These are done and
// tested; the hard part (hooking Discord's upload/render code) is in patches/attachments.ts.

/** "photo.png" -> "photo.enc.png", "notes" -> "notes.enc", "" -> "file.enc" (same as Aegires). */
export function encryptedFileName(original: string | null | undefined): string {
  if (!original) return "file.enc";
  const dot = original.lastIndexOf(".");
  if (dot > 0 && dot < original.length - 1) return original.slice(0, dot) + ".enc" + original.slice(dot);
  return original + ".enc";
}

/** True for names Aegires would have produced: "x.enc.png" or "x.enc". */
export function isEncryptedFileName(name: string | null | undefined): boolean {
  return !!name && (name.includes(".enc.") || name.endsWith(".enc"));
}

/** Inverse of encryptedFileName, for display / saving: "photo.enc.png" -> "photo.png". */
export function originalFileName(name: string): string {
  if (name.endsWith(".enc")) return name.slice(0, -4);
  const i = name.lastIndexOf(".enc.");
  return i >= 0 ? name.slice(0, i) + name.slice(i + 4) : name;
}

// Aegires prefixes the (encrypted) message text of an image upload with "[sz:W,H]" so the
// receiver can reserve the right space before the image is downloaded and decrypted.
const SIZE_TAG = /^\[sz:(\d+),(\d+)\]/;

export function makeSizeTag(width: number, height: number): string {
  return `[sz:${Math.round(width)},${Math.round(height)}]`;
}

/** Splits a decrypted message body into its optional size tag and the text the user typed. */
export function splitSizeTag(body: string): { width: number; height: number; text: string } | { width: null; height: null; text: string } {
  const m = SIZE_TAG.exec(body);
  if (!m) return { width: null, height: null, text: body };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10), text: body.slice(m[0].length) };
}
