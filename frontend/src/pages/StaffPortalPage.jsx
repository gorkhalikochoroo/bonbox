/**
 * Staff Portal — what your staff sees when they open their magic link.
 * Mobile-first, dark theme, no login required.
 * Route: /s/:token
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";

import { useConfirm } from "../hooks/useConfirm";
import GeofenceDial from "../components/GeofenceDial";
import { nextShiftCountdown } from "../utils/nextShiftCountdown";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import { RefreshCw, CloudOff, Download, FileText, Smartphone, Share, Check, X, Calendar, ArrowLeftRight, Clock, Bell, Lock, AlertTriangle, Mail, BellOff, MessageCircle, MessageSquare, Send, Inbox, Thermometer, StickyNote, MapPin, MapPinOff, CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, Repeat, CalendarOff, Plus, Users, Apple } from "lucide-react";
import portalApi, { storePinProof } from "../services/portalApi";
import { useLanguage } from "../hooks/useLanguage";
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
function roleBarColor(role) {
  const r = (role || "").toLowerCase();
  if (r.includes("køkken") || r.includes("kitchen") || r.includes("chef") || r.includes("kok")) {
    return "bg-red-500";
  }
  if (r.includes("bar") || r.includes("barista")) {
    return "bg-blue-500";
  }
  if (r.includes("floor") || r.includes("gulv") || r.includes("tjener") || r.includes("waiter") || r.includes("server")) {
    // Violet, NOT emerald — green is reserved exclusively for "live/now"
    // (Live pill + clocked-in ping). Tjener is the majority persona; painting
    // it green flooded every page with false "live" signals.
    return "bg-violet-500";
  }
  return "bg-gray-600";
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
    <div className="pt-3 border-t border-gray-100">
      <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-2">
        {t("portalHolidaySection", "Feriedage")}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[22px] font-bold text-gray-900 tabular-nums leading-none">
          {fmt(h.remaining)}
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

  // Nothing shared and nothing to say — stay silent rather than render an empty
  // promise. The owner shares documents; the staffer cannot request one here.
  if (!docs || docs.length === 0) return null;

  return (
    <div className="pt-3 border-t border-gray-100">
      <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-2">
        {t("portalDocsSection", "Contract & documents")}
      </div>
      <div className="space-y-1.5">
        {docs.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => open(d)}
            disabled={busyId === d.id}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-gray-200 text-left hover:bg-gray-50 transition disabled:opacity-50"
          >
            <FileText className="w-4 h-4 shrink-0 text-gray-400" />
            <span className="flex-1 min-w-0 text-[13px] font-semibold text-gray-900 truncate">{d.label}</span>
            <Download className="w-4 h-4 shrink-0 text-gray-400" />
          </button>
        ))}
      </div>
      {err && <p className="mt-2 text-[12px] text-red-600">{err}</p>}
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
    <div className="pt-3 border-t border-gray-100">
      <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-2">
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
                className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 tabular-nums placeholder:text-gray-400 outline-none focus:border-gray-900/30"
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
                className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 tabular-nums placeholder:text-gray-400 outline-none focus:border-gray-900/30"
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
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-xs text-center">
        <div
          className="w-16 h-16 rounded-2xl border shadow-soft flex items-center justify-center mx-auto mb-4"
          style={{ background: "rgb(var(--brand-50))", borderColor: "rgb(var(--brand-100))" }}
        >
          <Lock className="w-7 h-7" strokeWidth={2} aria-hidden style={{ color: "rgb(var(--brand-600))" }} />
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-1">{t("portalPinTitle", "Enter PIN")}</h1>
        <p className="text-sm text-gray-500 mb-8">{t("portalPinSubtitle", "Hi {name}, enter your 4-digit PIN", { name: staffName })}</p>
        <div className="flex gap-3 justify-center mb-6">
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
              className="w-14 h-14 text-center text-2xl font-bold bg-white border border-gray-300 rounded-xl text-gray-900 focus:border-gray-900/30 focus:ring-2 focus:ring-gray-400/30 outline-none"
              autoFocus={i === 0}
            />
          ))}
        </div>
        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
        {loading && <p className="text-gray-500 text-sm">{t("portalPinVerifying", "Verifying...")}</p>}
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
function SickCallButton({ token, upcomingShifts, onCalledIn }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const todayIso = useState(() => toLocalISO(new Date()))[0];
  const [date, setDate] = useState(todayIso);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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
      // Reset + close + tell parent so it can refetch.
      setReason("");
      setOpen(false);
      onCalledIn?.();
    } catch (err) {
      setError(errText(err, t("portalSickSendFailed", "Couldn't send. Try again.")));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full px-4 py-3 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-medium text-gray-700 transition flex items-center justify-center gap-2"
      >
        <Thermometer className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />
        {t("portalCallInSick", "Call in sick")}
      </button>
    );
  }

  // 14-day forward window matches the backend MAX_FUTURE_DAYS soft cap;
  // backend allows up to 60 but most call-ins are same-day or near.
  const maxIso = toLocalISO(addDaysToDate(new Date(), 14));

  return (
    <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-gray-900 text-sm flex items-center gap-1.5"><Thermometer className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />{t("portalCallInSick", "Call in sick")}</div>
        <button
          onClick={() => { setOpen(false); setError(""); setReason(""); }}
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
          min={todayIso}
          max={maxIso}
          onChange={(e) => setDate(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-amber-500/40"
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
          className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-amber-500/40 resize-none"
        />
      </div>
      {error && (
        <div className="text-xs text-red-400">{error}</div>
      )}
      <button
        onClick={submit}
        disabled={submitting || !date}
        className="w-full px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold transition disabled:opacity-50"
      >
        {submitting ? t("portalSending", "Sending...") : t("portalSickSubmit", "Send sick call")}
      </button>
      <div className="text-[10px] text-gray-400 text-center leading-snug">
        {t("portalSickFootnote", "Your owner will be notified. They can assign someone to cover.")}
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
function ConfirmScheduleButton({ token, shifts, onConfirmed, onNeedChange }) {
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

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const res = await portalApi.post(`/portal/${token}/confirm-schedule`, {});
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
  const seen = new Set();
  const mates = [];
  for (const s of teamShifts) {
    if (s.date !== nextShift.date) continue;
    if (myBranch && s.branch_name && s.branch_name !== myBranch) continue;
    const isMine =
      s.start_time === nextShift.start_time &&
      s.end_time === nextShift.end_time &&
      (s.role || "") === (nextShift.role_on_shift || "");
    if (isMine) continue;
    const id = s.staff_id ?? `${s.staff_name}|${s.start_time}|${s.end_time}`;
    if (seen.has(id)) continue;
    seen.add(id);
    mates.push(s);
  }

  const CAP = 6;
  const shown = mates.slice(0, CAP);
  const overflow = mates.length - shown.length;

  // Lives INSIDE the dark next-shift hero (its avatars ring gray-900 — built
  // for that surface, which is why they looked orphaned on the gray page).
  // Renders NOTHING on a solo shift, so stillness costs zero chrome. No
  // per-avatar role bar — role colour lives only on the hero's left-bar.
  if (mates.length === 0) return null;
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
function OpenShiftsClaimCard({ token, rows, onClaimed }) {
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
      <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
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
                <span className={`block h-[3px] w-5 rounded-full ${roleBarColor(o.role)}`} aria-hidden />
                {fmtDate(o.date, lang)}
              </div>
              <div className="text-[13px] text-gray-500 tabular-nums mt-0.5">
                {o.start_time}–{o.end_time}
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


function ScheduleTab({ shifts: rawShifts, teamShifts, openShifts, staffName, token, restaurantName, restaurantCity, restaurantAddress, coversByShift, onShiftsChanged, onNeedChange, onOpenAvailability }) {
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
  const [savingDay, setSavingDay] = useState(null); // iso currently posting/deleting
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
  const markUnavail = async (iso) => {
    if (savingDay || unavailByDate[iso]) return;
    setSavingDay(iso);
    setUnavail((rows) => [...(rows || []), { id: "tmp-" + iso, kind: "unavailable", date: iso, weekday: null, start_time: null, end_time: null, note: null }]);
    try { await portalApi.post(`/portal/${token}/availability`, { date: iso, kind: "unavailable" }); }
    catch { /* revert-on-fail via refetch below */ }
    finally { await loadUnavail(); setSavingDay(null); }
  };
  const removeUnavail = async (iso) => {
    const id = unavailByDate[iso];
    if (!id || savingDay) return;
    setSavingDay(iso);
    setUnavail((rows) => (rows || []).filter((r) => r.id !== id));
    try { if (!String(id).startsWith("tmp-")) await portalApi.delete(`/portal/${token}/availability/${id}`); }
    catch { /* revert-on-fail via refetch below */ }
    finally { await loadUnavail(); setSavingDay(null); }
  };
  // "Brug for en ændring?" reveals the sick-call form inline (and deep-links
  // Swaps via onNeedChange from the confirm strip).
  const [showSick, setShowSick] = useState(false);

  const nextWeekStart = addDays(weekStart, 7);
  const laterStart = addDays(weekStart, 14);

  // Build all 7 days for current + next week (OFF days included as silent dots).
  const thisWeek = [];
  const nextWeek = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    thisWeek.push({ date: d, shift: shifts.find((s) => s.date === d) });
  }
  for (let i = 0; i < 7; i++) {
    const d = addDays(nextWeekStart, i);
    nextWeek.push({ date: d, shift: shifts.find((s) => s.date === d) });
  }

  const hasLater = shifts.some((s) => s.date >= laterStart);

  // Hours / counts for the muted summary line under the strip.
  const thisWeekShifts = shifts.filter((s) => s.date >= weekStart && s.date < nextWeekStart);
  const thisWeekHours = Math.round(thisWeekShifts.reduce((a, s) => a + s.net_hours, 0) * 100) / 100;

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
  const subscribeCalendar = () => {
    if (!token) return;
    const base = (portalApi.defaults.baseURL || "https://api.bonbox.dk/api").replace(/\/+$/, "");
    const url = `${base}/portal/${token}/schedule.ics`;
    window.open(url.replace(/^https?:/, "webcal:"), "_blank", "noopener");
  };

  const weekDays = weekView === "this" ? thisWeek : nextWeek;
  const weekLabelStart = weekView === "this" ? weekStart : nextWeekStart;
  const expandedShift = expandedDate
    ? shifts.find((s) => s.date === expandedDate)
    : null;

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
            className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${roleBarColor(nextShift.role_on_shift)}`}
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
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {nextShift.break_minutes > 0 ? (
                // With a break, the split is meaningful: gross span · unpaid break · net.
                <>
                  <span className="rounded-md bg-white/[0.07] px-2 py-1 text-[12px] font-semibold text-gray-300 tabular-nums">
                    {t("portalHoursGross", "{h} shift", { h: fmtHM(grossHrs(nextShift)) })}
                  </span>
                  <span className="rounded-md bg-white/[0.07] px-2 py-1 text-[12px] font-semibold text-gray-300 tabular-nums">
                    {t("portalHoursBreak", "{m} min break", { m: nextShift.break_minutes })}
                  </span>
                  <span className="rounded-md bg-emerald-400/15 px-2 py-1 text-[12px] font-bold text-emerald-300 tabular-nums">
                    {t("portalHoursNet", "{h} net", { h: fmtHM(nextShift.net_hours) })}
                  </span>
                </>
              ) : (
                // No break → gross == net, so ONE chip (avoids a redundant "8t shift · 8t net").
                <span className="rounded-md bg-emerald-400/15 px-2 py-1 text-[12px] font-bold text-emerald-300 tabular-nums">
                  {t("portalHoursGross", "{h} shift", { h: fmtHM(nextShift.net_hours) })}
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[12px] text-gray-400">{nextShiftRole}</div>

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
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-xl bg-white/10 ring-1 ring-white/15 text-gray-200 text-sm font-medium hover:bg-white/20 active:scale-[0.98] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
                  >
                    <CalendarPlus className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />
                    <span>{t("portalSyncCalendar", "Sync shifts")}</span>
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
            {/* Honesty crumb: an empty hero says what happens next, not just
                "nothing" — the portal will light up when the plan is published. */}
            <div className="mt-2 text-[13px] text-gray-400">
              {t("portalNoShiftHint", "You'll get notified here when {venue} publishes the schedule.", { venue: restaurantName || "" })}
            </div>
          </>
        )}
      </div>

      {/* Åbne vagter — open shifts this staffer can pick up one-tap. */}
      {token && <OpenShiftsClaimCard token={token} rows={openShifts || []} onClaimed={onShiftsChanged} />}

      {/* Bidirectional confirmation — calm "Jeg har set det" strip. Truth logic
          (allConfirmed gated on every confirmed_at) untouched; only the CTA
          copy + style change. The "Brug for en ændring?" link reveals the
          sick-call form inline AND deep-links the Swaps tab. */}
      {token && (
        <ConfirmScheduleButton
          token={token}
          shifts={shifts}
          onConfirmed={onShiftsChanged}
          onNeedChange={() => {
            setShowSick(true);
            onNeedChange?.();
          }}
        />
      )}

      {/* Sick-call self-service — revealed by "Brug for en ændring?". */}
      {token && showSick && (
        <SickCallButton
          token={token}
          upcomingShifts={upcoming}
          onCalledIn={onShiftsChanged}
        />
      )}

      {/* 7-dot week-at-a-glance — replaces the three long ShiftRow scrolls. One
          strip at a time (this/next week). Working day = thin role-colored bar;
          OFF = silent hollow dot; TODAY = bold gray-900 label + soft cell fill.
          Tap a working day → expand ONE inline ShiftRow below. */}
      <div className="rounded-xl bg-white border border-gray-200 p-4">
        <div className="flex items-start justify-between mb-2">
          {/* Eyebrow stays a pure uppercase-tracked label; the date range drops
              to its own quiet line instead of muddying the tracked eyebrow. */}
          <div>
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              {weekView === "this" ? t("portalSecThisWeek", "This week") : t("portalSecNextWeek", "Next week")}
            </div>
            <div className="text-[11px] text-gray-400 tabular-nums mt-0.5">
              {fmtShort(weekLabelStart, lang)} – {fmtShort(addDays(weekLabelStart, 6), lang)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setWeekView((v) => (v === "this" ? "next" : "this"));
              setExpandedDate(null);
            }}
            className="text-[11px] font-medium text-gray-500 hover:text-gray-700 active:opacity-60 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 rounded px-2 -mx-1 py-2.5 -my-2"
          >
            {weekView === "this" ? t("portalSecNextWeek", "Next week") : t("portalSecThisWeek", "This week")} →
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5">
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
                className={`flex flex-col items-center gap-1.5 rounded-lg py-2 min-h-[44px] transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 ${isExpanded ? "bg-gray-100" : isTodayCell ? "bg-gray-50" : "hover:bg-gray-50"}`}
                aria-label={`${WD[i]} ${fmtShort(d, lang)}${dayUnavail && !shift ? " · " + t("portalUnavailBadge", "Can't work") : ""}`}
                aria-current={isTodayCell ? "date" : undefined}
                aria-expanded={cellTappable ? isExpanded : undefined}
              >
                {/* TODAY = bold gray-900 label + soft cell fill (above). No ink
                    ring — a ring hugging a 4px bar rendered as a broken pill.
                    EXPANDED = a step darker (bg-gray-100) so "open" reads
                    distinctly from "today". */}
                <span className={`text-[10px] ${isTodayCell ? "text-gray-900 font-semibold" : "text-gray-400"}`}>{WD[i]}</span>
                <span className={`text-[10px] tabular-nums ${isTodayCell ? "text-gray-900 font-semibold" : "text-gray-400"} ${dayUnavail && !shift ? "line-through decoration-amber-400" : ""}`}>{parseInt(d.slice(8), 10)}</span>
                {shift ? (
                  <span
                    className={`block w-1.5 h-5 rounded-full ${roleBarColor(shift.role_on_shift)}`}
                    aria-hidden
                  />
                ) : dayUnavail ? (
                  <CalendarOff className="w-3.5 h-3.5 text-amber-500" strokeWidth={2.5} aria-hidden />
                ) : (
                  <span
                    className={`block w-2 h-2 rounded-full ${isTodayCell ? "bg-gray-900" : "border border-gray-300"}`}
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Opt-in detail: ONE inline ShiftRow for the tapped working day. */}
        {expandedShift && (
          <div className="mt-2 motion-safe:animate-scaleIn">
            <ShiftRow date={expandedShift.date} shift={expandedShift} />
          </div>
        )}

        {/* Tapped a FREE future day → mark / un-mark "kan ikke arbejde" right
            here. Writes the same StaffAvailability rows the Availability tab
            uses, so a strip mark shows on the calendar and vice-versa. */}
        {!expandedShift && expandedDate && !isPast(expandedDate) && (() => {
          const iso = expandedDate;
          const marked = !!unavailByDate[iso];
          const recurring = !marked && recurUnavailWeekdays.has(weekdayOfIso(iso));
          const saving = savingDay === iso;
          const dLabel = new Date(iso + "T00:00:00").toLocaleDateString(localeFor(lang), { weekday: "long", day: "numeric", month: "short" });
          return (
            <div className="mt-2 motion-safe:animate-scaleIn rounded-xl border border-gray-200 bg-white p-3">
              {recurring ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Repeat className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={2} aria-hidden />
                    <span className="text-[13px] text-gray-600 truncate">{t("portalUnavailRecurring", "You're off this weekday")}</span>
                  </div>
                  {onOpenAvailability && (
                    <button type="button" onClick={onOpenAvailability}
                      className="text-[13px] font-semibold text-gray-900 underline decoration-gray-300 underline-offset-2 shrink-0">
                      {t("portalUnavailOpen", "Manage")}
                    </button>
                  )}
                </div>
              ) : marked ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <CalendarOff className="w-4 h-4 text-amber-500 shrink-0" strokeWidth={2} aria-hidden />
                    <span className="text-[13px] text-gray-700 truncate">{t("portalUnavailMarked", "Can't work {day}", { day: dLabel })}</span>
                  </div>
                  <button type="button" disabled={saving} onClick={() => removeUnavail(iso)}
                    className="text-[13px] font-semibold text-gray-500 hover:text-gray-900 disabled:opacity-50 shrink-0">
                    {t("portalUnavailRemove", "Undo")}
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-gray-500 min-w-0 truncate">{t("portalUnavailPrompt", "Can't work {day}?", { day: dLabel })}</span>
                  <button type="button" disabled={saving} onClick={() => markUnavail(iso)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-[13px] font-semibold text-white active:scale-[0.98] disabled:opacity-50 shrink-0">
                    <CalendarOff className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />
                    {t("portalUnavailMark", "Can't work")}
                  </button>
                </div>
              )}
              {onOpenAvailability && !recurring && (
                <button type="button" onClick={onOpenAvailability}
                  className="mt-2 block text-[11px] text-gray-400 hover:text-gray-600 underline decoration-gray-200 underline-offset-2">
                  {t("portalUnavailMore", "Set a time or repeat weekly")}
                </button>
              )}
            </div>
          );
        })()}

        {/* Selected-day detail + week total — the design's week footer. Left =
            the tapped day (or today's shift by default) with a role-colored bar;
            right = the week total. Connects the strip to a concrete shift. */}
        {weekView === "this" && (() => {
          const fs = expandedShift || nextShift;
          return (
            <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between gap-3">
              {fs ? (
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className={`w-1.5 h-8 rounded-full shrink-0 ${roleBarColor(fs.role_on_shift)}`} aria-hidden />
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-gray-900 tabular-nums truncate">
                      {new Date(fs.date + "T00:00:00").toLocaleDateString(localeFor(lang), { weekday: "short", day: "numeric" })} · {fs.start_time}–{fs.end_time}
                    </div>
                    <div className="text-[11px] text-gray-500 truncate">
                      {fs.role_on_shift ? `${fs.role_on_shift} · ` : ""}{fs.net_hours}{t("portalHrsShort")}
                    </div>
                  </div>
                </div>
              ) : <span aria-hidden />}
              <div className="text-right shrink-0">
                <div className="text-[15px] font-bold text-gray-900 tabular-nums leading-tight">{thisWeekHours} {t("portalHrsShort")}</div>
                <div className="text-[11px] text-gray-400">{thisWeekShifts.length} {t("portalShiftsCount")}</div>
              </div>
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

function ShiftRow({ date: d, shift }) {
  const { t, lang } = useLanguage();
  const dt = new Date(d + "T00:00:00");
  const dayName = dt.toLocaleDateString(localeFor(lang), { weekday: "short" });
  const dayNum = dt.getDate();
  const today = isToday(d);
  const past = isPast(d);

  if (!shift) {
    return (
      <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white border border-gray-200 ${past ? "opacity-40" : "opacity-50"}`}>
        <div className="w-10 text-center">
          <div className="text-[10px] font-semibold text-gray-400">{dayName}</div>
          <div className="text-sm font-bold text-gray-400">{dayNum}</div>
        </div>
        <div className="flex-1">
          <div className="text-sm text-gray-400">{t("portalShiftOff", "OFF")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white border border-gray-200 ${past && !today ? "opacity-50" : ""} ${today ? "border-gray-500/40 bg-white" : ""}`}>
      <div className="w-10 text-center">
        <div className="text-[10px] font-semibold text-gray-500">{dayName}</div>
        <div className={`text-sm font-bold ${today ? "text-gray-900" : "text-gray-900"}`}>{dayNum}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900">{shift.start_time} – {shift.end_time}</div>
        <div className="text-[11px] text-gray-500">{shift.role_on_shift || t("portalRoleStaff", "Staff")}</div>
        {/* Multi-location: WHERE this shift is. Kills the "which restaurant
            am I at today?" confusion — tap opens maps. Only renders when the
            shift actually carries a location (single-venue staff never see it). */}
        {shift.branch_name && (
          <a
            href={`https://maps.apple.com/?q=${encodeURIComponent([shift.branch_name, shift.branch_address].filter(Boolean).join(", "))}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 flex items-start gap-1 text-[12px] text-gray-600 font-medium hover:text-gray-900"
          >
            <MapPin className="w-3 h-3 mt-[2px] shrink-0 text-gray-400" strokeWidth={2} aria-hidden />
            <span className="min-w-0 break-words underline-offset-2 hover:underline">{shift.branch_name}</span>
          </a>
        )}
        {/* Owner's per-shift note — a quiet line so the time/role stay the
            focus. Only renders when the owner actually left a note. */}
        {shift.notes && (
          <div
            className="mt-1 flex items-start gap-1 text-[12px] text-gray-500"
            aria-label={t("portalShiftNote", "Note from your manager")}
          >
            <StickyNote className="w-3 h-3 mt-[2px] shrink-0 text-gray-400" strokeWidth={2} aria-hidden />
            <span className="min-w-0 break-words">{shift.notes}</span>
          </div>
        )}
      </div>
      <div className="shrink-0 self-start">
        {today ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-gray-100 border border-gray-200 text-gray-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{t("portalPillToday", "Today")}
          </span>
        ) : past ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-gray-100 border border-gray-200 text-gray-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{t("portalPillDone", "Done")}
          </span>
        ) : (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-gray-100 text-gray-500">{shift.net_hours}h</span>
        )}
      </div>
    </div>
  );
}


