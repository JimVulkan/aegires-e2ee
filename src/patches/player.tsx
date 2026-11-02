// Decrypted videos live in Discord's cache dir as file:// URIs, but Discord's video player only
// streams through Cronet (http/https), so they never play. When the media viewer is opened on
// one of them we show our own full-screen player instead: a WebView (Chrome's <video>) reading
// the file next to its page.
import { React, RN, comp } from "../rt.ts";
import { findModuleWhere, instead, whenModule } from "../patch.ts";
import { diag } from "../diag.ts";
import { releaseViewer, viewerWebView } from "../engine/engine.tsx";

const VIDEO = /\.(mp4|m4v|mov|webm|mkv|3gp)$/i;
const ALERT_KEY = "aegires-video-player";

// Also to logcat (ReactNativeJS), so a connected phone can be debugged with adb.
function note(msg: string): void {
  diag.installed["video player"] = msg;
  console.log("[aegires-e2ee] video player:", msg);
}

const shape = (v: any, d = 0): string => {
  if (v == null || typeof v !== "object") return typeof v === "string" ? JSON.stringify(v.slice(0, 80)) : String(v);
  if (d > 2) return Array.isArray(v) ? `[${v.length}]` : "{…}";
  if (Array.isArray(v)) return `[${v.slice(0, 3).map((x) => shape(x, d + 1)).join(",")}${v.length > 3 ? ",…" + v.length : ""}]`;
  return "{" + Object.keys(v).slice(0, 14).map((k) => `${k}:${typeof v[k] === "function" ? "fn" : shape(v[k], d + 1)}`).join(",") + "}";
};

const isOurVideo = (s: unknown): s is string => typeof s === "string" && s.startsWith("file://") && s.includes("/aegires/") && VIDEO.test(s.split("?")[0]);

/** Our decrypted video URIs anywhere in v (shallow-ish walk), in order. */
function videosIn(v: any, out: string[] = [], depth = 0, seen = new Set<any>()): string[] {
  if (isOurVideo(v)) {
    const u = v.split("?")[0];
    if (!out.includes(u)) out.push(u);
    return out;
  }
  if (!v || typeof v !== "object" || depth > 5 || seen.has(v)) return out;
  seen.add(v);
  const vals = Array.isArray(v) ? v.slice(0, 100) : Object.values(v).slice(0, 60);
  for (const x of vals) videosIn(x, out, depth + 1, seen);
  return out;
}

/** The video the viewer opens on: the item at the start index if args name one, else the only video. */
function pickVideo(args: any[]): string | null {
  const all = videosIn(args);
  if (!all.length) return null;
  for (const a of args) {
    if (!a || typeof a !== "object") continue;
    const idxKey = Object.keys(a).find((k) => /index/i.test(k) && typeof a[k] === "number");
    const list = Object.values(a).find((x) => Array.isArray(x) && x.length > 1) as any[] | undefined;
    if (idxKey && list) return videosIn(list[a[idxKey]])[0] ?? null;
  }
  return all.length === 1 ? all[0] : null;
}

function alerts(): any {
  return findModuleWhere((m: any) => typeof m?.openAlert === "function" && typeof m?.dismissAlert === "function");
}

function Player({ uri }: { uri: string }): any {
  const View = RN?.View ?? comp("View");
  const Text = RN?.Text ?? comp("Text");
  const Press = RN?.Pressable ?? comp("Pressable") ?? RN?.TouchableOpacity;
  const win = RN?.Dimensions?.get?.("window") ?? { width: 400, height: 800 };
  const key = React.useMemo(() => "aegires-player-" + Date.now(), []);
  React.useEffect(() => {
    console.log("[aegires-e2ee] video player: mounted", uri);
    return () => releaseViewer(key);
  }, []);
  const cut = uri.lastIndexOf("/") + 1;
  const name = uri.slice(cut).replace(/[^\w.-]/g, "");
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%;object-fit:contain}</style><video src="${name}" controls autoplay playsinline></video>`;
  const box = { width: win.width, height: win.height };
  const views = viewerWebView(key, html, uri.slice(0, cut), { position: "absolute", left: 0, top: 0, ...box });
  const close = () => {
    try { alerts()?.dismissAlert(ALERT_KEY); } catch {}
  };
  return (
    <View style={{ ...box, backgroundColor: "#000" }}>
      {views}
      <Press onPress={close} style={{ position: "absolute", top: 40, right: 16, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Text style={{ color: "#fff", fontSize: 18 }}>✕</Text>
      </Press>
    </View>
  );
}

function openPlayer(uri: string): boolean {
  const a = alerts();
  if (!a) {
    note("no alert host (openAlert) - using Discord's viewer");
    return false;
  }
  a.openAlert(ALERT_KEY, <Player uri={uri} />);
  note("opened " + uri.slice(uri.lastIndexOf("/") + 1));
  return true;
}

// Discord loads the media viewer module only when it is first opened, so we hook it the moment
// it loads (before the tap that loaded it calls it).
export function installVideoPlayer(): () => void {
  let unpatch: (() => void) | null = null;
  note("waiting for the media viewer to load");
  const stop = whenModule((m: any) => typeof m?.openMediaModal === "function", (mod) => {
    try {
      unpatch = hookViewer(mod);
      note("hooked");
    } catch (e) {
      note("hook failed: " + String((e as any)?.message ?? e).slice(0, 80));
    }
  });
  // Debug: log what the chat's image-tap handlers receive (the tap may never reach the viewer).
  const taps: Array<() => void> = [];
  for (const name of ["handleTapImage", "onTapImage"]) {
    try {
      taps.push(whenModule((m: any) => typeof m?.[name] === "function", (mod) => {
        try {
          taps.push(instead(name, mod, (args, orig) => {
            console.log(`[aegires-e2ee] video player: ${name}`, shape(args));
            return orig(...args);
          }));
          console.log(`[aegires-e2ee] video player: watching ${name}`);
        } catch (e) {
          console.log(`[aegires-e2ee] video player: cannot watch ${name}`, e);
        }
      }));
    } catch {}
  }
  return () => {
    stop();
    unpatch?.();
    taps.splice(0).forEach((u) => u());
  };
}

function hookViewer(mod: any): () => void {
  return instead("openMediaModal", mod, (args, orig) => {
    console.log("[aegires-e2ee] video player: openMediaModal", shape(args));
    try {
      const uri = pickVideo(args);
      if (uri && openPlayer(uri)) return;
      if (!uri) note("viewer opened on something else");
    } catch (e) {
      note("failed: " + String((e as any)?.message ?? e).slice(0, 80));
    }
    return orig(...args);
  });
}
