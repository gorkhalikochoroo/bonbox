/**
 * quickJobs — the urgent jobs I dag's quick row and the phone "+" sheet both
 * offer (phone R1, PHONE-OWNER-PLAN §4, decision 3): one model, two ways in.
 *
 *   • Ny reservation → /reservations?new=1 — the reservations pillar is on.
 *   • Drop-in        → /reservations?walkin=1 — I dag's rule (canWalkIn): the
 *     venue keeps a book, it is a food venue, and it has seats.
 *
 * Both open the sheets Reservationer already has (ReservationsPage's deep
 * link), so neither is a second booking flow.
 *
 * The book's facts (has a book, how many seats) come from I dag's own read
 * (GET /api/today `reservations`). I dag notes them here on every answer, so
 * the "+" sheet can tell without a read of its own; a sheet opened before I
 * dag ever answered asks /today once. Unknown never shows Drop-in: a chip
 * that opens a seat sheet with no tables would be a dead end.
 */
import { archetypeIdFor } from "../../config/archetypes";
import { relevantPillarsForArchetype } from "../../config/navManifest";

export const NEW_BOOKING_TO = "/reservations?new=1";
export const WALK_IN_TO = "/reservations?walkin=1";

/** A food venue (a restaurant, a café, a bar): the one that seats drop-ins. */
export function isFoodVenue(businessType) {
  const a = archetypeIdFor(businessType);
  return a === "food_service" || a === "bar";
}

/** I dag's canWalkIn: a book on screen, a food venue, seats > 0. */
export function canWalkInWith({ showRsv, isFood, seats }) {
  return !!showRsv && !!isFood && (Number(seats) || 0) > 0;
}

let kept = null; // { account, hasBook, seats }

/** I dag answered: keep the book's facts for this account. */
export function noteBookFacts(account, reservations) {
  if (account == null || !reservations || typeof reservations !== "object") return;
  kept = { account: String(account), hasBook: !!reservations.has_book, seats: Number(reservations.seats) || 0 };
}

/** The last facts I dag gave for this account, or null (not known). */
export function bookFactsFor(account) {
  return kept && account != null && kept.account === String(account) ? kept : null;
}

export function __resetQuickJobsForTests() { kept = null; }

/**
 * Which jobs to offer. `facts` null = not known yet: Ny reservation still
 * shows where the venue keeps a book (the pillar is on and belongs to the
 * type, or I dag said there is a book); Drop-in waits for the facts.
 */
export function quickJobs({ businessType, hiddenPillars, facts = null }) {
  const hidden = hiddenPillars instanceof Set ? hiddenPillars : new Set();
  const rsvOn = !hidden.has("reservations");
  const relevant = relevantPillarsForArchetype(archetypeIdFor(businessType)).has("reservations");
  return {
    newBooking: rsvOn && (relevant || !!facts?.hasBook),
    walkIn: rsvOn && canWalkInWith({ showRsv: !!facts?.hasBook, isFood: isFoodVenue(businessType), seats: facts?.seats }),
  };
}
