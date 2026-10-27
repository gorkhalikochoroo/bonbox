// The words of "Glem" on Blokerede kontakter (fix round 27 Oct 2026): what
// the server would erase or did erase for a contact, and the upcoming
// bookings it keeps until the visit (it never erases those silently).
// Counts come from POST /reservations/contact-blocks/erase-preview and /erase.

// "3 past bookings, 1 waitlist place and the entry •• •• •• 78 on this list"
// — only the kinds with something in them. [] when nothing. `entries`: the
// list's entries that go, masked as the list shows them (fix round 4): the
// confirm names them instead of counting them.
export function forgetParts(counts, t, apptWords = false, entries = null) {
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
  if (list) {
    const hints = Array.isArray(entries) ? entries.map((e) => e && e.hint).filter(Boolean) : [];
    if (hints.length === list) {
      out.push(list === 1
        ? t("rsvpForgetListNamedOne", "the entry {hint} on this list", { hint: hints[0] })
        : t("rsvpForgetListNamedN", "{n} entries on this list ({hints})", { n: list, hints: hints.join(", ") }));
    } else {
      out.push(part(list, "rsvpForgetListOne", "rsvpForgetListN", "1 entry on this list", "{n} entries on this list"));
    }
  }
  return out;
}

// What stays on the list, said — never folded into "everything goes" (fix
// round 4, review2 #3): an entry that also covers another number with the
// same last digits (the guest's number is taken out of it), and one that
// can't be told apart from such a number (named, for the owner to remove).
export function keptLines(kept, t, apptWords = false) {
  const k = kept || {};
  const out = [];
  const shared = Number(k.shared) || 0;
  if (shared) {
    if (apptWords) {
      out.push(shared === 1
        ? t("rsvpForgetSharedOneAppt", "1 entry on this list also covers another number with the same last digits — it stays for that number; the customer's number is taken out of it.")
        : t("rsvpForgetSharedNAppt", "{n} entries on this list also cover another number with the same last digits — they stay for that number; the customer's number is taken out of them.", { n: shared }));
    } else {
      out.push(shared === 1
        ? t("rsvpForgetSharedOne", "1 entry on this list also covers another number with the same last digits — it stays for that number; the guest's number is taken out of it.")
        : t("rsvpForgetSharedN", "{n} entries on this list also cover another number with the same last digits — they stay for that number; the guest's number is taken out of them.", { n: shared }));
    }
  }
  const unsure = Array.isArray(k.unsure) ? k.unsure.map((e) => e && e.hint).filter(Boolean) : [];
  if (unsure.length) {
    const hints = unsure.join(", ");
    out.push(apptWords
      ? t("rsvpForgetUnsureAppt", "{hints} on this list can't be told apart from another number with the same last digits, so it stays — remove it yourself if it is the customer's.", { hints })
      : t("rsvpForgetUnsure", "{hints} on this list can't be told apart from another number with the same last digits, so it stays — remove it yourself if it is the guest's.", { hints }));
  }
  return out;
}

// Nothing found: what was searched, never "nothing is kept" (fix round 4).
export function noneFoundLine(contact, t, apptWords = false) {
  return apptWords
    ? t("rsvpBlocksForgetNoneFoundAppt", "Nothing found for {contact} in appointments, on the waitlist or on this list.", { contact })
    : t("rsvpBlocksForgetNoneFound", "Nothing found for {contact} in bookings, on the waitlist or on this list.", { contact });
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
