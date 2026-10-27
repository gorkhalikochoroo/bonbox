/**
 * Words for a failure on the book — never the server's code (R10, rubric V10).
 *
 * The book's error lines were written `detail.error || "Couldn't …"`, so any
 * refusal that carried a code showed the CODE: a removed door iPad read
 * "not_found" over an empty night, and a lost race could read
 * "slot_unavailable". A host at the door cannot act on either.
 *
 * The callers keep their own specific sentences for the refusals they already
 * understand (a taken table, a room that is full, a stylist who left); this
 * covers everything else and falls back to the caller's own sentence — the
 * raw code is never returned.
 *
 *   bookFailWords(err, t, t("rsvpAssignError", "Couldn't assign the table."))
 */
// `load`: the failure was reading the book itself, so "that booking is gone"
// would be the wrong story — the caller's sentence says it instead.
export function bookFailWords(err, t, fallback, { apptWords = false, load = false } = {}) {
  const say = typeof t === "function" ? t : (_k, fb) => fb;
  const res = err && err.response;
  // No answer at all: the network, not the request.
  if (err && !res) {
    return say("rsvpErrNoNet", "Couldn't reach BonBox — check the connection and try again.");
  }
  const status = res ? Number(res.status) : 0;
  const code = res && res.data && res.data.detail && typeof res.data.detail === "object"
    ? res.data.detail.error
    : null;
  if (code === "not_found" && !load) {
    return apptWords
      ? say("rsvpErrGoneAppt", "That appointment isn't in the book any more. The book has been updated.")
      : say("rsvpErrGone", "That booking isn't in the book any more. The book has been updated.");
  }
  if (status === 402) {
    return say("rsvpErrPlan", "Reservations aren't part of the venue's plan right now. Ask the owner to check the subscription.");
  }
  if (status === 429) {
    return say("rsvpErrBusy", "Too many tries in a row. Wait a moment and try again.");
  }
  if (typeof fallback === "string" && fallback) return fallback;
  return say("rsvpActionError", "Action failed. Please try again.");
}

export default bookFailWords;
