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
const FluxDispatcher = { dispatch: (event) => { dispatched.push(event); } };

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
    findByProps: (...p) => (p.includes("sendMessage") ? MessageActions : undefined),
    findByStoreName: () => ({ getChannelId: () => "999" }),
    common: { React: { createElement: () => null, useState: (v) => [v, () => {}] }, ReactNative: new Proxy({}, { get: () => "RN" }), FluxDispatcher },
  },
  plugin: { storage },
  storage: { useProxy: (s) => s },
  ui: { toasts: { showToast: (t) => toasts.push(t) } },
  commands: { registerCommand: (c) => { commands.push(c); return () => commands.splice(commands.indexOf(c), 1); } },
};

// ---- load the bundle like a loader would --------------------------------------------------
const ctx = vm.createContext({ vendetta, console, require, crypto: globalThis.crypto, setTimeout, clearTimeout });
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
