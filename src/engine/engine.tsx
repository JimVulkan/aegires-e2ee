// Plugin side of the WebView crypto engine (the page is src/engine/page.ts).
//
// Hermes runs plugin code in an interpreter with no WebAssembly, but Discord ships a WebView, which
// runs Chrome's engine (JIT, WebAssembly, WebCrypto with hardware AES).
//
// One job = one short-lived 1x1 invisible WebView whose HTML carries the request; the page answers
// through onMessage and the WebView is removed. So only the native -> JS message event is needed,
// never a native command, which keeps working when we have to use the bare native view.
//
// Which WebView: Discord's react-native-webview component if it is loaded; otherwise the native
// "RNCWebView" view itself (Discord loads the JS wrapper lazily, often never). Registering that
// view name ourselves would make Discord's own later registration throw ("Tried to register two
// views with the same name"), so we only do it after patching React Native's view registry to
// ignore a second registration of that name.
//
// <EngineHost/> renders the job WebViews (in the plugin settings, and next to the chat input when
// it can be found); the first mounted host is active. Every caller must work without the engine:
// `call` rejects when there is none, and callers fall back to the JS code.
import { findComponent, findExportedComponent, findModuleWhere, findWithLoaders, instead } from "../patch.ts";
import { React, RN } from "../rt.ts";
import { diag } from "../diag.ts";

declare const __ENGINE_PAGE__: string;

const NATIVE = "RNCWebView";

type Job = { id: number; html: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: any };
type WebViewKind = { comp: any; native: boolean };

let found: WebViewKind | null = null;
let seq = 0;
const jobs = new Map<number, Job>();
const hosts: Array<(on: boolean) => void> = [];
let rerender: (() => void) | null = null;
let hostWaiters: Array<(ok: boolean) => void> = [];
let unguard: (() => void) | null = null;
let ours = false; // we registered the native view name

function nativeViewExists(): boolean {
  // requireNativeComponent builds the view config from exactly this, so it must be there.
  const ui = RN?.UIManager;
  try {
    if (ui?.getViewManagerConfig?.(NATIVE)) return true;
    ui?.getConstantsForViewManager?.(NATIVE); // lazily registered view managers load on request
    return !!ui?.getViewManagerConfig?.(NATIVE);
  } catch {
    return false;
  }
}

/** Everything WebView-like this Discord exposes, for the Diagnostics card ("webview probe"). */
function probe(): string {
  const g: any = globalThis as any;
  const ui = RN?.UIManager;
  const out: string[] = [];
  const t = (f: () => any) => { try { return f(); } catch (e) { return "err"; } };
  for (const n of [NATIVE, "RCTWebView", "AndroidWebView", "DCDWebView", "WebView"]) {
    const has = t(() => ui?.hasViewManagerConfig?.(n));
    const cfg = t(() => !!ui?.getViewManagerConfig?.(n));
    const fab = t(() => g.__nativeComponentRegistry__hasComponent?.(n));
    if (has || cfg === true || fab) out.push(`${n}[has=${has} cfg=${cfg} fabric=${fab}]`);
  }
  const web = (keys: any) => (Array.isArray(keys) ? keys : []).filter((k: any) => /web/i.test(String(k)));
  const names = [
    ...web(t(() => ui?.ViewManagerNames)),
    ...web(t(() => Object.keys(ui?.getConstants?.() ?? {}))),
    ...web(t(() => RN?.NativeModules?.UIManager?.ViewManagerNames)),
  ];
  if (names.length) out.push("view managers: " + Array.from(new Set(names)).join(","));
  const mods = web(t(() => Object.keys(RN?.NativeModules ?? {})));
  if (mods.length) out.push("native modules: " + mods.join(","));
  for (const m of ["RNCWebViewModule", "RNCWebView", "RNCWebViewUtils"]) {
    const tm = t(() => g.__turboModuleProxy?.(m));
    if (tm && tm !== "err") out.push("turbo " + m);
  }
  out.push(`arch: ${g.nativeFabricUIManager ? "fabric" : "paper"}${g.RN$Bridgeless ? " bridgeless" : ""}`);
  return out.join("; ");
}

/** The bare native view, registered with a guard so Discord can still register it later. */
function nativeWebView(report: string[]): any {
  if (!nativeViewExists()) {
    report.push("native " + NATIVE + ": no view config");
    return null;
  }
  const registry = findModuleWhere((o) => typeof o.register === "function" && typeof o.get === "function" && !!o.customDirectEventTypes);
  if (!registry) {
    report.push("native: view registry not found");
    return null;
  }
  let registered = false;
  try {
    registry.get(NATIVE);
    registered = true; // someone (Discord) already registered it: just use it
  } catch {}
  if (!registered) {
    if (!unguard) {
      try {
        // Discord registering the same name later must not throw.
        unguard = instead("register", registry, (args, orig) => (args[0] === NATIVE && ours ? args[0] : orig(...args)));
      } catch (e) {
        report.push("native: cannot guard registry (" + String((e as any)?.message ?? e).slice(0, 30) + ")");
        return null;
      }
    }
    try {
      if (typeof RN.requireNativeComponent !== "function") throw new Error("no requireNativeComponent");
      RN.requireNativeComponent(NATIVE);
      ours = true;
      registry.get(NATIVE); // build the view config now, so a failure cannot happen mid-render
    } catch (e) {
      report.push("native: register failed (" + String((e as any)?.message ?? e).slice(0, 40) + ")");
      return null;
    }
  }
  report.push("native " + NATIVE + ": " + (ours ? "registered by us" : "already registered"));
  return NATIVE; // a host component is just its name
}

