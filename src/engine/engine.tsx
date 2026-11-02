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
import { eachExport, findComponent, findExportedComponent, findModuleWhere, findWithLoaders, instead } from "../patch.ts";
import { React, RN, comp } from "../rt.ts";
import { diag } from "../diag.ts";
import { base64Encode } from "../crypto/base64.ts";
import { utf8Encode } from "../crypto/utf8.ts";

declare const __ENGINE_PAGE__: string;

// Discord's WebView is a fork: the WebView lives in a native RNCWebViewContainer, keyed by a
// webViewKey (an RNCWebViewTarget shows it on screen; we never need to) and the RNCWebView native
// module manages instances by key. Plain RNCWebView is upstream react-native-webview.
const NATIVE_NAMES = ["RNCWebViewContainer", "RNCWebView"];
let NATIVE = NATIVE_NAMES[0];

type Job = { id: number; html: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: any; loadTimer?: any; loaded?: boolean; attempt?: number; ref?: any; tag?: number; nudged?: string };

/** A page that has not said a word after this long never loaded: turn the engine off. */
const LOAD_TIMEOUT_MS = 10000;
const MESSAGING_MODULE = "AegiresEngineMessaging";
// Ways to get the page's messages back, tried in order until a page reports:
//   0: the onMessage event (upstream Android without messagingModuleName)
//   1: a JS module the native side calls (messagingModuleName; also as "RNCWebViewMessagingModule")
const MODES = 2;
let mode = 0;

const safeDecode = (s: string) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/** Load events seen from the native WebView, newest last (Diagnostics: webview events). */
const seenEvents: string[] = [];
function noteEvent(label: string, ne: any): void {
  let extra = String(ne?.description ?? ne?.statusCode ?? (typeof ne?.progress === "number" ? Math.round(ne.progress * 100) + "%" : ""));
  // The page reports through navigations to https://localhost/__aeg?<info> (seen here as the URL).
  const url = typeof ne?.url === "string" ? ne.url : "";
  const at = url.indexOf("__aeg?");
  if (at >= 0) {
    if (/Error/.test(label)) return; // the same report again, failing to load (nothing serves it)
    extra = "REPORT " + safeDecode(url.slice(at + 6)).slice(0, 220);
  } else if (url && /Start|Finish/.test(label)) extra += " " + url.slice(0, 24);
  seenEvents.push(label + (extra.trim() ? ":" + extra.trim().slice(0, 180) : ""));
  if (seenEvents.length > 12) seenEvents.shift();
  diag.installed["webview events"] = `mode ${mode}: ` + seenEvents.join(", ");
}
/** comp: component or native view name; props: the native view's prop names; msg: message event prop. */
type WebViewKind = {
  comp: any;
  native: boolean;
  props?: Set<string> | null;
  msg?: string; // message event prop
  startLoad?: string; // "may I load this page?" event prop, if the view asks
  target?: { name: string; props: Set<string> } | null;
  events?: Record<string, string>; // top event name -> prop name
};

let found: WebViewKind | null = null;
let seq = 0;
const jobs = new Map<number, Job>();
const hosts: Array<(on: boolean) => void> = [];
let rerender: (() => void) | null = null;
let hostWaiters: Array<(ok: boolean) => void> = [];
let unguard: (() => void) | null = null;

