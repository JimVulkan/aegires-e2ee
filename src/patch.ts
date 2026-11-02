// Own module finder + patcher. In some Kettu builds the helpers from @vendetta/metro and
// @vendetta/patcher throw ("Object is not a function") or return objects without the
// functions we need, so we do not depend on them: we scan Discord's Metro module registry
// directly (falling back to Vendetta's helper only as a first try) and patch by replacing
// the property on the module object.
import { diag } from "./diag.ts";

declare const vendetta: any;

const log = (...a: any[]) => console.log("[aegires-e2ee]", ...a);

function registry(): any {
  const g: any = globalThis as any;
  const tries: Array<() => any> = [() => vendetta?.metro?.modules, () => g.modules, () => g.__r?.getModules?.()];
  for (const t of tries) {
    try {
      const m = t();
      if (m && typeof m === "object") return m;
    } catch {}
  }
  return null;
}

/** First already-initialised module export (or its .default) that satisfies pred. */
function scan(pred: (o: any) => boolean): any {
  const reg = registry();
  if (!reg) return undefined;
  let ids: string[];
  try { ids = Object.keys(reg); } catch { return undefined; }
  for (const id of ids) {
    let ex: any;
    try {
      const m = reg[id];
      if (!m || !m.isInitialized) continue;
      ex = m.publicModule?.exports;
    } catch { continue; }
    if (!ex) continue;
    for (let i = 0; i < 2; i++) {
      try {
        const c = i === 0 ? ex : ex.default;
        if (c && (typeof c === "object" || typeof c === "function") && pred(c)) return c;
      } catch {}
    }
  }
  return undefined;
}

const isFn = (o: any, n: string) => typeof o[n] === "function";

const isComponent = (c: any) => typeof c === "function" || (!!c && typeof c === "object" && !!c.$$typeof);

/**
 * Calls cb once with the first module export (or .default) matching pred: right away if it is
 * loaded, else the moment Discord initialises it (we wrap the factories of modules not loaded
 * yet; Metro reads module.factory when it first requires a module). Returns an undo.
 */
export function whenModule(pred: (o: any) => boolean, cb: (o: any) => void): () => void {
  const now = scan(pred);
  if (now) {
    cb(now);
    return () => {};
  }
  const reg = registry();
  if (!reg) throw new Error("no module registry");
  const wrapped: Array<[any, any, any]> = []; // [entry, original factory, our wrapper]
  let done = false;
  const restore = () => {
    done = true;
    for (const [m, orig, ours] of wrapped.splice(0)) {
      try { if (m.factory === ours) m.factory = orig; } catch {}
    }
  };
  for (const id of Object.keys(reg)) {
    try {
      const m = reg[id];
      if (!m || m.isInitialized || typeof m.factory !== "function") continue;
      const orig = m.factory;
      const ours = function (this: any, ...args: any[]) {
        const r = orig.apply(this, args);
        if (!done) {
          try {
            const ex = m.publicModule?.exports;
            const hit = ex && (pred(ex) ? ex : ex.default && pred(ex.default) ? ex.default : null);
            if (hit) {
              restore();
              cb(hit);
            }
          } catch (e) {
            log("whenModule callback failed", e);
          }
        }
        return r;
      };
      m.factory = ours;
      wrapped.push([m, orig, ours]);
    } catch {}
  }
  return restore;
}

/** Calls fn(export) for every loaded module export and its .default (for probes). */
export function eachExport(fn: (o: any) => void): void {
  const reg = registry();
  if (!reg) return;
  for (const id of Object.keys(reg)) {
    try {
      const m = reg[id];
      if (!m?.isInitialized) continue;
      const ex = m.publicModule?.exports;
      if (ex == null) continue;
      fn(ex);
      if (typeof ex === "object" && ex.default != null && ex.default !== ex) fn(ex.default);
    } catch {}
  }
}

/** First loaded module export (or its .default) that satisfies pred. */
export function findModuleWhere(pred: (o: any) => boolean): any {
  return scan(pred);
}

/** Class or function component whose name / displayName is `name`. */
export function findComponent(name: string): any {
  return scan((o) => typeof o === "function" && (o.displayName === name || o.name === name));
}

/** Component exported under property `name` (e.g. react-native-webview's { WebView }). */
export function findExportedComponent(name: string): any {
  return scan((o) => isComponent(o[name]))?.[name];
}

/**
 * Asks the loader's own finders (Kettu/Bunny keep a cache of which module exports what, so they
 * can also load modules Discord has not loaded yet). Each attempt is guarded; `report` collects
 * what every loader said, for the Diagnostics card.
 */
