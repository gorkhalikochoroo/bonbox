// The note line the daily close writes for gavekort sold today (Danish on
// purpose: it is printed on the revisor's kasserapport). The close form OWNS
// the line: it is taken out of the note when a close is opened, and written
// again from the day's facts when it is saved — so a close saved twice never
// carries it twice (review 12 Oct 2026, f). Owner text around it is left
// exactly as typed.
export const GK_NOTE_PREFIX = "Gavekort solgt:";

/** Split a saved close note into the owner's own text and the form's
 *  "Gavekort solgt: …" line (its amount text, e.g. "300,00 kr."). A note
 *  without the line comes back untouched. */
export function splitGkNote(text) {
  const raw = String(text ?? "");
  const lines = raw.split("\n");
  const own = lines.filter((l) => l.trim().startsWith(GK_NOTE_PREFIX));
  if (!own.length) return { notes: raw, amountText: "" };
  const rest = lines.filter((l) => !l.trim().startsWith(GK_NOTE_PREFIX)).join("\n").replace(/\s+$/, "");
  const m = own[own.length - 1].match(/^\s*Gavekort solgt:\s*([^(]+?)\s*(?:\(|$)/);
  return { notes: rest, amountText: m ? m[1].trim() : "" };
}