// ─── Hours Tab ────────────────────────────────────────────────────────────

function HoursTab({ data, maxHours }) {
  const { t, lang } = useLanguage();
  if (!data) return <LoadingSkeleton />;

  const pct = maxHours && maxHours > 0 ? Math.min(100, (data.total_hours / maxHours) * 100) : null;
  const remaining = maxHours ? Math.max(0, maxHours - data.total_hours) : null;

  // Headline can be rostered (from the published schedule) or logged
  // (actuals the owner recorded). Label honestly so staff know which
  // number they're looking at. Default to "schedule" for older payloads.
  const isSchedule = (data.hours_source || "schedule") === "schedule";
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
      {/* Period info */}
      <div className="text-[11px] text-gray-500 flex items-center gap-2">
        <span>{t("portalHoursPeriod", "Period")}: {fmtShort(data.period_start, lang)} – {fmtShort(data.period_end, lang)}</span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-white border border-gray-200 p-3">
          <div className="text-[11px] text-gray-500 mb-1">{hoursLabel}</div>
          <div className="text-2xl font-bold text-gray-900">
            {data.total_hours} {maxHours ? <span className="text-sm text-gray-500">/ {maxHours}</span> : null}
          </div>
          {pct !== null && (
            <>
              <div className="h-1.5 bg-gray-100 rounded-full mt-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {remaining !== null && remaining <= 15 && (
                <div className={`text-[10px] mt-1 flex items-center gap-1 ${remaining <= 5 ? "text-red-600" : "text-amber-600"}`}>
                  <AlertTriangle className="w-3 h-3" strokeWidth={2} aria-hidden />
                  {t("portalHrsRemaining", "{n} hrs remaining", { n: remaining })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-3">
          <div className="text-[11px] text-gray-500 mb-1">{t("portalHoursShiftsCount", "Shifts")}</div>
          <div className="text-2xl font-bold text-gray-900">{data.entries.length}</div>
          <div className="text-[11px] text-gray-500">{t("portalHoursThisPeriod", "this period")}</div>
        </div>
      </div>

      {/* Hours warning for work permits */}
      {maxHours && remaining !== null && remaining <= 10 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[12px] text-amber-800">
          <strong className="flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />{t("portalWorkPermitLimit", "Work permit limit")}</strong>
          <p className="mt-0.5 text-amber-700">{t("portalHoursRemainingLong", "You have {n} hours remaining this period.", { n: remaining })}</p>
        </div>
      )}

      {/* Recent / upcoming shifts */}
      <div>
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">{recentLabel}</div>
        <div className="space-y-1.5">
          {data.entries.length === 0 && (
            <div className="text-sm text-gray-400 py-4 text-center">{emptyLabel}</div>
          )}
          {data.entries.map((h, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white border border-gray-200">
              <span className="text-sm text-gray-500">
                {fmtDate(h.date, lang)} {h.start_time && h.end_time ? `· ${h.start_time}-${h.end_time}` : ""}
              </span>
              <span className="text-sm font-semibold text-gray-900">{h.total_hours} {t("portalHrsShort")}</span>
            </div>
          ))}
        </div>
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
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
              {t("portalHoursRecentlyClocked", "Recently clocked")}
              <span className="ml-1 font-normal text-gray-400 normal-case tracking-normal">
                · {t("portalHoursRecentlyClockedWindow", "last {n} days", { n: winDays })}
              </span>
            </div>
            <div className="space-y-1.5">
              {extra.map((h, i) => (
                <div key={`rc-${i}`} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white border border-gray-200">
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
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{claimErr}</div>
          )}
          {pool.map((g) => (
            <div key={g.id} className="rounded-xl bg-white border border-gray-200 p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900">
                  <span className="font-semibold">{fmtSwapDay(g.from_shift_date, lang)}</span>
                  <span className="text-gray-500"> · {g.from_shift_time}</span>
                </div>
                <div className="text-[11px] text-gray-500 truncate">
                  {t("portalGaFrom", "From")} {g.from_staff_name}
                  {g.from_branch_name ? ` · ${g.from_branch_name}` : ""}
                  {g.reason ? ` — “${g.reason}”` : ""}
                </div>
              </div>
              <button
                onClick={() => claimGiveaway(g.id)}
                disabled={claimBusy === g.id}
                className="shrink-0 text-xs font-semibold px-3 py-2 rounded-lg bg-gray-900 hover:bg-gray-700 text-white disabled:opacity-50"
              >
                {claimBusy === g.id ? "…" : t("portalGaTake", "Take it")}
              </button>
            </div>
          ))}
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
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[10px] text-gray-500">
            {isGiveaway ? t("portalGaShiftLabel", "Shift") : t("portalSwapGives", "Gives")}
          </div>
          <div className="text-gray-900">{fmtSwapDay(swap.from_shift_date, lang)}</div>
          <div className="text-gray-500">{swap.from_shift_time}</div>
        </div>
        {!isGiveaway && (
          <div className="bg-gray-50 rounded p-1.5">
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
    <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-gray-900 text-sm flex items-center gap-1.5">
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
        className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-800"
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
        className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-800"
      />
      {error && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{error}</div>
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
  const { t } = useLanguage();
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
    <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-gray-900 text-sm flex items-center gap-1.5"><ArrowLeftRight className="w-4 h-4 text-gray-500" strokeWidth={2} aria-hidden />{t("portalOfferSwap", "Offer to swap")}</div>
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
          className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-gray-900"
        >
          <option value="">{t("portalSwapPickOwn", "Pick one of your shifts…")}</option>
          {upcomingOwn.map((s) => (
            <option key={s.id} value={s.id}>
              {s.date} · {s.start_time}–{s.end_time}
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
            className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-gray-900"
          >
            <option value="">{t("portalSwapPickTeammate", "Pick a teammate's shift…")}</option>
            {candidateTeamShifts.map((s) => (
              <option key={s.shift_id} value={s.shift_id}>
                {s.staff_name} — {s.date} · {s.start_time}–{s.end_time}
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
          className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900 resize-none"
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

function AlertsTab({ token, staffName }) {
  const { t, lang } = useLanguage();
  const [notifications, setNotifications] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    portalApi.get(`/portal/${token}/notifications`)
      .then((res) => {
        setNotifications(res.data.notifications || []);
      })
      .catch(() => {
        setNotifications([]);
      })
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <LoadingSkeleton />;

  const EVENT_ICONS = {
    schedule_published: { Icon: Calendar, label: t("portalEvtSchedulePublished", "Schedule published") },
    shift_changed: { Icon: ArrowLeftRight, label: t("portalEvtShiftChanged", "Shift changed") },
    shift_deleted: { Icon: X, label: t("portalEvtShiftDeleted", "Shift cancelled") },
  };

  // The feed is the IN-APP record. Every publish also writes a push/email
  // delivery row whose subject is just the notification title ("BonBox ·
  // Vagtplan") — showing those reads as contentless duplicates, so they are
  // filtered out. Fail-open: if a staffer somehow has ONLY delivery rows,
  // show them rather than an empty feed.
  const inAppRows = (notifications || []).filter((n) => n.channel === "in_app");
  const feed = inAppRows.length ? inAppRows : notifications || [];

  if (!feed.length) {
    return (
      <div className="space-y-4">
        <div className="text-center py-12">
          <Bell className="w-8 h-8 text-gray-300 mb-3 mx-auto" strokeWidth={2} aria-hidden />
          <h3 className="text-base font-semibold text-gray-900 mb-1">{t("portalAlertsEmptyTitle", "No notifications yet")}</h3>
          <p className="text-sm text-gray-500">
            {t("portalAlertsEmptyBody", "You'll see shift reminders, schedule updates, and tip notifications here.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
        {t("portalAlertsRecent", "Recent notifications")}
      </div>
      <div className="space-y-1.5">
        {feed.map((n) => {
          const evt = EVENT_ICONS[n.event_type] || { Icon: Bell, label: n.event_type };
          const EvtIcon = evt.Icon;
          const timeAgo = n.created_at ? formatTimeAgo(n.created_at, lang, t) : "";
          return (
            <div key={n.id} className="flex items-start gap-3 px-3 py-3 rounded-xl bg-white border border-gray-200">
              <EvtIcon className="w-4 h-4 text-gray-500 mt-0.5" strokeWidth={2} aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900">{n.subject || evt.label}</div>
                <div className="text-[11px] text-gray-400 mt-1">{timeAgo}</div>
              </div>
            </div>
          );
        })}
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


// ─── Messages (Beskeder) — owner ↔ this staffer, 1:1 ───────────────────────

function MessagesTab({ token, restaurantName, onRead }) {
  const { t, lang } = useLanguage();
  const [messages, setMessages] = useState(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const picker = usePhotoPicker();
  const scrollRef = useRef(null);

  const load = useCallback(
    (markRead = true) => {
      portalApi
        .get(`/portal/${token}/chat`)
        .then((res) => {
          setMessages(res.data.messages || []);
          if (markRead) onRead?.();
        })
        .catch(() => setMessages((prev) => prev || []));
    },
    [token, onRead],
  );

  // Initial load + gentle poll (only while the tab is visible).
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
        res = await portalApi.post(`/portal/${token}/chat/photos`, fd);
      } else {
        res = await portalApi.post(`/portal/${token}/chat`, {
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

  const onKeyDown = (e) => {
    // Enter sends; Shift+Enter is a newline (desktop). On-screen keyboards
    // send via the button, so this only helps physical keyboards.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col">
      {/* Message stream */}
      <div
        ref={scrollRef}
        className="space-y-2 overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 16rem)" }}
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
            <h3 className="text-base font-semibold text-gray-900 mb-1">
              {t("staffChatEmptyTitle", "No messages yet")}
            </h3>
            <p className="text-sm text-gray-500">
              {t(
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
                  <span className="text-[10px] text-gray-400 mb-0.5 px-1">
                    {restaurantName || t("staffChatOwnerLabel", "Manager")}
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
                    className={`px-3.5 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                      m.mine
                        ? "text-white rounded-br-md"
                        : "bg-white border border-gray-200/70 text-gray-900 rounded-bl-md"
                    } ${m._pending ? "opacity-60" : ""} ${m._failed ? "cursor-pointer ring-1 ring-red-300" : ""}`}
                    style={m.mine ? { background: "rgb(var(--brand-600))" } : undefined}
                  >
                    {m.body}
                  </div>
                )}
                <span className="text-[10px] text-gray-400 mt-0.5 px-1">
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
        className="fixed inset-x-0 z-20 glass border-t border-gray-200/70"
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
              className="flex-1 resize-none max-h-28 px-3 py-2 rounded-2xl bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
            />
            <button
              onClick={send}
              disabled={(!text.trim() && picker.files.length === 0) || sending}
              aria-label={t("staffChatSend", "Send")}
              className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white disabled:opacity-40 transition"
              style={{ background: "rgb(var(--brand-600))" }}
            >
              <Send className="w-[18px] h-[18px]" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── Loading skeleton ──────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="grid grid-cols-2 gap-3">
        <div className="h-20 bg-gray-100 rounded-xl" />
        <div className="h-20 bg-gray-100 rounded-xl" />
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
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <Inbox className="w-8 h-8 text-gray-300 mb-3 mx-auto" strokeWidth={2} aria-hidden />
        <h1 className="text-xl font-bold text-gray-900 mb-2">{t("portalErrorTitle", "Link not working")}</h1>
        <p className="text-sm text-gray-500">{message || t("portalErrorBody", "This link may have expired or been deactivated. Ask your manager for a new one.")}</p>
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
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          {t("fravaerHeading", "Time off · needs approval")}
        </div>
        <p className="text-[12px] text-gray-500 mt-0.5 leading-snug">
          {t("fravaerNeedsApprovalSub", "This is a request — your manager approves it. You'll see Pending, then Approved.")}
        </p>
      </div>

      {rows === null ? (
        <div className="text-xs text-gray-500">{t("portalLoading", "Loading…")}</div>
      ) : groups.length > 0 ? (
        <div className="space-y-2">
          {groups.map((g) => {
            const st = STATUS[g.status] || STATUS.pending;
            return (
              <div key={g.ids[0]} className="rounded-xl bg-white border border-gray-200 p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                  <CalendarPlus className="w-[18px] h-[18px] text-gray-500" strokeWidth={2} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-900 truncate">
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
                    {t("fravaerWithdraw", "Withdraw")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {!adding ? (
        <button
          onClick={() => { reset(); setAdding(true); }}
          className="w-full px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          <CalendarPlus className="w-4 h-4" strokeWidth={2.25} aria-hidden />
          {t("fravaerAdd", "Request holiday / sick leave")}
        </button>
      ) : (
        <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-4">
          <div className="grid grid-cols-2 gap-1.5">
            {["ferie", "sick", "barns_syg", "andet"].map((k) => (
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
                className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-gray-900/30" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 mb-1 block">{t("fravaerTo", "To (optional)")}</label>
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-gray-900/30" />
            </div>
          </div>
          <input
            type="text" value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)}
            placeholder={t("fravaerNotePlaceholder", "Note (optional)")}
            className="w-full px-3 py-2.5 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
          />
          <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-snug">
            {t("fravaerNeedsApproval", "This is a request — your manager must approve it.")}
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex gap-2">
            <button onClick={() => { setAdding(false); reset(); }}
              className="flex-1 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition">
              {t("portalCancel", "Cancel")}
            </button>
            <button onClick={submit} disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700 transition disabled:opacity-50">
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
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {/* Month nav — mutates view only, never data */}
      <div className="flex items-center justify-between px-1 pb-1">
        <button type="button" onClick={onPrev} aria-label={t("kanIkkePrevMonth", "Previous month")}
          className="w-9 h-9 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition">
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
          className="w-9 h-9 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition">
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
          let fill = "", num = "text-gray-900", ring = "";
          let tappable = !past;
          if (approved) { fill = "bg-emerald-50"; ring = "ring-1 ring-inset ring-emerald-200"; num = "text-emerald-700 font-semibold"; tappable = false; }
          else if (pending) { fill = "bg-amber-50"; ring = "ring-1 ring-inset ring-amber-200"; num = "text-amber-700 font-semibold"; tappable = false; }
          else if (oneOff) { fill = "bg-gray-900"; num = "text-white font-semibold"; }
          else if (recurring) { ring = "ring-1 ring-inset ring-gray-900"; num = "text-gray-900"; }
          if (past) num = "text-gray-300 font-normal";

          const cls =
            "relative aspect-square min-h-[44px] rounded-xl flex items-center justify-center text-[15px] font-medium tabular-nums transition " +
            fill + " " + ring + " " + num +
            (tappable ? " active:scale-[0.97] cursor-pointer" : " cursor-default") +
            (saving ? " opacity-60" : "") +
            (today && !fill && !ring ? " bg-gray-100" : "") +
            (past && (oneOff || abs || recurring) ? " opacity-40" : "");

          const shiftDot = oneOff ? "bg-white" : approved ? "bg-emerald-600" : pending ? "bg-amber-500" : "bg-gray-900";

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
            >
              <span className={today ? "font-bold" : ""}>{dayNum}</span>
              {recurring && !oneOff && !abs && (
                <Repeat className="absolute top-0.5 right-0.5 w-2.5 h-2.5 text-gray-500" strokeWidth={2.5} aria-hidden />
              )}
              {oneOff?.timed && (
                <Clock className="absolute bottom-0.5 left-0.5 w-2.5 h-2.5 text-white" strokeWidth={2.5} aria-hidden />
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
          <div className="text-sm font-semibold text-gray-900 truncate">{label}</div>
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
        <div className="px-3 pb-3 pt-3 space-y-3 border-t border-gray-100">
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
                className="flex-1 px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm outline-none focus:border-gray-900/30" />
              <span className="text-gray-400" aria-hidden>–</span>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm outline-none focus:border-gray-900/30" />
            </div>
          )}
          <input type="text" value={note} maxLength={80} onChange={(e) => setNote(e.target.value)}
            placeholder={t("kanIkkeNotePlaceholder", "Note (optional) — e.g. exam")}
            className="w-full px-3 py-2.5 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30" />
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
function AvailabilityTab({ token, shifts }) {
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
      if (a.kind === "unavailable" && a.date) {
        m[a.date] = { id: a.id, timed: !!a.start_time, start: a.start_time, end: a.end_time, note: a.note };
      }
    });
    return m;
  }, [avail]);
  const recurringByWeekday = useMemo(() => {
    const m = new Map();
    (avail || []).forEach((a) => {
      if (a.kind === "unavailable" && a.date == null && a.weekday != null) m.set(a.weekday, a.id);
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
    withSaving(iso, true);
    setAvail((rows) => [...(rows || []), { id: "tmp-" + iso, kind: "unavailable", date: iso, weekday: null, start_time: null, end_time: null, note: null }]);
    try { await portalApi.post(`/portal/${token}/availability`, { date: iso, kind: "unavailable" }); await loadAvail(); }
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
    const id = recurringByWeekday.get(wd);
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
    const body = { date: row.date, kind: "unavailable" };
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
      {/* Intro — mental model + honesty boundary before the first tap */}
      <p className="text-[13px] leading-relaxed text-gray-600">
        {t("kanIkkeCalIntro", "Tap the days you can't work. Your manager sees it while planning — a heads-up, not approved time off.")}
      </p>

      <MonthCalendar
        viewYear={viewYear} viewMonth={viewMonth}
        onPrev={goPrev} onNext={goNext} onToday={goToday} showToday={!isCurrentMonth}
        oneOffByDate={oneOffByDate} recurringSet={recurringSet} absenceByDate={absenceByDate}
        shiftSet={shiftSet} savingSet={savingSet}
        onTapDay={tapDay} lang={lang} t={t}
      />

      {err && <div className="text-xs text-red-600">{err}</div>}

      {/* Legend — text always present, never colour-only */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-gray-900" />{t("legendCantWork", "Can't work")}</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded ring-1 ring-inset ring-gray-900" />{t("legendRepeats", "Every week")}</span>
        {hasAbsence && <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-100 ring-1 ring-inset ring-amber-300" />{t("legendPending", "Pending")}</span>}
        {hasAbsence && <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-100 ring-1 ring-inset ring-emerald-300" />{t("legendApproved", "Approved off")}</span>}
        {shiftSet.size > 0 && <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gray-900" />{t("legendScheduled", "Scheduled")}</span>}
      </div>
      <p className="text-[11px] text-gray-400 -mt-2">{t("legendCaption", "Grey = your note. Colour = your manager's answer.")}</p>

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
      <div className="h-px bg-gray-100" />

      {/* Fravær — a request the owner approves (distinct from the soft calendar taps) */}
      <AbsenceSection token={token} onChanged={loadAbsence} />

      {/* Remove-weekly-rule scoped confirm (blast-radius honesty) */}
      {confirmWeekday && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true">
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => setConfirmWeekday(null)} aria-label={t("portalCancel", "Cancel")} />
          <div className="relative w-full max-w-lg mx-auto bg-white rounded-t-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-3">
            <div className="text-base font-bold text-gray-900">{t("kanIkkeRemoveWeeklyTitle", "Remove this weekly rule?")}</div>
            <p className="text-[13px] text-gray-600">{t("kanIkkeRemoveWeeklyBody", "This clears every {day}.").split("{day}").join(WD[confirmWeekday.wd])}</p>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setConfirmWeekday(null)} className="flex-1 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition">{t("portalCancel", "Cancel")}</button>
              <button type="button" onClick={() => removeWeekly(confirmWeekday.wd)} className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition">{t("kanIkkeRemove", "Remove")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
        <div className="px-3 pb-3 border-t border-gray-100">
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
              className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold bg-gray-900 text-white hover:bg-gray-700 transition"
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
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold bg-gray-900 text-white hover:bg-gray-700 transition"
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


/**
 * SyncPill — the honest freshness indicator in the portal header.
 *
 * Hard rule (see MEMORY "honest claims"): the pill must reflect REAL state.
 *   • Offline                       → "Offline", gray, CloudOff. Never "Synced".
 *   • Online + synced < 45s ago     → "Synced", emerald dot + RefreshCw.
 *   • Online + synced ≥ 45s ago     → "Synced HH:MM", gray, tap to refetch.
 *   • Online + never synced yet     → "Synced HH:MM" falls back to a plain
 *     "Sync" affordance (no lastSynced) so we never imply freshness we lack.
 *
 * It's a button so the stale/online state is tappable to force a refetch;
 * onRefresh is the parent's loadData. Re-renders are driven by the parent's
 * freshness ticker so the label decays without a new fetch.
 */
function SyncPill({ isOnline, live, lastSynced, onRefresh, t }) {
  const FRESH_MS = 45000;
  const ageMs = lastSynced ? Date.now() - lastSynced.getTime() : Infinity;
  const isFresh = isOnline && lastSynced && ageMs < FRESH_MS;

  if (!isOnline) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 border border-gray-200 text-[11px] font-medium text-gray-400"
        role="status"
      >
        <CloudOff className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
        {t("portalOffline")}
      </span>
    );
  }

  // Live — the realtime stream is open, so changes land instantly. This is
  // the ONE honest "live/now" use of the full emerald pill (green exclusivity:
  // LIVE keeps the pill; mere freshness gets the quiet gray+dot below). Solid
  // dot, NO animate-ping — the clocked-in ping in the hero owns the pulse.
  // Only shown when truly connected (never imply "live" while polling).
  if (live) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 active:scale-[0.98] transition"
        title={t("portalLive")}
        aria-label={t("portalLive")}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
        {t("portalLive")}
      </button>
    );
  }

  if (isFresh) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 border border-gray-200 text-[11px] font-medium text-gray-500 hover:bg-gray-200 active:scale-[0.98] transition"
        title={t("portalSynced")}
        aria-label={t("portalSynced")}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
        {t("portalSynced")}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 border border-gray-200 text-[11px] font-medium text-gray-500 hover:bg-gray-200 transition"
      title={t("portalSynced")}
    >
      <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
      {lastSynced
        ? t("portalSyncedAt", { time: fmtClock(lastSynced) })
        : t("portalSynced")}
    </button>
  );
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
  // Hoisted from WhosOnStrip / OpenShiftsClaimCard so the Schedule tab paints
  // ONCE — no post-settle hero growth or card insertion (stillness doctrine).
  const [teamShifts, setTeamShifts] = useState([]);
  const [openShifts, setOpenShifts] = useState([]);
  // business_date -> booked covers, for the days I'm rostered. Empty map = this
  // owner doesn't take reservations (or the book is untouched) -> render NOTHING.
  const [coversByShift, setCoversByShift] = useState({});
  const [hoursData, setHoursData] = useState(null);
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
    // Schedule — the freshness source of truth. On success we stamp
    // lastSynced (drives the "Synced" pill) and diff the published shifts
    // against the last-rendered signature to decide whether to toast.
    // Schedule + who's-on + open-shifts settle TOGETHER (Promise.allSettled →
    // React 18 batches the sets into one paint), so the hero never grows and
    // no card inserts after first paint. Each leg fails independently and
    // honest: on error we keep the previous data, never clear it.
    Promise.allSettled([
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
        // Only toast on a REAL change after we already had data — never on the
        // first successful load (prevSig === null means we've shown nothing yet).
        if (prevSig !== null && prevSig !== nextSig) {
          setScheduleUpdated(true);
        }
        scheduleSigRef.current = nextSig;
        setShifts(nextShifts);
        setLastSynced(new Date());
      }
      // Fail honest: do NOT advance lastSynced on a failed schedule fetch, so
      // the pill keeps showing the real last-good time (or Offline).
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
    });

    // Hours
    portalApi.get(`/portal/${token}/hours`).then((res) => {
      setHoursData(res.data);
    }).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (pinVerified && info) loadData();
  }, [pinVerified, info, loadData]);

  // Refetch on the app-wide freshness signal — e.g. after a clock-out, so the
  // just-logged shift shows in "My hours" (recent_clocked) without a reload.
  useEffect(() => {
    if (!(pinVerified && info)) return;
    const onChanged = () => loadData();
    window.addEventListener("bonbox-data-changed", onChanged);
    return () => window.removeEventListener("bonbox-data-changed", onChanged);
  }, [pinVerified, info, loadData]);

  // NOTE on old installed PWAs: the manifest used to ship a "?tab=tips"
  // shortcut. "tips" is no longer in the deep-link allow-list above, so such a
  // link already resolves to "schedule" — no special handling needed.

  // 2c. Chat unread badge — poll the cheap count endpoint so the "Beskeder"
  // nav dot lights up when the owner writes. While the Messages tab is open
  // the server marks read on each fetch, so we just hold the badge at 0.
  useEffect(() => {
    if (!(pinVerified && info)) return;
    if (tab === "messages") {
      setChatUnread(0);
      return;
    }
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
    const id = setInterval(poll, 25000);
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

    const onVisible = () => {
      if (document.visibilityState === "visible") loadData();
    };
    const onOnline = () => {
      setIsOnline(true);
      loadData();
    };
    const onOffline = () => setIsOnline(false);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const pollId = setInterval(() => {
      if (document.visibilityState === "visible") loadData();
    }, liveConnected ? 60000 : 20000);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(pollId);
    };
  }, [pinVerified, info, loadData, liveConnected]);

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

    const onPublished = () => loadData();
    es.onopen = () => setLiveConnected(true);
    es.onerror = () => setLiveConnected(false); // browser keeps auto-reconnecting
    es.addEventListener("schedule_published", onPublished);

    return () => {
      setLiveConnected(false);
      try { es.removeEventListener("schedule_published", onPublished); } catch { /* noop */ }
      try { es.close(); } catch { /* noop */ }
    };
  }, [pinVerified, info, token, loadData]);

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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
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
    <div className="full-height scrollable bg-gray-50 text-gray-900 pb-24">
      {/* Header — sticks to the top of the internal scroller. Uses .glass-static
          (no translateZ) so the sticky header doesn't wobble during momentum
          scroll on iOS. */}
      <div className="sticky top-0 z-10 glass-static border-b border-gray-200/70 pt-[env(safe-area-inset-top)]">
        {/* Opaque cap over the status-bar / notch inset. The header glass is
            translucent (85%), so without this the content scrolling underneath
            bleeds up into the status bar — this keeps the notch clean and the
            scroll transition crisp. Theme-aware; sized to the safe-area inset. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 bg-white/95 dark:bg-gray-900"
          style={{ height: "env(safe-area-inset-top)" }}
        />
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">
              {tab === "schedule" ? t("portalTitleSchedule", "My schedule")
                : tab === "availability" ? t("portalTitleKanIkke", "Availability")
                : tab === "messages" ? t("portalTitleMessages", "Messages")
                : tab === "swaps" ? t("portalTitleSwaps", "Swaps")
                : tab === "hours" ? t("portalTitleHours", "My hours")
                : t("portalTitleAlerts", "Alerts")}
            </h1>
            {info?.restaurant_name && (
              <div className="text-[11px] text-gray-500">{info.restaurant_name}</div>
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
            </button>
            {/* Honest freshness pill — only shown once verified. Tap (when
                online + stale) forces a refetch. */}
            {pinVerified && info && (
              <SyncPill
                isOnline={isOnline}
                live={liveConnected}
                lastSynced={lastSynced}
                onRefresh={loadData}
                t={t}
              />
            )}
            <button
              onClick={() => { setShowEmailEdit(!showEmailEdit); setEmailInput(info?.email || ""); setPhoneInput(info?.phone || ""); setAddressInput(info?.address || ""); setPostalInput(info?.postal_code || ""); setCityInput(info?.city || ""); setEmailMsg(""); setEmailStatus(null); }}
              className="relative w-9 h-9 rounded-full bg-gray-100 border border-gray-200 shadow-soft overflow-hidden flex items-center justify-center text-sm font-bold text-gray-700 active:scale-[0.98] transition before:absolute before:-inset-2 before:content-['']"
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
              className="absolute inset-0 bg-black/40"
            />
            <div className="relative w-full max-w-lg mx-auto bg-white rounded-t-2xl shadow-soft-lg max-h-[90dvh] overflow-y-auto overscroll-contain">
              <div className="sticky top-0 bg-white/95 flex items-center justify-between px-4 pt-4 pb-2 border-b border-gray-100">
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
              <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
                <div className="w-14 h-14 rounded-full bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center text-base font-bold text-gray-500 shrink-0">
                  {photoUrl ? (
                    <img src={photoUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    info?.staff_name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-1.5">{t("portalPhotoLabel", "Photo")}</div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handlePhotoChange}
                      disabled={photoBusy}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 text-white hover:bg-gray-700 transition disabled:opacity-50"
                    >
                      <CameraIcon className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
                      {photoBusy ? t("portalSaving", "Saving…") : (photoUrl ? t("portalPhotoChange", "Change") : t("portalPhotoAdd", "Add photo"))}
                    </button>
                    {photoUrl && !photoBusy && (
                      <button
                        type="button"
                        onClick={handlePhotoRemove}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100 transition"
                        aria-label={t("portalPhotoRemove", "Remove photo")}
                      >
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold">{t("portalNotifications", "Notifications")}</div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">{t("portalContactEmailLabel", "Email")}</label>
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">{t("portalContactPhoneLabel", "Phone (optional)")}</label>
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="+45 12 34 56 78"
                  className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                />
              </div>
              {/* Home address — DK-structured (adresse / postnr / by). Optional;
                  the owner sees it so they have a current address on file. */}
              <div className="pt-1 border-t border-gray-100 space-y-3">
                <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold">{t("portalAddressSection", "Address")}</div>
                <div>
                  <label className="text-[10px] text-gray-500 mb-1 block">{t("portalAddressStreetLabel", "Street & number")}</label>
                  <input
                    type="text"
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                    autoComplete="street-address"
                    placeholder={t("portalAddressStreetPlaceholder", "e.g. Nørrebrogade 12, 2. th")}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
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
                      className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
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
                      className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
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
              <DocumentsSection token={token} />

              {/* Language — moved here from the header (design). Staff pick DA / EN. */}
              <div className="pt-3 border-t border-gray-100">
                <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-2">{t("portalLangSection", "Language")}</div>
                <div className="flex w-full rounded-lg border border-gray-200 p-0.5 gap-0.5" role="group" aria-label={t("portalLangLabel", "Language")}>
                  {["da", "en"].map((code) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setLang(code)}
                      aria-pressed={lang === code}
                      className={`flex-1 py-1.5 rounded-md text-[13px] font-semibold transition active:scale-[0.98] ${
                        lang === code ? "bg-gray-900 text-white" : "bg-white text-gray-500 hover:bg-gray-50"
                      }`}
                    >
                      {code === "da" ? "Dansk" : "English"}
                    </button>
                  ))}
                </div>
                <div className="mt-1.5 text-[10px] text-gray-400">{t("portalLangNote", "Only changes the app's language.")}</div>
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
              <div className="text-[10px] text-gray-400">
                {info?.email || info?.phone ? (
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    {info.email && (
                      <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" strokeWidth={2} aria-hidden />{info.email}</span>
                    )}
                    {info.email && info.phone && <span aria-hidden>·</span>}
                    {info.phone && (
                      <span className="inline-flex items-center gap-1"><Smartphone className="w-3 h-3" strokeWidth={2} aria-hidden />{info.phone}</span>
                    )}
                  </span>
                ) : (
                  t("portalContactEmptyHint", "Add your email or phone to get notified when your schedule changes.")
                )}
              </div>
              {(info?.address || info?.postal_code || info?.city) && (
                <div className="text-[10px] text-gray-400 inline-flex items-start gap-1">
                  <MapPin className="w-3 h-3 mt-px shrink-0" strokeWidth={2} aria-hidden />
                  <span>{[info.address, [info.postal_code, info.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</span>
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
              <div className="pt-1 border-t border-gray-100">
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

      {/* Content */}
      <div className="max-w-lg mx-auto px-4 py-4">
        {tab === "schedule" && (
          <ScheduleTab
            shifts={shifts}
            coversByShift={coversByShift}
            teamShifts={teamShifts}
            openShifts={openShifts}
            staffName={info?.staff_name}
            token={token}
            restaurantName={info?.restaurant_name}
            restaurantCity={info?.restaurant_city}
            restaurantAddress={info?.restaurant_address}
            onShiftsChanged={loadData}
            onNeedChange={() => setTab("swaps")}
            onOpenAvailability={() => setTab("availability")}
          />
        )}
        {/* Install/push nudge — BELOW the shift so the schedule leads; a calm
            collapsed line, not a promo card above the fold. */}
        {/* Inside the native Scheduler shell "add to home screen" is
            nonsense — the user IS in the app. Native push arrives with the
            APNs slice; until then the card simply doesn't render there. */}
        {tab === "schedule" && !isNativeApp() && <InstallNotifyCard token={token} />}
        {tab === "availability" && <AvailabilityTab token={token} shifts={shifts} />}
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
        {tab === "hours" && <HoursTab data={hoursData} maxHours={info?.max_hours_month} />}
        {tab === "alerts" && <AlertsTab token={token} staffName={info?.staff_name} />}
      </div>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 glass border-t border-gray-200/70 z-20">
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
                  color: active ? "#15803d" : "#94a3b8",
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
                      className="absolute -inset-x-3.5 -inset-y-[4px] rounded-full"
                      style={{
                        background: "linear-gradient(180deg,#dcfce7,#bbf7d0)",
                        boxShadow:
                          "inset 0 1px 0 rgba(255,255,255,.8), 0 4px 10px -6px rgba(22,163,74,.7)",
                      }}
                    />
                  )}
                  <item.Icon
                    className="relative z-10 w-[18px] h-[18px]"
                    strokeWidth={active ? 2.25 : 2}
                    aria-hidden
                  />
                  {item.key === "messages" && chatUnread > 0 && (
                    <span
                      className="absolute z-10 -top-1 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[14px] text-center"
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
