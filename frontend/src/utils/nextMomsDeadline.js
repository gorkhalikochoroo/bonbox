/**
 * nextMomsDeadline.js — the next real DK MOMS frist, for the landing hero.
 *
 * WHY THIS EXISTS
 *
 * The hero card and the AI panel both demonstrate the MOMS countdown, and both
 * had the answer typed into the copy: "MOMS · H1 2026 · in 36 days" beside
 * "~88.777 kr. due 1 Sept 2026". Read on 6 September 2026 that card names a
 * deadline five days in the PAST and calls it 36 days away — and 36 days from
 * that day would be 12 October, so the card also contradicted itself.
 *
 * Frozen copy in a countdown ages into a lie by construction. Rolling the date
 * forward by hand only resets the clock on the next one, so the number is
 * computed instead. Same defect class as the landing-honesty work: a claim on
 * one surface disagreeing with a fact on another — here, with the calendar.
 *
 * SCOPE, deliberately narrow. This drives MARKETING copy on a mockup, not a
 * filing. The kroner figures beside it (88.777, ~17.800/week) stay invented —
 * a mockup is allowed to show made-up money, it is not allowed to show a date
 * that has passed. The real filing engine is backend tax_service.py /
 * compute_filing_data and nothing here should ever be used for an angivelse.
 *
 * The DK half-yearly small-business fristerne are 1 March (for H2 of the prior
 * year) and 1 September (for H1). Those are the two the hero has always shown.
 */

/** The two DK half-yearly MOMS fristerne, as [month, day] — 1 Mar and 1 Sep. */
const FRIST = [
  [2, 1], // 1 March  → covers H2 of the previous year
  [8, 1], // 1 Sept   → covers H1 of this year
];

const MS_PER_DAY = 86_400_000;

/**
 * @param {Date} [now] injectable so tests are not hostage to the wall clock
 * @returns {{date: Date, daysUntil: number, periodKey: "H1"|"H2", periodYear: number}}
 */
export function nextMomsDeadline(now = new Date()) {
  // Compare on date only — a frist at 00:00 today is still "today", not passed.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const candidates = [];
  for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
    for (const [m, d] of FRIST) candidates.push(new Date(year, m, d));
  }

  // STRICTLY AFTER today, never `>=`. On the frist itself the countdown should
  // read "due today" from a live engine — but this is a marketing mockup with
  // an invented amount, and showing "0 days" beside a fabricated figure invites
  // a reader to think it is their own. Rolling to the next period keeps the
  // card truthful about the calendar.
  //
  // NOTE for whoever ports this idea into the product: the REAL countdown in
  // tax_service._get_next_deadlines drops `deadline <= today` for a different
  // reason and thereby makes its own "due today" and "overdue" states
  // unreachable. That is a bug there; it is a choice here. Do not read this
  // file as precedent for it.
  const next = candidates.filter((d) => d > today).sort((a, b) => a - b)[0];

  const daysUntil = Math.round((next - today) / MS_PER_DAY);
  // 1 March settles H2 of the previous year; 1 September settles H1 of this one.
  const isMarch = next.getMonth() === 2;
  return {
    date: next,
    daysUntil,
    periodKey: isMarch ? "H2" : "H1",
    periodYear: isMarch ? next.getFullYear() - 1 : next.getFullYear(),
  };
}

/** "1 Sept 2026" / "1. september 2026" — the frist as the hero prints it. */
export function formatFrist(date, lang = "en") {
  if (lang === "da") {
    const months = [
      "januar", "februar", "marts", "april", "maj", "juni",
      "juli", "august", "september", "oktober", "november", "december",
    ];
    return `${date.getDate()}. ${months[date.getMonth()]} ${date.getFullYear()}`;
  }
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
  ];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/** "H1 2026" / "1. halvår 2026" — the period the frist settles. */
export function formatPeriod({ periodKey, periodYear }, lang = "en") {
  if (lang === "da") {
    return `${periodKey === "H1" ? "1." : "2."} halvår ${periodYear}`;
  }
  return `${periodKey} ${periodYear}`;
}

/**
 * The weekly set-aside the card advises, DERIVED from the real days remaining.
 *
 * This has to be computed or the card stops adding up. The original copy was
 * internally coherent by accident of being written on one day: 88.777 kr over
 * ~17.800 kr/week is five weeks, which is the 36 days it claimed. Fixing only
 * the date would have left "176 days" beside "17.800 a week" — which implies
 * 445.000 kr against a stated bill of 88.777, an arithmetic contradiction on
 * the card that exists to show the product doing arithmetic for you.
 *
 * Rounded to the nearest 100 kr and printed DK-style (period thousands
 * separator), because a set-aside is advice, not an invoice — "3.500" reads as
 * guidance where "3.531" reads as a figure someone owes.
 */
export function weeklySetAside(totalKr, daysUntil) {
  const weeks = Math.max(1, daysUntil / 7);
  const per = Math.max(100, Math.round(totalKr / weeks / 100) * 100);
  return per.toLocaleString("da-DK");
}
