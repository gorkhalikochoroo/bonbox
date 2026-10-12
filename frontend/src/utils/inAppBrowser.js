/**
 * Is this page open inside Instagram's, Facebook's or Messenger's own
 * browser?
 *
 * A paid Instagram ad opens /register INSIDE Instagram — the app's webview,
 * not Safari or Chrome. Google refuses its sign-in in such webviews
 * ("Error 403: disallowed_useragent", its secure-browser policy), so a Google
 * button there only leads to Google's error page. /register and /login show
 * one calm line instead of the button (Push 7).
 *
 * These apps name themselves in the user agent:
 *   Instagram   "… Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5_1; …)"
 *               "… Mobile Safari/537.36 Instagram 337.0.0.35.102 Android (34/14; …)"
 *   Facebook    "… Mobile/15E148 [FBAN/FBIOS;FBAV/472.0.0.45.110;…]"   (iPhone)
 *               "… Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/478.0.0.42.109;]"   (Android)
 *   Messenger   "… Mobile/15E148 [FBAN/MessengerForiOS;FBAV/458.0.0.36.108;…]"
 *               "… Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/439.0.0.29.119;]"
 * Safari, Chrome (CriOS on iPhone), Samsung Internet and Firefox carry none
 * of these words.
 *
 * Returns the app's name — "Instagram", "Messenger" or "Facebook", a brand
 * name, the same in every language — or null in any other browser. Messenger
 * is asked before Facebook: its user agent carries the FBAN / FB_IAB / FBAV
 * tokens too.
 *
 * @param {string} [ua] the user agent; navigator.userAgent when left out
 * @returns {"Instagram"|"Messenger"|"Facebook"|null}
 */
export function inAppBrowserName(ua) {
  let s = ua;
  if (typeof s !== "string") {
    try {
      s = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    } catch {
      s = "";
    }
  }
  if (/\binstagram\b/i.test(s)) return "Instagram";
  if (/messenger|orca-android/i.test(s)) return "Messenger";
  if (/FBAN|FBAV|FB_IAB|FBIOS/.test(s)) return "Facebook";
  return null;
}
