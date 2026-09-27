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
