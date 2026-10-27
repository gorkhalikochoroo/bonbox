// The words of "Glem" on Blokerede kontakter (fix round 27 Oct 2026): what
// the server would erase or did erase for a contact, and the upcoming
// bookings it keeps until the visit (it never erases those silently).
// Counts come from POST /reservations/contact-blocks/erase-preview and /erase.

// "3 past bookings, 1 waitlist place and 1 entry on this list" — only the
// kinds with something in them. [] when nothing.
export function forgetParts(counts, t, apptWords = false) {
  const c = counts || {};
  const part = (n, one, many, fbOne, fbMany) =>
    n === 1 ? t(one, fbOne) : t(many, fbMany, { n });
  const out = [];
  const past = Number(c.reservations) || 0;
  const wait = Number(c.waitlist) || 0;
  const list = Number(c.blocks) || 0;
  if (past) {
    out.push(apptWords
      ? part(past, "rsvpForgetPastOneAppt", "rsvpForgetPastNAppt", "1 past appointment", "{n} past appointments")
      : part(past, "rsvpForgetPastOne", "rsvpForgetPastN", "1 past booking", "{n} past bookings"));
  }
  if (wait) out.push(part(wait, "rsvpForgetWaitOne", "rsvpForgetWaitN", "1 waitlist place", "{n} waitlist places"));
  if (list) out.push(part(list, "rsvpForgetListOne", "rsvpForgetListN", "1 entry on this list", "{n} entries on this list"));
  return out;
}

export function joinParts(parts, lang = "da") {
  try {
    return new Intl.ListFormat(lang === "en" ? "en" : "da", { style: "long", type: "conjunction" }).format(parts);
  } catch {
    return parts.join(", ");
  }
}

// The upcoming bookings "Glem" keeps (it never erases them silently).
export function futureLine(n, t, apptWords = false) {
  const k = Number(n) || 0;
  if (!k) return "";
  if (apptWords) {
    return k === 1
      ? t("rsvpBlocksForgetFutureOneAppt", "1 upcoming appointment keeps the contact until the visit — cancel it first if the customer asked.")
      : t("rsvpBlocksForgetFutureNAppt", "{n} upcoming appointments keep the contact until the visit — cancel them first if the customer asked.", { n: k });
  }
  return k === 1
    ? t("rsvpBlocksForgetFutureOne", "1 upcoming booking keeps the contact until the visit — cancel it first if the guest asked.")
    : t("rsvpBlocksForgetFutureN", "{n} upcoming bookings keep the contact until the visit — cancel them first if the guest asked.", { n: k });
}
