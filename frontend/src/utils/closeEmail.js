/**
 * The lock mail to the revisor — what the page needs to show and resend it.
 *
 * The status is PERSISTED on the close (email_status / email_sent_at /
 * email_sent_to / email_error), so History can say after a reload whether a
 * day reached the revisor. There is no background retry: a failed send says
 * "Ikke sendt" and the owner taps Send igen, which calls the real resend
 * endpoint — never the old re-POST of a locked close (a 409 dead end).
 */

/** One key per click. A replay of the same key (double tap, network retry)
 *  answers with the first outcome; and the server claims the send itself
 *  (status "sending") before mailing, so a second request with ANOTHER key —
 *  the card and the History row, or a second tab — gets 409 in_progress
 *  instead of becoming a second mail. */
export function newSendKey() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/[^A-Za-z0-9-]/g, "");
  } catch { /* fall through */ }
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** POST /daily-close/{id}/resend-email. `_noRetry`: the interceptor must not
 *  replay a send on its own. */
export function resendCloseEmail(api, closeId, { key, force = false }) {
  return api.post(`/daily-close/${closeId}/resend-email`, { key, force }, { _noRetry: true });
}

const FAILED = new Set(["send_failed", "queued_retry", "failed_skipped"]);

/**
 * What to say about one close's lock mail.
 *   kind: "revisor" (reached the revisor) | "owner_only" | "failed" |
 *         "opted_out" | "pref_off" | "no_recipient" | "sending" | "none"
 */
export function closeEmailState({ status, sentTo = [], skip = null, profile = null }) {
  const acct = String(profile?.accountant_email || "").trim().toLowerCase();
  const to = (sentTo || []).map((x) => String(x).toLowerCase());
  if (!status || status === "skipped_feature_locked") return { kind: "none", acct };
  if (status === "sending") return { kind: "sending", acct };
  if (acct && to.includes(acct)) return { kind: "revisor", acct };
  if (profile?.accountant_opted_out || skip === "opted_out") return { kind: "opted_out", acct };
  // "partial" = one of the two mails failed. When the revisor is not among
  // those who got it, the revisor's send FAILED (the owner's copy went) —
  // never the same line as a deliberate owner-only send.
  if (status === "partial" && acct && !to.includes(acct)) return { kind: "failed", acct };
  if (status === "skipped_preference_off") return { kind: "pref_off", acct };
  if (status === "skipped_no_recipient") return { kind: "no_recipient", acct };
  if (FAILED.has(status)) return { kind: "failed", acct };
  if ((status === "sent" || status === "partial") && to.length) return { kind: "owner_only", acct };
  if (status === "partial") return { kind: "failed", acct };
  return { kind: "none", acct };
}

/** i18n key for the honest cause of a failed send. */
export function emailErrorKey(error) {
  const e = String(error || "");
  if (e === "email_not_configured") return "dcMailErrNotConfigured";
  if (e === "pdf_build_failed") return "dcMailErrPdf";
  if (e === "attachment_too_large") return "dcMailErrTooLarge";
  if (e === "no_recipient") return "dcMailErrNoRecipient";
  if (e.startsWith("send_error")) return "dcMailErrProvider";
  return "dcMailErrUnknown";
}

/** { date: "08.10", time: "07:12" } in the device's (= the venue's) local
 *  time — the caller words it ("08.10 kl. 07:12"). The server stores naive
 *  UTC; read bare, the browser took it as local. null when unknown. */
export function sentWhen(iso) {
  if (!iso) return null;
  const s = String(iso);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return { date: `${dd}.${mm}`, time: `${hh}:${mi}` };
}

/** The server's file name from Content-Disposition (filename* first, then
 *  filename), else `fallback`. "Kasserapporter Mirabelle ApS 2026-09-01–
 *  2026-09-30.xlsx" — business and period, the same name the mail uses. */
export function filenameFromResponse(res, fallback) {
  const h = res?.headers?.["content-disposition"] || res?.headers?.get?.("content-disposition") || "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(h);
  return plain ? plain[1].trim() : fallback;
}

/** Every CloseEmailStatus on the page (the lock card and the History row
 *  show the same close) hears about a send made by any of them. */
export const CLOSE_EMAIL_EVENT = "bonbox-close-email";

export function announceCloseEmail(closeId, state) {
  try {
    window.dispatchEvent(new CustomEvent(CLOSE_EMAIL_EVENT, { detail: { id: closeId, ...state } }));
  } catch { /* no window (tests) */ }
}
