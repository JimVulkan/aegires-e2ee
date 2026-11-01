# Aegires E2EE plugin: developer guide

A Kettu/Revenge plugin that encrypts and decrypts Discord messages in the **same format as
the Aegires Android app** (`Curione23/Aegires`, `app/.../util/Crypto.java`), so people using
the app and people using Kettu can talk to each other.

## What works and how sure we are

| Piece | Status |
|---|---|
| Wire format, key derivation, compression | **Verified** byte-for-byte against Aegires' real Java code (both directions) |
| Send / receive / edit / unload logic | **Verified** with a mock Discord (`test/e2e-mock.mjs`) |
| TypeScript types | **Verified** (`tsc` clean) |
| Real `@noble/*` + `fflate` libs | **Not run yet** (npm was blocked where this was written). Run `npm test` first |
| Discord's real internals (`sendMessage`, `FluxDispatcher` events) | **From memory of the Vendetta API, untested on a phone** |
| Slash command shape, plugin loader wrapper | **From memory, untested.** Kettu's plugin docs were not found |
| Attachments | **Not written. This is your friend's part** |

## Who does what, and why

Hardest to easiest:

1. **Attachments** (friend). Needs hooks into Discord's *upload* pipeline and *media
   rendering*, native file writing, memory limits, and image sizing. Undocumented and fragile.
2. **Receive path** (done). Hooks the message event bus. Fragile when Discord renames events.
3. **Send path** (done). One function to wrap, but must fail closed.
4. **Crypto, storage, settings UI, command** (done). Standard code, tested.

## Wire format (Aegires v1)

```
key   = PBKDF2-HMAC-SHA1(password UTF-8, salt "pwc", 15000 iterations, 32 bytes)
text  = "§" + base64( iv[12] + AES-256-GCM( flag[1] + data ) + tag[16] )
          flag 0 = raw UTF-8   flag 1 = raw DEFLATE   (only used when >= 100 bytes and smaller)
file  = iv[12] + AES-256-GCM(file bytes) + tag[16]      (name becomes x.enc.ext)
image caption: "[sz:W,H]" + text, before encryption
max plaintext: 1300 characters
```

## File map: what each file does

| File | What it does |
|---|---|
| `src/index.tsx` | Entry point. `onLoad` installs each patch in its own try/catch; `onUnload` removes them all |
| `src/crypto/wire.ts` | `encryptText` / `decryptText` / `encryptBytes` / `decryptBytes` in the Aegires format |
| `src/crypto/keys.ts` | Password to key (PBKDF2), hex helpers |
| `src/crypto/utf8.ts`, `base64.ts`, `random.ts` | Own UTF-8 and base64 codecs (Discord's runtime may lack `TextEncoder`/`atob`); secure random that **throws** rather than falling back to `Math.random` |
| `src/crypto/files.ts` | Attachment naming and `[sz:W,H]` helpers |
| `src/state.ts` | Settings storage. Stores the *derived key*, never the password. Global key plus optional per-chat key and on/off |
| `src/patches/send.ts` | Wraps `sendMessage` / `editMessage`; encrypts or blocks (fail closed) |
| `src/patches/receive.ts` | `before` hook on `FluxDispatcher.dispatch`; decrypts message content in place |
| `src/patches/attachments.ts` | **Friend's skeleton** |
| `src/commands.ts` | `/e2ee on|off|status|selftest`. No password option on purpose |
| `src/ui/Settings.tsx` | Settings screen from plain React Native primitives |
| `src/selftest*.ts` | On-device check using real Aegires-made vectors |
| `build.mjs` | esbuild bundle, maps `@vendetta/*` imports to the `vendetta` global, writes `dist/` |
| `test/` | `interop.mjs` (crypto vs Java vectors), `e2e-mock.mjs` (built plugin vs mock Discord), `reference.mjs` (independent Node implementation) |

## Termux setup

```sh
pkg update && pkg install nodejs git unzip
unzip aegires-e2ee.zip && cd aegires-e2ee
npm install
npm test                 # crypto vs Aegires' Java vectors. Run this first.
npm run typecheck
npm run build            # writes dist/index.js and dist/manifest.json
node test/e2e-mock.mjs   # built plugin vs mock Discord
npm run serve            # serves dist/ on http://localhost:4040
```

`npm install` should download esbuild's android-arm64 binary. If that step fails in Termux,
copy the error message and ask for help; do not skip the build step. In Kettu: Settings,
Plugins, add, paste `http://localhost:4040/` (the phone is the server, so `localhost`
works). Edit, `npm run build`, reload the plugin.

## First run on the phone (do in this order)

1. Open plugin settings, press **Run self-test**. It must say PASS on all lines.
   - "secure random ... FAIL": Discord's runtime has no `crypto.getRandomValues`. Encrypting
     is impossible until a native random source is wired into `src/crypto/random.ts`.
     The plugin will refuse to send rather than use weak randomness.
   - A decrypt vector fails: tell us which one; it points at UTF-8 or compression.
2. Set a global key with the **same password** as in the Aegires app.
3. Open a test chat, `/e2ee on` (or enable "encrypt by default"), send a message, confirm the
   Aegires app reads it, then the other direction.
4. If a screen still shows `§...` text, turn on Debug logging and add the logged event type
   to `MESSAGE_EVENTS` in `receive.ts`.

## Security notes

- **The KDF is weak** (SHA-1, fixed salt `pwc`, 15000 rounds). Anyone who saves a ciphertext
  can try passwords offline at high speed. Use a long random passphrase (5+ random words).
  A better v2 format (per-message salt, scrypt/Argon2) needs both apps to change.
- **Aegires has a hardcoded password in the repo**: `ForcedKeys.java` maps channel
  `1562876012675465326` to the password `mojoen`. The repo is public, so anyone can read
  that channel. Rotate it if it matters.
- Shared password means: no forward secrecy, anyone with the password can read all history,
  and any member can forge messages.
- Discord still sees who talks, when, and message sizes. Mentions inside encrypted text do
  not ping. Discord search cannot search ciphertext. Push notifications show ciphertext.
- The derived key sits in plugin storage on the phone. Lock the phone.