/** The native view's config from UIManager (requireNativeComponent builds its view config from it). */
function nativeConfig(name: string): any {
  const ui = RN?.UIManager;
  try {
    const c = ui?.getViewManagerConfig?.(name);
    if (c) return c;
    ui?.getConstantsForViewManager?.(name); // lazily registered view managers load on request
    const again = ui?.getViewManagerConfig?.(name);
    if (again) return again;
  } catch {}
  // Bridgeless: getViewManagerConfig knows nothing about Fabric-only views, but the UIManager
  // constants object (keyed by view name: APNGStickerView, DCDChatList, ...) still has them.
  const hasCfg = (o: any) => !!o?.[name]?.NativeProps;
  try {
    if (hasCfg(ui)) return ui[name];
  } catch {}
  return findModuleWhere(hasCfg)?.[name] ?? null;
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
  // Fabric/bridgeless: the native component registry is the only reliable answer.
  const hc = g.__nativeComponentRegistry__hasComponent;
  out.push(`hasComponent ${typeof hc}` + (typeof hc === "function" ? ": " + ["RNCWebView", "RCTWebView", "WebView", "AndroidWebView"].map((n) => `${n}=${t(() => hc(n))}`).join(",") : ""));
  for (const m of ["RNCWebViewModule", "RNCWebViewUtils", "RNCWebView"]) {
    const nm = t(() => g.nativeModuleProxy?.[m]);
    if (nm && nm !== "err") out.push("module " + m);
  }
  // Native component names Discord's loaded JS knows (host components are plain name strings),
  // and exported names that mention web pages.
  const comps = new Set<string>();
  const keys = new Set<string>();
  const WEBBY = /web|captcha|activit|embed|browser|iframe/i;
  eachExport((o) => {
    if (typeof o === "string") {
      if (/^[A-Z][A-Za-z0-9]{3,40}$/.test(o) && WEBBY.test(o)) comps.add(o);
      return;
    }
    if (typeof o !== "object" && typeof o !== "function") return;
    let ks: string[] = [];
    try { ks = Object.keys(o).slice(0, 200); } catch {}
    for (const k of ks) {
      if (!WEBBY.test(k)) continue;
      keys.add(k);
      try {
        const v = o[k];
        if (typeof v === "string" && /^[A-Z][A-Za-z0-9]{3,40}$/.test(v)) comps.add(v);
      } catch {}
    }
  });
  if (comps.size) out.push("component names: " + Array.from(comps).slice(0, 15).join(","));
  // Discord's own WebView (RNCWebViewContainer / RNCWebViewTarget): describe that module's API.
  const desc = (v: any): string => {
    if (typeof v === "string") return `"${v.slice(0, 40)}"`;
    if (typeof v === "function") return `fn${v.length}${v.name ? ":" + v.name : ""}${v.displayName ? ":" + v.displayName : ""}${v.prototype?.render ? ":class" : ""}`;
    if (v && typeof v === "object") return v.$$typeof ? `elem(${String(v.$$typeof.toString?.() ?? "").slice(7, 20)}${v.render ? ",render" : ""}${typeof v.type === "string" ? ",type=" + v.type : ""})` : `obj{${t(() => Object.keys(v).slice(0, 8).join(","))}}`;
    return typeof v;
  };
  const seen = new Set<any>();
  eachExport((o) => {
    if (!o || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) return;
    let ks: string[] = [];
    try { ks = Object.keys(o); } catch {}
    if (!ks.some((k) => /^RNCWebView/.test(k))) return;
    seen.add(o);
    out.push("WEBVIEW MODULE {" + ks.slice(0, 30).map((k) => `${k}=${t(() => desc(o[k]))}`).join(", ") + "}");
  });
  const nm = t(() => g.nativeModuleProxy?.RNCWebView);
  if (nm && nm !== "err") {
    const own = t(() => Object.keys(nm).join(",")) || "";
    const forIn: string[] = [];
    try { for (const k in nm) forIn.push(k); } catch {}
    const guesses = ["postMessage", "injectJavaScript", "createWebView", "loadUrl", "evaluateJavascript", "reload", "goBack", "stopLoading", "isFileUploadSupported", "shouldStartLoadWithLockIdentifier", "clearCache", "requestFocus", "getConstants", "addListener", "removeListeners", "messageResult", "onMessage"]
      .filter((k) => t(() => typeof nm[k]) === "function");
    out.push(`NATIVE RNCWebView keys[${own}] forin[${forIn.slice(0, 30).join(",")}] fns[${guesses.join(",")}] consts[${t(() => JSON.stringify(nm.getConstants?.() ?? null)?.slice(0, 200))}]`);
  }
  for (const n of ["RNCWebViewContainer", "RNCWebViewTarget", "DCDWebView", "RNCWebViewComponent"]) {
    const r = t(() => hc?.(n));
    if (r) out.push(`hasComponent ${n}=${r}`);
  }
  if (keys.size) out.push("exports: " + Array.from(keys).slice(0, 25).join(","));
  out.push(`arch: ${g.nativeFabricUIManager ? "fabric" : "paper"}${g.RN$Bridgeless ? " bridgeless" : ""}`);
  return out.join("; ");
}

