# Friend's task: encrypted attachments

**File to write:** `src/patches/attachments.ts` (a skeleton with the full plan is already there).
Everything else in the plugin is done. This is the hardest part because it means hooking
into Discord's mobile app internals, which have no documentation and change between versions.

## Goal

Make images (then other files) work in encrypted chats, in the same format the Aegires app
uses, so each can open the other's files.

## The format (already implemented and tested in `src/crypto/`)

| Thing | Rule |
|---|---|
| File bytes on Discord | `iv[12] + AES-256-GCM(file) + tag[16]` = `encryptBytes(bytes, key)` |
| File name | `photo.png` becomes `photo.enc.png` = `encryptedFileName(name)` |
| Detect encrypted file | `isEncryptedFileName(name)` (has `.enc.` or ends in `.enc`) |
| Image size hint | caption becomes `[sz:640,480]caption` **before** the caption is encrypted = `makeSizeTag(w,h)` |
| Key | `getSendKey(channelId)` to send, `getReceiveKeys(channelId)` to receive (try each) |

You do not need to touch crypto. Import the helpers.

## Do it in this order

### Part A: receive and display (no upload work needed, so start here)

1. Find the Discord component that draws an image attachment inside a message row. Use the
   plugin console to explore: `findByName("...")`, `findByProps("...")`. Names worth trying
   from memory (they may be wrong for your Discord version): `MessageAccessories`,
   `ChatItem`, `ImageAttachment`, `MediaViewer`. Patch its output with `after()` from
   `@vendetta/patcher`.
2. For an attachment where `isEncryptedFileName(filename)`: `fetch(url)`, get the bytes,
   `decryptBytes(bytes, key)`, turn into `data:<mime>;base64,...` (use `base64Encode` from
   `src/crypto/base64.ts`), render with `<Image source={{ uri }} />`. Mime comes from the
   extension of `originalFileName(filename)`.
3. Cache decrypted images by attachment id (a `Map`, keep the last ~20) so scrolling is cheap.
4. Show placeholders: "Decrypting...", "Key missing", "Decrypt failed". A bad key must
   never crash the chat.

### Part B: send

1. Find where a picked file turns into an upload. Names to look for: `uploadLocalFiles`,
   `CloudUpload`, `UploadManager`, `promptToUpload`. `before()`-patch it.
2. If `isEncryptionOn(channelId)` and a key exists: read the file bytes, `encryptBytes`,
   write them to a temp file (needs a native file-write module; look under
   `nativeModuleProxy` for something like `DCDFileManager` or `RTNFileManager`), then swap
   the upload item's uri, filename (`encryptedFileName`) and mime (`application/octet-stream`).
3. **Fail closed.** If encryption is on and any step fails, cancel the upload. Never let the
   plaintext original go out. (See `src/patches/send.ts` for the pattern.)
4. For images, read the pixel width/height first and put `makeSizeTag(w, h)` at the start of
   the caption. The caption already goes through `send.ts`, so just put the tag in
   `message.content`.

### Part C: polish

Other file types, video, a size limit (keep v1 under ~8 MB; everything is held in JS memory),
progress toasts.

## Definition of done

- [ ] Aegires app opens an image sent by this plugin, and the plugin opens one sent by Aegires.
- [ ] Wrong or missing key shows a placeholder and never crashes.
- [ ] If encryption is on, no plaintext file ever reaches Discord, even when something fails.
- [ ] Disabling the plugin (`onUnload`) removes every patch; Discord behaves normally again.
- [ ] Pure logic has a node test in `test/` (run with `npm test`).

## Things to know

- Nothing here can be tested on a PC-less setup except on the phone itself. Build, serve
  (`npm run serve`), reload the plugin in Kettu, and watch `console.log` output.
- Keep each patch in its own `try/catch` and return an unpatch function. `index.tsx`
  already wraps `installAttachmentPatches()` so a crash here cannot break the other features.
- Do not use `Buffer` or Node APIs: the code runs in Discord's Hermes runtime. Use
  `Uint8Array` and the helpers in `src/crypto/`.
- Do not add npm packages that need native code. Pure-JS only.
