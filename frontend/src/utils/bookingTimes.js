// Bookable start times for the owner's own pickers (New booking, Edit, the
// waitlist's Book row). One copy, so the three never disagree about what
// "open" means.

// 15-minute slots across the business day, 06:00–23:45 (06:00 is the
// app-wide business-day cutoff). The backend's auto-assign stays the source
// of truth on submit — this only decides what the picker offers.
export const QUARTER_TIMES = (() => {
  const out = [];
  const pad = (n) => String(n).padStart(2, "0");
  for (let m = 6 * 60; m <= 23 * 60 + 45; m += 15) {
    out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  }
  return out;
})();

// open_hours from /reservations/settings is keyed mon…sun.
export const WEEKDAY_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// "19:00" → "19.00": how every time reads on screen (the Danish way, and
// what the book's own fmtTime prints). Values sent to the API keep the colon.
export const hm = (hhmm) => String(hhmm ?? "").replace(":", ".");

export const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

// How long a party holds its table — the server's rule (smallest tier that
// fits; above the last tier, the largest tier's time; no tiers → default).
export function sittingMinutes(party, rules) {
  const tiers = (Array.isArray(rules?.turn_time_tiers) ? rules.turn_time_tiers : [])
    .filter((tr) => tr?.up_to && tr?.minutes)
    .sort((a, b) => a.up_to - b.up_to);
  const def = Number(rules?.default_duration_min) || 90;
  if (!tiers.length) return def;
  const fit = tiers.find((tr) => party <= tr.up_to);
  return fit ? Number(fit.minutes) : Math.max(Number(tiers[tiers.length - 1].minutes), def);
}

// Window [a, b) in minutes, a close at or before the open meaning "past
// midnight"; a time before the open is read as after midnight.
function inWindow([a, b], hhmm) {
  const start = toMin(a);
  const end = toMin(b) <= start ? toMin(b) + 1440 : toMin(b);
  const t0 = toMin(hhmm) < start ? toMin(hhmm) + 1440 : toMin(hhmm);
  return { start, end, t0 };
}

// The day's open windows ([["11:30","22:00"]]), [] when closed, null when
// no hours were loaded.
export function windowsFor(dateIso, openHours) {
  const key = WEEKDAY_KEY[new Date(`${dateIso}T12:00:00`).getDay()];
  return openHours && Array.isArray(openHours[key]) ? openHours[key] : null;
}

// The window a start falls in, or null.
export function windowAt(wins, hhmm) {
  if (!Array.isArray(wins) || !hhmm) return null;
  return wins.find((w) => {
    const { start, end, t0 } = inWindow(w, hhmm);
    return t0 >= start && t0 < end;
  }) || null;
}

// The venue's bookable times for a date (booking hours, else opening hours).
// A start counts only if the whole sitting ends by closing: 21:45 was
// offered for a 22:00 close and then always refused. known=false means no
// hours were loaded — the caller shows every quarter rather than nothing.
export function openTimesFor(dateIso, openHours, sitting = 0) {
  const wins = windowsFor(dateIso, openHours);
  if (!wins) return { times: QUARTER_TIMES, closed: false, known: false };
  if (wins.length === 0) return { times: QUARTER_TIMES, closed: true, known: true };
  const fits = (q, s) => wins.some((w) => {
    const { start, end, t0 } = inWindow(w, q);
    return t0 >= start && t0 + s <= end;
  });
  let times = QUARTER_TIMES.filter((q) => fits(q, sitting));
  if (!times.length) times = QUARTER_TIMES.filter((q) => fits(q, 0));
  return { times: times.length ? times : QUARTER_TIMES, closed: false, known: true };
}

// True when the start is inside an open window but the sitting runs past its
// close — the one reason an empty room still refuses a time.
export function overrunsClose(wins, hhmm, sitting) {
  if (!Array.isArray(wins) || !hhmm || !sitting) return false;
  return wins.some((w) => {
    const { start, end, t0 } = inWindow(w, hhmm);
    return t0 >= start && t0 < end && t0 + sitting > end;
  });
}