const ourNames = new Set<string>(); // native view names we registered (Discord re-registering them is ignored)
let registryMod: any = null;

/** Registers a native view's config (from UIManager constants) with React Native; true if usable. */
function registerView(name: string, cfg: any, report: string[]): boolean {
  const registry = (registryMod ??= findModuleWhere((o) => typeof o.register === "function" && typeof o.get === "function" && !!o.customDirectEventTypes));
  if (!registry) {
    report.push("native: view registry not found");
    return false;
  }
  try {
    registry.get(name);
    return true; // someone (Discord) already registered it: just use it
  } catch {}
  if (!unguard) {
    try {
      // Discord registering the same name later must not throw.
      unguard = instead("register", registry, (args, orig) => (ourNames.has(args[0]) ? args[0] : orig(...args)));
    } catch (e) {
      report.push("native: cannot guard registry (" + String((e as any)?.message ?? e).slice(0, 30) + ")");
      return false;
    }
  }
  // View config built like requireNativeComponent does: every View attribute (style, layout)
  // plus the view's own props, and its events.
  const viewConfig = () => {
    let base: any = {};
    try { base = registry.get("RCTView")?.validAttributes ?? {}; } catch {}
    const validAttributes: any = { ...base };
    for (const k of Object.keys(cfg?.NativeProps ?? {})) validAttributes[k] = true;
    return { uiViewClassName: name, validAttributes, directEventTypes: cfg?.directEventTypes ?? {}, bubblingEventTypes: cfg?.bubblingEventTypes ?? {} };
  };
  try {
    registry.register(name, viewConfig);
    ourNames.add(name);
    registry.get(name); // build the view config now, so a failure cannot happen mid-render
    return true;
  } catch (e) {
    report.push(`native ${name}: register failed (${String((e as any)?.message ?? e).slice(0, 40)})`);
    return false;
  }
}

const describeCfg = (name: string, cfg: any) =>
  `${name} props[${Object.keys(cfg?.NativeProps ?? {}).join(",") || "?"}] events[${Object.keys({ ...(cfg?.directEventTypes ?? {}), ...(cfg?.bubblingEventTypes ?? {}) }).join(",")}] commands[${Object.keys(cfg?.Commands ?? {}).join(",")}]`;

/** The bare native view (Discord's container, or upstream RNCWebView), registered with a guard. */
function nativeWebView(report: string[]): WebViewKind | null {
  const name = NATIVE_NAMES.find((n) => nativeConfig(n));
  if (!name) {
    report.push("native " + NATIVE_NAMES.join("/") + ": no view config");
    return null;
  }
  NATIVE = name;
  const cfg = nativeConfig(name);
  const propNames = cfg?.NativeProps && typeof cfg.NativeProps === "object" ? new Set<string>(Object.keys(cfg.NativeProps)) : null;
  const events: any = { ...(cfg?.directEventTypes ?? {}), ...(cfg?.bubblingEventTypes ?? {}) };
  const reg = (e: any) => e?.registrationName ?? e?.phasedRegistrationNames?.bubbled;
  const msg = reg(events.topMessage) ?? "onMessage";
  const startLoad = reg(events.topShouldStartLoadWithRequest);
  // Discord's container is shown on screen by an RNCWebViewTarget with the same key; render a
  // hidden one too in case the container only starts its WebView once it is targeted.
  const tcfg = name === "RNCWebViewContainer" ? nativeConfig("RNCWebViewTarget") : null;
  diag.installed["webview config"] = describeCfg(name, cfg) + (tcfg ? "; " + describeCfg("RNCWebViewTarget", tcfg) : "");
  if (!registerView(name, cfg, report)) return null;
  const target = tcfg && registerView("RNCWebViewTarget", tcfg, report) ? { name: "RNCWebViewTarget", props: new Set<string>(Object.keys(tcfg.NativeProps ?? {})) } : null;
  report.push(`native ${name}: ready` + (target ? " (+ target)" : ""));
  const evProps: Record<string, string> = {};
  for (const k of Object.keys(events)) if (reg(events[k])) evProps[k] = reg(events[k]);
  return { comp: name, native: true, props: propNames, msg, startLoad, target, events: evProps }; // a host component is just its name
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
  else found = nativeWebView(report);
  diag.installed["webview lookup"] = report.join("; ") || "nothing to ask";
  if (!found) diag.installed["webview probe"] = probe();
  diag.engine = found ? (found.native ? "native WebView" : "WebView component") + ", idle" : "no WebView available";
  return found;
}

