// Channels that always use a built-in password (Aegires ForcedKeys.java). This is an INTENDED Aegires
// feature: the channel is public, so nobody has to type a key - everyone gets it automatically.
// Messages there are always encrypted, always AES-128-GCM (like Aegires), and the key is
//   Argon2id(password, salt "dcenc2|ctx|forced|<channelId>")   - stored here already derived,
// so the phone does not need to run the slow Argon2id step for it.
export const FORCED_CHANNELS: Record<string, { keyHex: string }> = {
  "1562876012675465326": { keyHex: "7d5b536cb362f4fb58f9be5c472b5a6967b29eae7f27c469f862bdbdad490234" },
};
