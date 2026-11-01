// End-to-end test of the BUILT plugin against a mock Discord.   Run:  npm run build && node test/e2e-mock.mjs
//
// It evaluates dist/index.js the way a Vendetta-style loader does (as an expression inside
// `vendetta => { return <code> }`), hands it a fake `vendetta` object (patcher, metro,
// storage, toasts, commands) and then drives the patched send/receive paths.
//
// What this proves: our send/receive/edit logic, fail-closed behaviour, unpatching, and (when
// run on your machine with the real npm libs) that the bundled @noble/fflate code is wire
// compatible. What it can NOT prove: that Discord's real internals look like the mock - that
// needs a phone (see docs/GUIDE.md, "First run on the phone").
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import * as ref from "./reference.mjs";

const require = createRequire(import.meta.url);
const code = fs.readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));

// ---- mock Discord -------------------------------------------------------------------------
const toasts = [];
const sent = [];
const edited = [];
const dispatched = [];
const storage = {};
const commands = [];

const MessageActions = {
  sendMessage: (channelId, message) => { sent.push({ channelId, content: message.content }); return Promise.resolve("sent"); },
  editMessage: (channelId, id, message) => { edited.push({ channelId, id, content: message.content }); return Promise.resolve("edited"); },
  receiveMessage() {},
};
const FluxDispatcher = { dispatch: (event) => { dispatched.push(event); }, subscribe() {}, unsubscribe() {} };
const uploaded = [];
const Upload = { uploadLocalFiles: (opts) => { uploaded.push(opts); return Promise.resolve("uploaded"); } };

// Fake native file system + network, so attachment code can run in node.
const files = new Map(); // path -> Buffer
const remote = new Map(); // url -> Buffer
const nativeModuleProxy = {
  NativeFileModule: {
    getConstants: () => ({ CacheDirPath: "/cache" }),
    writeFile: async (dir, rel, data, enc) => { assert.equal(dir, "cache"); assert.equal(enc, "base64"); files.set("/cache/" + rel, Buffer.from(data, "base64")); },
    removeFile: async (dir, rel) => { files.delete("/" + dir + "/" + rel); },
  },
};
const fakeFetch = async (url) => {
  const b = url.startsWith("file://") ? files.get(url.slice(7)) : remote.get(url);
  if (!b) return { ok: false, status: 404, blob: async () => new Blob([]) };
  return { ok: true, status: 200, blob: async () => new Blob([b]) };
};

// Same semantics as Vendetta's patcher: patch in place, return an unpatch function.
function patcher(kind) {
  return (name, obj, cb) => {
    const orig = obj[name];
    obj[name] = function (...args) {
      if (kind === "before") { const r = cb(args); return orig.apply(this, Array.isArray(r) ? r : args); }
      if (kind === "after") return cb(args, orig.apply(this, args));
      return cb(args, orig.bind(this));
    };
    return () => { obj[name] = orig; };
  };
}
const vendetta = {
  patcher: { before: patcher("before"), after: patcher("after"), instead: patcher("instead") },
  metro: {
    findByProps: (...p) => (p.includes("sendMessage") ? MessageActions : p.includes("uploadLocalFiles") ? Upload : undefined),
    findByStoreName: () => ({ getChannelId: () => "999" }),
    common: { React: { createElement: () => null, useState: (v) => [v, () => {}] }, ReactNative: new Proxy({}, { get: (_, k) => (k === "Alert" ? { alert: (_t, m) => toasts.push(m) } : k === "Image" ? { getSize: (_u, ok) => ok(640, 480) } : "RN") }), FluxDispatcher },
  },
  plugin: { storage },
  storage: { useProxy: (s) => s },
  ui: { toasts: { showToast: (t) => toasts.push(t) } },
  commands: { registerCommand: (c) => { commands.push(c); return () => commands.splice(commands.indexOf(c), 1); } },
};

// ---- load the bundle like a loader would --------------------------------------------------
const ctx = vm.createContext({ vendetta, console, require, crypto: globalThis.crypto, setTimeout, clearTimeout, nativeModuleProxy, fetch: fakeFetch });
const tick = () => new Promise((r) => setTimeout(r, 20));
const raw = vm.runInContext(`(vendetta => { return ${code} })(vendetta)`, ctx);
const plugin = raw.default ?? raw;
assert.equal(typeof plugin.onLoad, "function");
assert.equal(typeof plugin.onUnload, "function");
assert.ok(plugin.settings, "settings component exported");
console.log("  ok  bundle evaluates to { default: { onLoad, onUnload, settings } }");

plugin.onLoad();
assert.equal(commands.length, 1, "/e2ee registered");
const key = ref.deriveKey("pw");
const keyHex = key.toString("hex");

// ---- outgoing -----------------------------------------------------------------------------
storage.globalKeyHex = keyHex;
storage.encryptByDefault = true;
await MessageActions.sendMessage("123", { content: "hello there" });
assert.ok(sent.at(-1).content.startsWith("§"));
assert.equal(ref.decrypt(sent.at(-1).content, key), "hello there");
console.log("  ok  outgoing text is encrypted and readable by the reference (=> by Aegires)");