function failAll(why: string): void {
  for (const j of jobs.values()) {
    clearTimeout(j.timer);
    clearTimeout(j.loadTimer);
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
  if (msg?.probe) {
    noteEvent("message from " + msg.probe, null);
    return;
  }
  if (msg?.caps) {
    diag.engine = `${found?.native ? "native WebView" : "WebView component"} (${msg.caps.wasm ? "WebAssembly" : "no WebAssembly"}, ${msg.caps.subtle ? "WebCrypto" : "no WebCrypto"})`;
    const lj = jobs.get(msg.job);
    if (lj) lj.loaded = true;
    return;
  }
  const j = jobs.get(msg?.id);
  if (!j) return;
  finish(j);
  msg.ok ? j.resolve(msg.out) : j.reject(new Error(String(msg.err)));
}

const keyOf = (j: Job) => `aegires-engine-${j.id}-${j.attempt ?? 0}`;

/** Removes the job's WebView and frees the native instance (Discord's fork keeps them by key). */
function finish(j: Job): void {
  jobs.delete(j.id);
  clearTimeout(j.timer);
  clearTimeout(j.loadTimer);
  rerender?.();
  if (found?.native && found.props?.has("webViewKey")) {
    setTimeout(() => {
      try { (globalThis as any).nativeModuleProxy?.RNCWebView?.releaseWebView?.(keyOf(j)); } catch {}
    }, 500);
  }
}

let broken = ""; // set when rendering the WebView crashed: the engine stays off until reload

export function engineReady(): boolean {
  return !!rerender && !!found && !broken;
}

const typeName = (c: any) => (typeof c === "string" ? `"${c}"` : typeof c);

/** Keeps a crash in the engine's views away from the screen that hosts it. */
const Guard: any =
  typeof React.Component === "function"
    ? class extends React.Component<any, { failed: boolean }> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        componentDidCatch(error: any) {
          broken = String(error?.message ?? error).slice(0, 120);
          diag.engine = `WebView crashed (view ${typeName(RN?.View)}, webview ${typeName(found?.comp)}): ${broken}`;
          failAll("WebView crashed");
        }
        render() {
          return this.state.failed ? null : this.props.children;
        }
      }
    : null;

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
      const j = jobs.get(id);
      if (j) finish(j);
      reject(new Error("engine timeout"));
    }, timeoutMs);
    // Until the engine has worked once, the page also reports what it sees (see page.ts).
    const job: Job = { id, html: pageHtml({ ...args, id, op, report: diag.engineJobs === 0 }), resolve, reject, timer };
    const armLoadTimer = () => (job.loadTimer = setTimeout(() => {
      if (job.loaded || !jobs.has(id)) return;
      if (found?.native && mode + 1 < MODES) {
        // Try the next way of receiving messages: re-render the job under a fresh key.
        mode++;
        noteEvent("retry", null);
        job.attempt = (job.attempt ?? 0) + 1;
        job.nudged = undefined;
        job.ref = undefined;
        rerender?.();
        armLoadTimer();
        armNudge();
        return;
      }
      broken = `page never loaded in ${LOAD_TIMEOUT_MS / 1000} s`;
      diag.engine = `${found?.native ? "native WebView" : "WebView component"}: ${broken} (sent ${diag.installed["webview sent"] ?? "?"})`;
      failAll(broken);
      rerender?.();
    }, LOAD_TIMEOUT_MS));
    armLoadTimer();
    // No layout event (not mounted?) -> still try the commands after 3 s.
    const armNudge = () => setTimeout(() => {
      if (job.loaded || job.nudged || !jobs.has(id)) return;
      job.nudged = "timer";
      noteEvent("no layout" + (job.ref ? " (have ref)" : " (no ref)"), null);
      nudge(job, 0);
    }, 3000);
    jobs.set(id, job);
    armNudge();
    rerender?.();
  });
}

