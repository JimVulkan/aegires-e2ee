// Plugin side of the WebView crypto engine (the page is src/engine/page.ts).
//
// Hermes runs plugin code in an interpreter with no WebAssembly, but Discord ships a WebView, which
// runs Chrome's engine (JIT, WebAssembly, WebCrypto with hardware AES). A 1x1 invisible WebView is
// mounted by <EngineHost/> (in the plugin settings, and in the chat input when it can be found);
// the first mounted host runs the engine, the others stand by. Every caller must still work
// without it: `call` rejects when no engine is ready, and callers fall back to the JS code.
import { findByName, findByProps } from "@vendetta/metro";
import { instead } from "../patch.ts";
import { React, RN } from "../rt.ts";
import { diag } from "../diag.ts";

declare const __ENGINE_PAGE__: string;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: any };

let webViewComp: any;
let send: ((s: string) => void) | null = null;
let ready = false;
let readyWaiters: Array<(ok: boolean) => void> = [];
let seq = 0;
const pending = new Map<number, Pending>();
const hosts: Array<(on: boolean) => void> = [];

function WebViewComponent(): any {
  if (webViewComp !== undefined) return webViewComp;
  const tries: Array<() => any> = [
    () => findByProps("WebView")?.WebView,
    () => findByName("WebView", false)?.default,
    () => findByName("WebView"),
  ];
  webViewComp = null;
  for (const t of tries) {
    try {
      const c = t();
      if (c && (typeof c === "function" || typeof c === "object")) return (webViewComp = c);
    } catch {}
  }
  diag.engine = "no WebView component in this Discord";
  return null;
}

function failAll(why: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(why));
    pending.delete(id);
  }
}

function setActive(on: boolean, post?: (s: string) => void): void {
  send = on ? post ?? null : null;
  if (!on) {
    ready = false;
    failAll("engine unmounted");
  }
}

function onPageMessage(e: any): void {
  let msg: any;
  try {
    msg = JSON.parse(e?.nativeEvent?.data ?? "");
  } catch {
    return;
  }
  if (msg?.ready) {
    ready = true;
    diag.engine = `ready (${msg.caps?.wasm ? "WebAssembly" : "no WebAssembly"}, ${msg.caps?.subtle ? "WebCrypto" : "no WebCrypto"})`;
    readyWaiters.splice(0).forEach((f) => f(true));
    return;
  }
  const p = pending.get(msg?.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  msg.ok ? p.resolve(msg.out) : p.reject(new Error(String(msg.err)));
}

export function engineReady(): boolean {
  return ready && !!send;
}

/** Resolves true once the engine is ready, false after `ms` (or right away if no host exists). */
export function waitEngine(ms: number): Promise<boolean> {
  if (engineReady()) return Promise.resolve(true);
  if (!hosts.length || !WebViewComponent()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(engineReady()), ms);
    readyWaiters.push((ok) => {
      clearTimeout(t);
      resolve(ok);
    });
  });
}

/** Sends one request to the engine. Rejects if it is not ready, fails, or times out. */
export function call<T = any>(op: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<T> {
  if (!engineReady()) return Promise.reject(new Error("engine not ready"));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("engine timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      send!(JSON.stringify({ ...args, id, op }));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e as Error);
    }
  });
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${__ENGINE_PAGE__.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
const HIDDEN = { position: "absolute", width: 1, height: 1, opacity: 0, left: -10, top: -10 };

/** Invisible host for the engine WebView. Safe to mount anywhere, any number of times. */
export function EngineHost(): any {
  const [active, setActiveState] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const me = (on: boolean) => setActiveState(on);
    hosts.push(me);
    if (hosts.length === 1) me(true);
    return () => {
      const i = hosts.indexOf(me);
      if (i >= 0) hosts.splice(i, 1);
      if (i === 0) {
        setActive(false);
        hosts[0]?.(true); // hand over to the next host
      }
    };
  }, []);
  React.useEffect(() => {
    if (active) {
      diag.engine = "loading";
      setActive(true, (s) => (ref.current as any)?.postMessage(s));
    }
  }, [active]);
  const WebView = active ? WebViewComponent() : null;
  if (!WebView) return null;
  return React.createElement(
    RN.View,
    { style: HIDDEN, pointerEvents: "none" },
    React.createElement(WebView, {
      ref,
      style: { width: 1, height: 1, opacity: 0 },
      source: { html: HTML, baseUrl: "https://localhost/" }, // https origin: WebCrypto needs a secure context
      originWhitelist: ["*"],
      javaScriptEnabled: true,
      onMessage: onPageMessage,
      onError: () => {
        diag.engine = "WebView failed to load";
        setActive(false);
      },
      onContentProcessDidTerminate: () => setActive(false),
      onRenderProcessGone: () => setActive(false),
    }),
  );
}

/**
 * Keeps an engine mounted while chatting (for attachments) by rendering a host next to the chat
 * input. Throws if the chat input is not loaded yet (the installer retries).
 */
export function mountChatHost(): () => void {
  const proto = findByName("ChatInput")?.prototype;
  if (!proto || typeof proto.render !== "function") throw new Error("chat input not found yet");
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
  setActive(false);
  readyWaiters.splice(0).forEach((f) => f(false));
}
