// Who customers can book online, per day (R7, 27 Oct 2026 — rubric S5).
//
// The engine always booked one customer per chair in parallel: two stylists
// on shift, two customers at 17:00. Nothing told the owner. Now:
//
//   • Behandlere — "Hvem kan bookes": the next 7 days, one line each,
//     "2 kan bookes samtidig (dig og Mia)".
//   • Aftaler — the same line for the day the book shows.
//
// Both read GET /reservations/salon/capacity, which counts from the SAME
// windows the booking engine books on (a stylist's published shifts, or the
// opening hours for the owner's own chair and a stylist who follows them;
// Ferie / Syg take her off). "Samtidig" is the most chairs open at one
// instant — Mia 9–12 and Jonas 12–17 are one at a time, and say so.
//
// A failed read shows nothing: never a count drawn from a fetch that did not
// answer. Owner session only — the door stand never mounts these.
import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import api from "../../services/api";
import { fmtClosureRange } from "../../utils/closures";
import { ABSENCE_KIND } from "./SalonAttention";

/** "dig, Mia og Jonas" / "you, Mia, and Jonas". */
export function joinNames(names, lang) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  const loc = lang === "da" ? "da" : "en";
  try {
    return new Intl.ListFormat(loc, { style: "long", type: "conjunction" }).format(list);
  } catch {
    return list.slice(0, -1).join(", ") + (loc === "da" ? " og " : " and ") + list[list.length - 1];
  }
}

/** The names on a day, the owner's own chair first as "dig" / "you". */
export function peopleNames(day, t) {
  const people = Array.isArray(day?.people) ? day.people : [];
  return [
    ...people.filter((p) => p.self).map(() => t("rsvpCapacityYou", "you")),
    ...people.filter((p) => !p.self).map((p) => p.name),
  ];
}

/** The day's line: "2 kan bookes samtidig (dig og Mia)" and its siblings. */
export function capacityText(day, t, lang) {
  if (!day) return "";
  if (day.closed === "closed_date") {
    return day.note
      ? t("rsvpCapacityClosedNote", "Closed for online booking: {note}", { note: day.note })
      : t("rsvpCapacityClosed", "Closed for online booking");
  }
  if (day.closed === "paused") return t("rsvpCapacityPaused", "Online booking is paused");
  const names = peopleNames(day, t);
  const n = Number(day.count) || 0;
  if (n <= 0 || names.length === 0) {
    return day.hours_closed
      ? t("rsvpCapacityClosedDay", "Closed — no one can be booked")
      : t("rsvpCapacityNobody", "No one can be booked");
  }
  const list = joinNames(names, lang);
  if (names.length === 1) {
    return day.people.find((p) => p.self)
      ? t("rsvpCapacityOnlyYou", "Only you can be booked")
      : t("rsvpCapacityOnlyOne", "Only {name} can be booked", { name: list });
  }
  if (n === 1) return t("rsvpCapacityOneAtATime", "One at a time ({names} take turns)", { names: list });
  if (n < names.length) {
    return t("rsvpCapacityUpTo", "Up to {n} can be booked at the same time ({names})", { n, names: list });
  }
  return t("rsvpCapacityN", "{n} can be booked at the same time ({names})", { n, names: list });
}

/** "Fravær: Mia (Ferie)" — or "" when nobody is away. */
export function awayText(day, t) {
  const away = Array.isArray(day?.away) ? day.away : [];
  if (!away.length) return "";
  const names = away.map((a) => {
    const kind = ABSENCE_KIND[a.kind];
    return kind ? `${a.name} (${t(kind[0], kind[1])})` : a.name;
  });
  return t("rsvpCapacityAway", "Away: {names}", { names: names.join(", ") });
}

/** The hours card says closed, yet a stylist on shift can be booked (V3). */
export function hoursClosedNote(day, t) {
  return day?.hours_closed && !day?.closed && Number(day?.count) > 0
    ? t("rsvpCapacityHoursClosedShift", "Closed in your opening hours — stylists on shifts can still be booked")
    : "";
}

function useCapacity(params, key) {
  const [days, setDays] = useState(null);
  const want = useRef(key);
  useEffect(() => {
    let alive = true;
    want.current = key;
    api.get("/reservations/salon/capacity", { params })
      .then((r) => {
        if (!alive || want.current !== key) return;
        setDays(Array.isArray(r?.data?.days) ? r.data.days : null);
      })
      .catch(() => {
        if (alive && want.current === key) setDays(null);
      });
    return () => {
      alive = false;
    };
    // `key` carries every param; the object itself is new on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return days;
}

/** One line for the day the book shows (Aftaler). */
export function SalonDayCapacity({ t, lang = "da", day, refreshKey = 0 }) {
  const days = useCapacity({ start: day, days: 1 }, `${day}|${refreshKey}`);
  const d = Array.isArray(days) ? days.find((x) => x.date === day) : null;
  if (!d) return null;
  const away = awayText(d, t);
  const note = hoursClosedNote(d, t);
  return (
    <p data-testid="salon-day-capacity" className="flex items-start gap-2 text-[13px] text-gray-600 dark:text-gray-300">
      <Users className="w-4 h-4 mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0">
        {capacityText(d, t, lang)}
        {away && <span className="text-gray-500 dark:text-gray-400"> · {away}</span>}
        {note && <span className="block text-[12px] text-gray-500 dark:text-gray-400">{note}</span>}
      </span>
    </p>
  );
}

/** The next 7 days, one line each (Behandlere). */
export default function SalonWeekCapacity({ t, lang = "da", refreshKey = 0 }) {
  const days = useCapacity({ days: 7 }, `week|${refreshKey}`);
  if (!Array.isArray(days) || days.length === 0) return null;
  return (
    <section
      data-testid="salon-week-capacity"
      aria-labelledby="salon-week-capacity-title"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))]"
    >
      <div className="px-4 pt-3 pb-2.5 max-sm:px-3">
        <h2 id="salon-week-capacity-title" className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-400" strokeWidth={1.75} aria-hidden />
          {t("rsvpCapacityWeekTitle", "Who can be booked")}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {t("rsvpCapacityWeekIntro", "The next 7 days, as customers can book online.")}
        </p>
      </div>
      <ul className="border-t border-gray-100 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
        {days.map((d) => {
          const away = awayText(d, t);
          const note = hoursClosedNote(d, t);
          const open = Number(d.count) > 0;
          return (
            <li
              key={d.date}
              data-testid="salon-capacity-day"
              // Phone: the day over its line. From sm: one row, the day in a
              // fixed column so the lines start in one place.
              className="px-4 py-2.5 max-sm:px-3 grid grid-cols-1 sm:grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5"
            >
              <span className="text-[13px] font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                {fmtClosureRange(d.date, null, lang)}
              </span>
              <span className={"min-w-0 text-[13px] " + (open ? "text-gray-700 dark:text-gray-200" : "text-gray-500 dark:text-gray-400")}>
                {capacityText(d, t, lang)}
                {away && <span className="block text-[12px] text-gray-500 dark:text-gray-400">{away}</span>}
                {note && <span className="block text-[12px] text-gray-500 dark:text-gray-400">{note}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