const n = sent.length;
await MessageActions.sendMessage("123", { content: "x".repeat(1301) });
assert.equal(sent.length, n, "over-long message must NOT be sent");
assert.ok(toasts.at(-1).includes("Too long"));
console.log("  ok  >1300 chars is blocked (fail closed), not sent in plaintext");

storage.channels["777"] = { enabled: false };
await MessageActions.sendMessage("777", { content: "plain on purpose" });
assert.equal(sent.at(-1).content, "plain on purpose");
console.log("  ok  per-channel OFF sends plaintext");

storage.globalKeyHex = "";
await MessageActions.sendMessage("123", { content: "no key" });
assert.equal(sent.length, n + 1, "no key + encryption on => blocked");
assert.ok(toasts.at(-1).includes("no key"));
storage.globalKeyHex = keyHex;
console.log("  ok  encryption on but no key => blocked, not sent in plaintext");

await MessageActions.editMessage("123", "m1", { content: "🔒 edited text" });
assert.equal(ref.decrypt(edited.at(-1).content, key), "edited text");
console.log("  ok  edit strips the lock marker, then encrypts");

// ---- incoming -----------------------------------------------------------------------------
FluxDispatcher.dispatch({ type: "MESSAGE_CREATE", channelId: "123", message: { id: "1", channel_id: "123", content: ref.encrypt("secret text", key) } });
assert.equal(dispatched.at(-1).message.content, "🔒 secret text");

const javaCompressed = fx.cases[3];
const javaCaption = fx.cases[6];
FluxDispatcher.dispatch({
  type: "LOAD_MESSAGES_SUCCESS",
  channelId: "123",
  messages: [
    { id: "2", channel_id: "123", content: javaCompressed.wire },
    { id: "3", channel_id: "123", content: javaCaption.wire, referenced_message: { id: "2", channel_id: "123", content: ref.encrypt("quoted", key) } },
    { id: "4", channel_id: "123", content: "just a normal message" },
    { id: "5", channel_id: "123", content: ref.encrypt("other key", ref.deriveKey("someone else")) },
  ],
});
const msgs = dispatched.at(-1).messages;
assert.equal(msgs[0].content, "🔒 " + Buffer.from(javaCompressed.plain_b64, "base64").toString("utf8"));
assert.equal(msgs[1].content, "🔒 look at this", "[sz:W,H] tag stripped from Aegires caption");
assert.equal(msgs[1].referenced_message.content, "🔒 quoted");
assert.equal(msgs[2].content, "just a normal message");
assert.ok(msgs[3].content.startsWith("§"), "undecryptable message left untouched");
console.log("  ok  incoming: Java-made messages (compressed + [sz] caption), replies, history; foreign/plain untouched");

storage.showLock = false;
FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message: { id: "6", channel_id: "123", content: ref.encrypt("no icon", key) } });
assert.equal(dispatched.at(-1).message.content, "no icon");
console.log("  ok  lock icon can be turned off");

// ---- edits of encrypted messages stay encrypted ------------------------------------------
storage.channels["123"] = { enabled: false };
await MessageActions.editMessage("123", "1", { content: "🔒 changed my mind" });
assert.equal(ref.decrypt(edited.at(-1).content, key), "changed my mind");
await MessageActions.editMessage("123", "4", { content: "plain edit" });
assert.equal(edited.at(-1).content, "plain edit");
delete storage.channels["123"];
console.log("  ok  editing a decrypted message re-encrypts it even when the chat is off");

// ---- attachments: upload ------------------------------------------------------------------
storage.showLock = true;
const photo = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 13) & 255));
files.set("/pics/photo.png", photo);
const up = { item: { uri: "file:///pics/photo.png", filename: "photo.png", mimeType: "image/png" }, filename: "photo.png", mimeType: "image/png", isImage: true, currentSize: photo.length };
await Upload.uploadLocalFiles({ channelId: "123", uploads: [up], parsedMessage: { content: "look" } });
const sentUp = uploaded.at(-1);
assert.ok(sentUp, "upload went through");
assert.equal(up.item.filename, "photo.enc.png");
assert.equal(up.item.mimeType, "application/octet-stream");
assert.equal(up.isImage, false);
assert.ok(up.item.uri.startsWith("file:///cache/aegires/"));
const encFile = files.get(up.item.uri.slice(7));
assert.equal(up.currentSize, encFile.length);
assert.deepEqual(ref.decryptBytes(encFile, key), photo);
assert.equal(ref.decrypt(sentUp.parsedMessage.content, key), "[sz:640,480]look");
console.log("  ok  upload: file encrypted (Aegires framing), renamed x.enc.png, caption gets [sz] tag + encrypted");

