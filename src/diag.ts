declare const __BUILD__: string;
// Live counters shown in the plugin settings ("Diagnostics" card), so we can see what the
// hooks are actually doing on the phone without a console.
export const diag = {
  installed: {} as Record<string, string>,
  events: 0, // every Flux event seen
  msgEvents: 0, // events that carried message(s)
  types: {} as Record<string, number>, // event type -> count, for events carrying messages
  encSeen: 0, // messages starting with the § marker
  decrypted: 0,
  noKey: 0,
  wrongKey: 0,
  noAuthor: 0, // v2 message but its author id was unknown (the author is part of the key)
  lastKdfMs: 0, // how long the last key derivation (PBKDF2 + Argon2id) took
  sendCalls: 0,
  lastSend: "(no send seen yet)",
  attSeen: 0, // encrypted attachments seen
  attDecrypted: 0,
  attFailed: 0,
  attEncrypted: 0,
  lastAttError: "",
  uploadEvents: [] as string[], // upload-related Flux event types seen
  engine: "not started", // WebView crypto engine state
  engineJobs: 0, // operations done by the engine
  engineFallbacks: 0, // operations that fell back to the JS code
  engineLastError: "",
};

export function diagLines(): string[] {
  const types = Object.entries(diag.types).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
  return [
    ...Object.entries(diag.installed).map(([k, v]) => `hook ${k}: ${v}`),
    `flux events seen: ${diag.events}`,
    `message events: ${diag.msgEvents}`,
    `event types with messages: ${types}`,
    `encrypted msgs seen: ${diag.encSeen}`,
    `decrypted OK: ${diag.decrypted}`,
    `no key for channel: ${diag.noKey}`,
    `wrong key: ${diag.wrongKey}`,
    `no author id (v2): ${diag.noAuthor}`,
    `last key derivation: ${diag.lastKdfMs ? (diag.lastKdfMs / 1000).toFixed(1) + " s" : "never run"}`,
    `sendMessage calls: ${diag.sendCalls}`,
    `last send: ${diag.lastSend}`,
    `attachments seen/decrypted/failed: ${diag.attSeen}/${diag.attDecrypted}/${diag.attFailed}`,
    `attachments encrypted: ${diag.attEncrypted}`,
    `upload events: ${diag.uploadEvents.join(", ") || "none"}`,
    ...(diag.lastAttError ? [`last attachment error: ${diag.lastAttError}`] : []),
    `fast engine (WebView): ${diag.engine} [build ${typeof __BUILD__ === "string" ? __BUILD__ : "dev"}]`,
    `engine jobs / JS fallbacks: ${diag.engineJobs} / ${diag.engineFallbacks}`,
    ...(diag.engineLastError ? [`last engine error: ${diag.engineLastError}`] : []),
  ];
}
