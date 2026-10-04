/**
 * View-only quick ranges for the Hours hub — "Denne uge · Sidste uge · Denne
 * måned · Sidste måned".
 *
 * WHY. Asked for "last week", all three testers opened the period sheet and
 * tapped "Hver uge (man.–søn.)" — which SAVES the venue's pay period for Timer
 * and Løn. Looking at a week must never rewrite a setting. These ranges are
 * only ever a window on screen (StaffHoursPage applyCustomRange, frame
 * "custom"); nothing here posts anything.
 *
 * Same calendar arithmetic as the Drikkepenge presets (StaffTipsPage
 * presetRange): local days built from their parts at noon, so no daylight-
 * saving shift or UTC midnight can move a date; weeks start on Monday. Unlike
 * a tip pool, a week here is the whole week (Monday–Sunday), because Timer
 * also shows the planned shifts still ahead in it.
 */
import { localIso } from "./dateFormat";

function atNoon(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

export function shiftIso(iso, days) {
  const d = atNoon(iso);
  d.setDate(d.getDate() + days);
  return localIso(d);
}

export function mondayOf(iso) {
  return shiftIso(iso, -((atNoon(iso).getDay() + 6) % 7));
}

function monthOf(iso, offset = 0) {
  const d = atNoon(iso);
  const first = new Date(d.getFullYear(), d.getMonth() + offset, 1, 12);
  const last = new Date(d.getFullYear(), d.getMonth() + offset + 1, 0, 12);
  return { from: localIso(first), to: localIso(last) };
}

export const VIEW_RANGES = [
  { id: "thisWeek", key: "hovRangeThisWeek", fallback: "This week" },
  { id: "lastWeek", key: "hovRangeLastWeek", fallback: "Last week" },
  { id: "thisMonth", key: "hovRangeThisMonth", fallback: "This month" },
  { id: "lastMonth", key: "hovRangeLastMonth", fallback: "Last month" },
];

/** {from, to} for a quick range, relative to the BUSINESS day `todayIso`. */
export function viewRange(id, todayIso) {
  if (id === "thisWeek") {
    const monday = mondayOf(todayIso);
    return { from: monday, to: shiftIso(monday, 6) };
  }
  if (id === "lastWeek") {
    const monday = shiftIso(mondayOf(todayIso), -7);
    return { from: monday, to: shiftIso(monday, 6) };
  }
  if (id === "lastMonth") return monthOf(todayIso, -1);
  return monthOf(todayIso, 0);       // thisMonth
}

/** Which quick range a window IS, if any — so the sheet can mark it. */
export function matchViewRange(from, to, todayIso) {
  if (!from || !to) return null;
  const hit = VIEW_RANGES.find((r) => {
    const w = viewRange(r.id, todayIso);
    return w.from === from && w.to === to;
  });
  return hit ? hit.id : null;
}

/**
 * How Previous / Next should step a one-off window: a whole calendar month
 * steps month by month (1.–30. sep. → 1.–31. okt., never 30 days), a Monday-
 * started week steps by 7, anything else by its own length (null).
 */
export function stepUnit(from, to) {
  if (!from || !to) return null;
  const m = monthOf(from, 0);
  if (m.from === from && m.to === to) return "month";
  if (mondayOf(from) === from && shiftIso(from, 6) === to) return "week";
  return null;
}

/** The window one unit before (dir = -1) or after (dir = 1). */
export function stepWindow(unit, from, dir) {
  if (unit === "month") return monthOf(from, dir);
  if (unit === "week") {
    const monday = shiftIso(from, 7 * dir);
    return { from: monday, to: shiftIso(monday, 6) };
  }
  return null;
}
