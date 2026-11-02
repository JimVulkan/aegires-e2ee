// Aegires v1 (PBKDF2 + AES-256-GCM). GENERATED from test/fixtures.json (vectors produced by Aegires' own Java Crypto.java).
// Used by the on-device self-test so you can prove interop on the phone itself.
export interface VectorV1 { label: string; password: string; plain: string; wire: string }
export const VECTORS_V1: VectorV1[] = [
  { label: "short ascii", password: "correct horse battery staple", plain: "hi", wire: "§ocamRGm5W4ipCc79FmqVdUaOBv17qbvpUWz5dhyDTg==" },
  { label: "unicode password + emoji text", password: "pässwörd-☃", plain: "unicode ☃ 🔒 éè 日本語", wire: "§wf0RLC7/vN4ti5OWwuRmAxLp22E7V4CFgKBVPAsFanD2AVFxVA29N61zleIam8r+18LVAnJfjK4jSm+S" },
  { label: "compressed (flag=1)", password: "pw", plain: "hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world hello world ", wire: "§vqxQFKct0QMhamAdB6pBenhEzb9OrTd9Z6TWUWC0oIj5hnHJ0JhnsO5YJT4r4Y2vIg==" },
];
