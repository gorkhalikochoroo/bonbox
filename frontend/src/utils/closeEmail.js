import { HELD_CLAIM_OPEN, HELD_UNVERIFIED, heldReasonFromSkip } from "./senderGate";

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

/** A sample close from the demo seeder (notes end in " · demo"). It is never
 *  offered for sending — the server refuses it too (409 demo_close). */
export function isDemoClose(close) {
  return String(close?.notes || "").endsWith(" · demo");
}

/** The revisor address a send may go to — "" when none is saved, and "" when
 *  the saved one is the demo seeder's sample (the server treats it as NOT
 *  SAVED on every send path: skip / 409 "demo_recipient"). Never pre-fill,
 *  name or mail the sample address as "your revisor". */
export function revisorAddress(profile) {
  if (profile?.accountant_is_demo) return "";
  return String(profile?.accountant_email || "").trim();
}

/** The business on the profile is still the demo seeder's sample company
 *  (Mirabelle ApS): the server sends a revisor nothing under it (skip / 409
 *  "demo_identity") until the owner saves their own name, CVR and address. */
export function identityIsDemo(profile) {
  return Boolean(profile?.identity_is_demo);
}

/**
 * What to say about one close's lock mail.
 *   kind: "revisor" (handed to the mail server for the revisor) | "owner_only" |
 *         "failed" | "failed_owner" (no revisor saved; the owner's own copy
 *         failed) | "opted_out" | "pref_off" | "no_recipient" | "sending" |
 *         "unchanged" (re-locked with nothing changed: the revisor already
 *         holds these figures, so no new mail went) |
 *         "unrecorded" (locked before the send status was kept) |
 *         "unverified" (the revisor got nothing because the owner's own
 *         e-mail is not confirmed — "Ikke sendt til revisoren — bekræft din
 *         e-mail først"; `ownerSent` when the owner's own copy went: "Sendt
 *         til dig {when} — ikke til revisoren: bekræft din e-mail først") |
 *         "unverified_owner_failed" (the same, and the owner's own copy
 *         failed too — both said) |
 *         "claim_open" / "claim_open_owner_failed" (the address IS
 *         confirmed, but "Har du selv oprettet denne konto?" waits for the
 *         answer to the mailed question — said in those words, with "Send
 *         spørgsmålet igen", never "bekræft din e-mail"; release gate,
 *         9 Oct) | "none"
 *   ownerConfirmed: the owner's own e-mail is confirmed. Only `false` turns a
 *     held send into "unverified"; once confirmed, the ordinary line takes
 *     over ("Sent to you — not to your revisor" + Send to revisor).
 *   claimOpen: the question is open right now (/auth/me
 *     claim_question_open, or a Send igen answered 403 with that reason).
 *     A held day reads "claim_open" while it is; once answered, the
 *     ordinary line takes over.
 *   error: the persisted email_error. A held day keeps its marker
 *     ("revisor_email_unverified" / "revisor_claim_question_open"), and when
 *     the owner's own copy failed too, that error after a ";" — both said.
 *   demo: the saved revisor is demo-seeder sample data (never mailed).
 *   identity: the business is still the demo's sample company — a real
 *     revisor is saved but gets nothing until the owner fixes Profile. No
 *     send button is offered (acct is ""), the row says why.
 */
export function closeEmailState({ status, sentTo = [], skip = null, profile = null, error = null, ownerConfirmed = true, claimOpen = false }) {
  const raw = String(profile?.accountant_email || "").trim().toLowerCase();
  const demo = Boolean(profile?.accountant_is_demo) || skip === "demo_recipient";
  const identity = !demo && Boolean(raw) && (identityIsDemo(profile) || skip === "demo_identity");
  const to = (sentTo || []).map((x) => String(x).toLowerCase());
  // A close that DID reach the saved address before it was known as sample
  // data says so, honestly — every other line treats it as not saved.
  if (status && status !== "sending" && status !== "skipped_feature_locked" && raw && to.includes(raw)) {
    return { kind: "revisor", acct: raw, demo: false, identity: false };
  }
  const acct = demo || identity ? "" : raw;
  // Held for an unconfirmed owner, or while "did you create this account?"
  // is open: the lock's skip ("email_unverified" / "claim_question_open"),
  // the marker persisted on the close (so History says it after a reload),
  // or a 403 from Send igen. Said in the words of what blocks a send NOW:
  // the open question first (the address is confirmed then), else the
  // unconfirmed address.
  const held = heldReasonFromSkip(skip) || heldReasonFromSkip(error);
  const now = !held ? null
    : claimOpen === true ? HELD_CLAIM_OPEN
      : ownerConfirmed === false ? HELD_UNVERIFIED : null;
  if (now && acct && status !== "sending" && !profile?.accountant_opted_out) {
    const base = now === HELD_CLAIM_OPEN ? "claim_open" : "unverified";
    // Say what happened to the owner's OWN copy too (review, 9 Oct): that it
    // went, or that it failed — never hidden behind the held line.
    if ((status === "sent" || status === "partial") && to.length) {
      return { kind: base, ownerSent: true, acct, demo, identity };
    }
    if (FAILED.has(status) || status === "partial") {
      return { kind: `${base}_owner_failed`, acct, demo, identity };
    }
    return { kind: base, ownerSent: false, acct, demo, identity };
  }
  if (skip === "unchanged" || error === "revisor_unchanged") {
    if (status === "sent" || status === "partial") return { kind: "unchanged", acct, demo, identity };
  }
  return { ...closeEmailKind({ status, to, skip, profile, acct }), demo, identity };
}

function closeEmailKind({ status, to, skip, profile, acct }) {
  // Free: BonBox does not send — nothing to say.
  if (status === "skipped_feature_locked") return { kind: "none", acct };
  // Locked before the status was kept AND unknown to the audit trail (the
  // server fills the status from the trail when it knows): "Ikke
  // registreret", never a blank that reads like "nothing happened". The page
  // shows it only on a sending plan with a revisor saved, and asks before
  // sending — it may already have gone.
  if (!status) return { kind: "unrecorded", acct };
  if (status === "sending") return { kind: "sending", acct };
  if (profile?.accountant_opted_out || skip === "opted_out") return { kind: "opted_out", acct };
  // "partial" = one of the two mails failed. When the revisor is not among
  // those who got it, the revisor's send FAILED (the owner's copy went) —
  // never the same line as a deliberate owner-only send.
  if (status === "partial" && acct && !to.includes(acct)) return { kind: "failed", acct };
  if (status === "skipped_preference_off") return { kind: "pref_off", acct };
  if (status === "skipped_no_recipient") return { kind: "no_recipient", acct };
  // With no revisor saved the only mail was the owner's own copy.
  if (FAILED.has(status)) return { kind: acct ? "failed" : "failed_owner", acct };
  if ((status === "sent" || status === "partial") && to.length) return { kind: "owner_only", acct };
  if (status === "partial") return { kind: "failed", acct };
  return { kind: "none", acct };
}

/** The owner's own copy's error in a persisted email_error — after the held
 *  marker ("revisor_<reason>;<error>") when both are kept. */
export function ownerCopyError(error) {
  const e = String(error || "");
  if (!e.startsWith("revisor_")) return e;
  const i = e.indexOf(";");
  return i >= 0 ? e.slice(i + 1) : "";
}

/** i18n key for the honest cause of a failed send. */
export function emailErrorKey(error) {
  const e = ownerCopyError(error);
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
