# Aegires E2EE plugin: developer guide

A Kettu/Revenge plugin that encrypts and decrypts Discord messages in the **same format as
the Aegires Android app** ([`Curione23/Aegires`](https://github.com/Curione23/Aegires),
`app/.../util/Crypto.java`), so people using the app and people using Kettu can talk to each
other.

## Status

| Piece | Status |
|---|---|
| Wire format, key derivation, compression | **Verified** byte-for-byte against Aegires' real Java code (both directions, `test/interop.mjs`) |
| Send / receive / edit / unload logic | **Verified** with a mock Discord (`test/e2e-mock.mjs`). Send and receive also work on a real device in Kettu |
| TypeScript types | **Verified** (`tsc` clean) |
| `@noble/*` and `fflate` | Bundled into `dist/index.js`. Text encryption and decryption work on device |
| Discord internals (`sendMessage`, `FluxDispatcher`) | **Working on device.** The Diagnostics panel reports the modules found and the patches installed |
| Slash command | Registers without errors (Diagnostics shows `hook commands: ok`) |
| Attachments (images, video, files) | **Implemented, verified with a mock Discord** (`test/e2e-mock.mjs`). Needs on-device testing |

## Roadmap

- Confirm attachment support on device across Discord versions

## Where the fragile parts are

Hardest to easiest:

1. **Attachments.** Hooks `uploadLocalFiles` (send) and rewrites attachment URLs to decrypted
   cache files (receive), using Discord's native file module. Undocumented and fragile.
2. **Receive path.** Hooks the message event bus. Fragile when Discord renames events.
3. **Send path.** One function to wrap, but must fail closed.
4. **Crypto, storage, settings UI, command.** Standard code, tested.

## Wire format (Aegires v2, default for sending)

```
master = Argon2id(NFKC(password) UTF-8, salt "dcenc2|user-key|v1", t=3, m=64 MiB, p=1, 32 bytes)
info   = "dcenc2/<msg|file>" | preset(1) | len16 | channelId | len16 | senderId
text   = "§" + base64nopad( header | salt[16] | AES-GCM(padded) | tag )
           header = 0x20 | preset   key||nonce = HKDF-SHA256(master, salt, info)   AAD = header|salt|info
           presets: 0 AES-128 (12-byte tag, 16-byte pad blocks), 1 AES-192 (14, 32), 2 AES-256 (16, 64)
           padded = text | 0x80 | zeros, a multiple of the pad block (we pad further with Padmé)
file   = header 0x30 | preset, salt[16], then 64 KiB chunks, each AES-GCM'd with nonce = prefix|counter|last
```

Ciphertexts only open in the same channel and from the same author, so the receiver needs the
author id of each message (remembered across partial `MESSAGE_UPDATE` events) and the sender
needs its own user id (from `CONNECTION_OPEN`, or `UserStore`). Sending fails closed until it is known.

Improvements over upstream `experimental-v2`, all still readable by any v2 decoder:

- **Padmé padding** (`v2.ts`): pads to the Padmé bucket of the length (max ~12% overhead, never
  past the Discord limit) instead of only to the 16/32/64-byte block, so the ciphertext length
  leaks O(log log n) bits about the text instead of nearly all of it. Toggle in settings.
- **Verify before decrypt, half the AES work** (`aead.ts`): short-tag GCM is checked by computing
  the tag directly (GHASH over AAD and ciphertext, xor E(K, J0)) and only then CTR-decrypting.
  Upstream decrypted first and then re-ran a full GCM encryption to recompute the tag.
- **File decryption without per-chunk copies**: chunks are written into one preallocated buffer.
- **Media**: attachments are encrypted/decrypted in the v2 file format; v1 files still open.

## Fast crypto engine (WebView)

Discord runs plugins on Hermes: an interpreter with no JIT and no WebAssembly, and plugins cannot
load native code. Discord does ship a WebView, which runs Chrome's engine. The plugin mounts a
1x1 invisible WebView (`src/engine/engine.tsx`; in the plugin settings, and next to the chat
input when found) running `src/engine/page.ts`:

- Argon2id key derivation in WebAssembly (`hash-wasm`)
- whole attachments: AES-GCM on WebCrypto (native, hardware AES; AES-192, which WebCrypto lacks,
  uses our JS AES JIT-compiled), HKDF, chunking, image/video size, and the CDN download itself.
  Hermes only passes base64 strings between Discord's native file module and the WebView.

Everything falls back to the JS code if the engine is missing, loading or fails. Its state is in
the Diagnostics card (`fast engine (WebView)`, `engine jobs / JS fallbacks`). The JS fallback is
itself tuned for an interpreter: allocation-free Argon2id (`argon2.ts`, ~2x @noble/hashes) and
flat T-table AES-CTR (`aesfast.ts`).

## Wire format (Aegires v1, legacy)

```
key   = PBKDF2-HMAC-SHA1(password UTF-8, salt "pwc", 15000 iterations, 32 bytes)
text  = "§" + base64( iv[12] + AES-256-GCM( flag[1] + data ) + tag[16] )
          flag 0 = raw UTF-8   flag 1 = raw DEFLATE   (only used when >= 100 bytes and smaller)
file  = iv[12] + AES-256-GCM(file bytes) + tag[16]      (name becomes x.enc.ext)
image caption: "[sz:W,H]" + text, before encryption
max plaintext: 1300 characters
```

## File map

| File | What it does |
|---|---|
| `src/index.tsx` | Entry point. `onLoad` installs each patch in its own try/catch; `onUnload` removes them all |
| `src/crypto/wire.ts` | v1 `encryptText` / `decryptText` / `encryptBytes` / `decryptBytes` |
| `src/crypto/v2.ts`, `kdf2.ts`, `aead.ts` | v2 messages/files, Argon2id master key, short-tag AES-GCM |
| `src/self.ts`, `src/forced.ts` | Own user id (v2 binds to it); Aegires built-in channel keys |
| `src/crypto/keys.ts` | Password to key (PBKDF2), hex helpers |
| `src/crypto/utf8.ts`, `base64.ts`, `random.ts` | Own UTF-8 and base64 codecs (Discord's runtime may lack `TextEncoder`/`atob`); secure random that **throws** rather than falling back to `Math.random` |
| `src/crypto/files.ts` | Attachment naming, `[sz:W,H]`, CDN URL and MIME helpers |
| `src/state.ts` | Settings storage. Stores the *derived key*, never the password. Global key plus optional per-chat key and on/off |
| `src/patches/send.ts` | Wraps `sendMessage` / `editMessage`; encrypts or blocks (fail closed) |
| `src/patches/receive.ts` | `before` hook on `FluxDispatcher.dispatch`; decrypts message content in place, remembers encrypted ids so edits stay encrypted |
| `src/patches/media.ts` | Incoming attachments: download, decrypt to Discord's cache dir, rewrite the attachment and dispatch a partial `MESSAGE_UPDATE` |
| `src/patches/upload.ts` | Outgoing attachments: wraps `uploadLocalFiles`, encrypts files and caption (with `[sz:W,H]`), fails closed |
| `src/native.ts` | Native file module lookup, reading URIs into bytes, writing cache files |
| `src/commands.ts` | `/e2ee on|off|status|selftest`. No password option on purpose |
| `src/ui/Settings.tsx` | Settings screen from plain React Native primitives |
| `src/selftest*.ts` | On-device check using real Aegires-made vectors |
| `build.mjs` | esbuild bundle, maps `@vendetta/*` imports to the `vendetta` global, writes `dist/` |
| `test/` | `interop.mjs` (crypto vs Java vectors), `e2e-mock.mjs` (built plugin vs mock Discord), `reference.mjs` (independent Node implementation), `attachments.mjs` (attachment tests) |

## Development setup (Termux)

```sh
pkg update && pkg install nodejs git
git clone https://github.com/JimVulkan/aegires-e2ee.git
cd aegires-e2ee
npm install
npm test                 # crypto vs Aegires' Java vectors
npm run typecheck
npm run build            # writes dist/index.js and dist/manifest.json
npm run test:e2e        # build, then built plugin vs mock Discord
npm run serve            # serves dist/ on http://localhost:4040
```

In Kettu, add the plugin by URL and paste `http://localhost:4040/` (the phone is the server,
so `localhost` works). Edit the code, run `npm run build`, then reload the plugin.

**If the build fails with `spawn ... esbuild EACCES`:** the esbuild binary lost its
executable bit (this happens when `node_modules` is copied). Fix it with:

```sh
chmod +x node_modules/@esbuild/android-arm64/bin/esbuild
```

If that doesn't help, delete `node_modules` and run `npm install` again.

## Publishing (GitHub Pages)

`.github/workflows/pages.yml` runs on every push to `main`: typecheck, tests, build, mock e2e
test, then it publishes `dist/` to GitHub Pages. One-time setup in the GitHub repo:
**Settings -> Pages -> Build and deployment -> Source: GitHub Actions**. A run can also be
started by hand from the Actions tab ("Run workflow").

Kettu installs from `https://jimvulkan.github.io/aegires-e2ee/` (keep the trailing slash). GitHub Pages caches
for a few minutes, so a new deploy can take a moment to show up. Kettu detects updates through
the `hash` in `manifest.json`.

## First run on the phone (do in this order)

1. Open plugin settings, press **Run self-test**. It must say PASS on all lines.
   - "secure random ... FAIL": Discord's runtime has no `crypto.getRandomValues`. Encrypting
     is impossible until a native random source is wired into `src/crypto/random.ts`.
     The plugin will refuse to send rather than use weak randomness.
   - A decrypt vector fails: note which one; it points at UTF-8 or compression.
2. Set a global key with the **same password** as in the Aegires app.
3. Open a test chat, `/e2ee on` (or enable "encrypt by default"), send a message, confirm the
   Aegires app reads it, then the other direction.
4. If a screen still shows `§...` text, turn on Debug logging and add the logged event type
   to `MESSAGE_EVENTS` in `receive.ts`.

The **Diagnostics** section in the settings screen shows which hooks installed and counts of
encrypted, decrypted, no-key and wrong-key messages. Press **Refresh** after sending or
receiving a message.

## Security notes

- **The KDF is weak** (SHA-1, fixed salt `pwc`, 15000 rounds). Anyone who saves a ciphertext
  can try passwords offline at high speed. Use a long random passphrase (5+ random words).
  A better v2 format (per-message salt, scrypt/Argon2) needs both apps to change.
- **Aegires has a hardcoded channel password in its public repo** (`ForcedKeys.java`). Anyone
  can read that channel. Consider reporting it to the Aegires developer.
- Shared password means: no forward secrecy, anyone with the password can read all history,
  and any member can forge messages.
- Discord still sees who talks, when, and message sizes. Mentions inside encrypted text do
  not ping. Discord search cannot search ciphertext. Push notifications show ciphertext.
- The derived key sits in plugin storage on the phone. Lock the phone.

## Credits and license

Made by **Dark** ([system32crowdstrikewin11](https://github.com/system32crowdstrikewin11)).
Leverages the encryption feature of [Aegires](https://github.com/Curione23/Aegires) by
Curione23. Licensed under the [PolyForm Noncommercial License 1.0.0](../LICENSE.md).
