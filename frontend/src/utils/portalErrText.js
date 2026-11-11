/**
 * portalErrText — a staff-portal error in the staffer's language.
 *
 * The swap, give-away, sick-call and profile endpoints answer a refusal with
 * a plain English sentence in `detail` (shift_swap_service.py,
 * sick_call_service.py, routers/staff_portal.py). errText passes that through
 * word for word, which is fine in English and leaks English into the Danish
 * app ("This shift has already been taken." on a Danish screen).
 *
 * The client maps the sentences it knows to its own keys, the way
 * swapErrText already maps the structured swap_overlap code. A sentence it
 * does not know (a new or reworded server message) still goes through
 * errText exactly as before, so nothing is lost; it only reads in English
 * until it is added here. Matching is on the exact server text: if the
 * server rewords one, it falls back to that text rather than to a wrong one.
 */
import { errText } from "./errText";
import { formatHours } from "./hours";

/** Exact server sentence → [key, English fallback]. Every key has en + da. */
export const PORTAL_SERVER_ERRORS = {
  // shift_swap_service.py — give-aways
  "This shift has already been taken.": ["portalSrvErrTaken", "Someone just took this shift."],
  "You can't take your own shift — withdraw it instead.": ["portalSrvErrOwnShift", "This is your own shift — withdraw it instead."],
  "Give-away not found.": ["portalSrvErrGiveawayGone", "This shift is no longer being given away."],
  "The shift has changed since it was offered; ask them to re-offer.": ["portalSrvErrGiveawayChanged", "The shift has changed since it was offered — ask your colleague to offer it again."],
  "This shift is already in the past.": ["portalSrvErrShiftPast", "This shift is already over."],
  "You already work an overlapping shift that day.": ["portalSrvErrOverlap", "You already work at that time."],
  "Can't give away a shift that's already in the past.": ["portalSrvErrGiveawayPast", "You can't give away a shift that's already over."],
  // shift_swap_service.py — proposing a swap; sick_call_service.py
  "That shift doesn't belong to you.": ["portalSrvErrNotYours", "That shift isn't yours."],
  "You can't swap with yourself.": ["portalSrvErrSwapSelf", "You can't swap with yourself."],
  "Pick a different shift to swap.": ["portalSrvErrSwapSame", "Pick a different shift to swap."],
  "Target staff not found.": ["portalSrvErrColleagueGone", "We couldn't find that colleague."],
  "Can't swap a shift that's already in the past.": ["portalSrvErrSwapPast", "You can't swap a shift that's already over."],
  // sick_call_service.py
  "The shift you picked is on a different date than the absence date.": ["portalSrvErrSickShiftDate", "The shift you picked is on a different day."],
  // routers/staff_portal.py — profile save
  "Invalid email format": ["portalSrvErrEmail", "That email address doesn't look right."],
  "Invalid phone format. Use international format e.g. +4512345678": ["portalSrvErrPhone", "That phone number doesn't look right. Use the international format, e.g. +4512345678."],
};

/** Server sentences with a number in them. */
export const PORTAL_SERVER_ERROR_PATTERNS = [
  {
    // shift_swap_service.py: f"... weekly limit ({week_hours:.1f} of {cap:.0f} hours)."
    re: /^Taking this shift would put you over your weekly limit \((\d+(?:\.\d+)?) of (\d+(?:\.\d+)?) hours\)\.$/,
    key: "portalSrvErrWeeklyLimit",
    fallback: "Taking this shift would put you over your weekly limit ({h} of {cap}).",
    vars: (m, lang) => ({
      h: formatHours(Number(m[1]), { lang, decimals: 1 }),
      cap: formatHours(Number(m[2]), { lang, decimals: 1 }),
    }),
  },
  {
    // sick_call_service.py: f"Date is too far in the past (max {N} days back). ..."
    re: /^Date is too far in the past \(max (\d+) days back\)/,
    key: "portalSrvErrSickTooOld",
    fallback: "That date is too far back (at most {n} days). Ask your manager to log this absence.",
    vars: (m) => ({ n: m[1] }),
  },
  {
    // sick_call_service.py: f"Date is too far in the future (max {N} days ahead). ..."
    re: /^Date is too far in the future \(max (\d+) days ahead\)/,
    key: "portalSrvErrSickTooFar",
    fallback: "That date is too far ahead (at most {n} days). Check the date you picked.",
    vars: (m) => ({ n: m[1] }),
  },
];

export function portalErrText(err, t, fallback, lang = "en") {
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string") {
    const s = detail.trim();
    const hit = PORTAL_SERVER_ERRORS[s];
    if (hit) return t(hit[0], hit[1]);
    for (const p of PORTAL_SERVER_ERROR_PATTERNS) {
      const m = s.match(p.re);
      if (m) return t(p.key, p.fallback, p.vars(m, lang));
    }
  }
  return errText(err, fallback);
}

export default portalErrText;