const HIDDEN = { position: "absolute", width: 1, height: 1, opacity: 0, left: -10, top: -10 };

let rendererMod: any;

// Injected into the engine page: reports what the page sees (bridge object, origin, globals) by
// navigating to https://localhost/__aeg?<info>, which reaches us as the LoadingStart event's URL.
const REPORT_JS = `(function(){var go=function(i){location.replace('https://localhost/__aeg?'+encodeURIComponent(i))};try{var w=window,r=w.ReactNativeWebView;var ks=Object.getOwnPropertyNames(w).filter(function(k){return /webview|native|bridge|android|discord|rnc|post/i.test(k)}).slice(0,12).join('|');
var info='inject: rnwv='+(typeof r)+'/'+(r&&typeof r.postMessage)+' origin='+location.origin+' secure='+w.isSecureContext+' wasm='+(typeof WebAssembly)+' aeg='+(typeof w.__aegJob)+' keys='+ks;
try{r&&r.postMessage(JSON.stringify({probe:'cmd inject'}))}catch(e){info+=' postErr='+e}
setTimeout(function(){go(info)},300)}catch(e){go('inject err='+e)}})();true;`;

/** Sends a command (loadUrl, injectJavaScript, ...) to the job's native view. */
function command(j: Job, name: string, args: any[]): string {
  const g: any = globalThis as any;
  rendererMod ??= findModuleWhere((o) => typeof o.dispatchCommand === "function" && typeof o.findNodeHandle === "function") ?? null;
  const tries: Array<[string, () => void]> = [
    ["renderer", () => rendererMod.dispatchCommand(j.ref, name, args)],
    ["fabric", () => g.nativeFabricUIManager.dispatchCommand(j.ref?.__internalInstanceHandle?.stateNode?.node ?? j.ref?.node, name, args)],
    ["uimanager", () => RN.UIManager.dispatchViewManagerCommand(j.tag ?? rendererMod?.findNodeHandle?.(j.ref), name, args)],
  ];
  const out: string[] = [];
  for (const [label, f] of tries) {
    try {
      f();
      return label;
    } catch (e) {
      out.push(label + " " + String((e as any)?.message ?? e).slice(0, 30));
    }
  }
  return "failed (" + out.join("; ") + ")";
}

/**
 * Discord's container may only load what it is told to with commands. If the page has not spoken
 * yet: check the WebView exists (native inject by key), then inject the page, then load it as a
 * data: URL (no WebCrypto there - opaque origin - but WebAssembly and the JIT still work).
 */
function nudge(j: Job, step: number): void {
  if (j.loaded || !jobs.has(j.id) || !found?.native) return;
  const g: any = globalThis as any;
  const key = keyOf(j);
  if (step === 0) {
    try {
      const r = g.nativeModuleProxy?.RNCWebView?.injectJavaScriptWithWebViewKey?.(key, "window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({probe:'native inject'}));true;");
      noteEvent("nativeInject " + (r && typeof r.then === "function" ? "promise" : typeof r), null);
      if (r && typeof r.then === "function") r.then((v: any) => noteEvent("nativeInject ok " + String(v).slice(0, 20), null), (e: any) => noteEvent("nativeInject rejected " + String(e?.message ?? e).slice(0, 40), null));
    } catch (e) {
      noteEvent("nativeInject threw " + String((e as any)?.message ?? e).slice(0, 40), null);
    }
    noteEvent("cmd injectJavaScript " + command(j, "injectJavaScript", [REPORT_JS]), null);
    setTimeout(() => nudge(j, 1), 2500);
  } else if (step === 1) {
    const url = "data:text/html;base64," + base64Encode(utf8Encode(j.html));
    noteEvent("cmd loadUrl " + command(j, "loadUrl", [url]), null);
  }
}

