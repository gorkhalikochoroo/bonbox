// One clock for the room: when a party is LATE (confirmed, 5+ minutes past
// its start) or OVER TIME (seated past its booked end), and one way to say
// how much. The list, the drawer, the timeline, the floor and the strip all
// read these. They used to disagree: "49 min forsinket" beside "+49 min",
// and a table running over was red on the floor while the list, the drawer
// and the timeline said a calm green "Sidder" — so the next party was seated
// on top of it.
//
// Whole minutes, rounded DOWN, so every view says the same number.

export const LATE_GRACE_MIN = 5;

export function lateMinutes(r, nowMs, onToday = true) {
  if (!onToday || !r || r.status !== "confirmed" || !r.starts_at || !nowMs) return 0;
  const m = Math.floor((nowMs - new Date(r.starts_at).getTime()) / 60000);
  return m >= LATE_GRACE_MIN ? m : 0;
}

export function overdueMinutes(r, nowMs, onToday = true) {
  if (!onToday || !r || r.status !== "seated" || !r.ends_at || !nowMs) return 0;
  const m = Math.floor((nowMs - new Date(r.ends_at).getTime()) / 60000);
  return m >= 1 ? m : 0;
}

// "+12 min", "+2 t 05", "+3 d" — short enough for a 2-top on the floor.
// "+2940m over" was a party seated two days ago that nobody cleared.
export function overByText(t, m) {
  if (m < 60) return t("rsvpOverBy", "+{n} min", { n: m });
  if (m < 1440) return t("rsvpOverByHours", "+{h} h {m}", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
  return t("rsvpOverByDays", "+{n} d", { n: Math.floor(m / 1440) });
}
