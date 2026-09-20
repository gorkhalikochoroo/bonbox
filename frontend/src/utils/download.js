/**
 * saveFile — the ONE way a generated file reaches the owner's device.
 *
 * Before this there were 27 hand-rolled copies of the same eight lines, and
 * they disagreed in two ways that both end as "nothing happened":
 *
 *   1. SEVENTEEN of them called URL.revokeObjectURL(url) on the line after
 *      a.click(). In Chrome the download has already been handed to the
 *      download manager by then; in Safari (desktop and iOS) the click only
 *      SCHEDULES the fetch of that blob: URL, so revoking synchronously races
 *      it and the owner gets a 0-byte file or no file at all. Silently — the
 *      anchor click throws nothing, so every one of those call sites believed
 *      it had succeeded. Two of the seventeen were revisor exports.
 *
 *   2. None of them handled the native shell. Inside the Capacitor WebView an
 *      <a download> has no download manager and no Files destination, so the
 *      tap does nothing at all — and the iOS app is where an owner standing in
 *      their own kitchen actually taps "send to revisor". The share sheet is
 *      the native equivalent, and utils/shareDailyCloseRange.js already proved
 *      that path works for a PDF blob.
 *
 * So: one helper, deferred revoke, share sheet on native, and an OUTCOME the
 * caller can render. Not a boolean — "we could not tell" is its own answer and
 * has to survive back to the button (see gotcha: a boolean erases "couldn't
 * check"). Callers surface `ok === false` to the owner; nobody swallows it.
 */
import { isNativeApp } from "./platform";

/** How long Safari needs to start reading the blob: URL before we revoke it. */
const REVOKE_DELAY_MS = 60_000;

/**
 * Can this runtime hand a FILE to the OS share sheet? (Web Share Level 2.)
 *
 * Probe rather than UA-sniff, and swallow everything: a thrown feature test is
 * a "no", never a crash on the way to a download that would have worked.
 */
function canShareFile(blob, filename) {
  try {
    if (typeof navigator === "undefined") return false;
    if (typeof navigator.share !== "function") return false;
    if (typeof navigator.canShare !== "function") return false;
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    return navigator.canShare({ files: [file] }) ? file : false;
  } catch {
    return false;
  }
}

/**
 * Anchor download with a DEFERRED revoke.
 *
 * The anchor is appended to <body> before the click because Firefox ignores a
 * click on a detached node, and removed on the same timer as the revoke so the
 * DOM does not accumulate one dead anchor per export.
 */
function anchorDownload(blob, filename) {
  if (typeof document === "undefined") return { ok: false, reason: "no_document" };
  // Inside the native shell there is no download manager and no Files
  // destination (see the header): the anchor click is a no-op that throws
  // nothing. Returning ok:true here would put a green tick under a button
  // that delivered nothing — the exact silent failure this module exists to
  // kill — so the native shell gets the third outcome instead: we could not
  // deliver it, say so.
  if (isNativeApp()) return { ok: false, reason: "no_download_manager" };
  let url;
  try {
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        a.remove();
        URL.revokeObjectURL(url);
      } catch { /* the document went away — nothing left to clean up */ }
    }, REVOKE_DELAY_MS);
    return { ok: true, channel: "download" };
  } catch (e) {
    if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
    return { ok: false, reason: e?.message || "download_failed" };
  }
}

/**
 * Hand `blob` to the owner as `filename`.
 *
 * @param {Blob|ArrayBuffer|string} data  what the export endpoint returned.
 *        An axios `responseType: "blob"` response is already a Blob; anything
 *        else is wrapped, so a call site never has to remember which.
 * @param {string} filename  the name the owner will see in Files / Downloads.
 * @param {object} [opts]
 * @param {string} [opts.type]   MIME type, used when `data` is not a Blob.
 * @param {string} [opts.title]  share-sheet title on native.
 * @param {string} [opts.text]   share-sheet body on native.
 * @param {boolean} [opts.preferShare]  also try the share sheet on mobile WEB,
 *        not only in the native shell. Opt-in, because on a laptop that would
 *        turn a plain download into a share sheet. Used by the staff-facing
 *        CSV export, which already behaved this way before it moved here.
 * @returns {Promise<{ok: true, channel: "share"|"download"} | {ok: false, reason: string}>}
 *
 * Never throws: a failed export is a message on the button, not an unhandled
 * rejection that leaves the owner's spinner turning forever.
 */
export async function saveFile(data, filename, { type, title, text, preferShare = false } = {}) {
  if (data == null) return { ok: false, reason: "no_data" };
  let blob;
  try {
    blob = data instanceof Blob ? data : new Blob([data], type ? { type } : undefined);
  } catch (e) {
    return { ok: false, reason: e?.message || "blob_failed" };
  }
  if (blob.size === 0) return { ok: false, reason: "empty_file" };

  // Native shell FIRST — there is no download manager behind this WebView, so
  // the anchor path below is not a fallback there, it is a no-op. On the web
  // we deliberately do NOT probe for the share sheet: desktop Chrome can share
  // files, and replacing a plain download with a share sheet would change what
  // every export on a laptop does.
  if (isNativeApp() || preferShare) {
    const file = canShareFile(blob, filename);
    if (file) {
      try {
        await navigator.share({ files: [file], title, text });
        return { ok: true, channel: "share" };
      } catch (e) {
        // AbortError ALONE means the owner dismissed the sheet. The sheet
        // OPENED, which is everything this helper promises; treat it as
        // delivered rather than showing them an error for closing a thing they
        // opened, and do NOT then dump a download on them as if the cancel had
        // not happened.
        //
        // NotAllowedError is NOT a dismissal — it is what WebKit throws when
        // navigator.share() is called without transient user activation, and
        // every revisor export here is `await api.get(blob)` THEN saveFile, so
        // the network round-trip has already expired the activation by the
        // time we ask. Counting it as delivered is how the momsangivelse and
        // the lønseddel would silently vanish on the iPhone. Fall through.
        if (e?.name === "AbortError") {
          return { ok: true, channel: "share" };
        }
        // Anything else: fall through and let the anchor try.
      }
    }
  }

  return anchorDownload(blob, filename);
}

/**
 * Convenience for the CSV/text exports that build their content in JS rather
 * than fetching it. Adds the BOM those call sites already relied on so Excel
 * on a Danish Windows opens the file as UTF-8 instead of mojibake.
 */
export async function saveTextFile(text, filename, { type = "text/csv;charset=utf-8;", ...opts } = {}) {
  return saveFile(new Blob(["﻿" + String(text ?? "")], { type }), filename, opts);
}
