/**
 * The book on screen and the 20-second check (R10 — the door iPad stays on).
 *
 * WHAT WAS WRONG. Every open book learned about changes in two ways: the
 * live-alert poll (/changes, every 20 s), which by design carries only the
 * GUEST's events, and a full /book reload every 75 s. Anything the owner or a
 * host did — seat a walk-in, move a party, cancel by phone, park someone on
 * the Venteliste — reached the other screens up to 75 s later (measured: 71 s).
 *
 * THE FIX, IN TWO HALVES.
 *   • The server stamps each /book answer with the day's revision, and the
 *     poll asks "what is the revision of the day on my screen now?"
 *     (/changes?day=). Different → the book reloads quietly. Same → what is
 *     on screen is proven current, which is also what clears the "Offline"
 *     line. No toast, no sound: the alert rules are untouched.
 *   • The poll is tuned for a fleet of door screens: a little sooner while a
 *     book is open (so a change shows within ~20 s), a random spread so
 *     screens never tick in step, a backoff while the server cannot be
 *     reached (and a random wait when the network comes back), and one
 *     request per wake however many wake events the browser fires.
 *
 * This module is the meeting point: BookSection says which day it shows and
 * the revision of the book it has (watchBook); the poll in useLiveAlerts reads
 * that, asks, and answers with window events BookSection listens to. Plain
 * functions and events, so either side can be tested alone.
 */

/** The server's book for the watched day equals the one on screen. */
export const BOOK_FRESH_EVENT = "bonbox-book-fresh";
/** The poll could not reach BonBox; detail: { failures } (consecutive). */
export const BOOK_UNREACHABLE_EVENT = "bonbox-book-unreachable";

/** A book is open: a change made elsewhere shows within ~20 s (+ the reload). */
export const BOOK_POLL_MS = 18000;
/** No book open: the live alerts' own cadence. */
export const ALERT_POLL_MS = 20000;
/** Longest wait while BonBox cannot be reached. */
export const MAX_BACKOFF_MS = 120000;
/** Each wait is shortened by up to this share, at random, so screens spread. */
export const POLL_SPREAD = 0.2;
/** One request per wake: visibility, pageshow and focus often fire together. */
export const WAKE_GAP_MS = 4000;
/** The full reload kept as a safety net once revisions are known to work… */
export const SAFETY_RELOAD_MS = 120000;
/** …and the old cadence against a server that does not send them yet. */
export const LEGACY_RELOAD_MS = 75000;

let watched = null; // { id, day, rev }

/**
 * BookSection: "I show `day`, and the book I have carries `rev`" (null while
 * loading, or from a server too old to send one). The newest caller wins —
 * there is one book on a page.
 */
export function watchBook(id, day, rev = null) {
  if (!id || !day) return;
  watched = { id, day: String(day), rev: rev ? String(rev) : null };
}

/** BookSection unmounting (or the stand being unpaired): stop asking. */
export function unwatchBook(id) {
  if (watched && watched.id === id) watched = null;
}

/** { day, rev } of the book on screen, or null. */
export function watchedBook() {
  return watched ? { day: watched.day, rev: watched.rev } : null;
}

/**
 * How long until the next poll.
 *   failures 0 or 1 → the normal wait (one blip does not slow recovery);
 *   2, 3, 4 …       → doubling, up to MAX_BACKOFF_MS.
 * Every wait is shortened by up to POLL_SPREAD at random: a fleet of screens
 * that all lost the server together (a deploy, a router reboot) comes back
 * spread out, and a healthy book is never asked later than its full wait.
 */
export function nextPollDelay({ failures = 0, bookOpen = false, random = Math.random } = {}) {
  const base = bookOpen ? BOOK_POLL_MS : ALERT_POLL_MS;
  const n = Math.max(0, Number(failures) || 0);
  const span = n <= 1 ? base : Math.min(base * 2 ** (n - 1), MAX_BACKOFF_MS);
  let r = 0;
  try {
    r = Number(random());
  } catch {
    r = 0;
  }
  if (!Number.isFinite(r) || r < 0) r = 0;
  if (r > 1) r = 1;
  return Math.round(span * (1 - POLL_SPREAD * r));
}

/** The safety-net full reload: slower once the revision check is known to work. */
export function safetyReloadMs(revLive, random = Math.random) {
  const span = revLive ? SAFETY_RELOAD_MS : LEGACY_RELOAD_MS;
  let r = 0;
  try {
    r = Number(random());
  } catch {
    r = 0;
  }
  if (!Number.isFinite(r) || r < 0) r = 0;
  if (r > 1) r = 1;
  return Math.round(span * (1 - POLL_SPREAD * r));
}

/**
 * The poll's answer against the book on screen:
 *   "changed" — the day moved since this screen's book was sent: reload it;
 *   "same"    — what is on screen is what the server has right now;
 *   null      — nothing to compare (no book, still loading, another day, or a
 *               server that sends no revision) — the slower reload covers it.
 */
export function bookRevVerdict(book, answer) {
  if (!book || !book.rev || !answer || typeof answer !== "object") return null;
  const rev = answer.book_rev;
  if (!rev || answer.book_day !== book.day) return null;
  return String(rev) === String(book.rev) ? "same" : "changed";
}
