# Aegires E2EE

Encrypt and decrypt Discord messages with a shared passphrase, as a plugin for **Kettu** (Revenge-based) on Android.

Aegires E2EE is built with Kettu as its primary target. Messages are also designed to be readable by people using the native **Aegires Android client**, or an Aliucord plugin that is compatible with it, as long as everyone uses the same key.

This plugin leverages the client-side encryption feature of [Aegires](https://github.com/Curione23/Aegires) by Curione23. See [Credits](#credits).

> **Status: experimental.** Text encryption and decryption work. Attachment (image, video, file) encryption is newly implemented and still needs on-device testing. See [Status](#status) and [Known issues](#known-issues).

---

## Features

- **Text message encryption and decryption** with a shared password
- **Aegires v2 format**: Argon2id password keys, a fresh HKDF key per message and per file bound to the chat and the sender, AES-128 / 192 / 256-GCM presets. Old v1 messages are still decrypted, and v1 can still be chosen for sending
- **Padmé length padding** for v2 messages, so ciphertext length says much less about the text length (still readable by every v2 client)
- **Global key** used in every chat that has no key of its own
- **Per-chat keys**: set a separate password for a specific channel, by channel ID
- **Per-chat on/off switch** for outgoing encryption, so you choose where messages are encrypted
- **Encrypt by default** option for chats without their own setting
- **Lock icon** shown in front of decrypted messages, so you can tell what was encrypted
- **Password is never stored**. Only the key derived from it is kept
- **Encrypted attachments** (images, videos, other files) in the Aegires `x.enc.ext` format, with fail-closed uploads
- **Edits stay encrypted**: editing an encrypted message re-encrypts it even if the chat was switched off
- **Built-in diagnostics** showing what the plugin hooks are doing and how many messages were encrypted, decrypted or failed
- **Built-in self-test** that checks Discord has a secure random source and that your phone can decrypt messages made by the real Aegires code
- **Optional debug logging**

## Status

| Feature | Status |
| --- | --- |
| Text encryption / decryption | Working |
| Global key and per-chat keys | Working |
| Per-chat on/off switch | Working |
| Lock icon on decrypted messages | Working |
| Diagnostics and self-test | Working |
| Image encryption / decryption | Implemented, experimental |
| Video and other file encryption | Implemented, experimental |
| Aegires v2 (Argon2id, HKDF, AES-128/192/256) | Implemented, experimental |

## Compatibility

| Client | Support |
| --- | --- |
| Kettu (Android) | Primary target |
| [Aegires](https://github.com/Curione23/Aegires) Android client | Can read messages if it uses the same key |
| Aliucord with a compatible plugin | Can read messages if it uses the same key |

Everyone in a conversation must use the **same password**. Messages cannot be decrypted without it.

## Installation

1. Open Kettu and go to its plugin manager.
2. Choose to install a plugin from a URL.
3. Paste this URL, including the trailing slash:

   ```
   https://jimvulkan.github.io/aegires-e2ee/
   ```

4. Enable **Aegires E2EE**.

## Usage

1. Open the plugin settings with the wrench icon on the plugin card.
2. Run the **Self-test** first to confirm everything works on your device.
3. Under **Global key**, type the shared password and press **Set global key**.
4. To use a different password in one chat, fill in the **Per-chat key / switch** section with that chat's channel ID and password, then press **Save for this chat**.
5. Turn on **Encrypt outgoing here** for chats where you want your messages encrypted, or enable **Encrypt outgoing messages by default**.

Leave the password empty in the per-chat section if you only want to change that chat's on/off setting.

If something isn't working, press **Refresh** in the Diagnostics section after sending or receiving a message to see what the plugin is doing.

## Known issues

- Attachment support is new and has only been tested against a mock Discord. If uploads are cancelled or images do not show, turn on debug logging and include the Diagnostics output in an issue.
- Decrypted attachments are cached as plain files in Discord's cache folder until the plugin is unloaded.
- Attachments larger than 10 MB are not encrypted (the upload is cancelled).

Please open an issue if you find something else. Turn on debug logging and include the Diagnostics output if you can.

## Roadmap

- Confirm attachment support on more Discord versions

## Building from source

Requires Node.js and npm.

```sh
git clone https://github.com/JimVulkan/aegires-e2ee.git
cd aegires-e2ee
npm install
npm run build
```

The build writes `index.js` and `manifest.json` to `dist/`. Every push to `main` is built, tested and published to GitHub Pages by `.github/workflows/pages.yml`.

## Security notes

- This is an experimental hobby project. Do not rely on it where failure would be serious.
- Encryption covers message content only. Discord can still see who is talking to whom, in which channel, and when.
- Anyone who has the password can read the messages. Share it through a channel you trust, not through the encrypted chat itself.

## Credits

- Made by **Dark** ([system32crowdstrikewin11](https://github.com/system32crowdstrikewin11)).
- Leverages the encryption feature of the [Aegires](https://github.com/Curione23/Aegires) Android client by [Curione23](https://github.com/Curione23). Full credit for the original client and its encryption goes to them.


## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, modify and fork this project for noncommercial purposes. Forks must keep the notice in [NOTICE](NOTICE), which credits this repo. Contributions are welcome and are accepted under the same license.
