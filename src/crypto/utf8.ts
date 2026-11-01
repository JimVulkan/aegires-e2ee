// Tiny UTF-8 codec. We do not rely on TextEncoder/TextDecoder because their availability
// inside Discord's Hermes runtime is not guaranteed, and wrong bytes here would silently
// break compatibility with Aegires (Java String.getBytes(UTF_8)).

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0x3f; // lone high surrogate: Java/Android emit '?'
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0x3f; // lone low surrogate
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  const units: number[] = [];
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    let cp = 0xfffd;
    let need = 0;
    let min = 0;
    if (c < 0x80) {
      cp = c;
    } else if (c >= 0xc2 && c <= 0xdf) {
      cp = c & 0x1f; need = 1; min = 0x80;
    } else if (c >= 0xe0 && c <= 0xef) {
      cp = c & 0x0f; need = 2; min = 0x800;
    } else if (c >= 0xf0 && c <= 0xf4) {
      cp = c & 0x07; need = 3; min = 0x10000;
    }
    i++;
    if (need > 0) {
      let ok = i + need <= b.length;
      for (let k = 0; ok && k < need; k++) {
        const cc = b[i + k];
        if ((cc & 0xc0) !== 0x80) ok = false;
        else cp = (cp << 6) | (cc & 0x3f);
      }
      if (ok && cp >= min && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
        i += need;
      } else {
        cp = 0xfffd; // invalid sequence: consume only the lead byte
      }
    }
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      units.push(cp);
    }
  }
  let s = "";
  for (let k = 0; k < units.length; k += 8192) {
    s += String.fromCharCode.apply(null, units.slice(k, k + 8192) as unknown as number[]);
  }
  return s;
}