function jobView(j: Job): any {
  const kind = found!;
  const source = { html: j.html, baseUrl: "https://localhost/" }; // https origin: WebCrypto needs a secure context
  const props: any = { key: keyOf(j), style: { width: 1, height: 1, opacity: 0 } };
  if (kind.native) {
    // Only props the native view declares (upstream v13 calls the source "newSource" on Fabric).
    const has = (k: string) => !kind.props || kind.props.has(k);
    if (has("source")) props.source = source;
    if (has("newSource")) props.newSource = source;
    if (has("messagingEnabled")) props.messagingEnabled = true;
    if (has("javaScriptEnabled")) props.javaScriptEnabled = true;
    if (has("webViewKey")) props.webViewKey = keyOf(j);
    // Upstream Android can deliver messages through a named JS module instead of the event.
    if (mode === 1 && kind.props?.has("messagingModuleName") && registerMessaging()) props.messagingModuleName = MESSAGING_MODULE;
    for (const [top, prop] of Object.entries(kind.events ?? {})) {
      if (/^top(Loading|HttpError|RenderProcessGone)/.test(top)) props[prop] = (e: any) => noteEvent(top.slice(3), e?.nativeEvent);
    }
    props.ref = (r: any) => {
      if (r) j.ref = r;
    };
    props.onLayout = (e: any) => {
      j.tag = e?.nativeEvent?.target ?? j.tag;
      if (j.nudged) return;
      j.nudged = "yes";
      noteEvent(`layout ${Math.round(e?.nativeEvent?.layout?.width ?? -1)}x${Math.round(e?.nativeEvent?.layout?.height ?? -1)}`, null);
      setTimeout(() => nudge(j, 0), 2000);
    };
    props[kind.msg ?? "onMessage"] = onPageMessage;
    diag.installed["webview sent"] = Object.keys(props).filter((k) => k !== "key" && k !== "style").join(",");
  } else {
    Object.assign(props, { source, javaScriptEnabled: true, originWhitelist: ["*"], onMessage: onPageMessage });
    props.onError = () => j.reject(new Error("WebView failed to load"));
  }
  const view = React.createElement(kind.comp, props);
  const t = kind.target;
  if (!t || !t.props.has("webViewKey") || !props.webViewKey) return view;
  const target = React.createElement(t.name, { key: "target-" + props.webViewKey, webViewKey: props.webViewKey, style: { width: 1, height: 1, opacity: 0 } });
  return [view, target];
}

let messagingRegistered = false;

/** Registers MESSAGING_MODULE as a JS module the native WebView can call (onMessage, load approval). */
function registerMessaging(): boolean {
  if (messagingRegistered) return true;
  const g: any = globalThis as any;
  const approve = (e: any) => {
    const ne = e?.nativeEvent ?? e;
    try { g.nativeModuleProxy?.RNCWebView?.onShouldStartLoadWithRequestCallback?.(true, ne?.lockIdentifier); } catch {}
  };
  const mod = {
    onMessage: (e: any) => {
      noteEvent("module message", null);
      onPageMessage(e?.nativeEvent ? e : { nativeEvent: e });
    },
    onShouldStartLoadWithRequest: approve,
  };
  // Java calls a JS module by its interface name (RNCWebViewMessagingModule) or by the name we
  // passed; register both. Discord's own WebView JS is not loaded (or it would have been found);
  // if it loads later its registration replaces ours, which only affects our jobs.
  for (const name of [MESSAGING_MODULE, "RNCWebViewMessagingModule"]) {
    try {
      if (typeof g.RN$registerCallableModule === "function") {
        g.RN$registerCallableModule(name, () => mod); // bridgeless
        messagingRegistered = true;
      }
    } catch {}
    try {
      const bridge = findModuleWhere((o) => typeof o.registerCallableModule === "function" && typeof o.callFunctionReturnFlushedQueue === "function");
      if (bridge) {
        bridge.registerCallableModule(name, mod);
        messagingRegistered = true;
      }
    } catch {}
  }
  return messagingRegistered;
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
  if (!active || !found || broken || !jobs.size) return null;
  const View = RN?.View ?? comp("View");
  if (!Guard || !View || (typeof found.comp !== "string" && typeof found.comp !== "function" && typeof found.comp !== "object") || !found.comp) {
    broken = `cannot render (guard ${typeof Guard}, view ${typeName(View)}, webview ${typeName(found.comp)})`;
    diag.engine = "WebView " + broken;
    failAll(broken);
    return null;
  }
  return React.createElement(Guard, null, React.createElement(View, { style: HIDDEN, pointerEvents: "none" }, ...Array.from(jobs.values(), jobView)));
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
    if (!React.Fragment || broken) return ret;
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
