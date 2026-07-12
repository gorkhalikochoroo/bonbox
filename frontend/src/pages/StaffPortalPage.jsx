/**
 * Staff Portal — what your staff sees when they open their magic link.
 * Mobile-first, dark theme, no login required.
 * Route: /s/:token
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams } from "react-router-dom";
import { RefreshCw, CloudOff, Download, Smartphone, Share, Check, X, Calendar, ArrowLeftRight, Clock, Banknote, Bell, Lock, AlertTriangle, Mail, BellOff, MessageCircle, MessageSquare, Send, Inbox, Thermometer, StickyNote, MapPin, MapPinOff, CalendarPlus, ChevronDown, CalendarOff, Plus } from "lucide-react";
import portalApi, { storePinProof } from "../services/portalApi";
import { useLanguage } from "../hooks/useLanguage";
import { errText } from "../utils/errText";
import { isNativeApp } from "../utils/platform";
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
    <button
      type="button"
      onClick={onNeedChange}
      className="mt-2 w-full text-center text-[12px] text-gray-500 hover:text-gray-700 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 rounded-md py-1"
    >
      {t("portalNeedChange")}
    </button>
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
        if (pos) payload = pos;
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

  return { st, busy, err, result, act, fmtDur, liveLabel: fmtElapsed(liveSec) };
}

// ── Live countdown to the next shift's start. No timer of its own; the parent
// re-renders every 15s via the page-level freshnessTick, so this stays current
// without a second interval. Honest: started/past → "I gang" ("Now"), never a
// negative or fabricated future time. Returns null when there's no shift or the
// shift is neither today nor within ~24h (the chip would be noise otherwise).
// The impure Date.now() read is intentionally confined here, out of any
// component render body.
function nextShiftCountdown(shift, t) {
  if (!shift) return null;
  // Local-time parse matches the existing date+start_time pattern elsewhere.
  const target = new Date(`${shift.date}T${shift.start_time || "00:00"}`);
  if (Number.isNaN(target.getTime())) return null;
  const ms = target.getTime() - Date.now();
  // Only show today or within ~24h.
  if (!isToday(shift.date) && ms >= 24 * 3600000) return null;
  if (ms <= 0) return t("portalCountdownNow");
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return t("portalCountdownSoonMin", { m: totalMin });
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return t("portalCountdownIn", { h, m });
}

// ── Initials for a teammate avatar (≤2 letters, uppercased). Privacy: only
// initials + a role-underline are ever shown for teammates.
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
  const seen = new Set();
  const mates = [];
  for (const s of teamShifts) {
    if (s.date !== nextShift.date) continue;
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
      </div>
      <div className="flex items-center gap-3 overflow-x-auto pb-1">
        {shown.map((s, i) => (
          <div
            key={`${s.staff_id ?? s.staff_name}-${i}`}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-800 text-[12px] font-semibold text-white ring-2 ring-gray-900"
            title={staffInitials(s.staff_name)}
            aria-hidden
          >
            {staffInitials(s.staff_name)}
          </div>
        ))}
        {overflow > 0 && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-[12px] font-semibold text-gray-300">
            +{overflow}
          </div>
        )}
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


function ScheduleTab({ shifts: rawShifts, teamShifts, openShifts, staffName, token, restaurantName, onShiftsChanged, onNeedChange }) {
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

  // Countdown chip — null unless the shift is today or within ~24h. The
  // Date.now() read lives inside the pure helper, recomputed each 15s render.
  const countdownLabel = nextShiftCountdown(nextShift, t);

  // Add-to-calendar (.ics) for the next shift — naive wall-clock + TZID, no UTC.
  const addToCalendar = async () => {
    if (!nextShift) return;
    const summary = restaurantName
      ? t("portalIcsSummary", { venue: restaurantName })
      : t("portalIcsSummaryNoVenue");
    const ics = buildShiftIcs(nextShift, restaurantName, summary);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const filename = `vagt-${nextShift.date}.ics`;
    const file =
      typeof File !== "undefined" ? new File([blob], filename, { type: "text/calendar" }) : null;

    // 1) Web Share (best on mobile). try/catch so a REAL share failure falls
    //    through to a download path instead of the button silently doing
    //    nothing; a user-cancel (AbortError) just returns.
    if (file && navigator.canShare?.({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title: summary });
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
        /* real share failure → fall through to the download paths below */
      }
    }

    // 2) iOS Safari + in-app webviews (Instagram/Messenger magic-link opens)
    //    IGNORE anchor `download` on a blob: URL — the tap was a SILENT no-op,
    //    which is the "add to calendar not working" report. Navigating a data:
    //    URL hands the .ics to the OS "Add event" sheet on those clients.
    const ua = navigator.userAgent || "";
    const isIOS =
      /iP(hone|ad|od)/.test(navigator.platform || ua) ||
      (/Mac/.test(ua) && "ontouchend" in document);
    const inAppWebview =
      /(FBAN|FBAV|Instagram|Line|Messenger|LinkedInApp|Twitter|MicroMessenger)/i.test(ua);
    if (isIOS || inAppWebview) {
      window.location.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
      return;
    }

    // 3) Desktop + most Android: anchor download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
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

  return (
    <div className="space-y-4">
      {/* HERO — dark gray-900 next-shift card with a 4px role-colored left-bar.
          Absorbs the punch-clock (elapsed timer + Stempl ind/ud) and a live
          countdown. Role shows ONLY via the thin left-bar + a tiny label. */}
      <div className={`relative overflow-hidden rounded-2xl bg-gray-900 text-white p-5 shadow-soft-lg${playBeat ? " motion-safe:animate-heroSettle" : ""}`}>
        {/* Faint --brand corner under-glow — the portal's one ceremonial glossy
            beat: felt, not seen. Static, low-alpha (0.20), never neon. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-16 -right-12 h-48 w-48 rounded-full blur-3xl"
          style={{ background: "rgb(var(--brand-500) / 0.20)" }}
        />
        {/* 1px lit top edge — the cheapest premium "glossy" tell. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
        />
        {/* Role-colored left-bar — a thin SIGNAL, the only role colour. Only
            when there IS a shift: an empty hero has no role to signal. */}
        {nextShift && (
          <span
            className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${roleBarColor(nextShift.role_on_shift)}`}
            aria-hidden
          />
        )}
        <div className="flex items-start justify-between gap-2">
          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            {t("portalNextShiftHero")}
          </div>
          {countdownLabel && (
            <span className="shrink-0 rounded-full bg-white/10 ring-1 ring-white/15 backdrop-blur-sm text-gray-200 text-[12px] px-2.5 py-0.5 tabular-nums">
              {countdownLabel}
            </span>
          )}
        </div>

        {nextShift ? (
          <>
            <div className="mt-2 text-3xl font-bold text-white leading-tight tracking-[-0.02em]">
              {isToday(nextShift.date) ? t("portalToday") : fmtDate(nextShift.date, lang)}
            </div>
            {/* The TIME is the answer a staffer opens this page for — it speaks
                at headline-adjacent scale; date → time → meta, a true F-pattern.
                (Was 13px gray — the payload rendered as a footnote.) */}
            <div className="mt-1 text-lg font-semibold text-white tabular-nums">
              {nextShift.start_time}–{nextShift.end_time}{" "}
              <span className="text-[13px] font-normal text-gray-400">· {nextShift.net_hours} {t("portalHrsShort")}</span>
            </div>
            <div className="mt-1 text-[12px] text-gray-400">{nextShiftRole}</div>

            {/* Venue line — name ONLY (never a fabricated address). When the
                owner has turned ON the clock-in geofence, this becomes an honest
                "Stempl kun ind ved <venue>" lock hint so the staffer knows the
                clock-in is location-bound before they try it (the server's
                too_far 403 is still the real gate). */}
            {restaurantName && (
              <div className="mt-2 flex items-center gap-1.5 text-[12px] text-gray-400">
                {clock.st?.geofence_on ? (
                  <>
                    <Lock className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                    <span className="truncate">
                      {t("portalClockOnlyAt", "Clock in only at {venue}", { venue: restaurantName })}
                    </span>
                  </>
                ) : (
                  <>
                    <MapPin className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                    <span className="truncate">{restaurantName}</span>
                  </>
                )}
              </div>
            )}

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
                      disabled={clock.busy}
                      onClick={() => clock.act("in")}
                      className="flex-1 inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl bg-white text-gray-900 text-sm font-semibold shadow-[0_2px_8px_-2px_rgb(0_0_0/0.4)] hover:bg-gray-100 active:scale-[0.98] transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
                    >
                      {t("portalClockInCta")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={addToCalendar}
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-xl bg-white/10 ring-1 ring-white/15 text-gray-200 text-sm font-medium hover:bg-white/20 active:scale-[0.98] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
                  >
                    <CalendarPlus className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden />
                    <span>{t("portalAddToCalendar")}</span>
                  </button>
                </div>
              )}
            </div>
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
            return (
              <button
                key={d}
                type="button"
                onClick={() => setExpandedDate(isExpanded || !shift ? null : d)}
                className={`flex flex-col items-center gap-1.5 rounded-lg py-2 min-h-[44px] transition active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 ${isExpanded ? "bg-gray-100" : isTodayCell ? "bg-gray-50" : "hover:bg-gray-50"}`}
                aria-label={`${WD[i]} ${fmtShort(d, lang)}`}
                aria-current={isTodayCell ? "date" : undefined}
                aria-expanded={shift ? isExpanded : undefined}
              >
                {/* TODAY = bold gray-900 label + soft cell fill (above). No ink
                    ring — a ring hugging a 4px bar rendered as a broken pill.
                    EXPANDED = a step darker (bg-gray-100) so "open" reads
                    distinctly from "today". */}
                <span className={`text-[10px] ${isTodayCell ? "text-gray-900 font-semibold" : "text-gray-400"}`}>{WD[i]}</span>
                <span className={`text-[10px] tabular-nums ${isTodayCell ? "text-gray-900 font-semibold" : "text-gray-400"}`}>{parseInt(d.slice(8), 10)}</span>
                {shift ? (
                  <span
                    className={`block w-1.5 h-5 rounded-full ${roleBarColor(shift.role_on_shift)}`}
                    aria-hidden
                  />
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

        {/* Muted summary line (replaces the old "This week hrs" KPI card). */}
        {weekView === "this" && (
          <div className="mt-2 text-[11px] text-gray-500">
            {t("portalWeekStripHrs", {
              h: thisWeekHours,
              hrs: t("portalHrsShort"),
              n: thisWeekShifts.length,
              shifts: t("portalShiftsCount"),
            })}
          </div>
        )}

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


// ─── Tips Tab ─────────────────────────────────────────────────────────────

function TipsTab({ data }) {
  const { t: tr, lang } = useLanguage();
  if (!data) return <LoadingSkeleton />;

  const avgPerShift = data.entries.length > 0 ? (data.total_tips_30d / data.entries.length) : 0;
  const lastTip = data.entries[0];

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-white border border-gray-200 p-3">
          <div className="text-[10px] text-gray-500 mb-1">{tr("portalTipsLast30", "Last 30 days")}</div>
          <div className="text-lg font-bold text-gray-700">{Math.round(data.total_tips_30d).toLocaleString()}</div>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-3">
          <div className="text-[10px] text-gray-500 mb-1">{tr("portalTipsLastShift", "Last shift")}</div>
          <div className="text-lg font-bold text-gray-900">{lastTip ? Math.round(lastTip.amount) : "—"}</div>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-3">
          <div className="text-[10px] text-gray-500 mb-1">{tr("portalTipsAvgPerShift", "Avg / shift")}</div>
          <div className="text-lg font-bold text-gray-900">{Math.round(avgPerShift)}</div>
        </div>
      </div>

      {/* Tip history */}
      <div>
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">{tr("portalTipsHistory", "Tip history")}</div>
        <div className="space-y-1.5">
          {data.entries.length === 0 && (
            <div className="text-sm text-gray-400 py-4 text-center">{tr("portalTipsNone", "No tips recorded yet")}</div>
          )}
          {data.entries.map((t, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white border border-gray-200">
              <span className="text-sm text-gray-500">{fmtDate(t.date, lang)}</span>
              {t.share_pct && <span className="text-[11px] text-gray-400">{tr("portalTipsShare", "{pct}% share", { pct: t.share_pct.toFixed(1) })}</span>}
              <span className="text-sm font-semibold text-gray-700">{Math.round(t.amount)} DKK</span>
            </div>
          ))}
        </div>
      </div>

      {data.entries.length > 0 && (
        <div className="text-center text-[11px] text-gray-400">
          {tr("portalTipsSplitMethod", "Split method")}: {data.entries[0]?.split_method === "by_hours" ? tr("portalTipsByHours", "By hours worked") : data.entries[0]?.split_method || "—"}
        </div>
      )}
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
  const { t } = useLanguage();
  const [inbox, setInbox] = useState(null);
  const [showPropose, setShowPropose] = useState(false);

  const fetchInbox = async () => {
    try {
      const res = await portalApi.get(`/portal/${token}/swap-requests`);
      setInbox(res.data || []);
    } catch {
      setInbox([]);
    }
  };

  useEffect(() => { fetchInbox(); }, [token]);

  const reload = () => {
    fetchInbox();
    onChanged?.();
  };

  return (
    <div className="space-y-4">
      {/* Propose CTA */}
      {!showPropose && (
        <button
          onClick={() => setShowPropose(true)}
          className="w-full px-4 py-3 rounded-xl bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          <ArrowLeftRight className="w-4 h-4" strokeWidth={2} aria-hidden />
          {t("portalOfferSwapLong", "Offer to swap a shift")}
        </button>
      )}
      {showPropose && (
        <SwapProposeModal
          token={token}
          ownShifts={ownShifts}
          onClose={() => setShowPropose(false)}
          onProposed={() => { setShowPropose(false); reload(); }}
        />
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

  // Localized status word for the pill. "Byttet" (swapped/done) stays
  // Danish across all UI languages per the DK terminology lock.
  const statusLabel = swap.status === "proposed"
    ? t("portalSwapStatusProposed", "Pending")
    : swap.status === "done"
      ? t("portalSwapStatusDone", "Byttet")
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
        <span className="text-gray-500"> → </span>
        <span className="font-semibold">{swap.to_staff_name}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[10px] text-gray-500">{t("portalSwapGives", "Gives")}</div>
          <div className="text-gray-900">{fmtSwapDay(swap.from_shift_date, lang)}</div>
          <div className="text-gray-500">{swap.from_shift_time}</div>
        </div>
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[10px] text-gray-500">{t("portalSwapGets", "Gets")}</div>
          <div className="text-gray-900">{fmtSwapDay(swap.to_shift_date, lang)}</div>
          <div className="text-gray-500">{swap.to_shift_time}</div>
        </div>
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
function AbsenceSection({ token }) {
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
      reset(); setAdding(false); await load();
    } catch {
      setErr(t("fravaerSaveFailed", "Couldn't send — try again"));
    } finally { setSaving(false); }
  };

  const withdraw = async (g) => {
    try {
      await portalApi.post(`/portal/${token}/absence/withdraw`, { ids: g.ids });
      await load();
    } catch {
      setErr(t("fravaerWithdrawFailed", "Couldn't withdraw — try again"));
    }
  };

  const groups = groupAbsence(rows);

  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        {t("fravaerTitle", "Holiday & sick leave")}
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

/**
 * AvailabilityTab — staff-side "Kan ikke arbejde" (Planday-style unavailability).
 * A STANDING preference (recurring weekday or one-off date, all-day or a time
 * window) the owner sees while building the roster and the autopilot respects.
 * Honest: a soft signal, never a hidden hard block — the copy says so.
 */
function AvailabilityTab({ token }) {
  const { t, lang } = useLanguage();
  const [rows, setRows] = useState(null); // null = loading
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Add-form state
  const [mode, setMode] = useState("weekday"); // "weekday" | "date"
  const [weekday, setWeekday] = useState(0);
  const [dateVal, setDateVal] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("12:00");
  const [note, setNote] = useState("");

  // Monday-first short weekday names in the CHOSEN app language — no i18n keys.
  const WD = useMemo(() => {
    const base = new Date(Date.UTC(2026, 6, 6)); // 2026-07-06 is a Monday
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setUTCDate(base.getUTCDate() + i);
      return d.toLocaleDateString(localeFor(lang), { weekday: "short" });
    });
  }, [lang]);

  const load = async () => {
    try {
      const res = await portalApi.get(`/portal/${token}/availability`);
      setRows(res.data?.availability || []);
    } catch {
      setRows([]);
    }
  };
  useEffect(() => { load(); }, [token]);

  const resetForm = () => {
    setMode("weekday"); setWeekday(0); setDateVal("");
    setAllDay(true); setStartT("08:00"); setEndT("12:00"); setNote(""); setErr("");
  };

  const submit = async () => {
    setErr("");
    const body = { kind: "unavailable" };
    if (mode === "weekday") {
      body.weekday = weekday;
    } else {
      if (!dateVal) { setErr(t("kanIkkePickDate", "Pick a date")); return; }
      body.date = dateVal;
    }
    if (!allDay) {
      if (endT <= startT) { setErr(t("kanIkkeEndAfterStart", "End must be after start")); return; }
      body.start_time = startT;
      body.end_time = endT;
    }
    if (note.trim()) body.note = note.trim();
    setSaving(true);
    try {
      await portalApi.post(`/portal/${token}/availability`, body);
      resetForm(); setAdding(false); await load();
    } catch {
      setErr(t("kanIkkeSaveFailed", "Couldn't save — try again"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    setRows((r) => (r || []).filter((x) => x.id !== id)); // optimistic
    try {
      await portalApi.delete(`/portal/${token}/availability/${id}`);
    } catch {
      load(); // put it back if the delete really failed
    }
  };

  const describe = (row) => {
    const when = row.date
      ? new Date(row.date + "T00:00:00").toLocaleDateString(localeFor(lang), {
          weekday: "short", day: "numeric", month: "short",
        })
      : t("kanIkkeEveryWeekday", "Every {day}", { day: WD[row.weekday ?? 0] });
    const time = row.start_time
      ? `${row.start_time}–${row.end_time}`
      : t("kanIkkeAllDay", "All day");
    return { when, time };
  };

  return (
    <div className="space-y-4">
      {/* Ferie & sygdom — a request the owner approves. Grouped here (the
          staffer's "when I'm off" home) rather than an 8th nav tab. */}
      <AbsenceSection token={token} />

      <div className="h-px bg-gray-100" />

      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        {t("kanIkkeSectionLabel", "Can't work")}
      </div>
      {/* Honest soft-signal framing */}
      <p className="text-[13px] leading-relaxed text-gray-600">
        {t("kanIkkeIntro", "Mark the days or times you can't work. Your manager sees it while building the schedule.")}
      </p>

      {/* Existing blocks */}
      {rows === null ? (
        <div className="text-xs text-gray-500">{t("portalLoading", "Loading…")}</div>
      ) : rows.length === 0 && !adding ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white/60 p-6 text-center">
          <CalendarOff className="w-6 h-6 text-gray-300 mx-auto mb-2" strokeWidth={1.75} aria-hidden />
          <div className="text-sm text-gray-500">{t("kanIkkeEmpty", "Nothing marked yet.")}</div>
        </div>
      ) : (
        <div className="space-y-2">
          {(rows || []).map((row) => {
            const { when, time } = describe(row);
            return (
              <div key={row.id} className="rounded-xl bg-white border border-gray-200 p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                  <CalendarOff className="w-[18px] h-[18px] text-gray-500" strokeWidth={2} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-900 truncate">{when}</div>
                  <div className="text-[12px] text-gray-500 truncate">
                    {time}{row.note ? ` · ${row.note}` : ""}
                  </div>
                </div>
                <button
                  onClick={() => remove(row.id)}
                  className="w-8 h-8 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center transition shrink-0"
                  aria-label={t("kanIkkeRemove", "Remove")}
                >
                  <X className="w-4 h-4" strokeWidth={2} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add */}
      {!adding ? (
        <button
          onClick={() => { resetForm(); setAdding(true); }}
          className="w-full px-4 py-3 rounded-xl bg-gray-900 text-white hover:bg-gray-700 text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" strokeWidth={2.25} aria-hidden />
          {t("kanIkkeAdd", "Mark “can't work”")}
        </button>
      ) : (
        <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-4">
          {/* recurring vs one-off */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-gray-100 rounded-xl">
            {[["weekday", t("kanIkkeRecurring", "Weekly")], ["date", t("kanIkkeOneOff", "One date")]].map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => setMode(k)}
                className={`py-2 rounded-lg text-[13px] font-semibold transition ${mode === k ? "bg-white text-gray-900 shadow-soft" : "text-gray-500"}`}
              >
                {lbl}
              </button>
            ))}
          </div>

          {mode === "weekday" ? (
            <div className="flex gap-1.5">
              {WD.map((w, i) => (
                <button
                  key={i}
                  onClick={() => setWeekday(i)}
                  className={`flex-1 py-2 rounded-lg text-[12px] font-semibold capitalize transition ${weekday === i ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >
                  {w}
                </button>
              ))}
            </div>
          ) : (
            <input
              type="date"
              value={dateVal}
              onChange={(e) => setDateVal(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-gray-900/30"
            />
          )}

          {/* all-day vs window */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px] font-medium text-gray-700">{t("kanIkkeAllDayToggle", "All day")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={allDay}
              onClick={() => setAllDay(!allDay)}
              className={`relative w-11 h-6 rounded-full transition ${allDay ? "bg-gray-900" : "bg-gray-300"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${allDay ? "translate-x-5" : ""}`} />
            </button>
          </label>
          {!allDay && (
            <div className="flex items-center gap-2">
              <input type="time" value={startT} onChange={(e) => setStartT(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm outline-none focus:border-gray-900/30" />
              <span className="text-gray-400" aria-hidden>–</span>
              <input type="time" value={endT} onChange={(e) => setEndT(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm outline-none focus:border-gray-900/30" />
            </div>
          )}

          <input
            type="text"
            value={note}
            maxLength={80}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("kanIkkeNotePlaceholder", "Note (optional) — e.g. exam")}
            className="w-full px-3 py-2.5 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
          />

          {err && <div className="text-xs text-red-600">{err}</div>}

          <div className="flex gap-2">
            <button
              onClick={() => { setAdding(false); resetForm(); }}
              className="flex-1 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition"
            >
              {t("portalCancel", "Cancel")}
            </button>
            <button
              onClick={submit}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700 transition disabled:opacity-50"
            >
              {saving ? t("portalSaving", "Saving…") : t("kanIkkeSave", "Save")}
            </button>
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
  { key: "tips", Icon: Banknote, labelKey: "navTips", labelFallback: "Tips" },
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

          {/* iOS Safari — guide the Share → Add to Home Screen flow */}
          {!installed && !installPrompt && isIOS && (
            <div className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[12px] text-gray-600">
              <span>{t("staffInstallIosA", "Tap")}</span>
              <Share className="w-4 h-4 text-gray-900 shrink-0" strokeWidth={2} aria-hidden />
              <span>{t("staffInstallIosB", 'then "Add to Home Screen"')}</span>
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
  const [tab, setTab] = useState(() => {
    // Honor ?tab= so the installed-app shortcuts (Schedule / Hours / Tips) and
    // any deep link open the right tab.
    try {
      const q = new URLSearchParams(window.location.search).get("tab");
      return ["schedule", "availability", "messages", "swaps", "hours", "tips", "alerts"].includes(q) ? q : "schedule";
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
  const [hoursData, setHoursData] = useState(null);
  const [tipsData, setTipsData] = useState(null);
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
  // covers instant schedule pushes; the poll then only keeps hours/tips fresh).
  const [liveConnected, setLiveConnected] = useState(false);

  // Email & phone editing
  const [showEmailEdit, setShowEmailEdit] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMsg, setEmailMsg] = useState("");
  const [emailStatus, setEmailStatus] = useState(null); // "ok" | "err"

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
    ]).then(([sched, team, open]) => {
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
    });

    // Hours
    portalApi.get(`/portal/${token}/hours`).then((res) => {
      setHoursData(res.data);
    }).catch(() => {});

    // Tips
    portalApi.get(`/portal/${token}/tips`).then((res) => {
      setTipsData(res.data);
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

  // Tips is OPTIONAL — a business that doesn't share tips (e.g. no salary/tip
  // distribution) simply never sees the tab, so it's never an empty promise.
  // If a deep-link (?tab=tips) lands on a staffer with no tip data, fall back
  // to the schedule rather than show an empty "My tips".
  useEffect(() => {
    if (tab === "tips" && tipsData && !(tipsData.entries?.length > 0)) {
      setTab("schedule");
    }
  }, [tab, tipsData]);

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
    return <PinGate token={token} staffName={info.staff_name} onVerified={() => setPinVerified(true)} />;
  }

  const handleContactSave = async () => {
    setEmailSaving(true);
    setEmailMsg("");
    setEmailStatus(null);
    try {
      const res = await portalApi.put(`/portal/${token}/email`, { email: emailInput.trim(), phone: phoneInput.trim() });
      setInfo({ ...info, email: res.data.email, phone: res.data.phone });
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
      {/* Header — sticks to the top of the internal scroller. */}
      <div className="sticky top-0 z-10 glass border-b border-gray-200/70 pt-[env(safe-area-inset-top)]">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">
              {tab === "schedule" ? t("portalTitleSchedule", "My schedule")
                : tab === "availability" ? t("portalTitleKanIkke", "Availability")
                : tab === "messages" ? t("portalTitleMessages", "Messages")
                : tab === "swaps" ? t("portalTitleSwaps", "Swaps")
                : tab === "hours" ? t("portalTitleHours", "My hours")
                : tab === "tips" ? t("portalTitleTips", "My tips")
                : t("portalTitleAlerts", "Alerts")}
            </h1>
            {info?.restaurant_name && (
              <div className="text-[11px] text-gray-500">{info.restaurant_name}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* DA / EN toggle — staff pick their language. Danish phones
                already default to da via browser detection; this lets an
                English-phone staffer at a DK workplace switch, and back. */}
            {/* Per-button rounding (not container overflow-hidden) so the
                invisible before: hit-halo isn't clipped — visual size is
                unchanged, but the tap target clears ~44px vertically. */}
            <div className="flex rounded-lg border border-gray-200 text-[11px] font-semibold" role="group" aria-label={t("portalLangLabel", "Language")}>
              {["da", "en"].map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLang(code)}
                  aria-pressed={lang === code}
                  className={`relative px-2 py-1 transition active:scale-[0.98] before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-[''] ${
                    code === "da" ? "rounded-l-[7px]" : "rounded-r-[7px]"
                  } ${
                    lang === code
                      ? "bg-gray-900 text-white"
                      : "bg-white text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
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
              onClick={() => { setShowEmailEdit(!showEmailEdit); setEmailInput(info?.email || ""); setPhoneInput(info?.phone || ""); setEmailMsg(""); setEmailStatus(null); }}
              className="relative w-9 h-9 rounded-full bg-gray-100 border border-gray-200 shadow-soft flex items-center justify-center text-sm font-bold text-gray-700 active:scale-[0.98] transition before:absolute before:-inset-2 before:content-['']"
              title={t("portalEditContact", "Edit email")}
            >
              {info?.staff_name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
            </button>
          </div>
        </div>
        {/* Email edit panel */}
        {showEmailEdit && (
          <div className="max-w-lg mx-auto px-4 pb-3">
            <div className="rounded-xl bg-white border border-gray-200 p-3 space-y-3">
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
                <label className="text-[10px] text-gray-500 mb-1 block">{t("portalContactPhoneLabel", "Phone (for WhatsApp)")}</label>
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="+45 12 34 56 78"
                  className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                />
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
        )}
      </div>

      {/* Content */}
      <div className="max-w-lg mx-auto px-4 py-4">
        {tab === "schedule" && (
          <ScheduleTab
            shifts={shifts}
            teamShifts={teamShifts}
            openShifts={openShifts}
            staffName={info?.staff_name}
            token={token}
            restaurantName={info?.restaurant_name}
            onShiftsChanged={loadData}
            onNeedChange={() => setTab("swaps")}
          />
        )}
        {/* Install/push nudge — BELOW the shift so the schedule leads; a calm
            collapsed line, not a promo card above the fold. */}
        {/* Inside the native Scheduler shell "add to home screen" is
            nonsense — the user IS in the app. Native push arrives with the
            APNs slice; until then the card simply doesn't render there. */}
        {tab === "schedule" && !isNativeApp() && <InstallNotifyCard token={token} />}
        {tab === "availability" && <AvailabilityTab token={token} />}
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
        {tab === "tips" && (tipsData?.entries?.length || 0) > 0 && <TipsTab data={tipsData} />}
        {tab === "alerts" && <AlertsTab token={token} staffName={info?.staff_name} />}
      </div>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 glass border-t border-gray-200/70 z-20">
        <div className="max-w-lg mx-auto flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {TABS.filter(
            (item) => item.key !== "tips" || (tipsData?.entries?.length || 0) > 0,
          ).map((item) => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                aria-current={active ? "page" : undefined}
                className={`relative flex flex-col items-center gap-0.5 px-1.5 sm:px-4 py-1 rounded-lg transition-colors active:opacity-60 ${
                  active ? "" : "text-gray-400"
                }`}
                style={active ? { color: "rgb(var(--brand-600))" } : undefined}
              >
                <span className="relative">
                  {/* Soft --brand lozenge hugging ONLY the icon — the portal's
                      one recurring, deliberate touch of colour. Scoped to the
                      icon so it never slices through the label below. */}
                  {active && (
                    <span
                      aria-hidden
                      className="absolute -inset-x-3.5 -inset-y-[3px] rounded-full"
                      style={{ background: "rgb(var(--brand-50))" }}
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
