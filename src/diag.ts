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
  sendCalls: 0,
  lastSend: "(no send seen yet)",
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
    `sendMessage calls: ${diag.sendCalls}`,
    `last send: ${diag.lastSend}`,
  ];
}