export function findWithLoaders(how: "props" | "name", name: string, report: string[]): any {
  const g: any = globalThis as any;
  const loaders: Array<[string, () => any]> = [["vendetta", () => g.vendetta?.metro], ["bunny", () => g.bunny?.metro], ["kettu", () => g.kettu?.metro]];
  for (const [label, get] of loaders) {
    let api: any;
    try { api = get(); } catch {}
    if (!api) continue;
    const fn = how === "props" ? api.findByProps : api.findByName;
    if (typeof fn !== "function") { report.push(`${label}: no find${how === "props" ? "ByProps" : "ByName"}`); continue; }
    try {
      const r = how === "props" ? fn(name)?.[name] : fn(name, true) ?? fn(name);
      if (isComponent(r)) { report.push(`${label}: found`); return r; }
      report.push(`${label}: not found`);
    } catch (e) {
      report.push(`${label}: threw ${String((e as any)?.message ?? e).slice(0, 40)}`);
    }
  }
  return undefined;
}

/** Module whose given properties are all functions. */
export function findFns(...names: string[]): any {
  const pred = (o: any) => names.every((n) => isFn(o, n));
  try {
    const r = vendetta?.metro?.findByProps?.(...names);
    if (r && pred(r)) return r;
  } catch {}
  return scan(pred);
}

export function findFlux(): any {
  const pred = (o: any) => isFn(o, "dispatch") && isFn(o, "subscribe") && isFn(o, "unsubscribe");
  try {
    const c = vendetta?.metro?.common?.FluxDispatcher;
    if (c && isFn(c, "dispatch")) return c;
  } catch {}
  return findFns("dispatch", "subscribe", "unsubscribe") ?? scan(pred);
}

export function selectedChannelId(): string {
  try {
    const s = vendetta?.metro?.findByStoreName?.("SelectedChannelStore");
    const id = s?.getChannelId?.();
    if (id) return String(id);
  } catch {}
  try {
    const s = scan((o) => isFn(o, "getChannelId") && isFn(o, "getVoiceChannelId") && isFn(o, "getLastSelectedChannelId"));
    const id = s?.getChannelId?.();
    if (id) return String(id);
  } catch {}
  return "";
}

type Unpatch = () => void;

function install(name: string, obj: any, make: (orig: (...a: any[]) => any) => (...a: any[]) => any): Unpatch {
  if (!obj || typeof obj[name] !== "function") throw new Error(`${name} is not a function on the target`);
  const orig = obj[name];
  const inner = make(orig);
  let active = true;
  const wrapper = function (this: any, ...args: any[]) {
    return active ? inner.apply(this, args) : orig.apply(this, args);
  };
  try {
    Object.defineProperty(obj, name, { value: wrapper, writable: true, configurable: true, enumerable: true });
  } catch {
    try { obj[name] = wrapper; } catch {}
  }
  if (obj[name] !== wrapper) throw new Error(`could not replace ${name} (read-only)`);
  return () => {
    active = false; // even if someone wrapped us later, we become a pass-through
    try {
      if (obj[name] === wrapper) Object.defineProperty(obj, name, { value: orig, writable: true, configurable: true, enumerable: true });
    } catch {}
  };
}

/** Run cb(args) before the real function; cb may return a new args array. */
export function before(name: string, obj: any, cb: (args: any[]) => any[] | void): Unpatch {
  return install(name, obj, (orig) =>
    function (this: any, ...args: any[]) {
      try {
        const r = cb(args);
        if (Array.isArray(r)) args = r;
      } catch (e) {
        log("before-hook error in " + name, e);
      }
      return orig.apply(this, args);
    },
  );
}

/** Replace the function; cb gets (args, originalFunction). */
export function instead(name: string, obj: any, cb: (args: any[], orig: (...a: any[]) => any) => any): Unpatch {
  return install(name, obj, (orig) =>
    function (this: any, ...args: any[]) {
      return cb(args, (...a: any[]) => orig.apply(this, a));
    },
  );
}

/** One-line description of the runtime, for the Diagnostics card. */
export function envSummary(): string {
  const keys = (o: any) => { try { return o ? Object.keys(o).slice(0, 14).join(",") : String(o); } catch { return "?"; } };
  const reg = registry();
  let n = -1, init = -1;
  try {
    if (reg) {
      const ids = Object.keys(reg);
      n = ids.length;
      init = ids.reduce((c, id) => c + (reg[id]?.isInitialized ? 1 : 0), 0);
    }
  } catch {}
  return `metro[${keys(vendetta?.metro)}] patcher[${keys(vendetta?.patcher)}] registry=${reg ? n + " mods, " + init + " init" : "NONE"}`;
}

/** Names of exported functions containing "upload" in initialised modules (for Diagnostics). */
export function uploadCandidates(): string {
  const names = new Set<string>();
  scan((o) => {
    try {
      for (const k of Object.keys(o)) {
        if (/upload/i.test(k) && typeof o[k] === "function") names.add(k);
      }
    } catch {}
    return names.size >= 20;
  });
  return names.size ? Array.from(names).join(",") : "none";
}

export function noteFound(label: string, found: any): void {
  diag.installed["find " + label] = found ? "found" : "NOT FOUND";
}