function findWebView(): WebViewKind | null {
  if (found) return found;
  const report: string[] = [];
  let comp: any = null;
  try {
    comp = findExportedComponent("WebView") ?? findComponent("WebView") ?? null;
    if (comp) report.push("loaded modules: found");
  } catch {}
  if (!comp) comp = findWithLoaders("props", "WebView", report) ?? null;
  if (comp) found = { comp, native: false };
  else {
    const n = nativeWebView(report);
    if (n) found = { comp: n, native: true };
  }
  diag.installed["webview lookup"] = report.join("; ") || "nothing to ask";
  if (!found) diag.installed["webview probe"] = probe();
  diag.engine = found ? (found.native ? "native WebView" : "WebView component") + ", idle" : "no WebView available";
  return found;
}

function failAll(why: string): void {
  for (const j of jobs.values()) {
    clearTimeout(j.timer);
    j.reject(new Error(why));
  }
  jobs.clear();
}

function onPageMessage(e: any): void {
  let msg: any;
  try {
    msg = JSON.parse(e?.nativeEvent?.data ?? "");
  } catch {
    return;
  }
  if (msg?.caps) diag.engine = `${found?.native ? "native WebView" : "WebView component"} (${msg.caps.wasm ? "WebAssembly" : "no WebAssembly"}, ${msg.caps.subtle ? "WebCrypto" : "no WebCrypto"})`;
  const j = jobs.get(msg?.id);
  if (!j) return;
  jobs.delete(j.id);
  clearTimeout(j.timer);
  rerender?.();
  msg.ok ? j.resolve(msg.out) : j.reject(new Error(String(msg.err)));
}

export function engineReady(): boolean {
  return !!rerender && !!found;
}

/** Resolves true once a host with a WebView is mounted, false after `ms`. */
export function waitEngine(ms: number): Promise<boolean> {
  if (engineReady()) return Promise.resolve(true);
  if (!hosts.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(engineReady()), ms);
    hostWaiters.push((ok) => {
      clearTimeout(t);
      resolve(ok);
    });
  });
}

function pageHtml(job: unknown): string {
  const data = JSON.stringify(job).replace(/<\//g, "<\\/");
  const page = __ENGINE_PAGE__.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.__aegJob=${data}</script><script>${page}</script></body></html>`;
}

/** Runs one job in its own WebView. Rejects if there is no engine, it fails, or times out. */
export function call<T = any>(op: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<T> {
  if (!engineReady()) return Promise.reject(new Error("engine not ready"));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      rerender?.();
      reject(new Error("engine timeout"));
    }, timeoutMs);
    jobs.set(id, { id, html: pageHtml({ ...args, id, op }), resolve, reject, timer });
    rerender?.();
  });
}

const HIDDEN = { position: "absolute", width: 1, height: 1, opacity: 0, left: -10, top: -10 };

function jobView(j: Job): any {
  const kind = found!;
  const props: any = {
    key: "job" + j.id,
    style: { width: 1, height: 1, opacity: 0 },
    source: { html: j.html, baseUrl: "https://localhost/" }, // https origin: WebCrypto needs a secure context
    javaScriptEnabled: true,
    onMessage: onPageMessage,
  };
  if (kind.native) props.messagingEnabled = true;
  else {
    props.originWhitelist = ["*"];
    props.onError = () => j.reject(new Error("WebView failed to load"));
  }
  return React.createElement(kind.comp, props);
}

/** Invisible host for the job WebViews. Safe to mount anywhere, any number of times. */
export function EngineHost(): any {
  const [active, setActiveState] = React.useState(false);
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const me = (on: boolean) => setActiveState(on);
    hosts.push(me);
    if (hosts.length === 1) me(true);
    return () => {
      const i = hosts.indexOf(me);
      if (i >= 0) hosts.splice(i, 1);
      if (i === 0) {
        rerender = null;
        failAll("engine host closed");
        hosts[0]?.(true); // hand over to the next host
      }
    };
  }, []);
  React.useEffect(() => {
    if (!active) return;
    if (!findWebView()) {
      hostWaiters.splice(0).forEach((f) => f(false));
      return;
    }
    rerender = () => setTick((n: number) => n + 1);
    hostWaiters.splice(0).forEach((f) => f(true));
  }, [active]);
  if (!active || !found || !jobs.size) return null;
  return React.createElement(RN.View, { style: HIDDEN, pointerEvents: "none" }, ...Array.from(jobs.values(), jobView));
}

/**
 * Keeps an engine host mounted while chatting (for attachments) by rendering it next to the chat
 * input. Throws if the chat input is not found (the installer retries).
 */
export function mountChatHost(): () => void {
  const report: string[] = [];
  const ChatInput = findComponent("ChatInput") ?? findWithLoaders("name", "ChatInput", report);
  if (!ChatInput) throw new Error("chat input not found (" + (report.join("; ") || "no loader finders") + ")");
  const proto = ChatInput.prototype;
  if (!proto || typeof proto.render !== "function") throw new Error("chat input is not a class component");
  const un = instead("render", proto, (args, orig) => {
    const ret = orig(...args);
    try {
      return React.createElement(React.Fragment, null, ret, React.createElement(EngineHost, { key: "aegires-engine" }));
    } catch {
      return ret;
    }
  });
  return () => {
    un();
    stopEngine();
  };
}

export function stopEngine(): void {
  rerender = null;
  failAll("engine stopped");
  hostWaiters.splice(0).forEach((f) => f(false));
  // The registry guard stays: Discord may still register the native view after we did.
}
