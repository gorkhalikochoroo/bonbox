import { isNativeApp } from "./platform";

/**
 * The origin a link someone ELSE will open must be built on.
 *
 * Inside the native owner app the page's own origin is the shell's —
 * capacitor://localhost on iOS, http(s)://localhost on Android — so a staff
 * link, a menu QR or a gavekort link built from window.location.origin opened
 * nothing on the phone it was sent to. On the web the page's origin is the
 * right one (and keeps localhost links working in development).
 */
export const PUBLIC_ORIGIN = "https://www.bonbox.dk";

export function publicOrigin() {
  if (typeof window === "undefined") return PUBLIC_ORIGIN;
  const origin = window.location.origin || "";
  if (isNativeApp() || !/^https?:\/\//.test(origin)) return PUBLIC_ORIGIN;
  return origin;
}

/** An absolute, shareable URL for an app path like "/s/abc". */
export function publicUrl(path = "") {
  return `${publicOrigin()}${path}`;
}
