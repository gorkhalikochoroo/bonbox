// A PAIRED KITCHEN iPAD (/kitchen, /kitchen/<token>) owes no cookie banner —
// the same as the paired door screen at /stand, whose own build (src/stand)
// carries no banner at all. The kitchen screen logs in to nothing: its device
// token, the venue name and the language the cook picks are strictly-necessary
// storage, and no analytics or marketing runs there. Without an answer every
// optional category stays OFF (CookieConsent's getCookieConsent() is null), so
// hiding the banner turns nothing on; it only stops the banner covering the
// list and the keypad on an iPad no visitor reads. Leave for an app page
// unanswered, and the banner shows there as usual (components/CookieConsent).

/** Is this path the paired kitchen device's screen? */
export function isPairedDevicePath(pathname) {
  return typeof pathname === "string" && /^\/kitchen(\/|$)/.test(pathname);
}