storage.attachments = false;
const nUp = uploaded.length;
await Upload.uploadLocalFiles({ channelId: "123", uploads: [{ item: { uri: "file:///pics/photo.png", filename: "photo.png" } }], parsedMessage: { content: "" } });
assert.equal(uploaded.length, nUp, "attachments off + encryption on => upload blocked");
storage.attachments = true;
await Upload.uploadLocalFiles({ channelId: "123", uploads: [{ item: { uri: "file:///missing.png", filename: "x.png" } }], parsedMessage: { content: "" } });
assert.equal(uploaded.length, nUp, "unreadable file => upload blocked");
storage.channels["777"] = { enabled: false };
await Upload.uploadLocalFiles({ channelId: "777", uploads: [{ item: { uri: "file:///pics/photo.png", filename: "photo.png" } }], parsedMessage: { content: "hi" } });
assert.equal(uploaded.at(-1).parsedMessage.content, "hi");
console.log("  ok  upload fails closed (attachments off / unreadable file); plaintext chats untouched");

const viaSend = { item: { uri: "file:///pics/photo.png", filename: "photo.png", mimeType: "image/png" }, filename: "photo.png", isImage: true };
await MessageActions.sendMessage("123", { content: "cap" }, undefined, { attachmentsToUpload: [viaSend] });
assert.equal(viaSend.item.filename, "photo.enc.png");
assert.deepEqual(ref.decryptBytes(files.get(viaSend.item.uri.slice(7)), key), photo);
assert.equal(ref.decrypt(sent.at(-1).content, key), "[sz:640,480]cap");
console.log("  ok  sendMessage with attachmentsToUpload: files + caption encrypted");

FluxDispatcher.dispatch({ type: "UPLOAD_ATTACHMENT_ADD_FILES", channelId: "123", files: [] });
assert.equal(dispatched.at(-1).type, "UPLOAD_ATTACHMENT_ADD_FILES", "upload hook present => attach allowed");
console.log("  ok  attaching files allowed while the upload hook is installed");

// ---- attachments: receive -----------------------------------------------------------------
const cdn = "https://cdn.discordapp.com/attachments/123/555/photo.enc.png?ex=1&is=2&hm=3";
remote.set(cdn, encFile);
const att = { id: "555", filename: "photo.enc.png", url: cdn, proxy_url: cdn.replace("cdn.discordapp.com", "media.discordapp.net") + "&width=100", size: encFile.length };
FluxDispatcher.dispatch({ type: "MESSAGE_CREATE", channelId: "123", message: { id: "50", channel_id: "123", content: sentUp.parsedMessage.content, attachments: [att] } });
assert.equal(dispatched.at(-1).message.content, "🔒 look");
await tick();
const upd = dispatched.at(-1);
assert.equal(upd.type, "MESSAGE_UPDATE");
assert.equal(upd.message.id, "50");
const a2 = upd.message.attachments[0];
assert.ok(a2.url.startsWith("file:///cache/aegires/"), a2.url);
assert.equal(a2.filename, "photo.png");
assert.equal(a2.content_type, "image/png");
assert.equal(a2.width, 640);
assert.deepEqual(files.get(a2.url.slice(7)), photo);
FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message: { id: "50", channel_id: "123", attachments: [{ ...att }] } });
assert.equal(dispatched.at(-1).message.attachments[0].url, a2.url, "already-decrypted attachment is rewritten synchronously");
console.log("  ok  receive: encrypted attachment downloaded, decrypted to a cache file, message updated");

remote.set("https://cdn.discordapp.com/attachments/123/556/x.enc.png", ref.encryptBytes(photo, ref.deriveKey("other")));
const nd = dispatched.length;
FluxDispatcher.dispatch({ type: "MESSAGE_CREATE", message: { id: "51", channel_id: "123", content: "", attachments: [{ id: "556", filename: "x.enc.png", url: "https://cdn.discordapp.com/attachments/123/556/x.enc.png" }] } });
await tick();
assert.equal(dispatched.length, nd + 1, "wrong key => no update dispatched");
assert.equal(dispatched.at(-1).message.attachments[0].filename, "x.enc.png");
console.log("  ok  receive: wrong-key attachment left untouched");

// ---- command ------------------------------------------------------------------------------
await commands[0].execute([{ name: "action", value: "off" }], { channel: { id: "123" } });
assert.equal(storage.channels["123"].enabled, false);
await MessageActions.sendMessage("123", { content: "after /e2ee off" });
assert.equal(sent.at(-1).content, "after /e2ee off");
console.log("  ok  /e2ee off switches the chat to plaintext");

// ---- unload -------------------------------------------------------------------------------
plugin.onUnload();
storage.channels = {}; storage.encryptByDefault = true;
await MessageActions.sendMessage("123", { content: "after unload" });
assert.equal(sent.at(-1).content, "after unload", "unpatched: nothing encrypts any more");
FluxDispatcher.dispatch({ type: "MESSAGE_CREATE", message: { id: "9", channel_id: "123", content: ref.encrypt("still locked", key) } });
assert.ok(dispatched.at(-1).message.content.startsWith("§"), "unpatched: nothing decrypts any more");
console.log("  ok  onUnload removes every patch");

console.log("\nE2E mock test passed.");
