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
// midnight"; a time before the open is read as after midnight. A window may
// carry the owner's last booking time third (R8: ["17:30", "22:00", "21:00"]);
// `last` is then its minute on the same line, else null.
function inWindow([a, b, l], hhmm) {
  const start = toMin(a);
  const end = toMin(b) <= start ? toMin(b) + 1440 : toMin(b);
  const t0 = toMin(hhmm) < start ? toMin(hhmm) + 1440 : toMin(hhmm);
  let last = null;
  if (l) {
    const x = toMin(l) < start ? toMin(l) + 1440 : toMin(l);
    if (x <= end) last = x;
  }
  return { start, end, t0, last };
}

// The owner's own booking may start in the window when the sitting ends by
// closing, or — R8 — by the window's last booking time, even if the party
// then stays past closing (reservation_service.owner_windows).
function ownerFits(w, hhmm, sitting) {
  const { start, end, t0, last } = inWindow(w, hhmm);
  return t0 >= start && (t0 + sitting <= end || (last != null && t0 <= last));
}

// The hours the owner's pickers may treat as KNOWN, from GET
// /reservations/settings. When the owner never declared hours
// (hours_declared: false) the server answers open_hours {mon: [], …} — seven
// empty lists — and treats bookings as the owner's call (reservations.py: no
// hours check at all). Read literally, those empty lists say "closed every
// day", and a brand-new café saw "I har lukket den dag." on every date of its
// first phone booking. Undeclared hours are UNKNOWN, not closed: null, which
// openTimesFor already answers with every quarter and closed:false.
export function bookableHoursFromSettings(data) {
  if (!data || data.hours_declared === false) return null;
  return data.open_hours || null;
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
  const fits = (q, s) => wins.some((w) => ownerFits(w, q, s));
  let times = QUARTER_TIMES.filter((q) => fits(q, sitting));
  if (!times.length) times = QUARTER_TIMES.filter((q) => fits(q, 0));
  return { times: times.length ? times : QUARTER_TIMES, closed: false, known: true };
}

// True when the start is inside an open window but the sitting runs past its
// close — the one reason an empty room still refuses a time. Not when the
// window's last booking time (R8) allows that start.
export function overrunsClose(wins, hhmm, sitting) {
  if (!Array.isArray(wins) || !hhmm || !sitting) return false;
  if (wins.some((w) => ownerFits(w, hhmm, sitting))) return false;
  return wins.some((w) => {
    const { start, end, t0 } = inWindow(w, hhmm);
    return t0 >= start && t0 < end && t0 + sitting > end;
  });
}
