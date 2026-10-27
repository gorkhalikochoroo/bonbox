// Closed dates and pauses for online booking (R1 B5/B6, 24 Oct 2026) — the
// pure helpers behind components/reservations/ClosuresCard.jsx.
//
// The server owns the rules (backend reservation_service.clean_closures): ISO
// dates, at most 366 days a span, at most 60 entries, a note of at most 80
// characters. These helpers only word dates and work out the presets.
import { dateLocale } from "./guestLocale";

export const CLOSURE_NOTE_MAX = 80;

const pad = (n) => String(n).padStart(2, "0");

export function isoOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The browser's calendar day — the owner's book and the guest page read the
// same Copenhagen day for a Danish venue.
export function todayIso(now = new Date()) {
  return isoOf(now);
}

function parts(iso, lang) {
  const d = new Date(`${iso}T00:00:00`);
  const loc = dateLocale(lang);
  const strip = (x) => String(x).replace(/\.$/, "");
  return {
    wd: strip(d.toLocaleDateString(loc, { weekday: "short" })),
    day: d.getDate(),
    mon: strip(d.toLocaleDateString(loc, { month: "short" })).replace(/^Sept$/, "Sep"),
    month: d.getMonth(),
    year: d.getFullYear(),
  };
}

// "tor 24. dec" · "tor 24.–lør 26. dec" · "ons 31. dec–tor 1. jan"
// (en: "Thu 24 Dec" · "Thu 24–Sat 26 Dec" · "Wed 31 Dec–Thu 1 Jan").
export function fmtClosureRange(from, to, lang) {
  if (!from) return "";
  try {
    const en = lang === "en";
    const a = parts(from, lang);
    const one = (p, withMonth = true) =>
      en ? `${p.wd} ${p.day}${withMonth ? ` ${p.mon}` : ""}` : `${p.wd} ${p.day}.${withMonth ? ` ${p.mon}` : ""}`;
    if (!to || to === from) return one(a);
    const b = parts(to, lang);
    if (a.year === b.year && a.month === b.month) return `${one(a, false)}–${one(b)}`;
    return `${one(a)}–${one(b)}`;
  } catch {
    return to && to !== from ? `${from}–${to}` : from;
  }
}

// "2. nov" (en: "2 Nov") — for a sentence that already names the weekday
// ("Fra mandag {date}"): fmtClosureRange's "man 2. nov" said it twice
// ("Fra mandag man 2. nov", judge 27 Oct, frame 13).
export function fmtDayMonth(iso, lang) {
  if (!iso) return "";
  try {
    const p = parts(iso, lang);
    return lang === "en" ? `${p.day} ${p.mon}` : `${p.day}. ${p.mon}`;
  } catch {
    return iso;
  }
}

// The presets: the NEXT occurrence of each holiday that has not ended.
//   xmasEve  24/12           xmas  24/12–26/12           newYear 31/12–1/1
export function closurePresets(today = todayIso()) {
  const y = Number(today.slice(0, 4));
  const next = (fromMd, toMd, rollsOver = false) => {
    for (const year of [y, y + 1]) {
      const from = `${year}-${fromMd}`;
      const to = rollsOver ? `${year + 1}-${toMd}` : `${year}-${toMd}`;
      if (to >= today) return { from, to: to === from ? null : to };
    }
    return null;
  };
  return [
    { id: "xmasEve", label: "rsvpClosurePresetXmasEve", note: "rsvpClosurePresetXmasEveNote",
      ...next("12-24", "12-24") },
    { id: "xmas", label: "rsvpClosurePresetXmas", note: "rsvpClosurePresetXmasNote",
      ...next("12-24", "12-26") },
    { id: "newYear", label: "rsvpClosurePresetNewYear", note: "rsvpClosurePresetNewYearNote",
      ...next("12-31", "01-01", true) },
  ];
}

// The pause covering today ({id, from, to, kind: "pause"}), or null.
export function activePause(closures, today = todayIso()) {
  const list = Array.isArray(closures) ? closures : [];
  return list
    .filter((c) => c && c.kind === "pause" && c.from <= today && (c.to || c.from) >= today)
    .sort((a, b) => ((a.to || a.from) < (b.to || b.from) ? 1 : -1))[0] || null;
}

// The owner-facing message for a refused POST /reservations/closures.
export const CLOSURE_ERRORS = {
  end_before_start: ["rsvpClosureErrEndBeforeStart", "The end date is before the start date."],
  range_too_long: ["rsvpClosureErrTooLong", "A closed period can be at most 366 days."],
  too_many: ["rsvpClosureErrTooMany", "You can have at most 60 closed dates. Remove an old one first."],
  in_the_past: ["rsvpClosureErrPast", "That date has passed."],
};

// The closure covering `iso` (a "closed" entry wins over a pause on the same
// day — the server's closure_on), or null. R9: the owner's new-booking sheet
// says when the chosen day is closed for ONLINE booking (the owner can still
// book it — decision 3).
export function closureOn(closures, iso) {
  if (!iso) return null;
  const list = (Array.isArray(closures) ? closures : [])
    .filter((c) => c && c.from && c.from <= iso && (c.to || c.from) >= iso);
  if (list.length === 0) return null;
  list.sort((a, b) => (a.kind === "closed" ? 0 : 1) - (b.kind === "closed" ? 0 : 1) || (a.from < b.from ? -1 : 1));
  return list[0];
}
