// Safe user notifications. Discord's toast (showToast) crashes the whole app on some newer
// Discord builds (its ToastContainer fails while rendering our toast), and a crash at plugin
// load means the user cannot even open Discord. So we never use Discord toasts: important
// messages use a native Alert, everything else goes to the console and the Diagnostics card.
import { RN } from "./rt.ts";

/** Native dialog. For things the user must know about (e.g. "message NOT sent"). */
export function notify(message: string): void {
  console.log("[aegires-e2ee] notice:", message);
  try {
    RN.Alert.alert("Aegires E2EE", message);
  } catch {}
}

/** Log only. For startup / background problems that should never pop anything up. */
export function quiet(message: string): void {
  console.log("[aegires-e2ee]", message);
}
