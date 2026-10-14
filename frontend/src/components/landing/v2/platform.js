/**
 * Android (push 9, A5). Both apps are iPhone-only — there is no Android app —
 * so an Android visitor offered "BonBox i App Store" was offered a store they
 * cannot use. On Android the same pill points at the web app instead
 * (webHref: /register for the owner, /join for staff), which works in any
 * phone browser. iPhone, iPad and desktop keep the App Store link.
 */
export function isAndroidBrowser(ua) {
  try {
    const s = ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
    return /android/i.test(s || "");
  } catch {
    return false;
  }
}

