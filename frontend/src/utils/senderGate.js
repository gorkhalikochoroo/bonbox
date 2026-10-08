/**
 * Why BonBox holds a mail to a third party — fakturaer, team invitations,
 * supplier orders and every mail to the revisor (backend
 * services/revisor_mail.require_verified_sender / held_sender_reason).
 *
 *   "email_unverified"     the account's own address is not confirmed:
 *                          "Bekræft først din e-mail" + "Bekræft nu".
 *   "claim_question_open"  the address IS confirmed, but "Har du selv
 *                          oprettet denne konto?" waits for the inbox owner's
 *                          answer (a login link / reset code landed on a
 *                          never-confirmed account). Saying "confirm your
 *                          e-mail" there is false and "Bekræft nu" a dead end
 *                          (release gate, 9 Oct) — the app names the mailed
 *                          question and offers "Send spørgsmålet igen"
 *                          instead. The app never answers the question: only
 *                          the ticket in that mail can.
 *
 * The server keeps code "email_unverified" for both (older app builds refuse
 * to send either way) and puts the true reason in detail.reason.
 */
export const HELD_UNVERIFIED = "email_unverified";
export const HELD_CLAIM_OPEN = "claim_question_open";

/** The held reason in a 403 from a send, or null for any other answer. */
export function heldReasonFromError(err) {
  const res = err?.response;
  const d = res?.data?.detail;
  if (res?.status !== 403 || !d || typeof d !== "object" || d.code !== "email_unverified") return null;
  return d.reason === HELD_CLAIM_OPEN ? HELD_CLAIM_OPEN : HELD_UNVERIFIED;
}

/** What a send to a third party would meet right now, read from the
 *  signed-in user (/auth/me: email_verified, claim_question_open). Only an
 *  explicit `false` counts as unconfirmed (an older server sends no field). */
export function heldReasonForUser(user) {
  if (!user) return null;
  if (user.email_verified === false) return HELD_UNVERIFIED;
  if (user.claim_question_open === true) return HELD_CLAIM_OPEN;
  return null;
}

/** A skip reason / persisted marker → the held reason, or null. */
export function heldReasonFromSkip(value) {
  const v = String(value || "");
  if (v === HELD_CLAIM_OPEN || v.startsWith(`revisor_${HELD_CLAIM_OPEN}`)) return HELD_CLAIM_OPEN;
  if (v === HELD_UNVERIFIED || v.startsWith(`revisor_${HELD_UNVERIFIED}`)) return HELD_UNVERIFIED;
  return null;
}

/** POST /auth/claim-decision/remail — e-mail the question again to the
 *  account's own inbox (at most once a day). Never replayed by the
 *  interceptor: one tap, one request. */
export function remailClaimQuestion(api) {
  return api.post("/auth/claim-decision/remail", {}, { _noRetry: true });
}

/** The text to show for a remail answer, in the owner's language. */
export function remailResultText(resOrErr, t, lang) {
  const data = resOrErr?.data;
  if (data?.ok) return { ok: true, text: t("claimResent", "The question was sent again to {email}. Answer from the link in that e-mail.", { email: data.sent_to || "" }) };
  const d = resOrErr?.response?.data?.detail;
  if (d && typeof d === "object" && (d.message || d.message_da)) {
    return { ok: false, text: (lang === "da" ? d.message_da : d.message) || d.message || d.message_da };
  }
  return { ok: false, text: t("claimResendFailed", "Couldn't send the question again just now. Try again in a moment.") };
}
