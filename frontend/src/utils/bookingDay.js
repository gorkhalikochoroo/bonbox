// Day-selection rules for the public booking page.
import { maxAdvanceOf } from "./dayState";
import { speaksAppointments } from "../config/venueProfiles";

/**
 * Keep the chosen day unless the 14-day open/closed summary says it is closed.
 * A date outside the summary (picked in the calendar, or a ?d= link further
 * out) is unknown, not closed — it stays, and the time list says whether the
 * place is open that day.
 *
 * `keep` (booking R12): a FULL night the guest picked themselves (a tap, the
 * calendar, a ?d= link) when the venue takes waitlist names. It stays: the
 * page offers the nearest free times and the waitlist for it instead of
 * jumping away. The page's own first day (today) is never kept, so a full
 * tonight still moves on to the next open day and the times stay on the
 * first screen.
 */
export function rescueDay(cur, map, nextOpen, keep = null) {
  if (cur && keep && cur === keep) return cur;
  if (cur && (!(cur in (map || {})) || map[cur])) return cur;
  return nextOpen || cur;
}

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoOf(d);
};

/**
 * Step 1's first answers, from the page data and the link (?d=YYYY-MM-DD,
 * ?party=N). The page sets these in the SAME update as the page data (booking
 * R3), so the date strip's first paint already shows the day — it used to be
 * seeded by an effect after that paint, and today's chip faded from white to
 * ink about 650 ms into the load.
 *   day   — the link's day when it is a real date inside [today, today +
 *           max_advance_days] (the backend's reading of the window), else today.
 *   party — 1 for a salon, a shop or a workshop (one customer; the page does
 *           not ask), else the link's party up to the venue's maximum, else 2.
 */
export function seedStep1(page, { d = null, party = null } = {}, today) {
  const maxAdvance = maxAdvanceOf(page?.max_advance_days);
  const maxParty = Number(page?.max_party_size) || 10;
  let day = today;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && isoOf(new Date(`${d}T00:00:00`)) === d) {
    if (d >= today && d <= plusDays(today, maxAdvance)) day = d;
  }
  const q = parseInt(party || "", 10);
  let seededParty;
  if (speaksAppointments(page?.business_type)) seededParty = 1;
  else if (Number.isFinite(q) && q >= 1) seededParty = Math.min(q, maxParty);
  else seededParty = Math.min(2, maxParty);
  return { day, party: seededParty };
}
