/**
 * Staff Portal — what your staff sees when they open their magic link.
 * Mobile-first, dark theme, no login required.
 * Route: /s/:token
 */
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";

import { useConfirm } from "../hooks/useConfirm";
import GeofenceDial from "../components/GeofenceDial";
import { nextShiftChip } from "../utils/nextShiftCountdown";
import { overlapsOwnShift } from "../utils/overlapsOwnShift";
import { swapDoubleBooks } from "../utils/swapClash";
import { orderSwapInbox, swapSides, countNeedsMyAnswer } from "../utils/swapInbox";
import { saveFile } from "../utils/download";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import { RefreshCw, CloudOff, ServerCrash, Link2Off, KeyRound, Download, FileText, Smartphone, Share, Check, X, Calendar, ArrowLeftRight, Clock, Bell, Lock, AlertTriangle, Mail, BellOff, MessageCircle, MessageSquare, Search, Send, Thermometer, StickyNote, MapPin, MapPinOff, CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, Repeat, CalendarOff, CalendarX, CalendarCheck, Plus, Users, Apple, MoreHorizontal, Navigation, Coffee, LogIn, LogOut, ArrowRight } from "lucide-react";
// The Vagtplan's two faces (Nov 2026, the Orvexlo type of BeloBag): Sora for
// display — headings, the big numbers, the time on the card, the ring timer —
// and DM Sans for all body text. They replace Manrope (display) and Inter
// (text) on the portal only; the owner app keeps Inter + Hanken.
// Self-hosted like Inter and Hanken (main.jsx): vercel.json allows fonts from
// 'self' only, so a Google Fonts link would be blocked in production. The
// latin file per weight (Danish æ ø å are in latin); extended Latin comes from
// unicode-range rules in vagtplan.css, fetched only when a name needs it.
// Imported HERE, not in main.jsx, so the faces ride the staff portal's own
// lazy chunk and no other page pays. vagtplan.css must stay the LAST of these
// imports (its latin-ext rules must follow the latin files).
import "@fontsource/sora/latin-600.css";
import "@fontsource/sora/latin-700.css";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/dm-sans/latin-700.css";
import "../components/staff/vagtplan.css";
import RollingDigits from "../components/staff/RollingDigits";
import { usePresence, useLastValue, closingProps } from "../components/staff/sheetMotion";
import { parseServerTime } from "../utils/serverTime";
import { routeUrl } from "../utils/routeUrl";
import { MAP_H, MAP_PINE_BG, mapRequestWidth, mapDpr, mapQuery, mapCacheKey, getCachedMap, setCachedMap, loadMapOnce } from "../utils/venueMapImage";
import { exportToCsv } from "../utils/exportCsv";
import portalApi, { storePinProof } from "../services/portalApi";
import { useLanguage } from "../hooks/useLanguage";
import { formatHoursMinutes, formatHours, hoursUnit } from "../utils/hours";
import { sectionFor } from "../config/roleSections";
import { errText } from "../utils/errText";
import { portalErrText } from "../utils/portalErrText";
import { formatClockDistance } from "../utils/clockDistance";
import { roleName } from "../utils/roleNames";
import { isNativeApp, platform } from "../utils/platform";
import { applyVagtplanIcons } from "../lib/vagtplanIcons";
import { capturePhoto } from "../utils/camera";
import { Camera as CameraIcon, Trash2, PencilLine, MinusCircle } from "lucide-react";
import { haptic } from "../utils/haptics"; // no-op on web; physical feedback in the iOS shell
import useNativePush, { unregisterNativePush } from "../hooks/useNativePush";
import { useKeyboardState } from "../hooks/useKeyboardLift";
import { useAndroidBack, minimizeApp } from "../hooks/useAndroidBack";
import { runAndroidBack } from "../utils/androidBack";
import { useKeyboardReveal, KB_LIFT_STYLE } from "../hooks/useKeyboardReveal";
import { usePortalStream } from "../hooks/usePortalStream";
import { App as CapApp } from "@capacitor/app";
import { PhotoGrid, PendingPhotos, AttachButton, usePhotoPicker } from "../components/staff/chatPhotoKit";

// BonBox forest + paper (index.css --color-bb-forest / --color-bb-paper). Home
// v3 (Nov 2026): the next-shift card, the PIN gate, the Timer card, the profile
// card and the floating tab bar are ONE flat forest material — no gradient, no
// bloom, no sheen. Literal hex, not a Tailwind green-*: index.css remaps every
// green-* class to the owner's theme accent, and this is the brand's own ink.
//
// "Pine, ivory & brass" (the owner's canvas, Nov 2026): the forest became the
// canvas's pine and the paper its cream, so the PIN gate, the Timer card and
// the profile card stay one material with the restyled home.
const FOREST = "#0E3B2E";
const PAPER = "#F3EFE4";

// The canvas palette, by name. Literal hex for the same reason as above.
const PINE = FOREST;
const CREAM = PAPER;           // text on pine
const SAGE = "#A9B8AE";        // quiet text on pine
const BRASS = "#C8A464";       // the one accent: the card's main button, today's dot
const BRASS_INK = "#7A5C24";   // brass as text on ivory ("Ledig vagt")
const IVORY = "#F6F4EE";       // the page
const CARD = "#FFFEFB";        // cards and sheets
const TILE = "#F1EEE6";        // date tiles, the sheet's close button
const ROW = "#F4F1EA";         // a shift row inside the week card
const SOFT = "#E3ECE6";        // pale pine: "Tag den", icon wells
const LINE = "#E8E3D8";        // card borders
const DIVIDER = "#EEEAE0";
const INK = "#16211C";
const MUTED = "#5E6A63";
const LINK = "#1F5A45";
// Terracotta: "kan ikke" — the home strip and both Fravær calendars (see the
// colour note above the Fravær looks).
const RED_INK = "#A4452F";
const RED_WASH = "#F6E3DC";
// Sora, the display face (vagtplan.css maps var(--font-display) to the same
// stack on the portal). Literal, so an inline style names its face outright.
const SORA = "'Sora', 'DM Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// One-per-PAGE-LOAD latch for the hero's ceremonial settle beat. Module scope
// on purpose: switching tabs remounts ScheduleTab, and the beat must not
// replay on every return to the Schedule tab — only on a fresh load.
let heroBeatPlayed = false;


// ─── Push subscription helpers (Staff v2, 2026-05-28) ───────────────────
//
// urlBase64ToUint8Array — VAPID public keys arrive as base64url strings.
// PushManager.subscribe() requires Uint8Array. Standard polyfill, no deps.
function _urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function _isStandalone() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (window.navigator?.standalone === true) return true;
  } catch { /* SSR / sandbox */ }
  return false;
}

function _isIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIosUa = /iPad|iPhone|iPod/.test(ua);
  const isIpadOs =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;
  return isIosUa || isIpadOs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/* Dates follow the CHOSEN app language, not the phone locale — otherwise
   the DA/EN toggle flips the words but leaves "Thu 2 Jul" English.
   English pins to en-GB so ordering stays day-first ("Thu 2 Jul"). */
function localeFor(lang) {
  if (lang === "da") return "da-DK";
  if (lang === "en") return "en-GB";
  return lang || undefined;
}

// Danish weekday abbreviations in ONE style: three letters and a period,
// "man. tir. ons. tor. fre. lør. søn." — the house style ("tor. 8. okt.").
// ICU's da-DK mixes lengths ("tirs.", "tors."), writes "ons. den 7." for
// weekday+day, and the Kan ikke strip stripped its own copy to "tir": three
// spellings of one weekday in one app. Other languages keep ICU's.
const DA_WEEKDAYS = ["man.", "tir.", "ons.", "tor.", "fre.", "lør.", "søn."];

function wdShort(dt, lang) {
  if (lang === "da") return DA_WEEKDAYS[(dt.getDay() + 6) % 7];
  return dt.toLocaleDateString(localeFor(lang), { weekday: "short" });
}

/** "tor. 8." / "Thu 8" — weekday + day of month, for rows under a week. */
function fmtWeekdayDay(d, lang) {
  const dt = new Date(d + "T00:00:00");
  if (lang === "da") return `${wdShort(dt, lang)} ${dt.getDate()}.`;
  return dt.toLocaleDateString(localeFor(lang), { weekday: "short", day: "numeric" });
}

function fmtDate(d, lang) {
  const dt = new Date(d + "T00:00:00");
  if (lang === "da") {
    return `${wdShort(dt, lang)} ${dt.getDate()}. ${dt.toLocaleDateString("da-DK", { month: "short" })}`;
  }
  return dt.toLocaleDateString(localeFor(lang), { weekday: "short", day: "numeric", month: "short" });
}

function fmtShort(d, lang) {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString(localeFor(lang), { day: "numeric", month: "short" });
}

/** The header's date line: "Onsdag 11. november" / "Wednesday 11 November".
    Built by hand in Danish: ICU's da-DK writes "onsdag den 11. november". */
function fmtHeaderDate(lang, now = new Date()) {
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  if (lang === "da") {
    return `${cap(now.toLocaleDateString("da-DK", { weekday: "long" }))} ${now.getDate()}. ${now.toLocaleDateString("da-DK", { month: "long" })}`;
  }
  if (lang === "en") {
    return `${now.toLocaleDateString("en-GB", { weekday: "long" })} ${now.getDate()} ${now.toLocaleDateString("en-GB", { month: "long" })}`;
  }
  return cap(now.toLocaleDateString(localeFor(lang), { weekday: "long", day: "numeric", month: "long" }));
}

/** The week card's title: "9.–15. november" (one month) or
    "27. okt. – 2. nov." (two); English "9–15 November" / "27 Oct – 2 Nov". */
function fmtWeekRange(startIso, lang) {
  const a = new Date(startIso + "T12:00:00");
  const b = new Date(addDays(startIso, 6) + "T12:00:00");
  const same = a.getMonth() === b.getMonth();
  if (lang === "da") {
    const mon = (d, month) => d.toLocaleDateString("da-DK", { month });
    return same
      ? `${a.getDate()}.–${b.getDate()}. ${mon(b, "long")}`
      : `${a.getDate()}. ${mon(a, "short")} – ${b.getDate()}. ${mon(b, "short")}`;
  }
  if (lang === "en") {
    const mon = (d, month) => d.toLocaleDateString("en-GB", { month });
    return same
      ? `${a.getDate()}–${b.getDate()} ${mon(b, "long")}`
      : `${a.getDate()} ${mon(a, "short")} – ${b.getDate()} ${mon(b, "short")}`;
  }
  return `${fmtShort(startIso, lang)} – ${fmtShort(addDays(startIso, 6), lang)}`;
}

/** "Sofie, Oliver og Ida" / "Sofie, Oliver and Ida". */
function listNames(names, lang) {
  const list = (names || []).filter(Boolean);
  try {
    return new Intl.ListFormat(localeFor(lang) || "en-GB", { style: "long", type: "conjunction" }).format(list);
  } catch {
    return list.join(", ");
  }
}

/** A worked duration read like a clock: "2:16". */
function fmtClockHM(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** The shift the staffer is clocked in FOR — the published shift on today or
    yesterday (overnight) whose planned window holds the clock-in time (from
    3 h before its start to its end), the nearest start winning. null for a
    clock-in with no planned shift: the live card then draws no plan rather
    than borrowing the wrong one. `since` is the server's "HH:MM" clock-in. */
function liveShiftOf(shifts, since, now = new Date()) {
  if (!since || !/^\d{1,2}:\d{2}$/.test(since)) return null;
  const today = toLocalISO(now);
  const yesterday = addDays(today, -1);
  let inAt = new Date(`${today}T${since.padStart(5, "0")}:00`);
  if (inAt.getTime() > now.getTime() + 60000) inAt = new Date(`${yesterday}T${since.padStart(5, "0")}:00`);
  let best = null;
  for (const s of shifts || []) {
    if (!s?.start_time || (s.date !== today && s.date !== yesterday)) continue;
    const start = new Date(`${s.date}T${s.start_time}:00`);
    const end = s.end_time ? new Date(`${s.date}T${s.end_time}:00`) : null;
    if (!end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end <= start) end.setDate(end.getDate() + 1);
    if (inAt.getTime() < start.getTime() - 3 * 3600000 || inAt > end) continue;
    const gap = Math.abs(inAt - start);
    if (!best || gap < best.gap) best = { shift: s, start, end, gap, inAt };
  }
  return best;
}

// Monday-first short weekday names in the chosen language (2024-01-01 = a Monday).
function weekdayNames(lang) {
  return Array.from({ length: 7 }, (_, i) => wdShort(new Date(2024, 0, 1 + i), lang));
}

/** The weekday in full, Monday = 0 ("Sunday" / "søndag"), for a sentence:
    "every Sun." read as an abbreviation, and Danish "hver søn." also reads
    "every son". */
function weekdayLong(i, lang) {
  return new Date(2024, 0, 1 + i).toLocaleDateString(localeFor(lang), { weekday: "long" });
}

function toLocalISO(dt) {
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getWeekStart(d) {
  const dt = new Date(d + "T12:00:00");
  const day = dt.getDay();
  const diff = day === 0 ? 6 : day - 1;
  dt.setDate(dt.getDate() - diff);
  return toLocalISO(dt);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}

// How far the portal's week view can page: this week + 7 more, which is the
// server's window (get_portal_schedule returns week start + 55 days).
const PORTAL_WEEKS_AHEAD = 7;

/** Whole weeks from the Monday `fromMonday` to the week containing `iso`.
    Noon anchors keep a DST change from rounding a week away. */
function weeksFrom(fromMonday, iso) {
  const a = new Date(fromMonday + "T12:00:00");
  const b = new Date(getWeekStart(iso) + "T12:00:00");
  return Math.round((b - a) / (7 * 86400000));
}

/** ISO-8601 week number of a YYYY-MM-DD date ("Uge 44"). */
function isoWeekNumber(iso) {
  const d = new Date(iso + "T12:00:00");
  const th = new Date(d);
  th.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));     // this week's Thursday
  const jan4 = new Date(th.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((th - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function isToday(dateStr) {
  return dateStr === toLocalISO(new Date());
}

function isPast(dateStr) {
  return dateStr < toLocalISO(new Date());
}

// Stable, order-independent signature of the PUBLISHED shifts a staff member
// is shown — used by the "Schedule updated" toast to detect a real change
// across refetches. We compare date+start+end+status only (Phase 1 keeps the
// diff generic; no per-field human diffs). Sorting makes it insensitive to
// row ordering from the API.
// { shifts: [{ shift_id, covers }] } -> { "<shift id>": 38 }.
//
// Keyed by SHIFT id — the identity /schedule already handed us — so the join
// needs no date arithmetic on this side at all. We previously keyed by day,
// which forced the client to match a server business_date against a raw
// calendar date; those diverge for every pre-cutoff shift, so the number
// silently vanished. The id cannot drift.
//
// Each count is scoped to that shift's own hours, so a lunch waiter is never
// shown the dinner covers.
function coversMapFrom(data) {
  const out = {};
  for (const s of (data && data.shifts) || []) {
    if (s && typeof s.covers === "number" && s.shift_id) out[s.shift_id] = s.covers;
  }
  return out;
}

function publishedScheduleSignature(rawShifts) {
  return (rawShifts || [])
    .filter((s) => s && s.status === "published")
    .map((s) => `${s.date}|${s.start_time}|${s.end_time}|${s.status}`)
    .sort()
    .join("~");
}


// Roles are identity, not status — in dense rows they render as neutral gray
// text. Color is reserved for status only (emerald=live, amber=warn, red=error)
// per the locked design system; a per-role rainbow + emoji read as "vibecoded".
//
// roleBarColor — NET-NEW thin SIGNAL helper. Role is rendered ONLY as a thin
// 3–4px bar / underline (left-bar in the hero, underline in the week strip +
// teammate avatars) — NEVER a flood tint. Returns a Tailwind bg-* class for
// that thin element only. Match is case-insensitive + DK/EN aware; unknown
// roles fall back to neutral gray (no rainbow). Status-color discipline holds:
// these are identity hints on a hairline, not status semantics.
function roleBarColor(role, businessType) {
  // Was a four-branch substring chain that left 3 of 6 restaurant roles on the
  // neutral gray — Dishwasher, Runner and Manager — i.e. 33 of 80 production
  // shifts, every dishwasher shift among them. It also had no idea what
  // vertical it was in, so a salon "Barber" was filed behind a bar because the
  // word contains "bar".
  //
  // Now the same archetype-keyed resolver the OWNER's schedule maker calls, so
  // the two surfaces bucket a role identically. Colour still lives here, and
  // the two maps are still decided independently — but they no longer disagree
  // about floor: this app paints it VIOLET because green is reserved
  // exclusively for live/now (the Live pill, the clocked-in ping), and the
  // owner grid moved floor onto violet too when emerald there became the
  // "seen by staff" signal. Same reasoning, arrived at twice. Only the SECTION
  // has to agree, never the palette — so this stays a local decision.
  switch (sectionFor(role, businessType)) {
    case "kitchen": return "bg-red-500";
    case "bar": return "bg-blue-500";
    case "floor": return "bg-violet-500";
    case "treatment": return "bg-violet-500";
    case "front": return "bg-blue-500";
    default: return "bg-gray-600";   // genuinely unclassified — no rainbow
  }
}

// Role names as the staffer reads them: utils/roleNames.js (imported above),
// the one map the Vagtplan and the sick-call card read too. role /
// role_on_shift is free text the owner picked, so the stored value is never
// rewritten — only what is shown; unknown roles (and the salon vocabulary,
// Danish in both languages) show exactly as typed. The portal kept its own
// older copy without barista/bartender/runner/host/cleaner, so those built-in
// roles printed raw and lowercase ("barista" beside "Tjener").

// ─── Client-side .ics (calendar) export for a single shift ─────────────────
//
// buildShiftIcs(shift, venueName, summaryFn) → a self-contained VCALENDAR
// string a staff member can add to Apple/Google Calendar from the portal.
//
// HONESTY / TIMEZONE: start_time/end_time are NAIVE "HH:MM" wall-clock strings
// in Europe/Copenhagen local time (never UTC). We emit LOCAL datetime stamps
// tagged with TZID=Europe/Copenhagen and EMBED a VTIMEZONE so the event lands
// at the right wall-clock on any client — we NEVER append 'Z' and NEVER
// UTC-convert (the naive-UTC bug class). CRLF line endings per RFC 5545.
function _icsStamp(dateStr, hhmm) {
  // "2026-06-22" + "16:00" → "20260622T160000" (local wall-clock digits)
  return `${dateStr.replace(/-/g, "")}T${(hhmm || "00:00").replace(":", "")}00`;
}

function _icsStampUtc(d) {
  // DTSTAMP is a creation marker (not the event time) — UTC 'Z' is correct here.
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// RFC 5545 §3.3.11 — escape backslash, semicolon, comma and newline in TEXT
// values so a venue like "Café Nør, Vesterbro" (comma) doesn't truncate or
// corrupt the event on strict importers (Outlook, some Android). Mirrors the
// escaper already used in TicketPage.jsx.
function _icsEsc(v) {
  return String(v || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Google Calendar "create event" deep-link — opens the native add-event screen
// prefilled. On Android / desktop / the native webview an .ics download just
// lands in Files and never opens ("add to calendar not working"); this routes
// straight to the add-event screen, one tap to save. Times are venue-local
// wall-clock with ctz=Europe/Copenhagen (DK market).
function buildGoogleCalendarUrl(shift, venueName, summary) {
  const compact = (d, hhmm) => {
    const [h, m] = (hhmm || "00:00").split(":");
    return `${(d || "").replace(/-/g, "")}T${(h || "00").padStart(2, "0")}${(m || "00").padStart(2, "0")}00`;
  };
  let endDate = shift.date;
  // Overnight shift (end <= start) → the end lands on the next calendar day.
  // Parse + advance in UTC so a local-vs-UTC offset can't roll the date back
  // a day (a Copenhagen local-midnight Date serializes to the prior UTC day).
  if ((shift.end_time || "") <= (shift.start_time || "")) {
    const dt = new Date(shift.date + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + 1);
    endDate = dt.toISOString().slice(0, 10);
  }
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: summary || "",
    dates: `${compact(shift.date, shift.start_time)}/${compact(endDate, shift.end_time)}`,
    ctz: "Europe/Copenhagen",
  });
  if (venueName) params.set("location", venueName);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}


function buildShiftIcs(shift, venueName, summary) {
  // Overnight edge: if the shift ends at/before it starts, the end is the next
  // calendar day so DTEND > DTSTART.
  const endDate =
    shift.end_time && shift.start_time && shift.end_time <= shift.start_time
      ? addDays(shift.date, 1)
      : shift.date;
  const dtStart = _icsStamp(shift.date, shift.start_time);
  const dtEnd = _icsStamp(endDate, shift.end_time);
  const uid = `bonbox-shift-${shift.id || `${shift.date}-${shift.start_time}`}@bonbox.dk`;
  const safeSummary = summary || "Vagt";
  const safeLocation = venueName || "";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BonBox//Staff Portal//DA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
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
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${_icsStampUtc(new Date())}`,
    `DTSTART;TZID=Europe/Copenhagen:${dtStart}`,
    `DTEND;TZID=Europe/Copenhagen:${dtEnd}`,
    `SUMMARY:${_icsEsc(safeSummary)}`,
    `LOCATION:${_icsEsc(safeLocation)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT60M",
    `DESCRIPTION:${_icsEsc(safeSummary)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}


// ─── PIN Gate ─────────────────────────────────────────────────────────────

/**
 * HolidaySection — feriedage, under the Ferielov.
 *
 * Replaces v2's "HOLIDAY · 12 days" tile, which had nothing behind it.
 *
 * The copy is the feature. This is days earned WHILE BONBOX HAS KNOWN THEM,
 * minus ferie recorded here — so it says "optjent siden {dato}", never "tilbage".
 * We do not know their real employment start, transferred days, or holiday
 * booked outside BonBox; only their lønsystem can state an entitlement. Showing
 * the date is what keeps the number honest, so `since` is never hidden.
 */
function HolidaySection({ token }) {
  const { t, lang } = useLanguage();
  const [h, setH] = useState(null);

  useEffect(() => {
    let alive = true;
    portalApi.get(`/portal/${token}/holiday`)
      .then((r) => { if (alive) setH(r.data); })
      .catch(() => { if (alive) setH(null); });
    return () => { alive = false; };
  }, [token]);

  if (!h) return null;

  const fmt = (n) => Number(n).toLocaleString(lang === "da" ? "da-DK" : "en-GB", {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
  // The honesty line under it still says what this counts and from when.
  const nothingYet = !(Number(h.earned) > 0) && !(Number(h.taken) > 0);
  // `partial` = the ferieår began before BonBox knew this staffer, so what we
  // hold is a floor. A bold 0,0 there (ferie taken ≥ what BonBox saw earned)
  // would read as "you have no holiday left" — the one thing it cannot claim.
  const noBalanceToShow = !!h.partial && !(Number(h.remaining) > 0);

  return (
    <div className="pt-3 border-t border-[#f1f5f9]">
      <div className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8] mb-2">
        {t("portalHolidaySection", "Holiday")}
      </div>
      {nothingYet ? (
        // Nothing earned or taken while BonBox has known them: say that in
        // words — as what BonBox has RECORDED, never as what they have earned
        // (someone who joined mid-year may have years at the café). A bare "–"
        // above "0,0 optjent · 0,0 afholdt" read as a broken value.
        <div data-testid="holiday-empty" className="text-[15px] font-bold text-gray-900 leading-snug">
          {t("portalHolidayNoneYet", "No holiday days recorded in BonBox yet")}
        </div>
      ) : (
        <>
          {noBalanceToShow ? (
            <div data-testid="holiday-no-balance" className="text-[15px] font-bold text-gray-900 leading-snug">
              {t("portalHolidayBalanceOnPayslip", "Your balance is on your lønseddel")}
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-[22px] font-bold text-gray-900 vp-figures leading-none" data-testid="holiday-remaining">
                {fmt(h.remaining)}
              </span>
              <span className="text-[12px] text-gray-500">
                {t("portalHolidayUnit", "days")}
              </span>
            </div>
          )}
          <div className="mt-1 text-[11px] text-gray-500 tabular-nums">
            {t("portalHolidayBreakdown", "{earned} earned · {taken} taken", {
              earned: fmt(h.earned), taken: fmt(h.taken),
            })}
          </div>
        </>
      )}
      {/* The honesty line. Without it the number reads as a legal balance. */}
      <div className="mt-1 text-[10px] text-gray-400">
        {t("portalHolidaySince", "Counted from {date} — what BonBox has recorded, not your full entitlement. Your lønseddel is the authority.", {
          date: new Date(h.since).toLocaleDateString(lang === "da" ? "da-DK" : "en-GB", { day: "numeric", month: "short", year: "numeric" }),
        })}
      </div>
    </div>
  );
}

/**
 * DocumentsSection — employment documents the owner has shared with this staffer.
 *
 * Download goes through portalApi as a BLOB, not an <a href>. The endpoint is
 * PIN-gated by the X-BonBox-Pin header, and an anchor cannot carry a header —
 * a plain link would 401 and look like the document had vanished.
 *
 * Nothing renders inline: the server sends Content-Disposition: attachment and
 * the CSP sets object-src 'none', so a shared PDF can never execute on the
 * app's own origin. Download-only is the containment, not a limitation.
 */
function DocumentsSection({ token }) {
  const [openSheet, setOpenSheet] = useState(false);
  const docsSheet = usePresence(openSheet);
  const { t } = useLanguage();
  const [docs, setDocs] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    portalApi.get(`/portal/${token}/documents`)
      .then((r) => { if (alive) setDocs(r.data || []); })
      .catch(() => { if (alive) setDocs([]); });
    return () => { alive = false; };
  }, [token]);

  const open = async (doc) => {
    setBusyId(doc.id); setErr("");
    try {
      const r = await portalApi.get(`/portal/${token}/documents/${doc.id}`, { responseType: "blob" });
      const out = await saveFile(r.data, doc.label || "dokument");
      if (!out.ok) setErr(t("portalDocsOpenFailed", "Couldn't open that document. Try again."));
    } catch {
      setErr(t("portalDocsOpenFailed", "Couldn't open that document. Try again."));
    } finally {
      setBusyId(null);
    }
  };

  if (docs === null) return null;            // still loading — do not flash

  return (
    <div className="pt-3 border-t border-[#f1f5f9]">
      {/* One tappable row rather than an always-open list. Empty or not, it
          behaves the same way — you can always open it, and it tells you
          there is nothing rather than the section simply not reacting. */}
      <button
        type="button"
        onClick={() => setOpenSheet(true)}
        className="w-full flex items-center justify-between gap-3"
      >
        <div className="min-w-0 text-left">
          <div className="text-[13px] font-semibold text-gray-900">
            {t("portalDocsSection", "Contract & documents")}
          </div>
          <div className="text-[11px] text-gray-400">
            {docs.length
              ? t("portalDocsCount", "{n} shared with you").split("{n}").join(String(docs.length))
              : t("portalDocsNone", "None shared yet")}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 shrink-0 text-gray-400" strokeWidth={2.5} aria-hidden />
      </button>

      {docsSheet.mounted && createPortal(
        <div className="fixed inset-0 z-[60] m-0 flex items-end vp-scrim" style={{ background: "rgba(8,14,22,.45)" }} onClick={() => setOpenSheet(false)} {...closingProps(docsSheet.closing)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("portalDocsSection")}
            className="w-full bg-white vp-sheet"
            style={{ borderRadius: "24px 24px 0 0", padding: "18px 16px calc(18px + env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto" style={{ width: 38, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
            <div style={{ marginTop: 14, font: "700 17px/1.2 var(--font-display)", color: "#0f172a" }}>
              {t("portalDocsSection", "Contract & documents")}
            </div>

            {docs.length === 0 ? (
              <div style={{ marginTop: 10, font: "400 12px/1.5 var(--font-text)", color: "#64748b" }}>
                {t("portalDocsEmpty", "Nothing here yet. Your contract and lønsedler appear here when your manager shares them.")}
              </div>
            ) : (
              <div className="space-y-1.5" style={{ marginTop: 14 }}>
                {docs.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => open(d)}
                    disabled={busyId === d.id}
                    className="w-full flex items-center gap-2 px-3 py-3 rounded-2xl bg-[#f5f8fb] border border-[#e8edf3] text-left hover:bg-gray-100 transition disabled:opacity-50"
                  >
                    <FileText className="w-4 h-4 shrink-0 text-gray-400" />
                    <span className="flex-1 min-w-0 text-[13px] font-semibold text-gray-900 truncate">{d.label}</span>
                    <Download className="w-4 h-4 shrink-0 text-gray-400" />
                  </button>
                ))}
              </div>
            )}
            {err && <p className="mt-2 text-[12px] text-red-600">{err}</p>}

            <button
              type="button"
              onClick={() => setOpenSheet(false)}
              className="w-full"
              style={{ marginTop: 16, padding: "12px 0", font: "600 13px/1 var(--font-text)", color: "#64748b" }}
            >
              {t("close", "Close")}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * BankSection — the staffer's own bank account (reg-nr + kontonummer).
 *
 * Lives inside the PIN-gated profile editor because it is the most sensitive
 * thing on this phone. Three rules shape the whole component:
 *
 *  1. NEVER RENDER THE FULL NUMBER. The server only ever sends the last 4, so
 *     there is nothing here to accidentally leak — the display path physically
 *     cannot show more. Re-entering the whole account is the price of changing
 *     it, which is correct: it is also how you confirm you meant to.
 *  2. VALIDATION IS THE SERVER'S. staff_bank.normalise() is the single source of
 *     truth; we map its `code` to a Danish sentence rather than re-implementing
 *     the rules here, so the two can never disagree.
 *  3. NO DEAD ENDS. A 503 (storage not configured) says so plainly instead of
 *     failing as "something went wrong" — the staffer needs to know their
 *     account was NOT saved.
 */
export function BankSection({ token }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [state, setState] = useState(null);      // null = loading
  const [editing, setEditing] = useState(false);
  const [reg, setReg] = useState("");
  const [acct, setAcct] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // `alive` guards the async setState so a staffer who taps away mid-request
  // doesn't get a setState-after-unmount warning (or a resurrected state).
  const load = useCallback(() => {
    let alive = true;
    setState(null);
    portalApi.get(`/portal/${token}/bank`)
      .then((r) => { if (alive) setState(r.data); })
      // NOT {has_bank: false} — a failed read is not evidence of no account.
      .catch(() => { if (alive) setState({ unavailable: true }); });
    return () => { alive = false; };
  }, [token]);

  useEffect(() => load(), [load]);

  // Server error codes → real Danish copy. Anything unmapped falls back to a
  // generic line rather than showing the English developer message.
  const messageFor = (e) => {
    const status = e?.response?.status;
    // Transport / auth / throttle failures FIRST. Falling through to the
    // validation copy would tell a staffer whose digits are perfectly correct
    // to "check the numbers" — and on the 503 path a retry burns their own
    // rate budget, so a 429 here is a likely follow-on, not an edge case.
    if (!e?.response) {
      return t("portalBankErrOffline", "No connection — nothing was saved. Try again when you're back online.");
    }
    if (status === 503) {
      return t("portalBankUnavailable", "Bank details can't be saved yet. Nothing was stored — tell your employer.");
    }
    if (status === 429) {
      return t("portalBankErrTooMany", "Too many attempts — wait a minute. Nothing was saved.");
    }
    if (status === 401 || status === 404) {
      return t("portalBankErrLink", "Your link is no longer active. Reopen it from your invitation.");
    }
    const code = e?.response?.data?.detail?.code;
    const map = {
      empty: t("portalBankErrEmpty", "Enter both your reg. number and account number."),
      reg_nr_length: t("portalBankErrRegLength", "The reg. number must be exactly 4 digits."),
      account_missing: t("portalBankErrAcctMissing", "Enter your account number."),
      account_length: t("portalBankErrAcctLong", "The account number can be at most 10 digits."),
      account_too_short: t("portalBankErrAcctShort", "That account number looks too short — check it against your bank."),
      account_zero: t("portalBankErrAcctZero", "That isn't a valid account number."),
    };
    return map[code] || t("portalBankErrGeneric", "Couldn't save your account. Check the numbers and try again.");
  };

  const save = async () => {
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await portalApi.put(`/portal/${token}/bank`, { reg_nr: reg, account_number: acct });
      setState(r.data);
      setReg(""); setAcct("");
      setEditing(false);
      setOk(t("portalSaved", "Saved"));
      setTimeout(() => setOk(""), 1800);
    } catch (e) {
      setErr(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const yes = await confirm({
      title: t("portalBankRemoveTitle", "Remove your account?"),
      message: t("portalBankRemoveBody", "Your employer will no longer have an account to pay you into. You can add it again any time."),
      confirmLabel: t("portalBankRemove", "Remove my account"),
      destructive: true,
    });
    if (!yes) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await portalApi.delete(`/portal/${token}/bank`);
      setState(r.data);
      // Clear the inputs too — leaving them filled after a delete looks like
      // the removal failed, and is one tap from re-creating what was removed.
      setReg(""); setAcct("");
      setEditing(false);
      setOk(t("portalBankRemoved", "Account removed"));
      setTimeout(() => setOk(""), 1800);
    } catch (e) {
      setErr(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return null;  // no skeleton — it's one row inside a form

  return (
    <div className="pt-3 border-t border-[#f1f5f9]">
      <div className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8] mb-2">
        {t("portalBankSection", "Bank account")}
      </div>

      {/* A failed read is NOT "no account". The backend deliberately fails loud
          on a decrypt error rather than rendering an empty account; turning
          that into "Not added yet" — next to an Add button — would recreate
          exactly the silent lie it refused to tell. */}
      {state.unavailable && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[13px] text-gray-500">
            {t("portalBankLoadFailed", "We couldn't load your account just now — it isn't gone.")}
          </span>
          <button
            type="button"
            onClick={load}
            className="shrink-0 px-3 py-1.5 rounded-lg text-[13px] font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
          >
            {t("retry", "Try again")}
          </button>
        </div>
      )}

      {!editing && !state.unavailable && (
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            {state.has_bank ? (
              <div className="text-[13px] font-semibold text-gray-900 tabular-nums truncate">
                {state.masked}
                <span className="text-gray-400 font-medium"> · reg. {state.reg_nr}</span>
              </div>
            ) : (
              <div className="text-[13px] text-gray-500">{t("portalBankNone", "Not added yet")}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => { setEditing(true); setErr(""); }}
            className="shrink-0 px-3 py-1.5 rounded-lg text-[13px] font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 vp-press"
          >
            {state.has_bank ? t("portalBankChange", "Change") : t("portalBankAdd", "Add")}
          </button>
        </div>
      )}

      {editing && !state.unavailable && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="w-24 shrink-0">
              <label className="text-[10px] text-gray-500 mb-1 block">{t("portalBankRegLabel", "Reg. no.")}</label>
              <input
                type="text"
                inputMode="numeric"
                value={reg}
                onChange={(e) => setReg(e.target.value)}
                placeholder="1234"
                className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 tabular-nums placeholder:text-gray-400 outline-none focus:border-gray-900/30"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-gray-500 mb-1 block">{t("portalBankAcctLabel", "Account no.")}</label>
              <input
                type="text"
                inputMode="numeric"
                value={acct}
                onChange={(e) => setAcct(e.target.value)}
                placeholder="5678901234"
                className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 tabular-nums placeholder:text-gray-400 outline-none focus:border-gray-900/30"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 transition disabled:opacity-50"
            >
              {busy ? t("portalSaving", "Saving…") : t("portalBankSave", "Save account")}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setErr(""); setReg(""); setAcct(""); }}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
            >
              {t("cancel", "Cancel")}
            </button>
          </div>
          {state.has_bank && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="w-full text-[12px] font-semibold text-red-600 hover:text-red-700 py-1 disabled:opacity-50"
            >
              {t("portalBankRemove", "Remove my account")}
            </button>
          )}
        </div>
      )}

      {err && <p className="mt-2 text-[12px] text-red-600">{err}</p>}
      {ok && <p className="mt-2 text-[12px] text-emerald-600">{ok}</p>}
      <div className="mt-1.5 text-[10px] text-gray-400">
        {t("portalBankNote", "Only your employer can see this, and only to pay you. We show you the last 4 digits.")}
      </div>
    </div>
  );
}

function PinGate({ onVerified, token, staffName }) {
  const { t } = useLanguage();
  const [pin, setPin] = useState(["", "", "", ""]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleDigit = (idx, val) => {
    if (val.length > 1) val = val.slice(-1);
    if (val && !/^\d$/.test(val)) return;
    const next = [...pin];
    next[idx] = val;
    setPin(next);
    // Auto-focus next
    if (val && idx < 3) {
      document.getElementById(`pin-${idx + 1}`)?.focus();
    }
    // Auto-submit when all 4 filled
    if (idx === 3 && val) {
      submitPin(next.join(""));
    }
  };

  const handleKeyDown = (idx, e) => {
    if (e.key === "Backspace" && !pin[idx] && idx > 0) {
      document.getElementById(`pin-${idx - 1}`)?.focus();
    }
  };

  const submitPin = async (code) => {
    setLoading(true);
    setError("");
    try {
      const res = await portalApi.post(`/portal/${token}/verify-pin`, { pin: code });
      // Persist the signed proof — every data call for this link carries it
      // (X-BonBox-Pin), and reloads skip the gate while it's valid.
      if (res.data?.pin_proof) storePinProof(token, res.data.pin_proof);
      onVerified();
    } catch (err) {
      setError(
        err?.response?.status === 429
          ? t("portalPinLocked", "Too many attempts — try again in 15 minutes.")
          : t("portalPinWrong", "Wrong PIN. Try again."),
      );
      setPin(["", "", "", ""]);
      document.getElementById("pin-0")?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    /* The FIRST screen a new staffer ever sees wears the next-shift card's
       own surface: flat BonBox forest, radius 22. Home v3 (Nov 2026) dropped
       the gradient, the green bloom and the inset highlight here and on the
       hero together — they are the effects the brand rules out, and the two
       surfaces must stay one material. Nothing about the gate's behaviour
       changes; the PIN is still verified server-side and still mints the
       proof. */
    <div className="min-h-[100dvh] flex items-center justify-center p-6" style={{ background: "#f5f7fb" }}>
      <div
        className="relative w-full max-w-xs text-center"
        data-testid="portal-pin-card"
        style={{
          borderRadius: 22,
          padding: "28px 22px 24px",
          background: FOREST,
        }}
      >
        <div className="relative">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{
              background: "rgba(246,244,236,.10)",
              border: "1px solid rgba(246,244,236,.16)",
            }}
          >
            <Lock className="w-6 h-6" strokeWidth={2} aria-hidden style={{ color: PAPER }} />
          </div>
          <h1
            className="mb-1.5"
            style={{ font: "700 22px/1.1 var(--font-display)", letterSpacing: "-0.03em", color: PAPER }}
          >
            {t("portalPinTitle", "Enter PIN")}
          </h1>
          <p className="mb-7" style={{ font: "400 12.5px/1.45 var(--font-text)", color: "rgba(246,244,236,.66)" }}>
            {t("portalPinSubtitle", "Hi {name}, enter your 4-digit PIN", { name: staffName })}
          </p>
          <div className="flex gap-2.5 justify-center mb-5">
            {pin.map((d, i) => (
              <input
                key={i}
                id={`pin-${i}`}
                type="tel"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={(e) => handleDigit(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className="w-[52px] h-[56px] text-center outline-none pin-cell"
                style={{
                  font: "700 24px/1 var(--font-display)",
                  color: PAPER,
                  background: "rgba(246,244,236,.08)",
                  border: "1px solid rgba(246,244,236,.22)",
                  borderRadius: 14,
                }}
                autoFocus={i === 0}
              />
            ))}
          </div>
          {error && <p className="text-[13px] mb-3" style={{ color: "#fca5a5" }}>{error}</p>}
          {loading && (
            <p className="text-[13px]" style={{ color: "rgba(246,244,236,.66)" }}>
              {t("portalPinVerifying", "Verifying…")}
            </p>
          )}
          {/* The way out. A forgotten PIN used to end in a 15-minute lockout
              with no hint who can help; the owner can reset it (or send a
              fresh link) from the staff profile. */}
          <p className="mt-6" style={{ font: "400 12px/1.45 var(--font-text)", color: "rgba(246,244,236,.6)" }}>
            {t("portalPinForgot", "Forgot your PIN? Ask your manager for a new link.")}
          </p>
        </div>
      </div>
    </div>
  );
}


// ─── Schedule Tab ─────────────────────────────────────────────────────────

/**
 * SickCallButton — staff self-service "I'm sick today" trigger.
 *
 * UX shape (simple, mobile-first):
 *   • Primary button "🤒 Call in sick"
 *   • Tap → modal with:
 *       - Date picker (defaults to today; scrolls to upcoming shift
 *         dates so staff can pick a specific shift to call out for)
 *       - Optional reason textarea
 *       - Submit button (disabled until date is set)
 *   • On submit → POST /portal/{token}/sick-call → toast → modal closes
 *   • Idempotency is server-side; double-tap doesn't double-call
 *
 * Multi-layer security pulled in from the backend:
 *   • Server enforces the [-30, +60]-day date window — UI tightens
 *     it further by only allowing today + the next 14 days from the
 *     date input min/max.
 *   • staff_id is fixed by the magic-link token — the body only
 *     contains date + reason. UI doesn't even ask for staff_id.
 */
function SickCallButton({ token, upcomingShifts, onCalledIn, autoOpen = false, onDismiss, initialDate }) {
  const { t, lang } = useLanguage();
  const [open, setOpen] = useState(autoOpen);
  const todayIso = useState(() => toLocalISO(new Date()))[0];
  // initialDate: opened from ONE shift's ⋯ menu, the form is about that
  // shift's day — defaulting to today there would report the wrong day on a
  // straight "Send". The week section has no shift in hand and keeps today.
  const [date, setDate] = useState(initialDate || todayIso);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  // The schedule_id IS optional — the backend auto-finds the shift
  // by date if we don't pass one — but if the staff picks a date
  // that has a known shift, we forward the schedule_id so the server
  // can validate ownership at parse time (defense in depth).
  const matchingShift = upcomingShifts.find((s) => s.date === date);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await portalApi.post(`/portal/${token}/sick-call`, {
        date,
        reason: reason.trim() || null,
        schedule_id: matchingShift?.id || null,
      });
      // Was: reset, close, done — the sheet vanished and NOTHING said it
      // worked. For the one message in this product that means "I cannot come
      // in", silence is the wrong answer: the staffer is left guessing whether
      // to phone as well. Confirm what was recorded, then close on its own.
      setReason("");
      setSent(true);
      onCalledIn?.();
      setTimeout(() => { setSent(false); setOpen(false); onDismiss?.(); }, 2600);
    } catch (err) {
      setError(portalErrText(err, t, t("portalSickSendFailed", "Couldn't send. Try again."), lang));
    } finally {
      setSubmitting(false);
    }
  };

  // Closed = render NOTHING. The only mount site passes autoOpen and sits
  // directly under the "Report sick" pill that reveals it (see the call site),
  // so a collapsed button here stacked a second identical CTA under the first —
  // which is precisely what autoOpen's comment says it exists to avoid. The
  // pill is the entry point; dismissing the sheet returns you to it.
  if (!open) return null;

  // 14-day forward window matches the backend MAX_FUTURE_DAYS soft cap;
  // backend allows up to 60 but most call-ins are same-day or near. A shift
  // further out that the form was opened FOR stays pickable.
  const max14 = toLocalISO(addDaysToDate(new Date(), 14));
  const maxIso = initialDate && initialDate > max14 ? initialDate : max14;

  if (sent) {
    // "2026-09-03" is the value we POST, not a date a person reads — and for a
    // Danish reader it is not even the local convention.
    const prettyDate = new Date(date + "T00:00:00").toLocaleDateString(localeFor(lang), {
      weekday: "long", day: "numeric", month: "long",
    });
    return (
      <div className="rounded-[20px] bg-white border border-[#e8edf3] p-5 text-center space-y-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_32px_-24px_rgba(15,23,42,0.35)]">
        <Check className="w-6 h-6 mx-auto text-emerald-600" strokeWidth={2.5} aria-hidden />
        <div className="font-display text-[15px] font-bold text-gray-900">
          {t("portalSickSentTitle", "Sick report sent")}
        </div>
        {/* States what is TRUE. The row is written and the manager sees it in
            BonBox the moment they look. A push is attempted but may reach
            nothing, so this must not promise one. */}
        <div className="text-[12px] text-gray-500 leading-snug">
          {matchingShift
            ? t("portalSickSentBodyShift", "{date}, {from}–{to}. Your manager sees it in BonBox.", { date: prettyDate, from: matchingShift.start_time, to: matchingShift.end_time })
            : t("portalSickSentBody", "{date}. Your manager sees it in BonBox.", { date: prettyDate })}
        </div>
      </div>
    );
  }

  return (
    <div data-kb-block="" className="rounded-[20px] bg-white border border-[#e8edf3] p-4 space-y-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_32px_-24px_rgba(15,23,42,0.35)]">
      <div className="flex items-center justify-between">
        <div className="font-display text-[14.5px] font-bold tracking-[-0.02em] leading-[1.1] text-gray-900 flex items-center gap-1.5"><Thermometer className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />{t("portalCallInSick", "Report sick")}</div>
        <button
          onClick={() => { setOpen(false); setError(""); setReason(""); onDismiss?.(); }}
          data-back-close=""
          className="text-gray-500 hover:text-gray-700 text-lg leading-none w-6 h-6 flex items-center justify-center"
          aria-label={t("close", "Close")}
        >
          ×
        </button>
      </div>
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">{t("portalSickWhichDay", "Which day?")}</label>
        <input
          type="date"
          value={date}
          // Backdating matters once the Availability sick chip is gone: someone
          // ill over the weekend registers it Monday. The service allows 30 days
          // back (MAX_BACKDATE_DAYS); 14 is the honest UI floor — far enough for
          // a real weekend or a lost phone, short enough that a typo'd year
          // cannot silently land a sygemelding in a closed pay period.
          min={toLocalISO(addDaysToDate(new Date(), -14))}
          max={maxIso}
          onChange={(e) => setDate(e.target.value)}
          data-testid="portal-sick-date"
          // iOS draws a date input wider than its column (it ran past the
          // reason box below): hold it to the card, as Fravær's DateField does.
          className="block w-full min-w-0 max-w-full text-left px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 outline-none focus:border-amber-500/40"
          style={{ boxSizing: "border-box", WebkitAppearance: "none", appearance: "none" }}
        />
        {matchingShift && (
          <div className="mt-1 text-[11px] text-gray-500">
            {t("portalSickShiftLabel", "Shift")}: {matchingShift.start_time} – {matchingShift.end_time}
          </div>
        )}
      </div>
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">
          {t("portalSickReason", "Reason")} <span className="text-gray-400">{t("portalSickReasonHint", "(optional, only your owner sees this)")}</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          rows={2}
          placeholder={t("portalSickReasonPlaceholder", "e.g. fever 39C, doctor advised rest")}
          className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-amber-500/40 resize-none"
        />
      </div>
      {error && (
        <div className="text-xs text-red-400">{error}</div>
      )}
      <button
        onClick={submit}
        disabled={submitting || !date}
        className="w-full py-2.5 rounded-[14px] bg-gray-900 text-white font-text text-[13px] font-bold hover:bg-gray-700 transition disabled:opacity-50"
      >
        {submitting ? t("portalSending", "Sending…") : t("portalSickSubmit", "Send")}
      </button>
      <div className="text-[10px] text-gray-400 text-center leading-snug">
        {/* Was "Your owner will be notified". Measured 2026-09-03: this
            account has ZERO owner push subscriptions, so the push had nothing
            to deliver to and the sentence was false. What IS always true is
            that the absence row is written and shows in the owner's app. Say
            that, and point at the channel that reaches a human. */}
        {t("portalSickFootnote", "Your manager sees this in BonBox straight away. If it's urgent, message them too.")}
      </div>
    </div>
  );
}


// Lightweight helper used by SickCallButton's max-date computation —
// kept local so we don't grow the import surface for one-off math.
function addDaysToDate(d, days) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}


/**
 * useScheduleConfirm — staff side of the bidirectional notification
 * loop (was the ConfirmScheduleButton component; the canvas moved the button
 * into the next-shift card, so the state is a hook the card renders).
 *
 * When the owner publishes/edits a schedule, every affected staff
 * member gets an email with their unique portal link (already wired in
 * notification_service.send_shift_notifications). Staff opens the
 * link, glances at their shifts, and taps "I've got it" — that POSTs
 * to /portal/{token}/confirm-schedule which stamps confirmed_at on
 * every published shift in the visible 3-week window.
 *
 * Then on the owner side, the dashboard polls
 * /staff/schedule-confirmation-summary and shows a calm chip:
 *   "✓ 3 of 4 staff confirmed this week"
 * No nagging emails, no chasing. Just at-a-glance awareness.
 *
 * UX:
 *   • Hidden when there are no published shifts in the window (nothing
 *     to confirm — wait for the owner to publish first).
 *   • Already-confirmed state shows a dashed status instead of a button so
 *     re-tapping isn't tempting (still works as no-op idempotent).
 *   • One tap → server returns confirmed_count → small "✓ N shifts
 *     confirmed" inline confirmation that fades after 4s.
 */
function useScheduleConfirm({ token, shifts, onConfirmed, allShifts }) {
  const { t } = useLanguage();
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  // Only offer the button if there's at least one PUBLISHED shift in the
  // visible window; otherwise nothing to confirm.
  const publishedShifts = shifts.filter((s) => s.status === "published");
  const allConfirmed =
    publishedShifts.length > 0 &&
    publishedShifts.every((s) => !!s.confirmed_at);

  // Confirming is scoped to what is on screen, so a department selection can
  // leave the window's OTHER branches unconfirmed while this view rests on
  // "thanks". Say so, rather than letting the calm state imply everything is
  // done — the staffer would never find the remaining shifts.
  const visibleIds = new Set(publishedShifts.map((sh) => sh.id));
  const unconfirmedElsewhere = (allShifts || []).filter(
    (sh) => sh.status === "published" && !sh.confirmed_at && !visibleIds.has(sh.id),
  ).length;

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      // Send the ids on screen. With a department selected the list is a
      // SUBSET of the server's window, and an unscoped confirm stamps shifts at
      // another branch that were filtered out and never read — then reports a
      // count that disagrees with what is displayed.
      const res = await portalApi.post(`/portal/${token}/confirm-schedule`, {
        shift_ids: publishedShifts.filter((sh) => !sh.confirmed_at).map((sh) => sh.id),
      });
      haptic.light(); // a quiet physical ack — confirm is routine, not ceremonial
      const n = res?.data?.confirmed_count ?? 0;
      setFeedback(n > 0
        ? `✓ ${n === 1 ? t("portalConfirmCountOne", "{n} shift confirmed", { n }) : t("portalConfirmCount", "{n} shifts confirmed", { n })}`
        : `✓ ${t("portalConfirmAlready", "Already confirmed")}`);
      onConfirmed?.();
      setTimeout(() => setFeedback(""), 4000);
    } catch (e) {
      setError(errText(e, t("portalConfirmFailed", "Couldn't confirm. Try again.")));
    } finally {
      setSubmitting(false);
    }
  };

  // Truth logic above (allConfirmed = published>0 && every confirmed_at set)
  // is UNTOUCHED. The confirmed state still reads confirmed_at — never an
  // optimistic local flag.
  // Canvas "Pine, ivory & brass" (Nov 2026): the strip moved INTO the
  // next-shift card as its brass main button, "Jeg har set det", and its
  // resting state is the card's dashed "Vagten er bekræftet". "Meld syg" used
  // to hang under the strip; home v3 moved it — not deleted — to the card's ⋯
  // menu and the "Brug for en ændring?" tiles, both opening the same
  // SickCallButton form (pinned by StaffPortalPage.homeV3.test.jsx).
  return {
    show: publishedShifts.length > 0,
    allConfirmed,
    unconfirmedElsewhere,
    submitting,
    submit,
    feedback,
    error,
  };
}


// ── Punch-clock (Stempelur) — staff self-clock from the portal. Writes the
// SAME HoursLogged rows the owner sees, so a clock-in/out flows straight to
// the owner's "clocked in now" strip + hours. Server-stamps the time; the hook
// just reflects + polls state (auto-updates ~30s).
//
// useClock(token) — lifted OUT of the old standalone <ClockCard/> so the dark
// next-shift hero can render the live elapsed timer AND choose Stempl ind vs
// Tilføj til kalender from the same state. act()/getPos()/the geolocation-
// only-when-geofence_on guard / the too_far 403 → portalClockTooFar mapping /
// the 30s poll are MOVED VERBATIM — ownership changed, behaviour did not.
function useClock(token) {
  const { t, lang } = useLanguage();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(""); // honest clock-out outcome
  // The GPS fix used for the last punch attempt. Held ONLY so a refused punch
  // can draw the direction dial without asking for location a second time.
  // Never sent anywhere, never persisted — it dies with the component.
  const [lastFix, setLastFix] = useState(null);
  const [liveSec, setLiveSec] = useState(null); // live elapsed seconds (ticks 1/s)
  // Seconds into the running pause — the server's break_elapsed_sec, anchored
  // on every answer exactly like liveSec. null when not on a pause.
  const [breakSec, setBreakSec] = useState(null);

  // Snap server state AND the live-second baselines together, so the counters
  // re-anchor to the server's authoritative elapsed_sec / break_elapsed_sec on
  // every poll/punch and can never drift away — the +1/sec ticker only
  // smooths the gaps.
  const applySt = useCallback((data) => {
    setSt(data || null);
    setLiveSec(data?.elapsed_sec ?? null);
    setBreakSec(data?.on_break ? (data?.break_elapsed_sec ?? 0) : null);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await portalApi.get(`/portal/${token}/clock`);
      applySt(res.data);
    } catch {
      /* soft — leave last-known state */
    }
  }, [token, applySt]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000); // live-ish sync to the owner view
    return () => clearInterval(id);
  }, [load]);

  // 1-second live tick — ONLY while clocked in (keyed on the boolean so the
  // interval is created once on clock-in and cleared on clock-out / unmount,
  // not rebuilt every 30s poll). Display-only; the server stays source of truth.
  const clockedInNow = !!st?.clocked_in;
  useEffect(() => {
    if (!clockedInNow) return;
    const id = setInterval(() => {
      setLiveSec((s) => (s == null ? s : s + 1));
      setBreakSec((s) => (s == null ? s : s + 1));
    }, 1000);
    return () => clearInterval(id);
  }, [clockedInNow]);

  // Resolve device location (only when the venue lock is on). Denied / no-fix
  // → resolves null; the server then allows the punch but flags it unverified.
  const getPos = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        // Forward accuracy too — the server uses it as a grace radius so a real
        // worker at the door with an imprecise fix isn't wrongly locked out.
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
      );
    });

  const act = async (dir) => {
    setBusy(true);
    setErr("");
    try {
      let payload = {};
      // True when the server will accept this punch but flag it "Location
      // unverified" (no fix, or a fix too vague to trust — the server's own
      // 200 m rule). The staffer used to get a plain success and never learn
      // their manager would see the punch as unverified.
      let unverified = false;
      let noFix = false;   // no position at all — usually location switched off
      if (dir === "in" && st?.geofence_on) {
        const pos = await getPos();
        noFix = !pos;
        unverified = !pos || (pos.accuracy != null && pos.accuracy > 200);
        if (pos) {
          payload = pos;
          // Keep the fix that was actually used for this punch. If the server
          // refuses, the dial can then show DIRECTION as well as distance —
          // without asking for location a second time. Never sent anywhere
          // else and never persisted; it dies with the component.
          setLastFix(pos);
        }
      }
      const res = await portalApi.post(`/portal/${token}/clock-${dir}`, payload);
      applySt(res.data);
      // Native feel: a physical answer to the physical act. Success for a real
      // punch; warning when the punch was too short and discarded (honest).
      if (res.data?.discarded) haptic.warning();
      else haptic.success();
      if (dir === "out" && !res.data?.discarded) {
        // A completed punch just landed — nudge the portal to refetch hours so
        // the worker sees it in "My hours" without a manual reload.
        try { window.dispatchEvent(new Event("bonbox-data-changed")); } catch { /* noop */ }
      }
      if (dir === "out") {
        // Honest outcome: confirm the hours we logged, or — when the punch was
        // too short and discarded server-side — say so plainly. No silent flip.
        const d = res.data || {};
        const mins = Math.round((d.worked_hours || 0) * 60);
        // A duration someone worked — the thing a person says out loud. Unit
        // comes from the language (hours.js), never typed here: this line used
        // to hardcode the Danish "t" on a screen an English or Turkish worker
        // reads too.
        const dur = formatHours(mins / 60, { lang, decimals: 2 });
        setResult(
          d.discarded
            ? t("portalClockTooShort", "Too short — nothing logged.")
            : t("portalClockLogged", "Logged · {h}", { h: dur }),
        );
        setTimeout(() => setResult(""), 6000);
      } else if (unverified) {
        // Say how to fix it, not only that it happened: with no position at
        // all, location is almost always switched off for the app / site.
        const fix = noFix
          ? (isNativeApp()
            ? t("portalClockNoLocationFixNative", "To fix it: Settings → Vagtplan → Location → While Using the App.")
            : t("portalClockNoLocationFixWeb", "To fix it, allow location for this site in your browser. Your next punch is then verified."))
          : "";
        setResult([
          t("portalClockNoLocation", "Clocked in without your location — your manager sees this punch as unverified."),
          fix,
        ].filter(Boolean).join(" "));
        setTimeout(() => setResult(""), noFix ? 20000 : 10000);
      } else {
        setResult("");
      }
    } catch (e) {
      const det = e?.response?.data?.detail;
      if (det?.error === "too_far") {
        // Keep the real numbers — the hero renders a calm "you're ~X away" block
        // instead of a flat red line (being off-site isn't an error you caused).
        haptic.warning();
        setErr({ kind: "too_far", distance_m: det.distance_m, radius_m: det.radius_m });
      } else if (det?.error === "too_early") {
        // Server-side window gate (belt-and-braces behind the disabled button).
        // Rendered CALM (not the red error style) — being early isn't a mistake
        // the worker made, mirroring the too_far treatment. load() below refreshes
        // st so the button reflects the lock.
        haptic.warning();
        setErr({ kind: "too_early", opens_at: det.opens_at });
      } else {
        haptic.error();
        setErr(
          det?.error === "not_clocked_in"
            ? t("portalClockErrOut", "You're not clocked in.")
            : t("portalClockErr", "Couldn't update the clock. Try again."),
        );
      }
      load();
    } finally {
      setBusy(false);
    }
  };

  // Live breaks (Nov 2026) — Start pause / Slut pause, offered ONLY while the
  // clock answer says breaks_live (the owner's "Pauser stemples live"). The
  // server owns the state: its answer is applied when it carries one, else
  // the clock is read again. A 409 (not_on_break / not_clocked_in) means this
  // phone was behind (the break was already ended, or the punch closed,
  // elsewhere): re-read quietly, no error. Contract: no request body — the
  // server stamps the time; the shapes are pinned in
  // __tests__/fixtures/liveBreaksContract.json, written by the real endpoints.
  const breakAct = async (kind) => {
    setBusy(true);
    setErr("");
    setResult("");
    try {
      const res = await portalApi.post(`/portal/${token}/clock/break/${kind}`);
      if (res?.data && typeof res.data === "object" && "clocked_in" in res.data) applySt(res.data);
      else await load();
      haptic.success();
      if (kind === "end" && res?.data?.break_discarded) {
        // Ended within a minute: the server deleted it (a misclick), so the
        // Pause cell does not move. Say so, rather than leave a silent tap.
        // Its own words: "Too short — nothing logged" is the clock-out line
        // and read as if the shift itself was thrown away.
        setResult(t("portalBreakTooShort", "Break under a minute — not counted."));
        setTimeout(() => setResult(""), 6000);
      }
    } catch (e) {
      if (e?.response?.data?.detail?.error === "breaks_off") {
        // The owner switched live breaks off since this screen last asked:
        // say so; the re-read below takes the button away.
        haptic.warning();
        setErr(t("portalBreaksOff", "Your manager has turned live breaks off."));
      } else if (e?.response?.status !== 409) {
        haptic.error();
        setErr(kind === "start"
          ? t("portalBreakStartErr", "Couldn't start your break. Try again.")
          : t("portalBreakEndErr", "Couldn't end your break. Try again."));
      }
      load();
    } finally {
      setBusy(false);
    }
  };

  // A worked duration. formatHoursMinutes takes HOURS, so convert first, and
  // it renders "—" for an unknown value on its own.
  const fmtDur = (min) => formatHoursMinutes(min == null ? null : min / 60, { lang });

  // Live elapsed: starts at "0s" on clock-in (server returns elapsed_sec≈0),
  // ticks seconds for the first hour (proof it's alive), then calm "Xt Ym".
  const fmtElapsed = (sec) => {
    if (sec == null) return "—";
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    // Past the first hour: hand the FLOORED whole minutes to the formatter (as
    // hours) so a live counter never rounds itself a minute ahead, and the unit
    // comes from the language instead of a hardcoded Danish "t".
    if (h > 0) return formatHoursMinutes(Math.floor(s / 60) / 60, { lang });
    if (m > 0) return `${m}m ${String(ss).padStart(2, "0")}s`;
    return `${ss}s`;
  };

  return { st, busy, err, result, act, breakAct, fmtDur, liveLabel: fmtElapsed(liveSec), liveSec, breakSec, lastFix };
}

// ── Live countdown to the next shift's start. No timer of its own; the parent
// re-renders every 15s via the page-level freshnessTick, so this stays current
// without a second interval. Honest: started/past → "I gang" ("Now"), never a
// negative or fabricated future time. Returns null when there's no shift or the
// shift is neither today nor within ~24h (the chip would be noise otherwise).
// The impure Date.now() read is intentionally confined here, out of any
// component render body.

// ── Initials for a teammate avatar (≤2 letters, uppercased). Privacy: only
// initials + a role-underline are ever shown for teammates.
// The colleague discs (canvas "Pine, ivory & brass"): flat, earthy, cream
// initials. Deterministic on the name, so the same colleague is the same
// colour every render and across sessions. The home and, since Nov 2026, the
// chat's group picker use it (the chat's light gradient tints are gone).
const PINE_TONES = ["#2F5D4E", "#8A6A2F", "#4F5F80", "#93573F", "#456E5F", "#6B5A7E"];
function pineTone(name) {
  const key = (name || "?").trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PINE_TONES[h % PINE_TONES.length];
}

// Hours in the reader's notation: "15,5", never "15.5".
// One formatter for every hours figure on the portal, in the portal's own
// language — the Hours tab printed "101,5" beside "86.5 hrs" on one screen.
function fmtPortalHours(v, lang = "da") {
  const n = Number(v);
  if (!Number.isFinite(n)) return v ?? "";
  return new Intl.NumberFormat(lang === "da" ? "da-DK" : "en-GB", { maximumFractionDigits: 2 }).format(n);
}

function staffInitials(name) {
  return (name || "")
    .trim()
    .split(/\s+/)
    // Letters only: "Testcafé (lokal)" rendered as "T(".
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";
}

/** First name only — what one colleague calls another, and short enough to sit
    under an avatar without wrapping. Falls back to the whole string when the
    owner stored a single word ("demo"), and to "" when there is no name at all
    (the caller renders the avatar regardless, so this never leaves a gap). */
function firstName(name) {
  const first = (name || "").trim().split(/\s+/).filter(Boolean)[0] || "";
  return first;
}

// ── "På arbejde med dig" — teammate avatar strip for the next shift's date.
// PURE-PROPS: teamShifts is hoisted to the page-level loadData (fetched in the
// same Promise.allSettled as the schedule) so this strip paints WITH the hero
// instead of growing it ~100ms later — stillness doctrine. The endpoint filters
// to published/confirmed shifts server-side (no draft leak), and we ALSO restrict
// to nextShift.date only as defense-in-depth — never widen beyond the one date
// the staffer is already trusted to see.
/**
 * matesForShift — who else is on THIS shift's date, at this shift's location.
 *
 * Lifted out of WhosOnStrip so the week list can answer the same question for
 * every shift, not only the hero's next one. Previously "who am I on with?"
 * was answerable for exactly one day; a staffer looking at Friday got nothing.
 *
 * Rules preserved verbatim from the strip: same date only (defense-in-depth —
 * never widen past the one date the staffer is already trusted to see), own row
 * excluded structurally by matching start/end/role since the client has no
 * staff_id, dedupe by staff_id, and multi-location scoping where a shift with a
 * location only sees that location while a shift without one sees everyone.
 */
function matesForShift(teamShifts, shift) {
  if (!shift || !Array.isArray(teamShifts)) return [];
  const myBranch = shift.branch_name || null;
  const seen = new Set();
  const mates = [];
  for (const s of teamShifts) {
    if (s.date !== shift.date) continue;
    if (myBranch && s.branch_name && s.branch_name !== myBranch) continue;
    const isMine =
      s.start_time === shift.start_time &&
      s.end_time === shift.end_time &&
      (s.role || "") === (shift.role_on_shift || "");
    if (isMine) continue;
    const id = s.staff_id ?? `${s.staff_name}|${s.start_time}|${s.end_time}`;
    if (seen.has(id)) continue;
    seen.add(id);
    mates.push(s);
  }
  return mates;
}

/** A shared "section title" for the home (canvas: 16/700, in Sora). */
function HomeH2({ children, id, style }) {
  return (
    <h2 id={id} style={{ margin: 0, font: `700 16px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK, ...style }}>
      {children}
    </h2>
  );
}

/** Overlapping colleague discs (flat earthy tones, cream initials). */
function MateDiscs({ mates, size = 32, ring = CARD, overlap = 8, cap = 5, showOverflow = true }) {
  const shown = mates.slice(0, cap);
  const overflow = mates.length - shown.length;
  return (
    <span className="flex shrink-0" aria-hidden>
      {shown.map((s, i) => (
        <span
          key={`${s.staff_id ?? s.staff_name}-${i}`}
          className="inline-flex items-center justify-center rounded-full"
          style={{
            width: size, height: size, marginLeft: i === 0 ? 0 : -overlap,
            background: pineTone(s.staff_name), color: IVORY,
            font: `600 ${size >= 30 ? 12 : 10}px/1 var(--font-text)`,
            boxShadow: `0 0 0 ${size >= 30 ? 2 : 1.5}px ${ring}`,
          }}
        >
          {/* One letter, as on the canvas: two-letter initials crowd an
              overlapping row. The names sit right beside the discs. */}
          {staffInitials(s.staff_name).slice(0, 1)}
        </span>
      ))}
      {showOverflow && overflow > 0 && (
        <span
          className="inline-flex items-center justify-center rounded-full"
          style={{
            width: size, height: size, marginLeft: -overlap,
            background: TILE, color: MUTED,
            font: `600 ${size >= 30 ? 11 : 9}px/1 var(--font-text)`,
            boxShadow: `0 0 0 ${size >= 30 ? 2 : 1.5}px ${ring}`,
          }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

function WhosOnStrip({ teamShifts, nextShift, live = false, onOpen }) {
  const { t, lang } = useLanguage();

  if (!nextShift) return null;

  // Same date only; exclude YOUR OWN row structurally (no staff_id on the
  // client) by matching start/end/role; dedupe by staff_id.
  // Multi-location (S4): when MY shift has a location, "who am I on with?"
  // means MY floor — scope to teammates at the same location (or with no
  // location, which belongs everywhere). A shift with no location keeps the
  // whole-team view, so single-venue tenants see zero change.
  const myBranch = nextShift.branch_name || null;
  const mates = matesForShift(teamShifts, nextShift);
  const names = mates.map((s) => firstName(s.staff_name)).filter(Boolean);

  // Home v3 (Nov 2026): its own light card UNDER the next-shift card, not
  // folded inside it — the forest card carries the place (map, venue, Rute).
  // The ⋯ menu's "Hvem er på" row scrolls here. Canvas "Pine, ivory & brass":
  // a title with the count on the right, then one row — flat discs and the
  // first names as a sentence. The row opens that day in the week list,
  // where each name shows when else that colleague is on.
  // A solo shift used to render nothing at all — and 63% of venue-days in
  // production ARE solo, so the most common answer to "who am I on with?" was
  // silence, which reads as "not loaded yet" rather than "nobody". Say it.
  const title = live ? t("portalWhosOnNow", "On shift now") : t("portalWhosOnTitle");
  return (
    <section id="portal-whos-on" data-testid="portal-whos-on" style={{ scrollMarginTop: 8 }}>
      <div className="flex items-baseline justify-between" style={{ gap: 8, padding: "0 4px" }}>
        <HomeH2>
          {/* "På vagt nu": a brass dot breathes beside it while the shift runs. */}
          {live && (
            <span
              aria-hidden
              className="vp-breathe"
              data-testid="portal-whos-on-live-dot"
              style={{ display: "inline-block", width: 7, height: 7, borderRadius: 99, background: BRASS, marginRight: 8, verticalAlign: "0.12em" }}
            />
          )}
          {title}
          {/* DM Sans 500: Sora is loaded at 600/700 only, so a Sora 500 drew 600. */}
          {myBranch && <span style={{ fontFamily: "var(--font-text)", fontWeight: 500, color: MUTED }}> · {myBranch}</span>}
        </HomeH2>
        {mates.length > 0 && (
          <span className="shrink-0" style={{ font: "400 13px/1 var(--font-text)", color: MUTED }}>
            {mates.length === 1
              ? t("portalWhosOnCountOne", "1 colleague")
              : t("portalWhosOnCount", "{n} colleagues", { n: mates.length })}
          </span>
        )}
      </div>
      {mates.length === 0 ? (
        <div style={{ marginTop: 8, padding: "14px 16px", borderRadius: 20, background: CARD, border: `1px solid ${LINE}`, font: "500 14px/1.3 var(--font-text)", color: MUTED }}>
          {t("portalWhosOnSolo", "You're on your own this shift.")}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          data-testid="portal-whos-on-row"
          className="w-full flex items-center text-left vp-press vp-row active:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/40"
          style={{ marginTop: 8, gap: 12, padding: "12px 14px", minHeight: 56, borderRadius: 20, background: CARD, border: `1px solid ${LINE}`, color: INK }}
        >
          <MateDiscs mates={mates} />
          <span className="flex-1 min-w-0 truncate" style={{ font: "500 14px/1.3 var(--font-text)" }}>
            {listNames(names.slice(0, 6), lang)}{names.length > 6 ? ` +${names.length - 6}` : ""}
          </span>
          <ChevronRight className="shrink-0" size={18} strokeWidth={2} aria-hidden style={{ color: MUTED }} />
        </button>
      )}
    </section>
  );
}

// ── Åbne vagter — staff claim ───────────────────────────────────────────────
// Open shifts the owner posted that this staffer can pick up one-tap (PULL
// model — appears only when there's something to take, never a notification
// blast). Claim is atomic + overlap-guarded server-side; on success the shift
// lands in the staffer's own schedule, so we refresh.
//
// The claim is a hook since the canvas (Nov 2026): the same open shift can be
// taken from the "Åbne vagter" list AND from its dashed row in the week list,
// and both must share one in-flight state and one answer. `where` says which
// list the tap came from, so the answer prints there and not twice.
function useOpenShiftClaim(token, onClaimed) {
  const { t, lang } = useLanguage();
  const [claiming, setClaiming] = useState(null);
  const [msg, setMsg] = useState("");
  const [where, setWhere] = useState(null);

  const claim = async (id, from = "open") => {
    setClaiming(id);
    setWhere(from);
    setMsg("");
    try {
      await portalApi.post(`/portal/${token}/open-shifts/${id}/claim`);
      haptic.success();
      setMsg(t("portalOpenClaimed", "Added to your schedule."));
      setTimeout(() => setMsg(""), 3500);  // clear the confirmation after the moment
      onClaimed?.();
    } catch (err) {
      const code = err?.response?.data?.detail?.code;
      haptic.warning();
      if (code === "already_taken") setMsg(t("portalOpenTaken", "That shift was just taken."));
      else if (code === "shift_overlap") setMsg(t("portalOpenOverlap", "You already work then."));
      else setMsg(portalErrText(err, t, t("portalOpenClaimFailed", "Couldn't take the shift."), lang));
      onClaimed?.();
    } finally {
      setClaiming(null);
    }
  };
  return { claiming, msg, where, claim };
}

/** The span of an open shift, for its meta line ("6 t"). */
function openSpanHours(o) {
  const [sh, sm] = String(o?.start_time || "").split(":").map(Number);
  const [eh, em] = String(o?.end_time || "").split(":").map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return null;
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

/** The "Tag den" pill — pale pine on ivory (canvas). */
function TakeItButton({ onClick, busy, label, testId }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={testId}
      className="shrink-0 inline-flex items-center justify-center vp-press disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/40"
      style={{ height: 44, padding: "0 16px", borderRadius: 999, background: SOFT, color: PINE, font: "600 14px/1 var(--font-text)" }}
    >
      {busy ? "…" : label}
    </button>
  );
}

/** A date tile: "FRE" over "13" (canvas open-shift rows). */
function DateTile({ iso, lang, w = 52, h = 56 }) {
  const dt = new Date(iso + "T00:00:00");
  return (
    <span
      aria-hidden
      className="shrink-0 flex flex-col items-center justify-center"
      style={{ width: w, height: h, borderRadius: 14, background: TILE, gap: 1 }}
    >
      <span style={{ font: "600 10px/1.1 var(--font-text)", letterSpacing: "0.08em", textTransform: "uppercase", color: MUTED }}>
        {wdShort(dt, lang).replace(/\.$/, "")}
      </span>
      <span style={{ font: `700 20px/1 ${SORA}`, color: INK }}>{dt.getDate()}</span>
    </span>
  );
}

const OPEN_SHIFTS_PEEK = 3;

function OpenShiftsClaimCard({ rows, claimer, ownShifts, businessType }) {
  // PURE-PROPS rows: hoisted to the page-level loadData (same Promise.allSettled
  // as the schedule) so this card paints WITH the first render instead of
  // inserting itself after settle. Claim refreshes via onClaimed → loadData.
  const { t, lang } = useLanguage();
  const [showAll, setShowAll] = useState(false);
  const msg = claimer.where === "open" ? claimer.msg : "";

  // Silent when there's nothing to claim — but the "Added to your schedule"
  // confirmation must survive claiming the LAST shift (msg keeps the card
  // alive for its 3.5s moment; without this the card vanished mid-thanks).
  if (!rows.length && !msg) return null;

  // "Se alle" only when there is more than the peek — never a link to a list
  // that is already all on screen.
  const shown = showAll ? rows : rows.slice(0, OPEN_SHIFTS_PEEK);
  return (
    <section id="portal-open-shifts" data-testid="portal-open-shifts" style={{ scrollMarginTop: 8 }}>
      <div className="flex items-center justify-between" style={{ padding: "0 4px", minHeight: 24 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <HomeH2>{t("portalOpenTitle", "Open shifts")}</HomeH2>
          {rows.length > 0 && (
            <span
              className="inline-flex items-center justify-center tabular-nums"
              style={{ height: 20, minWidth: 20, padding: "0 6px", borderRadius: 10, background: PINE, color: CREAM, font: "700 11px/1 var(--font-text)" }}
            >
              {rows.length}
            </span>
          )}
        </div>
        {rows.length > OPEN_SHIFTS_PEEK && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="inline-flex items-center justify-center"
            style={{ minHeight: 44, minWidth: 44, margin: "-12px -10px -12px 0", padding: "0 10px", font: "600 13px/1 var(--font-text)", color: LINK }}
          >
            {showAll ? t("portalShowFewer", "Show fewer") : t("portalSeeAll", "See all")}
          </button>
        )}
      </div>
      {msg && (
        <div role="status" style={{ margin: "8px 4px 0", font: "500 13px/1.35 var(--font-text)", color: MUTED }}>{msg}</div>
      )}
      {shown.length > 0 && (
        <div style={{ marginTop: 8, background: CARD, border: `1px solid ${LINE}`, borderRadius: 22, overflow: "hidden" }}>
          {shown.map((o, i) => {
            const overlaps = overlapsOwnShift(o.date, `${o.start_time}–${o.end_time}`, ownShifts);
            const span = openSpanHours(o);
            return (
              <div key={o.id}>
                {i > 0 && <div aria-hidden style={{ height: 1, background: DIVIDER, marginLeft: 80 }} />}
                <div className="flex items-center" style={{ gap: 12, padding: "14px 12px 14px 14px" }}>
                  <DateTile iso={o.date} lang={lang} />
                  <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 3 }}>
                    {/* The tile is aria-hidden: the day, in words, for a screen reader. */}
                    <span className="sr-only">{fmtSwapDay(o.date, lang)}</span>
                    <span className="tabular-nums whitespace-nowrap" style={{ font: `700 16px/1.2 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>
                      {o.start_time}–{o.end_time}
                    </span>
                    <span className="flex items-center min-w-0" style={{ gap: 6, font: "400 13px/1.3 var(--font-text)", color: MUTED }}>
                      {o.role && (() => {
                        // Same mark as the card: brass for a role with no section.
                        const cls = roleBarColor(o.role, businessType);
                        const plain = cls === "bg-gray-600";
                        return <span aria-hidden className={`shrink-0${plain ? "" : ` ${cls}`}`} style={{ width: 7, height: 7, borderRadius: 2, ...(plain ? { background: BRASS } : {}) }} />;
                      })()}
                      <span className="truncate">
                        {[
                          o.role ? roleName(o.role, t) : null,
                          span != null ? formatHours(span, { lang, decimals: 2 }) : null,
                          // Multi-location S5: WHERE the hole is — a colleague
                          // sees the venue before taking a cross-location shift.
                          o.branch_name || null,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {/* Same pre-tap verdict Swaps gives. Finding out you clash
                        AFTER committing is the version that wastes a tap. */}
                    {overlaps && (
                      <span style={{ font: "600 12px/1.2 var(--font-text)", color: "#B42318" }}>{t("portalGaOverlaps", "Overlaps you")}</span>
                    )}
                  </div>
                  <TakeItButton
                    onClick={() => claimer.claim(o.id, "open")}
                    busy={claimer.claiming === o.id}
                    label={t("portalOpenClaim", "Take it")}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}


function ScheduleTab({ shifts: rawShifts, teamShifts, openShifts, token, restaurantName, restaurantCity, restaurantAddress, venue, businessType, coversByShift, onShiftsChanged, allShifts, calendarKey, schedState = "ok", onRetrySchedule, staffRole, focusDate, onOpenSwaps }) {
  const { t, lang } = useLanguage();
  const WD = useMemo(() => weekdayNames(lang), [lang]);
  // Defense-in-depth: the portal API already filters to published shifts
  // (get_portal_schedule), but never render a draft even if one ever slips
  // through — the owner's Publish action is the single source of truth for
  // what staff see, and the "This week" hours KPI must exclude drafts.
  const shifts = (rawShifts || []).filter((s) => s && s.status === "published");
  const today = toLocalISO(new Date());
  const weekStart = getWeekStart(today);

  const clock = useClock(token);
  const clockedIn = !!clock.st?.clocked_in;
  const confirmPunch = useConfirm();

  // Local UI state: which week is shown (0 = this week, 1 = next, …) + which
  // day is expanded. This was a two-state 'this' | 'next' toggle while the
  // server already sends 8 weeks (get_portal_schedule: week start + 55 days),
  // so a staffer rostered three weeks out could see the count of those shifts
  // and never their times.
  const [weekOffset, setWeekOffset] = useState(0);
  const [expandedDate, setExpandedDate] = useState(null);
  const goToWeek = (n) => { setWeekOffset(Math.max(0, n)); setExpandedDate(null); };
  // An alert about a shift or a published week opens THAT week. `focusDate`
  // carries a nonce so tapping the same alert twice still lands.
  useEffect(() => {
    if (!focusDate?.date) return;
    const off = weeksFrom(weekStart, focusDate.date);
    goToWeek(Math.min(PORTAL_WEEKS_AHEAD, Math.max(0, off)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDate?.n]);
  // Which teammate's upcoming shifts are open, keyed "<shiftId>|<mateId>" so
  // the same person expanded on two different days stays independent.
  const [openMate, setOpenMate] = useState(null);

  // Own "kan ikke arbejde" marks, so a free day in the strip is tappable to
  // mark unavailable right from the schedule (same StaffAvailability rows the
  // Availability tab writes — a strip mark shows there and vice-versa).
  const [unavail, setUnavail] = useState([]);
  const loadUnavail = async () => {
    try {
      const r = await portalApi.get(`/portal/${token}/availability`);
      setUnavail(r.data?.availability || []);
    } catch { /* non-fatal — the strip just won't show marks */ }
  };
  useEffect(() => { loadUnavail(); }, [token]);
  const unavailByDate = useMemo(() => {
    const m = {};
    (unavail || []).forEach((a) => { if (a.kind === "unavailable" && a.date) m[a.date] = a.id; });
    return m;
  }, [unavail]);
  const recurUnavailWeekdays = useMemo(() => {
    const s = new Set();
    (unavail || []).forEach((a) => { if (a.kind === "unavailable" && a.date == null && a.weekday != null) s.add(a.weekday); });
    return s;
  }, [unavail]);
  // Monday-first weekday index (matches the Availability calendar convention).
  const weekdayOfIso = (iso) => (new Date(iso + "T00:00:00").getDay() + 6) % 7;
  const isUnavailDay = (iso) => !!unavailByDate[iso] || recurUnavailWeekdays.has(weekdayOfIso(iso));
  // Where the sick-call form is open: "menu" (the card's ⋯ menu → under the
  // card) or "week" (the "Brug for en ændring?" section at the end of the
  // week list). null = closed. Both mount the same SickCallButton form.
  const [sickFrom, setSickFrom] = useState(null);
  const sickMenuRef = useRef(null);
  const sickWeekRef = useRef(null);
  // Bring the WHOLE form into view, its Send button above the floating tab
  // bar: block "end" against the scroller's scroll-padding-bottom (the bar's
  // height). "nearest" left Send under the bar from the menu, and the week
  // section did not scroll at all — Meld syg looked like it did nothing.
  useEffect(() => {
    const el = sickFrom === "menu" ? sickMenuRef.current : sickFrom === "week" ? sickWeekRef.current : null;
    el?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [sickFrom]);
  // The next-shift card's ⋯ sheet (Rute, Hvem er på, kalender, byt, Meld syg).
  const [menuOpen, setMenuOpen] = useState(false);

  // The week on screen, and how far forward paging may go: up to the last
  // week that has a published shift (never past the server's window).
  const lastShiftDate = shifts.reduce((m, sh) => (sh.date > m ? sh.date : m), "");
  const maxOffset = lastShiftDate
    ? Math.min(PORTAL_WEEKS_AHEAD, Math.max(0, weeksFrom(weekStart, lastShiftDate)))
    : 0;
  const visibleWeekStart = addDays(weekStart, 7 * weekOffset);
  const laterStart = addDays(visibleWeekStart, 7);

  // All 7 days of the visible week (OFF days included as silent dots).
  // `all` carries EVERY shift on the day; `shift` stays as the first one for
  // the strip, which draws one bar per day whatever happens on it. This used
  // to be `shifts.find()`, which kept the first and silently dropped the rest:
  // a split day (lunch, then back for dinner) showed one shift, and the week
  // total under-counted the hours the staffer is actually working. Splits are
  // normal in this trade, so the bug is common, invisible, and about pay.
  const dayShifts = (d) => shifts.filter((s) => s.date === d);
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(visibleWeekStart, i);
    const all = dayShifts(d);
    weekDays.push({ date: d, shift: all[0], all });
  }

  // The actual rows after the visible week, not just whether any exist — the
  // strip below names their dates (each one a jump to its week) so a staffer
  // who got an email about a later week can see it is really rostered.
  // Sorted, because the server orders by id.
  const laterShifts = shifts
    .filter((s) => s.date >= laterStart)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.start_time).localeCompare(String(b.start_time)));

  // Hours / counts for the muted summary line under the strip.

  // Next shift (drives the hero, countdown, teammate strip, .ics).
  const upcoming = shifts.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const nextShift = upcoming[0];
  // A shift's role: the per-shift override, else the staffer's OWN role —
  // the same fallback the owner's team schedule uses (staff.py:
  // `shift.role_on_shift or staff.role`). Without it the hero said
  // "Personale" while the profile sheet said "Køkken" for the same person,
  // because the override is empty on most shifts. "staff" is the backend's
  // placeholder for "no role", not a role to print.
  const effRole = (sh) =>
    sh?.role_on_shift || (staffRole && staffRole !== "staff" ? staffRole : null);
  const nextShiftRoleKey = effRole(nextShift);
  const nextShiftRole = nextShiftRoleKey
    ? roleName(nextShiftRoleKey, t)
    : t("portalRoleStaff", "Staff");

  // Countdown chip: nextShiftChip (utils/nextShiftCountdown) at the chip
  // itself. Its Date.now() read is recomputed each 15s render — minutes tick,
  // days do not need to.

  // Venue location — the owner sets this on their business profile. The
  // label ("Name, City") names the venue in the geofence hint.
  const venueLabel = restaurantName
    ? [restaurantName, restaurantCity].filter(Boolean).join(", ")
    : "";
  // The PLACE of the next shift, for the card and the Rute link. A shift at a
  // named location (multi-location) shows that location and its address; the
  // venue's map pin belongs to the venue, so it is never drawn for a shift
  // somewhere else. Otherwise: the venue, with the pin the owner confirmed
  // (`venue` on PortalInfo) — lat/lng arrive only once confirmed.
  //
  // `route` is what Rute searches when there is no pin. An address without a
  // street names a TOWN, not a door ("2200 København N", or a location with
  // no address at all): routing to it lands in the town centre, so Rute
  // searches the place's name in that town instead — what the app did before
  // the card carried the address. A location with no address of its own is
  // searched as "<venue> <location>, <venue's town>" (a bare "Hovedafdeling"
  // finds nothing).
  const venueName = venue?.name || restaurantName || "";
  const place = (() => {
    if (nextShift?.branch_name) {
      const bName = nextShift.branch_name;
      const bAddr = nextShift.branch_address || "";
      const withVenue = venueName && !bName.toLowerCase().includes(venueName.toLowerCase())
        ? `${venueName} ${bName}` : bName;
      return {
        name: bName, address: bAddr, lat: null, lng: null, hasMap: false, mapV: null,
        route: { name: bAddr ? bName : withVenue, address: bAddr, street: bAddr, town: restaurantCity || "" },
      };
    }
    const address = venue?.address_line || [restaurantAddress, restaurantCity].filter(Boolean).join(", ");
    const lat = venue?.lat ?? null;
    const lng = venue?.lng ?? null;
    return {
      name: venueName,
      address,
      lat,
      lng,
      hasMap: !!venue?.has_map,
      mapV: venue?.map_v || null,
      route: { lat, lng, name: venueName, address, street: restaurantAddress || "" },
    };
  })();
  const placeRouteUrl = routeUrl(place.route);

  // Subscribe ALL shifts as an auto-updating calendar feed (webcal://). One
  // tap on iOS opens the native "Subscribe to Calendar" dialog; the phone then
  // re-polls the feed, so a newly published or changed shift appears on its
  // own — no per-event add that iOS drops into Files. Falls back to https for
  // a manual add on clients without webcal.
  // This opens a webcal: SUBSCRIPTION, not a one-off "add". Once iOS accepts
  // it the calendar keeps itself up to date, so tapping again just offers a
  // duplicate — which is what a button that permanently reads "Add to my
  // calendar" invites you to do.
  //
  // The honest limit: webcal: hands off to the OS and never calls back, so we
  // cannot know whether the subscription was completed or the sheet was
  // cancelled. This flag therefore records that the button was TAPPED on this
  // device, and the copy it drives is conditional ("if you subscribed") rather
  // than a claim of success. Per token, so a shared phone doesn't inherit it.
  const calKey = token ? `bb_cal_${token.slice(0, 8)}` : null;
  const [calTapped, setCalTapped] = useState(() => {
    try { return !!(calKey && localStorage.getItem(calKey)); } catch { return false; }
  });
  const subscribeCalendar = () => {
    if (!token) return;
    const base = (portalApi.defaults.baseURL || "https://api.bonbox.dk/api").replace(/\/+$/, "");
    // A PIN-protected link's feed needs its own key (the calendar app can't
    // send the PIN header); the server hands it over only once the PIN is proven.
    const url = `${base}/portal/${token}/schedule.ics${calendarKey ? `?k=${encodeURIComponent(calendarKey)}` : ""}`;
    window.open(url.replace(/^https?:/, "webcal:"), "_blank", "noopener");
    try { if (calKey) localStorage.setItem(calKey, "1"); } catch { /* private mode */ }
    setCalTapped(true);
  };



  // Totals for the week ON SCREEN, not the fixed "this week" — paging to next

  // week has to move these numbers with it, or the footer describes a week

  // the staffer is not looking at.

  const weekTotals = useMemo(() => {

    // Flatten to shifts, not days — a split day is two shifts and two lots of
    // hours, and the old day-keyed reduce counted it once.
    const all = weekDays.flatMap((d) => d.all || (d.shift ? [d.shift] : []));

    const hours = all.reduce((a, s) => a + (Number(s.net_hours) || 0), 0);

    return { hours: Math.round(hours * 100) / 100, count: all.length };

  }, [weekDays]);

  // The ONE ceremonial beat: hero settles in once per page load. useRef pins
  // the decision for this mount so mid-animation re-renders (clock fetch,
  // freshness tick) can't strip the class before the 500ms beat completes;
  // the module-scope latch — written in a mount effect so render stays pure —
  // keeps tab-switch remounts still.
  const playBeat = useRef(!heroBeatPlayed).current;
  useEffect(() => {
    heroBeatPlayed = true;
  }, []);

  // Clock-in is time-locked until the owner's window opens (server-authoritative
  // via clock.st.locked/opens_at). Only meaningful before a punch.
  const clockLocked = !!(clock?.st?.locked) && !clock?.st?.clocked_in;
  // "Stempl ind" is the main button only when a shift is close (starts within
  // 2 hours, or is running). It was the hero action on a shift 18 days away
  // and punched in on one tap.
  const shiftSoon = (() => {
    if (!nextShift?.date || !nextShift?.start_time) return false;
    const start = new Date(`${nextShift.date}T${nextShift.start_time}:00`);
    const end = nextShift.end_time ? new Date(`${nextShift.date}T${nextShift.end_time}:00`) : null;
    if (end && end <= start) end.setDate(end.getDate() + 1);
    const now = Date.now();
    return start.getTime() - now <= 2 * 3600 * 1000 && (!end || end.getTime() > now);
  })();
  // The punch button sits on the card only while it is the thing to do.
  const showPunch = shiftSoon || clockedIn;
  const clockInNow = async () => {
    if (!shiftSoon) {
      const ok = await confirmPunch({
        title: t("portalPunchNoShiftTitle", "No shift right now — clock in anyway?"),
        message: t("portalPunchNoShiftBody", "Your hours start counting now and your manager sees an unplanned shift."),
        confirmLabel: t("portalClockInCta"),
      });
      if (!ok) return;
    }
    clock.act("in");
  };
  // A shift's length — a duration, so it goes through the one formatter. It
  // used to take its HOUR unit from t("portalHrsCompact") and type its MINUTE
  // unit inline: a hybrid that read "6t 15m" in Danish (glued, wrong minute
  // word) and "6h 15m" in Turkish, where the catalogue has no key and the unit
  // is "sa"/"dk". hours.js owns both units now.
  // ONE hours format per language, the owner app's: "8,5 t" / "8.5 h"
  // (hours.js formatHours, 2 decimals like a per-shift figure there). This
  // screen printed "8 t 30 min" while Timer printed "8,5 timer" for the same
  // shift. Hours-and-minutes stays only on running clocks (countdown,
  // elapsed), which are read like a clock, not like a quantity.
  const fmtHM = (h) => formatHours(h == null ? null : Number(h), { lang, decimals: 2 });

  // The sick-call form opens from two places — the card's ⋯ menu and the
  // "Brug for en ændring?" tiles at the end of the week — and renders where
  // it was asked for: under the card, or under the tiles. null = closed.
  const openSick = (from) => { setMenuOpen(false); setSickFrom(from); };

  // ── Canvas "Pine, ivory & brass" (Nov 2026) ─────────────────────────────
  const narrowPhone = useNarrowPhone();
  // "Jeg har set det" lives on the card now (it was a strip under it).
  const confirm = useScheduleConfirm({ token, shifts, allShifts, onConfirmed: onShiftsChanged });
  // One claim state for both places an open shift can be taken from.
  const claimer = useOpenShiftClaim(token, onShiftsChanged);

  // Clocked in: the shift being worked (planned start/end for the ring), or
  // null for a clock-in with no planned shift. Its ⋯ menu is about that shift.
  const live = clockedIn ? liveShiftOf(shifts, clock.st?.since) : null;
  const liveShift = live?.shift || null;
  const menuShift = clockedIn ? (liveShift || nextShift) : nextShift;
  // The ⋯ sheet plays its exit after menuOpen goes false (sheetMotion.js),
  // still showing the shift it opened on.
  const menuSheet = usePresence(menuOpen && !!menuShift);
  const menuSheetShift = useLastValue(menuOpen ? menuShift : null);
  // Canvas "Næste vagt" under the live card: the shift after the one on now.
  const afterLive = clockedIn
    ? [...upcoming]
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.start_time).localeCompare(String(b.start_time)))
      .find((s) => s !== liveShift && (!liveShift
        || s.date > liveShift.date
        || (s.date === liveShift.date && String(s.start_time) > String(liveShift.start_time))))
    : null;

  // Open shifts that fall in the week on screen — drawn as dashed "Ledig
  // vagt" rows in the week list and as brass rings in the date strip.
  const weekOpen = (openShifts || []).filter((o) => o?.date >= visibleWeekStart && o.date < laterStart);
  const openOn = (d) => weekOpen.filter((o) => o.date === d);

  // "Open that day in the week list": from Hvem er på, Næste vagt and the
  // date strip. Pages to the day's week, marks it, then scrolls its row in.
  const [dayJump, setDayJump] = useState(null);
  const jumpToDay = (date) => {
    if (!date) return;
    goToWeek(Math.min(PORTAL_WEEKS_AHEAD, Math.max(0, weeksFrom(weekStart, date))));
    setExpandedDate(date);
    setDayJump({ date, n: Date.now() });
  };
  useEffect(() => {
    if (!dayJump) return;
    document.getElementById(`portal-day-${dayJump.date}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [dayJump]);

  // A role as the canvas draws it: a 7 px rounded square in the role's
  // colour — brass when the role has no section of its own (the canvas's
  // "Tjener"), on the card and on ivory alike.
  const roleSquare = (role) => {
    const cls = roleBarColor(role, businessType);
    const plain = cls === "bg-gray-600";
    return (
      <span
        aria-hidden
        className={`inline-block shrink-0${plain ? "" : ` ${cls}`}`}
        style={{ width: 7, height: 7, borderRadius: 2, ...(plain ? { background: BRASS } : {}) }}
      />
    );
  };

  // Rute — the only moment anything leaves BonBox, and only on a tap
  // (utils/routeUrl: Apple Maps on iPhone, the phone's own map app on
  // Android, Google Maps elsewhere). A cream hairline ghost beside the card's
  // one brass button, as on the canvas.
  const ruteBtn = placeRouteUrl ? (
    <a
      href={placeRouteUrl}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="portal-route"
      aria-label={t("portalRouteTo", "Directions to {venue}", { venue: place.name || place.address })}
      className="shrink-0 inline-flex items-center justify-center vp-press focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      style={{
        gap: 8, height: 48, padding: "0 16px", borderRadius: 14, boxSizing: "border-box",
        border: "1px solid rgba(243,239,228,0.24)", background: "rgba(243,239,228,0.06)",
        color: CREAM, font: "600 14px/1 var(--font-text)",
      }}
    >
      <Navigation size={16} strokeWidth={2} aria-hidden />
      {t("portalRoute", "Directions")}
    </a>
  ) : null;

  const brassBtn = {
    flex: "1 1 auto", minWidth: 0, height: 48, gap: 8, borderRadius: 14,
    background: BRASS, color: PINE, font: "600 15px/1 var(--font-text)", whiteSpace: "nowrap",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35)",
  };

  // Everything the clock has to say, under whichever card is showing.
  const clockNotes = (
    <>
      {clock.err?.kind === "too_far" ? (
        /* Calm "almost there" — amber, not red. Being off-site isn't an
           error the worker caused; show how far + what to do. Numbers are
           server-stamped (the 403 carries distance_m/radius_m). */
        <div className="mt-3 rounded-lg bg-amber-500/10 ring-1 ring-amber-400/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-200">
            <MapPinOff className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
            <span>
              {restaurantName
                ? t("portalClockTooFarDist", "About {dist} from {venue}", { dist: formatClockDistance(clock.err.distance_m, lang), venue: restaurantName })
                : t("portalClockTooFarDistNoVenue", "About {dist} from the venue", { dist: formatClockDistance(clock.err.distance_m, lang) })}
            </span>
          </div>
          <div className="mt-1 text-[12px]" style={{ color: SAGE }}>
            {t("portalClockTooFarRadius", "Clock-in opens within {radius} m of the venue.", { radius: clock.err.radius_m })}
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "rgba(243,239,228,.8)" }}>
            {t("portalClockTooFarDo", "Head over and try again when you're there.")}
          </div>
          {/* Direction, not just distance. Drawn from the fix already
              used for this punch — no second permission prompt. */}
          {clock.lastFix && clock.st?.geofence?.lat && (
            <div className="mt-3">
              <GeofenceDial
                venue={clock.st.geofence}
                me={clock.lastFix}
                radiusM={clock.st.geofence.radius_m}
                accuracyM={clock.lastFix.accuracy}
              />
            </div>
          )}
        </div>
      ) : clock.err?.kind === "too_early" ? (
        <div className="mt-2 flex items-center gap-1.5 text-[12px]" style={{ color: SAGE }}>
          <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
          <span>{t("portalClockOpensAt", "Clock-in opens at {t}", { t: clock.err.opens_at || "—" })}</span>
        </div>
      ) : clock.err ? (
        <div role="alert" className="mt-2 text-[12px] text-red-200">{clock.err}</div>
      ) : null}
      {clock.result && !clock.err && (
        <div role="status" className="mt-2 text-[12px]" style={{ color: "rgba(243,239,228,.86)" }}>{clock.result}</div>
      )}
    </>
  );

  const pineCard = {
    borderRadius: 24, padding: "16px 18px 18px", background: PINE, color: CREAM,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 24px 48px -28px rgba(14,59,46,0.7)",
  };

  // The ⋯ button in the card's top row (44 px, the canvas's own size; the
  // negative margins keep the chip row at 28).
  const menuBtn = menuShift ? (
    <button
      type="button"
      onClick={() => setMenuOpen(true)}
      aria-label={t("portalShiftMenu", "More options for this shift")}
      aria-haspopup="dialog"
      data-testid="portal-shift-menu-btn"
      className="shrink-0 flex items-center justify-center rounded-full vp-press focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      style={{ width: 44, height: 44, minHeight: 0, margin: "-8px -10px -8px 0", color: CREAM }}
    >
      <MoreHorizontal size={20} strokeWidth={2.2} aria-hidden />
    </button>
  ) : null;

  const countLine = (n) => (n === 1
    ? t("portalWeekShiftCountOne", "{n} shift", { n })
    : t("portalWeekShiftCount", "{n} shifts", { n }));
  const emptyWeekTitle = weekOffset === 0
    ? t("portalWeekNoShifts", "No shifts this week")
    : weekOffset === 1
      ? t("portalWeekNoShiftsNext", "No shifts next week")
      : t("portalWeekNoShiftsThat", "No shifts that week");

  return (
    <div className="space-y-5">
      {clockedIn ? (
        /* LIVE — clocked in (canvas "Aktiv vagt"). The ring is the time on
           the clock against the planned shift; Start pause / Slut pause is
           there only when the owner turned live breaks on (breaks_live). */
        <section
          className={`relative${playBeat ? " motion-safe:animate-heroSettle" : ""}`}
          data-testid="portal-hero"
          data-state="live"
          style={pineCard}
        >
          <LiveShiftCard clock={clock} live={live} menuBtn={menuBtn} />
          {clockNotes}
        </section>
      ) : (
      /* HERO — the next shift on one flat pine card (canvas "Pine, ivory &
         brass", Nov 2026; home v3 dropped the gradient, bloom and sheen).
         Chip with the countdown, the time in Sora, role · pause ·
         effektiv, OUR server-drawn map, the place, then ONE brass action —
         "Jeg har set det", the dashed "Vagten er bekræftet" once it is, or
         "Stempl ind" when the shift is close — beside a ghost Rute. */
      <section
        className={`relative${playBeat ? " motion-safe:animate-heroSettle" : ""}`}
        data-testid="portal-hero"
        data-state="next"
        style={pineCard}
      >
        <div className="flex items-center justify-between" style={{ gap: 12, minHeight: 28 }}>
          {nextShift ? (
            <span
              className="inline-flex items-center min-w-0"
              data-testid="portal-hero-chip"
              style={{
                gap: 8, height: 28, padding: "0 12px 0 10px", borderRadius: 999,
                background: shiftSoon ? "rgba(200,164,100,0.28)" : "rgba(200,164,100,0.16)",
                font: "600 12.5px/1 var(--font-text)", color: CREAM, whiteSpace: "nowrap",
              }}
            >
              <span aria-hidden className="shrink-0" style={{ width: 6, height: 6, borderRadius: 99, background: BRASS, boxShadow: "0 0 0 3px rgba(200,164,100,0.3)" }} />
              <span className="truncate">
                {nextShiftChip(nextShift, t, { today: isToday(nextShift.date), dateLabel: fmtDate(nextShift.date, lang) })}
              </span>
            </span>
          ) : (
            <span className="uppercase" style={{ font: "600 11px/1 var(--font-text)", letterSpacing: "0.14em", color: SAGE }}>
              {t("portalNextShiftHero")}
            </span>
          )}
          {menuBtn}
        </div>

        {nextShift ? (
          <>
            <p
              className="tabular-nums whitespace-nowrap"
              data-testid="portal-hero-time"
              style={{ margin: "12px 0 0", fontFamily: SORA, fontWeight: 700, fontSize: "clamp(36px, 10.5vw, 46px)", lineHeight: 1, letterSpacing: "-0.035em", color: CREAM }}
            >
              {/* The dash in DM Sans 500 (Sora is loaded at 600/700 only). */}
              {nextShift.start_time}<span style={{ color: "#7F9A8C", fontFamily: "var(--font-text)", fontWeight: 500, padding: "0 0.1em" }}>–</span>{nextShift.end_time}
            </p>
            {/* role · unpaid break · net (paid), from the owner's rostered
                shift; with no break, the one figure. The span is the time
                right above, so it is not said twice. */}
            <p
              className="flex flex-wrap items-center"
              data-testid="portal-hero-meta"
              style={{ margin: "8px 0 0", gap: "2px 8px", font: "400 13px/1.35 var(--font-text)", color: SAGE }}
            >
              <span className="inline-flex items-center" style={{ gap: 6, color: CREAM, fontWeight: 600 }}>
                {roleSquare(effRole(nextShift))}
                {nextShiftRole}
              </span>
              {nextShift.break_minutes > 0 ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums whitespace-nowrap">{t("portalHoursBreak", "{m} min break", { m: nextShift.break_minutes })}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums whitespace-nowrap">{t("portalHoursNet", "{h} net", { h: fmtHM(nextShift.net_hours) })}</span>
                </>
              ) : (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums whitespace-nowrap">{t("portalHoursGross", "{h} shift", { h: fmtHM(nextShift.net_hours) })}</span>
                </>
              )}
            </p>

            {/* Booked covers for this shift's night — the reason to hold both
                the book and the roster. Count ONLY: the server sends one
                integer per shift and nothing about the guests (no allergy
                signal: Art.9 health data). NOT tappable — staff must never
                reach the guest list. "booket" is load-bearing: walk-ins never
                enter the book. 0 is not shown ("0 gæster booket" reads as a
                dead night when it usually means nobody has booked YET). */}
            {typeof coversByShift?.[nextShift.id] === "number" && coversByShift[nextShift.id] > 0 && (
              <div className="mt-2 inline-flex items-center gap-1.5 text-[12px]" style={{ color: SAGE }} data-testid="portal-hero-covers">
                <Users className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span className="tabular-nums">
                  {t("portalCoversBooked", "{n} guests booked", { n: coversByShift[nextShift.id] })}
                </span>
              </div>
            )}

            {/* The map — OUR server's drawing of the venue's own pin, only
                once the owner confirmed it (PortalInfo.venue.has_map). A
                still image: no route line, and never the staffer's position. */}
            {token && place.hasMap && <VenueMapImage token={token} venueName={place.name} mapV={place.mapV} />}

            {/* The place: venue (or the shift's own location) and its
                address. Name ONLY when the owner gave no address — never a
                fabricated one. No "you are at …": the app does not know where
                the phone is, and does not ask. */}
            {(place.name || place.address) && (
              <div
                className="flex items-center min-w-0"
                data-testid="portal-hero-place"
                style={{ marginTop: 12, gap: 8, font: "400 13px/1.3 var(--font-text)", color: SAGE }}
              >
                <MapPin size={14} strokeWidth={2} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate">
                  {place.name && <strong style={{ color: CREAM, fontWeight: 600 }}>{place.name}</strong>}
                  {place.address && place.address !== place.name && (
                    <>{place.name ? " · " : ""}{place.address}</>
                  )}
                </span>
              </div>
            )}

            {/* ONE brass action beside Rute. Stempl ind sits here only while
                the shift is close (starts within 2 h, or is running) — it was
                the hero action on a shift 18 days away. Further out it is the
                ⋯ menu's first row (same clockInNow, same confirm). Otherwise
                the card asks for "Jeg har set det", and rests on "Vagten er
                bekræftet" once every shift on screen is confirmed (the truth
                is confirmed_at, never a local flag). */}
            {token && (
              <div className="flex" style={{ marginTop: 14, gap: 8 }}>
                {showPunch ? (
                  <button
                    type="button"
                    disabled={clock.busy || clockLocked}
                    onClick={clockInNow}
                    className="inline-flex items-center justify-center vp-press disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    style={{ ...brassBtn, fontWeight: 700, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 0 0 4px rgba(200,164,100,0.18)" }}
                  >
                    {clockLocked
                      ? <Lock size={16} strokeWidth={2.2} aria-hidden className="shrink-0" />
                      : <LogIn size={18} strokeWidth={2.25} aria-hidden className="shrink-0" />}
                    {t("portalClockInCta")}
                  </button>
                ) : confirm.show && !confirm.allConfirmed ? (
                  <button
                    type="button"
                    onClick={confirm.submit}
                    disabled={confirm.submitting}
                    data-testid="portal-seen-it"
                    className="inline-flex items-center justify-center vp-press disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    style={brassBtn}
                  >
                    {confirm.submitting ? "…" : (
                      <>
                        <Check size={18} strokeWidth={2.25} aria-hidden className="shrink-0" />
                        <span className="truncate">{t("portalSeenIt")}</span>
                      </>
                    )}
                  </button>
                ) : confirm.show ? (
                  <div
                    role="status"
                    data-testid="portal-hero-confirmed"
                    className="inline-flex items-center justify-center"
                    style={{
                      flex: "1 1 auto", minWidth: 0, height: 48, gap: 8, boxSizing: "border-box",
                      borderRadius: 14, border: "1px dashed rgba(200,164,100,0.55)", background: "rgba(200,164,100,0.08)",
                      color: CREAM, font: "600 14px/1 var(--font-text)", whiteSpace: "nowrap",
                    }}
                  >
                    <span aria-hidden className="shrink-0 inline-flex items-center justify-center rounded-full" style={{ width: 20, height: 20, background: BRASS, color: PINE }}>
                      <Check size={12} strokeWidth={3.2} />
                    </span>
                    <span className="truncate">
                      {narrowPhone ? t("portalShiftConfirmedShort", "Confirmed") : t("portalShiftConfirmed", "Shift confirmed")}
                    </span>
                  </div>
                ) : null}
                {ruteBtn}
              </div>
            )}
            {confirm.feedback && (
              <div role="status" className="mt-2 text-[12px]" style={{ color: CREAM }}>{confirm.feedback}</div>
            )}
            {confirm.error && <div role="alert" className="mt-2 text-[12px] text-red-200">{confirm.error}</div>}
            {confirm.allConfirmed && confirm.unconfirmedElsewhere > 0 && (
              <div className="mt-2 text-[12px]" style={{ color: "#E9D3A6" }}>
                {t("portalConfirmOtherDept", "{n} shifts at another location are still unconfirmed — switch to All.")
                  .split("{n}").join(String(confirm.unconfirmedElsewhere))}
              </div>
            )}

            {/* Clock-in geofence: an honest "Stempl kun ind ved <venue>" lock
                hint so the staffer knows clock-in is location-bound before
                they try it (the server's too_far 403 is still the real gate). */}
            {showPunch && clock.st?.geofence_on && venueLabel && (
              <div className="mt-2.5 flex items-center gap-1.5 text-[12px]" style={{ color: SAGE }}>
                <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span className="truncate">{t("portalClockOnlyAt", "Clock in only at {venue}", { venue: venueLabel })}</span>
              </div>
            )}
            {/* Låst — clock-in is time-locked until the owner's window opens.
                Honest, specific: shows the exact open time from the server. */}
            {showPunch && clockLocked && clock.st?.opens_at && (
              <div className="mt-2.5 flex items-center gap-1.5 text-[12px]" style={{ color: SAGE }}>
                <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span>{t("portalClockOpensAt", "Clock-in opens at {t}", { t: clock.st.opens_at })}</span>
              </div>
            )}
            {clockNotes}
          </>
        ) : schedState === "loading" ? (
          /* Not answered yet — a placeholder, never "no shift". Saying
             "Ingen kommende vagt" before the first response lands tells
             someone who works tonight that they don't. */
          <div className="relative mt-3 space-y-2.5" data-testid="portal-hero-loading" aria-label={t("portalScheduleLoading", "Loading your schedule…")}>
            <div className="h-9 w-3/4 rounded-lg vp-shimmer vp-shimmer-dark" style={{ background: "rgba(243,239,228,.10)" }} />
            <div className="h-3.5 w-1/2 rounded vp-shimmer vp-shimmer-dark" style={{ background: "rgba(243,239,228,.10)" }} />
          </div>
        ) : schedState === "error" ? (
          /* The schedule call failed and there is nothing last-good to show:
             say so, and offer the retry right here. */
          <div className="relative mt-2" data-testid="portal-hero-failed">
            <div className="flex items-center gap-2" style={{ font: `700 18px/1.25 ${SORA}`, color: CREAM }}>
              <CloudOff className="w-5 h-5 shrink-0" strokeWidth={2.2} aria-hidden style={{ color: BRASS }} />
              {t("portalScheduleLoadFailed", "Couldn't load your schedule")}
            </div>
            <div className="mt-1.5 text-[13px]" style={{ color: SAGE }}>
              {t("portalScheduleLoadFailedHint", "Check your connection — your shifts are not gone.")}
            </div>
            {onRetrySchedule && (
              <button
                type="button"
                onClick={onRetrySchedule}
                className="mt-3.5 inline-flex items-center justify-center vp-press"
                style={{ ...brassBtn, flex: "none", padding: "0 20px" }}
              >
                <RefreshCw className="w-4 h-4" strokeWidth={2.4} aria-hidden />
                {t("tryAgain", "Try again")}
              </button>
            )}
          </div>
        ) : (
          <>
            <div style={{ marginTop: 10, font: `700 24px/1.2 ${SORA}`, letterSpacing: "-0.02em", color: CREAM }}>{t("portalNoUpcomingShift")}</div>
            {/* TWO empty states, not one. "You'll get notified when the venue
                publishes the schedule" is true only while nothing is published.
                Once the rota IS out and this staffer simply isn't on it, that
                sentence tells them to keep waiting for a message that will
                never come. `teamShifts` already tells us which case we're in. */}
            {(teamShifts || []).some((s) => s.date >= today) ? (
              <div className="mt-2 text-[13px]" style={{ color: SAGE }}>
                {t(
                  "portalNoShiftPublished",
                  "The schedule is out and you're not on it. Ask {venue} if that looks wrong.",
                  { venue: restaurantName || "" },
                )}
              </div>
            ) : (
              <div className="mt-2 text-[13px]" style={{ color: SAGE }}>
                {t("portalNoShiftHint", "You'll get notified here when {venue} publishes the schedule.", { venue: restaurantName || "" })}
              </div>
            )}
          </>
        )}
      </section>
      )}

      {/* Sick-call form, opened from the card's ⋯ menu — it renders right
          under the card it was asked from. */}
      {token && sickFrom === "menu" && (
        <div ref={sickMenuRef} data-testid="portal-sick-from-menu">
          <SickCallButton
            token={token}
            upcomingShifts={upcoming}
            // The menu belongs to the card's shift: the form opens on its day.
            initialDate={menuShift?.date}
            onCalledIn={onShiftsChanged}
            // Dismissing unmounts it; the menu row stays the way back in.
            onDismiss={() => setSickFrom(null)}
            // Straight to the form: the row already stated the intent.
            autoOpen
          />
        </div>
      )}

      {/* Hvem er på — its own card (was folded inside the hero). While
          clocked in it is "På vagt nu", about the shift being worked. */}
      {token && (clockedIn ? (liveShift || nextShift) : nextShift) && (
        <WhosOnStrip
          teamShifts={teamShifts || []}
          nextShift={clockedIn ? (liveShift || nextShift) : nextShift}
          live={clockedIn}
          onOpen={() => jumpToDay((clockedIn ? (liveShift || nextShift) : nextShift)?.date)}
        />
      )}

      {/* Næste vagt — under the live card, the shift after this one. */}
      {clockedIn && afterLive && (
        <section data-testid="portal-after-live">
          <HomeH2 style={{ padding: "0 4px" }}>{t("portalNextShiftRow", "Next shift")}</HomeH2>
          <button
            type="button"
            onClick={() => jumpToDay(afterLive.date)}
            className="w-full flex items-center text-left vp-press vp-row active:opacity-80"
            style={{ marginTop: 8, gap: 12, padding: "12px 14px", borderRadius: 20, background: CARD, border: `1px solid ${LINE}`, color: INK }}
          >
            <DateTile iso={afterLive.date} lang={lang} w={48} h={52} />
            <span className="flex-1 min-w-0 flex flex-col" style={{ gap: 3 }}>
              <span className="tabular-nums whitespace-nowrap" style={{ font: `700 16px/1.2 ${SORA}` }}>{afterLive.start_time}–{afterLive.end_time}</span>
              <span className="flex items-center min-w-0" style={{ gap: 6, font: "400 13px/1.3 var(--font-text)", color: MUTED }}>
                {roleSquare(effRole(afterLive))}
                <span className="truncate">
                  {[
                    effRole(afterLive) ? roleName(effRole(afterLive), t) : null,
                    t("portalHoursNet", "{h} net", { h: fmtHM(afterLive.net_hours) }),
                  ].filter(Boolean).join(" · ")}
                </span>
              </span>
            </span>
            <ChevronRight size={18} strokeWidth={2} aria-hidden className="shrink-0" style={{ color: MUTED }} />
          </button>
        </section>
      )}

      {/* Åbne vagter — open shifts this staffer can pick up one-tap. */}
      {token && <OpenShiftsClaimCard rows={openShifts || []} claimer={claimer} ownShifts={shifts} businessType={businessType} />}

      {/* THE WEEK — canvas "Hjem – rullet" + "Ugeoversigt": a header with the
          range, the 7-day date strip (pine dot = your shift, brass ring = an
          open shift, pine chip = today), the week's count and effektiv hours,
          then every day that has something: your shifts as rows (today
          outlined in pine) and open shifts as dashed rows with "Tag den". */}
      <section
        data-testid="portal-week"
        style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 24, padding: "16px 14px 14px" }}
      >
        {/* Pages week by week up to the last week with a published shift;
            "I dag" is the one-tap way back once you have paged away. */}
        <div className="flex items-center justify-between" style={{ gap: 8, padding: "0 4px" }}>
          <div className="min-w-0 flex flex-col" style={{ gap: 2 }}>
            <span className="flex items-center" style={{ gap: 8, minHeight: 16 }}>
              <span
                data-testid="portal-week-label"
                style={{ font: "600 11px/1.2 var(--font-text)", letterSpacing: "0.14em", textTransform: "uppercase", color: MUTED }}
              >
                {weekOffset === 0
                  ? t("portalSecThisWeek", "This week")
                  : weekOffset === 1
                    ? t("portalSecNextWeek", "Next week")
                    : t("portalWeekN", "Week {n}", { n: isoWeekNumber(visibleWeekStart) })}
              </span>
              {weekOffset > 0 && (
                <button
                  type="button"
                  onClick={() => goToWeek(0)}
                  aria-label={t("portalBackToThisWeek", "Back to this week")}
                  // A small pill; the ::before makes its hit area 44 tall.
                  className="relative before:absolute before:-inset-x-2 before:-inset-y-[13px] before:content-['']"
                  style={{ minHeight: 0, padding: "3px 8px", borderRadius: 999, background: SOFT, color: PINE, font: "600 11px/1 var(--font-text)" }}
                >
                  {t("portalToday", "Today")}
                </button>
              )}
            </span>
            <h2 className="tabular-nums truncate" style={{ margin: 0, font: `700 18px/1.25 ${SORA}`, letterSpacing: "-0.015em", color: INK }}>
              {fmtWeekRange(visibleWeekStart, lang)}
            </h2>
          </div>
          <div className="flex items-center shrink-0" style={{ gap: 6 }}>
            {[["prev", weekOffset > 0], ["next", weekOffset < maxOffset]].map(([dir, enabled]) => (
              <button
                key={dir}
                type="button"
                disabled={!enabled}
                onClick={() => goToWeek(weekOffset + (dir === "next" ? 1 : -1))}
                aria-label={dir === "next" ? t("portalWeekNext", "Next week") : t("portalWeekPrev", "Previous week")}
                className="flex items-center justify-center vp-press"
                style={{
                  width: 44, height: 44, borderRadius: 14, border: `1px solid ${LINE}`, background: CARD,
                  color: dir === "next" ? INK : MUTED, opacity: enabled ? 1 : 0.4, cursor: enabled ? "pointer" : "default",
                }}
              >
                {dir === "next"
                  ? <ChevronRight size={18} strokeWidth={2} aria-hidden />
                  : <ChevronLeft size={18} strokeWidth={2} aria-hidden />}
              </button>
            ))}
          </div>
        </div>

        {/* The date strip — the glance layer. Tap a day with something on it
            to bring its row into view; a free future day toggles its mark
            ("kan ikke arbejde" shows as a struck date). */}
        <div
          className="grid"
          data-testid="portal-week-strip"
          style={{ margin: "14px -10px 0", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: narrowPhone ? 0 : 2 }}
        >
          {weekDays.map(({ date: d, shift }, i) => {
            const isTodayCell = isToday(d);
            const isExpanded = expandedDate === d;
            const dayUnavail = isUnavailDay(d);
            const free = !shift && openOn(d).length > 0;
            const cellTappable = !!shift || free || !isPast(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => {
                  if (isExpanded || !cellTappable) { setExpandedDate(null); return; }
                  setExpandedDate(d);
                  if (shift || free) setDayJump({ date: d, n: Date.now() });
                }}
                className="min-w-0 flex flex-col items-center justify-center vp-press focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/40"
                style={{
                  height: 70, gap: 4, padding: 0, borderRadius: 14,
                  background: isTodayCell ? PINE : isExpanded ? SOFT : "transparent",
                  color: isTodayCell ? CREAM : INK,
                  boxShadow: isTodayCell ? "0 10px 20px -12px rgba(14,59,46,0.8)" : "none",
                }}
                aria-label={`${WD[i]} ${fmtShort(d, lang)}${
                  shift ? ` · ${t("portalLegendMine", "Your shift")}`
                    : free ? ` · ${t("portalLegendFree", "Open")}`
                    : dayUnavail ? ` · ${t("portalUnavailBadge", "Can't work")}` : ""}`}
                aria-current={isTodayCell ? "date" : undefined}
                aria-expanded={cellTappable ? isExpanded : undefined}
              >
                {/* Canvas strip: "man", "tir", "ons" — no full stop. */}
                <span style={{ font: "500 11px/1 var(--font-text)", color: isTodayCell ? SAGE : MUTED }}>{String(WD[i]).replace(/\.$/, "")}</span>
                <span
                  className="tabular-nums"
                  style={{
                    font: `700 17px/1 ${SORA}`,
                    textDecoration: dayUnavail && !shift ? "line-through" : "none",
                    // Terracotta = "kan ikke", as on Fravær (amber/brass
                    // means "Afventer" there). On today's pine cell the
                    // terracotta wash, so the strike stays legible.
                    textDecorationColor: dayUnavail && !shift ? (isTodayCell ? RED_WASH : RED_INK) : undefined,
                  }}
                >
                  {parseInt(d.slice(8), 10)}
                </span>
                {dayUnavail && !shift && !free ? (
                  <CalendarOff data-testid="portal-strip-cant" className="w-3 h-3" style={{ color: isTodayCell ? RED_WASH : RED_INK }} strokeWidth={2.5} aria-hidden />
                ) : (
                  <span
                    aria-hidden
                    style={{
                      width: 6, height: 6, borderRadius: 99, boxSizing: "border-box",
                      background: shift ? (isTodayCell ? BRASS : PINE) : "transparent",
                      border: free ? `1.5px solid ${isTodayCell ? BRASS : "#8A6A2F"}` : "none",
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* The two numbers that answer "how much am I working this week?",
            for the week ON SCREEN (paging moves them), and the strip's key. */}
        {weekTotals.count === 0 && schedState !== "ok" ? (
          <div style={{ marginTop: 12, padding: "12px 4px 0", borderTop: `1px solid ${DIVIDER}` }}>
            {/* Not an answer yet (or the call failed): no "no shifts" claim. */}
            <span aria-hidden className="inline-block h-3 w-28 rounded align-middle" style={{ background: TILE }} />
          </div>
        ) : (weekTotals.count > 0 || weekOpen.length > 0) ? (
          <div
            className="flex flex-wrap items-center justify-between"
            style={{ marginTop: 12, padding: "12px 4px 0", borderTop: `1px solid ${DIVIDER}`, gap: "8px 12px" }}
          >
            <span className="tabular-nums" data-testid="portal-week-summary" style={{ font: "400 13px/1.3 var(--font-text)", color: INK }}>
              {weekTotals.count > 0 ? (
                <>
                  <strong style={{ fontWeight: 600 }}>{countLine(weekTotals.count)}</strong>{" "}
                  <span style={{ color: MUTED }}>· {t("portalHoursNet", "{h} net", { h: fmtHM(weekTotals.hours) })}</span>
                </>
              ) : (
                <strong style={{ fontWeight: 600 }}>{emptyWeekTitle}</strong>
              )}
            </span>
            {weekOpen.length > 0 && (
              <span className="flex items-center" style={{ gap: 12, font: "400 12px/1 var(--font-text)", color: MUTED }} aria-hidden>
                <span className="flex items-center" style={{ gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: PINE }} />{t("portalLegendMine", "Your shift")}
                </span>
                <span className="flex items-center" style={{ gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, boxSizing: "border-box", border: "1.5px solid #8A6A2F" }} />{t("portalLegendFree", "Open")}
                </span>
              </span>
            )}
          </div>
        ) : null}
        {claimer.where === "week" && claimer.msg && (
          <div role="status" style={{ margin: "10px 4px 0", font: "500 13px/1.35 var(--font-text)", color: MUTED }}>{claimer.msg}</div>
        )}

        {/* THE WEEK'S TIMES — every day of the week on screen that has a
            shift or an open shift, side by side. Next week is the reason a
            staffer opens this app on purpose; its times were once
            unreachable behind a this/next toggle. Multiple shifts on one day
            are separate rows (a split day used to show one and under-count). */}
        {(() => {
          const days = weekDays.filter((d) => (d.all || []).length || openOn(d.date).length);
          if (!days.length) {
            if (schedState !== "ok") return null;
            return (
              <div data-testid="portal-week-empty" className="flex flex-col items-center text-center" style={{ padding: "26px 10px 10px", gap: 10 }}>
                <span className="flex items-center justify-center" style={{ width: 64, height: 64, borderRadius: 20, background: SOFT, color: PINE }}>
                  <CalendarCheck size={28} strokeWidth={1.6} aria-hidden />
                </span>
                <h3 style={{ margin: "6px 0 0", font: `700 18px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>{emptyWeekTitle}</h3>
                <p style={{ margin: 0, maxWidth: 270, font: "400 14px/1.5 var(--font-text)", color: MUTED, textWrap: "pretty" }}>
                  {t("portalWeekEmptyBody", "You're free. New and open shifts show up here as soon as they're posted.")}
                </p>
                {/* Only when there IS an open shift to see — never a button
                    to an empty list. */}
                {(openShifts || []).length > 0 && (
                  <button
                    type="button"
                    onClick={() => document.getElementById("portal-open-shifts")?.scrollIntoView?.({ block: "start", behavior: "smooth" })}
                    className="inline-flex items-center vp-press"
                    style={{ marginTop: 8, height: 48, gap: 8, padding: "0 20px", borderRadius: 14, background: PINE, color: CREAM, font: "600 15px/1 var(--font-text)" }}
                  >
                    {t("portalSeeOpenShifts", "See open shifts")}
                    <ArrowRight size={16} strokeWidth={2} aria-hidden />
                  </button>
                )}
              </div>
            );
          }
          return (
            <div className="flex flex-col" style={{ marginTop: 14, gap: 8 }}>
              {days.map(({ date: d, all }) => {
                const selected = expandedDate === d;
                // NOT `today` — that name is already the ISO date string in
                // this component's scope, and shadowing it once silently broke
                // the past-date guard below (string < boolean is always false).
                const isTodayCell = isToday(d);
                const dt = new Date(d + "T00:00:00");
                const opens = openOn(d);
                return (
                  <div key={d} id={`portal-day-${d}`} className="flex items-stretch" style={{ gap: 10, scrollMarginTop: 80, scrollMarginBottom: 100 }}>
                    <div
                      className="shrink-0 flex flex-col items-center justify-center"
                      style={{
                        width: 44, gap: 2, borderRadius: 14,
                        background: isTodayCell ? PINE : selected ? SOFT : "transparent",
                        color: isTodayCell ? CREAM : INK,
                      }}
                    >
                      <span style={{ font: "600 10px/1.1 var(--font-text)", letterSpacing: "0.08em", textTransform: "uppercase", color: isTodayCell ? SAGE : MUTED }}>
                        {wdShort(dt, lang).replace(/\.$/, "")}
                      </span>
                      <span style={{ font: `700 18px/1 ${SORA}` }}>{dt.getDate()}</span>
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 8 }}>
                      {all.map((fs) => {
                        const ink2 = isTodayCell ? "#4D5A53" : MUTED;
                        return (
                          <div
                            key={fs.id || `${fs.date}-${fs.start_time}`}
                            className="flex flex-col"
                            style={{
                              gap: 4, borderRadius: 16,
                              padding: isTodayCell ? "11px 13px" : "12px 14px",
                              background: isTodayCell ? "#EAF0EC" : ROW,
                              border: isTodayCell ? `1.5px solid ${PINE}` : "none",
                            }}
                          >
                            <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
                              <span className="flex items-center min-w-0" style={{ gap: 8 }}>
                                <span className="tabular-nums whitespace-nowrap" style={{ font: `700 16px/1.2 ${SORA}`, color: INK }}>
                                  {fs.start_time}–{fs.end_time}
                                </span>
                                {isTodayCell && (
                                  <span className="shrink-0 inline-flex items-center whitespace-nowrap" style={{ height: 20, padding: "0 8px", borderRadius: 999, background: PINE, color: CREAM, font: "600 11px/1 var(--font-text)" }}>
                                    {t("portalToday", "Today")}
                                  </span>
                                )}
                              </span>
                              <span className="tabular-nums whitespace-nowrap shrink-0" style={{ font: `600 14px/1.2 ${SORA}`, color: ink2 }}>
                                {fmtHM(fs.net_hours)}
                              </span>
                            </div>
                            {/* Role (override, else the staffer's own) and the
                                unpaid break — the hours on the right are NET,
                                so without the break "11:00–20:00 · 8,5 t"
                                does not add up. */}
                            {(effRole(fs) || fs.break_minutes > 0) && (
                              <span className="flex items-center min-w-0" data-testid="portal-week-row-meta" style={{ gap: 6, font: "400 13px/1.3 var(--font-text)", color: ink2 }}>
                                {effRole(fs) && roleSquare(effRole(fs))}
                                <span className="truncate">
                                  {[
                                    effRole(fs) ? roleName(effRole(fs), t) : null,
                                    fs.break_minutes > 0 ? t("portalHoursBreak", "{m} min break", { m: fs.break_minutes }) : null,
                                  ].filter(Boolean).join(" · ")}
                                </span>
                              </span>
                            )}
                            {/* Who you are on with, for EVERY shift — same
                                matching rule as Hvem er på (matesForShift), so
                                the two can never disagree. GET /team-schedule
                                starts at TODAY: about a past day it knows
                                nothing, and silence there must not read as
                                "alone". So: future + mates → name them;
                                future + none → say alone; past → nothing. */}
                            {(() => {
                              if (fs.date < today) return null;
                              const mates = matesForShift(teamShifts, fs);
                              if (!mates.length) {
                                return (
                                  <span className="truncate" style={{ marginTop: 2, font: "400 12px/1.3 var(--font-text)", color: ink2 }}>
                                    {t("portalWhosOnSoloShort", "On your own")}
                                  </span>
                                );
                              }
                              // The line is ONE button (canvas Week board: one
                              // line, "Med Sofie, Oliver, Magnus, Emil +1", cut
                              // with an ellipsis — never wrapping). A 44 px tap
                              // target that draws 22 px tall: the padding is
                              // taken back by negative margins. It opens the one
                              // fact not on screen — when else each colleague is
                              // on — from data already here (teamShifts). This
                              // fetches nothing.
                              const rowKey = fs.id || `${fs.date}-${fs.start_time}`;
                              const isOpen = openMate === rowKey;
                              const names = mates.map((m) => firstName(m.staff_name) || m.staff_name).filter(Boolean);
                              const more = names.length - 4;
                              const line = `${t("portalWithLabel", "With")} ${names.slice(0, 4).join(", ")}${more > 0 ? ` +${more}` : ""}`;
                              const panelId = `portal-mates-${rowKey}`;
                              return (
                                <div style={{ marginTop: 4 }}>
                                  <button
                                    type="button"
                                    data-testid="portal-week-mates"
                                    onClick={(e) => { e.stopPropagation(); setOpenMate(isOpen ? null : rowKey); }}
                                    aria-expanded={isOpen}
                                    aria-controls={panelId}
                                    className="flex items-center w-full min-w-0 text-left active:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                                    style={{ gap: 8, minHeight: 44, padding: "11px 0", margin: "-11px 0", background: "transparent", border: 0, color: ink2 }}
                                  >
                                    <MateDiscs mates={mates} size={22} overlap={6} cap={4} showOverflow={false} ring={isTodayCell ? "#EAF0EC" : ROW} />
                                    <span
                                      className="min-w-0"
                                      style={{ font: "400 12px/1.4 var(--font-text)", color: isOpen ? INK : ink2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
                                    >
                                      {line}
                                    </span>
                                  </button>
                                  {isOpen && (
                                    <div id={panelId} data-testid="portal-week-mates-panel" style={{ marginTop: 6, paddingLeft: 8, borderLeft: `2px solid ${LINE}`, font: "400 12px/1.5 var(--font-text)", color: ink2 }}>
                                      {mates.map((mt, mi) => {
                                        // Their OTHER shifts, from data already on
                                        // the client. teamShifts starts at today
                                        // and runs 21 days, so this is "what the
                                        // rota shows" — never a claim about
                                        // anything outside that window.
                                        const nm = firstName(mt.staff_name) || mt.staff_name;
                                        const others = (teamShifts || [])
                                          .filter((x) => (x.staff_id ?? x.staff_name) === (mt.staff_id ?? mt.staff_name))
                                          .filter((x) => x.date !== fs.date)
                                          .sort((a, b) => a.date.localeCompare(b.date))
                                          .slice(0, 3);
                                        return (
                                          <div key={`${mt.staff_id ?? mt.staff_name ?? mi}`} style={{ marginTop: mi ? 6 : 0 }}>
                                            {others.length === 0 ? (
                                              <div>{t("portalMateNoOther", "{name} has no other shift on the rota.", { name: nm })}</div>
                                            ) : (
                                              <>
                                                <div style={{ fontWeight: 600, color: INK }}>{nm}</div>
                                                {others.map((x, xi) => (
                                                  <div key={`${x.date}-${xi}`} className="tabular-nums">
                                                    {fmtWeekdayDay(x.date, lang)}
                                                    {" · "}{x.start_time}–{x.end_time}
                                                    {x.role ? ` · ${roleName(x.role, t)}` : ""}
                                                  </div>
                                                ))}
                                              </>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {/* Venue on the day it belongs to — a staffer
                                working two places needs it here, not on
                                whatever the hero happens to be showing. */}
                            {fs.branch_name && (
                              <a
                                href={`https://maps.apple.com/?q=${encodeURIComponent([fs.branch_name, fs.branch_address].filter(Boolean).join(", "))}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 underline truncate"
                                style={{ marginTop: 2, font: "400 12px/1.3 var(--font-text)", color: ink2 }}
                              >
                                <MapPin className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden />
                                {fs.branch_name}
                              </a>
                            )}
                          </div>
                        );
                      })}
                      {opens.map((o) => {
                        const overlaps = overlapsOwnShift(o.date, `${o.start_time}–${o.end_time}`, shifts);
                        return (
                          <div
                            key={`open-${o.id}`}
                            data-testid="portal-week-free"
                            className="flex items-center justify-between"
                            style={{ gap: 10, borderRadius: 16, border: "1.5px dashed #C9BB98", padding: "9px 9px 9px 13px" }}
                          >
                            <div className="min-w-0 flex flex-col" style={{ gap: 3 }}>
                              <span style={{ font: "600 11px/1.2 var(--font-text)", letterSpacing: "0.08em", textTransform: "uppercase", color: BRASS_INK }}>
                                {t("portalFreeShift", "Open shift")}
                              </span>
                              <span className="tabular-nums whitespace-nowrap" style={{ font: `700 16px/1.2 ${SORA}`, color: INK }}>
                                {o.start_time}–{o.end_time}
                              </span>
                              {(o.role || o.branch_name) && (
                                <span className="truncate" style={{ font: "400 12px/1.3 var(--font-text)", color: MUTED }}>
                                  {[o.role ? roleName(o.role, t) : null, o.branch_name || null].filter(Boolean).join(" · ")}
                                </span>
                              )}
                              {overlaps && (
                                <span style={{ font: "600 12px/1.2 var(--font-text)", color: "#B42318" }}>{t("portalGaOverlaps", "Overlaps you")}</span>
                              )}
                            </div>
                            <TakeItButton
                              onClick={() => claimer.claim(o.id, "week")}
                              busy={claimer.claiming === o.id}
                              label={t("portalOpenClaim", "Take it")}
                              testId="portal-week-take"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Shifts after the visible week. Every row jumps to its week, and
            "+N mere" to the week of the first one not listed — so every
            published shift is reachable. */}
        {weekOffset >= 1 && laterShifts.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 8, borderTop: `1px solid ${DIVIDER}` }} data-testid="portal-later-shifts">
            <div style={{ padding: "0 4px", font: "500 12px/1.3 var(--font-text)", color: MUTED }}>
              {laterShifts.length === 1
                ? t("portalSecComingUpCountOne", "Coming up · {n} more shift", { n: 1 })
                : t("portalSecComingUpCount", "Coming up · {n} more shifts", { n: laterShifts.length })}
            </div>
            <ul className="mt-0.5">
              {laterShifts.slice(0, 4).map((s) => (
                <li key={s.id || `${s.date}-${s.start_time}`}>
                  <button
                    type="button"
                    onClick={() => goToWeek(weeksFrom(weekStart, s.date))}
                    className="w-full flex items-center justify-between min-h-[44px] text-left tabular-nums active:opacity-60"
                    style={{ padding: "0 4px", font: "500 13px/1.3 var(--font-text)", color: INK }}
                  >
                    <span>{fmtDate(s.date, lang)} · {s.start_time}–{s.end_time}</span>
                    <ChevronRight className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden style={{ color: MUTED }} />
                  </button>
                </li>
              ))}
            </ul>
            {laterShifts.length > 4 && (
              <button
                type="button"
                onClick={() => goToWeek(weeksFrom(weekStart, laterShifts[4].date))}
                className="min-h-[44px] underline underline-offset-2 active:opacity-60"
                style={{ padding: "0 4px", font: "600 13px/1 var(--font-text)", color: LINK }}
              >
                {(t("portalSecComingUpMore", "+{n} more") || "")
                  .replace("{n}", String(laterShifts.length - 4))}
              </button>
            )}
          </div>
        )}
      </section>

      {/* "Brug for en ændring?" — the quiet way to the same two actions the
          ⋯ menu offers, at the end of the week where someone looking at a
          shift they cannot make ends up. Meld syg used to hang under the
          confirm strip; it was MOVED here and into the ⋯ menu, never removed
          (the Play listing promises it). Both open the one SickCallButton
          form that posts /sick-call. Canvas: two tiles. */}
      {token && (
        <section data-testid="portal-need-change">
          <HomeH2 style={{ padding: "0 4px" }}>{t("portalNeedChangeTitle", "Need a change?")}</HomeH2>
          <div
            className="grid"
            style={{ marginTop: 8, gap: 10, gridTemplateColumns: onOpenSwaps ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)" }}
          >
            {[
              {
                key: "sick",
                onClick: () => setSickFrom((v) => (v === "week" ? null : "week")),
                expanded: sickFrom === "week",
                Icon: Thermometer, well: "#F6E3DC", ink: "#A4452F",
                label: t("portalNeedChange"),
                hint: t("portalSickTileHint", "Let your manager know"),
              },
              onOpenSwaps && {
                key: "swap",
                onClick: onOpenSwaps,
                Icon: ArrowLeftRight, well: SOFT, ink: PINE,
                label: t("portalSwapAShift", "Swap a shift"),
                hint: t("portalSwapTileHint", "Offer it to a colleague"),
              },
            ].filter(Boolean).map((tile) => (
              <button
                key={tile.key}
                type="button"
                onClick={tile.onClick}
                aria-expanded={tile.expanded}
                className="flex flex-col items-start text-left vp-press focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/40"
                style={{ gap: 12, padding: 14, borderRadius: 20, background: CARD, border: `1px solid ${LINE}`, color: INK }}
              >
                <span className="flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 12, background: tile.well, color: tile.ink }}>
                  <tile.Icon size={18} strokeWidth={1.9} aria-hidden />
                </span>
                <span className="flex flex-col min-w-0" style={{ gap: 2 }}>
                  <span style={{ font: "600 15px/1.25 var(--font-text)" }}>{tile.label}</span>
                  <span style={{ font: "400 12.5px/1.3 var(--font-text)", color: MUTED }}>{tile.hint}</span>
                </span>
              </button>
            ))}
          </div>
          {sickFrom === "week" && (
            <div className="mt-3" ref={sickWeekRef} data-testid="portal-sick-from-week">
              <SickCallButton
                token={token}
                upcomingShifts={upcoming}
                onCalledIn={onShiftsChanged}
                onDismiss={() => setSickFrom(null)}
                autoOpen
              />
            </div>
          )}
        </section>
      )}

      {menuSheet.mounted && menuSheetShift && (
        <ShiftMenuSheet
          closing={menuSheet.closing}
          shift={menuSheetShift}
          roleLabel={effRole(menuSheetShift) ? roleName(effRole(menuSheetShift), t) : null}
          roleDot={roleSquare(effRole(menuSheetShift))}
          place={place}
          routeHref={placeRouteUrl}
          calTapped={calTapped}
          whosOnHint={(() => {
            const mates = matesForShift(teamShifts, menuSheetShift);
            return mates.length
              ? listNames(mates.map((m) => firstName(m.staff_name)).filter(Boolean).slice(0, 6), lang)
              : t("portalWhosOnSoloShort", "On your own");
          })()}
          onClose={() => setMenuOpen(false)}
          onWhosOn={() => {
            setMenuOpen(false);
            document.getElementById("portal-whos-on")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
          }}
          onCalendar={() => { setMenuOpen(false); subscribeCalendar(); }}
          onSwaps={onOpenSwaps ? () => { setMenuOpen(false); onOpenSwaps(); } : null}
          onSick={() => openSick("menu")}
          // Stempl ind lives here while the shift is not close (see the card).
          onClockIn={token && !showPunch ? () => { setMenuOpen(false); clockInNow(); } : null}
          clockInDisabled={clock.busy || clockLocked}
          clockInHint={clockLocked && clock.st?.opens_at
            ? t("portalClockOpensAt", "Clock-in opens at {t}", { t: clock.st.opens_at })
            : clock.st?.geofence_on && venueLabel
              ? t("portalClockOnlyAt", "Clock in only at {venue}", { venue: venueLabel })
              : null}
        />
      )}
    </div>
  );
}

/**
 * LiveShiftCard — the clocked-in card (canvas "Aktiv vagt"): the clock-in
 * time in the chip, a ring of the time worked against the planned shift with
 * the time in its middle, Start / Pause / Slut, then the actions.
 *
 * The time is the server's (useClock re-anchors on every poll and ticks the
 * gaps); the plan is the published shift the clock-in belongs to
 * (liveShiftOf). With no planned shift the ring draws no progress and says
 * so — it never borrows another shift's plan.
 *
 * Pauses: "Start pause" renders ONLY when the clock answer says breaks_live
 * (the owner's "Pauser stemples live", off by default). "Slut pause" also
 * shows for a pause that is running (on_break) — so a pause begun before the
 * owner switched the setting off can still be ended. Without live breaks the
 * Pause cell shows the planned break only — the app cannot know whether it
 * was taken, so it does not say "mangler".
 */
function LiveShiftCard({ clock, live, menuBtn }) {
  const { t, lang } = useLanguage();
  const confirmOut = useConfirm();
  const shortPhone = useShortPhone();
  const st = clock.st || {};
  const shift = live?.shift || null;
  const elapsed = clock.liveSec ?? st.elapsed_sec ?? 0;
  const totalSec = live ? (live.end.getTime() - live.start.getTime()) / 1000 : null;
  const p = totalSec ? Math.min(1, Math.max(0, elapsed / totalSec)) : 0;
  // Time left on the plan, from the clock itself (planned end − the
  // clock-in minute − time on the clock), so it ticks with the counter.
  const remainMin = live ? Math.round(((live.end.getTime() - live.inAt.getTime()) / 1000 - elapsed) / 60) : null;
  const dur = (min) => formatHoursMinutes(min / 60, { lang });
  const sub = remainMin == null
    ? t("portalLiveNoShift", "No planned shift")
    : remainMin >= 0
      ? t("portalLiveLeft", "{d} left", { d: dur(remainMin) })
      : t("portalLiveOver", "{d} over plan", { d: dur(-remainMin) });

  // When the running pause began: the server's owner-local "HH:MM"
  // (break_since), else its UTC stamp (break_started_at) read as UTC.
  const breakAt = (() => {
    if (st.break_since && /^\d{1,2}:\d{2}$/.test(String(st.break_since))) return String(st.break_since);
    const v = st.break_started_at;
    if (!v) return null;
    if (/^\d{1,2}:\d{2}$/.test(String(v))) return String(v);
    const d = parseServerTime(v);
    return d ? d.toLocaleTimeString(localeFor(lang), { hour: "2-digit", minute: "2-digit" }) : null;
  })();
  // on_break is read from the data, not the setting: a pause still running
  // when the owner switched live breaks off is shown — and can be ended.
  const onBreak = !!st.on_break;
  const showBreakBtn = !!st.breaks_live || onBreak;

  // Pause cell: the plan, and — only with live breaks — what happened.
  const planned = Number(shift?.break_minutes) || 0;
  const taken = Number(st.break_minutes_so_far) || 0;
  const pauseMain = planned > 0
    ? dur(planned)
    : st.breaks_live && taken > 0 ? dur(taken) : t("portalBreakNone", "None");
  const pauseSuffix = !st.breaks_live && !onBreak ? null
    : onBreak ? t("portalBreakSuffixNow", "on now")
      : taken > 0 && planned > 0 ? t("portalBreakSuffixTaken", "{m} taken", { m: dur(taken) })
        : planned > 0 && taken === 0 ? t("portalBreakSuffixDue", "due") : null;

  // The pause is OPTIONAL. "Start pause" leads (brass, first) only while a
  // planned pause is still to be taken with more than a quarter of an hour of
  // the shift left — or while one is running ("Slut pause"). Otherwise Stempl
  // ud is the card's brass action, first in the row, and Start pause stays
  // available as a quiet ghost button.
  const pausePending = onBreak
    || (planned > 0 && taken < planned && remainMin != null && remainMin > 15);
  const breakLeads = showBreakBtn && pausePending;

  // On a pause the ring PAUSES: the big number is the pause's own time (the
  // server's break_elapsed_sec, ticking), the line under it the whole shift,
  // and the arc turns sage. Off a pause it is the shift, as always.
  const breakSec = onBreak ? (clock.breakSec ?? st.break_elapsed_sec ?? 0) : null;
  const ringSub = onBreak
    ? t("portalLiveBreakSub", "{d} on shift", { d: dur(Math.floor(elapsed / 60)) })
    : sub;
  const ringAria = onBreak
    ? t("portalLiveRingBreakAria", "On break for {b}. On shift for {e} in total.", {
      b: dur(Math.floor((breakSec || 0) / 60)), e: dur(Math.floor(elapsed / 60)),
    })
    : t("portalLiveRingAria", "On shift for {e}. {r}.", { e: dur(Math.floor(elapsed / 60)), r: sub });

  // Ring geometry (viewBox 200, r 88): the arc and its end knob. Size as the
  // canvas: 184, 168 on a narrow phone (< 350 px: 51vw lands between), 150
  // when the screen is short (under 700 px tall).
  const C = 2 * Math.PI * 88;
  const angle = (-90 + 360 * p) * (Math.PI / 180);
  const knob = { x: 100 + 88 * Math.cos(angle), y: 100 + 88 * Math.sin(angle) };
  const ring = shortPhone ? "150px" : "min(184px, max(168px, 51vw))";

  // Stempl ud during a pause asks first: clock-out ends the pause, and a
  // pause that clock-out ends is not counted as a measured one (its end is a
  // guess) — the manager sees it. Never a silent tap.
  const clockOut = async () => {
    if (onBreak) {
      const ok = await confirmOut({
        title: breakAt
          ? t("portalClockOutOnBreakTitle", "On a break since {t} — end it and clock out?", { t: breakAt })
          : t("portalClockOutOnBreakTitleNoTime", "You're on a break — end it and clock out?"),
        message: t("portalClockOutOnBreakBody", "The break ends when you clock out. Your manager sees it with your hours."),
        confirmLabel: t("portalClockOutCta"),
      });
      if (ok !== true) return;
    }
    clock.act("out");
  };

  const chip = onBreak
    ? (breakAt ? t("portalLiveOnBreakSince", "On break since {t}", { t: breakAt }) : t("portalLiveOnBreak", "On break"))
    : t("portalLiveSince", "Clocked in at {t}", { t: st.since || "—" });

  const brass = {
    flex: "1 1 auto", minWidth: 0, height: 48, gap: 8, borderRadius: 14,
    background: BRASS, color: PINE, font: "600 15px/1 var(--font-text)", whiteSpace: "nowrap",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35)",
  };
  const ghost = {
    flex: "none", height: 48, gap: 8, padding: "0 16px", borderRadius: 14, boxSizing: "border-box",
    border: "1px solid rgba(243,239,228,0.24)", background: "rgba(243,239,228,0.06)",
    color: CREAM, font: "600 14px/1 var(--font-text)", whiteSpace: "nowrap",
  };

  return (
    <div data-testid="portal-live-shift">
      <div className="flex items-center justify-between" style={{ gap: 12, minHeight: 28 }}>
        <span
          className="inline-flex items-center min-w-0"
          data-testid="portal-live-chip"
          style={{ gap: 8, height: 28, padding: "0 12px 0 10px", borderRadius: 999, background: "rgba(200,164,100,0.16)", font: "600 12.5px/1 var(--font-text)", color: CREAM, whiteSpace: "nowrap" }}
        >
          {/* Breathes while the clock runs ("Stemplet ind" / on a pause). */}
          <span aria-hidden className="shrink-0 vp-breathe" data-testid="portal-live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: BRASS, boxShadow: "0 0 0 3px rgba(200,164,100,0.3), 0 0 0 6px rgba(200,164,100,0.12)" }} />
          <span className="truncate tabular-nums">{chip}</span>
        </span>
        {menuBtn}
      </div>

      <div className="flex justify-center" style={{ marginTop: 10 }}>
        <div
          role="img"
          data-testid="portal-live-ring"
          aria-label={ringAria}
          className="relative"
          style={{ width: ring, height: ring }}
        >
          <svg viewBox="0 0 200 200" aria-hidden className="block w-full h-full">
            <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(243,239,228,0.1)" strokeWidth="12" />
            <g stroke="rgba(243,239,228,0.28)" strokeWidth="2" strokeLinecap="round">
              <path d="M100 30 L100 25" />
              <path d="M160.6 65 L164.9 62.5" />
              <path d="M160.6 135 L164.9 137.5" />
              <path d="M100 170 L100 175" />
              <path d="M39.4 135 L35.1 137.5" />
              <path d="M39.4 65 L35.1 62.5" />
            </g>
            {totalSec && p > 0 && (
              <circle
                data-testid="portal-live-arc"
                data-paused={onBreak ? "true" : undefined}
                cx="100" cy="100" r="88" fill="none" stroke={onBreak ? SAGE : BRASS} strokeWidth="12" strokeLinecap="round"
                strokeDasharray={`${(p * C).toFixed(1)} ${C.toFixed(1)}`}
                transform="rotate(-90 100 100)"
              />
            )}
            {totalSec && <circle cx={knob.x.toFixed(1)} cy={knob.y.toFixed(1)} r="6" fill={CREAM} stroke={PINE} strokeWidth="3" />}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={{ gap: 4 }}>
            <span style={{ font: "600 10.5px/1 var(--font-text)", letterSpacing: "0.14em", textTransform: "uppercase", color: SAGE }}>
              {onBreak ? t("portalLiveOnBreak", "On break") : t("portalLiveOnShift", "On shift")}
            </span>
            <span
              className="tabular-nums"
              data-testid="portal-live-elapsed"
              style={{ fontFamily: SORA, fontWeight: 700, fontSize: `calc(${ring} * 0.24)`, lineHeight: 1, letterSpacing: "-0.03em", color: CREAM }}
            >
              {/* Only the digits that change roll (a minute, then its tens). */}
              <RollingDigits value={fmtClockHM(onBreak ? breakSec : elapsed)} />
            </span>
            {/* Held inside the ring: on a pause the line ran over the 8 and 4
                o'clock ticks on a 402 pt iPhone (and the 150 px short ring). */}
            <span className="whitespace-nowrap" data-testid="portal-live-sub" style={{ maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", font: "400 12px/1.2 var(--font-text)", color: SAGE }}>{ringSub}</span>
          </div>
        </div>
      </div>

      <div
        className="grid"
        style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(243,239,228,0.12)", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}
      >
        <div className="flex flex-col" style={{ gap: 2 }}>
          <span style={{ font: "400 11.5px/1.2 var(--font-text)", color: SAGE }}>{t("portalLiveStart", "Start")}</span>
          <span className="tabular-nums" style={{ font: `700 15px/1.2 ${SORA}` }}>{shift?.start_time || st.since || "—"}</span>
        </div>
        <div className="flex flex-col items-center text-center" style={{ gap: 2 }} data-testid="portal-live-pause">
          <span style={{ font: "400 11.5px/1.2 var(--font-text)", color: SAGE }}>{t("portalLivePause", "Break")}</span>
          <span className="whitespace-nowrap" style={{ font: `700 15px/1.2 ${SORA}` }}>
            {pauseMain}
            {pauseSuffix && <span style={{ font: "500 11.5px/1 var(--font-text)", color: onBreak ? BRASS : SAGE }}> · {pauseSuffix}</span>}
          </span>
        </div>
        <div className="flex flex-col items-end text-right" style={{ gap: 2 }}>
          <span style={{ font: "400 11.5px/1.2 var(--font-text)", color: SAGE }}>{t("portalLiveEnd", "End")}</span>
          <span className="tabular-nums" style={{ font: `700 15px/1.2 ${SORA}` }}>{shift?.end_time || "—"}</span>
        </div>
      </div>

      <div className="flex" style={{ marginTop: 16, gap: 8 }}>
        {breakLeads && (
          <button
            type="button"
            data-testid="portal-break-btn"
            data-primary="true"
            disabled={clock.busy}
            onClick={() => clock.breakAct(onBreak ? "end" : "start")}
            className="inline-flex items-center justify-center vp-press disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={brass}
          >
            <Coffee size={18} strokeWidth={2} aria-hidden className="shrink-0" />
            <span className="truncate">{onBreak ? t("portalBreakEnd", "End break") : t("portalBreakStart", "Start break")}</span>
          </button>
        )}
        <button
          type="button"
          data-testid="portal-clock-out"
          data-primary={breakLeads ? undefined : "true"}
          disabled={clock.busy}
          onClick={clockOut}
          className="inline-flex items-center justify-center vp-press disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          // Unless a pause is due (or running), Stempl ud is the card's
          // brass action — the pause is optional, never in the way.
          style={breakLeads ? ghost : brass}
        >
          <LogOut size={16} strokeWidth={2} aria-hidden className="shrink-0" />
          {t("portalClockOutCta")}
        </button>
        {showBreakBtn && !breakLeads && (
          <button
            type="button"
            data-testid="portal-break-btn"
            disabled={clock.busy}
            onClick={() => clock.breakAct("start")}
            className="inline-flex items-center justify-center vp-press disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={ghost}
          >
            <Coffee size={16} strokeWidth={2} aria-hidden className="shrink-0" />
            <span className="truncate">{t("portalBreakStart", "Start break")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * VenueMapImage — the small map on the next-shift card (Vagtplan R2).
 *
 * Drawn by OUR server (backend services/venue_map.py) from OpenStreetMap
 * data and served from api.bonbox.dk, so no map company sees the staffer or
 * their phone. Fetched as a blob through portalApi so a PIN-protected link
 * sends its proof header (a bare <img src> cannot).
 *
 * The card never grows after it paints: `has_map` already means a confirmed
 * pin that has not failed to draw, so the block takes its final 96 px at
 * once, in the map's own ground colour, and the image fades in over it. Only
 * a 204 or an error — rare — collapses it (never a broken image; the address
 * and Rute below work either way). The image is kept for the page session
 * (utils/venueMapImage), so a tab switch that remounts the card paints it in
 * the same frame. Width: the card's own, rounded up to the server's 16 px
 * grid, shown right-anchored so the "© OpenStreetMap" corner is never cut.
 */
function VenueMapImage({ token, venueName, mapV }) {
  const { t } = useLanguage();
  const dpr = mapDpr();
  const [w, setW] = useState(() => mapRequestWidth(0));
  // Measured as the block mounts, before paint (an update from a ref callback
  // is flushed with the commit): on a phone it equals the estimate above, so
  // there is no second request.
  const boxRef = useCallback((el) => {
    const px = el?.clientWidth || 0;
    if (px > 0) setW(mapRequestWidth(px));
  }, []);
  const key = mapCacheKey(`staff:${token}`, w, dpr, mapV, "pine");
  const entry = getCachedMap(key);
  const [, rerender] = useState(0);
  const [failedKey, setFailedKey] = useState(null);
  // Painted from memory → visible at once; fetched now → settles in on load
  // (vagtplan.css .vp-map-in: once, when it is drawn for the first time).
  const [shownKey, setShownKey] = useState(() => (entry?.url ? key : null));
  const [fromMemory] = useState(() => !!entry?.url);
  useEffect(() => {
    if (!token || getCachedMap(key)) return undefined;
    let gone = false;
    // Kept even if the card unmounted meanwhile: the next mount paints it.
    loadMapOnce(key, () => portalApi.get(`/portal/${token}/venue-map?${mapQuery(w, dpr, mapV, "pine")}`, { responseType: "blob" }))
      .then(() => { if (!gone) rerender((n) => n + 1); })
      .catch(() => { if (!gone) setFailedKey(key); /* no map is the honest fallback */ });
    return () => { gone = true; };
  }, [token, key, w, dpr, mapV]);
  if (entry?.none || failedKey === key) return null;
  return (
    <div
      ref={boxRef}
      data-testid="portal-venue-map"
      // Canvas: 14 below the meta line, radius 16. The server draws it 96
      // tall (MAP_H) — the block keeps that height from the first paint, in
      // the pine map's own ground, so nothing light flashes before it loads.
      style={{ marginTop: 14, height: MAP_H, borderRadius: 16, overflow: "hidden", boxShadow: "0 0 0 1px rgba(243,239,228,.14)", background: MAP_PINE_BG }}
    >
      {entry?.url && (
        <img
          src={entry.url}
          alt={t("portalMapAlt", "Map of {venue}", { venue: venueName || "" })}
          onLoad={() => setShownKey(key)}
          onError={() => { setCachedMap(key, { none: true }); setFailedKey(key); }}
          className={`block w-full h-full${shownKey === key && !fromMemory ? " vp-map-in" : ""}`}
          style={{ objectFit: "cover", objectPosition: "right center", opacity: shownKey === key ? 1 : 0, transition: "opacity 150ms ease" }}
        />
      )}
    </div>
  );
}

/**
 * ShiftMenuSheet — everything for the card's shift in one bottom sheet
 * (canvas "Vagt – handlinger"): the title and role · place, then — while the
 * shift is not close — a pine "Stempl ind" with where it works; a group of
 * Rute, Hvem er på, Tilføj til kalender, Byt eller giv væk; Meld syg in a
 * group of its own; the full map credit at the foot. Portaled to <body> (the
 * tab content is a space-y stack, and a fixed overlay inside one picks up a
 * stray margin), m-0 on the overlay for the same reason.
 */
function ShiftMenuSheet({ shift, roleLabel, roleDot, place, routeHref, calTapped, whosOnHint, onClose, onWhosOn, onCalendar, onSwaps, onSick, onClockIn, clockInDisabled, clockInHint, closing = false }) {
  const { t, lang } = useLanguage();
  // Focus moves into the sheet on open (screen readers land on the dialog,
  // not behind the scrim); Escape closes it.
  const dialogRef = useRef(null);
  useEffect(() => { dialogRef.current?.focus?.(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const title = `${isToday(shift.date) ? t("portalToday") : fmtDate(shift.date, lang)} · ${shift.start_time}–${shift.end_time}`;
  const row = ({ icon, label, hint, onClick, href, testId, disabled, well = SOFT, ink = PINE }) => {
    const Icon = icon;
    const inner = (
      <>
        <span className="shrink-0 flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 12, background: well, color: ink }}>
          <Icon size={18} strokeWidth={1.9} aria-hidden />
        </span>
        <span className="flex-1 min-w-0 flex flex-col" style={{ gap: 2 }}>
          <span style={{ font: "600 15px/1.25 var(--font-text)", color: INK }}>{label}</span>
          {hint && <span className="truncate" style={{ font: "400 12.5px/1.3 var(--font-text)", color: MUTED }}>{hint}</span>}
        </span>
        <ChevronRight size={18} strokeWidth={2} aria-hidden className="shrink-0" style={{ color: MUTED }} />
      </>
    );
    const cls = "w-full flex items-center text-left vp-press vp-row active:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0E3B2E]/40";
    const style = { gap: 14, minHeight: 64, padding: "12px 14px", boxSizing: "border-box", color: INK };
    return href ? (
      <a key={testId} href={href} target="_blank" rel="noopener noreferrer" onClick={onClose} className={cls} style={style} data-testid={testId}>{inner}</a>
    ) : (
      <button key={testId} type="button" onClick={onClick} disabled={disabled} className={`${cls} disabled:opacity-50`} style={style} data-testid={testId}>{inner}</button>
    );
  };
  const groupRows = [
    routeHref && row({
      icon: Navigation,
      label: t("portalRouteTo", "Directions to {venue}", { venue: place?.name || place?.address || "" }),
      hint: t("portalRouteHint", "Opens your maps app"),
      href: routeHref,
      testId: "portal-menu-route",
    }),
    row({ icon: Users, label: t("portalWhosOnRow", "Who's on"), hint: whosOnHint, onClick: onWhosOn, testId: "portal-menu-whos-on" }),
    row({
      icon: CalendarPlus,
      label: t("portalAddToCalendar", "Add to calendar"),
      hint: calTapped ? t("portalCalendarTappedHint", "If you subscribed, your calendar already updates itself") : t("portalCalendarRowHint", "Syncs automatically"),
      onClick: onCalendar,
      testId: "portal-menu-calendar",
    }),
    onSwaps && row({
      icon: ArrowLeftRight,
      label: t("portalSwapOrGive", "Swap or give away"),
      hint: t("portalSwapOrGiveHint", "Offer the shift to a colleague"),
      onClick: onSwaps,
      testId: "portal-menu-swaps",
    }),
  ].filter(Boolean);
  return createPortal(
    <div className="fixed inset-0 z-[60] m-0 flex flex-col justify-end" {...closingProps(closing)}>
      <button
        type="button"
        aria-label={t("close", "Close")}
        onClick={onClose}
        className="absolute inset-0 m-0 vp-scrim"
        style={{ background: "rgba(8,24,18,0.52)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="portal-shift-menu"
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-lg mx-auto m-0 outline-none overflow-y-auto overscroll-contain vp-sheet"
        style={{
          maxHeight: "92dvh", background: CARD, color: INK, borderRadius: "28px 28px 0 0",
          padding: "8px 16px max(16px, env(safe-area-inset-bottom, 0px))",
          boxShadow: "0 -20px 40px -20px rgba(8,24,18,0.5)",
        }}
      >
        <span aria-hidden className="block mx-auto" style={{ width: 36, height: 5, borderRadius: 3, background: "#D9D3C5", marginBottom: 12 }} />
        <div className="flex items-start justify-between" style={{ gap: 12, padding: "0 4px" }}>
          <div className="min-w-0 flex flex-col" style={{ gap: 4 }}>
            <div className="tabular-nums" style={{ font: `700 19px/1.25 ${SORA}`, letterSpacing: "-0.015em", color: INK }}>{title}</div>
            <div className="flex items-center" style={{ gap: 6, font: "400 13px/1.3 var(--font-text)", color: MUTED }}>
              {roleLabel && roleDot}
              <span className="truncate">{[roleLabel, place?.name].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            className="relative shrink-0 flex items-center justify-center rounded-full"
            style={{ width: 44, height: 44, minHeight: 0, background: TILE, color: INK }}
          >
            <X size={18} strokeWidth={2} aria-hidden />
          </button>
        </div>
        {onClockIn && (
          <div className="flex flex-col" style={{ marginTop: 18, gap: 8 }}>
            <button
              type="button"
              onClick={onClockIn}
              disabled={clockInDisabled}
              data-testid="portal-menu-clock-in"
              className="w-full inline-flex items-center justify-center vp-press disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/50 focus-visible:ring-offset-2"
              style={{ height: 56, gap: 10, borderRadius: 18, background: PINE, color: CREAM, font: "600 16px/1 var(--font-text)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 24px -14px rgba(14,59,46,0.8)" }}
            >
              <LogIn size={20} strokeWidth={1.9} aria-hidden />
              {t("portalClockInCta", "Clock in")}
            </button>
            {clockInHint && (
              <span className="flex items-center justify-center text-center" style={{ gap: 6, font: "400 12px/1.35 var(--font-text)", color: MUTED }}>
                <MapPin size={14} strokeWidth={2} aria-hidden className="shrink-0" />
                {clockInHint}
              </span>
            )}
          </div>
        )}
        <div style={{ marginTop: 16, background: IVORY, borderRadius: 20, overflow: "hidden" }}>
          {groupRows.map((el, i) => (
            <div key={i}>
              {i > 0 && <div aria-hidden style={{ height: 1, background: LINE, marginLeft: 66 }} />}
              {el}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, background: IVORY, borderRadius: 20, overflow: "hidden" }}>
          {row({
            icon: Thermometer,
            label: t("portalNeedChange"),
            hint: t("portalSickRowHint", "Let your manager know about your shift"),
            onClick: onSick,
            testId: "portal-menu-sick",
            well: "#F6E3DC",
            ink: "#A4452F",
          })}
        </div>
        <p className="text-center" style={{ margin: "16px 0 0", font: "400 11px/1.4 var(--font-text)", color: "#66716B" }}>
          {t("portalMapCredit", "Map: OpenFreeMap · OpenMapTiles · © OpenStreetMap contributors")}
        </p>
      </div>
    </div>,
    document.body,
  );
}



// ─── The system on the other tabs (Fravær, Beskeder, Byt, Timer) ─────────
//
// Nov 2026: the four tabs past the home speak the home's language. Ivory
// ground, cards #FFFEFB with a hairline, pine for the chosen and the primary,
// sage for the secondary pill, Sora for headings and figures, DM Sans for
// every sentence. Brass stays the home card's one action and is not spent
// here on buttons; on the calendars it is a MARKER with one meaning.
//
// Colour on the Fravær calendars means one thing each, and the legend says it
// in words too (never colour alone):
//   terracotta — "kan ikke" (the home's sick row uses the same ink)
//   sage       — "helst", a soft yes
//   brass      — waiting on your manager (a time-off request, Afventer)
//   pine       — settled: approved time off
// Literal hex for the same reason as the palette at the top: index.css remaps
// every green-* class to the owner's theme accent.
const RED_EDGE = "rgba(164, 69, 47, 0.38)";
const ALERT_INK = "#B42318";     // an error line; the home's "Overlapper dig"
const ALERT_WASH = "#FBEDE9";
const ALERT_EDGE = "#EFCFC6";
const BRASS_WASH = "#F4EBD7";
const BRASS_EDGE = "#E2CFA4";
const SAGE_EDGE = "rgba(14, 59, 46, 0.22)";
const SAGE_BAR = "#C3D1C8";      // Timer's weeks that are not this week
const GRAB = "#D9D3C5";          // a sheet's grabber (the ⋯ sheet's)
const SCRIM = "rgba(8, 24, 18, 0.52)";
const PLACEHOLDER = "#8A948E";

const CARD_BOX = { background: CARD, border: `1px solid ${LINE}` };
const EYEBROW = { font: "600 11px/1.2 var(--font-text)", letterSpacing: "0.14em", textTransform: "uppercase", color: MUTED };
const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/40";
// Chat photos (the shared chatPhotoKit) in the portal: 14 px corners beside
// the 18 px bubbles, and a shimmer on the divider tone while one loads — the
// kit's own look pulses a cool grey.
const PORTAL_PHOTO_LOOK = {
  imgStyle: { borderRadius: 14 },
  loadingClassName: "w-28 h-28 vp-shimmer",
  loadingStyle: { borderRadius: 14, background: DIVIDER },
};
// Every filled button has ONE shape: the home's (brassBtn, the live card's
// buttons, the canvas) — radius 14, a label that never wraps. A wrapped label
// in a line-height-1 button reads broken; where two would not fit side by
// side they stack instead (VpQuestionSheet, the Fravær form).
const BTN = { height: 48, padding: "0 18px", borderRadius: 14, font: "600 15px/1 var(--font-text)", boxSizing: "border-box", whiteSpace: "nowrap" };
const BTN_PINE = { ...BTN, background: PINE, color: CREAM, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 22px -16px rgba(14,59,46,0.8)" };
const BTN_QUIET = { ...BTN, background: CARD, color: INK, border: `1px solid ${LINE}` };
const BTN_SAGE = { ...BTN, background: SOFT, color: PINE };
const BTN_RED = { ...BTN, background: RED_INK, color: CREAM };
// A form's full-width submit: 52 tall, the same radius.
const BTN_FULL = { height: 52 };
// One disabled look for a filled button: the tile, muted text, no shadow
// (PeriodSheet's). Opacity faded pine and its shadow into a grey-sage slab.
const BTN_OFF = { background: TILE, color: MUTED, boxShadow: "none", border: "none" };
const pineBtn = (disabled, extra) => ({ ...BTN_PINE, ...extra, ...(disabled ? BTN_OFF : null) });
// A quiet text action under a primary (PeriodSheet's "Tilbage til min
// lønperiode"): 44 tall, no fill, no border.
const BTN_TEXT = { minHeight: 44, padding: "0 12px", borderRadius: 14, font: "600 14px/1 var(--font-text)", color: MUTED, background: "transparent", whiteSpace: "nowrap" };
// A field: ivory, the hairline, pine when it has focus. 16 px so iOS never
// zooms the page on focus (an inline font beats index.css's coarse rule).
const FIELD_CLS = "block w-full outline-none border border-[#E8E3D8] focus:border-[#0E3B2E]/50 placeholder:text-[#8A948E]";
const FIELD = {
  minHeight: 48, padding: "12px 14px", borderRadius: 14, background: IVORY,
  font: "400 16px/1.25 var(--font-text)", color: INK, boxSizing: "border-box", minWidth: 0,
};
// A field's label: one small muted line above it.
const FIELD_LABEL = { display: "block", marginBottom: 6, font: "600 12px/1.2 var(--font-text)", color: MUTED };

/** A two-way choice — "Kan ikke / Helst", "Ferie / Andet". The canvas's
    week chips: an ivory track with a hairline, the chosen one pine. 44 tall,
    so each half is a full tap target. */
function VpSegmented({ options, value, onChange, label, testId }) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className="flex"
      style={{ padding: 3, gap: 3, borderRadius: 999, ...CARD_BOX }}
    >
      {options.map((o) => {
        const on = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={on}
            data-testid={testId ? `${testId}-${o.key}` : undefined}
            className={`flex-1 min-w-0 inline-flex items-center justify-center vp-press ${FOCUS_RING}`}
            style={{
              height: 44, gap: 6, padding: "0 12px", borderRadius: 999,
              background: on ? PINE : "transparent", color: on ? CREAM : MUTED,
              font: "600 14px/1 var(--font-text)",
              boxShadow: on ? "0 6px 14px -10px rgba(14,59,46,0.8)" : "none",
            }}
          >
            <span className="truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A calm one-line empty state: a small line icon and one sentence on a card
    (the home's "Du er alene på vagten" line). No illustration, no emoji. */
function CalmEmpty({ icon: Icon, children, testId }) {
  return (
    <div
      data-testid={testId}
      className="flex items-center"
      style={{ gap: 12, padding: "14px 16px", borderRadius: 20, ...CARD_BOX, font: "500 14px/1.35 var(--font-text)", color: MUTED }}
    >
      {Icon && <Icon size={18} strokeWidth={1.75} aria-hidden className="shrink-0" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A short line that says something went wrong, in the house's red. */
function VpAlert({ children, testId, role = "alert" }) {
  return (
    <div
      role={role}
      data-testid={testId}
      style={{ padding: "10px 12px", borderRadius: 14, background: ALERT_WASH, border: `1px solid ${ALERT_EDGE}`, font: "500 13px/1.4 var(--font-text)", color: ALERT_INK }}
    >
      {children}
    </div>
  );
}

/** A note that is waiting on someone (the manager): brass, never an alarm. */
function VpNote({ children, testId, icon: Icon }) {
  return (
    <div
      data-testid={testId}
      className="flex items-start"
      style={{ gap: 8, padding: "10px 12px", borderRadius: 14, background: BRASS_WASH, border: `1px solid ${BRASS_EDGE}`, font: "500 13px/1.4 var(--font-text)", color: BRASS_INK }}
    >
      {Icon && <Icon size={15} strokeWidth={2} aria-hidden className="shrink-0" style={{ marginTop: 2 }} />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** The house sheet for a short question (the ⋯ sheet's material): card,
    28 px top corners, the grabber, a Sora title, one muted paragraph and the
    answers side by side. The overlay keeps the shared sheet motion. */
function VpQuestionSheet({ closing = false, title, body, onDismiss, dismissLabel, children, testId }) {
  return (
    <div
      className="fixed inset-0 z-[60] m-0 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      {...closingProps(closing)}
    >
      <button
        type="button"
        className="absolute inset-0 m-0 vp-scrim"
        style={{ background: SCRIM, backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }}
        onClick={onDismiss}
        aria-label={dismissLabel}
      />
      <div
        className="relative w-full max-w-lg mx-auto m-0 vp-sheet"
        style={{
          background: CARD, color: INK, borderRadius: "28px 28px 0 0",
          padding: "8px 20px max(20px, env(safe-area-inset-bottom, 0px))",
          boxShadow: "0 -20px 40px -20px rgba(8,24,18,0.5)",
        }}
      >
        <span aria-hidden className="block mx-auto" style={{ width: 36, height: 5, borderRadius: 3, background: GRAB, marginBottom: 14 }} />
        <div style={{ font: `700 19px/1.25 ${SORA}`, letterSpacing: "-0.015em", color: INK }}>{title}</div>
        {body && <p style={{ margin: "8px 0 0", font: "400 14px/1.45 var(--font-text)", color: MUTED }}>{body}</p>}
        {/* Side by side while both labels fit (they never wrap — BTN), one
            above the other on a narrow phone; the first action stays on top. */}
        <div className="grid" style={{ gap: 8, marginTop: 18, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>{children}</div>
      </div>
    </div>
  );
}

/** A 44 px square ‹ / › for paging a strip (the home's week card). */
function PageArrow({ dir, onClick, label, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`shrink-0 flex items-center justify-center vp-press disabled:opacity-40 ${FOCUS_RING}`}
      style={{ width: 44, height: 44, borderRadius: 14, ...CARD_BOX, color: dir === "next" ? INK : MUTED }}
    >
      {dir === "next"
        ? <ChevronRight size={18} strokeWidth={2} aria-hidden />
        : <ChevronLeft size={18} strokeWidth={2} aria-hidden />}
    </button>
  );
}


// ─── Hours Tab ────────────────────────────────────────────────────────────

/**
 * Choose which stretch of time "my hours" covers.
 *
 * Two ways in, because staff ask two different questions:
 *   • "what does my PAY period look like" → a cycle shape (1–31, 15–14, 16–15).
 *     Danish payroll rarely runs on calendar months, and the shape the owner
 *     runs is not something a staffer can be expected to know by heart.
 *   • "what did I work between these two dates" → a custom range.
 *
 * The bounds mirror the server's (366 days, no earlier than 3 years back) so a
 * staffer gets a sentence instead of a 400 — but the SERVER is the gate. This
 * is a courtesy, never the check.
 */
function PeriodSheet({ initial, anchorMonth, onClose, onApply, closing = false }) {
  const { t, lang } = useLanguage();
  const todayISO = new Date().toLocaleDateString("sv-SE");
  const [from, setFrom] = useState(initial?.start || "");
  const [to, setTo] = useState(initial?.end || "");

  const iso = (d) => d.toLocaleDateString("sv-SE");
  const anchor = anchorMonth ? new Date(`${anchorMonth}T00:00:00`) : new Date();
  const Y = anchor.getFullYear();
  const M = anchor.getMonth();
  const monthName = (off) =>
    new Date(Y, M + off, 1).toLocaleDateString(lang === "da" ? "da-DK" : "en-GB", { month: "short" });

  // The three cycle shapes DK owners actually run. Each is expressed against
  // the anchor month so the label shows real dates, not an abstract rule.
  // The ordinal dot ("1.–30.") is Danish notation; English writes "1–30".
  const dot = lang === "da" ? "." : "";
  const cycles = [
    {
      key: "calendar",
      label: `1${dot}–${new Date(Y, M + 1, 0).getDate()}${dot}`,
      hint: monthName(0),
      start: iso(new Date(Y, M, 1)),
      end: iso(new Date(Y, M + 1, 0)),
    },
    {
      key: "15-14",
      label: `15${dot}–14${dot}`,
      hint: `${monthName(0)} – ${monthName(1)}`,
      start: iso(new Date(Y, M, 15)),
      end: iso(new Date(Y, M + 1, 14)),
    },
    {
      key: "16-15",
      label: `16${dot}–15${dot}`,
      hint: `${monthName(0)} – ${monthName(1)}`,
      start: iso(new Date(Y, M, 16)),
      end: iso(new Date(Y, M + 1, 15)),
    },
  ];

  // Three years back, matching the server's floor exactly. A client bound looser
  // than the server's is worse than none: it lets the staffer pick a date that
  // looks legal, and the request 400s after the sheet has already closed.
  const floorISO = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    d.setDate(d.getDate() + 1);           // stay inside the server's 365*3 days
    return d.toLocaleDateString("sv-SE");
  })();

  const problem = (() => {
    if (!from || !to) return null;
    if (to < from) return t("portalHoursRangeBackwards", "The end date is before the start date");
    if ((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000 > 366) return t("portalHoursRangeTooWide", "Pick a year or less");
    if (from < floorISO) return t("portalHoursRangeTooOld", "We keep three years of hours");
    return null;
  })();
  const ready = from && to && !problem;

  // The date fields are DateField (16 px FIELD: under it iOS zooms the page
  // on focus).
  const cap = EYEBROW;

  return (
    <div className="fixed inset-0 z-50 m-0 flex items-end vp-scrim" style={{ background: SCRIM }} onClick={onClose} {...closingProps(closing)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("portalHoursCustomTitle")}
        data-testid="portal-period-sheet"
        className="w-full max-w-lg mx-auto m-0 vp-sheet"
        style={{
          background: CARD, color: INK, borderRadius: "28px 28px 0 0",
          padding: "8px 16px calc(18px + env(safe-area-inset-bottom))",
          boxShadow: "0 -20px 40px -20px rgba(8,24,18,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden className="block mx-auto" style={{ width: 36, height: 5, borderRadius: 3, background: GRAB }} />
        <div style={{ marginTop: 14, padding: "0 4px", font: `700 19px/1.25 ${SORA}`, letterSpacing: "-0.015em", color: INK }}>
          {t("portalHoursCustomTitle", "Choose a period")}
        </div>

        <div style={{ marginTop: 16, padding: "0 4px", ...cap }}>{t("portalHoursCycle", "Pay cycle")}</div>
        <div className="flex" style={{ gap: 8, marginTop: 8 }}>
          {cycles.map((c) => {
            const active = from === c.start && to === c.end;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => { setFrom(c.start); setTo(c.end); }}
                aria-pressed={active}
                className={`min-w-0 vp-press ${FOCUS_RING}`}
                style={{
                  flex: 1, padding: "12px 6px", borderRadius: 18, textAlign: "center",
                  background: active ? PINE : IVORY,
                  border: `1px solid ${active ? PINE : LINE}`,
                  boxShadow: active ? "0 8px 18px -12px rgba(14,59,46,0.8)" : "none",
                }}
              >
                <div className="vp-figures" style={{ font: `700 15px/1 ${SORA}`, color: active ? CREAM : INK }}>{c.label}</div>
                <div style={{ marginTop: 6, font: "500 11px/1 var(--font-text)", color: active ? SAGE : MUTED }}>{c.hint}</div>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 18, padding: "0 4px", ...cap }}>{t("portalHoursCustomRange", "Or pick your own dates")}</div>
        {/* Fravær's DateField: an empty iOS date input is wider than half the
            sheet (From ran over To, To off the edge, no placeholder); the
            field holds its column and says "Pick a date" while empty. */}
        <div className="grid" style={{ gap: 10, marginTop: 8, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          <DateField label={t("portalHoursFrom", "From")} value={from} min={floorISO} max={todayISO} onChange={setFrom} testId="portal-period-from" />
          <DateField label={t("portalHoursTo", "To")} value={to} min={from || floorISO} onChange={setTo} testId="portal-period-to" />
        </div>
        {problem && (
          <div role="alert" style={{ marginTop: 10, padding: "0 4px", font: "600 13px/1.4 var(--font-text)", color: ALERT_INK }}>{problem}</div>
        )}

        <button
          type="button"
          disabled={!ready}
          onClick={() => onApply({ start: from, end: to })}
          className={`w-full vp-press ${FOCUS_RING}`}
          style={pineBtn(!ready, { ...BTN_FULL, marginTop: 16 })}
        >
          {t("portalHoursShowPeriod", "Show these hours")}
        </button>
        {initial && (
          <button
            type="button"
            onClick={() => onApply(null)}
            className={`w-full vp-press ${FOCUS_RING}`}
            style={{ marginTop: 8, minHeight: 44, borderRadius: 14, font: "600 14px/1 var(--font-text)", color: MUTED }}
          >
            {t("portalHoursBackToDefault", "Back to my pay period")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Can this device hand a CSV FILE to the OS share sheet (Web Share level 2)?
    Probe, never sniff; a thrown probe is a "no". */
function canShareCsvFile() {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
    return !!navigator.canShare?.({ files: [new File(["x"], "t.csv", { type: "text/csv" })] });
  } catch {
    return false;
  }
}

function HoursTab({ data, maxHours: maxHoursRaw, range, setRange, prevTotal, hoursError, hoursLoading, onRetry }) {
  const { t, lang } = useLanguage();
  const [customOpen, setCustomOpen] = useState(false);
  // An export that came back undelivered (exportToCsv → false): said, never
  // silent. Cleared on the next try.
  const [exportFailed, setExportFailed] = useState(false);
  const periodSheet = usePresence(customOpen);
  // The permit cap is monthly. Against a chosen window of any other length the
  // ratio is meaningless — and it drives an amber/red "permit nearly blown"
  // alarm, so a wrong one is not a cosmetic slip. Suppress it unless we are
  // looking at the owner's own pay period.
  const maxHours = range ? null : maxHoursRaw;

  // Group the period's own entries into ISO weeks for the by-week chart.
  // Derived from the SAME entries the list below renders, so the bars can never
  // disagree with the rows — the prototype's bars are fixtures; these are the
  // actual shifts. `.max` rides along so the tallest bar is found once.
  const weekBars = useMemo(() => {
    const isoWeek = (iso) => {
      const d = new Date(iso + "T00:00:00");
      if (Number.isNaN(d.getTime())) return null;
      const th = new Date(d);
      th.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));   // Thursday of this week
      const jan4 = new Date(th.getFullYear(), 0, 4);
      const week = 1 + Math.round(((th - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
      // th is the Thursday, so ITS year is the ISO week-year by definition.
      return { key: `${th.getFullYear()}-${String(week).padStart(2, "0")}`, week };
    };
    const buckets = new Map();
    // A week of the period with no shifts keeps its (0) column — it used to
    // vanish (W40, W41, W43), which reads as "the chart skipped one" rather
    // than "you were off that week". But only weeks we KNOW: up to today, or
    // the last week holding an entry if that is later. A week that has not
    // happened yet and holds nothing is unknown, not 0 — drawing "0" there is
    // a computed zero shown as measured.
    if (data?.period_start && data?.period_end) {
      const today = toLocalISO(new Date());
      const lastEntry = (data.entries || []).reduce((m, e) => ((e.date || "") > m ? e.date : m), "");
      const known = today > lastEntry ? today : lastEntry;
      const end = known < data.period_end ? known : data.period_end;
      for (let d = data.period_start; d <= end; d = addDays(d, 7)) {
        const k = isoWeek(d);
        if (k) buckets.set(k.key, 0);
      }
      const last = end >= data.period_start ? isoWeek(end) : null;
      if (last) buckets.set(last.key, buckets.get(last.key) || 0);
    }
    for (const e of data?.entries || []) {
      const k = isoWeek(e.date);
      if (k === null) continue;                                // never bucket a date we cannot read
      buckets.set(k.key, (buckets.get(k.key) || 0) + (Number(e.total_hours) || 0));
    }
    // Key is `${isoYear}-${week}` so a range crossing New Year does not collide
    // W52 of one year with W52 of the next, or sort W01 before W52.
    const sorted = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const rows = sorted
      // Six columns: a calendar month can touch six ISO weeks (Nov 2026 runs
      // Sun 1 → Mon 30, W44–W49). Five dropped the first week — hours and
      // all — and flagged the default pay period as "last 5 weeks". Only a
      // long custom window is a tail now.
      .slice(-6)
      // "Uge 40" in Danish, "W40" in English — the label was English always.
      .map(([k, n]) => ({ k, w: t("portalWeekShort", "W{n}", { n: Number(k.split("-")[1]) }), n: Math.round(n * 100) / 100, v: String(Math.round(n * 100) / 100) }));
    rows.max = rows.reduce((m, r) => Math.max(m, r.n), 0) || 1;
    // Flagged, not hidden: with a long custom window these five bars are a tail,
    // not the whole period, so they cannot add up to the headline above them.
    rows.truncated = sorted.length > rows.length;
    // The week we are in, so its bar can be the pine one (the rest sage).
    // Not in the period (a past window) → no bar is pine: nothing is "now".
    rows.current = isoWeek(toLocalISO(new Date()))?.key || null;
    return rows;
  }, [data?.entries, data?.period_start, data?.period_end, t]);

  // A failed load, in the house red, with the way out beside the words.
  const hoursAlert = (stale) => (
    <div
      role="alert"
      className="flex items-start"
      style={{ gap: 9, padding: "11px 13px", borderRadius: 16, background: ALERT_WASH, border: `1px solid ${ALERT_EDGE}`, font: "500 13px/1.45 var(--font-text)", color: ALERT_INK }}
    >
      <AlertTriangle size={16} strokeWidth={2} aria-hidden style={{ flex: "none", marginTop: 1 }} />
      <span>
        {typeof hoursError === "string" ? hoursError : t("portalHoursLoadFailed", "Could not load that period")}
        {/* The numbers below are the LAST good fetch — say so. */}
        {stale && <>{" "}{t("portalHoursStale", "Showing the last numbers we got.")}</>}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={hoursLoading}
            data-testid="portal-hours-retry"
            className="min-h-[44px] disabled:opacity-50"
            style={{ marginLeft: 8, textDecoration: "underline", textUnderlineOffset: 2, color: ALERT_INK, font: "700 13px/1 var(--font-text)" }}
          >
            {t("tryAgain", "Try again")}
          </button>
        )}
        {range && (
          <button
            type="button"
            onClick={() => setRange(null)}
            className="min-h-[44px]"
            style={{ marginLeft: 8, textDecoration: "underline", textUnderlineOffset: 2, color: ALERT_INK, font: "600 13px/1 var(--font-text)" }}
          >
            {t("portalHoursBackToDefault", "Back to my pay period")}
          </button>
        )}
      </span>
    </div>
  );

  if (!data) {
    // A failed FIRST fetch also leaves data null. Showing the skeleton then is
    // an eternal spinner with no way out, so the error wins over the skeleton.
    if (hoursError) return hoursAlert(false);
    return <LoadingSkeleton />;
  }

  const remaining = maxHours ? Math.max(0, maxHours - data.total_hours) : null;

  // Headline can be rostered (from the published schedule) or logged
  // (actuals the owner recorded). Label honestly so staff know which
  // number they're looking at. Default to "schedule" for older payloads.
  const isSchedule = (data.hours_source || "schedule") === "schedule";

  const todayISO = new Date().toLocaleDateString("sv-SE");   // sv-SE renders YYYY-MM-DD in LOCAL time
  // How much of this period the staffer has already reached, vs what is still
  // ahead. Both halves come from `data.entries`, so they always sum to the
  // headline. Deliberately "so far", not "worked": with hours_source=schedule
  // these are ROSTERED shifts, and claiming they were worked would assert a
  // punch we do not have.
  const soFarRaw = (data.entries || [])
    .filter((e) => (e.date || "") < todayISO)
    .reduce((a, e) => a + (Number(e.total_hours) || 0), 0);
  const soFar = Math.round(soFarRaw * 100) / 100;
  // Round the difference of the ROUNDED parts. Differencing the raw float
  // against an already-rounded total leaves residue like 0.0000001, which
  // reads as "hours still left" in a period that closed months ago.
  const ahead = Math.round((Math.round(data.total_hours * 100) / 100 - soFar) * 100) / 100;
  // Entries arrive newest-first, so the soonest upcoming one is the LAST that
  // is still ahead of today.
  const nextUp = [...(data.entries || [])].reverse().find((e) => (e.date || "") >= todayISO);
  // A previous window with NO hours is not a baseline — it is usually "you did
  // not work here yet". Comparing against it would state a measurement where
  // there is none, so the tile stays hidden until there is something to compare.
  const delta = typeof prevTotal === "number" && Number.isFinite(prevTotal) && prevTotal > 0
    ? Math.round((data.total_hours - prevTotal) * 100) / 100
    : null;

  const hoursLabel = isSchedule
    ? t("portalHoursRostered", "Rostered hours")
    : t("portalHoursWorked", "Hours worked");
  const recentLabel = isSchedule
    ? t("portalHoursUpcomingShifts", "Your shifts")
    : t("portalHoursRecentShifts", "Recent shifts");
  const emptyLabel = isSchedule
    ? t("portalHoursNoShifts", "No shifts in this period yet")
    : t("portalHoursNoneLogged", "No hours logged yet this period");

  // The CSV goes out through utils/download.js (exportToCsv → saveFile with
  // preferShare). In the native shell saveFile tries the OS share sheet FIRST
  // — navigator.share({files}), which the iOS Vagtplan app's WKWebView has
  // (fb05b7d3) — and only then the anchor, which is a no-op there
  // ("no_download_manager"). The file is built in JS on the tap, no network
  // round-trip, so the tap's user activation is still alive for the sheet.
  //
  // So what decides is what THIS device can do, not which platform it is: no
  // share/filesystem plugin is synced into either app, and Android's WebView
  // has no Web Share — a button there would be dead. Probe file sharing; when
  // it is missing, or an export comes back undelivered, one line says where
  // the export does work instead of a button that silently does nothing.
  const nativeShell = isNativeApp();
  // A plain probe, not a hook: HoursTab returns early above, and the check
  // is two property reads and a File.
  const canDeliver = !nativeShell || canShareCsvFile();
  const hasRows = data.entries.length > 0;
  const canExport = hasRows && canDeliver;
  const showWebOnly = hasRows && nativeShell && (!canDeliver || exportFailed);

  // The two stat tiles on the pine card: cream figures, sage labels. "lit"
  // is the one that answers the question of the moment (permit, up on last
  // period, the first shift) — a lighter sage, never status-green.
  const tile = (lit) => ({
    padding: "11px 12px", borderRadius: 16,
    background: lit ? "rgba(208, 224, 213, 0.13)" : "rgba(243, 239, 228, 0.07)",
    border: `1px solid ${lit ? "rgba(208, 224, 213, 0.24)" : "rgba(243, 239, 228, 0.12)"}`,
  });
  const tileLabel = (lit) => ({ font: "600 11px/1.2 var(--font-text)", letterSpacing: "0.08em", textTransform: "uppercase", color: lit ? "#CFE0D4" : SAGE });
  const tileValue = { marginTop: 7, font: `700 18px/1 ${SORA}`, color: CREAM };

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>

      {periodSheet.mounted && (
        <PeriodSheet
          closing={periodSheet.closing}
          initial={range}
          anchorMonth={data.period_start}
          onClose={() => setCustomOpen(false)}
          onApply={(r) => { setRange(r); setCustomOpen(false); }}
        />
      )}

      {/* The period IS the control: an ivory card row, the range in Sora, the
          chevron as the affordance. While a new period loads the chevron
          dims (no spinner — the kit's rule); the button says it is busy. */}
      <button
        type="button"
        onClick={() => setCustomOpen(true)}
        aria-busy={hoursLoading ? "true" : undefined}
        data-testid="portal-hours-period"
        className={`w-full flex items-center justify-between vp-press vp-row ${FOCUS_RING}`}
        style={{
          gap: 8, minHeight: 56, padding: "0 16px 0 18px", borderRadius: 20, ...CARD_BOX,
          font: `700 16px/1.2 ${SORA}`, letterSpacing: "-0.01em", color: INK,
        }}
      >
        <span className="tabular-nums truncate">{fmtShort(data.period_start, lang)} – {fmtShort(data.period_end, lang)}</span>
        <ChevronDown size={18} strokeWidth={2} aria-hidden className="shrink-0" style={{ color: MUTED, opacity: hoursLoading ? 0.35 : 1, transition: "opacity var(--dur-fast) var(--ease-out)" }} />
      </button>

      {hoursError && hoursAlert(true)}

      {/* Period info — the next-shift card's sibling: flat pine, radius 24. */}
      <div
        className="relative overflow-hidden"
        data-testid="portal-hours-card"
        style={{
          borderRadius: 24, padding: 20,
          // Last-good numbers under a failed refresh read as such.
          opacity: hoursError ? 0.6 : 1,
          background: PINE, color: CREAM,
        }}
      >

        <div className="relative flex items-end" style={{ gap: 8 }}>
          <span className="vp-figures" data-testid="portal-hours-total" style={{ font: "700 44px/0.9 var(--font-display)", letterSpacing: "-0.04em", color: CREAM }}>
            {/* A new period (or a refresh) rolls only the digits that moved. */}
            <RollingDigits value={fmtPortalHours(data.total_hours, lang)} />
          </span>
          {/* hoursLabel already says "Rostered hours" or "Hours worked" from
              hours_source — the number must never claim to be the other one. */}
          <span style={{ font: "500 13px/1 var(--font-text)", color: SAGE, paddingBottom: 5 }}>
            {hoursLabel.toLowerCase()}
          </span>
        </div>
        <div className="relative flex" style={{ marginTop: 16, gap: 9 }}>
          <div style={{ ...tile(false), flex: maxHours ? 1 : "0 1 auto", minWidth: 96 }}>
            <div style={tileLabel(false)}>
              {t("portalHoursShiftsCount", "Shifts")}
            </div>
            <div className="vp-figures" style={tileValue}>
              <RollingDigits value={data.entries.length} />
            </div>
          </div>
          {/* v2 puts "Est. pay before tax" here. We removed that by decision —
              it was computed from ROSTERED hours and would disagree with the
              payslip. The permit cap is a real number in the same slot; with no
              cap the Shifts tile simply takes the full width. */}
          {maxHours ? (
            <div style={{ ...tile(true), flex: 1.5 }}>
              <div style={tileLabel(true)}>
                {t("portalWorkPermitLimit", "Work permit limit")}
              </div>
              <div className="vp-figures" style={tileValue}>
                <RollingDigits value={`${fmtPortalHours(data.total_hours, lang)} / ${formatHours(maxHours, { lang, decimals: 2 })}`} />
              </div>
            </div>
          ) : soFar > 0 && ahead > 0 ? (
            /* Mid-period only: before the first shift or after the last, a
               split states nothing the headline has not. */
            <div style={{ ...tile(false), flex: 1.5 }}>
              <div style={tileLabel(false)}>
                {t("portalHoursLeft", "Still to come")}
              </div>
              {/* Was "12 / 8" in the permit tile's exact shape — a ratio
                  against a cap. This is a SPLIT of the period, so it states the
                  one number the staffer does not already have. */}
              <div className="vp-figures" style={tileValue}>
                <RollingDigits value={formatHours(ahead, { lang, decimals: 2 })} />
              </div>
            </div>
          ) : delta !== null ? (
            /* vs the previous window of the same length. Zero is stated as
               "same", never as "+0" — a signed zero reads like a measurement
               when it is really "no difference". */
            <div style={{ ...tile(delta >= 0), flex: 1.5 }}>
              <div style={tileLabel(delta >= 0)}>
                {t("portalHoursVsLast", "vs last period")}
              </div>
              <div className="vp-figures" style={tileValue}>
                {delta === 0
                  ? t("portalHoursSameAsLast", "Same")
                  : formatHours(delta, { lang, decimals: 2, sign: true })}
              </div>
            </div>
          ) : nextUp ? (
            /* Nothing worked yet in this window — the useful fact is when it
               starts, not a split that would just restate the headline. */
            <div style={{ ...tile(true), flex: 1.5 }}>
              <div style={tileLabel(true)}>
                {t("portalHoursFirstShift", "First shift")}
              </div>
              <div style={tileValue}>
                {fmtDate(nextUp.date, lang)}{nextUp.start_time ? ` · ${nextUp.start_time}` : ""}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* v2 by-week chart. Bars are proportional to the period's own maximum.
          The week we are in is pine, every other week sage — "where am I in
          this period" before any number is read. Not green: green means
          confirmed / done everywhere else in the app. Silent when a period
          has one week: a single full-height bar compares nothing. Figures
          and week labels are Sora's tabular digits (vp-figures). */}
      {weekBars.length > 1 && (
        <section data-testid="portal-hours-weeks" style={{ ...CARD_BOX, borderRadius: 24, padding: "16px 14px 12px" }}>
          <div className="flex items-center justify-between" style={{ padding: "0 2px" }}>
            <span style={EYEBROW}>
              {t("portalHoursByWeek", "By week")}
            </span>
            <span style={{ font: "500 12px/1 var(--font-text)", color: MUTED }}>
              {weekBars.truncated
                ? t("portalHoursLastNWeeks", "last {n} weeks").split("{n}").join(String(weekBars.length))
                : hoursUnit(lang)}
            </span>
          </div>
          {/* minHeight, not height: the tallest column needs 110 px at
              normal text size and more when the phone's text is larger
              (Android scales it); a fixed 108 squeezed its week label and
              cut it off. Labels never shrink; the bottom one keeps 2 px of
              room for the "g" in "Uge" without moving anything. */}
          <div className="flex items-end" style={{ marginTop: 16, gap: 9, minHeight: 108 }} data-testid="portal-week-bars">
            {weekBars.map((b) => {
              const now = b.k === weekBars.current;
              return (
                <div key={b.k} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full" style={{ gap: 7 }} data-testid="portal-week-bar" data-current={now ? "" : undefined}>
                  <span className="vp-figures" style={{ flexShrink: 0, font: `600 11px/1 ${SORA}`, color: now ? INK : MUTED }}>{fmtPortalHours(b.v, lang)}</span>
                  <div
                    style={{
                      width: "100%", borderRadius: 8,
                      height: Math.max(3, Math.round((b.n / weekBars.max) * 74)),
                      background: now ? PINE : SAGE_BAR,
                      transition: "height .5s cubic-bezier(.22,.9,.24,1)",
                    }}
                  />
                  <span className="vp-figures truncate" style={{ maxWidth: "100%", flexShrink: 0, paddingBottom: 2, marginBottom: -2, font: `600 11px/1 ${SORA}`, color: now ? PINE : MUTED }}>{b.w}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* The permit warning stays SEPARATE from the tile above: the tile shows
          the position, this shows the alarm. Only when it is actually close. */}
      {maxHours && remaining !== null && remaining <= 10 && (
        <VpNote icon={AlertTriangle} testId="portal-hours-permit-note">
          <strong style={{ fontWeight: 700 }}>{t("portalWorkPermitLimit", "Work permit limit")}</strong>
          {/* The repo's hours formatter: a raw float printed 7.410000000000011,
              "1 hours", and a decimal point beside Danish "timer". */}
          <span style={{ display: "block", marginTop: 2 }}>{t("portalHoursRemainingLong", "You have {h} left this period.", { h: formatHours(remaining, { lang, decimals: 2 }) })}</span>
        </VpNote>
      )}

      {/* Recent / upcoming shifts */}
      <section>
        <div className="flex items-center justify-between" style={{ gap: 8, minHeight: 24, padding: "0 4px", marginBottom: 8 }}>
          <span style={EYEBROW}>{recentLabel}</span>
          {canExport && (
            <button
              type="button"
              data-testid="portal-hours-export"
              onClick={() => {
                // Built from the rows on screen, so the file and the screen can
                // never disagree — this is the staffer's own record if the hours
                // are ever queried, so a mismatch would be worse than no export.
                const total = data.entries.reduce((a, e) => a + (Number(e.total_hours) || 0), 0);
                setExportFailed(false);
                Promise.resolve(exportToCsv(
                  `bonbox-timer-${data.period_start}-${data.period_end}.csv`,
                  [
                    ...data.entries.map((e) => ({
                      date: e.date,
                      start: e.start_time || "",
                      end: e.end_time || "",
                      hours: e.total_hours,
                    })),
                    { date: t("portalHoursCsvTotal", "Total"), start: "", end: "", hours: Math.round(total * 100) / 100 },
                  ],
                  [
                    { key: "date", label: t("portalHoursCsvDate", "Date") },
                    { key: "start", label: t("portalHoursCsvStart", "Start") },
                    { key: "end", label: t("portalHoursCsvEnd", "End") },
                    { key: "hours", label: t("portalHoursCsvHours", "Hours") },
                  ],
                )).then((ok) => { if (!ok) setExportFailed(true); }, () => setExportFailed(true));
              }}
              // A quiet text button in pine: the export is a convenience, not
              // this screen's action. 44 tall, pulled back into the row.
              className={`shrink-0 inline-flex items-center vp-press ${FOCUS_RING}`}
              style={{ gap: 6, minHeight: 44, margin: "-10px -8px -10px 0", padding: "0 8px", borderRadius: 12, font: "600 13px/1 var(--font-text)", color: PINE }}
            >
              <Download size={15} strokeWidth={2} aria-hidden />
              {t("portalHoursExport", "Export CSV")}
            </button>
          )}
        </div>
        {/* Open clock punches — a STATE, never a number. They used to arrive
            as entries with total_hours 0 and render "0 timer" with no times,
            and one of them flipped the headline to "0 worked". The server now
            keeps them out of every total and every entry and sends them here
            with the same live/forgotten rule the owner's Timer uses. Brass =
            it waits on the manager; sage = it is running. */}
        {(data.open_punches || []).length > 0 && (
          <div className="flex flex-col" style={{ gap: 6, marginBottom: 8 }}>
            {data.open_punches.map((op) => {
              const forgotten = op.state === "forgotten";
              return (
                <div
                  key={`open-${op.date}-${op.start_time || ""}`}
                  data-testid="portal-open-punch"
                  className="flex items-start"
                  style={{
                    gap: 10, padding: "12px 14px", borderRadius: 18,
                    background: forgotten ? BRASS_WASH : SOFT,
                    border: `1px solid ${forgotten ? BRASS_EDGE : SAGE_EDGE}`,
                  }}
                >
                  {forgotten
                    ? <AlertTriangle size={16} strokeWidth={2} className="shrink-0" style={{ marginTop: 2, color: BRASS_INK }} aria-hidden />
                    : <Clock size={16} strokeWidth={2} className="shrink-0" style={{ marginTop: 2, color: PINE }} aria-hidden />}
                  <div className="min-w-0">
                    <div className="tabular-nums" style={{ font: "400 14px/1.35 var(--font-text)", color: INK }}>
                      {fmtDate(op.date, lang)}{op.start_time ? ` · ${op.start_time}–` : ""}
                    </div>
                    <div style={{ marginTop: 2, font: "600 13px/1.35 var(--font-text)", color: forgotten ? BRASS_INK : PINE }}>
                      {forgotten
                        ? t("portalHoursOpenForgotten", "Clock-out missing — your manager will fix it")
                        : t("portalHoursOpenLive", "Clocked in at {t}", { t: op.start_time || "—" })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {data.entries.length === 0 ? (
          <CalmEmpty icon={Clock} testId="portal-hours-empty">{emptyLabel}</CalmEmpty>
        ) : (
          <div className="overflow-hidden" style={{ ...CARD_BOX, borderRadius: 24 }}>
            {data.entries.map((h, i) => {
              // WHAT THE OWNER DECIDED ABOUT THIS SHIFT.
              //
              // The owner can confirm a shift, mark it absent, or ADJUST it —
              // and an adjustment changes the hours this person is paid for.
              // Until now none of that reached here, so the owner could change
              // someone's hours and the only person with a real stake in the
              // correction was the only one who could not see it.
              //
              // `adjusted` is the one that gets words and colour: BOTH figures,
              // so a reduction reads as a difference the staffer can ask about
              // rather than a number that quietly changed. The server only
              // sends clock_hours when it differs from what was recorded.
              //
              // An UNRESOLVED shift (resolution == null) is left unmarked on
              // purpose. It is the normal state for anything recent, and
              // labelling every fresh row "awaiting" would make the ordinary
              // case look like a problem.
              const adjusted = h.resolution === "adjusted" && h.clock_hours != null;
              return (
                <div
                  key={i}
                  style={{
                    padding: "14px 16px",
                    borderBottom: i === data.entries.length - 1 ? "none" : `1px solid ${DIVIDER}`,
                  }}
                >
                  <div className="flex items-center" style={{ gap: 12 }}>
                    <span className="flex-1 min-w-0" style={{ font: "400 14px/1.35 var(--font-text)", color: INK }}>
                      {fmtDate(h.date, lang)}{" "}
                      {h.start_time && h.end_time ? <span style={{ color: MUTED }}>· {h.start_time}–{h.end_time}</span> : ""}
                    </span>
                    {/* Right-aligned down the list: Sora's tabular digits (vp-figures). */}
                    <span className="text-sm font-semibold vp-figures" style={{ color: INK }} data-testid="portal-hours-entry-total">{formatHours(h.total_hours, { lang, decimals: 2 })}</span>
                  </div>
                  {adjusted && (
                    <p className="flex items-start" style={{ margin: "4px 0 0", gap: 6, font: "500 12px/1.4 var(--font-text)", color: BRASS_INK }}>
                      <PencilLine size={12} className="shrink-0" style={{ marginTop: 2 }} aria-hidden />
                      <span className="tabular-nums">
                        {t("portalHoursAdjusted", "You clocked {clocked} · recorded {recorded}", {
                          clocked: formatHours(h.clock_hours, { lang, decimals: 2 }),
                          recorded: formatHours(h.total_hours, { lang, decimals: 2 }),
                        })}
                      </span>
                    </p>
                  )}
                  {h.resolution === "absent" && (
                    <p className="flex items-start" style={{ margin: "4px 0 0", gap: 6, font: "400 12px/1.4 var(--font-text)", color: MUTED }}>
                      <MinusCircle size={12} className="shrink-0" style={{ marginTop: 2 }} aria-hidden />
                      <span>{t("portalHoursAbsent", "Recorded as not worked")}</span>
                    </p>
                  )}
                  {h.resolution === "confirmed" && (
                    <p className="flex items-start" style={{ margin: "4px 0 0", gap: 6, font: "400 12px/1.4 var(--font-text)", color: MUTED }}>
                      <Check size={12} className="shrink-0" style={{ marginTop: 2, color: PINE }} aria-hidden />
                      <span>{t("portalHoursConfirmed", "Checked by your manager")}</span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* In an app that cannot share a file the export is not drawn, and
            in any app an undelivered export lands here too (see canDeliver
            above): one line says where it does work. */}
        {showWebOnly && (
          <p
            data-testid="portal-hours-export-web-only"
            className="flex items-center"
            style={{ margin: "10px 4px 0", gap: 6, font: "400 13px/1.4 var(--font-text)", color: MUTED }}
          >
            <Download size={14} strokeWidth={2} aria-hidden className="shrink-0" />
            {t("portalHoursExportWebOnly", "Export your hours from bonbox.dk in a browser")}
          </p>
        )}
        {/* On the web an undelivered file is rare (the anchor nearly always
            lands) — but it is said, not swallowed. */}
        {!nativeShell && exportFailed && (
          <p
            role="alert"
            data-testid="portal-hours-export-failed"
            style={{ margin: "10px 4px 0", font: "400 13px/1.4 var(--font-text)", color: ALERT_INK }}
          >
            {t("portalHoursExportFailed", "The file wasn't saved to this device. Try again.")}
          </p>
        )}
      </section>

      {/* Recently clocked — period-INDEPENDENT proof-of-punch. A shift clocked
          just after midnight is dated to the previous business day and can land
          in the previous pay period, so it won't appear in the period summary
          above. This always shows the worker's last real punches so a just-
          finished shift is never invisible. Separate + honestly labelled. */}
      {(() => {
        const recent = data.recent_clocked || [];
        if (recent.length === 0) return null; // back-compat: old payloads omit it
        const winDays = data.recent_clocked_window_days || 14;
        // Dedup: drop punches already shown in the in-period list above so the
        // same shift never renders twice. In-period key = date + start_time.
        const inPeriodKeys = new Set(
          (data.entries || [])
            .filter((e) => data.period_start && data.period_end
              && e.date >= data.period_start && e.date <= data.period_end)
            .map((e) => `${e.date}|${e.start_time || ""}`),
        );
        const extra = recent.filter((r) => !inPeriodKeys.has(`${r.date}|${r.start_time || ""}`));
        if (extra.length === 0) return null; // nothing new to surface
        return (
          <section>
            <div style={{ ...EYEBROW, padding: "0 4px", marginBottom: 8 }}>
              {t("portalHoursRecentlyClocked", "Recently clocked")}
              <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                {" · "}{t("portalHoursRecentlyClockedWindow", "last {n} days", { n: winDays })}
              </span>
            </div>
            <div className="flex flex-col" style={{ gap: 6 }}>
              {extra.map((h, i) => (
                <div key={`rc-${i}`} className="flex items-center justify-between" style={{ gap: 12, padding: "12px 16px", borderRadius: 18, ...CARD_BOX }}>
                  <span className="min-w-0" style={{ font: "400 14px/1.35 var(--font-text)", color: INK }}>
                    {fmtDate(h.date, lang)}{" "}
                    {h.start_time && h.end_time ? <span style={{ color: MUTED }}>· {h.start_time}–{h.end_time}</span> : ""}
                  </span>
                  <span className="text-sm font-semibold vp-figures" style={{ color: INK }} data-testid="portal-hours-recent-total">{formatHours(h.total_hours, { lang, decimals: 2 })}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })()}
    </div>
  );
}





// ─── Swap Tab — peer-to-peer shift trading ─────────────────────────────────

/**
 * SwapTab — staff inbox for shift-swap requests + the propose modal.
 *
 * Two halves:
 *   1. Inbox: pending incoming + outgoing swaps. Each row has accept /
 *      decline (incoming) or withdraw (outgoing). Resolved statuses
 *      hidden by default.
 *   2. "Offer swap" CTA → modal:
 *      a. Pick the shift YOU want to give up (from your own upcoming)
 *      b. Pick the teammate's shift you want in exchange (from team
 *         transparency endpoint)
 *      c. Optional reason
 *      d. Submit → POST /portal/{token}/swap-requests → toast → refresh
 *
 * Multi-layer security inherited from the backend:
 *   • Magic-link token binds the proposer's staff_id (body never
 *     carries it)
 *   • Server validates ownership of from_shift, tenancy of to_staff
 *     and to_shift, lifecycle states on respond
 *   • Server scrubs reason text + caps to 500 chars
 */
function SwapTab({ token, ownShifts, onChanged, onInbox }) {
  const { t, lang } = useLanguage();
  const [inbox, setInbox] = useState(null);
  const [pool, setPool] = useState([]); // colleagues' open give-aways
  const [showPropose, setShowPropose] = useState(false);
  const [showSell, setShowSell] = useState(false);
  const [claimBusy, setClaimBusy] = useState(null);
  const [claimErr, setClaimErr] = useState("");

  const fetchInbox = async () => {
    const [inboxRes, poolRes] = await Promise.allSettled([
      portalApi.get(`/portal/${token}/swap-requests`),
      portalApi.get(`/portal/${token}/give-aways`),
    ]);
    setInbox(inboxRes.status === "fulfilled" ? (inboxRes.value.data || []) : []);
    setPool(poolRes.status === "fulfilled" ? (poolRes.value.data || []) : []);
    // The dock's Byt badge reads the same answer (a failed read leaves the
    // badge as it was rather than zeroing it).
    if (inboxRes.status === "fulfilled") onInbox?.(inboxRes.value.data || []);
  };

  useEffect(() => { fetchInbox(); }, [token]);

  const reload = () => {
    fetchInbox();
    onChanged?.();
  };

  const claimGiveaway = async (id) => {
    setClaimBusy(id);
    setClaimErr("");
    try {
      await portalApi.post(`/portal/${token}/give-aways/${id}/claim`);
      haptic.success(); // you just picked up a shift — a real moment
      reload();
    } catch (err) {
      haptic.warning();
      setClaimErr(portalErrText(err, t, t("portalGaClaimFailed", "Couldn't take the shift. Try again."), lang));
      fetchInbox(); // it may have just been taken — refresh the pool
    } finally {
      setClaimBusy(null);
    }
  };

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Actions — trade (targeted) or sell (open pool). The canvas's entry
          tiles ("Byt en vagt"): two ivory cards, a 38 px sage well with the
          mark in pine, the label in ink. Not filled buttons — the one filled
          pine action on this tab is the answer to a request (Accepter), or
          the submit inside an open form. */}
      {!showPropose && !showSell && (
        <div className="grid grid-cols-2" style={{ gap: 10 }}>
          {[
            { testId: "swap-offer", Icon: ArrowLeftRight, label: t("portalOfferSwapShort", "Swap"), open: () => setShowPropose(true) },
            { testId: "swap-give-away", Icon: Send, label: t("portalGaSellCta", "Give away a shift"), open: () => setShowSell(true) },
          ].map((a) => (
            <button
              key={a.testId}
              type="button"
              onClick={a.open}
              data-testid={a.testId}
              className={`min-w-0 flex flex-col items-start text-left vp-press ${FOCUS_RING}`}
              style={{ gap: 12, padding: 14, borderRadius: 20, ...CARD_BOX, color: INK }}
            >
              <span aria-hidden className="shrink-0 flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 12, background: SOFT, color: PINE }}>
                <a.Icon size={18} strokeWidth={1.9} />
              </span>
              <span style={{ font: "600 15px/1.25 var(--font-text)" }}>{a.label}</span>
            </button>
          ))}
        </div>
      )}
      {showPropose && (
        <SwapProposeModal
          token={token}
          ownShifts={ownShifts}
          onClose={() => setShowPropose(false)}
          onProposed={() => { setShowPropose(false); reload(); }}
        />
      )}
      {showSell && (
        <GiveawaySellModal
          token={token}
          ownShifts={ownShifts}
          onClose={() => setShowSell(false)}
          onOffered={() => { setShowSell(false); reload(); }}
        />
      )}

      {/* Colleagues' open give-aways — first qualified taker wins. The home's
          open-shift rows: a date tile, the time in Sora, who and why, the
          verdict before the tap, and the same sage "Tag den" pill (the
          home's words: the long "Tag vagten" cut the time off at 320 px). */}
      {pool.length > 0 && (
        <section data-testid="swap-pool">
          <div className="flex items-center" style={{ gap: 8, padding: "0 4px", minHeight: 24 }}>
            <HomeH2>{t("portalGaPoolHeading", "Shifts being given away")}</HomeH2>
            <span
              className="inline-flex items-center justify-center vp-figures"
              style={{ height: 20, minWidth: 20, padding: "0 6px", borderRadius: 10, background: PINE, color: CREAM, font: `700 11px/1 ${SORA}` }}
            >
              {pool.length}
            </span>
          </div>
          {claimErr && <div style={{ marginTop: 8 }}><VpNote>{claimErr}</VpNote></div>}
          <div style={{ marginTop: 8, ...CARD_BOX, borderRadius: 22, overflow: "hidden" }}>
            {pool.map((g, i) => {
              const clash = overlapsOwnShift(g.from_shift_date, g.from_shift_time, ownShifts);
              return (
                <div key={g.id}>
                  {i > 0 && <div aria-hidden style={{ height: 1, background: DIVIDER, marginLeft: 80 }} />}
                  <div data-testid="swap-pool-row" className="flex items-center" style={{ gap: 12, padding: "14px 12px 14px 14px" }}>
                    {/^\d{4}-\d{2}-\d{2}$/.test(g.from_shift_date || "") && <DateTile iso={g.from_shift_date} lang={lang} />}
                    <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 3 }}>
                      {/* The tile is aria-hidden (and has no month): the day,
                          in words, for a screen reader. */}
                      {g.from_shift_date && <span className="sr-only">{fmtSwapDay(g.from_shift_date, lang)}</span>}
                      <span className="tabular-nums whitespace-nowrap" style={{ font: `700 16px/1.2 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>
                        {g.from_shift_time}
                      </span>
                      <span className="truncate" style={{ font: "400 13px/1.3 var(--font-text)", color: MUTED }}>
                        {t("portalGaFrom", "From")} {g.from_staff_name}
                        {g.from_branch_name ? ` · ${g.from_branch_name}` : ""}
                        {g.reason ? ` — “${g.reason}”` : ""}
                      </span>
                      {/* v2's eligibility tag — the answer before the tap. */}
                      <span data-testid="swap-pool-verdict" style={{ font: "600 12px/1.2 var(--font-text)", color: clash ? ALERT_INK : PINE }}>
                        {clash ? t("portalGaOverlaps", "Overlaps you") : t("portalGaFree", "You're free then")}
                      </span>
                    </div>
                    {clash ? (
                      <button
                        type="button"
                        onClick={() => setClaimErr(t("portalGaBlockedWhy", "You already work then — that's why this one is blocked."))}
                        aria-disabled
                        className={`shrink-0 inline-flex items-center justify-center vp-press ${FOCUS_RING}`}
                        style={{ height: 44, padding: "0 16px", borderRadius: 999, background: TILE, color: MUTED, font: "600 14px/1 var(--font-text)" }}
                      >
                        {t("portalGaBlocked", "Blocked")}
                      </button>
                    ) : (
                      <TakeItButton
                        onClick={() => claimGiveaway(g.id)}
                        busy={claimBusy === g.id}
                        label={t("portalOpenClaim", "Take it")}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Inbox */}
      {inbox === null && <ListSkeleton label={t("portalLoading", "Loading…")} rows={2} height={72} />}
      {inbox && inbox.length === 0 && !showPropose && (
        <CalmEmpty icon={ArrowLeftRight} testId="swap-empty">
          {t("portalSwapNonePending", "No pending swap requests.")}
        </CalmEmpty>
      )}
      {/* The request that needs the viewer's answer leads; then what waits
          on someone else; then what is done. */}
      {inbox && inbox.length > 0 && (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {orderSwapInbox(inbox).map((s) => (
            <SwapRow key={s.id} swap={s} token={token} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  );
}


/** A row in the Swap inbox. Renders different actions based on
 * direction (incoming = respond, outgoing = withdraw) and status. */
/* Swap shifts arrive as ISO dates ("2026-06-05") — render them the way the
   rest of the portal speaks ("Fri 5 Jun" / "fre. 5. jun."), locale-aware. */

/** The swap endpoints answer a trade that would double-book someone with
    409 {code: "swap_overlap", who: "self" | "colleague"} — `who` relative to
    the person asking. Say it in their language; anything else goes through
    portalErrText (the server's known sentences in the staffer's language,
    an unknown one as errText always showed it). */
function swapErrText(err, t, fallback, lang) {
  const d = err?.response?.data?.detail;
  if (err?.response?.status === 409 && d && d.code === "swap_overlap") {
    return d.who === "colleague"
      ? t("portalSwapClashColleague", "Your colleague already works at that time — this swap would put them on two shifts at once.")
      : t("portalSwapClashSelf", "You already work at that time — this swap would put you on two shifts at once.");
  }
  return portalErrText(err, t, fallback, lang);
}

function fmtSwapDay(iso, lang) {
  if (!iso) return iso;
  try {
    return fmtDate(iso, lang);
  } catch {
    return iso;
  }
}

function SwapRow({ swap, token, onChanged }) {
  const { t, lang } = useLanguage();
  const [busy, setBusy] = useState(false);
  // { text, sticky } — sticky survives the re-read turning the row terminal.
  const [rowErr, setRowErr] = useState(null);

  const respond = async (accept) => {
    setBusy(true);
    setRowErr(null);
    try {
      await portalApi.post(
        `/portal/${token}/swap-requests/${swap.id}/respond`,
        { accept },
      );
      onChanged();
    } catch (err) {
      // A refusal used to vanish: the button just stopped spinning. Now the
      // staffer reads why (e.g. the trade would double-book them) and the
      // request stays open, so Decline is still right there.
      haptic.warning();
      const d = err?.response?.data?.detail;
      const overlap = err?.response?.status === 409 && d?.code === "swap_overlap";
      // The server declined it itself: a shift moved since it was offered.
      const stale = d?.code === "swap_stale";
      setRowErr({
        text: overlap
          ? swapErrText(err, t, "", lang)
          : stale
            ? t("portalSwapStale", "The shifts have changed since this swap was offered — ask your colleague to offer it again.")
            : t("portalSwapRespondFailed", "Couldn't answer the swap. Try again."),
        sticky: stale,
      });
      // Anything but the overlap refusal may have changed the row on the
      // server — the request was declined (stale), or an automatic retry hit
      // "already done" because the first try DID go through. Re-read it, so
      // the row shows what is true instead of Accept/Decline plus an error.
      if (!overlap) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    try {
      await portalApi.post(`/portal/${token}/swap-requests/${swap.id}/withdraw`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // Status pills carry meaning, as on Fravær: brass for the open "proposed"
  // state (it waits on someone), sage-and-pine for the completed
  // "done"/byttet state, a quiet tile for everything else
  // (declined/withdrawn/etc.).
  const statusPill = swap.status === "proposed"
    ? { background: BRASS_WASH, color: BRASS_INK }
    : swap.status === "done"
      ? { background: SOFT, color: PINE }
      : swap.status === "accepted"
        ? { background: TILE, color: INK }
        : { background: TILE, color: MUTED };

  // Give-away = no counter-shift (to_shift_id null). Same state machine,
  // different words: the row reads "up for grabs / taken", never "swap".
  const isGiveaway = !swap.to_shift_id;

  // Localized status word for the pill. "Byttet" (swapped/done) stays
  // Danish across all UI languages per the DK terminology lock.
  const statusLabel = swap.status === "proposed"
    ? (isGiveaway ? t("portalGaStatusOpen", "Being given away") : t("portalSwapStatusProposed", "Pending"))
    : swap.status === "done"
      ? (isGiveaway ? t("portalGaStatusTaken", "Taken") : t("portalSwapStatusDone", "Swapped"))
      : swap.status === "declined"
        ? t("portalSwapStatusDeclined", "Declined")
        : swap.status === "withdrawn"
          ? t("portalSwapStatusWithdrawn", "Withdrawn")
          : swap.status === "accepted"
            ? t("portalSwapStatusAccepted", "Agreed")
            : swap.status;

  // One side of the trade: the day in words, the time in Sora (the home's
  // shift-row tile). Labelled from the VIEWER's side ("Du giver / Du får"):
  // the proposer's "Giver" on an incoming card was the shift the viewer gets.
  const sides = swapSides(swap);
  const side = (label, date, time, testId) => (
    <div data-testid={testId} style={{ minWidth: 0, padding: "10px 12px", borderRadius: 14, background: ROW }}>
      <div style={{ font: "600 11px/1.2 var(--font-text)", letterSpacing: "0.08em", textTransform: "uppercase", color: MUTED }}>{label}</div>
      <div className="truncate" style={{ marginTop: 4, font: "500 13px/1.3 var(--font-text)", color: INK }}>{fmtSwapDay(date, lang)}</div>
      <div className="tabular-nums truncate" style={{ marginTop: 2, font: `700 15px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>{time}</div>
    </div>
  );

  return (
    <div data-testid="swap-row" className="flex flex-col" style={{ gap: 10, padding: 14, borderRadius: 20, ...CARD_BOX }}>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span style={EYEBROW}>
          {swap.direction === "outgoing" ? t("portalSwapOutgoing", "Outgoing") : t("portalSwapIncoming", "Incoming")}
        </span>
        <span data-testid="swap-status" style={{ padding: "5px 10px", borderRadius: 999, font: "600 12px/1 var(--font-text)", ...statusPill }}>
          {statusLabel}
        </span>
      </div>
      <div style={{ font: "400 15px/1.35 var(--font-text)", color: INK }}>
        <span style={{ fontWeight: 600 }}>{swap.from_staff_name}</span>
        {isGiveaway ? (
          swap.status === "done" && swap.to_staff_name ? (
            <>
              <span style={{ color: MUTED }}> → </span>
              <span style={{ fontWeight: 600 }}>{swap.to_staff_name}</span>
            </>
          ) : (
            <span style={{ color: MUTED }}> · {t("portalGaOnBoard", "on the board")}</span>
          )
        ) : (
          <>
            <span style={{ color: MUTED }}> → </span>
            <span style={{ fontWeight: 600 }}>{swap.to_staff_name}</span>
          </>
        )}
      </div>
      <div className="grid" style={{ gap: 8, gridTemplateColumns: isGiveaway ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))" }}>
        {isGiveaway
          ? side(t("portalGaShiftLabel", "Shift"), swap.from_shift_date, swap.from_shift_time, "swap-side-shift")
          : side(t("portalSwapYouGive", "You give"), sides.give.date, sides.give.time, "swap-side-give")}
        {!isGiveaway && sides.get && side(t("portalSwapYouGet", "You get"), sides.get.date, sides.get.time, "swap-side-get")}
      </div>
      {/* The pool's quote marks, upright — one way to quote a colleague. */}
      {swap.reason && (
        <div data-testid="swap-reason" style={{ font: "400 13px/1.4 var(--font-text)", color: MUTED }}>“{swap.reason}”</div>
      )}
      {swap.owner_note && (
        <div style={{ font: "400 13px/1.4 var(--font-text)", color: MUTED }}>
          <span style={{ fontWeight: 600 }}>{t("portalSwapOwnerLabel", "Owner")}:</span> {swap.owner_note}
        </div>
      )}

      {/* Actions */}
      {/* Once the re-read shows the swap settled (done, declined, withdrawn),
          a generic "couldn't answer" is no longer true — the pill says it. */}
      {rowErr && (rowErr.sticky || swap.status === "proposed") && (
        <VpAlert>{rowErr.text}</VpAlert>
      )}
      {swap.status === "proposed" && swap.direction === "incoming" && (
        <div className="flex" style={{ gap: 8 }}>
          <button
            type="button"
            onClick={() => respond(true)}
            disabled={busy}
            data-testid="swap-accept"
            className={`flex-1 min-h-[44px] vp-press ${FOCUS_RING}`}
            style={pineBtn(busy)}
          >
            {t("portalSwapAccept", "Accept")}
          </button>
          <button
            type="button"
            onClick={() => respond(false)}
            disabled={busy}
            data-testid="swap-decline"
            className={`flex-1 min-h-[44px] vp-press disabled:opacity-50 ${FOCUS_RING}`}
            style={BTN_QUIET}
          >
            {t("portalSwapDecline", "Decline")}
          </button>
        </div>
      )}
      {swap.status === "proposed" && swap.direction === "outgoing" && (
        <div>
          <button
            type="button"
            onClick={withdraw}
            disabled={busy}
            className={`min-h-[44px] inline-flex items-center vp-press disabled:opacity-50 ${FOCUS_RING}`}
            style={{ padding: "0 16px", borderRadius: 999, ...CARD_BOX, color: INK, font: "600 13px/1 var(--font-text)" }}
          >
            {t("portalSwapWithdraw", "Withdraw")}
          </button>
        </div>
      )}
      {/* Completed: both staff agreed and the shifts have ALREADY been
          reassigned (auto-execute). Honest, final copy — no "awaiting
          owner". The schedule tab now shows the new shift. */}
      {swap.status === "done" && (
        <div data-testid="swap-done-line" className="flex items-center" style={{ gap: 6, font: "500 13px/1.35 var(--font-text)", color: PINE }}>
          <Check size={15} strokeWidth={2.4} className="shrink-0" aria-hidden />
          {/* A give-away was TAKEN, not swapped — its pill says "Overtaget",
              so the line under it must not say "Byttet". */}
          <span>{isGiveaway
            ? t("portalGaDoneLine", "Taken — the schedule is updated.")
            : t("portalSwapDoneLine", "Done — shifts swapped. Your schedule is updated.")}</span>
        </div>
      )}
      {/* Legacy/edge: a swap left in `accepted` (e.g. a future owner-
          approval flow). Calm, non-promising copy. */}
      {swap.status === "accepted" && (
        <div className="flex items-center" style={{ gap: 6, font: "500 13px/1.35 var(--font-text)", color: INK }}>
          <Check size={15} strokeWidth={2.4} className="shrink-0" style={{ color: PINE }} aria-hidden />
          <span>{t("portalSwapAcceptedLine", "You both agreed.")}</span>
        </div>
      )}
    </div>
  );
}


/** Modal for proposing a new swap. Pulls the team's upcoming shifts
 * via /portal/{token}/team-schedule and the staff's own from a prop. */
/** GiveawaySellModal — "Sæt en vagt til salg": pick one of your own future
 * shifts, optional reason, post it to the colleague pool. First qualified
 * taker gets it (auto-execute, same doctrine as swaps); withdraw anytime
 * before it's taken via the request row in the inbox below. */
function GiveawaySellModal({ token, ownShifts, onClose, onOffered }) {
  const { t, lang } = useLanguage();
  const [shiftId, setShiftId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const todayIso = new Date().toISOString().slice(0, 10);
  const upcomingOwn = (ownShifts || []).filter((s) => (s.date || "") >= todayIso);

  const submit = async () => {
    if (!shiftId) return;
    setSubmitting(true);
    setError("");
    try {
      await portalApi.post(`/portal/${token}/give-aways`, {
        shift_id: shiftId,
        reason: reason.trim() || null,
      });
      haptic.light();
      onOffered?.();
    } catch (err) {
      setError(portalErrText(err, t, t("portalGaOfferFailed", "Couldn't post the shift. Try again."), lang));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-kb-block="" data-testid="swap-sell" className="flex flex-col vp-sheet" style={{ gap: 14, padding: 16, borderRadius: 24, ...CARD_BOX }}>
      <SwapFormHead icon={Send} title={t("portalGaSellCta", "Give away a shift")} onClose={onClose} closeLabel={t("close", "Close")} />
      <p style={{ margin: 0, font: "400 13px/1.45 var(--font-text)", color: MUTED }}>
        {t("portalGaSellHint", "Your shift goes on the board for colleagues. It stays yours until someone takes it — first come, first served.")}
      </p>
      <select
        value={shiftId}
        onChange={(e) => setShiftId(e.target.value)}
        className={FIELD_CLS}
        style={FIELD}
      >
        <option value="">{t("portalGaPickShift", "Pick your shift…")}</option>
        {upcomingOwn.map((s) => (
          <option key={s.id} value={s.id}>
            {fmtSwapDay(s.date, lang)} · {s.start_time}–{s.end_time}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={200}
        placeholder={t("portalGaReasonPh", "Reason (optional — colleagues see it)")}
        className={FIELD_CLS}
        style={FIELD}
      />
      {error && <VpAlert>{error}</VpAlert>}
      <button
        type="button"
        onClick={submit}
        disabled={!shiftId || submitting}
        className={`w-full vp-press ${FOCUS_RING}`}
        style={pineBtn(!shiftId || submitting, BTN_FULL)}
      >
        {submitting ? "…" : t("portalGaSellSubmit", "Give it away")}
      </button>
    </div>
  );
}

/** The head of Byt's two inline forms: a sage well with the form's mark, the
    title in Sora, and a 44 px close (the ⋯ sheet's). */
function SwapFormHead({ icon, title, onClose, closeLabel }) {
  const Icon = icon;
  return (
    <div className="flex items-center justify-between" style={{ gap: 12 }}>
      <div className="flex items-center min-w-0" style={{ gap: 10 }}>
        <span className="shrink-0 flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 12, background: SOFT, color: PINE }}>
          <Icon size={18} strokeWidth={1.9} aria-hidden />
        </span>
        <span className="truncate" style={{ font: `700 17px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>{title}</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        data-back-close=""
        className={`shrink-0 flex items-center justify-center rounded-full vp-press ${FOCUS_RING}`}
        style={{ width: 44, height: 44, background: TILE, color: INK }}
      >
        <X size={18} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}


function SwapProposeModal({ token, ownShifts, onClose, onProposed }) {
  const { t, lang } = useLanguage();
  const [teamShifts, setTeamShifts] = useState([]);
  const [fromShiftId, setFromShiftId] = useState("");
  const [toShiftId, setToShiftId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    portalApi
      .get(`/portal/${token}/team-schedule`)
      .then((r) => setTeamShifts(r.data || []))
      .catch(() => setTeamShifts([]));
  }, [token]);

  // The from_shift must be one of YOUR upcoming shifts.
  const upcomingOwn = (ownShifts || []).filter(
    (s) => s.date >= toLocalISO(new Date()),
  );

  // Don't let staff pick THEIR OWN shift as the to_shift — that'd be a
  // self-swap. Server rejects but UI catches it earlier.
  const ownStaffId = teamShifts.find((s) => s.shift_id === fromShiftId)?.staff_id;
  const fromShift = upcomingOwn.find((s) => s.id === fromShiftId) || null;
  const teammateShifts = teamShifts.filter(
    (s) => s.shift_id !== fromShiftId && s.staff_id !== ownStaffId,
  );
  // Never offer a trade that would put either of you on two shifts at once —
  // an accept executes it immediately. The server refuses it too (409); this
  // just keeps the impossible option off the list. The count says why the
  // list is shorter than the team schedule.
  const candidateTeamShifts = teammateShifts.filter(
    (s) => !swapDoubleBooks({ fromShift, toShift: s, ownShifts, teamShifts }),
  );
  const hiddenForOverlap = fromShift ? teammateShifts.length - candidateTeamShifts.length : 0;

  const submit = async () => {
    if (!fromShiftId || !toShiftId) return;
    const target = teamShifts.find((s) => s.shift_id === toShiftId);
    if (!target) return;
    setSubmitting(true);
    setError("");
    try {
      await portalApi.post(`/portal/${token}/swap-requests`, {
        from_shift_id: fromShiftId,
        to_staff_id: target.staff_id,
        to_shift_id: target.shift_id,
        reason: reason.trim() || null,
      });
      onProposed?.();
    } catch (err) {
      setError(swapErrText(err, t, t("portalSwapProposeFailed", "Couldn't propose. Try again."), lang));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-kb-block="" data-testid="swap-propose" className="flex flex-col vp-sheet" style={{ gap: 14, padding: 16, borderRadius: 24, ...CARD_BOX }}>
      <SwapFormHead icon={ArrowLeftRight} title={t("portalOfferSwap", "Offer to swap")} onClose={onClose} closeLabel={t("close", "Close")} />

      <label className="block min-w-0">
        <span style={FIELD_LABEL}>{t("portalSwapGiveUp", "Your shift to give up")}</span>
        <select
          value={fromShiftId}
          onChange={(e) => { setFromShiftId(e.target.value); setToShiftId(""); }}
          className={FIELD_CLS}
          style={FIELD}
        >
          <option value="">{t("portalSwapPickOwn", "Pick one of your shifts…")}</option>
          {upcomingOwn.map((s) => (
            <option key={s.id} value={s.id}>
              {fmtSwapDay(s.date, lang)} · {s.start_time}–{s.end_time}
            </option>
          ))}
        </select>
      </label>

      {fromShiftId && (
        <label className="block min-w-0">
          <span style={FIELD_LABEL}>{t("portalSwapTakeInExchange", "Your colleague's shift you'd take instead")}</span>
          <select
            value={toShiftId}
            onChange={(e) => setToShiftId(e.target.value)}
            className={FIELD_CLS}
            style={FIELD}
          >
            <option value="">{t("portalSwapPickTeammate", "Pick a colleague's shift…")}</option>
            {candidateTeamShifts.map((s) => (
              <option key={s.shift_id} value={s.shift_id}>
                {s.staff_name} — {fmtSwapDay(s.date, lang)} · {s.start_time}–{s.end_time}
              </option>
            ))}
          </select>
          {hiddenForOverlap > 0 && (
            <p data-testid="swap-hidden-overlap" style={{ margin: "8px 2px 0", font: "400 13px/1.4 var(--font-text)", color: MUTED }}>
              {t("portalSwapHiddenOverlap", "{n} hidden — they would put you or your colleague on two shifts at once.")
                .split("{n}").join(String(hiddenForOverlap))}
            </p>
          )}
        </label>
      )}

      <label className="block min-w-0">
        <span style={FIELD_LABEL}>
          {t("portalSwapReason", "Reason")} <span style={{ fontWeight: 400 }}>{t("portalSwapReasonOptional", "(optional)")}</span>
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          rows={2}
          placeholder={t("portalSwapReasonPlaceholder", "e.g. family wedding, doctor's appointment")}
          className={`${FIELD_CLS} resize-none`}
          style={FIELD}
        />
      </label>

      {error && <VpAlert>{error}</VpAlert>}

      <button
        type="button"
        onClick={submit}
        disabled={submitting || !fromShiftId || !toShiftId}
        className={`w-full vp-press ${FOCUS_RING}`}
        style={pineBtn(submitting || !fromShiftId || !toShiftId, BTN_FULL)}
      >
        {submitting ? t("portalSending", "Sending…") : t("portalSwapSubmit", "Send swap request")}
      </button>
      <p className="text-center" style={{ margin: 0, font: "400 12px/1.4 var(--font-text)", color: MUTED }}>
        {t("portalSwapProposeHint", "Your colleague will see this in their inbox. If they accept, the two shifts swap automatically.")}
      </p>
    </div>
  );
}


// ─── Alerts Tab ──────────────────────────────────────────────────────────

/**
 * Everything that changed since you last looked, newest first.
 *
 * Two things about the data this renders, both of which shape the design:
 *
 *   • Only FOUR event types ever reach a staffer. `GET /notifications` filters
 *     on `staff_id == member.id`, and the other seven event types in the
 *     backend are written with `staff_id=None` — they are owner rows. So the
 *     map below is the complete set, not a sample.
 *
 *   • There is no read/unread column anywhere. The prototype's "N unread",
 *     "Mark all read" and the unread row treatment all need a read state that
 *     the server does not have. Rather than invent one, this uses the reading
 *     the prototype's own copy implies — "since you last looked" — as a
 *     per-device last-seen timestamp. It is honest about what it measures:
 *     this device's last visit, not a synced account-wide receipt.
 */
const ALERT_SEEN_KEY = "bonbox_alerts_seen";

function readAlertsSeen(token) {
  try {
    const all = JSON.parse(localStorage.getItem(ALERT_SEEN_KEY) || "{}");
    return all[token] || null;
  } catch { return null; }
}

function writeAlertsSeen(token, iso) {
  try {
    const all = JSON.parse(localStorage.getItem(ALERT_SEEN_KEY) || "{}");
    all[token] = iso;
    localStorage.setItem(ALERT_SEEN_KEY, JSON.stringify(all));
  } catch { /* private mode — the feed still works, nothing is marked read */ }
}

function AlertsTab({ token, onNavigate }) {
  const { t, lang } = useLanguage();
  const [notifications, setNotifications] = useState(null);
  const [loading, setLoading] = useState(true);
  // Captured at mount: marking read must not make rows vanish under the finger
  // while the staffer is still reading them.
  const [seenAt] = useState(() => readAlertsSeen(token));
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setLoading(true);
    portalApi.get(`/portal/${token}/notifications`)
      .then((res) => setNotifications(res.data.notifications || []))
      .catch(() => setNotifications([]))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <LoadingSkeleton />;

  // Every schedule change also writes one push row per device whose subject is
  // the app name ("BonBox · Vagtplan"), carrying no information. Dropping the
  // push CHANNEL is what the old `channel === "in_app"` filter was reaching
  // for, but that one broke for anyone with an email on file: their real row
  // is logged as `email`, so the in_app list came back empty, the fail-open
  // branch fired, and every alert appeared beside its contentless twin.
  const all = notifications || [];
  const content = all.filter((n) => n.channel !== "push");
  const feed = content.length ? content : all;   // fail open rather than blank

  const parsed = feed.map((n) => {
    // The subject is machine-built as "<English verb> - <date label>". Split it
    // so the row gets a translated title and keeps the date as the body — and
    // read the VERB from the subject, not the event type: reassigning a shift
    // away from someone is logged as `shift_changed` but reads "Shift
    // cancelled", and a title contradicting its own body is worse than a
    // generic one.
    const subject = n.subject || "";
    const cut = subject.lastIndexOf(" - ");
    const cancelled = /cancelled/i.test(subject);

    let kind = n.event_type;
    if (n.event_type === "shift_changed" && cancelled) kind = "shift_deleted";

    // The detail line is built from DATA (ref_date / ref_start / ref_end from
    // the server) in the app's language — "ons. 25. nov. · 11:00–20:00",
    // "Uge 48 · 23. nov. – 29. nov." It used to print the stored subject's
    // tail, an English display string fixed at send time ("Wed 25 Nov") with
    // no shift time. A row the server could not read keeps its stored text.
    let detail = cut > 0 ? subject.slice(cut + 3) : subject;
    if (n.ref_date) {
      if (kind === "schedule_published") {
        detail = `${t("portalWeekN", "Week {n}", { n: isoWeekNumber(n.ref_date) })} · ${fmtShort(n.ref_date, lang)} – ${fmtShort(addDays(n.ref_date, 6), lang)}`;
      } else {
        detail = fmtDate(n.ref_date, lang) + (n.ref_start && n.ref_end ? ` · ${n.ref_start}–${n.ref_end}` : "");
      }
    }

    const META = {
      schedule_published: { Icon: Calendar, tone: "green", title: t("portalEvtSchedulePublished", "Schedule published"), tab: "schedule" },
      shift_changed:      { Icon: Clock,    tone: "amber", title: t("portalEvtShiftChanged", "Shift changed"),        tab: "schedule" },
      shift_deleted:      { Icon: CalendarOff, tone: "amber", title: t("portalEvtShiftDeleted", "Shift cancelled"),   tab: "schedule" },
      // The staffer is already inside the portal, so there is nowhere useful to
      // send them — no tab, deliberately.
      staff_link_shared:  { Icon: Mail,     tone: "slate", title: t("portalEvtLinkShared", "Portal link sent"),       tab: null },
    };
    const meta = META[kind] || { Icon: Bell, tone: "slate", title: subject || n.event_type, tab: null };
    const unread = !seenAt || (n.created_at || "") > seenAt;
    return { n, meta, detail: detail === meta.title ? "" : detail, unread };
  });

  const unreadCount = dismissed ? 0 : parsed.filter((r) => r.unread).length;

  const markAll = () => {
    if (!unreadCount) return;
    writeAlertsSeen(token, new Date().toISOString());
    setDismissed(true);      // grey the rows in place; do not reshuffle the list
  };

  if (!feed.length) {
    return (
      <div className="space-y-4">
        <div className="text-center py-12">
          <Bell className="w-8 h-8 text-gray-300 mb-3 mx-auto" strokeWidth={2} aria-hidden />
          <h3 className="font-display text-[14.5px] font-bold tracking-[-0.02em] leading-[1.2] text-gray-900 mb-1">{t("portalAlertsEmptyTitle", "No notifications yet")}</h3>
          <p className="text-sm text-gray-500">
            {t("portalAlertsEmptyBody", "You'll see shift reminders, schedule updates, and tip notifications here.")}
          </p>
        </div>
      </div>
    );
  }

  const TONES = {
    green: ["#dcfce7", "#16a34a"],
    amber: ["#fef3c7", "#d97706"],
    slate: ["#eef2f7", "#64748b"],
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <span style={{ font: "700 10px/1 var(--font-text)", letterSpacing: "0.15em", textTransform: "uppercase", color: "#94a3b8" }}>
          {t("portalAlertsRecentShort", "Recent")}
        </span>
        <button
          type="button"
          onClick={markAll}
          disabled={!unreadCount}
          style={{ font: "600 11px/1 var(--font-text)", color: unreadCount ? "#16a34a" : "#cbd5e1" }}
        >
          {t("portalAlertsMarkAllRead", "Mark all read")}
        </button>
      </div>

      <div className="flex flex-col" style={{ marginTop: 11, gap: 8 }}>
        {parsed.map(({ n, meta, detail, unread: wasUnread }) => {
          const unread = wasUnread && !dismissed;
          const [bg, fg] = TONES[meta.tone];
          const EvtIcon = meta.Icon;
          const target = meta.tab && onNavigate ? meta.tab : null;
          return (
            <button
              key={n.id}
              type="button"
              // Opens the week the alert is ABOUT, not just the tab.
              onClick={target ? () => onNavigate(target, n.ref_date || null) : undefined}
              // A row that goes nowhere must not pretend to be pressable.
              style={{
                display: "flex", alignItems: "flex-start", gap: 11,
                padding: "13px 14px", borderRadius: 17, textAlign: "left",
                cursor: target ? "pointer" : "default",
                background: unread ? "#fff" : "rgba(255,255,255,.5)",
                border: `1px solid ${unread ? "#e8edf3" : "#eef2f7"}`,
                boxShadow: unread ? "0 1px 2px rgba(15,23,42,.04), 0 14px 28px -26px rgba(15,23,42,.4)" : "none",
              }}
            >
              <span
                style={{
                  width: 34, height: 34, flex: "none", borderRadius: 12,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: bg, color: fg,
                }}
              >
                <EvtIcon size={17} strokeWidth={1.85} aria-hidden />
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline justify-between" style={{ gap: 8 }}>
                  <span style={{ font: `${unread ? 700 : 600} 12.5px/1.2 var(--font-text)`, color: unread ? "#0f172a" : "#475569" }}>
                    {meta.title}
                  </span>
                  <span style={{ font: "500 10.5px/1 var(--font-text)", color: "#94a3b8", flex: "none" }}>
                    {n.created_at ? formatTimeAgo(n.created_at, lang, t) : ""}
                  </span>
                </span>
                {detail && (
                  <span className="block" style={{ marginTop: 5, font: "400 11.5px/1.45 var(--font-text)", color: "#64748b", textWrap: "pretty" }}>
                    {detail}
                  </span>
                )}
              </span>
              <span
                style={{
                  width: 7, height: 7, flex: "none", marginTop: 6, borderRadius: 99,
                  background: "#16a34a", opacity: unread ? 1 : 0,
                }}
              />
            </button>
          );
        })}
      </div>

      {/* The prototype says "Alerts older than 30 days are cleared
          automatically." That is not true of this backend: the endpoint takes
          the last 30 ROWS and no job ever purges by age. Ship what the code
          actually does. */}
      <div style={{ marginTop: 16, textAlign: "center", font: "400 11px/1.5 var(--font-text)", color: "#94a3b8" }}>
        {t("portalAlertsFooter", "Showing your last 30 updates.")}
      </div>
    </div>
  );
}

function formatTimeAgo(dateStr, lang, t) {
  try {
    // Backend timestamps are UTC but can arrive tz-less; a naive string is
    // parsed as LOCAL, making everything look offset by the local UTC delta
    // (e.g. "2h ago" in Denmark/CEST for something that just happened).
    // Treat a designator-less string as UTC.
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dateStr) ? dateStr : `${dateStr}Z`;
    const d = new Date(iso);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return t("portalJustNow", "just now");
    if (diff < 3600) return t("portalMinsAgo", "{n}m ago", { n: Math.floor(diff / 60) });
    if (diff < 86400) return t("portalHoursAgo", "{n}h ago", { n: Math.floor(diff / 3600) });
    if (diff < 604800) return t("portalDaysAgo", "{n}d ago", { n: Math.floor(diff / 86400) });
    return d.toLocaleDateString(localeFor(lang));
  } catch {
    return "";
  }
}


// ─── Messages (Beskeder) — the owner thread plus staff groups ──────────────
//
// v2's shape: a list of conversations, then one open thread with a back link.
// The owner channel is pinned to the top because it is the one that carries
// schedule news; groups follow by most recent activity.

/** One row in the conversation list — an ivory card with the name in Sora.
    Unread is carried by weight, the preview's ink and a pine count, not by
    the badge alone: a badge alone is invisible in a hurried glance. */
function ThreadRow({ thread, onOpen }) {
  const { t, lang } = useLanguage();
  const unread = thread.unread || 0;
  const isGroup = thread.kind === "group";
  const name = thread.title || t("staffChatOwnerLabel", "Manager");
  const preview = thread.last_body
    ? (thread.last_sender ? `${thread.last_sender}: ${thread.last_body}` : thread.last_body)
    : t("staffChatNoMessagesYet", "No messages yet");

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="portal-thread-row"
      data-unread={unread ? "" : undefined}
      className={`w-full text-left flex items-center vp-press vp-row ${FOCUS_RING}`}
      style={{ gap: 12, padding: "12px 14px 12px 12px", minHeight: 68, borderRadius: 20, ...CARD_BOX, color: INK }}
    >
      <span
        aria-hidden
        className="flex-none flex items-center justify-center"
        style={{
          width: 44, height: 44, borderRadius: 999,
          // The owner channel is pine, so it never reads as just another
          // colleague; a group is a sage well with the people mark.
          background: isGroup ? SOFT : PINE,
          color: isGroup ? PINE : CREAM,
          font: "600 14px/1 var(--font-text)",
        }}
      >
        {isGroup ? <Users size={18} strokeWidth={1.9} /> : staffInitials(name)}
      </span>
      <span className="flex-1 min-w-0 flex flex-col" style={{ gap: 4 }}>
        <span className="flex items-baseline justify-between" style={{ gap: 8 }}>
          <span
            className="truncate"
            style={{ font: `${unread ? 700 : 600} 15px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}
          >
            {name}
          </span>
          <span className="flex-none" style={{ font: `${unread ? 600 : 500} 12px/1 var(--font-text)`, color: unread ? PINE : MUTED }}>
            {thread.last_message_at ? formatTimeAgo(thread.last_message_at, lang, t) : ""}
          </span>
        </span>
        <span className="flex items-center" style={{ gap: 8 }}>
          <span
            className="flex-1 min-w-0 truncate"
            style={{ font: `${unread ? 500 : 400} 13px/1.35 var(--font-text)`, color: unread ? INK : MUTED }}
          >
            {preview}
          </span>
          {unread > 0 && (
            <span
              data-testid="portal-thread-unread"
              className="flex-none inline-flex items-center justify-center vp-figures vp-pop"
              style={{ minWidth: 20, height: 20, padding: "0 6px", borderRadius: 999, background: PINE, color: CREAM, font: `700 11px/1 ${SORA}` }}
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}


/** Create a group. Deliberately two fields and nothing else — a name and who
    is in it. Colleagues come from an endpoint that returns names and roles
    only, so this picker cannot become a staff directory. */
function NewGroupSheet({ token, onClose, onCreated, closing = false }) {
  const { t } = useLanguage();
  const [colleagues, setColleagues] = useState(null);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    portalApi
      .get(`/portal/${token}/chat/colleagues`)
      .then((res) => setColleagues(res.data.colleagues || []))
      .catch(() => setColleagues([]));
  }, [token]);

  const toggle = (id) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const create = async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await portalApi.post(`/portal/${token}/chat/groups`, {
        title: name,
        staff_ids: picked,
      });
      onCreated(res.data.thread_id);
    } catch {
      setError(t("staffChatGroupFailed", "Could not create the group. Try again."));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 m-0 flex items-end sm:items-center sm:justify-center" style={KB_LIFT_STYLE} {...closingProps(closing)}>
      <div className="absolute inset-0 m-0 vp-scrim" style={{ background: SCRIM }} onClick={onClose} aria-hidden />
      {/* The ⋯ sheet's material: card, 28 px top corners, the grabber. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("staffChatNewGroup", "New group")}
        data-testid="portal-new-group"
        className="relative w-full sm:max-w-sm m-0 vp-sheet"
        style={{
          background: CARD, color: INK,
          borderRadius: "28px 28px 0 0",
          paddingTop: 8,
          paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
          boxShadow: "0 -20px 40px -20px rgba(8,24,18,0.5)",
        }}
      >
        <span aria-hidden className="block mx-auto" style={{ width: 36, height: 5, borderRadius: 3, background: GRAB, marginBottom: 10 }} />
        <div className="flex items-center justify-between" style={{ gap: 12, padding: "0 16px 12px 20px" }}>
          <h3 style={{ margin: 0, font: `700 19px/1.25 ${SORA}`, letterSpacing: "-0.015em", color: INK }}>
            {t("staffChatNewGroup", "New group")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("staffChatCancel", "Cancel")}
            className={`shrink-0 flex items-center justify-center rounded-full vp-press ${FOCUS_RING}`}
            style={{ width: 44, height: 44, minHeight: 0, background: TILE, color: INK }}
          >
            <X size={18} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <div style={{ padding: "0 16px" }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            placeholder={t("staffChatGroupNamePlaceholder", "e.g. Kitchen")}
            className={FIELD_CLS}
            // 16px: under it iOS zooms the page on focus (inline beats the
            // index.css anti-zoom rule) — same fix as the chat composer.
            style={{ ...FIELD, font: "500 16px/1.35 var(--font-text)" }}
          />
          <p style={{ ...EYEBROW, margin: "16px 4px 8px" }}>
            {t("staffChatChoosePeople", "Who's in it?")}
          </p>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: "42vh", padding: "0 16px" }}>
          {colleagues === null ? (
            <div className="flex flex-col py-1" style={{ gap: 6 }} data-testid="portal-skeleton">
              {[1, 2, 3].map((i) => <div key={i} className="vp-shimmer" style={{ height: 52, borderRadius: 16, background: DIVIDER }} />)}
            </div>
          ) : colleagues.length === 0 ? (
            <p style={{ margin: "4px 4px 8px", font: "400 14px/1.4 var(--font-text)", color: MUTED }}>
              {t("staffChatNoColleagues", "No colleagues to add yet.")}
            </p>
          ) : (
            <div className="flex flex-col pb-2" style={{ gap: 6 }}>
              {colleagues.map((c) => {
                const on = picked.includes(c.staff_id);
                return (
                  <button
                    key={c.staff_id}
                    type="button"
                    onClick={() => toggle(c.staff_id)}
                    aria-pressed={on}
                    className={`w-full flex items-center text-left vp-press vp-row ${FOCUS_RING}`}
                    style={{
                      gap: 12, padding: "8px 12px", minHeight: 52, borderRadius: 16,
                      border: `1px solid ${on ? SAGE_EDGE : LINE}`,
                      background: on ? SOFT : CARD,
                    }}
                  >
                    <span
                      aria-hidden
                      className="flex-none inline-flex items-center justify-center"
                      style={{
                        width: 34, height: 34, borderRadius: 999,
                        background: pineTone(c.name), color: IVORY,
                        font: "600 12px/1 var(--font-text)",
                      }}
                    >
                      {staffInitials(c.name)}
                    </span>
                    <span className="flex-1 min-w-0 flex flex-col" style={{ gap: 2 }}>
                      <span className="truncate" style={{ font: "600 14px/1.25 var(--font-text)", color: INK }}>
                        {c.name}
                      </span>
                      {c.role && (
                        <span className="truncate" style={{ font: "400 12px/1.2 var(--font-text)", color: MUTED }}>
                          {roleName(c.role, t)}
                        </span>
                      )}
                    </span>
                    <span
                      aria-hidden
                      className="flex-none inline-flex items-center justify-center"
                      style={{
                        width: 24, height: 24, borderRadius: 999, boxSizing: "border-box",
                        background: on ? PINE : "transparent", color: CREAM,
                        border: on ? "none" : `1.5px solid ${GRAB}`,
                      }}
                    >
                      {on && <Check size={14} strokeWidth={2.6} />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 16px 0" }}>
          {error && <div style={{ marginBottom: 8 }}><VpAlert>{error}</VpAlert></div>}
          <button
            type="button"
            onClick={create}
            disabled={!title.trim() || busy}
            className={`w-full vp-press ${FOCUS_RING}`}
            style={pineBtn(!title.trim() || busy, BTN_FULL)}
          >
            {t("staffChatCreateGroup", "Create group")}
          </button>
        </div>
      </div>
    </div>
  );
}


/** The conversation list. Search filters on name AND last message, which is
    what people actually remember — "the one about Friday", not a name. */
function ThreadListView({ token, onOpen, onRead }) {
  const { t } = useLanguage();
  const [threads, setThreads] = useState(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const groupSheet = usePresence(creating);

  const load = useCallback(() => {
    portalApi
      .get(`/portal/${token}/chat/threads`)
      .then((res) => {
        setThreads(res.data.threads || []);
        onRead?.();
      })
      .catch(() => setThreads((prev) => prev || []));
  }, [token, onRead]);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 8000);
    return () => clearInterval(id);
  }, [load]);

  const q = query.trim().toLowerCase();
  const shown = (threads || []).filter(
    (th) =>
      !q ||
      (th.title || "").toLowerCase().includes(q) ||
      (th.last_body || "").toLowerCase().includes(q),
  );

  return (
    <div>
      <div className="flex items-center" style={{ gap: 8 }}>
        {/* An ivory field with the hairline (the canvas's header bell), and a
            pine "+" beside it — the screen's one filled control. */}
        <label
          className="flex-1 min-w-0 flex items-center border border-[#E8E3D8] focus-within:border-[#0E3B2E]/50"
          style={{ gap: 10, height: 44, padding: "0 16px", borderRadius: 999, background: CARD, color: MUTED, boxSizing: "border-box" }}
          data-testid="portal-chat-search"
        >
          <Search size={16} strokeWidth={2} aria-hidden className="flex-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("staffChatSearch", "Search people and messages")}
            aria-label={t("staffChatSearch", "Search people and messages")}
            className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-[#8A948E]"
            style={{ font: "400 16px/1.2 var(--font-text)", color: INK, minHeight: 0 }}
          />
        </label>
        <button
          type="button"
          onClick={() => setCreating(true)}
          aria-label={t("staffChatNewGroup", "New group")}
          data-testid="portal-chat-new-group"
          className={`flex-none flex items-center justify-center vp-press ${FOCUS_RING}`}
          style={{
            width: 44, height: 44, borderRadius: 999,
            background: PINE, color: CREAM,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 18px -12px rgba(14,59,46,0.8)",
          }}
        >
          <Plus size={20} strokeWidth={2.2} aria-hidden />
        </button>
      </div>

      <div style={{ marginTop: 14, gap: 8 }} className="flex flex-col">
        {threads === null ? (
          [1, 2, 3].map((i) => (
            <div key={i} className="vp-shimmer" style={{ height: 68, borderRadius: 20, background: DIVIDER }} data-testid="portal-skeleton" />
          ))
        ) : shown.length === 0 ? (
          <CalmEmpty icon={q ? Search : MessageSquare} testId="portal-chat-empty">
            {q
              ? t("staffChatNoMatches", "Nothing matches that.")
              : t("staffChatEmptyBody", "Send your manager a message — questions, running late, anything.")}
          </CalmEmpty>
        ) : (
          shown.map((th) => (
            <ThreadRow key={th.thread_id} thread={th} onOpen={() => onOpen(th)} />
          ))
        )}
      </div>

      {groupSheet.mounted && (
        <NewGroupSheet
          closing={groupSheet.closing}
          token={token}
          onClose={() => setCreating(false)}
          onCreated={(threadId) => {
            setCreating(false);
            load();
            onOpen({ thread_id: threadId, kind: "group" });
          }}
        />
      )}
    </div>
  );
}


/** One open conversation. Same bubbles and composer for the owner thread and
    for a group — the only difference is that a group names who spoke. */
function Conversation({ token, thread, restaurantName, onBack, onRead, onLeft }) {
  const { t, lang } = useLanguage();
  const confirm = useConfirm();
  const [meta, setMeta] = useState(thread);
  const [messages, setMessages] = useState(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const picker = usePhotoPicker();
  const scrollRef = useRef(null);
  // px the on-screen keyboard covers (web: visual viewport; Scheduler app:
  // the Keyboard plugin). The composer is position:fixed, and the shell's
  // Keyboard resize mode is "body", which never moves a fixed bar — so it sat
  // UNDER the keyboard and the staffer typed blind with Send out of reach.
  // Android: the WebView itself shrinks for the keyboard, so `kb` is 0 there
  // while `kbOpen` is true — the composer sits at the window's (= the
  // keyboard's) edge and is not lifted a second time (hooks/useKeyboardLift).
  const { lift: kb, open: kbOpen } = useKeyboardState();
  useEffect(() => {
    // Keyboard up → keep the newest message in sight above the composer.
    if (!kbOpen) return undefined;
    const pin = () => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; };
    pin();
    if (!platform.isAndroid) return undefined;
    // Android: the window shrinks a moment after the plugin's event — pin
    // again once the shorter stream is laid out.
    window.addEventListener("resize", pin);
    return () => window.removeEventListener("resize", pin);
  }, [kb, kbOpen]);
  const threadId = thread.thread_id;
  const isGroup = (meta?.kind || thread.kind) === "group";

  const load = useCallback(
    (markRead = true) => {
      portalApi
        .get(`/portal/${token}/chat/threads/${threadId}`)
        .then((res) => {
          setMeta((prev) => ({ ...prev, ...res.data }));
          setMessages(res.data.messages || []);
          if (markRead) onRead?.();
        })
        .catch(() => setMessages((prev) => prev || []));
    },
    [token, threadId, onRead],
  );

  useEffect(() => {
    load(true);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, 6000);
    return () => clearInterval(id);
  }, [load]);

  // Keep pinned to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const body = text.trim();
    const photoFiles = picker.files.map((f) => f.file);
    if ((!body && photoFiles.length === 0) || sending) return;
    setSending(true);
    const cmid =
      (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
      `c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const localPreviews = picker.files.map((f) => f.preview);
    const optimistic = {
      id: `tmp-${cmid}`,
      sender_type: "staff",
      mine: true,
      body: body || null,
      photo_count: photoFiles.length,
      _localPreviews: localPreviews,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages((prev) => [...(prev || []), optimistic]);
    setText("");
    picker.clear();
    try {
      let res;
      if (photoFiles.length > 0) {
        const fd = new FormData();
        if (body) fd.append("body", body);
        fd.append("client_msg_id", cmid);
        photoFiles.forEach((file) => fd.append("photos", file));
        res = await portalApi.post(`/portal/${token}/chat/threads/${threadId}/photos`, fd);
      } else {
        res = await portalApi.post(`/portal/${token}/chat/threads/${threadId}`, {
          body,
          client_msg_id: cmid,
        });
      }
      setMessages((prev) =>
        (prev || []).map((m) => (m.id === optimistic.id ? res.data : m)),
      );
    } catch {
      setMessages((prev) =>
        (prev || []).map((m) =>
          m.id === optimistic.id ? { ...m, _pending: false, _failed: true } : m,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  const leave = async () => {
    const ok = await confirm({
      title: t("staffChatLeaveTitle", "Leave this group?"),
      message: t(
        "staffChatLeaveBody",
        "You'll stop seeing new messages here. Your manager can add you back.",
      ),
      confirmLabel: t("staffChatLeaveConfirm", "Leave"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await portalApi.post(`/portal/${token}/chat/groups/${threadId}/leave`);
      onLeft?.();
    } catch {
      /* stays open — nothing was lost */
    }
  };

  const onKeyDown = (e) => {
    // Enter sends; Shift+Enter is a newline (desktop). On-screen keyboards
    // send via the button, so this only helps physical keyboards.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const memberCount = (meta?.member_ids || []).length;
  const sendOff = (!text.trim() && picker.files.length === 0) || sending;
  const heading = isGroup
    ? meta?.title || t("staffChatGroup", "Group")
    : restaurantName || t("staffChatOwnerLabel", "Manager");

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between" style={{ gap: 8, padding: "0 0 8px" }}>
        <button
          type="button"
          onClick={onBack}
          data-back-close=""
          data-testid="portal-chat-back"
          className={`flex items-center vp-press ${FOCUS_RING}`}
          style={{ gap: 6, minHeight: 44, margin: "0 0 0 -6px", padding: "0 8px 0 4px", borderRadius: 12, font: "600 14px/1 var(--font-text)", color: LINK }}
        >
          <ChevronLeft size={18} strokeWidth={2} aria-hidden />
          {t("staffChatAllConversations", "All conversations")}
        </button>
        {isGroup && (
          <button
            type="button"
            onClick={leave}
            className={`vp-press ${FOCUS_RING}`}
            style={{ minHeight: 44, padding: "0 6px", borderRadius: 12, font: "600 13px/1 var(--font-text)", color: MUTED }}
          >
            {t("staffChatLeave", "Leave")}
          </button>
        )}
      </div>

      <div style={{ marginBottom: 12, padding: "0 4px" }}>
        <h2 style={{ margin: 0, font: `700 19px/1.25 ${SORA}`, letterSpacing: "-0.015em", color: INK }}>
          {heading}
        </h2>
        <p style={{ margin: "4px 0 0", font: "400 13px/1.3 var(--font-text)", color: MUTED }}>
          {isGroup && memberCount
            ? t("staffChatMemberCount", "{n} people").replace("{n}", String(memberCount))
            : t("staffChatDirectSub", "Your manager")}
        </p>
      </div>

      {/* Message stream. Its bottom must stay above the floating composer:
          20rem is the chrome a browser has (header and title above, composer
          and dock below), and the app adds the notch and home-indicator
          insets to that. Without them, on an iPhone the stream ran ~80 px
          under the composer — the newest message of a longer group thread
          sat behind it with no scroll left to free it, and the page itself
          overflowed. Insets are 0 in a browser, so the web is unchanged.
          With the keyboard up the composer rides on the keyboard instead. */}
      <div
        ref={scrollRef}
        data-testid="portal-chat-stream"
        className="flex flex-col overflow-y-auto"
        style={{
          maxHeight: kbOpen
            // Android's edge-to-edge window keeps its status-bar inset while
            // the keyboard is up; iOS's shell has none (env is 0 there).
            ? `calc(100vh - 20rem${platform.isAndroid ? " - env(safe-area-inset-top, 0px)" : ""} - ${kb}px)`
            : "calc(100vh - 20rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))",
          gap: 10,
        }}
      >
        {messages === null ? (
          <div className="flex flex-col" style={{ gap: 8 }} data-testid="portal-skeleton">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className={`vp-shimmer ${i % 2 ? "w-2/3" : "w-1/2 ml-auto"}`}
                style={{ height: 40, borderRadius: 18, background: DIVIDER }}
              />
            ))}
          </div>
        ) : messages.length === 0 ? (
          <CalmEmpty icon={MessageSquare} testId="portal-chat-thread-empty">
            {isGroup
              ? t("staffChatGroupEmptyBody", "Say hello — everyone here will see it.")
              : t(
                  "staffChatEmptyBody",
                  "Send your manager a message — questions, running late, anything.",
                )}
          </CalmEmpty>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.mine ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-[80%] ${m.mine ? "items-end" : "items-start"} flex flex-col`}>
                {!m.mine && isGroup && (
                  <span data-testid="portal-chat-sender" style={{ font: "600 12px/1.2 var(--font-text)", color: MUTED, padding: "0 6px", marginBottom: 4 }}>
                    {/* In a group the sender is the point; in the owner thread
                        there is only one other party and naming them is noise. */}
                    {m.sender_type === "owner"
                      ? restaurantName || t("staffChatOwnerLabel", "Manager")
                      : m.sender_name || t("staffChatColleague", "Colleague")}
                  </span>
                )}
                {(m.photo_count > 0 || m._localPreviews) && (
                  <div className={m._pending ? "opacity-60" : ""}>
                    <PhotoGrid
                      client={portalApi}
                      photos={m.photos}
                      localPreviews={m._localPreviews}
                      {...PORTAL_PHOTO_LOOK}
                    />
                  </div>
                )}
                {m.body && (
                  <div
                    onClick={
                      m._failed
                        ? () => {
                            // Refill the composer so they can resend, drop the
                            // failed bubble — no silent retry, the staffer decides.
                            setText(m.body);
                            setMessages((prev) =>
                              (prev || []).filter((x) => x.id !== m.id),
                            );
                          }
                        : undefined
                    }
                    data-testid="portal-chat-bubble"
                    data-mine={m.mine ? "" : undefined}
                    className={`whitespace-pre-wrap break-words ${m._pending ? "opacity-60" : ""} ${m._failed ? "cursor-pointer" : ""}`}
                    style={{
                      padding: "10px 14px",
                      // Own words are pine with ivory text; everyone else's
                      // are the ivory card with its hairline.
                      borderRadius: m.mine ? "18px 18px 6px 18px" : "18px 18px 18px 6px",
                      font: "400 15px/1.45 var(--font-text)",
                      textWrap: "pretty",
                      background: m.mine ? PINE : CARD,
                      color: m.mine ? CREAM : INK,
                      border: m.mine ? `1px solid ${PINE}` : `1px solid ${LINE}`,
                      boxShadow: m._failed
                        ? `0 0 0 1.5px ${ALERT_INK}`
                        : m.mine ? "0 8px 18px -14px rgba(14,59,46,0.7)" : "none",
                    }}
                  >
                    {m.body}
                  </div>
                )}
                <span style={{ font: `${m._failed ? 600 : 500} 11px/1.2 var(--font-text)`, color: m._failed ? ALERT_INK : PLACEHOLDER, padding: "0 6px", marginTop: 4 }}>
                  {m._failed
                    ? t("staffChatFailed", "Not sent — tap to retry")
                    : m.created_at
                      ? formatTimeAgo(m.created_at, lang, t)
                      : ""}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Composer — fixed above the bottom nav, notch-aware; while the
          keyboard is up it rides on top of the keyboard instead. v3: it
          floats like the dock (12 px in, the dock's warm bar and shadow),
          8 px above it; the older bars keep the edge-to-edge glass bar. */}
      <div
        data-testid="portal-chat-composer"
        data-kb-skip=""
        className={BAR_V3
          ? "fixed z-20 m-0"
          : `fixed inset-x-0 z-20 glass border-t border-gray-200/70${BAR_V2 ? " bb-lg-composer" : ""}`}
        style={BAR_V3
          ? {
            bottom: kbOpen ? `${kb}px` : aboveDock(8),
            left: "max(12px, env(safe-area-inset-left, 0px))",
            right: "max(12px, env(safe-area-inset-right, 0px))",
            maxWidth: 560,
            marginLeft: "auto",
            marginRight: "auto",
            borderRadius: 26,
            background: "rgba(255, 253, 249, 0.97)",
            boxShadow: "inset 0 1px 0 #ffffffb3, 0 0 0 .5px #0c2a2014, 0 2px 5px #402e1814, 0 10px 22px -10px #402e1829",
          }
          : { bottom: kbOpen ? `${kb}px` : "calc(3.5rem + env(safe-area-inset-bottom))" }}
      >
        <div className={BAR_V3 ? "" : "max-w-lg mx-auto px-3 pt-2"} style={BAR_V3 ? { padding: 5 } : undefined}>
          {/* The shared photo kit in the portal's material: a 14 px thumb, a
              pine "×" (24 px, 44 px to tap) instead of the kit's navy dot. */}
          <PendingPhotos
            picker={picker}
            thumbStyle={{ borderRadius: 14, border: `1px solid ${LINE}` }}
            removeClassName="absolute -top-2 -right-2 flex items-center justify-center before:absolute before:-inset-[10px] before:content-['']"
            removeStyle={{ width: 24, height: 24, borderRadius: 999, background: PINE, color: CREAM }}
          />
          <div className={`${BAR_V3 ? "" : "pb-2 "}flex items-end`} style={{ gap: 6 }}>
            {/* 44 × 44 like send, muted ink, no hover fill (the kit's is a
                cool grey that sits wrong next to the pine send). */}
            <AttachButton
              picker={picker}
              label={t("staffChatAddPhoto", "Add photo")}
              className={`shrink-0 flex items-center justify-center vp-press ${picker.atMax ? "cursor-not-allowed" : "cursor-pointer"}`}
              style={{ width: 44, height: 44, borderRadius: 999, color: picker.atMax ? PLACEHOLDER : MUTED }}
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={t("staffChatPlaceholder", "Write a message…")}
              className="flex-1 min-w-0 resize-none max-h-28 outline-none border border-[#E8E3D8] focus:border-[#0E3B2E]/50 placeholder:text-[#8A948E]"
              style={{
                // 16px, not 12.5: iOS zooms the page on focus of any field
                // under 16px — and this inline font beat index.css's
                // coarse-pointer 16px rule. In the Scheduler app the page then
                // STAYED zoomed after the keyboard closed, clipping Send and
                // the tab bar until a force-quit. 44 tall: the send button's
                // height, so the row's two ends line up.
                minHeight: 44, padding: "11px 16px", borderRadius: 22,
                background: IVORY, boxSizing: "border-box",
                font: "400 16px/1.35 var(--font-text)", color: INK,
              }}
            />
            <button
              onClick={send}
              disabled={sendOff}
              aria-label={t("staffChatSend", "Send")}
              data-testid="portal-chat-send"
              className={`shrink-0 flex items-center justify-center vp-press ${FOCUS_RING}`}
              style={{
                width: 44, height: 44, borderRadius: 999,
                background: PINE, color: CREAM,
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 18px -12px rgba(14,59,46,0.8)",
                // Nothing to send: the one disabled look (BTN_OFF).
                ...(sendOff ? BTN_OFF : null),
              }}
            >
              <Send size={18} strokeWidth={1.9} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


function MessagesTab({ token, restaurantName, onRead }) {
  const [open, setOpen] = useState(null);
  return open ? (
    <Conversation
      token={token}
      thread={open}
      restaurantName={restaurantName}
      onBack={() => setOpen(null)}
      onLeft={() => setOpen(null)}
      onRead={onRead}
    />
  ) : (
    <ThreadListView token={token} onOpen={setOpen} onRead={onRead} />
  );
}


// ─── Loading skeleton ──────────────────────────────────────────────────────

// A list still loading (Byt's inbox, Fravær, the availability calendar):
// a few shimmer rows where the rows will be. The words stay for a screen
// reader (role=status), the blocks are only shapes.
function ListSkeleton({ label, rows = 3, height = 56 }) {
  return (
    <div role="status" className="flex flex-col gap-2" data-testid="portal-list-loading">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="vp-shimmer" style={{ height, borderRadius: 20, background: DIVIDER }} data-testid="portal-skeleton" />
      ))}
    </div>
  );
}

// Shimmer blocks (vagtplan.css .vp-shimmer): a sweep, no spinner, no pulse —
// warm ivory shapes, the ground's own tone.
function LoadingSkeleton() {
  return (
    <div className="flex flex-col" style={{ gap: 12 }} data-testid="portal-skeleton">
      <div className="grid grid-cols-2" style={{ gap: 12 }}>
        <div className="vp-shimmer" style={{ height: 80, borderRadius: 20, background: DIVIDER }} />
        <div className="vp-shimmer" style={{ height: 80, borderRadius: 20, background: DIVIDER }} />
      </div>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="vp-shimmer" style={{ height: 56, borderRadius: 18, background: DIVIDER }} />
      ))}
    </div>
  );
}


// ─── Error / Not Found ────────────────────────────────────────────────────

// `expected` marks the classified dead/expired-link case (see the token-
// validation catch). It is the difference between showing the staffer copy
// written for them in their own language and showing FastAPI's English.
function PortalError({ message, expected = false }) {
  const { t } = useLanguage();
  useStaffDocTitle(t("portalAppDocTitle", "BonBox Vagtplan"));
  return (
    <div className="min-h-screen bg-[#f5f7fb] flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <Link2Off className="w-8 h-8 text-gray-400 mb-3 mx-auto" strokeWidth={2} aria-hidden />
        <h1 className="text-xl font-bold text-gray-900 mb-2">{t("portalErrorTitle", "Link not working")}</h1>
        {/* Catalogue copy wins for the expected dead/expired link — it exists
            in real en+da and it tells the staffer what to DO ("ask your manager
            for a new one"), which a server status string never does. `message`
            is raw server English, so it only earns the slot when we could not
            classify the failure and it is the only clue available. */}
        <p className="text-sm text-gray-500">
          {expected || !message
            ? t("portalErrorBody", "This link may have expired or been deactivated. Ask your manager for a new one.")
            : message}
        </p>
        {/* Deliberately a raw <a>, NOT a react-router <Link>: this is the
            "link not working" screen for a dead/expired portal token, and the
            full document load is what discards that token and the portal's
            in-memory state. A soft navigation would carry the dead session
            into /join. Styled as the real button it is, with /join's verb. */}
        <a
          href="/join"
          className="mt-5 inline-flex items-center justify-center gap-2 min-h-[44px] px-6 rounded-xl bg-gray-900 text-white text-sm font-semibold vp-press"
        >
          <KeyRound className="w-4 h-4" strokeWidth={2.2} aria-hidden />
          {t("portalErrorJoinCta", "Connect with a code")}
        </a>
      </div>
    </div>
  );
}


/** The staff screens before a portal has loaded (opening, offline, dead link)
    carry the staff app's own tab / app-switcher title, not the owner app's
    marketing <title> from index.html. Restored on unmount. */
function useStaffDocTitle(title) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
}


/** Opening the portal. The retry interceptor can spend ~20 s on a cold
    server; a bare spinner that long reads as frozen, so after a few seconds
    it says what it is doing. (Offline fails at once — see portalApi.) */
function PortalOpening() {
  const { t } = useLanguage();
  useStaffDocTitle(t("portalAppDocTitle", "BonBox Vagtplan"));
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(id);
  }, []);
  // The home's own shape in shimmer (vagtplan.css), not a spinner: the
  // header row, the pine next-shift card, a row under it — so the real page
  // lands where the eye already is.
  return (
    <div className="min-h-screen flex flex-col items-center" style={{ background: IVORY }} data-testid="portal-opening">
      <div className="w-full max-w-lg px-3 min-[361px]:px-4" aria-hidden>
        <div className="flex items-center" style={{ height: 56, gap: 12, padding: "0 4px", marginTop: "env(safe-area-inset-top, 0px)" }}>
          <div className="vp-shimmer" style={{ width: 40, height: 40, borderRadius: 999, background: "#E7E3D8" }} />
          <div className="vp-shimmer" style={{ width: 150, height: 18, borderRadius: 8, background: "#E7E3D8" }} />
        </div>
        <div className="vp-shimmer vp-shimmer-dark" style={{ marginTop: 8, height: 212, borderRadius: 24, background: PINE }} />
        <div className="vp-shimmer" style={{ marginTop: 16, height: 56, borderRadius: 20, background: "#EEEAE0" }} />
      </div>
      <p role="status" className="mt-6 text-center text-[13px] max-w-xs min-h-[1.25rem] px-6" style={{ color: MUTED }}>
        {slow ? t("portalOpeningSlow", "Connecting to BonBox… this can take up to 20 seconds.") : ""}
      </p>
    </div>
  );
}


/** Opening the portal failed WITHOUT the server saying the link is dead.
    kind "offline": no answer at all (the phone's connection). kind "server":
    BonBox answered with trouble (5xx while it wakes, 429) — the phone IS
    online, so this must not blame it. Either way the saved link is kept, a
    retry runs by itself, and "Prøv igen" is there. Never shows axios's raw
    "Network Error". */
function PortalOffline({ onRetry, busy = false, kind = "offline" }) {
  const { t } = useLanguage();
  useStaffDocTitle(t("portalAppDocTitle", "BonBox Vagtplan"));
  const server = kind === "server";
  const Icon = server ? ServerCrash : CloudOff;
  return (
    <div className="min-h-screen bg-[#f5f7fb] flex items-center justify-center p-6">
      <div className="text-center max-w-xs" data-kind={kind}>
        <Icon className="w-8 h-8 text-gray-400 mb-3 mx-auto" strokeWidth={2} aria-hidden />
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          {server ? t("portalServerDownTitle", "The server isn't answering") : t("portalOfflineTitle", "No connection")}
        </h1>
        <p className="text-sm text-gray-500">
          {server
            ? t("portalServerDownBody", "It's on our side, not your phone. Your link is saved, and we'll try again on our own in a moment.")
            : t("portalOfflineBody", "We couldn't reach BonBox. Your link is saved — we'll try again as soon as you're online.")}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="mt-5 inline-flex items-center justify-center gap-2 min-h-[44px] px-6 rounded-xl bg-gray-900 text-white text-sm font-semibold vp-press disabled:opacity-60"
        >
          {busy && <RefreshCw className="w-4 h-4 animate-spin" strokeWidth={2.4} aria-hidden />}
          {busy ? t("portalOfflineRetrying", "Trying again…") : t("tryAgain", "Try again")}
        </button>
      </div>
    </div>
  );
}


// ─── Main Portal Page ─────────────────────────────────────────────────────

/** Group per-day absence rows into contiguous same-kind+status ranges, so a
    5-day ferie reads as one line, not five. */
function groupAbsence(rows) {
  const sorted = [...(rows || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const consecutive =
      last && last.kind === r.kind && last.status === r.status &&
      new Date(r.date) - new Date(last.endDate) === 86400000;
    if (consecutive) { last.endDate = r.date; last.ids.push(r.id); }
    else out.push({ kind: r.kind, status: r.status, reason: r.reason, startDate: r.date, endDate: r.date, ids: [r.id] });
  }
  return out;
}

/**
 * AbsenceSection — staff registers Fravær (ferie / a sick period) over a date
 * range; the owner sees + approves. Tracking only, no pay. Lives inside the
 * "Kan ikke" tab (the staffer's "when I'm off" home) so it's not an 8th nav tab.
 */
/** A date field that fits its grid cell on iOS WebKit. The native control has
    an intrinsic minimum width, so two of them side by side ran into each other
    and past the card edge; min-width 0 + border-box + no native appearance
    lets the cell decide. An empty iOS date input shows nothing at all, so the
    placeholder says what tapping it does — on iOS, and in the Android app
    (its WebView draws an empty box too: Android walk, 11 Nov 2026). Not in a
    desktop browser: Chrome and Firefox draw their own "dd.mm.åååå" there, and
    the hint would be printed on top of it. */
function DateField({ label, value, onChange, min, max, testId }) {
  const { t } = useLanguage();
  const showHint = !value && typeof window !== "undefined" && (window.__BONBOX_IS_IOS === true || platform.isAndroid);
  return (
    <label className="block min-w-0">
      <span style={FIELD_LABEL}>{label}</span>
      <span className="relative block min-w-0">
        <input
          type="date"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
          className={`${FIELD_CLS} text-left`}
          style={{ ...FIELD, minWidth: 0, maxWidth: "100%", boxSizing: "border-box", WebkitAppearance: "none", appearance: "none" }}
        />
        {showHint && (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 flex items-center" style={{ left: 14, font: "400 16px/1 var(--font-text)", color: PLACEHOLDER }}>
            {t("portalPickDate", "Pick a date")}
          </span>
        )}
      </span>
    </label>
  );
}

function AbsenceSection({ token, onChanged }) {
  const { t, lang } = useLanguage();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);
  // The form opens at the bottom of a long tab, under the bottom nav — bring
  // it into view so Ferie/Andet, the dates AND Send are on screen.
  const formRef = useRef(null);
  useEffect(() => {
    if (!adding) return;
    const id = setTimeout(() => {
      formRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }, 30);
    return () => clearTimeout(id);
  }, [adding]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState("ferie");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  const load = async () => {
    setLoadFailed(false);
    try {
      const res = await portalApi.get(`/portal/${token}/absence`);
      // `status` is the stored value; the owner's decline is the separate
      // `declined` flag (a new status value would read as "Afventer" in
      // installed apps that bundle older code). Fold it in here so grouping
      // and the chip see "declined" → "Afvist".
      setRows((res.data?.absence || []).map((a) => (
        a.status === "cancelled" && a.declined ? { ...a, status: "declined" } : a
      )));
    } catch {
      // Keep whatever was last loaded and say the refresh failed. Clearing to
      // [] rendered "no absence registered" to a staffer who HAS booked
      // ferie — their own record, reported as empty because a request
      // dropped.
      setLoadFailed(true);
    }
  };
  useEffect(() => { load(); }, [token]);

  const KIND_LABEL = {
    ferie: t("fravaerFerie", "Holiday"),
    sick: t("fravaerSyg", "Sick"),
    barns_syg: t("fravaerBarns", "Child's sick day"),
    andet: t("fravaerAndet", "Other"),
  };
  // Sygdom is REGISTERED; ferie is REQUESTED. GET /portal/{token}/absence has no
  // kind filter (staff_portal.py ~2382 — staff_id + user_id + date only), so a
  // sick call made on the Schedule tab has always rendered in this list too. It
  // arrives status="pending" and was therefore labelled with an amber
  // "Afventer" under a heading reading "kræver godkendelse" — while the Schedule
  // tab told the same staffer "Sygemelding registreret" about the same row.
  // One row, two opposite stories. Nobody applies for permission to be ill.
  const isNotifyKind = (k) => k === "sick" || k === "barns_syg";
  // The chips speak the calendar's colours: brass = waiting on the manager,
  // pine-on-sage = approved, terracotta = the manager said no, a quiet tile
  // for a fact (registered) or a withdrawal.
  const REGISTERED = { label: t("fravaerStatusRegistered", "Registered"), bg: TILE, fg: MUTED };
  const STATUS = {
    pending: { label: t("fravaerStatusPending", "Pending"), bg: BRASS_WASH, fg: BRASS_INK },
    acknowledged: { label: t("fravaerStatusApproved", "Approved"), bg: SOFT, fg: PINE },
    covered: { label: t("fravaerStatusApproved", "Approved"), bg: SOFT, fg: PINE },
    cancelled: { label: t("fravaerStatusCancelled", "Cancelled"), bg: TILE, fg: MUTED },
    // The owner said no. Stored as 'cancelled' like a withdrawal; the portal
    // API flags it (`declined`, staff_portal._portal_absence_declined) and
    // load() folds that into this key.
    declined: { label: t("fravaerStatusDeclined", "Declined"), bg: RED_WASH, fg: RED_INK },
  };

  const fmtRange = (s, e) => {
    const opt = { day: "numeric", month: "short" };
    const a = new Date(s + "T00:00:00").toLocaleDateString(localeFor(lang), opt);
    if (s === e) return a;
    const b = new Date(e + "T00:00:00").toLocaleDateString(localeFor(lang), opt);
    return `${a} – ${b}`;
  };

  const reset = () => { setKind("ferie"); setFrom(""); setTo(""); setReason(""); setErr(""); };

  const submit = async () => {
    setErr("");
    if (!from) { setErr(t("fravaerPickDate", "Pick a start date")); return; }
    if (to && to < from) { setErr(t("kanIkkeEndAfterStart", "End must be after start")); return; }
    setSaving(true);
    try {
      const body = { kind, date_from: from };
      if (to) body.date_to = to;
      if (reason.trim()) body.reason = reason.trim();
      await portalApi.post(`/portal/${token}/absence`, body);
      reset(); setAdding(false); await load(); onChanged?.();
    } catch {
      setErr(t("fravaerSaveFailed", "Couldn't send — try again"));
    } finally { setSaving(false); }
  };

  const withdraw = async (g) => {
    try {
      await portalApi.post(`/portal/${token}/absence/withdraw`, { ids: g.ids });
      await load(); onChanged?.();
    } catch {
      setErr(t("fravaerWithdrawFailed", "Couldn't withdraw — try again"));
    }
  };

  const groups = groupAbsence(rows);

  return (
    <div className="flex flex-col" style={{ gap: 12 }} data-testid="fravaer-section">
      {/* Neutral heading. This list holds BOTH kinds — GET /absence has no kind
          filter (staff_portal.py ~2382), so a Schedule-tab sygemelding lands
          here too — and labelling the whole section "needs approval" put those
          words directly above a row chipped "Registered". Each row carries its
          own truth now: brass Afventer for a request, a quiet Registreret for a
          sick day. The approval sentence moved to the button it describes. */}
      <HomeH2 style={{ padding: "0 4px" }}>{t("fravaerHeadingNeutral", "Holiday and time off")}</HomeH2>

      {loadFailed && rows === null ? (
        <p style={{ margin: "0 4px", font: "400 13px/1.4 var(--font-text)", color: MUTED }}>
          {t("portalAbsenceLoadFailed", "Couldn't load your absence — pull to refresh or try again in a moment.")}
        </p>
      ) : rows === null ? (
        <ListSkeleton label={t("portalLoading", "Loading…")} rows={2} height={60} />
      ) : groups.length > 0 ? (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {groups.map((g) => {
            // A sygemelding is a fact, not an application, so it never wears
            // the brass "Afventer". Cancelled / declined still show for both
            // kinds — those ARE real state changes (the staffer's, or the
            // manager's).
            const st = isNotifyKind(g.kind) && g.status !== "cancelled" && g.status !== "declined"
              ? REGISTERED
              : (STATUS[g.status] || STATUS.pending);
            return (
              <div
                key={g.ids[0]}
                data-testid="fravaer-row"
                className="flex items-center"
                style={{ gap: 12, padding: "10px 10px 10px 12px", minHeight: 64, borderRadius: 20, ...CARD_BOX }}
              >
                <span className="shrink-0 flex items-center justify-center" style={{ width: 40, height: 40, borderRadius: 12, background: SOFT, color: PINE }}>
                  <CalendarPlus size={18} strokeWidth={1.9} aria-hidden />
                </span>
                {/* Three short lines, so the DATES are never the part that
                    gets cut: at 360 px "Ferie · 23. nov. –…" lost the very
                    thing the row is about. The kind may truncate, the reason
                    may truncate; the range does not wrap or clip. The chip
                    sits under them, so only "Fortryd" shares the row. */}
                <div className="min-w-0 flex-1 flex flex-col items-start" style={{ gap: 3 }}>
                  <span className="truncate max-w-full" style={{ font: `600 15px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>
                    {KIND_LABEL[g.kind] || g.kind}
                  </span>
                  <span data-testid="fravaer-row-dates" className="flex max-w-full" style={{ font: "400 13px/1.3 var(--font-text)", color: MUTED }}>
                    <span className="tabular-nums" style={{ whiteSpace: "nowrap", color: INK }}>{fmtRange(g.startDate, g.endDate)}</span>
                    {g.reason && <span className="truncate min-w-0">{"\u00a0· "}{g.reason}</span>}
                  </span>
                  <span
                    data-testid="fravaer-status"
                    style={{ marginTop: 3, padding: "5px 10px", borderRadius: 999, background: st.bg, color: st.fg, font: "600 12px/1 var(--font-text)" }}
                  >
                    {st.label}
                  </span>
                </div>
                {g.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => withdraw(g)}
                    className={`shrink-0 min-h-[44px] inline-flex items-center vp-press ${FOCUS_RING}`}
                    style={{ padding: "0 14px", borderRadius: 999, ...CARD_BOX, color: INK, font: "600 13px/1 var(--font-text)" }}
                  >
                    {isNotifyKind(g.kind)
                      ? t("fravaerUndo", "Undo")
                      : t("fravaerWithdraw", "Withdraw")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {!adding ? (
        <div>
          {/* Sage: a secondary action on this screen — the calendar above is
              the everyday errand, a time-off request the rarer one. */}
          <button
            type="button"
            onClick={() => { reset(); setAdding(true); }}
            data-testid="fravaer-add"
            className={`w-full flex items-center justify-center vp-press ${FOCUS_RING}`}
            style={{ ...BTN_SAGE, ...BTN_FULL, gap: 8 }}
          >
            <CalendarPlus size={18} strokeWidth={1.9} aria-hidden />
            {t("fravaerAdd", "Request time off")}
          </button>
          <p style={{ margin: "8px 4px 0", font: "400 13px/1.4 var(--font-text)", color: MUTED }}>
            {t("fravaerNeedsApprovalSub", "This is a request — your manager approves it. You'll see Pending, then Approved or Declined.")}
          </p>
        </div>
      ) : (
        <div
          ref={formRef}
          data-kb-block=""
          data-testid="fravaer-form"
          className="flex flex-col"
          // The scroller's scroll-padding already clears the sticky header and
          // the tab bar (home v3); these are just a little air on top of it.
          style={{ gap: 14, padding: 16, borderRadius: 24, ...CARD_BOX, scrollMarginTop: 32, scrollMarginBottom: 8 }}
        >
          {/* Sygdom deliberately absent: this form's banner promises manager
              approval, and that is a lie for a sick day. Sick lives on the
              Schedule tab, which notifies the owner and binds the shift —
              register_absence does neither. VALID_ABSENCE_KINDS still accepts
              "sick" server-side so an un-updated App Store bundle keeps
              working; only this picker stops creating them. */}
          <VpSegmented
            testId="fravaer-kind"
            options={["ferie", "andet"].map((k) => ({ key: k, label: KIND_LABEL[k] }))}
            value={kind}
            onChange={setKind}
          />
          <div className="grid grid-cols-2" style={{ gap: 10 }}>
            <DateField label={t("fravaerFrom", "From")} value={from} onChange={setFrom} testId="fravaer-from" />
            <DateField label={t("fravaerTo", "To (optional)")} value={to} min={from || undefined} onChange={setTo} testId="fravaer-to" />
          </div>
          <input
            type="text" value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)}
            placeholder={t("fravaerNotePlaceholder", "Note (optional)")}
            className={FIELD_CLS}
            style={FIELD}
          />
          <VpNote>{t("fravaerNeedsApproval", "This is a request — your manager must approve it.")}</VpNote>
          {err && <VpAlert>{err}</VpAlert>}
          {/* Stacked, never side by side: "Send anmodning" wrapped to two
              lines in half a row at 390 px. The send is the form's one pine
              action, full width; cancel is the quiet text line under it
              (PeriodSheet's "Tilbage til min lønperiode"). */}
          <div className="flex flex-col" style={{ gap: 4 }}>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              data-testid="fravaer-submit"
              className={`w-full vp-press ${FOCUS_RING}`}
              style={pineBtn(saving, BTN_FULL)}
            >
              {saving ? t("portalSaving", "Saving…") : t("fravaerSubmit", "Send request")}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); reset(); }}
              data-back-close=""
              data-testid="fravaer-cancel"
              className={`w-full vp-press ${FOCUS_RING}`}
              style={BTN_TEXT}
            >
              {t("portalCancel", "Cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* One vocabulary for both Fravær calendars and their legend (the system note
   above the Hours tab): terracotta = kan ikke, a dashed terracotta edge = the
   same every week, sage = helst, brass = a request waiting on the manager,
   pine = approved time off. A free day is the home's shift-row tile. Every
   look carries a 1 px border (dashed for weekly) so no state changes a
   cell's size. Today wears the home's pine outline, on top of any look. */
const DAY_LOOK = {
  free: { background: ROW, border: `1px solid ${ROW}`, color: INK },
  cant: { background: RED_WASH, border: `1px solid ${RED_EDGE}`, color: RED_INK },
  weekly: { background: ROW, border: `1.5px dashed ${RED_EDGE}`, color: RED_INK },
  pref: { background: SOFT, border: `1px solid ${SAGE_EDGE}`, color: PINE },
  pending: { background: BRASS_WASH, border: `1px solid ${BRASS_EDGE}`, color: BRASS_INK },
  approved: { background: PINE, border: `1px solid ${PINE}`, color: CREAM },
};
const TODAY_RING = `inset 0 0 0 1.5px ${PINE}`;
const PAST_INK = "#B9B3A6";

/* ═══════════════════════════════════════════════════════════════
   MonthCalendar — tappable "when I'm off" month grid. Pure presentation:
   the parent owns the data + tap handler. LOCAL dates only (toLocalISO /
   addDays), Monday-first ((getDay()+6)%7), 42 fixed cells so the block never
   reflows or scrolls internally (in-flow only — protects the iOS wobble fix).
   ═══════════════════════════════════════════════════════════════ */
function MonthCalendar({
  viewYear, viewMonth, onPrev, onNext, onToday, showToday,
  oneOffByDate, recurringSet, absenceByDate, shiftSet, savingSet,
  onTapDay, lang, t,
}) {
  const WD = useMemo(() => weekdayNames(lang), [lang]);
  // Under 360 px the columns are ~36 px wide: the grid gives up its gaps and
  // the card its side padding before any cell is allowed to overlap the next.
  const narrow = useNarrowPhone();
  const todayIso = toLocalISO(new Date());
  const monthLabel = new Date(viewYear, viewMonth, 1)
    .toLocaleDateString(localeFor(lang), { month: "long", year: "numeric" });

  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const lead = (first.getDay() + 6) % 7; // Monday = 0
    const startIso = addDays(toLocalISO(first), -lead);
    return Array.from({ length: 42 }, (_, i) => addDays(startIso, i));
  }, [viewYear, viewMonth]);

  return (
    <section data-testid="kanikke-month" style={{ ...CARD_BOX, borderRadius: 24, padding: narrow ? "14px 6px 12px" : "14px 10px 12px" }}>
      {/* Month nav — mutates view only, never data */}
      <div className="flex items-center justify-between" style={{ gap: 8, padding: "0 4px" }}>
        <PageArrow dir="prev" onClick={onPrev} label={t("kanIkkePrevMonth", "Previous month")} />
        <div className="flex items-center min-w-0" style={{ gap: 8 }}>
          <span className="truncate capitalize" style={{ font: `700 16px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>{monthLabel}</span>
          {showToday && (
            // The home's "I dag" pill; the ::before makes its hit area 44 tall.
            <button
              type="button"
              onClick={onToday}
              className="relative shrink-0 before:absolute before:-inset-x-2 before:-inset-y-[13px] before:content-['']"
              style={{ minHeight: 0, padding: "3px 8px", borderRadius: 999, background: SOFT, color: PINE, font: "600 11px/1 var(--font-text)" }}
            >
              {t("calToday", "Today")}
            </button>
          )}
        </div>
        <PageArrow dir="next" onClick={onNext} label={t("kanIkkeNextMonth", "Next month")} />
      </div>

      {/* Weekday header (Monday-first, localized) */}
      <div className="grid grid-cols-7" style={{ marginTop: 10, marginBottom: 4 }}>
        {WD.map((w, i) => (
          <div key={i} className="text-center" style={{ padding: "4px 0", font: "600 11px/1 var(--font-text)", letterSpacing: "0.06em", textTransform: "uppercase", color: MUTED }}>
            {String(w).replace(/\.$/, "")}
          </div>
        ))}
      </div>

      {/* 6×7 day grid. The COLUMN decides a cell's width and the cell is
          44 tall: aspect-square + min-h-44 forced 44×44 squares into 36 px
          columns at 320, and neighbours ran into each other. */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: narrow ? 2 : 4 }}>
        {cells.map((iso) => {
          const cellDate = new Date(iso + "T00:00:00");
          const inMonth = cellDate.getMonth() === viewMonth;
          const dayNum = cellDate.getDate();
          if (!inMonth) {
            return (
              <div key={iso} aria-hidden className="w-full flex items-center justify-center tabular-nums select-none" style={{ height: 44, minWidth: 0, font: `600 15px/1 ${SORA}`, color: "#CBC5B8" }}>
                {dayNum}
              </div>
            );
          }
          const past = isPast(iso);
          const today = iso === todayIso;
          const wd = (cellDate.getDay() + 6) % 7;
          const abs = absenceByDate[iso];        // { status, kind }
          const oneOff = oneOffByDate[iso];       // { id, timed, ... }
          const recurring = recurringSet.has(wd);
          const hasShift = shiftSet.has(iso);
          const saving = savingSet.has(iso);
          const approved = abs && (abs.status === "acknowledged" || abs.status === "covered");
          const pending = abs && abs.status === "pending";

          // Exactly ONE look — precedence: approved > pending > one-off >
          // recurring > free. "Can't work" is terracotta with the date STRUCK
          // THROUGH (unambiguous at a glance); "helst" is sage and NOT struck —
          // the day is still workable, which is the whole difference. The
          // manager-answer states (approved / pending) are not tappable here:
          // that day belongs to the approval flow.
          const kind = approved ? "approved"
            : pending ? "pending"
              : oneOff ? (oneOff.kind === "preferred" ? "pref" : "cant")
                : recurring ? "weekly" : "free";
          const look = DAY_LOOK[kind];
          const tappable = !past && !approved && !pending;
          const strike = kind === "cant" && !past;
          const cellStyle = {
            ...look,
            // History stays quiet: a past free day is just a faded number, a
            // past mark keeps its colour at 40 %.
            ...(past && kind === "free" ? { background: "transparent", border: "1px solid transparent", color: PAST_INK } : null),
            opacity: past && kind !== "free" ? 0.4 : saving ? 0.6 : 1,
            boxShadow: today && kind !== "approved" ? TODAY_RING : "none",
            font: `${today ? 700 : 600} 15px/1 ${SORA}`,
            boxSizing: "border-box",
            cursor: tappable ? "pointer" : "default",
          };

          return (
            <button
              key={iso}
              type="button"
              disabled={!tappable || saving}
              aria-disabled={!tappable}
              aria-current={today ? "date" : undefined}
              aria-label={iso}
              data-look={kind}
              onClick={() => tappable && onTapDay(iso, { oneOff, recurring, abs, wd })}
              className={`relative w-full flex items-center justify-center tabular-nums ${tappable ? "vp-press" : ""} ${FOCUS_RING}`}
              style={{ height: 44, minWidth: 0, padding: 0, borderRadius: 12, ...cellStyle }}
            >
              <span style={strike ? { textDecoration: "line-through", textDecorationThickness: "1.5px" } : undefined}>
                {dayNum}
              </span>
              {recurring && !oneOff && !abs && (
                <Repeat className="absolute" style={{ top: 3, right: 3, width: 10, height: 10, color: RED_INK }} strokeWidth={2.5} aria-hidden />
              )}
              {oneOff?.timed && (
                <Clock className="absolute" style={{ bottom: 3, left: 3, width: 10, height: 10, color: look.color }} strokeWidth={2.5} aria-hidden />
              )}
              {/* Approved: solid pine reads as "selected" everywhere else on
                  this screen, so it carries a mark colour alone cannot — a
                  cream tick, in the spot the Repeat glyph uses. */}
              {approved && (
                <Check data-testid="kanikke-approved-mark" className="absolute" style={{ top: 3, right: 3, width: 10, height: 10, color: CREAM }} strokeWidth={2.5} aria-hidden />
              )}
              {/* The rostered dot: pine, or cream on an approved (pine) day —
                  brass means "Afventer" on this screen. */}
              {hasShift && (
                <span className="absolute left-1/2 -translate-x-1/2" style={{ bottom: 4, width: 4, height: 4, borderRadius: 99, background: approved ? CREAM : PINE }} aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* MarkedDayRow — one one-off "Kan ikke" / "Helst" date; expands to set a
   time-window / note (DELETE+POST since the backend has no PATCH). An ivory
   card; its well says which kind it is in the calendar's colour. */
function MarkedDayRow({ row, label, expanded, onToggle, onRemove, onSave, t }) {
  const [allDay, setAllDay] = useState(!row.timed);
  const [start, setStart] = useState(row.start || "08:00");
  const [end, setEnd] = useState(row.end || "12:00");
  const [note, setNote] = useState(row.note || "");
  const pref = row.kind === "preferred";
  const timeText = row.timed ? `${row.start}–${row.end}` : t("kanIkkeAllDay", "All day");
  return (
    <div data-testid="kanikke-marked-row" style={{ borderRadius: 20, ...CARD_BOX }}>
      <div className="flex items-center" style={{ gap: 12, padding: "10px 6px 10px 12px" }}>
        <span
          className="shrink-0 flex items-center justify-center"
          style={{ width: 40, height: 40, borderRadius: 12, background: pref ? SOFT : RED_WASH, color: pref ? PINE : RED_INK }}
        >
          {pref
            ? <CalendarCheck size={18} strokeWidth={1.9} aria-hidden />
            : <CalendarOff size={18} strokeWidth={1.9} aria-hidden />}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={`min-w-0 flex-1 text-left flex flex-col ${FOCUS_RING}`}
          style={{ gap: 2, borderRadius: 10 }}
        >
          <span className="truncate tabular-nums" style={{ font: `600 15px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>{label}</span>
          <span className="truncate" style={{ font: "400 13px/1.3 var(--font-text)", color: MUTED }}>
            {/* A day that already has hours only lacks the note. */}
            {timeText}{row.note ? ` · ${row.note}` : row.timed ? ` · ${t("kanIkkeAddNote", "Add a note")}` : ` · ${t("kanIkkeAddTimeNote", "Add a time / note")}`}
          </span>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("kanIkkeRemove", "Remove")}
          className={`shrink-0 flex items-center justify-center vp-press ${FOCUS_RING}`}
          style={{ width: 44, height: 44, borderRadius: 999, color: MUTED }}
        >
          <X size={18} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col" style={{ gap: 12, padding: "12px 14px 14px", borderTop: `1px solid ${DIVIDER}` }}>
          <label className="flex items-center justify-between cursor-pointer" style={{ gap: 12 }}>
            <span style={{ font: "500 14px/1.3 var(--font-text)", color: INK }}>{t("kanIkkeAllDay", "All day")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={allDay}
              onClick={() => setAllDay(!allDay)}
              className={`relative shrink-0 ${FOCUS_RING}`}
              style={{ width: 46, height: 28, borderRadius: 999, background: allDay ? PINE : GRAB, transition: "background-color var(--dur-fast) var(--ease-out)" }}
            >
              <span
                aria-hidden
                className="absolute"
                style={{
                  top: 3, left: 3, width: 22, height: 22, borderRadius: 999, background: "#FFFFFF",
                  boxShadow: "0 1px 3px rgba(8,24,18,0.3)",
                  transform: allDay ? "translateX(18px)" : "none",
                  transition: "transform var(--dur-base) var(--spring-soft)",
                }}
              />
            </button>
          </label>
          {!allDay && (
            <div className="flex items-center" style={{ gap: 8 }}>
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`${FIELD_CLS} flex-1`} style={FIELD} />
              <span aria-hidden style={{ color: MUTED }}>–</span>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`${FIELD_CLS} flex-1`} style={FIELD} />
            </div>
          )}
          <input
            type="text" value={note} maxLength={80} onChange={(e) => setNote(e.target.value)}
            placeholder={t("kanIkkeNotePlaceholder", "Note (optional) — e.g. exam")}
            className={FIELD_CLS}
            style={FIELD}
          />
          <button
            type="button"
            onClick={() => onSave(allDay, start, end, note)}
            className={`w-full vp-press ${FOCUS_RING}`}
            style={BTN_PINE}
          >
            {t("kanIkkeSave", "Save")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * AvailabilityTab — the staff "when I'm off" surface. A tappable month calendar
 * to mark the days you can't work (a SOFT signal — the owner sees it, the
 * autopilot respects it, it's never a hard block), plus the Fravær request
 * (ferie/sygdom) the owner APPROVES. One calm view over the existing
 * availability + absence endpoints; nothing here is cosmetic.
 */
/**
 * The fast surface: seven cells, one tap each — the home week strip's shape
 * (weekday over a Sora date, a marker row under it) in the calendar's
 * vocabulary (DAY_LOOK). A day already governed by an absence request is NOT
 * tappable here, exactly as in the month view: that day belongs to the
 * approval flow, and a soft tap must not look like it can override it.
 */
function WeekStrip({ weekOffset, onShiftWeek, oneOffByDate, recurringSet, absenceByDate, shiftSet, savingSet, onTapDay, lang, t }) {
  const days = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const monday = new Date(base);
    monday.setDate(base.getDate() - ((base.getDay() + 6) % 7) + weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, [weekOffset]);

  const iso = (d) => d.toLocaleDateString("sv-SE");
  const todayISO = new Date().toLocaleDateString("sv-SE");
  // The home week card's words for the same week ("9–15 November" /
  // "9.–15. november"), not a second spelling ("9 Nov – 15 Nov").
  const range = fmtWeekRange(iso(days[0]), lang);
  const markedThisWeek = days.filter((d) => oneOffByDate[iso(d)]).length;

  return (
    <section data-testid="kanikke-week" style={{ ...CARD_BOX, borderRadius: 24, padding: "14px 12px" }}>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <PageArrow dir="prev" onClick={() => onShiftWeek(weekOffset - 1)} label={t("portalPrevWeek", "Previous week")} />
        <span className="min-w-0 truncate text-center tabular-nums" style={{ font: `700 16px/1.25 ${SORA}`, letterSpacing: "-0.01em", color: INK }}>
          {range}
        </span>
        <PageArrow dir="next" onClick={() => onShiftWeek(weekOffset + 1)} label={t("portalNextWeek", "Next week")} />
      </div>

      <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
        {days.map((d) => {
          const key = iso(d);
          const one = oneOffByDate[key];
          const abs = absenceByDate[key];
          const recurring = !one && recurringSet.has((d.getDay() + 6) % 7);
          const past = key < todayISO;
          const saving = savingSet.has(key);
          const pref = one?.kind === "preferred";
          const rostered = shiftSet?.has(key);
          const ok = abs && (abs.status === "acknowledged" || abs.status === "covered");
          const kind = abs ? (ok ? "approved" : "pending")
            : one ? (pref ? "pref" : "cant")
              : recurring ? "weekly" : "free";
          const look = DAY_LOOK[kind];
          const isTodayCell = key === todayISO;

          const locked = !!abs || past;
          return (
            <button
              key={key}
              type="button"
              disabled={locked || saving}
              onClick={() => onTapDay(key, { oneOff: one, abs, recurring, wd: (d.getDay() + 6) % 7 })}
              aria-pressed={!locked ? !!one : undefined}
              aria-current={isTodayCell ? "date" : undefined}
              aria-label={[
                d.toLocaleDateString(localeFor(lang), { weekday: "long", day: "numeric", month: "long" }),
                abs ? (ok ? t("legendApproved", "Approved time off") : t("legendPending", "Pending"))
                  : one?.kind === "preferred" ? t("legendPreferred", "Preferred")
                  : one ? t("legendCantWork", "Can't work")
                  : recurring ? t("legendRepeats", "Every week")
                  : null,
                rostered ? t("legendScheduled", "Scheduled") : null,
              ].filter(Boolean).join(" — ")}
              data-look={kind}
              className={`min-w-0 flex flex-col items-center justify-center ${locked ? "" : "vp-press"} ${FOCUS_RING}`}
              style={{
                height: 68, gap: 4, padding: 0, borderRadius: 14, boxSizing: "border-box",
                ...look,
                boxShadow: isTodayCell && kind !== "approved" ? TODAY_RING : "none",
                opacity: past ? 0.4 : saving ? 0.6 : 1,
                cursor: locked ? "default" : "pointer",
              }}
            >
              <span style={{ font: "500 11px/1 var(--font-text)", color: kind === "free" ? MUTED : kind === "approved" ? SAGE : look.color }}>
                {String(wdShort(d, lang)).replace(/\.$/, "")}
              </span>
              <span
                className="tabular-nums"
                style={{
                  font: `700 17px/1 ${SORA}`,
                  textDecoration: kind === "cant" ? "line-through" : "none",
                  textDecorationThickness: kind === "cant" ? "1.5px" : undefined,
                }}
              >
                {d.getDate()}
              </span>
              {/* The marker row. A rostered day carries its dot whatever it is
                  marked: marking "kan ikke" on a day you already work does NOT
                  release it, and this strip is where that mistake gets made.
                  A weekly rule and a timed window are states colour alone
                  cannot carry, so they get their own small marks. */}
              <span aria-hidden className="flex items-center justify-center" style={{ height: 10, gap: 3 }}>
                {recurring && !one && <Repeat style={{ width: 10, height: 10, color: RED_INK }} strokeWidth={2.5} />}
                {one?.timed && <Clock style={{ width: 10, height: 10, color: look.color }} strokeWidth={2.5} />}
                {kind === "approved" && <Check data-testid="kanikke-approved-mark" style={{ width: 10, height: 10, color: CREAM }} strokeWidth={2.5} />}
                {rostered && <span data-testid="kanikke-rostered-dot" style={{ width: 6, height: 6, borderRadius: 99, background: kind === "approved" ? CREAM : PINE }} />}
              </span>
            </button>
          );
        })}
      </div>

      <div
        data-testid="kanikke-week-count"
        style={{ marginTop: 12, padding: "12px 4px 0", borderTop: `1px solid ${DIVIDER}`, font: "500 13px/1.3 var(--font-text)", color: markedThisWeek ? INK : MUTED }}
      >
        {markedThisWeek
          ? t("kanIkkeMarkedCount", "{n} marked this week").split("{n}").join(String(markedThisWeek))
          : t("kanIkkeNothingMarked", "Nothing marked this week")}
      </div>
    </section>
  );
}

function AvailabilityTab({ token, shifts, onNavigate }) {
  const { t, lang } = useLanguage();
  const [avail, setAvail] = useState(null);     // null = loading
  const [absence, setAbsence] = useState([]);
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [savingSet, setSavingSet] = useState(() => new Set());
  const [recurOpen, setRecurOpen] = useState(false);
  const [expandedDate, setExpandedDate] = useState(null);
  const [confirmWeekday, setConfirmWeekday] = useState(null); // { wd }
  const [confirmRostered, setConfirmRostered] = useState(null); // { iso }
  // Both confirms play their exit (sheetMotion.js) with the day they were
  // about: the state is already null by then.
  const rosteredSheet = usePresence(!!confirmRostered);
  const rosteredShown = useLastValue(confirmRostered);
  const weekdaySheet = usePresence(!!confirmWeekday);
  const weekdayShown = useLastValue(confirmWeekday);
  // Which kind a tap writes. "unavailable" is the default because it is the one
  // that actually constrains the roster; "preferred" is a soft signal.
  const [mode, setMode] = useState("unavailable");
  // Collapsed by default: marking the next few days is the common errand, and a
  // 7-cell strip makes it one tap with no month to scan. The month is one tap
  // away for anything further out — collapsing must not cost reach.
  const [calOpen, setCalOpen] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);   // 0 = the week containing today
  const [err, setErr] = useState("");

  const loadAvail = async () => {
    try { const r = await portalApi.get(`/portal/${token}/availability`); setAvail(r.data?.availability || []); }
    catch { setAvail([]); }
  };
  const loadAbsence = async () => {
    try { const r = await portalApi.get(`/portal/${token}/absence`); setAbsence(r.data?.absence || []); }
    catch { setAbsence([]); }
  };
  useEffect(() => { loadAvail(); loadAbsence(); }, [token]);

  const WD = useMemo(() => weekdayNames(lang), [lang]);

  const oneOffByDate = useMemo(() => {
    const m = {};
    (avail || []).forEach((a) => {
      if (a.date) {
        m[a.date] = {
          id: a.id, timed: !!a.start_time, start: a.start_time, end: a.end_time, note: a.note,
          kind: a.kind === "preferred" ? "preferred" : "unavailable",
        };
      }
    });
    return m;
  }, [avail]);
  const recurringByWeekday = useMemo(() => {
    const m = new Map();
    (avail || []).forEach((a) => {
      if (a.date == null && a.weekday != null) {
        m.set(a.weekday, { id: a.id, kind: a.kind === "preferred" ? "preferred" : "unavailable" });
      }
    });
    return m;
  }, [avail]);
  const recurringSet = useMemo(() => new Set(recurringByWeekday.keys()), [recurringByWeekday]);
  const absenceByDate = useMemo(() => {
    const rank = (s) => (s === "acknowledged" || s === "covered") ? 2 : 1;
    const m = {};
    (absence || []).forEach((a) => {
      if (a.status === "cancelled") return;
      const prev = m[a.date];
      if (!prev || rank(a.status) >= rank(prev.status)) m[a.date] = { status: a.status, kind: a.kind };
    });
    return m;
  }, [absence]);
  const shiftSet = useMemo(() => new Set((shifts || []).map((s) => s.date)), [shifts]);
  const markedList = useMemo(
    () => Object.entries(oneOffByDate).map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
    [oneOffByDate],
  );
  const hasAbsence = (absence || []).some((a) => a.status !== "cancelled");

  const withSaving = (iso, on) => setSavingSet((s) => { const n = new Set(s); on ? n.add(iso) : n.delete(iso); return n; });

  const tapDay = async (iso, meta) => {
    setErr("");
    if (isPast(iso) || savingSet.has(iso)) return;
    if (meta.abs) return; // absence day — the request flow governs it, not a soft tap
    if (meta.oneOff) {                                   // un-mark
      withSaving(iso, true);
      setAvail((rows) => (rows || []).filter((r) => r.id !== meta.oneOff.id));
      try { await portalApi.delete(`/portal/${token}/availability/${meta.oneOff.id}`); }
      catch { setErr(t("kanIkkeSaveFailed", "Couldn't save — try again.")); await loadAvail(); }
      finally { withSaving(iso, false); }
      return;
    }
    if (meta.recurring) {                                // covered by a weekly rule — confirm scope, don't dup
      setConfirmWeekday({ wd: meta.wd });
      return;
    }
    if (oneOffByDate[iso]) return;                       // dedupe guard vs rapid double-tap
    // ROSTERED DAY + "can't work" = the app's most dangerous silent moment.
    // The tap succeeds, the dot turns red, and the staffer walks away believing
    // they have told someone they can't come in. They have not: availability is
    // a PLANNING signal the owner reads when building a future roster, and it
    // does nothing at all to a shift that is already published. Nobody is
    // notified, the shift stays on the roster, and the venue is short on the
    // night. `shiftSet` was already computed and handed to both strips to tint
    // the cell — the tap handler just never asked it. Say what the mark does
    // and does not do, and point at the channel that reaches a human.
    if (mode === "unavailable" && shiftSet.has(iso)) {
      setConfirmRostered({ iso });
      return;
    }
    withSaving(iso, true);
    setAvail((rows) => [...(rows || []), { id: "tmp-" + iso, kind: mode, date: iso, weekday: null, start_time: null, end_time: null, note: null }]);
    try { await portalApi.post(`/portal/${token}/availability`, { date: iso, kind: mode }); await loadAvail(); }
    catch { setErr(t("kanIkkeSaveFailed", "Couldn't save — try again.")); await loadAvail(); }
    finally { withSaving(iso, false); }
  };

  // Same write as tapDay's tail, reached only after the rostered-day sheet has
  // told the staffer the shift is NOT cancelled by this.
  const markAnyway = async (iso) => {
    setConfirmRostered(null);
    if (oneOffByDate[iso]) return;
    withSaving(iso, true);
    setAvail((rows) => [...(rows || []), { id: "tmp-" + iso, kind: mode, date: iso, weekday: null, start_time: null, end_time: null, note: null }]);
    try { await portalApi.post(`/portal/${token}/availability`, { date: iso, kind: mode }); await loadAvail(); }
    catch { setErr(t("kanIkkeSaveFailed", "Couldn't save — try again.")); await loadAvail(); }
    finally { withSaving(iso, false); }
  };

  const addWeekly = async (wd) => {
    if (recurringByWeekday.has(wd)) return;
    // Optimistically add the rule so a rapid second tap sees `on` (routes to
    // remove, never a duplicate add) — mirrors the calendar-tap dedupe guard.
    setAvail((rows) => [...(rows || []), { id: "tmp-wd-" + wd, kind: "unavailable", date: null, weekday: wd, start_time: null, end_time: null, note: null }]);
    try { await portalApi.post(`/portal/${token}/availability`, { weekday: wd, kind: "unavailable" }); await loadAvail(); }
    catch { setErr(t("kanIkkeSaveFailed", "Couldn't save — try again.")); await loadAvail(); }
  };
  const removeWeekly = async (wd) => {
    const id = recurringByWeekday.get(wd)?.id;
    setConfirmWeekday(null);
    if (!id) return;
    setAvail((rows) => (rows || []).filter((r) => r.id !== id));
    try { await portalApi.delete(`/portal/${token}/availability/${id}`); }
    catch { setErr(t("kanIkkeSaveFailed", "Couldn't save — try again.")); await loadAvail(); }
  };
  const removeOneOff = async (id) => {
    setAvail((rows) => (rows || []).filter((r) => r.id !== id));
    try { await portalApi.delete(`/portal/${token}/availability/${id}`); }
    catch { await loadAvail(); }
  };
  // No PATCH: edit an all-day mark to timed = DELETE the old row, POST a new one.
  const saveTime = async (row, allDay, start, end, note) => {
    setErr("");
    if (!allDay && end <= start) { setErr(t("kanIkkeEndAfterStart", "End time must be after start.")); return; }
    setExpandedDate(null);
    // Abort if the delete didn't land — else a transient failure + a successful
    // POST would leave TWO rows for one date (backend has no dedup/unique).
    try { await portalApi.delete(`/portal/${token}/availability/${row.id}`); }
    catch { setErr(t("kanIkkeSaveFailed", "Couldn't save — try again.")); await loadAvail(); return; }
    // Preserve the row's OWN kind. Hardcoding "unavailable" here silently
    // converted a "Helst" day to "Kan ikke" the moment its hours were edited.
    const body = { date: row.date, kind: row.kind === "preferred" ? "preferred" : "unavailable" };
    if (!allDay) { body.start_time = start; body.end_time = end; }
    if (note && note.trim()) body.note = note.trim();
    try { await portalApi.post(`/portal/${token}/availability`, body); await loadAvail(); }
    catch { setErr(t("kanIkkeSaveFailed", "Couldn't save — try again.")); await loadAvail(); }
  };

  const goPrev = () => { const d = new Date(viewYear, viewMonth - 1, 1); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); };
  const goNext = () => { const d = new Date(viewYear, viewMonth + 1, 1); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); };
  const goToday = () => { const d = new Date(); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); };
  const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();
  const fmtWhen = (iso) => fmtDate(iso, lang);

  if (avail === null) {
    return <ListSkeleton label={t("portalLoading", "Loading…")} rows={4} height={48} />;
  }

  // Legend swatches are the cells' own looks, so the key can never drift
  // from what the calendar draws.
  const swatch = (kind) => (
    <span aria-hidden className="shrink-0 inline-flex items-center justify-center" style={{ width: 14, height: 14, borderRadius: 4, boxSizing: "border-box", ...DAY_LOOK[kind] }}>
      {/* The approved cells' tick, so the key matches the mark. */}
      {kind === "approved" && <Check style={{ width: 10, height: 10, color: CREAM }} strokeWidth={2.5} />}
    </span>
  );
  const legendItem = (kind, label) => (
    <span key={kind} className="inline-flex items-center" style={{ gap: 6 }} data-legend={kind}>{swatch(kind)}{label}</span>
  );

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Which kind of day a tap marks. Both are real: "kan ikke" constrains
          the roster, "helst" is a soft preference the manager sees while
          planning. The copy for each says exactly that much and no more —
          a preference does not reserve the shift. The canvas's week chips:
          an ivory track, the chosen one pine. */}
      <VpSegmented
        testId="kanikke-mode"
        options={[
          { key: "unavailable", label: t("kanIkkeModeCant", "Can't work") },
          { key: "preferred", label: t("kanIkkeModePreferred", "Preferred") },
        ]}
        value={mode}
        onChange={setMode}
      />

      {/* Intro — mental model + honesty boundary before the first tap */}
      <p style={{ margin: "0 4px", font: "400 14px/1.45 var(--font-text)", color: MUTED }}>
        {mode === "preferred"
          ? t("kanIkkeIntroPreferred", "Tap the days you'd like to work. A preference never books a shift — your manager just sees it while planning.")
          : t("kanIkkeCalIntro", "Tap the days you can't work. Your manager sees it while planning — a heads-up, not approved time off.")}
      </p>

      {calOpen ? (
        <MonthCalendar
          viewYear={viewYear} viewMonth={viewMonth}
          onPrev={goPrev} onNext={goNext} onToday={goToday} showToday={!isCurrentMonth}
          oneOffByDate={oneOffByDate} recurringSet={recurringSet} absenceByDate={absenceByDate}
          shiftSet={shiftSet} savingSet={savingSet}
          onTapDay={tapDay} lang={lang} t={t}
        />
      ) : (
        <WeekStrip
          weekOffset={weekOffset} onShiftWeek={setWeekOffset}
          oneOffByDate={oneOffByDate} recurringSet={recurringSet} absenceByDate={absenceByDate}
          shiftSet={shiftSet} savingSet={savingSet} onTapDay={tapDay} lang={lang} t={t}
        />
      )}

      {/* A quiet pine text button: the month is one tap away, never a second
          primary on this screen. */}
      <button
        type="button"
        onClick={() => setCalOpen((v) => !v)}
        aria-expanded={calOpen}
        data-testid="kanikke-cal-toggle"
        className={`w-full flex items-center justify-center vp-press ${FOCUS_RING}`}
        style={{ gap: 6, height: 44, borderRadius: 999, border: `1px solid ${LINE}`, background: "transparent", font: "600 14px/1 var(--font-text)", color: PINE }}
      >
        {calOpen ? t("kanIkkeShowWeek", "Show this week only") : t("kanIkkeShowMonth", "Pick another date")}
        <ChevronDown size={16} strokeWidth={2} aria-hidden style={{ transform: calOpen ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out)" }} />
      </button>

      {err && <VpAlert>{err}</VpAlert>}

      {/* Legend — text always present, never colour-only */}
      <div
        data-testid="kanikke-legend"
        className="flex flex-wrap items-center"
        style={{ gap: "8px 14px", padding: "0 4px", font: "500 12px/1.2 var(--font-text)", color: MUTED }}
      >
        {legendItem("cant", t("legendCantWork", "Can't work"))}
        {legendItem("weekly", t("legendRepeats", "Every week"))}
        {legendItem("pref", t("legendPreferred", "Preferred"))}
        {hasAbsence && legendItem("pending", t("legendPending", "Pending"))}
        {hasAbsence && legendItem("approved", t("legendApproved", "Approved time off"))}
        {/* Only claim the scheduled dot when there is a shift to carry one. */}
        {shiftSet.size > 0 && (
          <span className="inline-flex items-center" style={{ gap: 6 }} data-legend="scheduled">
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 99, background: PINE, margin: "0 4px" }} />
            {t("legendScheduled", "Scheduled")}
          </span>
        )}
      </div>


      {/* Marked days — where time-window + note live (never on the grid cell) */}
      {markedList.length > 0 && (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {markedList.map((row) => (
            <MarkedDayRow
              key={row.date}
              row={row}
              label={fmtWhen(row.date)}
              expanded={expandedDate === row.date}
              onToggle={() => setExpandedDate(expandedDate === row.date ? null : row.date)}
              onRemove={() => removeOneOff(row.id)}
              onSave={(allDay, s, e, n) => saveTime(row, allDay, s, e, n)}
              t={t}
            />
          ))}
          {/* Time-window discovery hint (no per-cell chrome) */}
          <p style={{ margin: "0 4px", font: "400 12px/1.4 var(--font-text)", color: MUTED }}>{t("kanIkkeHoldHint", "Tap a day in this list to set hours or a note.")}</p>
        </div>
      )}

      {/* Recurring weekly ("Fast ugentlig") — advanced, opt-in, low emphasis:
          an ivory row that opens to seven weekday chips. */}
      <div style={{ borderRadius: 20, ...CARD_BOX }}>
        <button
          type="button"
          onClick={() => setRecurOpen((o) => !o)}
          aria-expanded={recurOpen}
          data-testid="kanikke-weekly-toggle"
          className={`w-full flex items-center text-left vp-press vp-row ${FOCUS_RING}`}
          style={{ gap: 12, minHeight: 56, padding: "8px 14px 8px 12px", borderRadius: 20, color: INK }}
        >
          <span className="shrink-0 flex items-center justify-center" style={{ width: 40, height: 40, borderRadius: 12, background: SOFT, color: PINE }}>
            <Repeat size={18} strokeWidth={1.9} aria-hidden />
          </span>
          <span className="flex-1 min-w-0 truncate" style={{ font: "600 15px/1.25 var(--font-text)" }}>{t("kanIkkeRepeatToggle", "Repeat weekly")}</span>
          <ChevronDown size={18} strokeWidth={2} aria-hidden className="shrink-0" style={{ color: MUTED, transform: recurOpen ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out)" }} />
        </button>
        {recurOpen && (
          <div className="flex flex-col" style={{ gap: 10, padding: "4px 12px 14px" }}>
            <p style={{ margin: "0 2px", font: "400 13px/1.4 var(--font-text)", color: MUTED }}>{t("kanIkkeRepeatHint", "Pick a weekday you can never work.")}</p>
            <div className="grid" style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
              {WD.map((w, i) => {
                const on = recurringSet.has(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => (on ? removeWeekly(i) : addWeekly(i))}
                    aria-pressed={on}
                    className={`min-w-0 inline-flex items-center justify-center capitalize vp-press ${FOCUS_RING}`}
                    style={{
                      height: 44, padding: 0, borderRadius: 999,
                      background: on ? PINE : ROW, color: on ? CREAM : MUTED,
                      font: "600 12px/1 var(--font-text)",
                    }}
                  >
                    <span className="truncate">{String(w).replace(/\.$/, "")}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Divider — a different kind of thing below */}
      <div aria-hidden style={{ height: 1, background: DIVIDER, margin: "4px 4px 0" }} />

      {/* Fravær — a request the owner approves (distinct from the soft calendar taps) */}
      <AbsenceSection token={token} onChanged={loadAbsence} />

      {/* Rostered-day confirm: the mark is a planning signal, not a cancellation. */}
      {rosteredSheet.mounted && rosteredShown && (
        <VpQuestionSheet
          closing={rosteredSheet.closing}
          testId="kanikke-rostered-sheet"
          title={t("kanIkkeRosteredTitle", "You already have a shift that day")}
          body={t("kanIkkeRosteredBody", "Marking it only helps your manager plan future weeks. It doesn't cancel the shift, and nobody is told — message your manager if you can't work it.")}
          onDismiss={() => setConfirmRostered(null)}
          dismissLabel={t("portalCancel", "Cancel")}
        >
          <button
            type="button"
            onClick={() => { setConfirmRostered(null); onNavigate?.("messages"); }}
            className={`flex-1 vp-press ${FOCUS_RING}`}
            style={BTN_PINE}
          >
            {t("kanIkkeRosteredMessage", "Message manager")}
          </button>
          <button
            type="button"
            onClick={() => markAnyway(rosteredShown.iso)}
            className={`flex-1 vp-press ${FOCUS_RING}`}
            style={BTN_QUIET}
          >
            {t("kanIkkeRosteredAnyway", "Mark anyway")}
          </button>
        </VpQuestionSheet>
      )}

      {/* Remove-weekly-rule scoped confirm (blast-radius honesty) */}
      {weekdaySheet.mounted && weekdayShown && (
        <VpQuestionSheet
          closing={weekdaySheet.closing}
          testId="kanikke-weekly-sheet"
          title={t("kanIkkeRemoveWeeklyTitle", "Remove this weekly rule?")}
          body={t("kanIkkeRemoveWeeklyBody", "This clears every {day}.", { day: weekdayLong(weekdayShown.wd, lang) })}
          onDismiss={() => setConfirmWeekday(null)}
          dismissLabel={t("portalCancel", "Cancel")}
        >
          <button type="button" onClick={() => setConfirmWeekday(null)} className={`flex-1 vp-press ${FOCUS_RING}`} style={BTN_QUIET}>
            {t("portalCancel", "Cancel")}
          </button>
          <button type="button" onClick={() => removeWeekly(weekdayShown.wd)} className={`flex-1 vp-press ${FOCUS_RING}`} style={BTN_RED}>
            {t("kanIkkeRemove", "Remove")}
          </button>
        </VpQuestionSheet>
      )}
    </div>
  );
}

/* Bar material for the portal's chrome (sticky header, notch cap, tab bar,
   chat composer). Scoped BY PAGE, not by build target: these classes land on
   four elements in this file and nowhere else, so .glass / .glass-static keep
   every other consumer (Layout.jsx:550, MobileBottomNav.jsx:119,
   FloorPlan.jsx:1302, LoginPage.jsx:334) byte-identical.

   NOT gated on VITE_APP_MODE on purpose. This same page is what a staff member
   gets at bonbox.dk/s/<token> from the SMS link, which is how most of them
   reach it before they install anything. Gating on the build would hand one
   person two visibly different products depending on which icon they tapped.
   The consequence is disclosed rather than hidden: this ships to the public
   web the moment the web bundle deploys, not only to dk.bonbox.scheduler.

   OFF SWITCHES, both failing toward an older appearance:
     1. VITE_PORTAL_BARS=off in the build env — compile-time, Vite dead-strips.
     2. localStorage bb_bars="v1" | "v2" — per-device, no rebuild. A DEV/QA
        lever so one binary can be A/B'd on a phone with Web Inspector
        attached. It is NOT a field kill switch: staff cannot set it.

   "v3" is the default: since Nov 2026 the Orvexlo floating DOCK (BeloBag's
   bar — vagtplan.css .vp-dock): a light warm bar 12 px in from the sides and
   8 px above the home indicator, 52 tall (48 under 360 px), every tab icon +
   name, ONE sage pill that slides to the active tab. (Before it, "v3" was
   the canvas's ivory bar with a pine icon pill, and before that a dark forest
   pill; both are gone, the levers below are the rollback.) "v2" keeps the
   glass bar edge to edge; "v1" is the pre-v2 bar. */
const BAR_MODE = (() => {
  if (import.meta.env.VITE_PORTAL_BARS === "off") return "v1";
  try {
    const v = localStorage.getItem("bb_bars");
    if (v === "v1" || v === "v2") return v;
  } catch { /* private mode — the default */ }
  return "v3";
})();
const BAR_V2 = BAR_MODE !== "v1";
const BAR_V3 = BAR_MODE === "v3";
// Where the dock sits (the kit: safe area + an 8 px lift) and how tall it is
// (52; vagtplan.css draws it 48 under 360 px, which only adds 4 px of air to
// what derives from it). Everything fixed to the bottom (chat composer,
// toasts) and the scroller's own padding derive from these, so moving the
// dock moves them with it. The cookie banner measures the dock itself
// (data-bb-consent-clear). The dock's own geometry lives in vagtplan.css.
const DOCK_LIFT = 8;
const DOCK_H = 52;
// "safe area + N px": N px above the bottom edge of the screen's usable area.
const aboveDock = (gap) => `calc(env(safe-area-inset-bottom, 0px) + ${DOCK_LIFT + DOCK_H + gap}px)`;
// Below 360 CSS px (iPhone SE / mini with Display Zoom: 320, a Fold cover
// screen: 323) the home tightens: the date strip drops its gaps and the
// card's confirmed state says "Bekræftet" instead of "Vagten er bekræftet".
const NARROW_PHONE_Q = "(max-width: 359px)";
// Under 700 CSS px of height (canvas: usable height < 700) the live ring
// drops to 150 px so the card's actions stay above the tab bar.
const SHORT_PHONE_Q = "(max-height: 700px)";
function useMediaMatch(query) {
  const read = () => {
    try { return !!window.matchMedia?.(query)?.matches; } catch { return false; }
  };
  const [match, setMatch] = useState(read);
  useEffect(() => {
    let mql = null;
    try { mql = window.matchMedia?.(query) || null; } catch { mql = null; }
    if (!mql) return undefined;
    const on = () => setMatch(!!mql.matches);
    if (mql.addEventListener) mql.addEventListener("change", on);
    else mql.addListener?.(on);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", on);
      else mql.removeListener?.(on);
    };
  }, [query]);
  return match;
}
function useNarrowPhone() {
  return useMediaMatch(NARROW_PHONE_Q);
}
function useShortPhone() {
  return useMediaMatch(SHORT_PHONE_Q);
}

// v3Label / V3Icon: the canvas bar's own words and icons ("Fravær", "Byt",
// a calendar with an x). The legacy v1/v2 bars keep labelKey / Icon.
const TABS = [
  { key: "schedule", Icon: Calendar, labelKey: "navSchedule", labelFallback: "Schedule" },
  { key: "availability", Icon: CalendarOff, V3Icon: CalendarX, labelKey: "navKanIkke", labelFallback: "Kan ikke", v3LabelKey: "portalTabTimeOff", v3LabelFallback: "Time off" },
  { key: "messages", Icon: MessageSquare, labelKey: "navMessages", labelFallback: "Messages" },
  { key: "swaps", Icon: ArrowLeftRight, labelKey: "navSwaps", labelFallback: "Swaps", v3LabelKey: "portalTabSwap", v3LabelFallback: "Swaps" },
  { key: "hours", Icon: Clock, labelKey: "navHours", labelFallback: "Hours" },
  { key: "alerts", Icon: Bell, labelKey: "navAlerts", labelFallback: "Alerts" },
];
// The dock's five: Alerts lives on the header bell.
const DOCK_TABS = TABS.filter((item) => item.key !== "alerts");

/**
 * InstallNotifyCard — the prominent "make this an app + get notified" card
 * shown at the top of the Schedule tab. Before this, push opt-in lived
 * buried behind the avatar → almost nobody found it. This surfaces it where
 * staff land, and adds the Android/Chrome install button (beforeinstallprompt).
 *
 * Install target note: a per-token manifest start_url (so the installed icon
 * opens straight to THIS staff's schedule) needs a same-origin manifest the
 * www host serves — tracked as a follow-up. Today install uses the app
 * manifest; the embedded StaffPushOptIn handles the iOS "Add to Home Screen"
 * path + the actual push subscription.
 */
function InstallNotifyCard({ token }) {
  const { t } = useLanguage();
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installed, setInstalled] = useState(() => _isStandalone());
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("bonbox_portal_card_dismissed") === "1";
    } catch {
      return false;
    }
  });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Once installed AND dismissed, the card has no job left — hide it. While
  // not installed we keep it (StaffPushOptIn self-hides when push is on or
  // tier-locked, so the card can still carry the install affordance).
  if (dismissed && installed) return null;

  const doInstall = async () => {
    if (!installPrompt) return;
    try {
      installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      /* user dismissed the native prompt */
    }
    setInstallPrompt(null);
  };

  const onDismiss = () => {
    try {
      localStorage.setItem("bonbox_portal_card_dismissed", "1");
    } catch {
      /* private mode */
    }
    setDismissed(true);
  };

  // iOS Safari has no install prompt — it installs via Share → Add to Home
  // Screen, so we show that as guided steps instead of an Install button.
  const isIOS = /iphone|ipad|ipod/i.test(
    typeof navigator !== "undefined" ? navigator.userAgent || "" : ""
  );

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white">
      {/* Collapsed: one calm, tappable line — the schedule stays the hero. */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Smartphone className="w-4 h-4 text-gray-500 shrink-0" strokeWidth={2} aria-hidden />
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex-1 min-w-0 text-left text-[13px] font-medium text-gray-700 truncate"
        >
          {t("staffInstallTitleSlim", "Add to home screen + alerts")}
        </button>
        {installed && (
          <Check className="w-4 h-4 text-emerald-600 shrink-0" strokeWidth={2.5} aria-hidden />
        )}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-label={t("staffInstallToggle", "Show install options")}
          className="p-3 -m-2 text-gray-400 hover:text-gray-600 active:opacity-60 shrink-0"
        >
          <ChevronDown
            className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            strokeWidth={2}
            aria-hidden
          />
        </button>
        {/* Dismiss only once installed — pre-install the card's job isn't done,
            and an X that resurrects nothing next visit is a dead control. */}
        {installed && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t("dismiss", "Dismiss")}
            className="p-3 -m-2 text-gray-400 hover:text-gray-600 active:opacity-60 shrink-0"
          >
            <X className="w-4 h-4" strokeWidth={2} aria-hidden />
          </button>
        )}
      </div>

      {/* Expanded: the install affordance + push opt-in (unchanged behaviour). */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-[#f1f5f9]">
          <div className="text-[12px] text-gray-500 mt-2 leading-relaxed">
            {t(
              "staffInstallSub",
              "Add this to your home screen and turn on alerts — you'll know the moment your shifts change."
            )}
          </div>

          {/* Android / Chrome — native install prompt */}
          {!installed && installPrompt && (
            <button
              type="button"
              onClick={doInstall}
              className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-[12px] font-text text-[12px] font-bold bg-gray-900 text-white hover:bg-gray-700 transition"
            >
              <Download className="w-4 h-4" strokeWidth={2} aria-hidden />
              {t("staffInstallBtn", "Install app")}
            </button>
          )}

          {/* iOS — the native BonBox Vagtplan app is the best path now that
              it's on the App Store (push, offline, proper app). The old
              Share → Add to Home Screen route stays as a lightweight fallback. */}
          {!installed && !installPrompt && isIOS && (
            <div className="mt-2.5 space-y-2">
              <a
                href="https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-[12px] font-text text-[12px] font-bold bg-gray-900 text-white hover:bg-gray-700 transition"
              >
                <Apple className="w-4 h-4" strokeWidth={2} aria-hidden />
                {t("staffGetSchedulerApp", "Get the BonBox Vagtplan app")}
              </a>
              <div className="flex items-center gap-1.5 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[12px] text-gray-500">
                <span>{t("staffInstallIosOr", "Or add to home screen:")}</span>
                <span>{t("staffInstallIosA", "Tap")}</span>
                <Share className="w-4 h-4 text-gray-700 shrink-0" strokeWidth={2} aria-hidden />
                <span>{t("staffInstallIosB", 'then "Add to Home Screen"')}</span>
              </div>
            </div>
          )}

          {/* Any other context — never a dead end; tell them where install lives. */}
          {!installed && !installPrompt && !isIOS && (
            <div className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[12px] text-gray-600 leading-relaxed">
              <Download className="w-4 h-4 text-gray-900 shrink-0 mt-0.5" strokeWidth={2} aria-hidden />
              <span>
                {t(
                  "staffInstallMenuHint",
                  "No install button? Open this page in Chrome or Safari, then use the browser menu → “Install app” / “Add to Home Screen”."
                )}
              </span>
            </div>
          )}

          {installed && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-700">
              <Check className="w-4 h-4" strokeWidth={2.5} aria-hidden />
              {t("staffInstalledLabel", "App installed")}
            </div>
          )}

          <div className="mt-2.5">
            <StaffPushOptIn token={token} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * StaffPushOptIn — opt-in card for native Web Push, scoped to the staff
 * portal token. Mirrors PushOptInPrompt (owner-side, Task #72) but uses
 * the portal endpoints + the OWNER's tier gate to decide whether to show
 * the toggle at all.
 *
 * Visibility cascade (top-to-bottom — first match renders):
 *   1. Browser doesn't support Web Push → render nothing (graceful skip).
 *   2. iOS Safari, NOT installed as PWA → "Add to Home Screen first" card.
 *   3. Owner tier doesn't enable push (403 from VAPID key endpoint) →
 *      render nothing (we never name the tier — see L10 honest claims).
 *   4. Already subscribed → "Push on — turn off" toggle.
 *   5. Permission denied at OS level → "Push blocked — enable in
 *      Settings" hint (can't recover from JS).
 *   6. Default state → "Get push when your schedule changes" with Enable
 *      button.
 *
 * Server flow:
 *   GET  /portal/{token}/vapid-public-key  → fetch the VAPID key. 403 OR
 *                                            503 → bail without erroring.
 *   POST /portal/{token}/push/subscribe    → upserts the row.
 *   POST /portal/{token}/push/unsubscribe  → cleans up.
 */
/**
 * The pre-shift reminder, reachable from the PROFILE.
 *
 * It also lives inside StaffPushOptIn, but that component renders only on the
 * Schedule tab and only on web (`tab === "schedule" && !isNativeApp()`) — so
 * once switched on it could not be switched OFF from the native app at all,
 * and on web only from one tab. A setting you can turn on and not off is not a
 * setting. Profile is reachable everywhere, so the off switch lives here too.
 */
/** Lead time as a person says it: "30 min", "1 time", "3 timer" — never "180 minutter". */
function fmtLead(minutes, t) {
  const m = Number(minutes) || 0;
  if (m < 60) return t("staffRemindMin", "{n} min").split("{n}").join(String(m));
  const h = m / 60;
  return (h === 1 ? t("staffRemindHrOne", "{n} hour") : t("staffRemindHr", "{n} hours"))
    .split("{n}").join(String(h));
}

function ShiftReminderRow({ token }) {
  const { t } = useLanguage();
  const [minutes, setMinutes] = useState(undefined);   // undefined = not loaded
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancel = false;
    portalApi.get(`/portal/${token}/reminder`)
      .then((r) => { if (!cancel) setMinutes(r.data?.minutes ?? null); })
      // A server without the /reminder route (not yet deployed) is NOT "off" —
      // it is a control that cannot save. Showing the switch there would be a
      // toggle that silently does nothing, so it stays hidden instead.
      .catch(() => { if (!cancel) setMinutes(false); });
    return () => { cancel = true; };
  }, [token]);

  if (minutes === undefined) return null;              // never flash a wrong state
  if (minutes === false) return null;                  // endpoint unavailable — offer nothing

  const save = async (next) => {
    setBusy(true); setErr("");
    const prev = minutes;
    setMinutes(next);
    try {
      await portalApi.post(`/portal/${token}/reminder`, { minutes: next });
    } catch {
      setMinutes(prev);                                 // never claim an opt-in the server refused
      setErr(t("staffPushSaveFailed", "Couldn't save — try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-3 border-t border-[#f1f5f9]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-gray-900">{t("staffRemindTitle", "Remind me before a shift")}</div>
          <div className="text-[11px] text-gray-400">
            {minutes
              ? t("staffRemindOnHint", "We'll let you know {n} before you start.").split("{n}").join(fmtLead(minutes, t))
              : t("staffRemindNeedsPush", "Needs notifications switched on for this device.")}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!!minutes}
          aria-label={t("staffRemindTitle", "Remind me before a shift")}
          disabled={busy}
          onClick={() => save(minutes ? null : 60)}
          className="flex-shrink-0 disabled:opacity-50"
          style={{
            width: 42, height: 25, borderRadius: 99, padding: 3, display: "flex",
            transition: "background .25s",
            background: minutes ? "linear-gradient(180deg,#22c55e,#16a34a)" : "#dbe3ec",
            boxShadow: "inset 0 1px 2px rgba(15,23,42,.14)",
          }}
        >
          <span
            style={{
              width: 19, height: 19, borderRadius: 99, background: "#fff",
              boxShadow: "0 1px 3px rgba(15,23,42,.35)",
              transition: "transform .25s cubic-bezier(.3,1.4,.5,1)",
              transform: minutes ? "translateX(17px)" : "translateX(0)",
            }}
          />
        </button>
      </div>
      {minutes && (
        <div className="flex" style={{ gap: 6, marginTop: 10 }}>
          {[30, 60, 120, 180].map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              onClick={() => save(m)}
              style={{
                flex: 1, padding: "7px 0", borderRadius: 10,
                font: `${minutes === m ? 700 : 600} 11px/1 var(--font-text)`,
                background: minutes === m ? "linear-gradient(180deg,#1e293b,#0f172a)" : "#f5f8fb",
                color: minutes === m ? "#fff" : "#64748b",
                border: `1px solid ${minutes === m ? "transparent" : "#e8edf3"}`,
              }}
            >
              {fmtLead(m, t)}
            </button>
          ))}
        </div>
      )}
      {err && <p className="mt-2 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

function StaffPushOptIn({ token }) {
  const { t } = useLanguage();
  const [supported, setSupported] = useState(true);
  const [permission, setPermission] = useState(() => {
    try {
      return typeof Notification !== "undefined" ? Notification.permission : "denied";
    } catch {
      return "denied";
    }
  });
  const [subscribed, setSubscribed] = useState(false);
  // Lead time in minutes; null = no reminder. Only meaningful once push is on,
  // so it is fetched lazily rather than on every portal boot.
  const [reminder, setReminder] = useState(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tierAllowed, setTierAllowed] = useState(null); // null = unknown, false = locked, true = ok
  const [vapidKey, setVapidKey] = useState("");
  const iosNotInstalled = _isIos() && !_isStandalone();

  // Step 1: feature-detect Web Push.
  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      typeof Notification !== "undefined";
    setSupported(!!ok);
  }, []);

  // Step 2: prefetch the VAPID key. The endpoint answers the tier gate
  // for us — 200 means push is enabled on the OWNER's plan, 403 means
  // locked (we hide the card), 503 means VAPID not configured at all
  // (also hide). Never error-toasts the staff member; this is a
  // best-effort feature.
  useEffect(() => {
    if (!supported || iosNotInstalled) return;
    let cancel = false;
    portalApi
      .get(`/portal/${token}/vapid-public-key`)
      .then((res) => {
        if (cancel) return;
        const key = res?.data?.key || "";
        if (!key) {
          setTierAllowed(false);
          return;
        }
        setVapidKey(key);
        setTierAllowed(true);
      })
      .catch(() => {
        if (cancel) return;
        // 403 / 503 → not allowed. Don't surface this — the staff has
        // no agency over the owner's tier.
        setTierAllowed(false);
      });
    return () => {
      cancel = true;
    };
  }, [token, supported, iosNotInstalled]);

  // Step 3: probe the existing subscription so re-opens of the portal
  // reflect "Push on" without prompting again.
  //
  // The browser's subscription is not the server's. When the owner rotates or
  // revokes a link, the server forgets every device registered for that
  // staffer (a leaked link's device must stop getting pushes), while this
  // phone still holds its subscription — so "Push on" would be a claim with
  // nothing behind it. Re-send it under the link in hand (an idempotent
  // upsert); if the server refuses, show push as off so one tap re-enables it.
  useEffect(() => {
    if (!supported || !tierAllowed) return;
    let cancel = false;
    navigator.serviceWorker?.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (cancel) return;
        setSubscribed(!!sub);
        if (!sub) return;
        const json = sub.toJSON();
        portalApi.post(`/portal/${token}/push/subscribe`, {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          user_agent: navigator.userAgent?.slice(0, 500) || null,
        }).catch(() => { if (!cancel) setSubscribed(false); });
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [supported, tierAllowed, token]);

  useEffect(() => {
    if (!subscribed) return;
    let cancel = false;
    portalApi.get(`/portal/${token}/reminder`)
      .then((r) => { if (!cancel) setReminder(r.data?.minutes ?? null); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [subscribed, token]);

  const setReminderMinutes = async (minutes) => {
    setReminderBusy(true);
    const prev = reminder;
    setReminder(minutes);                      // optimistic
    try {
      await portalApi.post(`/portal/${token}/reminder`, { minutes });
    } catch {
      setReminder(prev);                       // never leave the UI claiming an
      setError(t("staffPushSaveFailed", "Couldn't save — try again."));  // opt-in the server refused
    } finally {
      setReminderBusy(false);
    }
  };

  const handleEnable = async () => {
    setBusy(true);
    setError("");
    try {
      const reg = await navigator.serviceWorker.ready;
      // Re-use existing subscription if the SW already minted one.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // Triggers the OS permission prompt as part of subscribe().
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: _urlBase64ToUint8Array(vapidKey),
        });
      }
      const json = sub.toJSON();
      await portalApi.post(`/portal/${token}/push/subscribe`, {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        user_agent: navigator.userAgent?.slice(0, 500) || null,
      });
      setSubscribed(true);
      setPermission(
        typeof Notification !== "undefined" ? Notification.permission : "denied"
      );
    } catch (err) {
      // Permission denied is the most common failure — show it as a
      // hint, not a crash. Anything else is an unknown error.
      const msg =
        err?.name === "NotAllowedError"
          ? t("staffPushDeniedError", "Notifications are blocked. Turn them back on in Settings.")
          : errText(err, t("staffPushEnableFailed", "Couldn't enable push. Try again."));
      setError(msg);
      if (typeof Notification !== "undefined") {
        setPermission(Notification.permission);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    setError("");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await portalApi.post(`/portal/${token}/push/unsubscribe`, {
            endpoint: sub.endpoint,
          });
        } catch {
          // Server-side row may already be gone (downgrade prune, etc.).
          // Best-effort cleanup; local unsubscribe still runs below.
        }
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      setError(errText(err, t("staffPushDisableFailed", "Couldn't disable push.")));
    } finally {
      setBusy(false);
    }
  };

  // Bail-outs (see visibility cascade in docstring).
  if (!supported) return null;
  if (iosNotInstalled) {
    return (
      <div className="rounded-lg bg-white border border-gray-200 p-3 text-[11px] text-gray-500 leading-relaxed">
        <div className="font-semibold text-gray-700 mb-1 inline-flex items-center gap-1.5">
          <Smartphone className="w-4 h-4" strokeWidth={2} aria-hidden />
          {t("staffPushIosInstallTitle", "Get push notifications")}
        </div>
        {t("staffPushIosInstallHint", "On iPhone, tap the share icon in Safari and choose Add to Home Screen. Then open your schedule from the new icon — the light Vagtplan icon with your workplace's name — to turn on push.")}
      </div>
    );
  }
  if (tierAllowed === null) {
    // Loading state — render nothing to avoid flicker.
    return null;
  }
  if (tierAllowed === false) {
    return null;
  }

  if (subscribed) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg bg-white border border-gray-200 p-3 flex items-center justify-between gap-3">
        <div className="text-[11px] text-gray-700 min-w-0 flex-1">
          <div className="font-semibold text-gray-900 inline-flex items-center gap-1.5">
            <Bell className="w-4 h-4" strokeWidth={2} aria-hidden />
            {t("staffPushOnTitle", "Push notifications on")}
          </div>
          <div className="text-gray-500">
            {t("staffPushOnHint", "You'll get a tap on this device when your schedule changes.")}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDisable}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex-shrink-0"
        >
          {busy ? "…" : t("staffPushOnTurnOff", "Turn off")}
        </button>
        </div>

        {/* Pre-shift reminder. Only offered once push is actually on and the
            permission is granted — a toggle that quietly saves a preference no
            notification can honour is worse than no toggle. */}
        <div className="rounded-lg bg-white border border-gray-200 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] min-w-0 flex-1">
              <div className="font-semibold text-gray-900">{t("staffRemindTitle", "Remind me before a shift")}</div>
              <div className="text-gray-500">
                {reminder
                  ? t("staffRemindOnHint", "We'll let you know {n} before you start.").split("{n}").join(fmtLead(reminder, t))
                  : t("staffRemindOffHint", "Off — you'll still hear about schedule changes.")}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!!reminder}
              disabled={reminderBusy}
              onClick={() => setReminderMinutes(reminder ? null : 60)}
              className="flex-shrink-0 disabled:opacity-50"
              style={{
                width: 42, height: 25, borderRadius: 99, padding: 3, display: "flex",
                transition: "background .25s",
                background: reminder ? "linear-gradient(180deg,#22c55e,#16a34a)" : "#dbe3ec",
                boxShadow: "inset 0 1px 2px rgba(15,23,42,.14)",
              }}
            >
              <span
                style={{
                  width: 19, height: 19, borderRadius: 99, background: "#fff",
                  boxShadow: "0 1px 3px rgba(15,23,42,.35)",
                  transition: "transform .25s cubic-bezier(.3,1.4,.5,1)",
                  transform: reminder ? "translateX(17px)" : "translateX(0)",
                }}
              />
            </button>
          </div>

          {reminder && (
            <div className="flex" style={{ gap: 6, marginTop: 10 }}>
              {[30, 60, 120, 180].map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={reminderBusy}
                  onClick={() => setReminderMinutes(m)}
                  style={{
                    flex: 1, padding: "7px 0", borderRadius: 10,
                    font: `${reminder === m ? 700 : 600} 11px/1 var(--font-text)`,
                    background: reminder === m ? "linear-gradient(180deg,#1e293b,#0f172a)" : "#f5f8fb",
                    color: reminder === m ? "#fff" : "#64748b",
                    border: `1px solid ${reminder === m ? "transparent" : "#e8edf3"}`,
                  }}
                >
                  {fmtLead(m, t)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-[11px] text-amber-800 leading-relaxed">
        <div className="font-semibold mb-1 inline-flex items-center gap-1.5"><BellOff className="w-4 h-4" strokeWidth={2} aria-hidden />{t("staffPushBlockedTitle", "Push blocked")}</div>
        {t("staffPushBlockedHint", "Notifications are blocked in your browser. Turn them back on in Settings → Notifications → your workplace's name (the light Vagtplan icon) to get a tap when your shifts change.")}
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white border border-gray-200 p-3 space-y-2">
      <div className="text-[11px] text-gray-700">
        <div className="font-semibold text-gray-900 inline-flex items-center gap-1.5">
          <Bell className="w-4 h-4" strokeWidth={2} aria-hidden />
          {t("staffPushOffTitle", "Get push notifications")}
        </div>
        <div className="text-gray-500 mt-0.5">
          {t("staffPushOffHint", "Get a tap on this device when your shifts change or the schedule updates.")}
        </div>
      </div>
      <button
        type="button"
        onClick={handleEnable}
        disabled={busy}
        className="w-full px-3 py-2 rounded-lg text-[12px] font-medium bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 transition"
      >
        {busy ? t("staffPushEnabling", "Enabling…") : t("staffPushEnable", "Enable push")}
      </button>
      {error && (
        <div className="text-[10px] text-red-400 leading-snug">{error}</div>
      )}
    </div>
  );
}




export default function StaffPortalPage() {
  const { token } = useParams();
  const { t, lang, setLang } = useLanguage();
  const confirmDisconnect = useConfirm();

  // The portal is a fixed full-viewport app-shell that owns its OWN safe-area
  // insets (the sticky header pads + caps the notch; the bottom nav pads for
  // the home-indicator). The global `body { padding-top: env(safe-area-inset-*) }`
  // in index.css would apply the SAME inset a second time → a fat empty gap
  // under the notch (only visible where env() > 0: the installed PWA + the
  // native Scheduler app; a normal browser has env()=0 so it never showed).
  // Drop the body padding while the portal is mounted so the header's inset is
  // the single source. Owner-app pages (body scroll) keep the body padding.
  // A LAYOUT effect (before the first paint): the class also carries the
  // portal's type and motion tokens (vagtplan.css), so a plain effect let one
  // frame paint in the owner app's faces.
  useLayoutEffect(() => {
    document.body.classList.add("portal-shell");
    return () => document.body.classList.remove("portal-shell");
  }, []);
  // Native keyboard height (0 on the web and while it is down). The shell ends
  // at the keyboard's top edge instead of behind it, the profile sheets ride
  // on top of it (KB_LIFT_STYLE), and the focused field — any field — is
  // scrolled into what is left. See hooks/useKeyboardReveal.js.
  const kbShell = useKeyboardReveal();
  // Android: the window shrinks for the keyboard, so the dock (and its fade)
  // would ride on top of it — on iOS it stays behind the keyboard. Hide it
  // while typing there, as iOS effectively does.
  const kbState = useKeyboardState();
  const dockAway = platform.isAndroid && kbState.open;
  const [tab, setTab] = useState(() => {
    // Honor ?tab= so the installed-app shortcuts (Schedule / Hours) and
    // any deep link open the right tab.
    try {
      const q = new URLSearchParams(window.location.search).get("tab");
      return ["schedule", "availability", "messages", "swaps", "hours", "alerts"].includes(q) ? q : "schedule";
    } catch {
      return "schedule";
    }
  });
  // The dock's indicator keeps the last DOCK tab (on Alerts it fades out in
  // place and slides on from there). `moved`: has the staffer switched tabs
  // since the page opened — the first paint plays no name pop and no screen
  // rise, only a real switch does.
  const dockIdx = DOCK_TABS.findIndex((x) => x.key === tab);
  const [nav, setNav] = useState(() => ({ tab, idx: Math.max(0, dockIdx), moved: false }));
  if (nav.tab !== tab) setNav({ tab, idx: dockIdx >= 0 ? dockIdx : nav.idx, moved: true });
  // Android BACK (key, edge swipe, 3-button bar): close the top layer, else
  // back to Vagtplan, else the app goes to the background — never nothing.
  // Android shell only; see utils/androidBack.js.
  useAndroidBack(() => {
    runAndroidBack({ tab, homeTab: "schedule", setTab, minimize: minimizeApp });
  });
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pinVerified, setPinVerified] = useState(false);

  // Native shell only: swap dead web-push for a real APNs registration the
  // moment the portal is usable (validated + past any PIN gate).
  useNativePush(token, Boolean(info) && pinVerified);

  // Data for each tab
  const [shifts, setShifts] = useState([]);
  // Whether `shifts` is an ANSWER yet. [] means three different things —
  // not fetched yet, fetch failed, really no shifts — and the Schedule hero
  // used to say "Ingen kommende vagt" for all three: before the first
  // response landed, and for good when the schedule call failed.
  // "loading" | "ok" | "error". Once "ok", a later failed refresh keeps "ok"
  // (the last-good roster stays on screen; the header pill tells its age).
  const [schedState, setSchedState] = useState("loading");
  // {date, n}: the week an alert tap should open on Vagtplan. Cleared once the
  // staffer leaves Vagtplan, so coming back later lands on this week again.
  const [scheduleFocus, setScheduleFocus] = useState(null);
  // Which department (branch) the portal is showing. Built from the staffer's
  // OWN shifts — `branch_name` already rides on every row — so the list can
  // only ever contain places they actually work. null = all of them.
  const [dept, setDept] = useState(null);
  const [deptOpen, setDeptOpen] = useState(false);
  const [photoMenu, setPhotoMenu] = useState(false);
  // Sheets play their exit before they unmount (sheetMotion.js).
  const deptSheet = usePresence(deptOpen);
  const photoSheet = usePresence(photoMenu);


  const departments = useMemo(() => {
    const seen = new Map();
    for (const sh of shifts) {
      if (!sh.branch_name) continue;
      seen.set(sh.branch_name, (seen.get(sh.branch_name) || 0) + 1);
    }
    return [...seen.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  }, [shifts]);

  // A department the staffer no longer has shifts at must not stay selected —
  // it would silently empty every screen with no way to tell why.
  useEffect(() => {
    if (dept && !departments.some((d) => d.name === dept)) setDept(null);
  }, [dept, departments]);

  // Filter ONCE here so every tab agrees. Shifts with no branch always show:
  // a single-location business has none, and hiding them would blank the app.
  const visibleShifts = useMemo(
    () => (dept ? shifts.filter((sh) => !sh.branch_name || sh.branch_name === dept) : shifts),
    [shifts, dept],
  );
  // Hoisted from WhosOnStrip / OpenShiftsClaimCard so the Schedule tab paints
  // ONCE — no post-settle hero growth or card insertion (stillness doctrine).
  const [teamShifts, setTeamShifts] = useState([]);
  const [openShifts, setOpenShifts] = useState([]);
  // business_date -> booked covers, for the days I'm rostered. Empty map = this
  // owner doesn't take reservations (or the book is untouched) -> render NOTHING.
  const [coversByShift, setCoversByShift] = useState({});
  const [hoursData, setHoursData] = useState(null);
  // null = whatever the owner's pay-period config says (the default the staffer
  // is paid on). Non-null = a window the staffer chose themselves.
  const [hoursRange, setHoursRange] = useState(null);
  // Unread owner→staff chat messages — drives the "Beskeder" nav badge.
  const [chatUnread, setChatUnread] = useState(0);
  // Swap requests waiting on THIS staffer's answer — the "Byt" nav badge.
  const [swapAsks, setSwapAsks] = useState(0);

  // ─── Live-sync (Phase 1: dependency-free freshness) ──────────────────────
  // lastSynced — stamped when the SCHEDULE GET resolves. Drives the header
  //   sync pill, which must tell the truth: "Synced" only when we actually
  //   have fresh data AND are online.
  // isOnline — navigator.onLine, kept live via online/offline listeners. The
  //   pill shows "Offline" (never "Synced") whenever this is false.
  // scheduleUpdated — flips true when a refetch returns published shifts that
  //   differ from what was already on screen → brief bottom toast.
  // The signature ref holds the last-rendered published-schedule signature so
  //   we can detect a *real* change without firing on the very first load.
  const [lastSynced, setLastSynced] = useState(null);
  // Counted against the same per-device "since you last looked" stamp AlertsTab
  // uses, so the badge and the screen can never disagree. Push rows are already
  // excluded server-side, so this counts readable items only.
  const [alertsUnread, setAlertsUnread] = useState(0);
  useEffect(() => {
    if (!(pinVerified && info) || tab === "alerts") return;
    let cancel = false;
    portalApi.get(`/portal/${token}/notifications`)
      .then((r) => {
        if (cancel) return;
        const seen = readAlertsSeen(token);
        const rows = r.data?.notifications || [];
        setAlertsUnread(rows.filter((n) => !seen || (n.created_at || "") > seen).length);
      })
      .catch(() => {});
    return () => { cancel = true; };
  }, [token, pinVerified, info, tab, lastSynced]);

  useEffect(() => {
    // Any other tab, Alerts included, drops the focus: ScheduleTab remounts
    // on every return to Vagtplan and would otherwise re-open the old alert's
    // week each time. An alert tap sets focus + tab in one batch, so it is
    // never cleared before ScheduleTab reads it.
    if (tab !== "schedule") setScheduleFocus(null);
  }, [tab]);

  // Opening Alerts IS reading them — otherwise the badge stays lit until the
  // staffer happens to find "Mark all read".
  useEffect(() => {
    if (tab !== "alerts") return;
    writeAlertsSeen(token, new Date().toISOString());
    setAlertsUnread(0);
  }, [tab, token]);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine !== false : true,
  );
  const [scheduleUpdated, setScheduleUpdated] = useState(false);
  const scheduleSigRef = useRef(null);
  // Ticks every ~15s while mounted so the pill re-renders from "Synced" to
  // "Synced HH:MM" as the data ages, without depending on a new fetch.
  const [, setFreshnessTick] = useState(0);
  // liveConnected — true while the SSE stream (Phase 2) is open. Drives the
  // "Live" pill and backs the foreground poll off from 20s → 60s (the stream
  // covers instant schedule pushes; the poll then only keeps hours fresh).
  // Declared below, after loadData (hooks/usePortalStream).

  // Email & phone editing
  const [showEmailEdit, setShowEmailEdit] = useState(false);
  const profileSheet = usePresence(showEmailEdit);
  // The header gets its hairline and loses the date line once the page has
  // scrolled (canvas "Hjem – rullet"). The row keeps its height, so nothing
  // under the sticky header moves.
  const [headerScrolled, setHeaderScrolled] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  // Home address (staff self-edit) — saved through the same contact PUT so
  // there's ONE Save button behind the avatar. DK-structured: adresse/postnr/by.
  const [addressInput, setAddressInput] = useState("");
  const [postalInput, setPostalInput] = useState("");
  const [cityInput, setCityInput] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMsg, setEmailMsg] = useState("");
  const [emailStatus, setEmailStatus] = useState(null); // "ok" | "err"

  // Profile photo (staff self-edit). Fetched as a blob through portalApi (which
  // attaches the X-BonBox-Pin header) → object URL, so it renders even on
  // PIN-protected links where a bare <img src> to the gated proxy would 401.
  const [photoUrl, setPhotoUrl] = useState(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let obj = null;
    if (info?.profile_photo_at && (pinVerified || !info?.has_pin)) {
      portalApi
        // ?v= busts the browser HTTP cache (the proxy sets max-age=86400) so a
        // freshly-changed photo shows immediately instead of the stale one.
        .get(`/portal/${token}/profile-photo?v=${encodeURIComponent(info.profile_photo_at)}`, { responseType: "blob" })
        .then((res) => {
          if (cancelled) return;
          obj = URL.createObjectURL(res.data);
          setPhotoUrl(obj);
        })
        .catch(() => { if (!cancelled) setPhotoUrl(null); });
    } else {
      setPhotoUrl(null);
    }
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [info?.profile_photo_at, info?.has_pin, pinVerified, token]);

  const handlePhotoChange = async () => {
    setEmailMsg("");
    setEmailStatus(null);
    let b64;
    try {
      b64 = await capturePhoto("gallery");
    } catch {
      setEmailStatus("err");
      setEmailMsg(t("portalPhotoFailed", "Couldn't add the photo. Try again."));
      return;
    }
    if (!b64) return; // cancelled
    setPhotoBusy(true);
    try {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append("file", new Blob([arr], { type: "image/jpeg" }), "avatar.jpg");
      const res = await portalApi.post(`/portal/${token}/profile-photo`, fd);
      setInfo((prev) => ({ ...prev, profile_photo_at: res.data.profile_photo_at }));
    } catch (err) {
      setEmailStatus("err");
      setEmailMsg(errText(err, t("portalPhotoFailed", "Couldn't add the photo. Try again.")));
    } finally {
      setPhotoBusy(false);
    }
  };

  const handlePhotoRemove = async () => {
    setPhotoBusy(true);
    try {
      await portalApi.delete(`/portal/${token}/profile-photo`);
      setInfo((prev) => ({ ...prev, profile_photo_at: null }));
    } catch { /* best-effort */ }
    finally { setPhotoBusy(false); }
  };

  // 1. Validate token on mount — and again on "Prøv igen" / the browser coming
  // back online after a failed open (validateKey bumps).
  const [validateKey, setValidateKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let gone = false;
    portalApi.get(`/portal/${token}`)
      .then((res) => {
        if (gone) return;
        setError(null);
        setRetrying(false);
        setInfo(res.data);
        // No PIN — auto-verify. With a PIN, a still-valid stored proof
        // (validated server-side, returned as pin_ok) also skips the gate.
        if (!res.data.has_pin || res.data.pin_ok) setPinVerified(true);
        setLoading(false);
        // Remember this as the staff's portal so an INSTALLED app icon
        // (which launches to "/") can redirect straight back here instead
        // of the owner login. See PublicOrDashboard in App.jsx.
        try { localStorage.setItem("bonbox_portal_token", token); } catch { /* private mode */ }
      })
      .catch((err) => {
        if (gone) return;
        // ONLY the server saying "this link is gone" is a dead link. The
        // backend answers a burned, deactivated, expired or erased link with
        // 404 (staff_portal.py _get_staff_from_token — one status on purpose,
        // so it never confirms a token was once real); 410 is accepted too.
        //
        // Everything else — no response at all (offline, a dead radio), a
        // timeout, a 429, a 5xx while Render wakes — says nothing about the
        // link. This catch used to treat all of them as dead: it showed
        // "Link virker ikke" over axios's English "Network Error" with no way
        // to retry, AND erased the saved link, so the Scheduler app booted to
        // /join next launch. Join codes burn on use, so the staffer then needed
        // a new code from their manager to see a schedule nothing was wrong
        // with. Now a non-answer keeps the link and offers "Prøv igen".
        const status = err?.response?.status;
        const dead = status === 404 || status === 410;
        setLoading(false);
        setRetrying(false);
        if (!dead) {
          // "server" when BonBox answered with trouble (5xx while it wakes, a
          // 429) — the phone is online, so "you're offline" would be wrong and
          // the 'online' event that retries an offline open never fires.
          setError({ transient: true, kind: err?.response ? "server" : "offline" });
          return;
        }
        // The dead-link screen uses the da/en catalogue copy: the server's
        // detail is raw English ("Link not found or inactive") and tells the
        // staffer nothing they can act on.
        setError({ expected: true, text: "" });
        // A dead link must not keep booting an installed app (PWA or the
        // Scheduler shell — both launch to "/") into this error screen:
        // forget it so "/" falls back to the join-code screen.
        try {
          if (localStorage.getItem("bonbox_portal_token") === token) {
            localStorage.removeItem("bonbox_portal_token");
          }
        } catch { /* private mode */ }
      });
    return () => { gone = true; };
  }, [token, validateKey]);

  // A failed open retries by itself the moment the phone is back online —
  // the staffer should not have to know that "Prøv igen" exists.
  const transientOpen = !!error?.transient;
  // A layout effect, so the listener is armed in the same commit that draws
  // the "no connection" screen: a passive effect could run after an 'online'
  // that arrived right after the screen appeared, and that retry was lost
  // (StaffPortalPage.deadLink failed once under a loaded full run).
  useLayoutEffect(() => {
    if (!transientOpen) return;
    const onOnline = () => { setRetrying(true); setValidateKey((k) => k + 1); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [transientOpen]);
  // …and on a timer, because neither failure is guaranteed an 'online' event:
  // a server in trouble leaves the phone online, and the iOS web view can
  // miss the event after a suspend. Each failed try sets a fresh `error`, so
  // this re-arms itself; a server that is down is asked every 15 s, an
  // offline phone every 30 s — only while the screen is in front.
  // A timer that fires while the screen is hidden must not be dropped: no
  // new `error` would ever re-arm it, and the screen kept promising a retry
  // that never came. Coming back to the screen (tab, app switch, native
  // resume) asks again at once instead.
  useEffect(() => {
    if (!error?.transient) return undefined;
    const retry = () => { setRetrying(true); setValidateKey((k) => k + 1); };
    const id = setTimeout(() => {
      if (document.visibilityState === "visible") retry();
    }, error.kind === "server" ? 15000 : 30000);
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    document.addEventListener("visibilitychange", onVisible);
    let resumeSub = null;
    if (isNativeApp()) {
      try { resumeSub = CapApp.addListener("resume", retry); } catch { /* plugin missing — visibilitychange covers it */ }
    }
    return () => {
      clearTimeout(id);
      document.removeEventListener("visibilitychange", onVisible);
      Promise.resolve(resumeSub).then((l) => l?.remove?.()).catch(() => {});
    };
  }, [error]);

  // 2. Load data once verified
  const loadData = useCallback(() => {
    // Set inside the .then below; the returned promise resolves to it so a
    // pull-to-refresh can distinguish "new roster" from "nothing moved" — and,
    // critically, from "we could not ask". A boolean cannot carry that third
    // case: it collapses a 500 or a dead radio into `false`, which the chip
    // then renders as "Up to date — no changes" over week-old data. Observed
    // live 2026-09-03 (a bad row 500'd the schedule endpoint). The outcome is
    // keyed on the SCHEDULE leg alone, the same leg that gates lastSynced, so
    // the chip and the "Synced" pill can never contradict each other.
    // Defaults to "failed" on purpose — fail CLOSED. If a later edit ever adds
    // a path that forgets to set this, the chip under-claims ("couldn't check")
    // instead of resurrecting the exact bug this replaces.
    let outcome = "failed";      // "changed" | "unchanged" | "failed"
    // Schedule — the freshness source of truth. On success we stamp
    // lastSynced (drives the "Synced" pill) and diff the published shifts
    // against the last-rendered signature to decide whether to toast.
    // Schedule + who's-on + open-shifts settle TOGETHER (Promise.allSettled →
    // React 18 batches the sets into one paint), so the hero never grows and
    // no card inserts after first paint. Each leg fails independently and
    // honest: on error we keep the previous data, never clear it.
    return Promise.allSettled([
      portalApi.get(`/portal/${token}/schedule`),
      portalApi.get(`/portal/${token}/team-schedule`),
      portalApi.get(`/portal/${token}/open-shifts`),
      // Booked covers for the days I'm rostered. Count only — the server
      // returns an aggregate integer per business date and NOTHING about the
      // guests (no names, no notes, and deliberately no allergy data: Art.9).
      portalApi.get(`/portal/${token}/covers`),
    ]).then(([sched, team, open, covers]) => {
      if (sched.status === "fulfilled") {
        const nextShifts = sched.value.data.shifts || [];
        const nextSig = publishedScheduleSignature(nextShifts);
        const prevSig = scheduleSigRef.current;
        outcome = prevSig !== null && prevSig !== nextSig ? "changed" : "unchanged";
        // Only toast on a REAL change after we already had data — never on the
        // first successful load (prevSig === null means we've shown nothing yet).
        if (prevSig !== null && prevSig !== nextSig) {
          setScheduleUpdated(true);
        }
        scheduleSigRef.current = nextSig;
        setShifts(nextShifts);
        setSchedState("ok");
        setLastSynced(new Date());
        // An answer from the server IS being online. navigator.onLine and its
        // events are only a hint — inside the iOS web view an 'offline' that
        // fired while the phone slept may never be followed by 'online', and
        // the header said "Offline" for hours over a schedule that kept
        // refreshing. The pill now follows what actually happened.
        setIsOnline(true);
      } else {
        setSchedState((st) => (st === "ok" ? "ok" : "error"));
        // Fail honest: do NOT advance lastSynced on a failed schedule fetch, so
        // the pill keeps showing the real last-good time (or Offline). Keeping
        // the last-good shifts on screen is right; the caller just has to be
        // told the screen is last-KNOWN, not last-CHECKED.
        outcome = "failed";
      }
      if (team.status === "fulfilled") {
        setTeamShifts(team.value.data || []);
      }
      if (open.status === "fulfilled") {
        setOpenShifts(Array.isArray(open.value.data) ? open.value.data : []);
      }
      // Same fail-honest rule as the schedule leg: on a failed fetch KEEP the
      // previous value. A stale-but-true "38 booket" beats a fabricated 0 —
      // and 0 would read as "quiet night" to someone about to walk into 38.
      if (covers.status === "fulfilled") {
        setCoversByShift(coversMapFrom(covers.value.data));
      }
      return outcome;
    });

  }, [token]);


  // Hours are fetched separately from the rest: they are the one panel with a
  // caller-chosen window, so they refetch when the staffer picks a period
  // without re-pulling the schedule, covers and open shifts behind it.
  const [hoursError, setHoursError] = useState(null);
  const [hoursLoading, setHoursLoading] = useState(false);
  const hoursSeq = useRef(0);

  const loadHours = useCallback(() => {
    const q = hoursRange ? `?start=${hoursRange.start}&end=${hoursRange.end}` : "";
    // Sequence guard: the retry interceptor can make an earlier request land
    // AFTER a later one, and the earlier one describes a window the staffer has
    // already moved off. Only the newest request may write.
    const seq = ++hoursSeq.current;
    setHoursLoading(true);
    portalApi.get(`/portal/${token}/hours${q}`)
      .then((res) => {
        if (seq !== hoursSeq.current) return;
        setHoursData(res.data);
        setHoursError(null);
      })
      .catch((err) => {
        if (seq !== hoursSeq.current) return;
        // Never swallow this. The staffer picked a window and closed a sheet;
        // if we drop the failure they are left reading the PREVIOUS period's
        // numbers under the PREVIOUS period's label, with nothing on screen
        // saying so — the tap looks like it did nothing, and the rejected
        // window stays selected so every later refetch fails the same way.
        setHoursError(err?.response?.data?.detail || true);
      })
      .finally(() => { if (seq === hoursSeq.current) setHoursLoading(false); });
  }, [token, hoursRange]);

  useEffect(() => {
    if (pinVerified && info) loadHours();
  }, [pinVerified, info, loadHours]);

  // Pull-to-refresh. The portal is the screen a staffer checks BEFORE leaving
  // the house, so "did this actually reload?" is a real question — and the
  // honest answer includes "yes, and nothing had changed". Without that, a
  // refresh that finds no news is indistinguishable from a refresh that never
  // ran, and people pull again.
  // "failed" is the honest third answer: we tried, we could not reach the
  // schedule, and what you are looking at is the last KNOWN roster — not a
  // confirmed-current one.
  const [pullState, setPullState] = useState(null);   // null | "pulling" | "busy" | "same" | "new" | "failed"
  // Mirrors read by the touch listeners, which must outlive a state change —
  // see the dep-array note on the effect below.
  const pullBusy = useRef(false);
  const doRefreshRef = useRef(null);
  const pullY = useRef(0);

  const doRefresh = useCallback(async () => {
    setPullState("busy");
    // Anything that is not a clean answer from the schedule leg is "failed" —
    // including a synchronous throw out of loadData itself, which is why the
    // call is inside the try rather than handed to a trailing .catch().
    let outcome;
    try {
      outcome = await loadData();
    } catch {
      outcome = "failed";
    }
    loadHours();
    setPullState(outcome === "changed" ? "new" : outcome === "failed" ? "failed" : "same");
    // The failure chip has to survive being read: it is the one message the
    // staffer must actually act on (pull again / find signal), and it lands on
    // a screen that otherwise looks perfectly normal.
    setTimeout(() => setPullState(null), outcome === "failed" ? 4000 : 2200);
  }, [loadData, loadHours]);
  useEffect(() => { pullBusy.current = pullState === "busy"; }, [pullState]);
  useEffect(() => { doRefreshRef.current = doRefresh; }, [doRefresh]);

  useEffect(() => {
    if (!(pinVerified && info)) return;
    const el = document.querySelector(".full-height.scrollable");
    if (!el) return;                       // shell not mounted yet
    let startY = null;

    const onStart = (e) => {
      // Only arm at the very top, else this fights normal scrolling.
      startY = el.scrollTop <= 0 ? e.touches[0].clientY : null;
      pullY.current = 0;
    };
    const onMove = (e) => {
      if (startY === null || pullBusy.current) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0 && el.scrollTop <= 0) {
        pullY.current = dy;
        if (dy > 12) setPullState((p) => (p === null ? "pulling" : p));
      }
    };
    const onEnd = () => {
      const dy = pullY.current;
      startY = null;
      pullY.current = 0;
      if (dy > 70) doRefreshRef.current?.();
      else setPullState((p) => (p === "pulling" ? null : p));
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
    // `pullState` and `doRefresh` are DELIBERATELY not deps. Crossing the 12px
    // threshold sets pullState to "pulling", which re-ran this effect, tore the
    // listeners down and rebuilt them — and `startY`, a plain closure variable,
    // came back null with the finger still down. Every later touchmove bailed
    // on `startY === null`, so `pullY.current` froze at ~13px and the touchend
    // test `dy > 70` could never pass. Pull-to-refresh looked implemented,
    // rendered its own "Release to refresh" label, and had never once fired.
    // Reading both through refs keeps the listeners bound for the whole gesture.
  }, [pinVerified, info]);

  // Same-length window immediately before the one on screen, so "vs last
  // period" compares like with like even when the owner runs a 15–14 cycle.
  //
  // FAIL CLOSED: a server that does not understand start/end answers with the
  // CURRENT period instead. That would make the delta compute to zero and
  // render as "no change" — stating a fact we do not have. So we only trust
  // the payload when it comes back describing the window we actually asked
  // for; anything else leaves the comparison hidden.
  const [prevTotal, setPrevTotal] = useState(null);
  useEffect(() => {
    if (!(pinVerified && info) || !hoursData?.period_start || !hoursData?.period_end) return;
    const ps = new Date(`${hoursData.period_start}T00:00:00`);
    const pe = new Date(`${hoursData.period_end}T00:00:00`);
    const span = Math.round((pe - ps) / 86400000) + 1;
    const prevEnd = new Date(ps); prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - span + 1);
    const iso = (d) => d.toLocaleDateString("sv-SE");
    const [a, b] = [iso(prevStart), iso(prevEnd)];
    let cancelled = false;
    setPrevTotal(null);   // clear FIRST: the old value describes the old window
    portalApi.get(`/portal/${token}/hours?start=${a}&end=${b}`)
      .then((res) => {
        if (cancelled) return;
        const sameWindow = res.data?.period_start === a && res.data?.period_end === b;
        const sameBasis =
          (res.data?.hours_source || "schedule") === (hoursData.hours_source || "schedule");
        setPrevTotal(sameWindow && sameBasis ? Number(res.data.total_hours) : null);
      })
      .catch(() => { if (!cancelled) setPrevTotal(null); });
    return () => { cancelled = true; };
  }, [token, pinVerified, info, hoursData?.period_start, hoursData?.period_end, hoursData?.hours_source]);

  useEffect(() => {
    if (pinVerified && info) loadData();
  }, [pinVerified, info, loadData]);

  // Refetch on the app-wide freshness signal — e.g. after a clock-out, so the
  // just-logged shift shows in "My hours" (recent_clocked) without a reload.
  useEffect(() => {
    if (!(pinVerified && info)) return;
    const onChanged = () => { loadData(); loadHours(); };
    window.addEventListener("bonbox-data-changed", onChanged);
    return () => window.removeEventListener("bonbox-data-changed", onChanged);
  }, [pinVerified, info, loadData, loadHours]);

  // NOTE on old installed PWAs: the manifest used to ship a "?tab=tips"
  // shortcut. "tips" is no longer in the deep-link allow-list above, so such a
  // link already resolves to "schedule" — no special handling needed.

  // 2c. Chat unread badge — poll the cheap count endpoint so the "Beskeder"
  // nav dot lights up when the owner writes. While the Messages tab is open
  // the server marks read on each fetch, so we just hold the badge at 0.
  useEffect(() => {
    if (!(pinVerified && info)) return;
    let cancelled = false;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      portalApi
        .get(`/portal/${token}/chat/unread`)
        .then((res) => {
          if (!cancelled) setChatUnread(res.data?.unread || 0);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, tab === "messages" ? 8000 : 25000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pinVerified, info, tab, token]);

  // 2d. Byt badge — the requests that wait on this staffer's answer, read
  // from the inbox endpoint the Byt tab already uses (no endpoint of its
  // own). Once a minute while the app is in view, and again when it comes
  // back into view; on the Byt tab the tab's own read updates it too
  // (onInbox). Bounded so the route's 30/min per-address limit stays far off
  // for a whole team on one wifi. A failed read keeps the last count.
  const portalReady = Boolean(pinVerified && info);
  useEffect(() => {
    if (!portalReady) return;
    let cancelled = false;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      portalApi
        .get(`/portal/${token}/swap-requests`)
        .then((res) => {
          if (!cancelled) setSwapAsks(countNeedsMyAnswer(res?.data));
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 60000);
    const onVis = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [portalReady, token]);

  // 2e. Realtime stream (Phase 2) — instant push the moment the owner
  // publishes: on a "schedule_published" nudge we refetch immediately
  // (loadData diffs + toasts as usual). The 20s/60s poll below is the
  // fallback, so the stream is pure speed, never a correctness dependency.
  // usePortalStream reopens a stream the browser gave up on (an error status
  // while the server restarts, the 429 stream cap) with backoff, and starts a
  // fresh one whenever the staffer comes back to the app — the "Offline/no
  // Live until relaunch" report after hours idle.
  const onStreamPublished = useCallback(() => { loadData(); loadHours(); }, [loadData, loadHours]);
  const liveConnected = usePortalStream({
    enabled: Boolean(pinVerified && info),
    url: token ? `${portalApi.defaults?.baseURL || ""}/portal/${token}/stream` : null,
    onPublished: onStreamPublished,
  });

  // 2b. Refetch triggers — keep the schedule fresh without any realtime deps.
  // All gated on pinVerified && info, all cleaned up on unmount.
  //   • visibilitychange → refetch when the tab/app becomes visible again
  //     (the "came back after hours away" case — the biggest freshness win).
  //   • online → refetch the moment connectivity returns; track isOnline so
  //     the pill can show the truth.
  //   • native 'resume' → the same as visibilitychange, in case the web view
  //     does not report it after a long suspend.
  //   • setInterval(~20s) → background poll, but ONLY while the tab is
  //     visible (respects the 30/min API rate-limit; 20s ≈ 3/min).
  useEffect(() => {
    if (!(pinVerified && info)) return;

    // Hours are fetched separately (they carry a caller-chosen window), so
    // every refresh trigger has to drive BOTH or they drift apart.
    const refreshAll = () => { loadData(); loadHours(); };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Re-read the hint on the way back in; the refetch then settles it
      // (a schedule answer sets isOnline true — see loadData).
      if (typeof navigator !== "undefined" && navigator.onLine !== false) setIsOnline(true);
      refreshAll();
    };
    const onOnline = () => {
      setIsOnline(true);
      refreshAll();
    };
    const onOffline = () => setIsOnline(false);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    let resumeSub = null;
    if (isNativeApp()) {
      try { resumeSub = CapApp.addListener("resume", onVisible); } catch { /* plugin missing */ }
    }

    const pollId = setInterval(() => {
      if (document.visibilityState === "visible") refreshAll();
    }, liveConnected ? 60000 : 20000);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      Promise.resolve(resumeSub).then((l) => l?.remove?.()).catch(() => {});
      clearInterval(pollId);
    };
  }, [pinVerified, info, loadData, loadHours, liveConnected]);

  // 2c. Freshness ticker — re-render the pill every 15s so "Synced" decays to
  // "Synced HH:MM" as data ages, independent of any fetch.
  useEffect(() => {
    if (!(pinVerified && info)) return;
    const id = setInterval(() => setFreshnessTick((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, [pinVerified, info]);

  // 2d. Auto-dismiss the "Schedule updated" toast ~5s after it appears.
  useEffect(() => {
    if (!scheduleUpdated) return;
    const id = setTimeout(() => setScheduleUpdated(false), 5000);
    return () => clearTimeout(id);
  }, [scheduleUpdated]);

  // Browser-tab / share title — genuine + restaurant-branded (not the generic
  // marketing <title>). Uses the owner's trading name; reverts on unmount.
  useEffect(() => {
    if (!info?.restaurant_name) return;
    const prev = document.title;
    document.title = t("portalDocTitle", "Your schedule · {restaurant}", {
      restaurant: info.restaurant_name,
    });
    return () => { document.title = prev; };
  }, [info, t]);

  // The Vagtplan tab favicon + apple-touch-icon. index.html swaps them while
  // parsing when the first page is /s/<token>; a staffer who came in via /join
  // reached this page by SPA navigation, so the owner's icons were still in
  // the head (and iOS Add to Home Screen would take the owner's). Same swap
  // here, undone on unmount — a no-op when the head script already did it.
  useEffect(() => {
    if (!token) return undefined;
    return applyVagtplanIcons();
  }, [token]);

  // Per-staff PWA manifest + iOS home-screen name.
  //
  // PLATFORM SPLIT (set by the inline <head> script in index.html, which is
  // the authority for which manifest the browser binds to on first paint):
  //
  //   • iOS  → we deliberately ship NO <link rel="manifest"> on /s/ routes.
  //            iOS Safari's Add-to-Home does NOT honor a manifest href changed
  //            by JS after the initial parse; with no manifest it bookmarks the
  //            CURRENT page URL (= /s/<slug>/<token>) — which is what we want.
  //            So on iOS we MUST NOT create/restore a manifest link here (doing
  //            so re-introduces the "icon opens /" bug). We only set the
  //            apple-mobile-web-app-title, which iOS uses as the icon label.
  //   • non-iOS (Android/desktop Chrome) → keep the per-staff manifest pointed
  //            at THIS staff's lang-aware manifest so an install yields a
  //            separate, schedule-branded app (start_url /s/<token>), not the
  //            generic owner app.
  //
  // window.__BONBOX_IS_IOS is set by that inline script; default to false on
  // SSR / unexpected absence so Android/desktop behavior is the safe fallback.
  useEffect(() => {
    if (!token || typeof document === "undefined") return;
    const isIOS = typeof window !== "undefined" && window.__BONBOX_IS_IOS === true;

    // --- Manifest: non-iOS only. On iOS we never touch the manifest link. ---
    let link = null;
    let prevHref = null;
    let createdLink = false;
    if (!isIOS) {
      link = document.querySelector('link[rel="manifest"]');
      prevHref = link?.getAttribute("href") ?? null;
      if (!link) {
        // The inline script writes the per-staff manifest before React mounts,
        // but if it's somehow absent on a non-iOS staff route, create it so
        // Chrome installability still arms.
        link = document.createElement("link");
        link.setAttribute("rel", "manifest");
        document.head.appendChild(link);
        createdLink = true;
      }
      link.setAttribute("href", `/portal/${token}/app.webmanifest?lang=${lang || "da"}`);
    }

    // --- apple-mobile-web-app-title: both platforms. On iOS this is the icon
    //     label for the Add-to-Home bookmark of /s/<token>. ---
    const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    const prevApple = apple?.getAttribute("content") ?? null;
    if (apple && info?.restaurant_name) apple.setAttribute("content", info.restaurant_name);

    return () => {
      // Restore the manifest for the next route (owner app uses /manifest.json).
      if (link) {
        if (createdLink) {
          if (link.parentNode) link.parentNode.removeChild(link);
        } else if (prevHref) {
          link.setAttribute("href", prevHref);
        }
      }
      if (apple && prevApple) apple.setAttribute("content", prevApple);
    };
  }, [token, info, lang, t]);

  // Loading state
  if (loading) return <PortalOpening />;

  // Error state — see the token-validation catch. {transient} is "we could
  // not reach the server" (link kept, retry offered); anything else is the
  // dead-link screen.
  if (error?.transient) {
    return (
      <PortalOffline
        kind={error.kind}
        busy={retrying}
        onRetry={() => { setRetrying(true); setValidateKey((k) => k + 1); }}
      />
    );
  }
  if (error) return <PortalError message={error.text} expected={error.expected} />;

  // PIN gate
  if (info?.has_pin && !pinVerified) {
    return <PinGate token={token} staffName={info.staff_name} onVerified={() => {
      setPinVerified(true);
      // Re-fetch now that the PIN proof is stored (PinGate stores it before
      // calling this). The validate endpoint gates the staffer's contact PII
      // (email/phone/home address) behind pin_ok, so the pre-PIN `info` has
      // them null — hydrate the real values so the profile + address editor
      // don't show (or save) blanks.
      portalApi.get(`/portal/${token}`).then((r) => setInfo(r.data)).catch(() => { /* keep pre-PIN info */ });
    }} />;
  }

  const handleContactSave = async () => {
    setEmailSaving(true);
    setEmailMsg("");
    setEmailStatus(null);
    try {
      const res = await portalApi.put(`/portal/${token}/email`, {
        email: emailInput.trim(),
        phone: phoneInput.trim(),
        address: addressInput.trim(),
        postal_code: postalInput.trim(),
        city: cityInput.trim(),
      });
      setInfo({
        ...info,
        email: res.data.email,
        phone: res.data.phone,
        address: res.data.address,
        postal_code: res.data.postal_code,
        city: res.data.city,
      });
      setEmailStatus("ok");
      setEmailMsg(t("portalSaved", "Saved"));
      setTimeout(() => { setEmailMsg(""); setEmailStatus(null); setShowEmailEdit(false); }, 1500);
    } catch (err) {
      setEmailStatus("err");
      setEmailMsg(portalErrText(err, t, t("portalSaveFailed", "Couldn't save"), lang));
    } finally {
      setEmailSaving(false);
    }
  };

  // The amber strip's one rule (see the header): offline, or out of date —
  // the last schedule answer is older than 45 s and no live stream covers it.
  // The 15 s freshness tick re-renders this as the data ages.
  const showStaleStrip = !isOnline || (
    schedState === "ok" && !liveConnected && !!lastSynced
    && Date.now() - lastSynced.getTime() > 45000
  );

  return (
    // full-height + scrollable = one fixed app-shell with a single internal
    // momentum scroller (‑webkit-overflow-scrolling + overscroll containment).
    // Replaces min-h-screen BODY scroll, which rubber-bands on iOS WKWebView
    // and makes the sticky header + fixed bottom nav feel loose. The nav and
    // chat composer stay position:fixed (viewport-pinned) — .scrollable has no
    // transform, so it doesn't trap them.
    <div
      className="full-height scrollable text-gray-900 pb-24"
      /* pb-24 clears the tab bar; while the cookie banner sits on it, the
         scroller pads by the banner too (--bb-consent-h, CookieConsent.jsx). */
      onScroll={(e) => {
        const scrolled = e.currentTarget.scrollTop > 4;
        if (scrolled !== headerScrolled) setHeaderScrolled(scrolled);
      }}
      style={{
        // The canvas's ivory ground, on every tab.
        background: IVORY,
        // v3: the dock (52) + its lift (8 over the home-indicator inset) + 16
        // of air.
        paddingBottom: BAR_V3
          ? "calc(76px + env(safe-area-inset-bottom, 0px) + var(--bb-consent-h, 0px))"
          : "calc(6rem + var(--bb-consent-h, 0px))",
        // Where scrollIntoView may put things: below the sticky header (56 +
        // the notch) and above the floating tab bar. Without it the sick-call
        // form's Send button landed under the bar.
        scrollPaddingTop: "calc(68px + env(safe-area-inset-top, 0px))",
        scrollPaddingBottom: BAR_V3
          ? "calc(76px + env(safe-area-inset-bottom, 0px))"
          : "calc(6rem + env(safe-area-inset-bottom, 0px))",
        ...(kbShell > 0 ? { height: `calc(100dvh - ${kbShell}px)` } : {}),
      }}
    >
      {/* Header — sticks to the top of the internal scroller. Uses .glass-static
          (no translateZ) so the sticky header doesn't wobble during momentum
          scroll on iOS. */}
      {/* Canvas "Pine, ivory & brass": ivory glass (90%, the same blur), and
          a hairline only once the page has scrolled — at rest the header is
          the page. The border box is always there (transparent at rest), so
          the hairline never shifts anything. Still no transform on the
          sticky header. */}
      <div
        className="sticky top-0 z-10 glass-static pt-[env(safe-area-inset-top)]"
        data-testid="portal-header"
        style={{ background: "rgba(246,244,238,0.9)", borderBottom: `1px solid ${headerScrolled ? LINE : "transparent"}` }}
      >
        {/* Opaque cap over the status-bar / notch inset. The header glass is
            translucent, so without this the content scrolling underneath
            bleeds up into the status bar — this keeps the notch clean and the
            scroll transition crisp. Sized to the safe-area inset. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0"
          style={{ height: "env(safe-area-inset-top)", background: IVORY }}
        />
        {/* Home v3 (Nov 2026): ONE 52 px row — avatar (opens the profile),
            title, bell. The venue name moved into the next-shift card, and
            the always-on "Live" word is gone: it was colour on every screen
            saying nothing actionable. What replaces it speaks only when it
            matters — the amber strip below, shown while the app is offline
            or its data is out of date. The location chip stays, but only
            for someone who works in more than one place. */}
        {/* Canvas "Pine, ivory & brass": ONE 56 px row — the avatar (pine,
            a brass ring; opens the profile), the date over "Min vagtplan",
            the bell. The date line is the home's: other tabs, and the home
            once scrolled, show the title alone. */}
        <div className="max-w-lg mx-auto flex items-center" style={{ height: 56, gap: 12, padding: "0 20px" }} data-testid="portal-header-row">
          <button
            type="button"
            onClick={() => { setShowEmailEdit(!showEmailEdit); setEmailInput(info?.email || ""); setPhoneInput(info?.phone || ""); setAddressInput(info?.address || ""); setPostalInput(info?.postal_code || ""); setCityInput(info?.city || ""); setEmailMsg(""); setEmailStatus(null); }}
            // overflow-hidden lives on the INNER circle: on the button it
            // clipped the -inset-1 ::before, so the hit area was the circle.
            className="relative rounded-full flex items-center justify-center vp-press before:absolute before:-inset-1 before:content-['']"
            // minHeight 0: the touch-screen 44 px min-height (index.css) drew
            // this as an oval; the ::before is the 48 px hit area.
            style={{
              width: 40, height: 40, minHeight: 0, flex: "none",
              background: PINE, color: CREAM,
              font: `700 14px/1 ${SORA}`, letterSpacing: "0.02em",
              boxShadow: `0 0 0 2px ${IVORY}, 0 0 0 3.5px ${BRASS}`,
            }}
            title={t("portalEditContact", "Edit profile")}
          >
            <span className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
              {photoUrl ? (
                <img src={photoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                info?.staff_name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
              )}
            </span>
          </button>
          <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 1 }}>
            {tab === "schedule" && !headerScrolled && (
              <p data-testid="portal-header-date" className="truncate" style={{ margin: 0, font: "500 12px/1.3 var(--font-text)", color: MUTED }}>
                {fmtHeaderDate(lang)}
              </p>
            )}
            <h1 className="min-w-0" style={{ margin: 0, font: `700 20px/1.2 ${SORA}`, letterSpacing: "-0.02em", color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {tab === "schedule" ? t("portalTitleSchedule", "My schedule")
                // The dock's own word for this tab (v3: "Fravær"); the old
                // bars still say "Kan ikke" in the dock, so their title does.
                : tab === "availability" ? (BAR_V3 ? t("portalTabTimeOff", "Time off") : t("portalTitleKanIkke", "Availability"))
                : tab === "messages" ? t("portalTitleMessages", "Messages")
                : tab === "swaps" ? t("portalTitleSwaps", "Swaps")
                : tab === "hours" ? t("portalTitleHours", "My hours")
                : t("portalTitleAlerts", "Alerts")}
            </h1>
          </div>
          {/* Location switcher. Only for someone who actually works in more
              than one place — a single location gets nothing rather than a
              chip that cannot switch anywhere (the venue name is on the
              card). */}
          {departments.length > 1 && (
            <button
              type="button"
              onClick={() => setDeptOpen(true)}
              aria-label={t("portalDepartment", "Location")}
              style={{
                display: "flex", alignItems: "center", gap: 6, height: 32,
                padding: "0 10px 0 9px",
                borderRadius: 999,
                background: CARD,
                border: `1px solid ${LINE}`,
                flex: "none",
              }}
            >
              <span style={{ font: "600 11.5px/1 var(--font-text)", color: INK, letterSpacing: "-0.005em", maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {dept || t("portalAllDepartments", "All")}
              </span>
              <ChevronDown size={11} strokeWidth={2.4} style={{ color: MUTED, flex: "none" }} />
            </button>
          )}
          {/* Alerts bell — replaces the Alerts nav tab. 44 px, radius 14, the
              unread count a pine badge (canvas). */}
          <button
            type="button"
            onClick={() => setTab("alerts")}
            aria-label={t("navAlerts", "Alerts")}
            aria-current={tab === "alerts" ? "page" : undefined}
            className="relative flex-none flex items-center justify-center vp-press focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/40"
            style={{
              width: 44, height: 44, minHeight: 0, borderRadius: 14, boxSizing: "border-box",
              border: `1px solid ${tab === "alerts" ? PINE : LINE}`,
              background: tab === "alerts" ? PINE : CARD,
              color: tab === "alerts" ? CREAM : INK,
            }}
          >
            <Bell size={20} strokeWidth={1.75} aria-hidden />
            {alertsUnread > 0 && tab !== "alerts" && (
              <span
                className="absolute z-10 inline-flex items-center justify-center"
                style={{
                  top: 6, right: 6, minWidth: 16, height: 16, padding: "0 4px", boxSizing: "border-box", borderRadius: 8,
                  background: PINE, color: CREAM, font: "700 10px/1 var(--font-text)", boxShadow: `0 0 0 2px ${CARD}`,
                }}
                aria-label={t("portalAlertsUnreadBadge", "Unread updates")}
              >
                {alertsUnread > 9 ? "9+" : alertsUnread}
              </span>
            )}
          </button>
        </div>
        {/* Offline / out-of-date strip. Speaks ONLY when the screen may not
            be current: the phone is offline, or the last schedule answer is
            more than 45 s old with no live stream (the 20 s poll has failed
            at least twice). Falls toward failure, never toward fake-live: a
            schedule answer is what clears it (loadData sets isOnline). */}
        {pinVerified && info && showStaleStrip && (
          <div
            role="status"
            data-testid="portal-offline-strip"
            className="flex items-center justify-center"
            style={{ gap: 6, minHeight: 32, padding: "4px 16px", background: "#FEF3C7", borderTop: "1px solid #FDE68A", font: "600 12px/1.3 var(--font-text)", color: "#92400E" }}
          >
            <CloudOff size={13} strokeWidth={2.5} aria-hidden className="shrink-0" />
            <span>{!isOnline ? t("portalOfflineStrip", "Offline – showing last update") : t("portalStaleStrip", "Couldn't refresh – showing the last update")}</span>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={() => { loadData(); loadHours(); }}
              // minHeight 0 keeps the strip ~32 px (the touch-screen 44 px
              // min-height made it 53 and doubled the header); the 14 px
              // ::before gives the word a 44 px tall hit area.
              className="relative underline underline-offset-2 before:absolute before:-inset-x-3 before:-inset-y-[14px] before:content-['']"
              style={{ minHeight: 0, font: "700 12px/1.3 var(--font-text)", color: "#92400E" }}
            >
              {t("portalOfflineRefresh", "Refresh")}
            </button>
          </div>
        )}
        {photoSheet.mounted && createPortal(
          <div className="fixed inset-0 z-[60] m-0 flex items-end vp-scrim" style={{ background: "rgba(8,14,22,.45)" }} onClick={() => setPhotoMenu(false)} {...closingProps(photoSheet.closing)}>
            <div
              role="dialog"
            aria-modal="true"
            aria-label={t("portalPhotoLabel")}
            className="w-full bg-white vp-sheet"
              style={{ borderRadius: "24px 24px 0 0", padding: "18px 16px calc(18px + env(safe-area-inset-bottom))" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mx-auto" style={{ width: 38, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
              <div style={{ marginTop: 14, font: "700 17px/1.2 var(--font-display)", color: "#0f172a" }}>
                {t("portalPhotoLabel", "Photo")}
              </div>
              <div style={{ marginTop: 6, font: "400 12px/1.45 var(--font-text)", color: "#64748b" }}>
                {t("portalPhotoWhoSees", "Your manager and the colleagues on your shifts can see this.")}
              </div>
              <div className="flex flex-col" style={{ gap: 8, marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => { setPhotoMenu(false); handlePhotoChange(); }}
                  className="w-full flex items-center"
                  style={{ gap: 10, padding: "14px 15px", borderRadius: 16, background: "#f5f8fb", border: "1px solid #e8edf3", font: "600 13px/1 var(--font-text)", color: "#0f172a" }}
                >
                  <CameraIcon size={16} strokeWidth={2} aria-hidden />
                  {photoUrl ? t("portalPhotoChange", "Change") : t("portalPhotoAdd", "Add photo")}
                </button>
                {photoUrl && (
                  <button
                    type="button"
                    onClick={() => { setPhotoMenu(false); handlePhotoRemove(); }}
                    className="w-full flex items-center"
                    style={{ gap: 10, padding: "14px 15px", borderRadius: 16, background: "#fff", border: "1px solid #fecaca", font: "600 13px/1 var(--font-text)", color: "#b91c1c" }}
                  >
                    <Trash2 size={16} strokeWidth={2} aria-hidden />
                    {t("portalPhotoRemove", "Remove photo")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setPhotoMenu(false)}
                  className="w-full"
                  style={{ padding: "12px 0", font: "600 13px/1 var(--font-text)", color: "#64748b" }}
                >
                  {t("cancel", "Cancel")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        {deptSheet.mounted && createPortal(
          <div className="fixed inset-0 z-50 m-0 flex items-end vp-scrim" style={{ background: "rgba(8,14,22,.45)" }} onClick={() => setDeptOpen(false)} {...closingProps(deptSheet.closing)}>
            <div
              role="dialog"
            aria-modal="true"
            aria-label={t("portalDepartment")}
            className="w-full bg-white vp-sheet"
              style={{ borderRadius: "24px 24px 0 0", padding: "18px 16px calc(18px + env(safe-area-inset-bottom))" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mx-auto" style={{ width: 38, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
              <div style={{ marginTop: 14, font: "700 17px/1.2 var(--font-display)", color: "#0f172a" }}>
                {t("portalDepartment", "Department")}
              </div>
              <div className="flex flex-col" style={{ gap: 8, marginTop: 14 }}>
                {[{ name: null, label: t("portalAllDepartments", "All"), n: shifts.length }, ...departments.map((d) => ({ name: d.name, label: d.name, n: d.n }))].map((d) => {
                  const on = dept === d.name;
                  return (
                    <button
                      key={d.name || "__all"}
                      type="button"
                      onClick={() => { setDept(d.name); setDeptOpen(false); }}
                      className="flex items-center justify-between"
                      style={{
                        gap: 10, padding: "13px 14px", borderRadius: 16, textAlign: "left",
                        background: on ? "linear-gradient(180deg,#1e293b,#0f172a)" : "#f5f8fb",
                        border: `1px solid ${on ? "transparent" : "#e8edf3"}`,
                      }}
                    >
                      <span style={{ font: "600 13px/1.2 var(--font-text)", color: on ? "#fff" : "#0f172a" }}>{d.label}</span>
                      {/* The count is the honest reason to pick one. */}
                      <span style={{ font: "500 11px/1 var(--font-text)", color: on ? "rgba(255,255,255,.55)" : "#94a3b8" }}>
                        {d.n === 1
                          ? t("portalDeptShiftCountOne", "{n} shift", { n: 1 })
                          : t("portalDeptShiftCount", "{n} shifts", { n: d.n })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}

        {/* Profile / contact edit — a bottom-sheet overlay portaled to <body>.
            Previously it rendered INSIDE this sticky header, which made the
            header taller than the viewport and made the schedule scroll oddly
            behind it. As an overlay it has its own scroll + a tap-out backdrop
            and never disturbs the main scroll. */}
        {profileSheet.mounted && createPortal((
          <div className="fixed inset-0 z-[60] m-0 flex flex-col justify-end" role="dialog" aria-modal="true" style={KB_LIFT_STYLE} {...closingProps(profileSheet.closing)}>
            <button
              type="button"
              aria-label={t("close", "Close")}
              onClick={() => setShowEmailEdit(false)}
              className="absolute inset-0 bg-[#080e16]/50 backdrop-blur-[2px] vp-scrim"
            />
            <div className="relative w-full max-w-lg mx-auto bg-white rounded-t-2xl shadow-soft-lg max-h-[90dvh] overflow-y-auto overscroll-contain vp-sheet">
              <div className="sticky top-0 bg-white/95 flex items-center justify-between px-4 pt-4 pb-2 border-b border-[#f1f5f9]">
                <h2 className="text-base font-bold text-gray-900">{t("portalEditContact", "Edit profile")}</h2>
                <button
                  type="button"
                  onClick={() => setShowEmailEdit(false)}
                  aria-label={t("close", "Close")}
                  className="w-11 h-11 -mr-2.5 rounded-full inline-flex items-center justify-center text-gray-500 hover:bg-gray-100 vp-press"
                >
                  <X className="w-5 h-5" strokeWidth={2} aria-hidden />
                </button>
              </div>
              <div className="px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-3">
              {/* Profile photo — staff pick a photo; the owner sees it too. */}
              {/* Flat forest, like the next-shift card (home v3, Nov 2026). */}
              <div
                className="relative flex items-center overflow-hidden"
                data-testid="portal-profile-card"
                style={{
                  gap: 14, padding: 19, borderRadius: 22,
                  background: FOREST,
                }}
              >
                <button
                  type="button"
                  onClick={() => setPhotoMenu(true)}
                  disabled={photoBusy}
                  aria-label={photoUrl ? t("portalPhotoChange", "Change") : t("portalPhotoAdd", "Add photo")}
                  className="relative shrink-0 overflow-visible"
                  style={{ width: 62, height: 62 }}
                >
                  <span
                    className="w-full h-full overflow-hidden flex items-center justify-center"
                    style={{
                      borderRadius: 20,
                      background: "rgba(246,244,236,.12)",
                      border: "1px solid rgba(246,244,236,.18)",
                      font: "700 21px/1 var(--font-display)", letterSpacing: "-0.02em", color: PAPER,
                    }}
                  >
                    {photoUrl ? (
                      <img src={photoUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      info?.staff_name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
                    )}
                  </span>
                  {/* The + badge IS the change-photo affordance in v2, so the
                      avatar itself is the button rather than a separate row. */}
                  <span
                    className="absolute flex items-center justify-center"
                    style={{
                      right: -4, bottom: -4, width: 22, height: 22, borderRadius: 99,
                      background: PAPER,
                      border: `2px solid ${FOREST}`, color: FOREST,
                    }}
                  >
                    <Plus size={11} strokeWidth={2.6} aria-hidden />
                  </span>
                </button>
                <div className="relative flex-1 min-w-0">
                  <div style={{ font: "700 21px/1.05 var(--font-display)", letterSpacing: "-0.032em", color: "#fff" }}>
                    {info?.staff_name}
                  </div>
                  <div style={{ marginTop: 6, font: "500 12px/1 var(--font-text)", color: "rgba(255,255,255,.55)" }}>
                    {[info?.role ? roleName(info.role, t) : null, info?.restaurant_name].filter(Boolean).join(" · ")}
                  </div>
                  {info?.since && (
                    <div style={{ marginTop: 10 }}>
                      <span
                        style={{
                          display: "inline-block", padding: "5px 9px", borderRadius: 999,
                          background: "rgba(246,244,236,.10)", border: "1px solid rgba(246,244,236,.2)",
                          font: "600 10px/1 var(--font-text)", color: PAPER,
                        }}
                      >
                        {t("portalSinceJoined", "Since {d}").split("{d}").join(
                          new Date(`${info.since}T00:00:00`).toLocaleDateString(
                            localeFor(lang), { month: "short", year: "numeric" },
                          )
                        )}
                      </span>
                    </div>
                  )}
                  {photoBusy ? (
                    <div style={{ marginTop: 10, font: "600 10px/1 var(--font-text)", color: "rgba(255,255,255,.55)" }}>
                      {t("portalSaving", "Saving…")}
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, font: "600 10px/1 var(--font-text)", color: "rgba(255,255,255,.55)" }}>
                      {photoUrl ? t("portalPhotoChange", "Change") : t("portalPhotoAdd", "Add photo")}
                    </div>
                  )}
                </div>
              </div>
              <div className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8]">{t("portalNotifications", "Notifications")}</div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">{t("portalContactEmailLabel", "Email")}</label>
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder={t("stfEmailPlaceholder", "your@email.com")}
                  className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">{t("portalContactPhoneLabel", "Phone (optional)")}</label>
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="+45 12 34 56 78"
                  className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                />
              </div>
              {/* Home address — DK-structured (adresse / postnr / by). Optional;
                  the owner sees it so they have a current address on file. */}
              <div className="pt-1 border-t border-[#f1f5f9] space-y-3">
                <div className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8]">{t("portalAddressSection", "Address")}</div>
                <div>
                  <label className="text-[10px] text-gray-500 mb-1 block">{t("portalAddressStreetLabel", "Street & number")}</label>
                  <input
                    type="text"
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                    autoComplete="street-address"
                    placeholder={t("portalAddressStreetPlaceholder", "e.g. Nørrebrogade 12, 2. th")}
                    className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                  />
                </div>
                <div className="flex gap-2">
                  <div className="w-24 shrink-0">
                    <label className="text-[10px] text-gray-500 mb-1 block">{t("portalAddressPostalLabel", "Postal code")}</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={postalInput}
                      onChange={(e) => setPostalInput(e.target.value)}
                      autoComplete="postal-code"
                      placeholder="2200"
                      className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-gray-500 mb-1 block">{t("portalAddressCityLabel", "City")}</label>
                    <input
                      type="text"
                      value={cityInput}
                      onChange={(e) => setCityInput(e.target.value)}
                      autoComplete="address-level2"
                      placeholder={t("portalAddressCityPlaceholder", "København N")}
                      className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                    />
                  </div>
                </div>
              </div>

              {/* Bank account — staff-entered, encrypted, owner reads it to pay
                  them. Sits inside the PIN-gated profile editor; the server
                  only ever returns the last 4. */}
              <BankSection token={token} />

              {/* Feriedage under the Ferielov — days earned while BonBox has
                  known them, never posed as a legal entitlement. */}
              <HolidaySection token={token} />

              {/* Employment documents the owner has shared. Renders nothing
                  when there are none — the staffer cannot request one here, so
                  an empty section would be an empty promise. */}
              <ShiftReminderRow token={token} />
              <DocumentsSection token={token} />

              {/* Language — moved here from the header (design). Staff pick DA / EN. */}
              <div className="pt-3 border-t border-[#f1f5f9]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-gray-900">{t("portalLangSection", "Language")}</div>
                    <div className="text-[11px] text-gray-400">{t("portalLangNote", "Only changes the app's language.")}</div>
                  </div>
                  <div className="flex flex-none rounded-lg border border-gray-200 p-0.5 gap-0.5" role="group" aria-label={t("portalLangLabel", "Language")}>
                    {["da", "en"].map((code) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() => setLang(code)}
                        aria-pressed={lang === code}
                        className={`px-3 py-1.5 rounded-md text-[12px] font-bold uppercase vp-press ${
                          lang === code ? "bg-gray-900 text-white" : "bg-white text-gray-500 hover:bg-gray-50"
                        }`}
                      >
                        {code === "da" ? "DA" : "EN"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <button
                onClick={handleContactSave}
                disabled={emailSaving}
                className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 transition disabled:opacity-50"
              >
                {emailSaving ? t("portalSaving", "Saving…") : t("portalSave", "Save")}
              </button>
              {emailMsg && (
                <div className={`text-xs ${emailStatus === "ok" ? "text-emerald-700" : "text-red-600"}`}>{emailMsg}</div>
              )}
              {/* Only the EMPTY-state hint survives here. The filled version
                  reprinted the email, phone and address as grey read-only
                  lines — the same values sitting in the input boxes half a
                  screen above, which reads as a second, older copy of the
                  data you are editing. The hint still earns its place: it
                  says WHY the fields matter when they are blank. */}
              {!info?.email && !info?.phone && (
                <div className="text-[10px] text-gray-400">
                  {t("portalContactEmptyHint", "Add your email or phone to get notified when your schedule changes.")}
                </div>
              )}
              {/* Native Web Push opt-in moved to the prominent
                  InstallNotifyCard on the Schedule tab — far better
                  discovery than buried behind the avatar. */}
              {/* Disconnect: forget this schedule on THIS phone (saved token
                  + PIN proof) and land on the join screen. Matters for the
                  Scheduler app: a phone that changes workplace needs a way
                  out, and App Review likes an explicit disconnect.
                  NOT cheap to undo: join codes burn on first use
                  (staff_portal.py code_used_at), so getting back needs the
                  link again or a NEW code from the manager — and shift alerts
                  stop. One mis-tap under "Gem" used to do all of that, so it
                  asks first (destructive: focus starts on Annuller). */}
              <div className="pt-1 border-t border-[#f1f5f9]">
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirmDisconnect({
                      title: t("portalDisconnectTitle", "Disconnect this phone?"),
                      message: t("portalDisconnectBody", "You'll stop getting shift alerts. To see your schedule again, you'll need your link or a new code from your manager."),
                      confirmLabel: t("portalDisconnectConfirm", "Disconnect"),
                      destructive: true,
                    });
                    if (ok !== true) return;
                    // Order matters: the unregister call needs the portal
                    // token + PIN proof that are about to be forgotten.
                    await unregisterNativePush(token);
                    try {
                      localStorage.removeItem("bonbox_portal_token");
                      localStorage.removeItem("bonbox_pin_proof");
                    } catch { /* private mode */ }
                    // replace, not href: the portal URL must leave the
                    // history. On Android BACK went back to /s/<token>, which
                    // still loads — and saved the token again, undoing the
                    // disconnect in one press.
                    window.location.replace("/join");
                  }}
                  className="mt-2 min-h-[44px] text-[11px] font-medium text-gray-500 hover:text-gray-700 underline underline-offset-2"
                >
                  {t("portalDisconnect", "Disconnect this phone from the schedule")}
                </button>
              </div>
              </div>
            </div>
          </div>
        ), document.body)}
      </div>

      {/* Pull-to-refresh readout. "same" is the case that matters: a refresh
          that finds no news must SAY so, or it is indistinguishable from one
          that never ran — and people just pull again. "failed" is the case
          that must NEVER be dressed as "same": the shifts below are the last
          known ones, not confirmed-current ones, and only this chip says so. */}
      {pullState && (
        <div
          className="fixed left-0 right-0 z-40 flex justify-center pointer-events-none"
          // Below the status bar: Android draws the page under it (edge to
          // edge, env top 48 px); the iOS shell insets the WebView (env 0).
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
          data-testid="portal-pull-status"
          role="status"
          aria-live="polite"
        >
          <span
            className="inline-flex items-center gap-2"
            style={{
              padding: "7px 13px", borderRadius: 999,
              background: pullState === "new" ? "#dcfce7" : pullState === "failed" ? "#fef3c7" : "#fff",
              border: `1px solid ${pullState === "new" ? "#a7f3d0" : pullState === "failed" ? "#fde68a" : "#e8edf3"}`,
              boxShadow: "0 6px 16px -8px rgba(15,23,42,.4)",
              font: "600 12px/1 var(--font-text)",
              color: pullState === "new" ? "#15803d" : pullState === "failed" ? "#92400e" : "#64748b",
            }}
          >
            {pullState === "busy" && <RefreshCw size={13} strokeWidth={2.5} className="animate-spin" aria-hidden />}
            {pullState === "failed" && <CloudOff size={13} strokeWidth={2.5} aria-hidden />}
            {pullState === "pulling" && t("portalPullRelease", "Release to refresh")}
            {pullState === "busy" && t("portalPullBusy", "Checking…")}
            {pullState === "same" && t("portalPullSame", "Up to date — no changes")}
            {pullState === "new" && t("portalPullNew", "Schedule updated")}
            {pullState === "failed" && t("portalPullFailed", "Couldn't check — showing last known")}
          </span>
        </div>
      )}

      {/* Content — the canvas's 16 px gutters (12 on a 360 px phone and
          under); the home starts 8 under the header. */}
      {/* Keyed by tab: a switch mounts the new screen with a short rise +
          fade (vagtplan.css .vp-screen-in; transform + opacity, no layout). */}
      <div key={tab} data-testid="portal-content" className={`max-w-lg mx-auto px-3 min-[361px]:px-4 ${tab === "schedule" ? "pt-2 pb-4" : "py-4"}${nav.moved ? " vp-screen-in" : ""}`}>
        {tab === "schedule" && (
          <ScheduleTab
            shifts={visibleShifts}
            allShifts={shifts}
            coversByShift={coversByShift}
            teamShifts={teamShifts}
            openShifts={openShifts}
            staffName={info?.staff_name}
            token={token}
            restaurantName={info?.restaurant_name}
            restaurantCity={info?.restaurant_city}
            restaurantAddress={info?.restaurant_address}
            // The venue's confirmed pin + map flag (R2). Absent on an older
            // server: the card then falls back to name + address.
            venue={info?.venue}
            onOpenSwaps={() => setTab("swaps")}
            // The venue's vertical, so role→section resolves the same way the
            // owner's schedule maker does. New field on PortalInfo.
            businessType={info?.business_type}
            calendarKey={info?.calendar_key}
            onShiftsChanged={loadData}
            schedState={schedState}
            onRetrySchedule={() => { setSchedState((st) => (st === "ok" ? "ok" : "loading")); loadData(); }}
            staffRole={info?.role}
            focusDate={scheduleFocus}
          />
        )}
        {/* Install/push nudge — BELOW the shift so the schedule leads; a calm
            collapsed line, not a promo card above the fold. */}
        {/* Inside the native Scheduler shell "add to home screen" is
            nonsense — the user IS in the app. Native push arrives with the
            APNs slice; until then the card simply doesn't render there. */}
        {tab === "schedule" && !isNativeApp() && <InstallNotifyCard token={token} />}
        {tab === "availability" && <AvailabilityTab token={token} shifts={visibleShifts} onNavigate={setTab} />}
        {tab === "messages" && (
          <MessagesTab
            token={token}
            restaurantName={info?.restaurant_name}
            onRead={() => setChatUnread(0)}
          />
        )}
        {tab === "swaps" && (
          <SwapTab token={token} ownShifts={shifts} onChanged={loadData} onInbox={(list) => setSwapAsks(countNeedsMyAnswer(list))} />
        )}
        {tab === "hours" && <HoursTab data={hoursData} maxHours={info?.max_hours_month} range={hoursRange} setRange={setHoursRange} prevTotal={prevTotal} hoursError={hoursError} hoursLoading={hoursLoading} onRetry={loadHours} />}
        {tab === "alerts" && (
          <AlertsTab
            token={token}
            onNavigate={(next, refDate) => {
              setScheduleFocus(next === "schedule" && refDate ? { date: refDate, n: Date.now() } : null);
              setTab(next);
            }}
          />
        )}
      </div>

      {/* Bottom Navigation */}
      {/* data-bb-consent-clear: the cookie banner sits on this bar, not over it (CookieConsent.jsx). */}
      {BAR_V3 ? (
      /* v3: the Orvexlo floating dock (vagtplan.css .vp-dock — BeloBag's
         bar). Five equal columns, every tab its icon AND its name; the
         active one dark evergreen, the rest a muted green-grey. ONE sage
         pill (the indicator) slides to the active column on a soft spring —
         it is never re-drawn per tab. The active name pops in. A pine count
         on Beskeder. Fixed, not sticky. Five columns hold at 320 px: ~57 px
         each, names 11 px on one line (they can only ellipsize). */
      <>
      <div
        aria-hidden
        className="fixed inset-x-0 bottom-0 z-10 m-0 pointer-events-none"
        // The canvas's fade: content dissolves into the ivory under the dock.
        style={{ height: aboveDock(42), background: `linear-gradient(to bottom, rgba(246,244,238,0), ${IVORY} 70%)`, ...(dockAway ? { display: "none" } : {}) }}
      />
      <nav data-bb-consent-clear="" aria-label={t("portalTabsLabel", "Tabs")} data-testid="portal-tabbar-v3"
        className="vp-dock"
        data-kb-away={dockAway ? "" : undefined}
        style={{ gridTemplateColumns: `repeat(${DOCK_TABS.length}, minmax(0, 1fr))`, "--n": DOCK_TABS.length, ...(dockAway ? { display: "none" } : {}) }}
      >
        {/* The track clips the pill to the dock's shape when the spring
            overshoots; the dock itself never clips (focus ring, count). */}
        <span aria-hidden className="vp-dock-track" data-testid="portal-dock-track">
          <span
            className="vp-dock-ind"
            data-testid="portal-dock-indicator"
            // On Alerts (the header bell, not a dock tab) the pill fades out
            // where it was, and slides on from there when a tab is chosen.
            {...(dockIdx < 0 ? { "data-hidden": "" } : {})}
            style={{ "--i": nav.idx }}
          >
            <span className="vp-dock-pill" />
          </span>
        </span>
        {DOCK_TABS.map((item) => {
          const active = tab === item.key;
          const label = item.v3LabelKey ? t(item.v3LabelKey, item.v3LabelFallback) : t(item.labelKey, item.labelFallback);
          const Icon = item.V3Icon || item.Icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              aria-current={active ? "page" : undefined}
              data-testid={`portal-tab-${item.key}`}
              className="vp-dock-item focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E3B2E]/40"
            >
              <span className="vp-dock-icon">
                {/* BeloBag: the active icon draws heavier (2.3), the rest 1.9. */}
                <Icon aria-hidden strokeWidth={active ? 2.3 : 1.9} />
                {item.key === "messages" && chatUnread > 0 && (
                  <span
                    key={`n${chatUnread > 9 ? "9+" : chatUnread}`}
                    className="absolute inline-flex items-center justify-center vp-pop"
                    style={{
                      top: -4, right: -9, minWidth: 16, height: 16, padding: "0 4px", boxSizing: "border-box", borderRadius: 8,
                      background: PINE, color: CREAM, font: "700 10px/1 var(--font-text)", boxShadow: "0 0 0 2px #FFFDF9",
                    }}
                    aria-label={t("staffChatUnreadBadge", "Unread messages")}
                  >
                    {chatUnread > 9 ? "9+" : chatUnread}
                  </span>
                )}
                {/* The same pine count on Byt: requests only this staffer
                    can answer. */}
                {item.key === "swaps" && swapAsks > 0 && (
                  <span
                    key={`s${swapAsks > 9 ? "9+" : swapAsks}`}
                    data-testid="portal-swaps-badge"
                    className="absolute inline-flex items-center justify-center vp-pop"
                    style={{
                      top: -4, right: -9, minWidth: 16, height: 16, padding: "0 4px", boxSizing: "border-box", borderRadius: 8,
                      background: PINE, color: CREAM, font: "700 10px/1 var(--font-text)", boxShadow: "0 0 0 2px #FFFDF9",
                    }}
                    aria-label={t("portalSwapAsksBadge", "Swap requests waiting for your answer")}
                  >
                    {swapAsks > 9 ? "9+" : swapAsks}
                  </span>
                )}
              </span>
              <span
                // Re-mounts when the tab becomes active, so the name pops in
                // (not on the page's first paint).
                key={active ? "on" : "off"}
                className={`vp-dock-label${active && nav.moved ? " vp-label-in" : ""}`}
                style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>
      </>
      ) : (
      <nav data-bb-consent-clear="" className={`fixed bottom-0 left-0 right-0 glass border-t border-gray-200/70 z-20${BAR_V2 ? " bb-lg-tabbar" : ""}`} style={dockAway ? { display: "none" } : undefined}>
        <div className="max-w-lg mx-auto flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {TABS.filter(
            // Alerts moved to the header bell (design).
            // Leaves 5 tabs: Schedule · Availability · Messages · Swaps · Hours.
            (item) => item.key !== "alerts",
          ).map((item) => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                aria-current={active ? "page" : undefined}
                className="relative flex flex-col items-center gap-1 px-1.5 sm:px-4 py-1 rounded-lg active:opacity-60"
                style={{
                  // #64748b (slate-500), not #94a3b8 (slate-400). The label is
                  // text-[10px] font-semibold — never "large text" — so WCAG AA
                  // wants 4.5:1. #94a3b8 on this bar measures 2.59:1: a shipped
                  // failure, and nothing to do with the bar material. #64748b is
                  // 4.70:1. Deliberately OUTSIDE the BAR_V2 flag — an
                  // accessibility fix must not be revertible by a cosmetic
                  // toggle. Same hue family, no geometry change.
                  color: active ? "#15803d" : "#64748b",
                  transition: "color 250ms ease",
                }}
              >
                <span className="relative">
                  {/* v2 tab pill — the portal's one recurring touch of colour.
                      Scoped to the icon so it never slices through the label.
                      BonBox green (#16a34a family), not the --brand accent:
                      this is a standalone staff app carrying brand identity,
                      and the accent themes belong to the owner dashboard. */}
                  {active && (
                    <span
                      aria-hidden
                      className={`absolute -inset-x-3.5 -inset-y-[4px] rounded-full${BAR_V2 ? " bb-lg-pill" : ""}`}
                      style={
                        BAR_V2
                          ? undefined
                          : {
                              background: "linear-gradient(180deg,#dcfce7,#bbf7d0)",
                              boxShadow:
                                "inset 0 1px 0 rgba(255,255,255,.8), 0 4px 10px -6px rgba(22,163,74,.7)",
                            }
                      }
                    />
                  )}
                  <item.Icon
                    className="relative z-10 w-[18px] h-[18px]"
                    strokeWidth={active ? 2.25 : 2}
                    aria-hidden
                  />
                  {item.key === "messages" && chatUnread > 0 && (
                    <span
                      className="absolute z-10 -top-1 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-red-600 text-white text-[9px] font-bold leading-[14px] text-center"
                      aria-label={t("staffChatUnreadBadge", "Unread messages")}
                    >
                      {chatUnread > 9 ? "9+" : chatUnread}
                    </span>
                  )}
                  {item.key === "swaps" && swapAsks > 0 && (
                    <span
                      data-testid="portal-swaps-badge"
                      className="absolute z-10 -top-1 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-red-600 text-white text-[9px] font-bold leading-[14px] text-center"
                      aria-label={t("portalSwapAsksBadge", "Swap requests waiting for your answer")}
                    >
                      {swapAsks > 9 ? "9+" : swapAsks}
                    </span>
                  )}
                </span>
                <span className="relative max-w-[64px] truncate text-[10px] font-semibold">
                  {t(item.labelKey, item.labelFallback)}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
      )}

      {/* "Schedule updated" toast — fires only on a REAL change to the
          published schedule after data already existed (never on first load).
          Sits above the bottom nav, notch/safe-area aware, auto-dismisses ~5s.
          Generic by design (Phase 1) — no per-field human diff. */}
      {scheduleUpdated && (
        <div
          className="fixed inset-x-0 z-30 flex justify-center px-4 pointer-events-none"
          style={{ bottom: BAR_V3 ? aboveDock(12) : "calc(5rem + env(safe-area-inset-bottom))" }}
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            onClick={() => { setScheduleUpdated(false); setTab("schedule"); }}
            className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-medium shadow-lg active:scale-[0.98] motion-safe:animate-fadeIn"
          >
            <RefreshCw className="w-4 h-4" strokeWidth={2} aria-hidden />
            {t("portalScheduleUpdated")}
          </button>
        </div>
      )}
    </div>
  );
}
