/**
 * Pure helpers for the public reservation confirmation.
 *
 * Split out of ReservationPublicPage so they can be tested directly: the
 * .ics builder has real logic (RFC 5545 escaping, byte-accurate line
 * folding, hour/day rollover on the end time) and a silent bug there
 * writes a wrong time into a guest's calendar — a no-show the venue
 * never sees coming.
 */

// Owners type the city into the address line as well as the city field —
// a Danish address ends "2500 Valby" and the city field then says "Valby",
// so joining both blindly printed "Valbygårdsvej 1, 2500 Valby, Valby" on
// the confirmation. Compare comma-separated parts rather than substrings:
// "Valbygårdsvej 1" must NOT be treated as containing "Valby", and a
// word-boundary regex cannot be used because \b does not recognise æøå.
export function venueAddress(address, city) {
  const a = (address || "").trim();
  const c = (city || "").trim();
  if (!a) return c;
  if (!c) return a;
  const cl = c.toLowerCase();
  const alreadyThere = a
    .split(",")
    .some((part) => {
      const pt = part.trim().toLowerCase();
      return pt === cl || pt.endsWith(` ${cl}`);   // "2500 valby"
    });
  return alreadyThere ? a : `${a}, ${c}`;
}

// ── Add to calendar ──────────────────────────────────────────────────
// A confirmed table the guest forgets is a no-show, which costs the venue
// the covers and the guest the evening. One tap writes it to their own
// calendar, entirely client-side — no booking data leaves the page.
//
// Times are naive Europe/Copenhagen wall-clock (the engine's frame), so
// the event carries TZID + a real VTIMEZONE rather than being converted
// against the phone's own timezone: a guest travelling to Copenhagen
// would otherwise get an entry shifted by their home offset.
const ICS_TZ_BLOCK = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Copenhagen",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

// RFC 5545 TEXT escaping. A venue called "Bord, Bar & Køkken" or an
// address with a comma would otherwise split the field and corrupt the
// event on import.
function icsText(v) {
  return String(v || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 caps a content line at 75 octets; longer lines must be folded
// onto continuation lines starting with a space. Measured in BYTES, not
// characters — "æ" is two, and folding mid-character corrupts the file.
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = " ";           // continuation marker
      curBytes = 1;
      limit = 75;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function buildIcs({ uid, day, time, minutes, summary, location, description }) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const [h, m] = String(time).split(":").map(Number);
  const dayDigits = String(day).replace(/-/g, "");
  const pad = (n) => String(n).padStart(2, "0");
  const start = `${dayDigits}T${pad(h)}${pad(m)}00`;
  // End is computed on a UTC clock purely to roll the hour/day over
  // correctly; the wall-clock digits it produces are what we emit under
  // TZID, so no offset is ever applied to the guest's actual time.
  const endAt = new Date(Date.UTC(
    Number(dayDigits.slice(0, 4)),
    Number(dayDigits.slice(4, 6)) - 1,
    Number(dayDigits.slice(6, 8)),
    h, m + (minutes || 120),
  ));
  const end =
    `${endAt.getUTCFullYear()}${pad(endAt.getUTCMonth() + 1)}${pad(endAt.getUTCDate())}` +
    `T${pad(endAt.getUTCHours())}${pad(endAt.getUTCMinutes())}00`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BonBox//Reservation//DA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...ICS_TZ_BLOCK,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/Copenhagen:${start}`,
    `DTEND;TZID=Europe/Copenhagen:${end}`,
    `SUMMARY:${icsText(summary)}`,
    location ? `LOCATION:${icsText(location)}` : null,
    description ? `DESCRIPTION:${icsText(description)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

