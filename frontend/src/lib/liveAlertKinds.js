// Small, testable pieces of the live-alert system (hooks/useLiveAlerts.jsx).

/** Fired on window when the live-alert poll sees new booking changes. */
export const RESERVATIONS_CHANGED_EVENT = "bonbox-reservations-changed";

/**
 * Which sound one poll's batch of changes plays — once per poll.
 *   "urgent" — any severe allergy (the safety alert always wins)
 *   "cancel" — the batch is nothing but cancellations (a falling chime)
 *   "chime"  — anything else: a new booking, an edit (a rising chime)
 */
export function alertSoundFor(items) {
  if (!items?.length) return null;
  if (items.some((i) => i.severe)) return "urgent";
  if (items.every((i) => i.kind === "cancelled")) return "cancel";
  return "chime";
}

/**
 * A HELD online booking (R1: the booking screen kept it for the owner's OK)
 * holds no table and may be a robot's — so it never sets off a sound, a
 * sticky toast or the severe-allergy alarm on the stand. One poll's held
 * items fold into ONE quiet "N til tjek" toast; the rest alert as before.
 * When the owner approves a held booking with a severe allergy, the feed
 * sends it again as kind "approved" (not held) — that is when the kitchen
 * needs it, and it alerts like any severe allergy.
 *   → { live: [...], held: [...] }
 */
export function splitHeld(items) {
  const live = [];
  const held = [];
  for (const i of items || []) (i && i.held ? held : live).push(i);
  return { live, held };
}
