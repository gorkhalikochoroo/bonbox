// Small truths the booking settings say out loud (R9, 27 Oct 2026).

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// The weekdays the BOOKING hours decide (Reservationer → Indstillinger →
// Åbningstider): "closed", "HH:MM-HH:MM", or a non-empty list of periods
// (a newer shape). The backend's reservation_service.booking_hours_days.
export function bookingHoursDays(bh) {
  if (!bh || typeof bh !== "object") return [];
  return WEEK.filter((k) => {
    const v = bh[k];
    return v === "closed" || (typeof v === "string" && v.includes("-")) || (Array.isArray(v) && v.length > 0);
  });
}

// Where the online times come from, for the hours card's one line:
//   "chairs"  — a salon: the chairs read these hours only (never Profile)
//   "booking" — saved here for every weekday: Profile hours change nothing
//   "profile" — nothing saved here, Profile hours declared: guests book on those
//   "mixed"   — some weekdays here, the rest on the Profile hours
//   "none"    — nothing anywhere (the "not saved" banner says it)
export function hoursSource({ bookingHours, hoursDeclared, isProvider }) {
  if (isProvider) return "chairs";
  const n = bookingHoursDays(bookingHours).length;
  if (n === WEEK.length) return "booking";
  if (n === 0) return hoursDeclared === true ? "profile" : "none";
  return "mixed";
}

// The Profile cards' note, from GET /business/operating-profile's
// `booking_hours` ({days, chairs_only} or null = no booking page).
export function profileHoursNote(status) {
  if (!status || typeof status !== "object") return null;
  if (status.chairs_only) return "chairs";
  const n = Array.isArray(status.days) ? status.days.length : 0;
  if (n >= WEEK.length) return "booking";
  if (n === 0) return "profile";
  return "mixed";
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// "Maks. gæster pr. tid" counts guests (R9), the new party included — so a
// party bigger than the cap gets no time online. Which party sizes does
// that leave out, given the online ceiling and the request rule (requests
// hold no table and are never paced)? {from, to} (to null = no upper end),
// or null when none.
export function pacingGap({ pacing, maxParty, requestFrom }) {
  const cap = toInt(pacing);
  if (!cap || cap < 1) return null;
  const from = cap + 1;
  const ceiling = toInt(maxParty);
  const req = toInt(requestFrom);
  let to = ceiling && ceiling >= 1 ? ceiling : null;
  if (req && req >= 1) to = to === null ? req - 1 : Math.min(to, req - 1);
  if (to !== null && to < from) return null;
  return { from, to };
}
