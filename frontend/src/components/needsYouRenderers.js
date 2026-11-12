// needsYouRenderers — the "Skal ses nu" findings' words, icons and the
// owner's dismissals, shared by NeedsYouQueue (the old Home) and the I dag
// page's "Kræver dig" card so the two can never word a finding differently or
// disagree about what the owner already dismissed. Moved verbatim from
// NeedsYouQueue.jsx (Nov 2026).
import { CalendarCheck, Landmark, FileClock, Scale, CalendarX } from "lucide-react";
import { formatKr } from "../utils/currency";
import { formatDateClear } from "../utils/dateFormat";

export const STORAGE_KEY = "bonbox_nyq_dismissed"; // { [key]: dismissedAtMs }
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORED = 120;
// Codes whose finding is anchored to a specific date → permanent dismissal,
// sent to the backend as skip tokens. Must mirror _SKIPPABLE in
// routers/diagnostics.py.
export const DATED_CODES = new Set(["close_missing", "stale_draft_close", "close_unreconciled"]);

// Stable identity per finding: the date where there is one, else the most
// distinguishing meta (a changed reservation count re-surfaces the row).
export const keyFor = (f) => `${f.code}|${f.meta?.date ?? f.meta?.provider ?? f.meta?.count ?? ""}`;

export function loadDismissed() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const now = Date.now();
    const kept = Object.entries(raw)
      .filter(([k, ts]) => {
        if (typeof ts !== "number") return false;
        // dated = permanent; ongoing conditions expire (snooze) after 7 days
        return DATED_CODES.has(k.split("|")[0]) || now - ts < SNOOZE_MS;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_STORED);
    return Object.fromEntries(kept);
  } catch {
    return {};
  }
}

// Said on the window whenever the owner dismisses a finding, so the rail's
// badges (hooks/useNavBadges) re-read with the new skip list.
export const DISMISS_EVENT = "bonbox-needs-dismissed";

/** Store one dismissal (the same key either surface uses) and say so.
 *  Returns the new map. Storage full/blocked: it still applies this session. */
export function saveDismissal(dismissed, f) {
  const next = { ...(dismissed || {}), [keyFor(f)]: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — dismissal still applies for this session */
  }
  try {
    window.dispatchEvent(new Event(DISMISS_EVENT));
  } catch {
    /* no DOM */
  }
  return next;
}

// Dated dismissals → "code:YYYY-MM-DD" CSV for the backend skip param.
export const skipParamFor = (dismissed) =>
  Object.keys(dismissed)
    .filter((k) => {
      const [code, anchor] = k.split("|");
      return DATED_CODES.has(code) && anchor;
    })
    .slice(0, 60)
    .map((k) => k.replace("|", ":"))
    .join(",");

/**
 * The day a dated finding is about, written the way an owner reads a date.
 *
 * The server sends `worst_date.isoformat()` — "2026-09-19" — and these rows
 * used to interpolate it raw, so a Danish restaurateur read a date format no
 * Dane writes. DailyClosePage already passes a formatted `dateLabel` into the
 * near-identical dcAnomalyForDate; this is the same convention.
 *
 * Returns null when the server had no date, because `String(null)` inside t()
 * renders the literal word "null" on the owner's dashboard. Callers branch to
 * a dateless sibling key, the way stale_bank_feed already branches on days.
 */
const dayLabel = (iso) => (iso ? formatDateClear(iso) : null);

// code → { icon, title(t, meta), action(t) }. Adding a detector server-side +
// a row here is all it takes to extend the queue.
export const RENDERERS = {
  unconfirmed_reservations: {
    icon: CalendarCheck,
    title: (t, m) => t("nyqUnconfirmed", "{count} booking(s) waiting for your reply", { count: m.count }),
    action: (t) => t("nyqUnconfirmedAction", "Review"),
  },
  stale_bank_feed: {
    icon: Landmark,
    title: (t, m) =>
      m.days == null
        ? t("nyqStaleFeedNever", "Your bank feed hasn't synced yet")
        : t("nyqStaleFeed", "Bank feed not synced for {days} days", { days: m.days }),
    action: (t) => t("nyqStaleFeedAction", "Open connections"),
  },
  close_missing: {
    icon: CalendarCheck,
    title: (t, m) => {
      const d = dayLabel(m.date);
      return d
        ? t("nyqCloseMissing", "You didn't close {date}", { date: d })
        : t("nyqCloseMissingNoDate", "A day is still missing its kasserapport");
    },
    action: (t) => t("nyqCloseMissingAction", "Close the day"),
  },
  // A draft kasserapport left unlocked past its day. When it doesn't tie out
  // we say so ("…der ikke stemmer") — that's the trust-critical signal: a
  // close that won't reconcile must be caught BEFORE it reaches the revisor.
  stale_draft_close: {
    icon: FileClock,
    title: (t, m) =>
      dayLabel(m.date)
        ? t("nyqStaleDraft", "Unlocked kladde from {date}{notTie} — review and lock", {
            date: dayLabel(m.date),
            notTie: m.ties_out === false ? t("nyqNotTie", ", that doesn't tie out") : "",
          })
        : t("nyqStaleDraftNoDate", "An unlocked kladde{notTie} — review and lock", {
            notTie: m.ties_out === false ? t("nyqNotTie", ", that doesn't tie out") : "",
          }),
    action: (t) => t("nyqStaleDraftAction", "Review"),
  },
  // A confirmed (locked) close whose payments clearly don't match revenue.
  close_unreconciled: {
    icon: Scale,
    title: (t, m) =>
      dayLabel(m.date)
        ? t("nyqUnreconciled", "The {date} kasserapport doesn't tie out: you took {payment} in payments but booked {revenue} in sales", {
            date: dayLabel(m.date),
            payment: formatKr(m.payment_total),
            revenue: formatKr(m.revenue_total),
          })
        : t("nyqUnreconciledNoDate", "A kasserapport doesn't tie out: you took {payment} in payments but booked {revenue} in sales", {
            payment: formatKr(m.payment_total),
            revenue: formatKr(m.revenue_total),
          }),
    action: (t) => t("nyqUnreconciledAction", "Review"),
  },
  // Your public booking page has no free slots for the next 14 days — a
  // customer who opens the link just bounces. Flagged by the public-surface
  // monitor (dead-on-arrival), surfaced here so you can fix opening hours /
  // tables. Never fires for a demo's missing name (that stays admin-only).
  public_booking_dead: {
    icon: CalendarX,
    title: (t) =>
      t("nyqBookingDead", "Your booking page has no free times for the next 14 days — customers can't book"),
    action: (t) => t("nyqBookingDeadAction", "Fix booking setup"),
  },
};

// Status-color dot per severity (palette: amber/red only; info = quiet gray).
