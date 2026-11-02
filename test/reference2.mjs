// Independent reference of Aegires v2 (Crypto.java "dcenc2") using ONLY node:crypto (+ noble Argon2
// as a fallback on Node < 24.7, which has no crypto.argon2Sync). Shares no code with src/crypto/*.
import * as nc from "node:crypto";
import { argon2id as nobleArgon } from "@noble/hashes/argon2";

export const PRESETS = [
  { index: 0, bits: 128, keyBytes: 16, tagBytes: 12, padBlock: 16 },
  { index: 1, bits: 192, keyBytes: 24, tagBytes: 14, padBlock: 32 },
  { index: 2, bits: 256, keyBytes: 32, tagBytes: 16, padBlock: 64 },
];
export const argonSource = typeof nc.argon2Sync === "function" ? "node:crypto argon2Sync" : "noble (fallback)";

export function master(password, saltStr, memory = 65536) {
  const pw = Buffer.from(password.normalize("NFKC"), "utf8");
  const salt = Buffer.from(saltStr, "utf8");
  if (typeof nc.argon2Sync === "function") {
    return Buffer.from(nc.argon2Sync("argon2id", { message: pw, nonce: salt, parallelism: 1, tagLength: 32, memory, passes: 3 }));
  }
  return Buffer.from(nobleArgon(pw, salt, { t: 3, m: memory, p: 1, dkLen: 32 }));
}

const u16 = (n) => Buffer.from([(n >>> 8) & 255, n & 255]);
function info(kind, p, ch, se) {
  const c = Buffer.from(ch, "utf8"), s = Buffer.from(se, "utf8");
  return Buffer.concat([Buffer.from("dcenc2/" + kind), Buffer.from([p.index]), u16(c.length), c, u16(s.length), s]);
}
const hk = (m, salt, inf, len) => Buffer.from(nc.hkdfSync("sha256", m, salt, inf, len));
function seal(p, key, nonce, aad, data) {
  const c = nc.createCipheriv(`aes-${p.bits}-gcm`, key, nonce, { authTagLength: p.tagBytes });
  c.setAAD(aad);
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}
function open(p, key, nonce, aad, ct) {
  const d = nc.createDecipheriv(`aes-${p.bits}-gcm`, key, nonce, { authTagLength: p.tagBytes });
  d.setAAD(aad);
  d.setAuthTag(ct.subarray(ct.length - p.tagBytes));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - p.tagBytes)), d.final()]);
}

export function encMsg(text, m, p, ch, se) {
  const data = Buffer.from(text, "utf8");
  const padded = Math.ceil((data.length + 1) / p.padBlock) * p.padBlock;
  const payload = Buffer.alloc(padded); data.copy(payload); payload[data.length] = 0x80;
  const header = (2 << 4) | p.index;
  const salt = nc.randomBytes(16);
  const inf = info("msg", p, ch, se);
  const okm = hk(m, salt, inf, p.keyBytes + 12);
  const ct = seal(p, okm.subarray(0, p.keyBytes), okm.subarray(p.keyBytes), Buffer.concat([Buffer.from([header]), salt, inf]), payload);
  return "§" + Buffer.concat([Buffer.from([header]), salt, ct]).toString("base64").replace(/=+$/, "");
}

export function decMsg(wire, m, ch, se) {
  const raw = Buffer.from(wire.slice(1), "base64");
  const header = raw[0];
  const p = PRESETS.find((x) => x.index === (header & 15));
  const salt = raw.subarray(1, 17);
  const inf = info("msg", p, ch, se);
  const okm = hk(m, salt, inf, p.keyBytes + 12);
  const pl = open(p, okm.subarray(0, p.keyBytes), okm.subarray(p.keyBytes), Buffer.concat([Buffer.from([header]), salt, inf]), raw.subarray(17));
  let end = pl.length; while (end > 0 && pl[end - 1] === 0) end--;
  if (pl[end - 1] !== 0x80) throw new Error("bad padding");
  return pl.subarray(0, end - 1).toString("utf8");
}

const nonceOf = (prefix, counter, last) => Buffer.concat([prefix, Buffer.from([(counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255, last ? 1 : 0])]);

export function encFile(buf, m, p, ch, se) {
  const header = (3 << 4) | p.index;
  const salt = nc.randomBytes(16);
  const inf = info("file", p, ch, se);
  const okm = hk(m, salt, inf, p.keyBytes + 7);
  const key = okm.subarray(0, p.keyBytes), prefix = okm.subarray(p.keyBytes);
  const aad = Buffer.concat([Buffer.from([header]), salt, inf]);
  const n = Math.max(1, Math.ceil(buf.length / 65536));
  const out = [Buffer.from([header]), salt];
  for (let c = 0; c < n; c++) out.push(seal(p, key, nonceOf(prefix, c, c === n - 1), aad, buf.subarray(c * 65536, (c + 1) * 65536)));
  return Buffer.concat(out);
}

export function decFile(wire, m, ch, se) {
  const header = wire[0];
  const p = PRESETS.find((x) => x.index === (header & 15));
  const salt = wire.subarray(1, 17);
  const inf = info("file", p, ch, se);
  const okm = hk(m, salt, inf, p.keyBytes + 7);
  const key = okm.subarray(0, p.keyBytes), prefix = okm.subarray(p.keyBytes);
  const aad = Buffer.concat([Buffer.from([header]), salt, inf]);
  const body = wire.subarray(17), cc = 65536 + p.tagBytes, n = Math.ceil(body.length / cc);
  const out = [];
  for (let c = 0; c < n; c++) out.push(open(p, key, nonceOf(prefix, c, c === n - 1), aad, body.subarray(c * cc, (c + 1) * cc)));
  return Buffer.concat(out);
}
