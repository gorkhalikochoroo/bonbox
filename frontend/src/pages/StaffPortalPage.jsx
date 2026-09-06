/**
 * Staff Portal — what your staff sees when they open their magic link.
 * Mobile-first, dark theme, no login required.
 * Route: /s/:token
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";

import { useConfirm } from "../hooks/useConfirm";
import GeofenceDial from "../components/GeofenceDial";
import { nextShiftCountdown } from "../utils/nextShiftCountdown";
import { overlapsOwnShift } from "../utils/overlapsOwnShift";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import { RefreshCw, CloudOff, Download, FileText, Smartphone, Share, Check, X, Calendar, ArrowLeftRight, Clock, Bell, Lock, AlertTriangle, Mail, BellOff, MessageCircle, MessageSquare, Search, Send, Inbox, Thermometer, StickyNote, MapPin, MapPinOff, CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, Repeat, CalendarOff, Plus, Users, Apple } from "lucide-react";
import { exportToCsv } from "../utils/exportCsv";
import portalApi, { storePinProof } from "../services/portalApi";
import { useLanguage } from "../hooks/useLanguage";
import { sectionFor } from "../config/roleSections";
import { errText } from "../utils/errText";
import { isNativeApp } from "../utils/platform";
import { capturePhoto } from "../utils/camera";
import { Camera as CameraIcon, Trash2 } from "lucide-react";
import { haptic } from "../utils/haptics"; // no-op on web; physical feedback in the iOS shell
import useNativePush, { unregisterNativePush } from "../hooks/useNativePush";
import { PhotoGrid, PendingPhotos, AttachButton, usePhotoPicker } from "../components/staff/chatPhotoKit";

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

function fmtDate(d, lang) {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString(localeFor(lang), { weekday: "short", day: "numeric", month: "short" });
}

function fmtShort(d, lang) {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString(localeFor(lang), { day: "numeric", month: "short" });
}

// Monday-first short weekday names in the chosen language (2024-01-01 = a Monday).
function weekdayNames(lang) {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(localeFor(lang), { weekday: "short" }));
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

// HH:MM in the staff's locale, used by the sync pill's "Synced HH:MM" state.
function fmtClock(d) {
  try {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
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
  // the two surfaces bucket a role identically. Colour still lives here: this
  // app paints floor VIOLET, not the owner grid's emerald, because green is
  // reserved exclusively for live/now (the Live pill, the clocked-in ping) and
  // painting the majority persona green flooded every page with false live
  // signals. Only the SECTION has to agree, never the palette.
  switch (sectionFor(role, businessType)) {
    case "kitchen": return "bg-red-500";
    case "bar": return "bg-blue-500";
    case "floor": return "bg-violet-500";
    case "treatment": return "bg-violet-500";
    case "front": return "bg-blue-500";
    default: return "bg-gray-600";   // genuinely unclassified — no rainbow
  }
}

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

  return (
    <div className="pt-3 border-t border-[#f1f5f9]">
      <div className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8] mb-2">
        {t("portalHolidaySection", "Feriedage")}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[22px] font-bold text-gray-900 tabular-nums leading-none">
          {/* `partial` means the ferieår began before we knew this staffer, so
              what we hold is a floor. A bare 0,0 at 22px bold would read as a
              statement about their entitlement — the one thing it is not. */}
          {h.partial && !h.remaining ? "–" : fmt(h.remaining)}
        </span>
        <span className="text-[12px] text-gray-500">
          {t("portalHolidayUnit", "days")}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-gray-500 tabular-nums">
        {t("portalHolidayBreakdown", "{earned} earned · {taken} taken", {
          earned: fmt(h.earned), taken: fmt(h.taken),
        })}
      </div>
      {/* The honesty line. Without it the number reads as a legal balance. */}
      <div className="mt-1 text-[10px] text-gray-400">
        {t("portalHolidaySince", "Counted from {date} — what BonBox has recorded, not your full entitlement. Your payslip is the authority.", {
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
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.label || "dokument";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick — revoking synchronously can cancel the
      // download on some mobile browsers before it has started.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

      {openSheet && createPortal(
        <div className="fixed inset-0 z-[60] flex items-end" style={{ background: "rgba(8,14,22,.45)" }} onClick={() => setOpenSheet(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("portalDocsSection")}
            className="w-full bg-white"
            style={{ borderRadius: "24px 24px 0 0", padding: "18px 16px calc(18px + env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto" style={{ width: 38, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
            <div style={{ marginTop: 14, font: "700 17px/1.2 var(--font-display)", color: "#0f172a" }}>
              {t("portalDocsSection", "Contract & documents")}
            </div>

            {docs.length === 0 ? (
              <div style={{ marginTop: 10, font: "400 12px/1.5 var(--font-text)", color: "#64748b" }}>
                {t("portalDocsEmpty", "Nothing here yet. Your contract and payslips appear here when your manager shares them.")}
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
      empty: t("portalBankErrEmpty", "Enter both your registreringsnummer and kontonummer."),
      reg_nr_length: t("portalBankErrRegLength", "Registreringsnummer must be exactly 4 digits."),
      account_missing: t("portalBankErrAcctMissing", "Enter your kontonummer."),
      account_length: t("portalBankErrAcctLong", "Kontonummer can be at most 10 digits."),
      account_too_short: t("portalBankErrAcctShort", "That kontonummer looks too short — check it against your bank."),
      account_zero: t("portalBankErrAcctZero", "That isn't a valid kontonummer."),
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
            className="shrink-0 px-3 py-1.5 rounded-lg text-[13px] font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 transition active:scale-[0.98]"
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
    /* v2 treatment. This is the FIRST screen a new staffer ever sees — the
       moment they connect — and it looked like a system prompt while the rest
       of the app looked like BonBox. It now wears the hero's own surface:
       the same 152deg gradient, radius 22, green bloom off the top-right and
       the 1px inset highlight. Nothing about the gate's behaviour changes;
       the PIN is still verified server-side and still mints the proof. */
    <div className="min-h-[100dvh] flex items-center justify-center p-6" style={{ background: "#f5f7fb" }}>
      <div
        className="relative overflow-hidden w-full max-w-xs text-center"
        style={{
          borderRadius: 22,
          padding: "28px 22px 24px",
          background: "linear-gradient(152deg,#1d2a3b 0%,#0f172a 46%,#080e16 100%)",
          boxShadow: "0 24px 46px -26px rgba(4,10,18,.95), inset 0 1px 0 rgba(255,255,255,.13)",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute h-[230px] w-[230px] rounded-full"
          style={{
            top: -90, right: -80,
            background: "radial-gradient(closest-side, rgba(34,197,94,.40), rgba(34,197,94,0))",
          }}
        />
        <div className="relative">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{
              background: "rgba(255,255,255,.08)",
              border: "1px solid rgba(255,255,255,.14)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.18)",
            }}
          >
            <Lock className="w-6 h-6" strokeWidth={2} aria-hidden style={{ color: "#4ade80" }} />
          </div>
          <h1
            className="text-white mb-1.5"
            style={{ font: "700 22px/1.1 var(--font-display)", letterSpacing: "-0.03em" }}
          >
            {t("portalPinTitle", "Enter PIN")}
          </h1>
          <p className="mb-7" style={{ font: "400 12.5px/1.45 var(--font-text)", color: "rgba(255,255,255,.55)" }}>
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
                  color: "#fff",
                  background: "rgba(255,255,255,.07)",
                  border: "1px solid rgba(255,255,255,.16)",
                  borderRadius: 14,
                }}
                autoFocus={i === 0}
              />
            ))}
          </div>
          {error && <p className="text-[13px] mb-3" style={{ color: "#fca5a5" }}>{error}</p>}
          {loading && (
            <p className="text-[13px]" style={{ color: "rgba(255,255,255,.55)" }}>
              {t("portalPinVerifying", "Verifying...")}
            </p>
          )}
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
function SickCallButton({ token, upcomingShifts, onCalledIn, autoOpen = false, onDismiss }) {
  const { t, lang } = useLanguage();
  const [open, setOpen] = useState(autoOpen);
  const todayIso = useState(() => toLocalISO(new Date()))[0];
  const [date, setDate] = useState(todayIso);
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
      setError(errText(err, t("portalSickSendFailed", "Couldn't send. Try again.")));
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
  // backend allows up to 60 but most call-ins are same-day or near.
  const maxIso = toLocalISO(addDaysToDate(new Date(), 14));

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
          {t("portalSickSentTitle", "Sick call registered")}
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
    <div className="rounded-[20px] bg-white border border-[#e8edf3] p-4 space-y-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_32px_-24px_rgba(15,23,42,0.35)]">
      <div className="flex items-center justify-between">
        <div className="font-display text-[14.5px] font-bold tracking-[-0.02em] leading-[1.1] text-gray-900 flex items-center gap-1.5"><Thermometer className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />{t("portalCallInSick", "Call in sick")}</div>
        <button
          onClick={() => { setOpen(false); setError(""); setReason(""); onDismiss?.(); }}
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
          className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 outline-none focus:border-amber-500/40"
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
        {submitting ? t("portalSending", "Sending...") : t("portalSickSubmit", "Send sick call")}
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
 * ConfirmScheduleButton — staff side of the bidirectional notification
 * loop.
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
 *   • Already-confirmed state shows a green pill instead of a button so
 *     re-tapping isn't tempting (still works as no-op idempotent).
 *   • One tap → server returns confirmed_count → small "✓ N shifts
 *     confirmed" inline confirmation that fades after 4s.
 */
function ConfirmScheduleButton({ token, shifts, onConfirmed, onNeedChange, allShifts}) {
  const { t } = useLanguage();
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  // Only show button if there's at least one PUBLISHED shift in the
  // visible window; otherwise nothing to confirm.
  const publishedShifts = shifts.filter((s) => s.status === "published");
  const allConfirmed =
    publishedShifts.length > 0 &&
    publishedShifts.every((s) => !!s.confirmed_at);

  if (publishedShifts.length === 0) return null;

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
        ? `✓ ${t("portalConfirmCount", "{n} shifts confirmed", { n })}`
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
  // is UNTOUCHED. Only the CTA copy + styling change to a calm full-width strip
  // labelled "Jeg har set det". The confirmed state still reads confirmed_at —
  // never an optimistic local flag.
  const needChangeLink = onNeedChange && (
    // Real "request a change" affordance — a tappable pill (not a low-contrast
    // text link), matching the design. Same behavior: reveals sick-call + swaps.
    <div className="mt-2.5 flex justify-center">
      <button
        type="button"
        onClick={onNeedChange}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-gray-200 bg-white text-[13px] font-semibold text-gray-700 shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:bg-gray-50 active:scale-[0.98] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
      >
        {t("portalNeedChange")}
        <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
      </button>
    </div>
  );

  if (allConfirmed) {
    return (
      <div>
        {/* Confirmation is a resting past-state, not an alert — a quiet gray
            line, no fill/border. Green is reserved strictly for "live/now". */}
        <div className="w-full flex items-center justify-center gap-1.5 text-[13px] text-gray-500">
          <Check className="w-4 h-4 shrink-0 text-gray-400" strokeWidth={2.5} aria-hidden />
          <span>{t("portalConfirmedThanks", "You've confirmed this schedule. Thanks!")}</span>
        </div>
        {unconfirmedElsewhere > 0 && (
          <div className="w-full text-center text-[11px] text-amber-700">
            {t("portalConfirmOtherDept", "{n} shifts at another location are still unconfirmed — switch to All.")
              .split("{n}").join(String(unconfirmedElsewhere))}
          </div>
        )}
        {needChangeLink}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="w-full inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold disabled:opacity-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-1"
      >
        {submitting ? "…" : (
          <>
            <Check className="w-4 h-4 shrink-0" strokeWidth={2.5} aria-hidden />
            {t("portalSeenIt")}
          </>
        )}
      </button>
      {feedback && (
        <div className="mt-1.5 text-center text-[12px] text-emerald-600" role="status">
          {feedback}
        </div>
      )}
      {error && (
        <div className="mt-1.5 text-center text-[12px] text-red-500">{error}</div>
      )}
      {needChangeLink}
    </div>
  );
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
// Approximate distance for the "too far" hint — GPS jitters, so always "~" and
// rounded: metres under 1 km, da-DK comma km above (matches the formatKr style).
function fmtDist(m) {
  if (m == null) return "";
  return m < 1000
    ? `~${Math.round(m)} m`
    : `~${(m / 1000).toLocaleString("da-DK", { maximumFractionDigits: 1 })} km`;
}

function useClock(token) {
  const { t } = useLanguage();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(""); // honest clock-out outcome
  // The GPS fix used for the last punch attempt. Held ONLY so a refused punch
  // can draw the direction dial without asking for location a second time.
  // Never sent anywhere, never persisted — it dies with the component.
  const [lastFix, setLastFix] = useState(null);
  const [liveSec, setLiveSec] = useState(null); // live elapsed seconds (ticks 1/s)

  // Snap server state AND the live-second baseline together, so the counter
  // re-anchors to the server's authoritative elapsed_sec on every poll/punch
  // and can never drift away — the +1/sec ticker only smooths the gaps.
  const applySt = useCallback((data) => {
    setSt(data || null);
    setLiveSec(data?.elapsed_sec ?? null);
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
    const id = setInterval(() => setLiveSec((s) => (s == null ? s : s + 1)), 1000);
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
      if (dir === "in" && st?.geofence_on) {
        const pos = await getPos();
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
        const dur = mins >= 60 ? `${Math.floor(mins / 60)}t ${mins % 60}m` : `${mins}m`;
        setResult(
          d.discarded
            ? t("portalClockTooShort", "Too short — nothing logged.")
            : t("portalClockLogged", "Logged · {h}", { h: dur }),
        );
        setTimeout(() => setResult(""), 6000);
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

  const fmtDur = (min) => {
    if (min == null) return "—";
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}t ${m}m` : `${m}m`;
  };

  // Live elapsed: starts at "0s" on clock-in (server returns elapsed_sec≈0),
  // ticks seconds for the first hour (proof it's alive), then calm "Xt Ym".
  const fmtElapsed = (sec) => {
    if (sec == null) return "—";
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}t ${m}m`;
    if (m > 0) return `${m}m ${String(ss).padStart(2, "0")}s`;
    return `${ss}s`;
  };

  return { st, busy, err, result, act, fmtDur, liveLabel: fmtElapsed(liveSec) , lastFix };
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
/** Per-teammate avatar tint (v2's AV_TONE). Deterministic on the name, so the
    same colleague is the same colour every render and across sessions — the
    strip is scannable by colour before it is readable by initial. Light tints
    with dark ink: legible on the hero's near-black gradient. */
const MATE_TONES = [
  "linear-gradient(150deg,#4ade80,#16a34a)",
  "linear-gradient(150deg,#93c5fd,#3b82f6)",
  "linear-gradient(150deg,#fcd34d,#f59e0b)",
  "linear-gradient(150deg,#f9a8d4,#ec4899)",
  "linear-gradient(150deg,#c4b5fd,#8b5cf6)",
  "linear-gradient(150deg,#7dd3fc,#0ea5e9)",
];
function mateTone(name) {
  const key = (name || "?").trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return MATE_TONES[h % MATE_TONES.length];
}

function staffInitials(name) {
  return (name || "")
    .trim()
    .split(/\s+/)
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

function WhosOnStrip({ teamShifts, nextShift }) {
  const { t } = useLanguage();

  if (!nextShift) return null;

  // Same date only; exclude YOUR OWN row structurally (no staff_id on the
  // client) by matching start/end/role; dedupe by staff_id.
  // Multi-location (S4): when MY shift has a location, "who am I on with?"
  // means MY floor — scope to teammates at the same location (or with no
  // location, which belongs everywhere). A shift with no location keeps the
  // whole-team view, so single-venue tenants see zero change.
  const myBranch = nextShift.branch_name || null;
  const mates = matesForShift(teamShifts, nextShift);

  const CAP = 6;
  const shown = mates.slice(0, CAP);
  const overflow = mates.length - shown.length;

  // Lives INSIDE the dark next-shift hero (its avatars ring gray-900 — built
  // for that surface, which is why they looked orphaned on the gray page).
  // Renders NOTHING on a solo shift, so stillness costs zero chrome. No
  // per-avatar role bar — role colour lives only on the hero's left-bar.
  // A solo shift used to render nothing at all — and 63% of venue-days in
  // production ARE solo, so the most common answer to "who am I on with?" was
  // silence, which reads as "not loaded yet" rather than "nobody". Say it.
  if (mates.length === 0) {
    return (
      <div className="mt-4 pt-4 border-t border-white/10">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
          {t("portalWhosOnTitle")}
        </div>
        <div className="text-[13px] text-gray-400">
          {t("portalWhosOnSolo", "You're on your own this shift.")}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-4 pt-4 border-t border-white/10">
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
        {t("portalWhosOnTitle")}
        {myBranch && <span className="normal-case tracking-normal text-gray-500"> · {myBranch}</span>}
      </div>
      {/* Name under the avatar — an initial alone cannot answer the only
          question this strip exists to answer ("who am I on with?"). "D" is
          not an answer. First name only: it is what one colleague calls
          another, and it keeps the row narrow enough to stay calm.
          The avatar was aria-hidden with a title that repeated the initials,
          so a screen-reader user got nothing at all and a hover told a
          sighted user what they could already see. */}
      {/* v2 layout: overlapping 26px avatars with a name LIST beside them,
          rather than a row of avatars each captioned. Same answer to "who am I
          on with?" — the names are still there, just read as a sentence — in
          roughly half the vertical space, which is what lets the hero, the week
          card and the day panel share one screen. The 2px ring is the card
          colour (#14202f), so the discs punch out of the gradient. */}
      <div className="flex items-center gap-[9px]">
        <div className="flex shrink-0">
          {shown.map((s, i) => (
            <span
              key={`${s.staff_id ?? s.staff_name}-${i}`}
              aria-hidden
              className="inline-block h-[26px] w-[26px] rounded-full text-center"
              style={{
                marginLeft: i === 0 ? 0 : -8,
                background: mateTone(s.staff_name),
                color: "#0b1220",
                font: "700 9.5px/26px var(--font-text)",
                boxShadow: "0 0 0 2px #14202f",
              }}
            >
              {staffInitials(s.staff_name)}
            </span>
          ))}
          {overflow > 0 && (
            <span
              aria-hidden
              className="inline-block h-[26px] w-[26px] rounded-full text-center"
              style={{
                marginLeft: -8,
                background: "rgba(255,255,255,.14)",
                color: "rgba(255,255,255,.85)",
                font: "700 9.5px/26px var(--font-text)",
                boxShadow: "0 0 0 2px #14202f",
              }}
            >
              +{overflow}
            </span>
          )}
        </div>
        <span
          className="min-w-0 truncate"
          style={{ font: "500 11.5px/1 var(--font-text)", color: "rgba(255,255,255,.52)" }}
        >
          {shown.map((s) => firstName(s.staff_name)).filter(Boolean).join(", ")}
          {overflow > 0 ? ` +${overflow}` : ""}
        </span>
      </div>
    </div>
  );
}

// ── Åbne vagter — staff claim card ─────────────────────────────────────────
// Open shifts the owner posted that this staffer can pick up one-tap (PULL
// model — appears only when there's something to take, never a notification
// blast). Claim is atomic + overlap-guarded server-side; on success the shift
// lands in the staffer's own schedule, so we refresh.
function OpenShiftsClaimCard({ token, rows, onClaimed, ownShifts, businessType }) {
  // PURE-PROPS rows: hoisted to the page-level loadData (same Promise.allSettled
  // as the schedule) so this card paints WITH the first render instead of
  // inserting itself after settle. Claim refreshes via onClaimed → loadData.
  const { t, lang } = useLanguage();
  const [claiming, setClaiming] = useState(null);
  const [msg, setMsg] = useState("");

  const claim = async (id) => {
    setClaiming(id);
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
      else setMsg(errText(err, t("portalOpenClaimFailed", "Couldn't take the shift.")));
      onClaimed?.();
    } finally {
      setClaiming(null);
    }
  };

  // Silent when there's nothing to claim — but the "Added to your schedule"
  // confirmation must survive claiming the LAST shift (msg keeps the card
  // alive for its 3.5s moment; without this the card vanished mid-thanks).
  if (!rows.length && !msg) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8] mb-2 flex items-center gap-1.5">
        <CalendarPlus className="w-3.5 h-3.5" />
        {t("portalOpenTitle", "Open shifts")}
      </div>
      {msg && <div className="text-[12px] text-gray-600 mb-2">{msg}</div>}
      <div className="space-y-2">
        {rows.map((o) => (
          <div
            key={o.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[14px] font-semibold text-gray-900">
                <span className={`block h-[3px] w-5 rounded-full ${roleBarColor(o.role, businessType)}`} aria-hidden />
                {fmtDate(o.date, lang)}
              </div>
              <div className="text-[13px] text-gray-500 tabular-nums mt-0.5">
                {o.start_time}–{o.end_time}
                {/* Same pre-tap verdict Swaps gives. Finding out you clash
                    AFTER committing is the version that wastes a tap. */}
                {overlapsOwnShift(o.date, `${o.start_time}–${o.end_time}`, ownShifts) && (
                  <span className="ml-1.5 text-red-600 font-semibold">· {t("portalGaOverlaps", "Overlaps you")}</span>
                )}
                {/* Multi-location S5: WHERE the hole is — a colleague sees
                    the venue before taking a cross-location shift. */}
                {o.branch_name && (
                  <span className="text-gray-400"> · {o.branch_name}</span>
                )}
              </div>
            </div>
            <button
              onClick={() => claim(o.id)}
              disabled={claiming === o.id}
              className="shrink-0 inline-flex items-center justify-center min-h-[44px] rounded-xl bg-gray-900 text-white text-[13px] font-medium px-4 active:scale-95 transition disabled:opacity-60"
            >
              {claiming === o.id ? "…" : t("portalOpenClaim", "Take it")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


function ScheduleTab({ shifts: rawShifts, teamShifts, openShifts, token, restaurantName, restaurantCity, restaurantAddress, businessType, coversByShift, onShiftsChanged, allShifts}) {
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

  // Local UI state: which week-strip is shown + which day is expanded.
  const [weekView, setWeekView] = useState("this"); // 'this' | 'next'
  const [expandedDate, setExpandedDate] = useState(null);

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
  // "Brug for en ændring?" reveals the sick-call form inline (and deep-links
  // Swaps via onNeedChange from the confirm strip).
  const [showSick, setShowSick] = useState(false);

  const nextWeekStart = addDays(weekStart, 7);
  const laterStart = addDays(weekStart, 14);

  // Build all 7 days for current + next week (OFF days included as silent dots).
  const thisWeek = [];
  const nextWeek = [];
  // `all` carries EVERY shift on the day; `shift` stays as the first one for
  // the strip, which draws one bar per day whatever happens on it. This used
  // to be `shifts.find()`, which kept the first and silently dropped the rest:
  // a split day (lunch, then back for dinner) showed one shift, and the week
  // total under-counted the hours the staffer is actually working. Splits are
  // normal in this trade, so the bug is common, invisible, and about pay.
  const dayShifts = (d) => shifts.filter((s) => s.date === d);
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const all = dayShifts(d);
    thisWeek.push({ date: d, shift: all[0], all });
  }
  for (let i = 0; i < 7; i++) {
    const d = addDays(nextWeekStart, i);
    const all = dayShifts(d);
    nextWeek.push({ date: d, shift: all[0], all });
  }

  const hasLater = shifts.some((s) => s.date >= laterStart);

  // Hours / counts for the muted summary line under the strip.

  // Next shift (drives the hero, countdown, teammate strip, .ics).
  const upcoming = shifts.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const nextShift = upcoming[0];
  const nextShiftRole = nextShift?.role_on_shift || t("portalRoleStaff", "Staff");

  // Countdown chip. The Date.now() read lives inside the pure helper,
  // recomputed each 15s render — minutes tick, days do not need to.
  const countdownLabel = nextShiftCountdown(nextShift, t);

  // Venue location — the owner sets this on their business profile. Label is
  // "Name, City"; the tap opens Maps for directions (address if the owner
  // filled one, else name+city). Makes "where do I go" one tap for staff.
  const venueLabel = restaurantName
    ? [restaurantName, restaurantCity].filter(Boolean).join(", ")
    : "";
  const venueMapsQuery = restaurantAddress
    ? [restaurantAddress, restaurantCity].filter(Boolean).join(", ")
    : venueLabel;
  const venueMapsUrl = venueMapsQuery
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueMapsQuery)}`
    : null;

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
    const url = `${base}/portal/${token}/schedule.ics`;
    window.open(url.replace(/^https?:/, "webcal:"), "_blank", "noopener");
    try { if (calKey) localStorage.setItem(calKey, "1"); } catch { /* private mode */ }
    setCalTapped(true);
  };

  const weekDays = weekView === "this" ? thisWeek : nextWeek;


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
  const weekLabelStart = weekView === "this" ? weekStart : nextWeekStart;

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
  const hUnit = t("portalHrsCompact", "h");
  // Format decimal hours as "7t" / "6t 15m" (unit is locale "t"/"h").
  const fmtHM = (h) => {
    if (h == null) return "—";
    const mm = Math.round(Number(h) * 60);
    const H = Math.floor(mm / 60), M = mm % 60;
    return M ? `${H}${hUnit} ${M}m` : `${H}${hUnit}`;
  };
  // Gross span = net (paid) + unpaid break — both come from the owner's roster.
  const grossHrs = (s) => (Number(s?.net_hours) || 0) + (Number(s?.break_minutes) || 0) / 60;

  return (
    <div className="space-y-4">
      {/* HERO — dark gray-900 next-shift card with a 4px role-colored left-bar.
          Absorbs the punch-clock (elapsed timer + Stempl ind/ud) and a live
          countdown. Role shows ONLY via the thin left-bar + a tiny label. */}
      <div
        className={`relative overflow-hidden text-white${playBeat ? " motion-safe:animate-heroSettle" : ""}`}
        style={{
          // v2 hero: a three-stop diagonal rather than a flat fill, so the card
          // has a direction of light instead of sitting there. Radius 22 and the
          // inset top highlight are the other two thirds of v2's "glossy" —
          // which it defines as exactly three things and nothing more.
          borderRadius: 22,
          padding: "19px 19px 17px",
          background: "linear-gradient(152deg,#1d2a3b 0%,#0f172a 46%,#080e16 100%)",
          boxShadow:
            "0 24px 46px -26px rgba(4,10,18,.95), inset 0 1px 0 rgba(255,255,255,.13)",
        }}
      >
        {/* Brand bloom bleeding off the TOP-RIGHT corner — v2 moves it there so
            the light reads as coming from above, agreeing with the gradient.
            Green, low-alpha, felt rather than seen; never neon. */}
        {/* NO blur filter here, deliberately. A radial-gradient is already soft,
            and adding `blur-3xl` gives this div its own compositing layer —
            which WebKit then fails to clip against the parent's border-radius,
            painting a hard pale-green rectangle over the rounded corner. Caught
            on a real iPhone 17 Pro Max; invisible in a desktop browser. */}
        <div
          aria-hidden
          className="pointer-events-none absolute h-[230px] w-[230px] rounded-full"
          style={{
            top: -80, right: -70,
            background: "radial-gradient(closest-side, rgba(34,197,94,.40), rgba(34,197,94,0))",
          }}
        />
        {/* v2 sheen — a 70px blade crossing the card every 7s. Long gap, short
            pass: seen once and then forgotten, which is the point. Purely
            optical, so aria-hidden and pointer-events-none. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[70px] motion-safe:animate-heroSheen"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,.10), transparent)",
          }}
        />
        {/* Role-colored left-bar — a thin SIGNAL, the only role colour. Only
            when there IS a shift: an empty hero has no role to signal. */}
        {nextShift && (
          <span
            className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${roleBarColor(nextShift.role_on_shift, businessType)}`}
            aria-hidden
          />
        )}
        {/* v2 eyebrow: a slow pulsing dot + green label. The dot is the screen's
            only moving element at rest — it says "this is live" without a
            spinner. 2.4s is deliberately slower than a heartbeat: present, not
            urgent. Respects prefers-reduced-motion via motion-safe. */}
        <div className="relative flex items-start justify-between gap-2">
          <div
            className="flex items-center gap-1.5 uppercase"
            style={{ font: "700 10px/1 var(--font-text)", letterSpacing: "0.16em", color: "#4ade80" }}
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full motion-safe:animate-heroLiveDot"
              style={{ background: "#22c55e" }}
            />
            {t("portalNextShiftHero")}
          </div>
          {countdownLabel && (
            <span
              className="shrink-0 rounded-full tabular-nums"
              style={{
                font: "600 10.5px/1 var(--font-text)",
                color: "rgba(255,255,255,.86)",
                background: "rgba(255,255,255,.10)",
                border: "1px solid rgba(255,255,255,.14)",
                padding: "5px 9px",
              }}
            >
              {countdownLabel}
            </span>
          )}
        </div>

        {nextShift ? (
          <>
            {/* v2 headline: date and time on ONE line at display weight, split by
                a dimmed separator. Two stacked lines made the time read as a
                subtitle of the date; they are one fact and now look like it. */}
            <div
              className="relative text-white"
              style={{ marginTop: 13, font: "700 26px/1.06 var(--font-display)", letterSpacing: "-0.032em" }}
            >
              {isToday(nextShift.date) ? t("portalToday") : fmtDate(nextShift.date, lang)}
              <span style={{ color: "rgba(255,255,255,.42)" }}> · </span>
              <span className="tabular-nums">{nextShift.start_time}–{nextShift.end_time}</span>
            </div>
            {/* Hours clarity — gross span · unpaid break · net (paid). All three
                derive from the owner's rostered shift (net_hours + break_minutes),
                replacing the old ambiguous single "6.25 hrs" that read like a bug. */}
            {/* The prototype answers "what is this shift" in ONE quiet line —
                role · span · break — with 3px dots between. Ours carried the
                same facts as three coloured pills plus a separate role row:
                two rows and four backgrounds on the calmest surface in the app.
                Same facts, one line. NET keeps its emphasis because it is the
                paid number and the one thing here we compute rather than
                restate. */}
            <div className="mt-2 flex flex-wrap items-center" style={{ gap: 7, font: "500 12.5px/1.35 var(--font-text)", color: "rgba(255,255,255,.60)" }}>
              {nextShiftRole && <span>{nextShiftRole}</span>}
              {nextShift.break_minutes > 0 ? (
                <>
                  {nextShiftRole && <HeroDot />}
                  <span className="tabular-nums">{t("portalHoursGross", "{h} shift", { h: fmtHM(grossHrs(nextShift)) })}</span>
                  <HeroDot />
                  <span className="tabular-nums">{t("portalHoursBreak", "{m} min break", { m: nextShift.break_minutes })}</span>
                  <HeroDot />
                  <span className="tabular-nums font-semibold" style={{ color: "#6ee7b7" }}>
                    {t("portalHoursNet", "{h} net", { h: fmtHM(nextShift.net_hours) })}
                  </span>
                </>
              ) : (
                <>
                  {nextShiftRole && <HeroDot />}
                  {/* No break → gross == net, so ONE figure, not a redundant pair. */}
                  <span className="tabular-nums font-semibold" style={{ color: "#6ee7b7" }}>
                    {t("portalHoursGross", "{h} shift", { h: fmtHM(nextShift.net_hours) })}
                  </span>
                </>
              )}
            </div>

            {/* Booked covers for this shift's night — the reason to hold both the
                book and the roster. Count ONLY: the server sends one integer per
                business date and nothing about the guests. No allergy signal, not
                even a count — that is Art.9 health data and the owner's own host
                stand already refuses to show it beside a name; this surface
                (token-in-URL, personal phone, PIN opt-in) can never get more.

                NOT tappable, deliberately: a tap has nowhere honest to go — staff
                must never reach the guest list — and a control that opens nothing
                is a dead end.

                Joined on the shift's own id, so the count belongs to THIS shift
                and no date is re-derived here. The server scopes it to the
                shift's hours: guests arriving while this staffer is on, not the
                whole day's total.

                "booket" is load-bearing — walk-ins never enter the book, so this
                is guests BOOKED, never guests served. */}
            {typeof coversByShift?.[nextShift.id] === "number" && (
              <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-gray-400">
                <Users className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span className="tabular-nums">
                  {t("portalCoversBooked", "{n} guests booked", { n: coversByShift[nextShift.id] })}
                </span>
              </div>
            )}

            {/* Venue line — name ONLY (never a fabricated address). When the
                owner has turned ON the clock-in geofence, this becomes an honest
                "Stempl kun ind ved <venue>" lock hint so the staffer knows the
                clock-in is location-bound before they try it (the server's
                too_far 403 is still the real gate). */}
            {restaurantName &&
              (venueMapsUrl ? (
                <a
                  href={venueMapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-200 active:opacity-70 transition-colors"
                  title={t("portalVenueDirections", "Get directions")}
                >
                  {clock.st?.geofence_on ? (
                    <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                  ) : (
                    <MapPin className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                  )}
                  <span className="truncate underline decoration-gray-600 underline-offset-2">
                    {clock.st?.geofence_on
                      ? t("portalClockOnlyAt", "Clock in only at {venue}", { venue: venueLabel })
                      : venueLabel}
                  </span>
                </a>
              ) : (
                <div className="mt-2 flex items-center gap-1.5 text-[12px] text-gray-400">
                  {clock.st?.geofence_on ? (
                    <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                  ) : (
                    <MapPin className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                  )}
                  <span className="truncate">
                    {clock.st?.geofence_on
                      ? t("portalClockOnlyAt", "Clock in only at {venue}", { venue: venueLabel })
                      : venueLabel}
                  </span>
                </div>
              ))}

            {/* Live elapsed timer while clocked in (emerald ping, reused from
                the old ClockCard). */}
            {clockedIn && (
              <div className="mt-3 flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                </span>
                <span className="text-2xl font-bold tabular-nums tracking-[-0.01em]">{clock.liveLabel}</span>
                <span className="text-[12px] text-gray-300 tabular-nums">
                  {t("portalClockedInSince", "Clocked in · since {t}", { t: clock.st?.since || "—" })}
                </span>
              </div>
            )}

            {/* ONE geofence-aware CTA. Honesty: the client can't verify "at
                venue" (no coords) — the server's too_far 403 is the real gate.
                Clocked in → Stempl ud. Else → Stempl ind (primary) + a quiet
                ghost "Tilføj til kalender". Never claims presence. */}
            <div className="mt-4">
              {token && clockedIn ? (
                <button
                  type="button"
                  disabled={clock.busy}
                  onClick={() => clock.act("out")}
                  className="w-full inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl bg-white text-gray-900 text-sm font-semibold shadow-[0_2px_8px_-2px_rgb(0_0_0/0.4)] hover:bg-gray-100 active:scale-[0.98] transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
                >
                  {t("portalClockOutCta")}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  {token && (
                    <button
                      type="button"
                      disabled={clock.busy || clockLocked}
                      onClick={() => clock.act("in")}
                      className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl bg-white text-gray-900 text-sm font-semibold shadow-[0_2px_8px_-2px_rgb(0_0_0/0.4)] hover:bg-gray-100 active:scale-[0.98] transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
                    >
                      {clockLocked && <Lock className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />}
                      {t("portalClockInCta")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={subscribeCalendar}
                    title={t("portalSyncCalendarHint", "Subscribe once — your calendar updates itself when shifts change")}
                    className={"shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-xl bg-white/10 ring-1 ring-white/15 text-sm font-medium hover:bg-white/20 active:scale-[0.98] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900 " + (calTapped ? "text-gray-400" : "text-gray-200")}
                  >
                    <CalendarPlus className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />
                    <span>{calTapped ? t("portalSyncCalendarAgain", "Calendar") : t("portalSyncCalendar", "Add to my calendar")}</span>
                  </button>
                </div>
              )}
            </div>
            {/* Låst — clock-in is time-locked until the owner's window opens.
                Honest, specific: shows the exact open time from the server. */}
            {clockLocked && clock.st?.opens_at && (
              <div className="mt-2.5 flex items-center gap-1.5 text-[12px] text-gray-400">
                <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span>{t("portalClockOpensAt", "Clock-in opens at {t}", { t: clock.st.opens_at })}</span>
              </div>
            )}
            {clock.err?.kind === "too_far" ? (
              /* Calm "almost there" — amber, not red. Being off-site isn't an
                 error the worker caused; show how far + what to do. Numbers are
                 server-stamped (the 403 carries distance_m/radius_m). Honest: a
                 distance estimate, never a claim about where the person is. */
              <div className="mt-3 rounded-lg bg-amber-500/10 ring-1 ring-amber-400/20 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-200">
                  <MapPinOff className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                  <span>
                    {restaurantName
                      ? t("portalClockTooFarDist", "About {dist} from {venue}", { dist: fmtDist(clock.err.distance_m), venue: restaurantName })
                      : t("portalClockTooFarDistNoVenue", "About {dist} from the venue", { dist: fmtDist(clock.err.distance_m) })}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-gray-400">
                  {t("portalClockTooFarRadius", "Clock-in opens within {radius} m of the venue.", { radius: clock.err.radius_m })}
                </div>
                <div className="mt-0.5 text-[12px] text-gray-300">
                  {t("portalClockTooFarDo", "Head over and try again when you're there.")}
                </div>
                {/* Direction, not just distance. Drawn from the fix already used
                    for this punch — no second permission prompt — against the
                    venue centre the status endpoint sends when the fence is on.
                    Schematic, so no tiles, no CSP change, no network call. */}
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
              <div className="mt-2 flex items-center gap-1.5 text-[12px] text-gray-400">
                <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span>{t("portalClockOpensAt", "Clock-in opens at {t}", { t: clock.err.opens_at || "—" })}</span>
              </div>
            ) : clock.err ? (
              <div className="mt-2 text-[12px] text-red-300">{clock.err}</div>
            ) : null}
            {clock.result && !clock.err && (
              <div className="mt-2 text-[12px] text-gray-200">{clock.result}</div>
            )}

            {/* "På arbejde med dig" — folded INTO the hero (its avatars ring
                gray-900, built for this surface). Who's-on is a property of this
                next shift, so it belongs here, not floating on the gray page.
                Renders nothing on a solo shift. */}
            {token && <WhosOnStrip teamShifts={teamShifts || []} nextShift={nextShift} />}
          </>
        ) : (
          <>
            <div className="mt-1 text-2xl font-bold text-gray-500">{t("portalNoUpcomingShift")}</div>
            {/* TWO empty states, not one. "You'll get notified when the venue
                publishes the schedule" is true only while nothing is published.
                Once the rota IS out and this staffer simply isn't on it, that
                sentence tells them to keep waiting for a message that will
                never come — the app quietly lies about why they have no work.
                `teamShifts` already tells us which case we're in (it's a prop
                on this component, so no backend call): if teammates have
                upcoming shifts, the plan exists and the honest line is that
                they're not on it. */}
            {(teamShifts || []).some((s) => s.date >= today) ? (
              <div className="mt-2 text-[13px] text-gray-400">
                {t(
                  "portalNoShiftPublished",
                  "The schedule is out and you're not on it. Ask {venue} if that looks wrong.",
                  { venue: restaurantName || "" },
                )}
              </div>
            ) : (
              <div className="mt-2 text-[13px] text-gray-400">
                {t("portalNoShiftHint", "You'll get notified here when {venue} publishes the schedule.", { venue: restaurantName || "" })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Åbne vagter — open shifts this staffer can pick up one-tap. */}
      {token && <OpenShiftsClaimCard token={token} rows={openShifts || []} onClaimed={onShiftsChanged} ownShifts={shifts} businessType={businessType} />}

      {/* Bidirectional confirmation — calm "Jeg har set det" strip. Truth logic
          (allConfirmed gated on every confirmed_at) untouched; only the CTA
          copy + style change. The "Brug for en ændring?" link reveals the
          sick-call form inline AND deep-links the Swaps tab. */}
      {token && (
        <ConfirmScheduleButton
          token={token}
          shifts={shifts}
          allShifts={allShifts}
          onConfirmed={onShiftsChanged}
          // Reveal the form and STAY. This used to also fire onNeedChange(),
          // which switches to Swaps — so the tap opened something and then
          // navigated away from it before it could be read.
          onNeedChange={() => setShowSick(true)}
        />
      )}

      {/* Sick-call self-service — revealed by "Brug for en ændring?". */}
      {token && showSick && (
        <SickCallButton
          token={token}
          upcomingShifts={upcoming}
          onCalledIn={onShiftsChanged}
          // Dismissing the sheet unmounts it, so you land back on the single
          // "Report sick" pill instead of a second identical CTA beneath it.
          onDismiss={() => setShowSick(false)}
          // Straight to the form. "Report sick" already stated the intent; an
          // intermediate "Call in sick" button is a second stacked CTA that
          // only repeats it.
          autoOpen
        />
      )}

      {/* 7-dot week-at-a-glance — replaces the three long shift scrolls. One
          strip at a time (this/next week). Working day = thin role-colored bar;
          OFF = silent hollow dot; TODAY = bold gray-900 label + soft cell fill.
          Tap a working day → the day panel below shows it. */}
      <div
        className="bg-white"
        style={{
          border: "1px solid #e8edf3", borderRadius: 20, padding: "15px 15px 13px",
          boxShadow: "0 1px 2px rgba(15,23,42,.04), 0 16px 32px -24px rgba(15,23,42,.35)",
        }}
      >
        {/* v2 week card header: eyebrow over the RANGE at display weight, with
            two chevron buttons rather than a text link. The range is the fact
            a staffer scans for, so it carries the type weight, not the label. */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <div style={{ font: "700 10px/1 var(--font-text)", letterSpacing: "0.15em", textTransform: "uppercase", color: "#94a3b8" }}>
              {weekView === "this" ? t("portalSecThisWeek", "This week") : t("portalSecNextWeek", "Next week")}
            </div>
            <div className="tabular-nums" style={{ marginTop: 6, font: "700 14.5px/1 var(--font-display)", letterSpacing: "-0.02em", color: "#0f172a" }}>
              {fmtShort(weekLabelStart, lang)} – {fmtShort(addDays(weekLabelStart, 6), lang)}
            </div>
          </div>
          <div className="flex items-center gap-[5px]">
            {[["prev", weekView !== "this"], ["next", weekView === "this"]].map(([dir, enabled]) => (
              <button
                key={dir}
                type="button"
                disabled={!enabled}
                onClick={() => { setWeekView(dir === "next" ? "next" : "this"); setExpandedDate(null); }}
                aria-label={dir === "next" ? t("portalSecNextWeek", "Next week") : t("portalSecThisWeek", "This week")}
                className="flex items-center justify-center"
                style={{
                  width: 28, height: 28, borderRadius: 9, border: "1px solid #e8edf3",
                  background: enabled ? "#f1f5f9" : "#f6f8fb",
                  color: enabled ? "#475569" : "#cbd5e1",
                  cursor: enabled ? "pointer" : "default",
                }}
              >
                {dir === "next"
                  ? <ChevronRight className="w-3.5 h-3.5" strokeWidth={2.4} aria-hidden />
                  : <ChevronLeft className="w-3.5 h-3.5" strokeWidth={2.4} aria-hidden />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-1" style={{ marginTop: 13 }}>
          {weekDays.map(({ date: d, shift }, i) => {
            const isTodayCell = isToday(d);
            const isExpanded = expandedDate === d;
            const dayUnavail = isUnavailDay(d);
            // Free FUTURE days are tappable too now — to mark "kan ikke arbejde".
            // A shift day still expands its shift; a past free day stays inert.
            const cellTappable = !!shift || !isPast(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => setExpandedDate(isExpanded || !cellTappable ? null : d)}
                className="flex-1 min-w-0 flex flex-col items-center transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
                style={{
                  gap: 5, padding: "8px 0 9px", borderRadius: 13,
                  background: isExpanded
                    ? "linear-gradient(180deg,#1e293b,#0f172a)"
                    : isTodayCell ? "#eef2f7" : "transparent",
                  boxShadow: isExpanded ? "0 8px 18px -10px rgba(15,23,42,.85)" : "none",
                }}
                aria-label={`${WD[i]} ${fmtShort(d, lang)}${dayUnavail && !shift ? " · " + t("portalUnavailBadge", "Can't work") : ""}`}
                aria-current={isTodayCell ? "date" : undefined}
                aria-expanded={cellTappable ? isExpanded : undefined}
              >
                {/* TODAY = bold gray-900 label + soft cell fill (above). No ink
                    ring — a ring hugging a 4px bar rendered as a broken pill.
                    EXPANDED = a step darker (bg-gray-100) so "open" reads
                    distinctly from "today". */}
                <span style={{ font: "600 9.5px/1 var(--font-text)", color: isExpanded ? "rgba(255,255,255,.55)" : "#94a3b8" }}>{WD[i]}</span>
                <span
                  className="tabular-nums"
                  style={{
                    font: "700 13.5px/1 var(--font-display)", letterSpacing: "-0.02em",
                    color: isExpanded ? "#fff" : "#0f172a",
                    textDecoration: dayUnavail && !shift ? "line-through" : "none",
                    textDecorationColor: dayUnavail && !shift ? "#f59e0b" : undefined,
                  }}
                >
                  {parseInt(d.slice(8), 10)}
                </span>
                {/* v2 marker: a 15×5 BAR when there is a shift, a 5×5 dot when
                    there is not. Length carries the signal, so a working week
                    is legible at a glance without reading a single date. */}
                {dayUnavail && !shift ? (
                  <CalendarOff className="w-3.5 h-3.5 text-amber-500" strokeWidth={2.5} aria-hidden />
                ) : (
                  <span
                    aria-hidden
                    style={{
                      width: shift ? 15 : 5, height: 5, borderRadius: 99,
                      background: shift
                        ? (isExpanded ? "#4ade80" : "#16a34a")
                        : (isExpanded ? "rgba(255,255,255,.22)" : "#dbe3ec"),
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* v2 week footer — the two numbers that answer "how much am I working
            this week?" without opening anything, plus the status of the rota
            itself. Ours is honestly "Live": the portal only ever receives
            published shifts (drafts never leave the owner side), so the pill
            states a fact rather than decorating one. */}
        <div
          className="flex items-center justify-between"
          style={{ marginTop: 13, paddingTop: 11, borderTop: "1px solid #eef2f7" }}
        >
          <span className="tabular-nums" style={{ font: "600 12px/1 var(--font-text)", color: "#475569" }}>
            {fmtHM(weekTotals.hours)} · {t("portalWeekShiftCount", "{n} shifts", { n: weekTotals.count })}
          </span>
        </div>

        {/* Tapped a FREE future day → mark / un-mark "kan ikke arbejde" right
            here. Writes the same StaffAvailability rows the Availability tab
            uses, so a strip mark shows on the calendar and vice-versa. */}

        {/* Selected-day detail, with v2's eyebrow above it: the DAY on the left,
            the station on the right. Without it the shift row floats free of the
            strip and you have to work out which day you tapped. */}
        {/* THE WEEK'S TIMES — every shift in the week on screen, not one
            tapped day at a time.

            This used to be gated on `weekView === "this"`, which meant paging
            to NEXT week rendered the bars, the chevrons and the totals and then
            nothing at all: next week's start and end times were unreachable in
            this app at any number of taps. Next week is the only reason a
            staffer opens this app on purpose — the rota comes out, the whole
            team looks at once, and the app showed them coloured bars. They
            texted the manager, which is the behaviour the owner bought this to
            stop.

            The old panel also answered only "which day did I tap". A staffer
            writing the week on the fridge, or checking whether Friday finishes
            before the last train, needs the days side by side. The strip stays
            the glance layer (which days); this list is the answer layer (what
            times). A tapped day still highlights here rather than hiding the
            rest.

            Multiple shifts on one day render as separate rows — see `all` on
            the week arrays. `shifts.find()` used to keep only the first, so a
            double shift showed one and the week total under-counted it. */}
        {(() => {
          const daysWithShifts = weekDays.filter((d) => (d.all || []).length);
          if (!daysWithShifts.length) return null;
          return (
            <div style={{ marginTop: 16 }} className="border-t border-[#f1f5f9] pt-1">
              {daysWithShifts.map(({ date: d, all }) => {
                const selected = expandedDate === d;
                const today = isToday(d);
                return (
                  <div
                    key={d}
                    className="pt-3"
                    style={{
                      // The tapped day is emphasised, never isolated — the rest
                      // of the week stays readable underneath it.
                      background: selected ? "#f8fafc" : "transparent",
                      borderRadius: selected ? 12 : 0,
                      paddingLeft: selected ? 10 : 0,
                      paddingRight: selected ? 10 : 0,
                      paddingBottom: selected ? 10 : 0,
                      transition: "background 140ms ease-out",
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span style={{ font: "700 10px/1 var(--font-text)", letterSpacing: "0.15em", textTransform: "uppercase", color: today ? "#0f172a" : "#94a3b8" }}>
                        {new Date(d + "T00:00:00")
                          .toLocaleDateString(localeFor(lang), { weekday: "short", day: "numeric" })
                          .toUpperCase()}
                        {today ? ` · ${t("portalToday", "Today")}` : ""}
                      </span>
                      {all[0]?.role_on_shift && (
                        <span style={{ font: "500 11px/1 var(--font-text)", color: "#94a3b8" }}>
                          {all[0].role_on_shift}
                        </span>
                      )}
                    </div>

                    {all.map((fs) => (
                      <div key={fs.id || `${fs.date}-${fs.start_time}`} className="flex items-center justify-between gap-3 mt-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className={`w-1.5 h-8 rounded-full shrink-0 ${roleBarColor(fs.role_on_shift, businessType)}`} aria-hidden />
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-gray-900 tabular-nums truncate">
                              {fs.start_time}–{fs.end_time}
                            </div>
                            <div className="text-[11px] text-gray-500 truncate">
                              {fs.role_on_shift ? `${fs.role_on_shift} · ` : ""}{fmtHM(fs.net_hours)}
                            </div>
                            {/* Who you are on with, for EVERY shift — not just
                                the hero's next one. "Who am I on with?" was
                                answerable for exactly one day; a staffer
                                looking at Friday got nothing. Same matching
                                rule as the hero strip (matesForShift), so the
                                two can never disagree.
                                First names only, three then "+N" — this is a
                                glance line under a time, not a roster. */}
                            {(() => {
                              // GET /team-schedule starts at TODAY, so it has
                              // nothing to say about a past day. Silence there
                              // means UNKNOWN, and rendering the same silence
                              // for a future solo shift would let a staffer
                              // read "I was on my own on Friday" out of missing
                              // data. So: only speak about dates we can see.
                              //   future + mates -> name them
                              //   future + none  -> say alone (we KNOW)
                              //   past           -> say nothing (we do not)
                              if (fs.date < today) return null;
                              const mates = matesForShift(teamShifts, fs);
                              if (!mates.length) {
                                return (
                                  <div className="text-[11px] text-gray-400 truncate mt-0.5">
                                    {t("portalWhosOnSoloShort", "On your own")}
                                  </div>
                                );
                              }
                              const names = mates.map((m) => firstName(m.staff_name)).filter(Boolean);
                              const shown = names.slice(0, 3).join(", ");
                              const extra = names.length - Math.min(names.length, 3);
                              return (
                                <div className="text-[11px] text-gray-400 truncate mt-0.5">
                                  {t("portalWithMates", "With {names}", {
                                    names: extra > 0 ? `${shown} +${extra}` : shown,
                                  })}
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
                                className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-gray-400 underline truncate"
                              >
                                <MapPin className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden />
                                {fs.branch_name}
                              </a>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="tabular-nums" style={{ font: "700 13px/1 var(--font-display)", color: "#0f172a" }}>
                            {fmtHM(fs.net_hours)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Quiet pointer to shifts beyond next week. */}
        {weekView === "next" && hasLater && (
          <div className="mt-2 text-[11px] text-gray-400">{t("portalSecComingUp", "Coming up")}</div>
        )}
      </div>
    </div>
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
function PeriodSheet({ initial, anchorMonth, onClose, onApply }) {
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
  const cycles = [
    {
      key: "calendar",
      label: `1.–${new Date(Y, M + 1, 0).getDate()}.`,
      hint: monthName(0),
      start: iso(new Date(Y, M, 1)),
      end: iso(new Date(Y, M + 1, 0)),
    },
    {
      key: "15-14",
      label: "15.–14.",
      hint: `${monthName(0)} – ${monthName(1)}`,
      start: iso(new Date(Y, M, 15)),
      end: iso(new Date(Y, M + 1, 14)),
    },
    {
      key: "16-15",
      label: "16.–15.",
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

  const field = {
    width: "100%", minWidth: 0, boxSizing: "border-box",
    marginTop: 6, padding: "11px 12px", borderRadius: 14,
    border: "1px solid #e8edf3", background: "#fbfdff",
    font: "600 14px/1 var(--font-text)", color: "#0f172a",
  };
  const cap = {
    font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.1em",
    textTransform: "uppercase", color: "#94a3b8",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(8,14,22,.45)" }} onClick={onClose}>
      <div
        role="dialog"
            aria-modal="true"
            aria-label={t("portalHoursCustomTitle")}
            className="w-full bg-white"
        style={{ borderRadius: "24px 24px 0 0", padding: "18px 16px calc(18px + env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto" style={{ width: 38, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
        <div style={{ marginTop: 14, font: "700 17px/1.2 var(--font-display)", color: "#0f172a" }}>
          {t("portalHoursCustomTitle", "Choose a period")}
        </div>

        <div style={{ marginTop: 16, ...cap }}>{t("portalHoursCycle", "Pay cycle")}</div>
        <div className="flex" style={{ gap: 7, marginTop: 8 }}>
          {cycles.map((c) => {
            const active = from === c.start && to === c.end;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => { setFrom(c.start); setTo(c.end); }}
                style={{
                  flex: 1, padding: "11px 6px", borderRadius: 14, textAlign: "center",
                  background: active ? "linear-gradient(180deg,#1e293b,#0f172a)" : "#f5f8fb",
                  border: `1px solid ${active ? "transparent" : "#e8edf3"}`,
                  boxShadow: active ? "0 8px 18px -10px rgba(15,23,42,.85)" : "none",
                }}
              >
                <div style={{ font: "700 13px/1 var(--font-text)", color: active ? "#fff" : "#0f172a" }}>{c.label}</div>
                <div style={{ marginTop: 5, font: "600 10px/1 var(--font-text)", color: active ? "rgba(255,255,255,.55)" : "#94a3b8" }}>{c.hint}</div>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 18, ...cap }}>{t("portalHoursCustomRange", "Or pick your own dates")}</div>
        <div className="flex" style={{ gap: 10, marginTop: 8 }}>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span style={cap}>{t("portalHoursFrom", "From")}</span>
            <input type="date" value={from} min={floorISO} max={todayISO} onChange={(e) => setFrom(e.target.value)} style={field} />
          </label>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span style={cap}>{t("portalHoursTo", "To")}</span>
            <input type="date" value={to} min={from || floorISO} onChange={(e) => setTo(e.target.value)} style={field} />
          </label>
        </div>
        {problem && (
          <div style={{ marginTop: 10, font: "600 12px/1.4 var(--font-text)", color: "#dc2626" }}>{problem}</div>
        )}

        <button
          type="button"
          disabled={!ready}
          onClick={() => onApply({ start: from, end: to })}
          className="w-full"
          style={{
            marginTop: 16, padding: "14px 0", borderRadius: 16,
            font: "700 14px/1 var(--font-text)",
            color: ready ? "#fff" : "#94a3b8",
            background: ready ? "linear-gradient(180deg,#1e293b,#0f172a)" : "#f1f5f9",
            boxShadow: ready ? "0 10px 22px -12px rgba(15,23,42,.9)" : "none",
          }}
        >
          {t("portalHoursShowPeriod", "Show these hours")}
        </button>
        {initial && (
          <button
            type="button"
            onClick={() => onApply(null)}
            className="w-full"
            style={{ marginTop: 10, padding: "12px 0", font: "600 13px/1 var(--font-text)", color: "#64748b" }}
          >
            {t("portalHoursBackToDefault", "Back to my pay period")}
          </button>
        )}
      </div>
    </div>
  );
}

function HoursTab({ data, maxHours: maxHoursRaw, range, setRange, prevTotal, hoursError, hoursLoading }) {
  const { t, lang } = useLanguage();
  const [customOpen, setCustomOpen] = useState(false);
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
    for (const e of data?.entries || []) {
      const k = isoWeek(e.date);
      if (k === null) continue;                                // never bucket a date we cannot read
      buckets.set(k.key, (buckets.get(k.key) || 0) + (Number(e.total_hours) || 0));
    }
    // Key is `${isoYear}-${week}` so a range crossing New Year does not collide
    // W52 of one year with W52 of the next, or sort W01 before W52.
    const sorted = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const rows = sorted
      .slice(-5)                                               // v2 shows five columns
      .map(([k, n]) => ({ w: `W${k.split("-")[1]}`, n: Math.round(n * 100) / 100, v: String(Math.round(n * 100) / 100) }));
    rows.max = rows.reduce((m, r) => Math.max(m, r.n), 0) || 1;
    // Flagged, not hidden: with a long custom window these five bars are a tail,
    // not the whole period, so they cannot add up to the headline above them.
    rows.truncated = sorted.length > rows.length;
    return rows;
  }, [data?.entries]);

  if (!data) {
    // A failed FIRST fetch also leaves data null. Showing the skeleton then is
    // an eternal spinner with no way out, so the error wins over the skeleton.
    if (hoursError) {
      return (
        <div
          className="flex items-start"
          style={{
            gap: 9, padding: "11px 13px", borderRadius: 14,
            background: "#fef2f2", border: "1px solid #fecaca",
            font: "600 12px/1.45 var(--font-text)", color: "#b91c1c",
          }}
        >
          <AlertTriangle size={15} strokeWidth={2.4} style={{ flex: "none", marginTop: 1 }} />
          <span>
            {typeof hoursError === "string" ? hoursError : t("portalHoursLoadFailed", "Could not load that period")}
            {range && (
              <button type="button" onClick={() => setRange(null)} style={{ marginLeft: 8, textDecoration: "underline", color: "#b91c1c" }}>
                {t("portalHoursBackToDefault", "Back to my pay period")}
              </button>
            )}
          </span>
        </div>
      );
    }
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


  return (
    <div className="space-y-4">

      {customOpen && (
        <PeriodSheet
          initial={range}
          anchorMonth={data.period_start}
          onClose={() => setCustomOpen(false)}
          onApply={(r) => { setRange(r); setCustomOpen(false); }}
        />
      )}

      {/* The period IS the control. It sat inside the card as a 10px eyebrow,
          which read as a caption rather than something you could tap — so it
          moves out, goes up in size, and keeps the chevron as the affordance. */}
      <button
        type="button"
        onClick={() => setCustomOpen(true)}
        className="w-full flex items-center justify-between bg-white"
        style={{
          gap: 8, padding: "12px 14px", borderRadius: 16, marginBottom: 13,   // space-y does not reach the card (inline style wins), so state it
          border: "1px solid #e8edf3",
          boxShadow: "0 1px 2px rgba(15,23,42,.04)",
          font: "700 15px/1 var(--font-display)", color: "#0f172a",
        }}
      >
        <span>{fmtShort(data.period_start, lang)} – {fmtShort(data.period_end, lang)}</span>
        {hoursLoading
          ? <RefreshCw size={14} strokeWidth={2.5} className="animate-spin" style={{ color: "#94a3b8" }} />
          : <ChevronDown size={16} strokeWidth={2.5} style={{ color: "#94a3b8" }} />}
      </button>

      {hoursError && (
        <div
          className="flex items-start"
          style={{
            gap: 9, padding: "11px 13px", borderRadius: 14,
            background: "#fef2f2", border: "1px solid #fecaca",
            font: "600 12px/1.45 var(--font-text)", color: "#b91c1c",
          }}
        >
          <AlertTriangle size={15} strokeWidth={2.4} style={{ flex: "none", marginTop: 1 }} />
          <span>
            {typeof hoursError === "string" ? hoursError : t("portalHoursLoadFailed", "Could not load that period")}
            {range && (
              <button
                type="button"
                onClick={() => setRange(null)}
                style={{ marginLeft: 8, textDecoration: "underline", color: "#b91c1c" }}
              >
                {t("portalHoursBackToDefault", "Back to my pay period")}
              </button>
            )}
          </span>
        </div>
      )}

      {/* Period info */}
      {/* v2 dark stat card. Note the bloom sits BOTTOM-LEFT here at .34, where
          the Schedule hero's is top-right at .40 — the two dark cards are lit
          from opposite corners on purpose, so they read as siblings rather than
          copies. Gradient stop is 48% here (the hero's is 46%). */}
      <div
        className="relative overflow-hidden"
        style={{
          borderRadius: 22, padding: 19,
          background: "linear-gradient(152deg,#1d2a3b 0%,#0f172a 48%,#080e16 100%)",
          boxShadow: "0 24px 46px -26px rgba(4,10,18,.95), inset 0 1px 0 rgba(255,255,255,.13)",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute h-[230px] w-[230px] rounded-full"
          style={{ left: -60, bottom: -90, background: "radial-gradient(closest-side, rgba(34,197,94,.34), rgba(34,197,94,0))" }}
        />

        <div className="relative flex items-end gap-2">
          <span className="tabular-nums" style={{ font: "700 44px/0.9 var(--font-display)", letterSpacing: "-0.04em", color: "#fff" }}>
            {data.total_hours}
          </span>
          {/* hoursLabel already says "Rostered hours" or "Hours worked" from
              hours_source — the number must never claim to be the other one. */}
          <span style={{ font: "600 12px/1 var(--font-text)", color: "rgba(255,255,255,.5)", paddingBottom: 5 }}>
            {hoursLabel.toLowerCase()}
          </span>
        </div>
        <div className="relative flex" style={{ marginTop: 16, gap: 9 }}>
          <div style={{ flex: maxHours ? 1 : "0 1 auto", minWidth: 96, padding: "11px 12px", borderRadius: 14, background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.10)" }}>
            <div style={{ font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,.42)" }}>
              {t("portalHoursShiftsCount", "Shifts")}
            </div>
            <div className="tabular-nums" style={{ marginTop: 7, font: "700 18px/1 var(--font-display)", color: "#fff" }}>
              {data.entries.length}
            </div>
          </div>
          {/* v2 puts "Est. pay before tax" here. We removed that by decision —
              it was computed from ROSTERED hours and would disagree with the
              payslip. The permit cap is a real number in the same slot; with no
              cap the Shifts tile simply takes the full width. */}
          {maxHours ? (
            <div style={{ flex: 1.5, padding: "11px 12px", borderRadius: 14, background: "rgba(34,197,94,.14)", border: "1px solid rgba(34,197,94,.26)" }}>
              <div style={{ font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(134,239,172,.85)" }}>
                {t("portalWorkPermitLimit", "Work permit limit")}
              </div>
              <div className="tabular-nums" style={{ marginTop: 7, font: "700 18px/1 var(--font-display)", color: "#dcfce7" }}>
                {data.total_hours} / {maxHours}
              </div>
            </div>
          ) : soFar > 0 && ahead > 0 ? (
            /* Mid-period only: before the first shift or after the last, a
               split states nothing the headline has not. */
            <div style={{ flex: 1.5, padding: "11px 12px", borderRadius: 14, background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.10)" }}>
              <div style={{ font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,.42)" }}>
                {t("portalHoursLeft", "Still to come")}
              </div>
              {/* Was "12 / 8" in the permit tile's exact shape — a ratio
                  against a cap. This is a SPLIT of the period, so it states the
                  one number the staffer does not already have. */}
              <div className="tabular-nums" style={{ marginTop: 7, font: "700 18px/1 var(--font-display)", color: "#fff" }}>
                {ahead} {t("portalHrsShort")}
              </div>
            </div>
          ) : delta !== null ? (
            /* vs the previous window of the same length. Zero is stated as
               "same", never as "+0" — a signed zero reads like a measurement
               when it is really "no difference". */
            <div style={{ flex: 1.5, padding: "11px 12px", borderRadius: 14, background: delta >= 0 ? "rgba(34,197,94,.14)" : "rgba(255,255,255,.07)", border: `1px solid ${delta >= 0 ? "rgba(34,197,94,.26)" : "rgba(255,255,255,.10)"}` }}>
              <div style={{ font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.1em", textTransform: "uppercase", color: delta >= 0 ? "rgba(134,239,172,.85)" : "rgba(255,255,255,.42)" }}>
                {t("portalHoursVsLast", "vs last period")}
              </div>
              <div className="tabular-nums" style={{ marginTop: 7, font: "700 18px/1 var(--font-display)", color: delta >= 0 ? "#dcfce7" : "#fff" }}>
                {delta === 0
                  ? t("portalHoursSameAsLast", "Same")
                  : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} ${t("portalHrsUnit")}`}
              </div>
            </div>
          ) : nextUp ? (
            /* Nothing worked yet in this window — the useful fact is when it
               starts, not a split that would just restate the headline. */
            <div style={{ flex: 1.5, padding: "11px 12px", borderRadius: 14, background: "rgba(34,197,94,.14)", border: "1px solid rgba(34,197,94,.26)" }}>
              <div style={{ font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(134,239,172,.85)" }}>
                {t("portalHoursFirstShift", "First shift")}
              </div>
              <div style={{ marginTop: 7, font: "700 18px/1 var(--font-display)", color: "#dcfce7" }}>
                {fmtDate(nextUp.date, lang)}{nextUp.start_time ? ` · ${nextUp.start_time}` : ""}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* v2 by-week chart. Bars are proportional to the period's own maximum,
          and the tallest is green — so the shape answers "which week was
          heaviest" before any number is read. Silent when a period has one
          week: a single full-height bar compares nothing. */}
      {weekBars.length > 1 && (
        <div
          className="bg-white"
          style={{
            border: "1px solid #e8edf3", borderRadius: 20, padding: "16px 15px 13px",
            boxShadow: "0 1px 2px rgba(15,23,42,.04), 0 16px 32px -24px rgba(15,23,42,.35)",
          }}
        >
          <div className="flex items-center justify-between">
            <span style={{ font: "700 10px/1 var(--font-text)", letterSpacing: "0.15em", textTransform: "uppercase", color: "#94a3b8" }}>
              {t("portalHoursByWeek", "By week")}
            </span>
            <span style={{ font: "500 11px/1 var(--font-text)", color: "#94a3b8" }}>
              {weekBars.truncated
                ? t("portalHoursLastNWeeks", "last {n} weeks").split("{n}").join(String(weekBars.length))
                : t("portalHrsShort")}
            </span>
          </div>
          <div className="flex items-end" style={{ marginTop: 16, gap: 9, height: 104 }}>
            {weekBars.map((b) => (
              <div key={b.w} className="flex-1 flex flex-col items-center justify-end h-full" style={{ gap: 7 }}>
                <span className="tabular-nums" style={{ font: "700 10px/1 var(--font-text)", color: "#475569" }}>{b.v}</span>
                <div
                  style={{
                    width: "100%", borderRadius: 7,
                    height: Math.max(3, Math.round((b.n / weekBars.max) * 74)),
                    background: b.n === weekBars.max
                      ? "linear-gradient(180deg,#22c55e,#15803d)"
                      : "linear-gradient(180deg,#cbd5e1,#94a3b8)",
                    boxShadow: b.n === weekBars.max ? "0 8px 18px -10px rgba(22,163,74,.8)" : "none",
                    transition: "height .5s cubic-bezier(.22,.9,.24,1)",
                  }}
                />
                <span style={{ font: "600 9.5px/1 var(--font-text)", color: "#94a3b8" }}>{b.w}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The permit warning stays SEPARATE from the tile above: the tile shows
          the position, this shows the alarm. Only when it is actually close. */}
      {maxHours && remaining !== null && remaining <= 10 && (
        <div className="bg-amber-50 border border-amber-200 rounded-[14px] p-3 text-[12px] text-amber-800">
          <strong className="flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />{t("portalWorkPermitLimit", "Work permit limit")}</strong>
          <p className="mt-0.5 text-amber-700">{t("portalHoursRemainingLong", "You have {n} hours remaining this period.", { n: remaining })}</p>
        </div>
      )}

      {/* Recent / upcoming shifts */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8]">{recentLabel}</span>
          {data.entries.length > 0 && (
            <button
              type="button"
              onClick={() => {
                // Built from the rows on screen, so the file and the screen can
                // never disagree — this is the staffer's own record if the hours
                // are ever queried, so a mismatch would be worse than no export.
                const total = data.entries.reduce((a, e) => a + (Number(e.total_hours) || 0), 0);
                exportToCsv(
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
                );
              }}
              style={{ font: "600 11px/1 var(--font-text)", color: "#16a34a" }}
            >
              {t("portalHoursExport", "Export CSV")}
            </button>
          )}
        </div>
        {data.entries.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 text-center">{emptyLabel}</div>
        ) : (
          <div
            className="bg-white overflow-hidden"
            style={{
              border: "1px solid #e8edf3", borderRadius: 20,
              boxShadow: "0 1px 2px rgba(15,23,42,.04), 0 16px 32px -24px rgba(15,23,42,.35)",
            }}
          >
            {data.entries.map((h, i) => {
              return (
                <div
                  key={i}
                  className="flex items-center"
                  style={{
                    gap: 11, padding: "13px 15px",
                    borderBottom: i === data.entries.length - 1 ? "none" : "1px solid #f1f5f9",
                  }}
                >
                  <span className="text-sm text-gray-500 flex-1">
                    {fmtDate(h.date, lang)} {h.start_time && h.end_time ? `· ${h.start_time}-${h.end_time}` : ""}
                  </span>
                  <span className="text-sm font-semibold text-gray-900 tabular-nums">{h.total_hours} {t("portalHrsShort")}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
          <div>
            <div className="font-text text-[10px] font-bold uppercase tracking-[0.15em] text-[#94a3b8] mb-2">
              {t("portalHoursRecentlyClocked", "Recently clocked")}
              <span className="ml-1 font-normal text-gray-400 normal-case tracking-normal">
                · {t("portalHoursRecentlyClockedWindow", "last {n} days", { n: winDays })}
              </span>
            </div>
            <div className="space-y-1.5">
              {extra.map((h, i) => (
                <div key={`rc-${i}`} className="flex items-center justify-between px-3 py-2.5 rounded-[18px] bg-white border border-[#e8edf3] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                  <span className="text-sm text-gray-500">
                    {fmtDate(h.date, lang)} {h.start_time && h.end_time ? `· ${h.start_time}-${h.end_time}` : ""}
                  </span>
                  <span className="text-sm font-semibold text-gray-900">{h.total_hours} {t("portalHrsShort")}</span>
                </div>
              ))}
            </div>
          </div>
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
function SwapTab({ token, ownShifts, onChanged }) {
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
      setClaimErr(errText(err, t("portalGaClaimFailed", "Couldn't take the shift. Try again.")));
      fetchInbox(); // it may have just been taken — refresh the pool
    } finally {
      setClaimBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Actions — trade (targeted) or sell (open pool) */}
      {!showPropose && !showSell && (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setShowPropose(true)}
            className="px-3 py-3 rounded-xl bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold transition flex items-center justify-center gap-1.5"
          >
            <ArrowLeftRight className="w-4 h-4" strokeWidth={2} aria-hidden />
            {t("portalOfferSwapShort", "Swap")}
          </button>
          <button
            onClick={() => setShowSell(true)}
            className="px-3 py-3 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-gray-900 text-sm font-semibold transition flex items-center justify-center gap-1.5"
          >
            <Send className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />
            {t("portalGaSellCta", "Give away a shift")}
          </button>
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

      {/* Colleagues' open give-aways — first qualified taker wins. */}
      {pool.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide font-medium text-gray-500">
            {t("portalGaPoolHeading", "Shifts up for grabs")}
          </div>
          {claimErr && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-[14px] px-2.5 py-1.5">{claimErr}</div>
          )}
          {pool.map((g) => {
            const clash = overlapsOwnShift(g.from_shift_date, g.from_shift_time, ownShifts);
            return (
            <div
              key={g.id}
              className="rounded-[18px] bg-white p-3 flex items-center gap-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
              style={{ border: clash ? "1px solid rgba(239,68,68,.28)" : "1px solid #e8edf3" }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900 flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{fmtSwapDay(g.from_shift_date, lang)}</span>
                  <span className="text-gray-500">· {g.from_shift_time}</span>
                  {/* v2's eligibility tag — the answer before the tap. */}
                  <span
                    className="shrink-0 rounded-full font-text text-[10px] font-bold uppercase tracking-[0.05em] px-2 py-0.5"
                    style={clash
                      ? { background: "#fee2e2", color: "#b91c1c" }
                      : { background: "#dcfce7", color: "#15803d" }}
                  >
                    {clash ? t("portalGaOverlaps", "Overlaps you") : t("portalGaFree", "Free for you")}
                  </span>
                </div>
                <div className="text-[11px] text-gray-500 truncate">
                  {t("portalGaFrom", "From")} {g.from_staff_name}
                  {g.from_branch_name ? ` · ${g.from_branch_name}` : ""}
                  {g.reason ? ` — “${g.reason}”` : ""}
                </div>
              </div>
              <button
                onClick={() => (clash
                  ? setClaimErr(t("portalGaBlockedWhy", "You already work then — that's why this one is blocked."))
                  : claimGiveaway(g.id))}
                disabled={claimBusy === g.id}
                aria-disabled={clash}
                className={`shrink-0 font-text text-[12px] font-bold px-3 py-2 rounded-[12px] disabled:opacity-50 ${
                  clash ? "bg-[#f1f5f9] text-gray-400" : "bg-gray-900 hover:bg-gray-700 text-white"
                }`}
              >
                {claimBusy === g.id
                  ? "…"
                  : clash
                    ? t("portalGaBlocked", "Blocked")
                    : t("portalGaTake", "Take it")}
              </button>
            </div>
            );
          })}
        </div>
      )}

      {/* Inbox */}
      {inbox === null && <div className="text-xs text-gray-500">{t("portalLoading", "Loading…")}</div>}
      {inbox && inbox.length === 0 && !showPropose && (
        <div className="text-center text-xs text-gray-500 py-6">
          {t("portalSwapNonePending", "No pending swap requests.")}
        </div>
      )}
      {inbox && inbox.length > 0 && (
        <div className="space-y-2">
          {inbox.map((s) => (
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

function fmtSwapDay(iso, lang) {
  if (!iso) return iso;
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(localeFor(lang), {
      weekday: "short", day: "numeric", month: "short",
    });
  } catch {
    return iso;
  }
}

function SwapRow({ swap, token, onChanged }) {
  const { t, lang } = useLanguage();
  const [busy, setBusy] = useState(false);

  const respond = async (accept) => {
    setBusy(true);
    try {
      await portalApi.post(
        `/portal/${token}/swap-requests/${swap.id}/respond`,
        { accept },
      );
      onChanged();
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

  // Status pills use STATUS colors only (design system): amber for the
  // pending "proposed" state, emerald for the completed "done"/byttet
  // state, neutral gray for everything else (declined/withdrawn/etc.).
  const statusPill = swap.status === "proposed"
    ? "bg-amber-50 border border-amber-200 text-amber-700"
    : swap.status === "done"
      ? "bg-emerald-50 border border-emerald-200 text-emerald-700"
      : swap.status === "accepted"
        ? "bg-gray-100 border border-gray-200 text-gray-700"
        : "bg-gray-100 border border-gray-200 text-gray-500";

  // Give-away = no counter-shift (to_shift_id null). Same state machine,
  // different words: the row reads "up for grabs / taken", never "swap".
  const isGiveaway = !swap.to_shift_id;

  // Localized status word for the pill. "Byttet" (swapped/done) stays
  // Danish across all UI languages per the DK terminology lock.
  const statusLabel = swap.status === "proposed"
    ? (isGiveaway ? t("portalGaStatusOpen", "Up for grabs") : t("portalSwapStatusProposed", "Pending"))
    : swap.status === "done"
      ? (isGiveaway ? t("portalGaStatusTaken", "Taken") : t("portalSwapStatusDone", "Byttet"))
      : swap.status === "declined"
        ? t("portalSwapStatusDeclined", "Declined")
        : swap.status === "withdrawn"
          ? t("portalSwapStatusWithdrawn", "Withdrawn")
          : swap.status;

  return (
    <div className="rounded-xl bg-white border border-gray-200 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide font-medium text-gray-500">
          {swap.direction === "outgoing" ? t("portalSwapOutgoing", "Outgoing") : t("portalSwapIncoming", "Incoming")}
        </span>
        <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${statusPill}`}>
          {statusLabel}
        </span>
      </div>
      <div className="text-sm text-gray-900">
        <span className="font-semibold">{swap.from_staff_name}</span>
        {isGiveaway ? (
          swap.status === "done" && swap.to_staff_name ? (
            <>
              <span className="text-gray-500"> → </span>
              <span className="font-semibold">{swap.to_staff_name}</span>
            </>
          ) : (
            <span className="text-gray-500"> · {t("portalGaOnBoard", "on the board")}</span>
          )
        ) : (
          <>
            <span className="text-gray-500"> → </span>
            <span className="font-semibold">{swap.to_staff_name}</span>
          </>
        )}
      </div>
      <div className={`grid gap-2 text-[11px] ${isGiveaway ? "grid-cols-1" : "grid-cols-2"}`}>
        <div className="bg-[#f5f8fb] rounded-[13px] p-1.5">
          <div className="text-[10px] text-gray-500">
            {isGiveaway ? t("portalGaShiftLabel", "Shift") : t("portalSwapGives", "Gives")}
          </div>
          <div className="text-gray-900">{fmtSwapDay(swap.from_shift_date, lang)}</div>
          <div className="text-gray-500">{swap.from_shift_time}</div>
        </div>
        {!isGiveaway && (
          <div className="bg-[#f5f8fb] rounded-[13px] p-1.5">
            <div className="text-[10px] text-gray-500">{t("portalSwapGets", "Gets")}</div>
            <div className="text-gray-900">{fmtSwapDay(swap.to_shift_date, lang)}</div>
            <div className="text-gray-500">{swap.to_shift_time}</div>
          </div>
        )}
      </div>
      {swap.reason && (
        <div className="text-[11px] text-gray-500 italic">"{swap.reason}"</div>
      )}
      {swap.owner_note && (
        <div className="text-[11px] text-gray-500">
          <span className="text-gray-500">{t("portalSwapOwnerLabel", "Owner")}:</span> {swap.owner_note}
        </div>
      )}

      {/* Actions */}
      {swap.status === "proposed" && swap.direction === "incoming" && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => respond(true)}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded bg-gray-900 hover:bg-gray-700 text-white disabled:opacity-50"
          >
            {t("portalSwapAccept", "Accept")}
          </button>
          <button
            onClick={() => respond(false)}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 disabled:opacity-50"
          >
            {t("portalSwapDecline", "Decline")}
          </button>
        </div>
      )}
      {swap.status === "proposed" && swap.direction === "outgoing" && (
        <div className="pt-1">
          <button
            onClick={withdraw}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 disabled:opacity-50"
          >
            {t("portalSwapWithdraw", "Withdraw")}
          </button>
        </div>
      )}
      {/* Completed: both staff agreed and the shifts have ALREADY been
          reassigned (auto-execute). Honest, final copy — no "awaiting
          owner". The schedule tab now shows the new shift. */}
      {swap.status === "done" && (
        <div className="flex items-center gap-1.5 text-[12px] text-emerald-700 pt-1">
          <Check className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
          <span>{t("portalSwapDoneLine", "Done — shifts swapped. Your schedule is updated.")}</span>
        </div>
      )}
      {/* Legacy/edge: a swap left in `accepted` (e.g. a future owner-
          approval flow). Calm, non-promising copy. */}
      {swap.status === "accepted" && (
        <div className="flex items-center gap-1.5 text-[12px] text-gray-700 pt-1">
          <Check className="w-3.5 h-3.5 shrink-0 text-emerald-600" strokeWidth={2.5} aria-hidden />
          <span>{t("portalSwapAcceptedLine", "Both staff agreed.")}</span>
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
      setError(errText(err, t("portalGaOfferFailed", "Couldn't post the shift. Try again.")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-[20px] bg-white border border-[#e8edf3] p-4 space-y-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_32px_-24px_rgba(15,23,42,0.35)]">
      <div className="flex items-center justify-between">
        <div className="font-display text-[14.5px] font-bold tracking-[-0.02em] leading-[1.1] text-gray-900 flex items-center gap-1.5">
          <Send className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />
          {t("portalGaSellCta", "Give away a shift")}
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700 text-lg w-6 h-6 flex items-center justify-center"
          aria-label={t("close", "Close")}
        >
          ×
        </button>
      </div>
      <p className="text-[11px] text-gray-500 leading-snug">
        {t("portalGaSellHint", "Your shift goes on the board for colleagues. You keep it until someone takes it — first to take it, gets it.")}
      </p>
      <select
        value={shiftId}
        onChange={(e) => setShiftId(e.target.value)}
        className="w-full px-3 py-2 rounded-[14px] border border-[#e2e8f0] bg-[#fbfdff] text-sm text-gray-800"
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
        className="w-full px-3 py-2 rounded-[14px] border border-[#e2e8f0] bg-[#fbfdff] text-sm text-gray-800"
      />
      {error && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-[14px] px-2.5 py-1.5">{error}</div>
      )}
      <button
        onClick={submit}
        disabled={!shiftId || submitting}
        className="w-full px-4 py-2.5 rounded-xl bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold transition disabled:opacity-50"
      >
        {submitting ? "…" : t("portalGaSellSubmit", "Put it up for grabs")}
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
  const candidateTeamShifts = teamShifts.filter(
    (s) => s.shift_id !== fromShiftId && s.staff_id !== ownStaffId,
  );

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
      setError(errText(err, t("portalSwapProposeFailed", "Couldn't propose. Try again.")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-[20px] bg-white border border-[#e8edf3] p-4 space-y-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_32px_-24px_rgba(15,23,42,0.35)]">
      <div className="flex items-center justify-between">
        <div className="font-display text-[14.5px] font-bold tracking-[-0.02em] leading-[1.1] text-gray-900 flex items-center gap-1.5"><ArrowLeftRight className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />{t("portalOfferSwap", "Offer to swap")}</div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700 text-lg w-6 h-6 flex items-center justify-center"
          aria-label={t("close", "Close")}
        >
          ×
        </button>
      </div>

      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">
          {t("portalSwapGiveUp", "Your shift to give up")}
        </label>
        <select
          value={fromShiftId}
          onChange={(e) => { setFromShiftId(e.target.value); setToShiftId(""); }}
          className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 outline-none focus:border-gray-900"
        >
          <option value="">{t("portalSwapPickOwn", "Pick one of your shifts…")}</option>
          {upcomingOwn.map((s) => (
            <option key={s.id} value={s.id}>
              {fmtSwapDay(s.date, lang)} · {s.start_time}–{s.end_time}
            </option>
          ))}
        </select>
      </div>

      {fromShiftId && (
        <div>
          <label className="text-[11px] text-gray-500 mb-1 block">
            {t("portalSwapTakeInExchange", "Teammate's shift you'd take in exchange")}
          </label>
          <select
            value={toShiftId}
            onChange={(e) => setToShiftId(e.target.value)}
            className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 outline-none focus:border-gray-900"
          >
            <option value="">{t("portalSwapPickTeammate", "Pick a teammate's shift…")}</option>
            {candidateTeamShifts.map((s) => (
              <option key={s.shift_id} value={s.shift_id}>
                {s.staff_name} — {fmtSwapDay(s.date, lang)} · {s.start_time}–{s.end_time}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">
          {t("portalSwapReason", "Reason")} <span className="text-gray-400">{t("portalSwapReasonOptional", "(optional)")}</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          rows={2}
          placeholder={t("portalSwapReasonPlaceholder", "e.g. family wedding, doctor appt")}
          className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900 resize-none"
        />
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <button
        onClick={submit}
        disabled={submitting || !fromShiftId || !toShiftId}
        className="w-full px-4 py-2.5 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold transition disabled:opacity-50"
      >
        {submitting ? t("portalSending", "Sending...") : t("portalSwapSubmit", "Send swap request")}
      </button>
      <div className="text-[10px] text-gray-400 text-center leading-snug">
        {t("portalSwapProposeHint", "Your teammate will see this in their inbox. If they accept, the two shifts swap automatically.")}
      </div>
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
    const detail = cut > 0 ? subject.slice(cut + 3) : subject;
    const cancelled = /cancelled/i.test(subject);

    let kind = n.event_type;
    if (n.event_type === "shift_changed" && cancelled) kind = "shift_deleted";

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
              onClick={target ? () => onNavigate(target) : undefined}
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

/** One row in the conversation list. Unread is carried by weight and a solid
    card, not just a badge — a badge alone is invisible in a hurried glance. */
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
      className="w-full text-left flex items-center"
      style={{
        gap: 11, padding: "12px 13px", borderRadius: 16,
        background: unread ? "#fff" : "rgba(255,255,255,0.55)",
        border: `1px solid ${unread ? "#e8edf3" : "#eef2f7"}`,
        boxShadow: unread
          ? "0 1px 2px rgba(15,23,42,0.04),0 14px 28px -26px rgba(15,23,42,0.4)"
          : "none",
      }}
    >
      <span
        aria-hidden
        className="flex-none flex items-center justify-center"
        style={{
          width: 38, height: 38, borderRadius: 13,
          // The owner channel wears the venue's near-black so it never reads as
          // just another colleague.
          background: isGroup
            ? mateTone(name)
            : "linear-gradient(150deg,#1e293b,#0f172a)",
          color: isGroup ? "#0f172a" : "#e2e8f0",
          font: "700 12px/1 var(--font-text)",
        }}
      >
        {isGroup ? <Users className="w-4 h-4" strokeWidth={2.2} /> : staffInitials(name)}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className="truncate"
            style={{ font: `${unread ? 700 : 600} 12.5px/1 var(--font-text)`, color: "#0f172a" }}
          >
            {name}
          </span>
          <span className="flex-none" style={{ font: "500 10.5px/1 var(--font-text)", color: "#94a3b8" }}>
            {thread.last_message_at ? formatTimeAgo(thread.last_message_at, lang, t) : ""}
          </span>
        </span>
        <span
          className="block truncate"
          style={{
            marginTop: 5,
            font: `${unread ? 500 : 400} 11.5px/1.35 var(--font-text)`,
            color: unread ? "#475569" : "#94a3b8",
          }}
        >
          {preview}
        </span>
      </span>
      <span
        className="flex-none text-center"
        style={{
          minWidth: 19, height: 19, padding: "0 5px", borderRadius: 999,
          background: "#16a34a", color: "#fff",
          font: "700 10px/19px var(--font-text)",
          opacity: unread ? 1 : 0,
        }}
      >
        {unread > 9 ? "9+" : unread || ""}
      </span>
    </button>
  );
}


/** Create a group. Deliberately two fields and nothing else — a name and who
    is in it. Colleagues come from an endpoint that returns names and roles
    only, so this picker cannot become a staff directory. */
function NewGroupSheet({ token, onClose, onCreated }) {
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
    <div className="fixed inset-0 z-40 flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-gray-900/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("staffChatNewGroup", "New group")}
        className="relative w-full sm:max-w-sm bg-white"
        style={{
          borderRadius: "22px 22px 0 0",
          paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
        }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h3 className="font-display text-[15px] font-bold tracking-[-0.02em] text-gray-900">
            {t("staffChatNewGroup", "New group")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("staffChatCancel", "Cancel")}
            className="p-1.5 -mr-1.5 text-gray-400"
          >
            <X className="w-[18px] h-[18px]" strokeWidth={2.2} aria-hidden />
          </button>
        </div>

        <div className="px-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            placeholder={t("staffChatGroupNamePlaceholder", "e.g. Kitchen")}
            className="w-full bg-white outline-none placeholder:text-[#94a3b8]"
            style={{
              padding: "12px 14px", borderRadius: 14, border: "1px solid #e2e8f0",
              font: "500 13px/1.35 var(--font-text)", color: "#0f172a",
            }}
          />
          <p
            className="mt-3 mb-1.5"
            style={{
              font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.06em",
              textTransform: "uppercase", color: "#94a3b8",
            }}
          >
            {t("staffChatChoosePeople", "Who's in it?")}
          </p>
        </div>

        <div className="px-4 overflow-y-auto" style={{ maxHeight: "42vh" }}>
          {colleagues === null ? (
            <div className="space-y-2 animate-pulse py-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-11 rounded-xl bg-gray-100" />)}
            </div>
          ) : colleagues.length === 0 ? (
            <p className="text-sm text-gray-500 py-3">
              {t("staffChatNoColleagues", "No colleagues to add yet.")}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 pb-2">
              {colleagues.map((c) => {
                const on = picked.includes(c.staff_id);
                return (
                  <button
                    key={c.staff_id}
                    type="button"
                    onClick={() => toggle(c.staff_id)}
                    aria-pressed={on}
                    className="w-full flex items-center text-left"
                    style={{
                      gap: 10, padding: "9px 11px", borderRadius: 13,
                      border: `1px solid ${on ? "#bbf7d0" : "#eef2f7"}`,
                      background: on ? "#f0fdf4" : "#fff",
                    }}
                  >
                    <span
                      aria-hidden
                      className="flex-none text-center"
                      style={{
                        width: 30, height: 30, borderRadius: 10,
                        background: mateTone(c.name), color: "#0f172a",
                        font: "700 10.5px/30px var(--font-text)",
                      }}
                    >
                      {staffInitials(c.name)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate" style={{ font: "600 12.5px/1 var(--font-text)", color: "#0f172a" }}>
                        {c.name}
                      </span>
                      {c.role && (
                        <span className="block truncate" style={{ marginTop: 3, font: "400 11px/1 var(--font-text)", color: "#94a3b8" }}>
                          {c.role}
                        </span>
                      )}
                    </span>
                    {on && <Check className="w-4 h-4 text-green-600 flex-none" strokeWidth={2.6} aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 pt-3">
          {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
          <button
            type="button"
            onClick={create}
            disabled={!title.trim() || busy}
            className="w-full text-white disabled:opacity-40 transition"
            style={{
              height: 46, borderRadius: 14,
              background: "linear-gradient(180deg,#22c55e,#16a34a)",
              font: "700 13px/1 var(--font-text)",
              boxShadow: "0 10px 22px -14px rgba(22,163,74,.9)",
            }}
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
      <div className="flex items-center gap-2">
        <div
          className="flex-1 flex items-center"
          style={{ gap: 9, height: 42, padding: "0 13px", borderRadius: 13, background: "#eaeff5" }}
        >
          <Search className="w-[15px] h-[15px] flex-none text-[#94a3b8]" strokeWidth={2.1} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("staffChatSearch", "Search people and messages")}
            aria-label={t("staffChatSearch", "Search people and messages")}
            className="flex-1 bg-transparent outline-none placeholder:text-[#94a3b8]"
            style={{ font: "400 12.5px/1 var(--font-text)", color: "#0f172a" }}
          />
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          aria-label={t("staffChatNewGroup", "New group")}
          className="flex-none flex items-center justify-center text-white"
          style={{
            width: 42, height: 42, borderRadius: 13,
            background: "linear-gradient(180deg,#22c55e,#16a34a)",
            boxShadow: "0 8px 18px -12px rgba(22,163,74,.95)",
          }}
        >
          <Plus className="w-[18px] h-[18px]" strokeWidth={2.4} aria-hidden />
        </button>
      </div>

      <div style={{ marginTop: 14 }} className="flex flex-col gap-2">
        {threads === null ? (
          [1, 2, 3].map((i) => (
            <div key={i} className="h-[62px] rounded-2xl bg-gray-100 animate-pulse" />
          ))
        ) : shown.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="w-8 h-8 text-gray-300 mb-3 mx-auto" strokeWidth={2} aria-hidden />
            <p className="text-sm text-gray-500">
              {q
                ? t("staffChatNoMatches", "Nothing matches that.")
                : t("staffChatEmptyBody", "Send your manager a message — questions, running late, anything.")}
            </p>
          </div>
        ) : (
          shown.map((th) => (
            <ThreadRow key={th.thread_id} thread={th} onOpen={() => onOpen(th)} />
          ))
        )}
      </div>

      {creating && (
        <NewGroupSheet
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
  const heading = isGroup
    ? meta?.title || t("staffChatGroup", "Group")
    : restaurantName || t("staffChatOwnerLabel", "Manager");

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between" style={{ padding: "2px 0 12px" }}>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center"
          style={{ gap: 7, font: "600 12px/1 var(--font-text)", color: "#16a34a" }}
        >
          <ChevronLeft className="w-[14px] h-[14px]" strokeWidth={2.4} aria-hidden />
          {t("staffChatAllConversations", "All conversations")}
        </button>
        {isGroup && (
          <button
            type="button"
            onClick={leave}
            style={{ font: "600 11.5px/1 var(--font-text)", color: "#94a3b8" }}
          >
            {t("staffChatLeave", "Leave")}
          </button>
        )}
      </div>

      <div style={{ marginBottom: 10 }}>
        <h2 className="font-display text-[15px] font-bold tracking-[-0.02em] leading-[1.2] text-gray-900">
          {heading}
        </h2>
        <p style={{ marginTop: 3, font: "400 11px/1 var(--font-text)", color: "#94a3b8" }}>
          {isGroup && memberCount
            ? t("staffChatMemberCount", "{n} people").replace("{n}", String(memberCount))
            : t("staffChatDirectSub", "Your manager")}
        </p>
      </div>

      {/* Message stream */}
      <div
        ref={scrollRef}
        className="flex flex-col overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 20rem)", gap: 9 }}
      >
        {messages === null ? (
          <div className="space-y-2 animate-pulse">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className={`h-9 rounded-2xl bg-gray-100 ${i % 2 ? "w-2/3" : "w-1/2 ml-auto"}`}
              />
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare
              className="w-8 h-8 text-gray-300 mb-3 mx-auto"
              strokeWidth={2}
              aria-hidden
            />
            <h3 className="font-display text-[14.5px] font-bold tracking-[-0.02em] leading-[1.2] text-gray-900 mb-1">
              {t("staffChatEmptyTitle", "No messages yet")}
            </h3>
            <p className="text-sm text-gray-500">
              {isGroup
                ? t("staffChatGroupEmptyBody", "Say hello — everyone here will see it.")
                : t(
                    "staffChatEmptyBody",
                    "Send your manager a message — questions, running late, anything.",
                  )}
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.mine ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-[78%] ${m.mine ? "items-end" : "items-start"} flex flex-col`}>
                {!m.mine && (
                  <span style={{ font: "600 9.5px/1 var(--font-text)", letterSpacing: "0.06em", textTransform: "uppercase", color: "#94a3b8", padding: "0 4px", marginBottom: 4 }}>
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
                    className={`whitespace-pre-wrap break-words ${m._pending ? "opacity-60" : ""} ${m._failed ? "cursor-pointer ring-1 ring-red-300" : ""}`}
                    style={{
                      maxWidth: "80%",
                      padding: "11px 13px",
                      borderRadius: m.mine ? "16px 16px 5px 16px" : "16px 16px 16px 5px",
                      font: "400 12.5px/1.45 var(--font-text)",
                      textWrap: "pretty",
                      background: m.mine ? "linear-gradient(180deg,#22c55e,#16a34a)" : "#fff",
                      color: m.mine ? "#fff" : "#0f172a",
                      border: m.mine ? "none" : "1px solid #e8edf3",
                      boxShadow: m.mine
                        ? "0 10px 22px -14px rgba(22,163,74,.9)"
                        : "0 1px 2px rgba(15,23,42,.04)",
                    }}
                  >
                    {m.body}
                  </div>
                )}
                <span style={{ font: "500 9.5px/1 var(--font-text)", color: "#cbd5e1", padding: "0 4px", marginTop: 4 }}>
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

      {/* Composer — fixed above the bottom nav, notch-aware. */}
      <div
        className={`fixed inset-x-0 z-20 glass border-t border-gray-200/70${BAR_V2 ? " bb-lg-composer" : ""}`}
        style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom))" }}
      >
        <div className="max-w-lg mx-auto px-3 pt-2">
          <PendingPhotos picker={picker} />
          <div className="pb-2 flex items-end gap-1.5">
            <AttachButton picker={picker} label={t("staffChatAddPhoto", "Add photo")} />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={t("staffChatPlaceholder", "Write a message…")}
              className="flex-1 resize-none max-h-28 bg-white outline-none placeholder:text-[#94a3b8]"
              style={{
                minHeight: 42, padding: "12px 15px", borderRadius: 999,
                border: "1px solid #e2e8f0",
                font: "400 12.5px/1.35 var(--font-text)", color: "#0f172a",
              }}
            />
            <button
              onClick={send}
              disabled={(!text.trim() && picker.files.length === 0) || sending}
              aria-label={t("staffChatSend", "Send")}
              className="shrink-0 flex items-center justify-center text-white disabled:opacity-40 transition"
              style={{
                width: 42, height: 42, borderRadius: 999,
                background: "linear-gradient(180deg,#22c55e,#16a34a)",
                boxShadow: "0 8px 18px -10px rgba(22,163,74,.95), inset 0 1px 0 rgba(255,255,255,.35)",
              }}
            >
              <Send className="w-[18px] h-[18px]" strokeWidth={2} aria-hidden />
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

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="grid grid-cols-2 gap-3">
        <div className="h-20 bg-[#eef2f7] rounded-2xl" />
        <div className="h-20 bg-[#eef2f7] rounded-2xl" />
      </div>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-14 bg-gray-100 rounded-xl" />
      ))}
    </div>
  );
}


// ─── Error / Not Found ────────────────────────────────────────────────────

function PortalError({ message }) {
  const { t } = useLanguage();
  return (
    <div className="min-h-screen bg-[#f5f7fb] flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <Inbox className="w-8 h-8 text-gray-300 mb-3 mx-auto" strokeWidth={2} aria-hidden />
        <h1 className="text-xl font-bold text-gray-900 mb-2">{t("portalErrorTitle", "Link not working")}</h1>
        <p className="text-sm text-gray-500">{message || t("portalErrorBody", "This link may have expired or been deactivated. Ask your manager for a new one.")}</p>
        {/* Deliberately a raw <a>, NOT a react-router <Link>: this is the
            "link not working" screen for a dead/expired portal token, and the
            full document load is what discards that token and the portal's
            in-memory state. A soft navigation would carry the dead session
            into /join. */}
        <a
          href="/join"
          className="inline-block mt-4 text-sm font-medium text-gray-700 underline underline-offset-2 hover:text-gray-900"
        >
          {t("portalErrorJoin", "Have a join code? Connect here")}
        </a>
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
function AbsenceSection({ token, onChanged }) {
  const { t, lang } = useLanguage();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState("ferie");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");

  const load = async () => {
    try {
      const res = await portalApi.get(`/portal/${token}/absence`);
      setRows(res.data?.absence || []);
    } catch { setRows([]); }
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
  const REGISTERED = { label: t("fravaerStatusRegistered", "Registered"), cls: "bg-gray-100 text-gray-600" };
  const STATUS = {
    pending: { label: t("fravaerStatusPending", "Pending"), cls: "bg-amber-100 text-amber-700" },
    acknowledged: { label: t("fravaerStatusApproved", "Approved"), cls: "bg-emerald-100 text-emerald-700" },
    covered: { label: t("fravaerStatusApproved", "Approved"), cls: "bg-emerald-100 text-emerald-700" },
    cancelled: { label: t("fravaerStatusCancelled", "Cancelled"), cls: "bg-gray-100 text-gray-500" },
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
    <div className="space-y-3">
      <div>
        {/* Neutral heading. This list holds BOTH kinds — GET /absence has no kind
            filter (staff_portal.py ~2382), so a Schedule-tab sygemelding lands
            here too — and labelling the whole section "needs approval" put those
            words directly above a row chipped "Registered". Each row carries its
            own truth now: amber Afventer for a request, grey Registreret for a
            sick day. The approval sentence moved to the button it describes. */}
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          {t("fravaerHeadingNeutral", "Time off")}
        </div>
      </div>

      {rows === null ? (
        <div className="text-xs text-gray-500">{t("portalLoading", "Loading…")}</div>
      ) : groups.length > 0 ? (
        <div className="space-y-2">
          {groups.map((g) => {
            // A sygemelding is a fact, not an application, so it never wears
            // the amber "Afventer". Cancelled still shows for both kinds —
            // that one IS a real state change the staffer made.
            const st = isNotifyKind(g.kind) && g.status !== "cancelled"
              ? REGISTERED
              : (STATUS[g.status] || STATUS.pending);
            return (
              <div key={g.ids[0]} className="rounded-[18px] bg-white border border-[#e8edf3] p-3 flex items-center gap-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                <div className="w-9 h-9 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                  <CalendarPlus className="w-[18px] h-[18px] text-gray-500" strokeWidth={2} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-[14px] font-bold tracking-[-0.025em] tabular-nums text-gray-900 truncate">
                    {KIND_LABEL[g.kind] || g.kind} · {fmtRange(g.startDate, g.endDate)}
                  </div>
                  {g.reason && <div className="text-[12px] text-gray-500 truncate">{g.reason}</div>}
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${st.cls}`}>{st.label}</span>
                {g.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => withdraw(g)}
                    className="shrink-0 text-[11px] font-medium text-gray-500 hover:text-gray-700 underline underline-offset-2"
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
        <button
          onClick={() => { reset(); setAdding(true); }}
          className="w-full px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          <CalendarPlus className="w-4 h-4" strokeWidth={2.25} aria-hidden />
          {t("fravaerAdd", "Request time off")}
        </button>
        <p className="text-[12px] text-gray-500 leading-snug mt-2">
          {t("fravaerNeedsApprovalSub", "This is a request — your manager approves it. You'll see Pending, then Approved.")}
        </p>
        </div>
      ) : (
        <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-4">
          <div className="grid grid-cols-2 gap-1.5">
            {/* Sygdom deliberately absent: this form's banner promises manager
                approval, and that is a lie for a sick day. Sick lives on the
                Schedule tab, which notifies the owner and binds the shift —
                register_absence does neither. VALID_ABSENCE_KINDS still accepts
                "sick" server-side so an un-updated App Store bundle keeps
                working; only this picker stops creating them. */}
            {["ferie", "andet"].map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`py-2 rounded-lg text-[12px] font-semibold transition ${kind === k ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-gray-500 mb-1 block">{t("fravaerFrom", "From")}</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 outline-none focus:border-gray-900/30" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 mb-1 block">{t("fravaerTo", "To (optional)")}</label>
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
                className="w-full px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 outline-none focus:border-gray-900/30" />
            </div>
          </div>
          <input
            type="text" value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)}
            placeholder={t("fravaerNotePlaceholder", "Note (optional)")}
            className="w-full px-3 py-2.5 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
          />
          <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-snug">
            {t("fravaerNeedsApproval", "This is a request — your manager must approve it.")}
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex gap-2">
            <button onClick={() => { setAdding(false); reset(); }}
              className="flex-1 py-2.5 rounded-[14px] bg-[#f1f5f9] text-gray-700 font-text text-[13px] font-bold hover:bg-[#e2e8f0] transition">
              {t("portalCancel", "Cancel")}
            </button>
            <button onClick={submit} disabled={saving}
              className="flex-1 py-2.5 rounded-[14px] bg-gray-900 text-white font-text text-[13px] font-bold hover:bg-gray-700 transition disabled:opacity-50">
              {saving ? t("portalSaving", "Saving…") : t("fravaerSubmit", "Send request")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
    <div
      className="bg-white"
      style={{
        border: "1px solid #e8edf3", borderRadius: 20, padding: 8,
        boxShadow: "0 1px 2px rgba(15,23,42,.04), 0 16px 32px -24px rgba(15,23,42,.35)",
      }}
    >
      {/* Month nav — mutates view only, never data */}
      <div className="flex items-center justify-between px-1 pb-1">
        <button type="button" onClick={onPrev} aria-label={t("kanIkkePrevMonth", "Previous month")}
          className="w-9 h-9 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 rounded-[11px] flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-[#eef2f7] transition">
          <ChevronLeft className="w-5 h-5" strokeWidth={2} aria-hidden />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-gray-900 capitalize truncate">{monthLabel}</span>
          {showToday && (
            <button type="button" onClick={onToday}
              className="text-[12px] text-gray-500 hover:text-gray-900 underline underline-offset-2">
              {t("calToday", "Today")}
            </button>
          )}
        </div>
        <button type="button" onClick={onNext} aria-label={t("kanIkkeNextMonth", "Next month")}
          className="w-9 h-9 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 rounded-[11px] flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-[#eef2f7] transition">
          <ChevronRight className="w-5 h-5" strokeWidth={2} aria-hidden />
        </button>
      </div>

      {/* Weekday header (Monday-first, localized) */}
      <div className="grid grid-cols-7 mb-1">
        {WD.map((w, i) => (
          <div key={i} className="text-[11px] font-medium text-gray-400 uppercase text-center py-1">{w}</div>
        ))}
      </div>

      {/* 6×7 day grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((iso) => {
          const cellDate = new Date(iso + "T00:00:00");
          const inMonth = cellDate.getMonth() === viewMonth;
          const dayNum = cellDate.getDate();
          if (!inMonth) {
            return (
              <div key={iso} className="aspect-square min-h-[44px] flex items-center justify-center text-[15px] text-gray-300 tabular-nums select-none">
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

          // Exactly ONE background — precedence: approved > pending > one-off > recurring > free.
          //
          // "Can't work" takes v2's treatment: a red wash with the date STRUCK
          // THROUGH. The old solid gray-900 square read as "selected", which is
          // the opposite of what it means — a struck-out date is unambiguous at
          // a glance and needs no legend. The manager-answer states (approved /
          // pending) stay as they are: v2 has no equivalent, and green/amber
          // already say "this is their reply, not your note".
          let fill = "", num = "text-gray-900", ring = "", style, strike = false;
          let tappable = !past;
          if (approved) { fill = "bg-emerald-50"; ring = "ring-1 ring-inset ring-emerald-200"; num = "text-emerald-700 font-semibold"; tappable = false; }
          else if (pending) { fill = "bg-amber-50"; ring = "ring-1 ring-inset ring-amber-200"; num = "text-amber-700 font-semibold"; tappable = false; }
          else if (oneOff && oneOff.kind === "preferred") {
            // "Helst" — a soft yes. Green, and NOT struck through: this day is
            // still workable, which is the whole difference from "kan ikke".
            style = {
              background: "linear-gradient(180deg,#dcfce7,#bbf7d0)",
              border: "1px solid rgba(22,163,74,.35)",
            };
            num = "font-semibold";
          } else if (oneOff) {
            style = {
              background: "linear-gradient(180deg,#fee2e2,#fecaca)",
              border: "1px solid rgba(239,68,68,.32)",
            };
            num = "font-semibold";
            strike = true;
          } else if (recurring) {
            // Same meaning as a one-off, every week — so the same red family,
            // but outlined rather than filled so the two stay distinguishable.
            style = { border: "1px solid rgba(239,68,68,.32)" };
            num = "";
          }
          if (past) num = "text-gray-300 font-normal";

          const cls =
            "relative aspect-square min-h-[44px] rounded-xl flex items-center justify-center text-[15px] font-medium tabular-nums transition " +
            fill + " " + ring + " " + num +
            (tappable ? " active:scale-[0.97] cursor-pointer" : " cursor-default") +
            (saving ? " opacity-60" : "") +
            (today && !fill && !ring && !style ? " bg-gray-100" : "") +
            (past && (oneOff || abs || recurring) ? " opacity-40" : "");

          // v2's ink for the red states; `past` still wins so history stays quiet.
          const cellStyle = past
            ? style
            : { ...style, ...(oneOff ? { color: oneOff.kind === "preferred" ? "#14532d" : "#7f1d1d" } : recurring ? { color: "#b91c1c" } : null) };

          const shiftDot = oneOff ? (oneOff.kind === "preferred" ? "bg-green-700" : "bg-red-700") : approved ? "bg-emerald-600" : pending ? "bg-amber-500" : "bg-gray-900";

          return (
            <button
              key={iso}
              type="button"
              disabled={!tappable || saving}
              aria-disabled={!tappable}
              aria-current={today ? "date" : undefined}
              aria-label={iso}
              onClick={() => tappable && onTapDay(iso, { oneOff, recurring, abs, wd })}
              className={cls}
              style={cellStyle}
            >
              <span
                className={today ? "font-bold" : ""}
                style={strike && !past ? { textDecoration: "line-through", textDecorationThickness: "1.5px" } : undefined}
              >
                {dayNum}
              </span>
              {recurring && !oneOff && !abs && (
                <Repeat className="absolute top-0.5 right-0.5 w-2.5 h-2.5 text-red-500" strokeWidth={2.5} aria-hidden />
              )}
              {oneOff?.timed && (
                <Clock className="absolute bottom-0.5 left-0.5 w-2.5 h-2.5 text-red-800" strokeWidth={2.5} aria-hidden />
              )}
              {hasShift && (
                <span className={`absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${shiftDot}`} aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* MarkedDayRow — one one-off "Kan ikke" date; expands to set a time-window /
   note (DELETE+POST since the backend has no PATCH). */
function MarkedDayRow({ row, label, expanded, onToggle, onRemove, onSave, t }) {
  const [allDay, setAllDay] = useState(!row.timed);
  const [start, setStart] = useState(row.start || "08:00");
  const [end, setEnd] = useState(row.end || "12:00");
  const [note, setNote] = useState(row.note || "");
  const timeText = row.timed ? `${row.start}–${row.end}` : t("kanIkkeAllDay", "All day");
  return (
    <div className="rounded-xl bg-white border border-gray-200">
      <div className="p-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gray-900 flex items-center justify-center shrink-0">
          <CalendarOff className="w-[18px] h-[18px] text-white" strokeWidth={2} aria-hidden />
        </div>
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="font-display text-[14px] font-bold tracking-[-0.025em] tabular-nums text-gray-900 truncate">{label}</div>
          <div className="text-[12px] text-gray-500 truncate">
            {timeText}{row.note ? ` · ${row.note}` : ` · ${t("kanIkkeAddTimeNote", "Add a time / note")}`}
          </div>
        </button>
        <button type="button" onClick={onRemove} aria-label={t("kanIkkeRemove", "Remove")}
          className="w-8 h-8 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center transition shrink-0">
          <X className="w-4 h-4" strokeWidth={2} aria-hidden />
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-3 space-y-3 border-t border-[#f1f5f9]">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] font-medium text-gray-700">{t("kanIkkeAllDay", "All day")}</span>
            <button type="button" role="switch" aria-checked={allDay} onClick={() => setAllDay(!allDay)}
              className={`relative w-11 h-6 rounded-full transition ${allDay ? "bg-gray-900" : "bg-gray-300"}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${allDay ? "translate-x-5" : ""}`} />
            </button>
          </label>
          {!allDay && (
            <div className="flex items-center gap-2">
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)}
                className="flex-1 px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm outline-none focus:border-gray-900/30" />
              <span className="text-gray-400" aria-hidden>–</span>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)}
                className="flex-1 px-3 py-2 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm outline-none focus:border-gray-900/30" />
            </div>
          )}
          <input type="text" value={note} maxLength={80} onChange={(e) => setNote(e.target.value)}
            placeholder={t("kanIkkeNotePlaceholder", "Note (optional) — e.g. exam")}
            className="w-full px-3 py-2.5 rounded-[14px] bg-[#fbfdff] border border-[#e2e8f0] text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30" />
          <button type="button" onClick={() => onSave(allDay, start, end, note)}
            className="w-full py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700 transition">
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
 * The fast surface: seven cells, one tap each.
 *
 * Cell treatment is the prototype's — red gradient + strike-through for "kan
 * ikke", green gradient for "helst", flat #f5f8fb when free. A day already
 * governed by an absence request is NOT tappable here, exactly as in the month
 * view: that day belongs to the approval flow, and a soft tap must not look
 * like it can override it.
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
  const range = `${days[0].toLocaleDateString(localeFor(lang), { day: "numeric", month: "short" })} – ${days[6].toLocaleDateString(localeFor(lang), { day: "numeric", month: "short" })}`;
  const markedThisWeek = days.filter((d) => oneOffByDate[iso(d)]).length;

  return (
    <div
      className="bg-white"
      style={{
        border: "1px solid #e8edf3", borderRadius: 20, padding: 15,
        boxShadow: "0 1px 2px rgba(15,23,42,.04), 0 16px 32px -24px rgba(15,23,42,.35)",
      }}
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => onShiftWeek(weekOffset - 1)}
          aria-label={t("portalPrevWeek", "Previous week")}
          className="flex items-center justify-center -m-2"
          style={{ color: "#94a3b8", minWidth: 44, minHeight: 44 }}
        >
          <ChevronLeft size={16} strokeWidth={2.5} />
        </button>
        <span style={{ font: "700 10px/1 var(--font-text)", letterSpacing: "0.15em", textTransform: "uppercase", color: "#94a3b8" }}>
          {range}
        </span>
        <button
          type="button"
          onClick={() => onShiftWeek(weekOffset + 1)}
          aria-label={t("portalNextWeek", "Next week")}
          className="flex items-center justify-center -m-2"
          style={{ color: "#94a3b8", minWidth: 44, minHeight: 44 }}
        >
          <ChevronRight size={16} strokeWidth={2.5} />
        </button>
      </div>

      <div className="flex" style={{ marginTop: 13, gap: 4 }}>
        {days.map((d) => {
          const key = iso(d);
          const one = oneOffByDate[key];
          const abs = absenceByDate[key];
          const recurring = !one && recurringSet.has((d.getDay() + 6) % 7);
          const past = key < todayISO;
          const saving = savingSet.has(key);
          const pref = one?.kind === "preferred";
          const on = !!one;
          const rostered = shiftSet?.has(key);

          let cell = { background: "#f5f8fb", border: "1px solid #eef2f7" };
          let dow = "#94a3b8";
          let num = "#0f172a";
          let dot = "transparent";
          if (abs) {
            const ok = abs.status === "acknowledged" || abs.status === "covered";
            cell = { background: ok ? "#ecfdf5" : "#fffbeb", border: `1px solid ${ok ? "#a7f3d0" : "#fde68a"}` };
            dow = ok ? "#15803d" : "#b45309"; num = ok ? "#14532d" : "#92400e";
          } else if (on && pref) {
            cell = { background: "linear-gradient(180deg,#dcfce7,#bbf7d0)", border: "1px solid rgba(22,163,74,.35)" };
            dow = "#15803d"; num = "#14532d"; dot = "#16a34a";
          } else if (on) {
            cell = { background: "linear-gradient(180deg,#fee2e2,#fecaca)", border: "1px solid rgba(239,68,68,.32)" };
            dow = "#b91c1c"; num = "#7f1d1d"; dot = "#ef4444";
          } else if (recurring) {
            cell = { background: "#f5f8fb", border: "1px solid rgba(239,68,68,.32)" };
            dow = "#b91c1c";
          }

          const locked = !!abs || past;
          return (
            <button
              key={key}
              type="button"
              disabled={locked || saving}
              onClick={() => onTapDay(key, { oneOff: one, abs, recurring, wd: (d.getDay() + 6) % 7 })}
              aria-pressed={!locked ? !!one : undefined}
              aria-label={[
                d.toLocaleDateString(localeFor(lang), { weekday: "long", day: "numeric", month: "long" }),
                abs ? t("legendApproved", "Approved off")
                  : one?.kind === "preferred" ? t("legendPreferred", "Prefers")
                  : one ? t("legendCantWork", "Can't work")
                  : recurring ? t("legendRepeats", "Every week")
                  : null,
                rostered ? t("legendScheduled", "Scheduled") : null,
              ].filter(Boolean).join(" — ")}
              className="flex flex-col items-center"
              style={{
                flex: "1 1 0", minWidth: 0, gap: 5, padding: "9px 0 10px", borderRadius: 13,
                transition: "all .2s", opacity: past ? 0.4 : saving ? 0.6 : 1,
                cursor: locked ? "default" : "pointer", ...cell,
              }}
            >
              <span style={{ font: "600 9.5px/1 var(--font-text)", color: dow }}>
                {d.toLocaleDateString(localeFor(lang), { weekday: "short" }).replace(".", "").slice(0, 3)}
              </span>
              <span
                className="tabular-nums"
                style={{
                  font: "700 13.5px/1 var(--font-display)", letterSpacing: "-0.02em", color: num,
                  textDecoration: on && !pref ? "line-through" : "none",
                }}
              >
                {d.getDate()}
              </span>
              <span className="relative flex items-center justify-center" style={{ height: 5 }}>
                {/* A rostered day carries a dot even when unmarked: marking
                    "kan ikke" on a day you already work does NOT release it,
                    and this strip is where that mistake gets made. */}
                <span style={{ width: 5, height: 5, borderRadius: 99, background: dot !== "transparent" ? dot : (rostered ? "#0f172a" : "transparent") }} />
                {/* Non-colour markers, matching the month view: a weekly rule
                    and a timed window are states colour alone cannot carry. */}
                {recurring && !one && <Repeat className="absolute w-2.5 h-2.5 text-red-500" strokeWidth={2.5} aria-hidden />}
                {one?.timed && <Clock className="absolute w-2.5 h-2.5" strokeWidth={2.5} style={{ color: one.kind === "preferred" ? "#14532d" : "#7f1d1d" }} aria-hidden />}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 11, font: "600 11px/1 var(--font-text)", color: markedThisWeek ? "#16a34a" : "#94a3b8" }}>
        {markedThisWeek
          ? t("kanIkkeMarkedCount", "{n} marked this week").split("{n}").join(String(markedThisWeek))
          : t("kanIkkeNothingMarked", "Nothing marked this week")}
      </div>
    </div>
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
  const fmtWhen = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(localeFor(lang), { weekday: "short", day: "numeric", month: "short" });

  if (avail === null) {
    return <div className="text-xs text-gray-500 py-6">{t("portalLoading", "Loading…")}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Which kind of day a tap marks. Both are real: "kan ikke" constrains
          the roster, "helst" is a soft preference the manager sees while
          planning. The copy for each says exactly that much and no more —
          a preference does not reserve the shift. */}
      <div className="flex" style={{ padding: 3, borderRadius: 14, background: "#e9eef4", gap: 3 }}>
        {[
          { key: "unavailable", label: t("kanIkkeModeCant", "Can't work") },
          { key: "preferred", label: t("kanIkkeModePreferred", "Preferred") },
        ].map((m) => {
          const on = mode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              style={{
                flex: 1, height: 34, borderRadius: 11,
                font: "700 12px/1 var(--font-text)",
                background: on ? "#fff" : "transparent",
                color: on ? "#0f172a" : "#64748b",
                boxShadow: on ? "0 2px 6px -2px rgba(15,23,42,.22)" : "none",
                transition: "all .22s",
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Intro — mental model + honesty boundary before the first tap */}
      <p className="text-[13px] leading-relaxed text-gray-600">
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

      <button
        type="button"
        onClick={() => setCalOpen((v) => !v)}
        className="w-full flex items-center justify-center"
        style={{ gap: 6, height: 38, borderRadius: 13, background: "#f5f8fb", border: "1px solid #eef2f7", font: "600 11.5px/1 var(--font-text)", color: "#64748b" }}
      >
        {calOpen ? t("kanIkkeShowWeek", "Show this week only") : t("kanIkkeShowMonth", "Pick another date")}
        <ChevronDown size={13} strokeWidth={2.5} style={{ transform: calOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
      </button>

      {err && <div className="text-xs text-red-600">{err}</div>}

      {/* Legend — text always present, never colour-only */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded" style={{ background: "linear-gradient(180deg,#fee2e2,#fecaca)", border: "1px solid rgba(239,68,68,.32)" }} />{t("legendCantWork", "Can't work")}</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded" style={{ border: "1px solid rgba(239,68,68,.32)" }} />{t("legendRepeats", "Every week")}</span>
        {hasAbsence && <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-100 ring-1 ring-inset ring-amber-300" />{t("legendPending", "Pending")}</span>}
        {hasAbsence && <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-100 ring-1 ring-inset ring-emerald-300" />{t("legendApproved", "Approved off")}</span>}
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded" style={{ background: "linear-gradient(180deg,#dcfce7,#bbf7d0)", border: "1px solid rgba(22,163,74,.35)" }} />{t("legendPreferred", "Prefers")}</span>
        {/* Only claim the scheduled dot when the surface on screen actually
            draws one — the week strip does not. */}
        {shiftSet.size > 0 && <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gray-900" />{t("legendScheduled", "Scheduled")}</span>}
      </div>


      {/* Marked days — where time-window + note live (never on the grid cell) */}
      {markedList.length > 0 && (
        <div className="space-y-2">
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
        </div>
      )}

      {/* Recurring weekly — advanced, opt-in, low emphasis */}
      <div>
        <button type="button" onClick={() => setRecurOpen((o) => !o)}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 text-[13px] font-semibold transition">
          <span className="inline-flex items-center gap-2"><Repeat className="w-4 h-4" strokeWidth={2} aria-hidden />{t("kanIkkeRepeatToggle", "Repeat weekly")}</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${recurOpen ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {recurOpen && (
          <div className="mt-2 space-y-2">
            <p className="text-[12px] text-gray-500">{t("kanIkkeRepeatHint", "Pick a weekday you can never work.")}</p>
            <div className="flex gap-1.5">
              {WD.map((w, i) => {
                const on = recurringSet.has(i);
                return (
                  <button key={i} type="button" onClick={() => (on ? removeWeekly(i) : addWeekly(i))} aria-pressed={on}
                    className={`flex-1 py-2 rounded-lg text-[12px] font-semibold capitalize transition ${on ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                    {w}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Time-window discovery hint (no per-cell chrome) */}
      {markedList.length > 0 && (
        <p className="text-[11px] text-gray-400">{t("kanIkkeHoldHint", "Tap a marked day above to set hours.")}</p>
      )}

      {/* Divider — a different kind of thing below */}
      <div className="h-px bg-[#f1f5f9]" />

      {/* Fravær — a request the owner approves (distinct from the soft calendar taps) */}
      <AbsenceSection token={token} onChanged={loadAbsence} />

      {/* Rostered-day confirm: the mark is a planning signal, not a cancellation. */}
      {confirmRostered && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true">
          <button type="button" className="absolute inset-0 bg-[#080e16]/50 backdrop-blur-[2px]" onClick={() => setConfirmRostered(null)} aria-label={t("portalCancel", "Cancel")} />
          <div className="relative w-full max-w-lg mx-auto bg-white rounded-t-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-3">
            <div className="text-base font-bold text-gray-900">{t("kanIkkeRosteredTitle", "You already have a shift that day")}</div>
            <p className="text-[13px] text-gray-600">
              {t("kanIkkeRosteredBody", "Marking this only tells the manager how to plan future weeks. It does not cancel the shift and nobody is notified — message them if you can't work it.")}
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setConfirmRostered(null); onNavigate?.("messages"); }}
                className="flex-1 py-2.5 rounded-[14px] bg-gray-900 text-white font-text text-[13px] font-bold hover:bg-gray-800 transition"
              >
                {t("kanIkkeRosteredMessage", "Message manager")}
              </button>
              <button
                type="button"
                onClick={() => markAnyway(confirmRostered.iso)}
                className="flex-1 py-2.5 rounded-[14px] bg-[#f1f5f9] text-gray-700 font-text text-[13px] font-bold hover:bg-[#e2e8f0] transition"
              >
                {t("kanIkkeRosteredAnyway", "Mark anyway")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove-weekly-rule scoped confirm (blast-radius honesty) */}
      {confirmWeekday && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true">
          <button type="button" className="absolute inset-0 bg-[#080e16]/50 backdrop-blur-[2px]" onClick={() => setConfirmWeekday(null)} aria-label={t("portalCancel", "Cancel")} />
          <div className="relative w-full max-w-lg mx-auto bg-white rounded-t-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-3">
            <div className="text-base font-bold text-gray-900">{t("kanIkkeRemoveWeeklyTitle", "Remove this weekly rule?")}</div>
            <p className="text-[13px] text-gray-600">{t("kanIkkeRemoveWeeklyBody", "This clears every {day}.").split("{day}").join(WD[confirmWeekday.wd])}</p>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setConfirmWeekday(null)} className="flex-1 py-2.5 rounded-[14px] bg-[#f1f5f9] text-gray-700 font-text text-[13px] font-bold hover:bg-[#e2e8f0] transition">{t("portalCancel", "Cancel")}</button>
              <button type="button" onClick={() => removeWeekly(confirmWeekday.wd)} className="flex-1 py-2.5 rounded-[14px] bg-red-600 text-white font-text text-[13px] font-bold hover:bg-red-700 transition">{t("kanIkkeRemove", "Remove")}</button>
            </div>
          </div>
        </div>
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

   OFF SWITCHES, both failing toward today's appearance:
     1. VITE_PORTAL_BARS=off in the build env — compile-time, Vite dead-strips.
     2. localStorage bb_bars="v1" — per-device, no rebuild. A DEV/QA lever so
        one binary can be A/B'd on a phone with Web Inspector attached. It is
        NOT a field kill switch: staff cannot set it. */
const BAR_V2 = (() => {
  if (import.meta.env.VITE_PORTAL_BARS === "off") return false;
  try { return localStorage.getItem("bb_bars") !== "v1"; } catch { return true; }
})();

const TABS = [
  { key: "schedule", Icon: Calendar, labelKey: "navSchedule", labelFallback: "Schedule" },
  { key: "availability", Icon: CalendarOff, labelKey: "navKanIkke", labelFallback: "Kan ikke" },
  { key: "messages", Icon: MessageSquare, labelKey: "navMessages", labelFallback: "Messages" },
  { key: "swaps", Icon: ArrowLeftRight, labelKey: "navSwaps", labelFallback: "Swaps" },
  { key: "hours", Icon: Clock, labelKey: "navHours", labelFallback: "Hours" },
  { key: "alerts", Icon: Bell, labelKey: "navAlerts", labelFallback: "Alerts" },
];

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

          {/* iOS — the native BonBox Scheduler app is the best path now that
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
                {t("staffGetSchedulerApp", "Get the BonBox Scheduler app")}
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
  return (h === 1 ? t("staffRemindHrOne", "{n} hour") : t("staffRemindHr", "{n} h"))
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
              {m < 60
                ? t("staffRemindMin", "{n} min").split("{n}").join(String(m))
                : t("staffRemindHr", "{n} h").split("{n}").join(String(m / 60))}
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
  useEffect(() => {
    if (!supported || !tierAllowed) return;
    let cancel = false;
    navigator.serviceWorker?.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (cancel) return;
        setSubscribed(!!sub);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [supported, tierAllowed]);

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
          ? t("staffPushDeniedError", "Push permission was blocked. Re-enable in Settings to receive notifications.")
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
        {t("staffPushIosInstallHint", "On iPhone, tap the share icon in Safari and choose Add to Home Screen. Open BonBox from the home-screen icon to enable push.")}
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
                  {m < 60
                    ? t("staffRemindMin", "{n} min").split("{n}").join(String(m))
                    : t("staffRemindHr", "{n} h").split("{n}").join(String(m / 60))}
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
        {t("staffPushBlockedHint", "Notifications are blocked in your browser settings. Re-enable them in Settings → Notifications → BonBox to get a tap when your shifts change.")}
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



/** The prototype's meta separator: a 3px dot at 35% white. */
function HeroDot() {
  return <span aria-hidden style={{ width: 3, height: 3, borderRadius: 99, background: "rgba(255,255,255,.35)", flex: "none" }} />;
}

export default function StaffPortalPage() {
  const { token } = useParams();
  const { t, lang, setLang } = useLanguage();

  // The portal is a fixed full-viewport app-shell that owns its OWN safe-area
  // insets (the sticky header pads + caps the notch; the bottom nav pads for
  // the home-indicator). The global `body { padding-top: env(safe-area-inset-*) }`
  // in index.css would apply the SAME inset a second time → a fat empty gap
  // under the notch (only visible where env() > 0: the installed PWA + the
  // native Scheduler app; a normal browser has env()=0 so it never showed).
  // Drop the body padding while the portal is mounted so the header's inset is
  // the single source. Owner-app pages (body scroll) keep the body padding.
  useEffect(() => {
    document.body.classList.add("portal-shell");
    return () => document.body.classList.remove("portal-shell");
  }, []);
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
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pinVerified, setPinVerified] = useState(false);

  // Native shell only: swap dead web-push for a real APNs registration the
  // moment the portal is usable (validated + past any PIN gate).
  useNativePush(token, Boolean(info) && pinVerified);

  // Data for each tab
  const [shifts, setShifts] = useState([]);
  // Which department (branch) the portal is showing. Built from the staffer's
  // OWN shifts — `branch_name` already rides on every row — so the list can
  // only ever contain places they actually work. null = all of them.
  const [dept, setDept] = useState(null);
  const [deptOpen, setDeptOpen] = useState(false);
  const [photoMenu, setPhotoMenu] = useState(false);


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
  const [liveConnected, setLiveConnected] = useState(false);

  // Email & phone editing
  const [showEmailEdit, setShowEmailEdit] = useState(false);
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

  // 1. Validate token on mount
  useEffect(() => {
    portalApi.get(`/portal/${token}`)
      .then((res) => {
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
        setError(errText(err, "Link not found"));
        setLoading(false);
        // A dead link must not keep booting an installed app (PWA or the
        // Scheduler shell — both launch to "/") into this error screen:
        // forget it so "/" falls back to the join-code screen.
        try {
          if (localStorage.getItem("bonbox_portal_token") === token) {
            localStorage.removeItem("bonbox_portal_token");
          }
        } catch { /* private mode */ }
      });
  }, [token]);

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
        setLastSynced(new Date());
      } else {
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

  // 2b. Refetch triggers — keep the schedule fresh without any realtime deps.
  // All gated on pinVerified && info, all cleaned up on unmount.
  //   • visibilitychange → refetch when the tab/app becomes visible again
  //     (the "came back after hours away" case — the biggest freshness win).
  //   • online → refetch the moment connectivity returns; track isOnline so
  //     the pill can show the truth.
  //   • setInterval(~20s) → background poll, but ONLY while the tab is
  //     visible (respects the 30/min API rate-limit; 20s ≈ 3/min).
  useEffect(() => {
    if (!(pinVerified && info)) return;

    // Hours are fetched separately (they carry a caller-chosen window), so
    // every refresh trigger has to drive BOTH or they drift apart.
    const refreshAll = () => { loadData(); loadHours(); };

    const onVisible = () => {
      if (document.visibilityState === "visible") refreshAll();
    };
    const onOnline = () => {
      setIsOnline(true);
      refreshAll();
    };
    const onOffline = () => setIsOnline(false);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const pollId = setInterval(() => {
      if (document.visibilityState === "visible") refreshAll();
    }, liveConnected ? 60000 : 20000);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(pollId);
    };
  }, [pinVerified, info, loadData, loadHours, liveConnected]);

  // 2e. Realtime stream (Phase 2) — instant push the moment the owner
  // publishes. Opens a Server-Sent Events connection to the portal stream; on
  // a "schedule_published" nudge we refetch immediately (loadData diffs +
  // toasts as usual). The browser's EventSource auto-reconnects on drop, and
  // the 20s/60s poll above is the fallback — so the stream is pure speed, never
  // a correctness dependency. liveConnected drives the "Live" pill + poll backoff.
  useEffect(() => {
    if (!(pinVerified && info)) return;
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") return;

    const base = portalApi.defaults.baseURL || "";
    let es;
    try {
      es = new EventSource(`${base}/portal/${token}/stream`);
    } catch {
      return; // EventSource unavailable → poll-only, harmless no-op
    }

    const onPublished = () => { loadData(); loadHours(); };
    es.onopen = () => setLiveConnected(true);
    es.onerror = () => setLiveConnected(false); // browser keeps auto-reconnecting
    es.addEventListener("schedule_published", onPublished);

    return () => {
      setLiveConnected(false);
      try { es.removeEventListener("schedule_published", onPublished); } catch { /* noop */ }
      try { es.close(); } catch { /* noop */ }
    };
  }, [pinVerified, info, token, loadData, loadHours]);

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
  if (loading) {
    return (
      <div className="min-h-screen bg-[#f5f7fb] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-gray-300 border-t-transparent rounded-full" />
      </div>
    );
  }

  // Error state
  if (error) return <PortalError message={error} />;

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
      setEmailMsg(errText(err, t("portalSaveFailed", "Couldn't save")));
    } finally {
      setEmailSaving(false);
    }
  };

  return (
    // full-height + scrollable = one fixed app-shell with a single internal
    // momentum scroller (‑webkit-overflow-scrolling + overscroll containment).
    // Replaces min-h-screen BODY scroll, which rubber-bands on iOS WKWebView
    // and makes the sticky header + fixed bottom nav feel loose. The nav and
    // chat composer stay position:fixed (viewport-pinned) — .scrollable has no
    // transform, so it doesn't trap them.
    <div className="full-height scrollable bg-[#f5f7fb] text-gray-900 pb-24">
      {/* Header — sticks to the top of the internal scroller. Uses .glass-static
          (no translateZ) so the sticky header doesn't wobble during momentum
          scroll on iOS. */}
      <div className={`sticky top-0 z-10 glass-static border-b border-gray-200/70 pt-[env(safe-area-inset-top)]${BAR_V2 ? " bb-lg-header" : ""}`}>
        {/* Opaque cap over the status-bar / notch inset. The header glass is
            translucent (85%), so without this the content scrolling underneath
            bleeds up into the status bar — this keeps the notch clean and the
            scroll transition crisp. Theme-aware; sized to the safe-area inset. */}
        <div
          aria-hidden
          className={`absolute inset-x-0 top-0 ${BAR_V2 ? "bb-lg-cap" : "bg-white/95 dark:bg-gray-900"}`}
          style={{ height: "env(safe-area-inset-top)" }}
        />
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 style={{ font: "700 23px/1.08 var(--font-display)", letterSpacing: "-0.03em", color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {tab === "schedule" ? t("portalTitleSchedule", "My schedule")
                : tab === "availability" ? t("portalTitleKanIkke", "Availability")
                : tab === "messages" ? t("portalTitleMessages", "Messages")
                : tab === "swaps" ? t("portalTitleSwaps", "Swaps")
                : tab === "hours" ? t("portalTitleHours", "My hours")
                : t("portalTitleAlerts", "Alerts")}
            </h1>
            {/* Venue name ink is #64748b, not #94a3b8: 12px at weight 500 is
                body text, so WCAG AA wants 4.5:1 and #94a3b8 measured 2.56:1
                here. Same hue family, same size, same weight — only the ink
                darkens. (Comment lives OUTSIDE the && so the expression keeps
                exactly one child; two adjacent JSX children there need a
                fragment and fail the build.) */}
            {info?.restaurant_name && (
              <div style={{ marginTop: 5, font: "500 12px/1 var(--font-text)", letterSpacing: "0.005em", color: "#64748b" }}>
                {info.restaurant_name}
                {/* Live/offline moves here off the chip slot, which the
                    department switcher now owns. Only ever states what is
                    true: "Live" needs the stream actually open. */}
                {pinVerified && info && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => { loadData(); loadHours(); }}
                      style={{ color: liveConnected && isOnline ? "#16a34a" : "#94a3b8" }}
                    >
                      {!isOnline
                        ? t("portalOffline")
                        : liveConnected
                          ? t("portalLive")
                          : lastSynced && Date.now() - lastSynced.getTime() < 45000
                            ? t("portalSynced")
                            : t("portalTapToRefresh", "Tap to refresh")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Alerts bell — replaces the Alerts nav tab (moved to the header
                per the design). Language moved into the profile sheet below. */}
            <button
              type="button"
              onClick={() => setTab("alerts")}
              aria-label={t("navAlerts", "Alerts")}
              aria-current={tab === "alerts" ? "page" : undefined}
              className={`relative w-9 h-9 rounded-full border flex items-center justify-center transition active:scale-[0.98] before:absolute before:-inset-2 before:content-[''] ${
                tab === "alerts"
                  ? "bg-gray-900 border-gray-900 text-white"
                  : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              <Bell className="w-[18px] h-[18px]" strokeWidth={2} aria-hidden />
              {alertsUnread > 0 && tab !== "alerts" && (
                <span
                  className="absolute z-10 -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-600 text-white text-[9px] font-bold leading-[16px] text-center ring-2 ring-white"
                  aria-label={t("portalAlertsUnreadBadge", "Unread updates")}
                >
                  {alertsUnread > 9 ? "9+" : alertsUnread}
                </span>
              )}
            </button>
            {/* Department switcher. Only rendered when the staffer actually
                has shifts at a named branch — a single-location business gets
                nothing rather than a chip that cannot switch anywhere. The
                chevron appears only when there is a second place to go, so it
                never advertises a menu that would open onto one item. */}
            {departments.length > 0 && (
              <button
                type="button"
                onClick={() => departments.length > 1 && setDeptOpen(true)}
                aria-label={t("portalDepartment", "Department")}
                style={{
                  display: "flex", alignItems: "center", gap: 6, height: 32,
                  padding: departments.length > 1 ? "0 10px 0 9px" : "0 11px 0 9px",
                  borderRadius: 999,
                  background: "linear-gradient(180deg,#ffffff,#f8fafc)",
                  border: "1px solid #e2e8f0",
                  boxShadow: "0 1px 2px rgba(15,23,42,.05), inset 0 1px 0 #fff",
                  cursor: departments.length > 1 ? "pointer" : "default",
                }}
              >
                <span style={{ font: "600 11.5px/1 var(--font-text)", color: "#334155", letterSpacing: "-0.005em", maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dept || (departments.length > 1 ? t("portalAllDepartments", "All") : departments[0].name)}
                </span>
                {departments.length > 1 && <ChevronDown size={11} strokeWidth={2.4} style={{ color: "#94a3b8", flex: "none" }} />}
              </button>
            )}
            <button
              onClick={() => { setShowEmailEdit(!showEmailEdit); setEmailInput(info?.email || ""); setPhoneInput(info?.phone || ""); setAddressInput(info?.address || ""); setPostalInput(info?.postal_code || ""); setCityInput(info?.city || ""); setEmailMsg(""); setEmailStatus(null); }}
              className="relative rounded-full overflow-hidden flex items-center justify-center active:scale-[0.98] transition before:absolute before:-inset-2 before:content-['']"
              style={{
                width: 33, height: 33, flex: "none",
                background: "linear-gradient(150deg,#1e293b,#0f172a)", color: "#fff",
                font: "700 12.5px/1 var(--font-text)", letterSpacing: "0.01em",
                boxShadow: "0 4px 12px -6px rgba(15,23,42,.8), inset 0 1px 0 rgba(255,255,255,.18)",
              }}
              title={t("portalEditContact", "Edit profile")}
            >
              {photoUrl ? (
                <img src={photoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                info?.staff_name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
              )}
            </button>
          </div>
        </div>
        {photoMenu && createPortal(
          <div className="fixed inset-0 z-[60] flex items-end" style={{ background: "rgba(8,14,22,.45)" }} onClick={() => setPhotoMenu(false)}>
            <div
              role="dialog"
            aria-modal="true"
            aria-label={t("portalPhotoLabel")}
            className="w-full bg-white"
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

        {deptOpen && createPortal(
          <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(8,14,22,.45)" }} onClick={() => setDeptOpen(false)}>
            <div
              role="dialog"
            aria-modal="true"
            aria-label={t("portalDepartment")}
            className="w-full bg-white"
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
                        {t("portalDeptShiftCount", "{n} shifts").split("{n}").join(String(d.n))}
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
        {showEmailEdit && createPortal((
          <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label={t("close", "Close")}
              onClick={() => setShowEmailEdit(false)}
              className="absolute inset-0 bg-[#080e16]/50 backdrop-blur-[2px]"
            />
            <div className="relative w-full max-w-lg mx-auto bg-white rounded-t-2xl shadow-soft-lg max-h-[90dvh] overflow-y-auto overscroll-contain">
              <div className="sticky top-0 bg-white/95 flex items-center justify-between px-4 pt-4 pb-2 border-b border-[#f1f5f9]">
                <h2 className="text-base font-bold text-gray-900">{t("portalEditContact", "Edit profile")}</h2>
                <button
                  type="button"
                  onClick={() => setShowEmailEdit(false)}
                  aria-label={t("close", "Close")}
                  className="w-8 h-8 -mr-1 rounded-full inline-flex items-center justify-center text-gray-500 hover:bg-gray-100 active:scale-[0.98] transition"
                >
                  <X className="w-5 h-5" strokeWidth={2} aria-hidden />
                </button>
              </div>
              <div className="px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-3">
              {/* Profile photo — staff pick a photo; the owner sees it too. */}
              <div
                className="relative flex items-center overflow-hidden"
                style={{
                  gap: 14, padding: 19, borderRadius: 22,
                  background: "linear-gradient(152deg,#1d2a3b 0%,#0f172a 48%,#080e16 100%)",
                  boxShadow: "0 24px 46px -26px rgba(4,10,18,.95), inset 0 1px 0 rgba(255,255,255,.13)",
                }}
              >
                {/* Bloom as a radial-gradient background, never a blurred child:
                    a blur gets its own compositing layer that WebKit fails to
                    clip against border-radius, painting a hard corner. */}
                <span
                  className="absolute"
                  style={{
                    right: -70, top: -80, width: 230, height: 230, borderRadius: "50%",
                    background: "radial-gradient(closest-side,rgba(34,197,94,.34),rgba(34,197,94,0))",
                  }}
                  aria-hidden
                />
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
                      background: "linear-gradient(150deg,#334155,#0f172a)",
                      border: "1px solid rgba(255,255,255,.14)",
                      font: "700 21px/1 var(--font-display)", letterSpacing: "-0.02em", color: "#e2e8f0",
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
                      background: "linear-gradient(180deg,#22c55e,#16a34a)",
                      border: "2px solid #0f172a", color: "#fff",
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
                    {[info?.role, info?.restaurant_name].filter(Boolean).join(" · ")}
                  </div>
                  {info?.since && (
                    <div style={{ marginTop: 10 }}>
                      <span
                        style={{
                          display: "inline-block", padding: "5px 9px", borderRadius: 999,
                          background: "rgba(34,197,94,.16)", border: "1px solid rgba(34,197,94,.28)",
                          font: "600 10px/1 var(--font-text)", color: "#86efac",
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
                  placeholder="your@email.com"
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
                        className={`px-3 py-1.5 rounded-md text-[12px] font-bold uppercase transition active:scale-[0.98] ${
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
                  + PIN proof) and land on the join screen. Recoverable —
                  re-enter the join code or tap the link again. Matters for
                  the Scheduler app: a phone that changes workplace needs a
                  way out, and App Review likes an explicit disconnect. */}
              <div className="pt-1 border-t border-[#f1f5f9]">
                <button
                  type="button"
                  onClick={async () => {
                    // Order matters: the unregister call needs the portal
                    // token + PIN proof that are about to be forgotten.
                    await unregisterNativePush(token);
                    try {
                      localStorage.removeItem("bonbox_portal_token");
                      localStorage.removeItem("bonbox_pin_proof");
                    } catch { /* private mode */ }
                    window.location.href = "/join";
                  }}
                  className="text-[11px] font-medium text-gray-500 hover:text-gray-700 underline underline-offset-2"
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
          style={{ top: 8 }}
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

      {/* Content */}
      <div className="max-w-lg mx-auto px-4 py-4">
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
            // The venue's vertical, so role→section resolves the same way the
            // owner's schedule maker does. New field on PortalInfo.
            businessType={info?.business_type}
            onShiftsChanged={loadData}
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
          <SwapTab token={token} ownShifts={shifts} onChanged={loadData} />
        )}
        {tab === "hours" && <HoursTab data={hoursData} maxHours={info?.max_hours_month} range={hoursRange} setRange={setHoursRange} prevTotal={prevTotal} hoursError={hoursError} hoursLoading={hoursLoading} />}
        {tab === "alerts" && <AlertsTab token={token} onNavigate={setTab} />}
      </div>

      {/* Bottom Navigation */}
      <nav className={`fixed bottom-0 left-0 right-0 glass border-t border-gray-200/70 z-20${BAR_V2 ? " bb-lg-tabbar" : ""}`}>
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
                </span>
                <span className="relative max-w-[64px] truncate text-[10px] font-semibold">
                  {t(item.labelKey, item.labelFallback)}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* "Schedule updated" toast — fires only on a REAL change to the
          published schedule after data already existed (never on first load).
          Sits above the bottom nav, notch/safe-area aware, auto-dismisses ~5s.
          Generic by design (Phase 1) — no per-field human diff. */}
      {scheduleUpdated && (
        <div
          className="fixed inset-x-0 z-30 flex justify-center px-4 pointer-events-none"
          style={{ bottom: "calc(5rem + env(safe-area-inset-bottom))" }}
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
