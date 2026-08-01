/**
 * The guest-facing scarcity cue on a booking time slot.
 *
 * Turns the server's honest per-slot count into the short note under the time
 * ("Last table", "2 left").
 *
 * SILENCE IS THE DEFAULT, and that is the whole design decision. A hint on
 * every slot is noise; a hint the server did not back is a lie told to make
 * someone book faster. The booking design handoff states it plainly — if the
 * backend cannot supply real numbers, show plain available/full rather than
 * faking them. So anything that is not a real number, or is not genuinely
 * scarce, renders nothing at all.
 *
 * The number itself comes from availability_engine.count_free_singles, which
 * counts exactly the set the seating decision picks from and ignores
 * combinable tables — so it understates rather than overstates. A slot can
 * never advertise availability the booking path would then refuse.
 */

/** At or below this many tables left, the slot is worth flagging. */
export const SLOT_SCARCE_AT = 3;

/**
 * @param {number|undefined} remaining single tables still free for this slot
 * @param {(key: string, fallback: string) => string} t
 * @returns {string} the note, or "" when there is nothing honest to say
 */
export function slotNote(remaining, t) {
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return "";
  if (remaining === 1) return t("rsvpSlotLastTable", "Sidste bord");
  if (remaining > 1 && remaining <= SLOT_SCARCE_AT) {
    return t("rsvpSlotNLeft", "{n} tilbage").replace("{n}", String(remaining));
  }
  return "";
}
