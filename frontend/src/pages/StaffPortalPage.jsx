/**
 * Staff Portal — what your staff sees when they open their magic link.
 * Mobile-first, dark theme, no login required.
 * Route: /s/:token
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { RefreshCw, CloudOff, Download, Smartphone, Share, Check, X, Calendar, ArrowLeftRight, Clock, Banknote, Bell } from "lucide-react";
import portalApi from "../services/portalApi";
import { useLanguage } from "../hooks/useLanguage";


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

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(d) {
  const dt = new Date(d + "T00:00:00");
  return `${DAYS[dt.getDay() === 0 ? 6 : dt.getDay() - 1]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}

function fmtShort(d) {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
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

// Roles are identity, not status — they render as neutral gray text. Color is
// reserved for status only (emerald=live, amber=warn, red=error) per the
// locked design system; a per-role rainbow + emoji read as "vibecoded".
const ROLE_STYLE = { bg: "bg-gray-100", text: "text-gray-600", icon: "" };

function getRoleStyle() {
  return ROLE_STYLE;
}


// ─── PIN Gate ─────────────────────────────────────────────────────────────

function PinGate({ onVerified, token, staffName }) {
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
      await portalApi.post(`/portal/${token}/verify-pin`, { pin: code });
      onVerified();
    } catch {
      setError("Wrong PIN. Try again.");
      setPin(["", "", "", ""]);
      document.getElementById("pin-0")?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-xs text-center">
        <div className="w-16 h-16 bg-gray-100 border border-gray-200 rounded-xl flex items-center justify-center mx-auto mb-4">
          <span className="text-3xl">🔐</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-1">Enter PIN</h1>
        <p className="text-sm text-gray-500 mb-8">Hi {staffName}, enter your 4-digit PIN</p>
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
        {loading && <p className="text-gray-500 text-sm">Verifying...</p>}
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
      setError(err.response?.data?.detail || "Couldn't send. Try again.");
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
        🤒 Call in sick
      </button>
    );
  }

  // 14-day forward window matches the backend MAX_FUTURE_DAYS soft cap;
  // backend allows up to 60 but most call-ins are same-day or near.
  const maxIso = toLocalISO(addDaysToDate(new Date(), 14));

  return (
    <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-gray-900 text-sm">🤒 Call in sick</div>
        <button
          onClick={() => { setOpen(false); setError(""); setReason(""); }}
          className="text-gray-500 hover:text-gray-700 text-lg leading-none w-6 h-6 flex items-center justify-center"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">Which day?</label>
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
            Shift: {matchingShift.start_time} – {matchingShift.end_time}
          </div>
        )}
      </div>
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">
          Reason <span className="text-gray-400">(optional, only your owner sees this)</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="e.g. fever 39C, doctor advised rest"
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
        {submitting ? "Sending..." : "Send sick call"}
      </button>
      <div className="text-[10px] text-gray-400 text-center leading-snug">
        Your owner will be notified. They can assign someone to cover.
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
function ConfirmScheduleButton({ token, shifts, onConfirmed }) {
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
      const n = res?.data?.confirmed_count ?? 0;
      setFeedback(n > 0 ? `✓ ${n} shift${n === 1 ? "" : "s"} confirmed` : "✓ Already confirmed");
      onConfirmed?.();
      setTimeout(() => setFeedback(""), 4000);
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't confirm. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (allConfirmed) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 flex items-center gap-2">
        <span aria-hidden className="text-emerald-400">✓</span>
        <span className="font-medium">You've confirmed this schedule. Thanks!</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 flex items-center justify-between gap-3">
      <div className="text-sm text-gray-700">
        <div className="font-medium text-gray-900">Got the schedule?</div>
        <div className="text-[12px] text-gray-500">Tap to let your owner know you've seen it.</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {feedback && (
          <span className="text-[12px] text-emerald-400 whitespace-nowrap" role="status">
            {feedback}
          </span>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white text-sm font-semibold disabled:opacity-50 transition"
        >
          {submitting ? "…" : "I've got it"}
        </button>
      </div>
      {error && (
        <span className="text-[12px] text-red-400 ml-2">{error}</span>
      )}
    </div>
  );
}


function ScheduleTab({ shifts: rawShifts, staffName, token, onShiftsChanged }) {
  const { t } = useLanguage();
  // Defense-in-depth: the portal API already filters to published shifts
  // (get_portal_schedule), but never render a draft even if one ever slips
  // through — the owner's Publish action is the single source of truth for
  // what staff see, and the "This week" hours KPI must exclude drafts.
  const shifts = (rawShifts || []).filter((s) => s && s.status === "published");
  const today = toLocalISO(new Date());
  const weekStart = getWeekStart(today);

  // Group shifts by week
  const thisWeek = [];
  const nextWeek = [];
  const later = [];

  const nextWeekStart = addDays(weekStart, 7);
  const laterStart = addDays(weekStart, 14);

  // Build all 7 days for current week (show OFF days too)
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const shift = shifts.find((s) => s.date === d);
    thisWeek.push({ date: d, shift });
  }

  // Build next week
  for (let i = 0; i < 7; i++) {
    const d = addDays(nextWeekStart, i);
    const shift = shifts.find((s) => s.date === d);
    nextWeek.push({ date: d, shift });
  }

  // Anything beyond
  shifts
    .filter((s) => s.date >= laterStart)
    .forEach((s) => later.push({ date: s.date, shift: s }));

  // KPIs
  const thisWeekShifts = shifts.filter((s) => s.date >= weekStart && s.date < nextWeekStart);
  const thisWeekHours = thisWeekShifts.reduce((a, s) => a + s.net_hours, 0);

  // Next shift
  const upcoming = shifts.filter((s) => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const nextShift = upcoming[0];

  const nextShiftRole = nextShift?.role_on_shift || "Staff";

  return (
    <div className="space-y-4">
      {/* HERO — the single most-glanceable thing: your next shift. Largest
          type on the screen, gray-900. Day + time + role + hours. */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
          {t("portalNextShiftHero")}
        </div>
        {nextShift ? (
          <>
            <div className="text-3xl font-bold text-gray-900 leading-tight">
              {isToday(nextShift.date) ? t("portalToday") : fmtDate(nextShift.date)}
            </div>
            <div className="mt-1 text-lg font-semibold text-gray-900">
              {nextShift.start_time} – {nextShift.end_time}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[13px] text-gray-500">
              <span>{nextShiftRole}</span>
              <span aria-hidden>·</span>
              <span>{nextShift.net_hours} {t("portalHrsShort")}</span>
            </div>
          </>
        ) : (
          <div className="text-2xl font-bold text-gray-400">{t("portalNoUpcomingShift")}</div>
        )}
      </div>

      {/* This week hrs KPI (kept, but no longer the headline). */}
      <div className="grid grid-cols-1 gap-3">
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="text-[11px] text-gray-500 mb-1">{t("portalThisWeek")}</div>
          <div className="text-2xl font-bold text-gray-900">{thisWeekHours} <span className="text-sm text-gray-500">{t("portalHrsShort")}</span></div>
          <div className="text-[11px] text-gray-500">{thisWeekShifts.length} {t("portalShiftsCount")}</div>
        </div>
      </div>

      {/* Sick-call self-service. Sits between KPIs and the schedule
          so it's visible at-a-glance but doesn't fight for attention
          with the actual shift list. token + onShiftsChanged are
          passed in from the parent page. */}
      {token && (
        <SickCallButton
          token={token}
          upcomingShifts={upcoming}
          onCalledIn={onShiftsChanged}
        />
      )}

      {/* Bidirectional confirmation — staff taps "I've got it" to ack
          the published schedule. Owner's dashboard reads aggregate
          counts via /staff/schedule-confirmation-summary. Idempotent;
          re-tap is a calm no-op. */}
      {token && (
        <ConfirmScheduleButton
          token={token}
          shifts={shifts}
          onConfirmed={onShiftsChanged}
        />
      )}

      {/* This week */}
      <div>
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
          This week — {fmtShort(weekStart)} – {fmtShort(addDays(weekStart, 6))}
        </div>
        <div className="space-y-1.5">
          {thisWeek.map(({ date: d, shift }) => (
            <ShiftRow key={d} date={d} shift={shift} />
          ))}
        </div>
      </div>

      {/* Next week */}
      <div>
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Next week — {fmtShort(nextWeekStart)} – {fmtShort(addDays(nextWeekStart, 6))}
        </div>
        <div className="space-y-1.5">
          {nextWeek.map(({ date: d, shift }) => (
            <ShiftRow key={d} date={d} shift={shift} />
          ))}
        </div>
      </div>

      {later.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Coming up</div>
          <div className="space-y-1.5">
            {later.map(({ date: d, shift }) => (
              <ShiftRow key={d} date={d} shift={shift} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShiftRow({ date: d, shift }) {
  const dt = new Date(d + "T00:00:00");
  const dayName = DAYS[dt.getDay() === 0 ? 6 : dt.getDay() - 1];
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
          <div className="text-sm text-gray-400">OFF</div>
        </div>
      </div>
    );
  }

  const role = getRoleStyle(shift.role_on_shift);

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white border border-gray-200 ${past && !today ? "opacity-50" : ""} ${today ? "border-gray-500/40 bg-white" : ""}`}>
      <div className="w-10 text-center">
        <div className="text-[10px] font-semibold text-gray-500">{dayName}</div>
        <div className={`text-sm font-bold ${today ? "text-gray-900" : "text-gray-900"}`}>{dayNum}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900">{shift.start_time} – {shift.end_time}</div>
        <div className="text-[11px] text-gray-500">{shift.role_on_shift || "Staff"}</div>
      </div>
      <div>
        {today ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-gray-100 border border-gray-200 text-gray-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Today
          </span>
        ) : past ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-gray-100 border border-gray-200 text-gray-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Done
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
  if (!data) return <LoadingSkeleton />;

  const pct = maxHours && maxHours > 0 ? Math.min(100, (data.total_hours / maxHours) * 100) : null;
  const remaining = maxHours ? Math.max(0, maxHours - data.total_hours) : null;

  return (
    <div className="space-y-4">
      {/* Period info */}
      <div className="text-[11px] text-gray-500 flex items-center gap-2">
        <span>Period: {fmtShort(data.period_start)} – {fmtShort(data.period_end)}</span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="text-[11px] text-gray-500 mb-1">Hours worked</div>
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
                <div className={`text-[10px] mt-1 ${remaining <= 5 ? "text-red-400" : "text-amber-400"}`}>
                  ⚠️ {remaining} hrs remaining
                </div>
              )}
            </>
          )}
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="text-[11px] text-gray-500 mb-1">Shifts logged</div>
          <div className="text-2xl font-bold text-gray-900">{data.entries.length}</div>
          <div className="text-[11px] text-gray-500">this period</div>
        </div>
      </div>

      {/* Hours warning for work permits */}
      {maxHours && remaining !== null && remaining <= 10 && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-[12px] text-amber-300">
          <strong>⚠️ Work permit limit</strong>
          <p className="mt-0.5 text-amber-400/80">You have {remaining} hours remaining this period.</p>
        </div>
      )}

      {/* Recent shifts */}
      <div>
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Recent shifts</div>
        <div className="space-y-1.5">
          {data.entries.length === 0 && (
            <div className="text-sm text-gray-400 py-4 text-center">No hours logged yet this period</div>
          )}
          {data.entries.map((h, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white border border-gray-200">
              <span className="text-sm text-gray-500">
                {fmtDate(h.date)} {h.start_time && h.end_time ? `· ${h.start_time}-${h.end_time}` : ""}
              </span>
              <span className="text-sm font-semibold text-gray-900">{h.total_hours} hrs</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


// ─── Tips Tab ─────────────────────────────────────────────────────────────

function TipsTab({ data }) {
  if (!data) return <LoadingSkeleton />;

  const avgPerShift = data.entries.length > 0 ? (data.total_tips_30d / data.entries.length) : 0;
  const lastTip = data.entries[0];

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="text-[10px] text-gray-500 mb-1">Last 30 days</div>
          <div className="text-lg font-bold text-gray-700">{Math.round(data.total_tips_30d).toLocaleString()}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="text-[10px] text-gray-500 mb-1">Last shift</div>
          <div className="text-lg font-bold text-gray-900">{lastTip ? Math.round(lastTip.amount) : "—"}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <div className="text-[10px] text-gray-500 mb-1">Avg / shift</div>
          <div className="text-lg font-bold text-gray-900">{Math.round(avgPerShift)}</div>
        </div>
      </div>

      {/* Tip history */}
      <div>
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Tip history</div>
        <div className="space-y-1.5">
          {data.entries.length === 0 && (
            <div className="text-sm text-gray-400 py-4 text-center">No tips recorded yet</div>
          )}
          {data.entries.map((t, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white border border-gray-200">
              <span className="text-sm text-gray-500">{fmtDate(t.date)}</span>
              {t.share_pct && <span className="text-[11px] text-gray-400">{t.share_pct.toFixed(1)}% share</span>}
              <span className="text-sm font-semibold text-gray-700">{Math.round(t.amount)} DKK</span>
            </div>
          ))}
        </div>
      </div>

      {data.entries.length > 0 && (
        <div className="text-center text-[11px] text-gray-400">
          Split method: {data.entries[0]?.split_method === "by_hours" ? "By hours worked" : data.entries[0]?.split_method || "—"}
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
          className="w-full px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          🔄 Offer to swap a shift
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
      {inbox === null && <div className="text-xs text-gray-500">Loading…</div>}
      {inbox && inbox.length === 0 && !showPropose && (
        <div className="text-center text-xs text-gray-500 py-6">
          No pending swap requests.
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
function SwapRow({ swap, token, onChanged }) {
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

  const statusPill = swap.status === "proposed"
    ? "bg-amber-500/20 text-amber-300"
    : swap.status === "accepted"
      ? "bg-gray-100 border border-gray-200 text-gray-700"
      : "bg-gray-500/20 text-gray-400";

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide font-medium text-gray-500">
          {swap.direction === "outgoing" ? "Outgoing" : "Incoming"}
        </span>
        <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${statusPill}`}>
          {swap.status}
        </span>
      </div>
      <div className="text-sm text-gray-900">
        <span className="font-semibold">{swap.from_staff_name}</span>
        <span className="text-gray-500"> → </span>
        <span className="font-semibold">{swap.to_staff_name}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[10px] text-gray-500">Gives</div>
          <div className="text-gray-900">{swap.from_shift_date}</div>
          <div className="text-gray-500">{swap.from_shift_time}</div>
        </div>
        <div className="bg-gray-50 rounded p-1.5">
          <div className="text-[10px] text-gray-500">Gets</div>
          <div className="text-gray-900">{swap.to_shift_date}</div>
          <div className="text-gray-500">{swap.to_shift_time}</div>
        </div>
      </div>
      {swap.reason && (
        <div className="text-[11px] text-gray-500 italic">"{swap.reason}"</div>
      )}
      {swap.owner_note && (
        <div className="text-[11px] text-gray-500">
          <span className="text-gray-500">Owner:</span> {swap.owner_note}
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
            Accept
          </button>
          <button
            onClick={() => respond(false)}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 disabled:opacity-50"
          >
            Decline
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
            Withdraw
          </button>
        </div>
      )}
      {swap.status === "accepted" && (
        <div className="text-[11px] text-gray-700 pt-1">
          ✓ Both staff agreed — awaiting owner approval
        </div>
      )}
    </div>
  );
}


/** Modal for proposing a new swap. Pulls the team's upcoming shifts
 * via /portal/{token}/team-schedule and the staff's own from a prop. */
function SwapProposeModal({ token, ownShifts, onClose, onProposed }) {
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
      setError(err.response?.data?.detail || "Couldn't propose. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl bg-white border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-gray-900 text-sm">🔄 Offer to swap</div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700 text-lg w-6 h-6 flex items-center justify-center"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">
          Your shift to give up
        </label>
        <select
          value={fromShiftId}
          onChange={(e) => { setFromShiftId(e.target.value); setToShiftId(""); }}
          className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-gray-900"
        >
          <option value="">Pick one of your shifts…</option>
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
            Teammate's shift you'd take in exchange
          </label>
          <select
            value={toShiftId}
            onChange={(e) => setToShiftId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 outline-none focus:border-gray-900"
          >
            <option value="">Pick a teammate's shift…</option>
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
          Reason <span className="text-gray-400">(optional)</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="e.g. family wedding, doctor appt"
          className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900 resize-none"
        />
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <button
        onClick={submit}
        disabled={submitting || !fromShiftId || !toShiftId}
        className="w-full px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition disabled:opacity-50"
      >
        {submitting ? "Sending..." : "Send swap request"}
      </button>
      <div className="text-[10px] text-gray-400 text-center leading-snug">
        Your teammate will see this in their inbox. If they accept, your owner approves.
      </div>
    </div>
  );
}


// ─── Alerts Tab ──────────────────────────────────────────────────────────

function AlertsTab({ token, staffName }) {
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
    schedule_published: { icon: "📅", label: "Schedule published" },
    shift_changed: { icon: "🔄", label: "Shift changed" },
    shift_deleted: { icon: "❌", label: "Shift cancelled" },
  };

  const CHANNEL_ICONS = {
    email: "📧",
    push: "🔔",
    whatsapp: "💬",
  };

  if (!notifications || notifications.length === 0) {
    return (
      <div className="space-y-4">
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🔔</div>
          <h3 className="text-base font-semibold text-gray-900 mb-1">No notifications yet</h3>
          <p className="text-sm text-gray-500">
            You'll see shift reminders, schedule updates, and tip notifications here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
        Recent notifications
      </div>
      <div className="space-y-1.5">
        {notifications.map((n) => {
          const evt = EVENT_ICONS[n.event_type] || { icon: "🔔", label: n.event_type };
          const channelIcon = CHANNEL_ICONS[n.channel] || "🔔";
          const timeAgo = n.created_at ? formatTimeAgo(n.created_at) : "";
          return (
            <div key={n.id} className="flex items-start gap-3 px-3 py-3 rounded-xl bg-white border border-gray-200">
              <div className="text-lg mt-0.5">{evt.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900">{n.subject || evt.label}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-gray-500">{channelIcon} {n.channel}</span>
                  <span className="text-[11px] text-gray-400">{timeAgo}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTimeAgo(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
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
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <div className="text-4xl mb-3">😕</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Link not working</h1>
        <p className="text-sm text-gray-500">{message || "This link may have expired or been deactivated. Ask your manager for a new one."}</p>
      </div>
    </div>
  );
}


// ─── Main Portal Page ─────────────────────────────────────────────────────

const TABS = [
  { key: "schedule", Icon: Calendar, labelKey: "navSchedule", labelFallback: "Schedule" },
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
    <div className="mb-4 rounded-xl bg-white border border-gray-200 p-4 relative">
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("dismiss", "Dismiss")}
        className="absolute top-2.5 right-2.5 text-gray-400 hover:text-gray-600"
      >
        <X className="w-4 h-4" strokeWidth={2} aria-hidden />
      </button>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-gray-900 flex items-center justify-center shrink-0">
          <Smartphone className="w-5 h-5 text-white" strokeWidth={2} aria-hidden />
        </div>
        <div className="flex-1 min-w-0 pr-4">
          <div className="text-sm font-bold text-gray-900">
            {t("staffInstallTitle", "Keep your schedule one tap away")}
          </div>
          <div className="text-[12px] text-gray-500 mt-0.5 leading-relaxed">
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
              className="mt-3 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold bg-gray-900 text-white hover:bg-gray-700 transition"
            >
              <Download className="w-4 h-4" strokeWidth={2} aria-hidden />
              {t("staffInstallBtn", "Install app")}
            </button>
          )}

          {/* iOS Safari — guide the Share → Add to Home Screen flow */}
          {!installed && !installPrompt && isIOS && (
            <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[12px] text-gray-600">
              <span>{t("staffInstallIosA", "Tap")}</span>
              <Share className="w-4 h-4 text-gray-900 shrink-0" strokeWidth={2} aria-hidden />
              <span>{t("staffInstallIosB", 'then "Add to Home Screen"')}</span>
            </div>
          )}

          {/* Installed — confirm it's set up */}
          {installed && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-700">
              <Check className="w-4 h-4" strokeWidth={2.5} aria-hidden />
              {t("staffInstalledLabel", "App installed")}
            </div>
          )}

          <div className="mt-3">
            <StaffPushOptIn token={token} />
          </div>
        </div>
      </div>
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
          : err?.response?.data?.detail || t("staffPushEnableFailed", "Couldn't enable push. Try again.");
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
      setError(err?.response?.data?.detail || t("staffPushDisableFailed", "Couldn't disable push."));
    } finally {
      setBusy(false);
    }
  };

  // Bail-outs (see visibility cascade in docstring).
  if (!supported) return null;
  if (iosNotInstalled) {
    return (
      <div className="rounded-lg bg-white border border-gray-200 p-3 text-[11px] text-gray-500 leading-relaxed">
        <div className="font-semibold text-gray-700 mb-1">
          📲 {t("staffPushIosInstallTitle", "Get push notifications")}
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
          <div className="font-semibold text-gray-900">
            🔔 {t("staffPushOnTitle", "Push notifications on")}
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
      <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-[11px] text-amber-200 leading-relaxed">
        <div className="font-semibold mb-1">🔕 {t("staffPushBlockedTitle", "Push blocked")}</div>
        {t("staffPushBlockedHint", "Notifications are blocked in your browser settings. Re-enable them in Settings → Notifications → BonBox to get a tap when your shifts change.")}
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white border border-gray-200 p-3 space-y-2">
      <div className="text-[11px] text-gray-700">
        <div className="font-semibold text-gray-900">
          🔔 {t("staffPushOffTitle", "Get push notifications")}
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

  // Live — the realtime stream is open, so changes land instantly. A subtle
  // pulsing dot signals it without shouting. Only shown when truly connected
  // (honest: never imply "live" when we're actually polling).
  if (live) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-[11px] font-medium text-emerald-700"
        title={t("portalLive")}
        aria-label={t("portalLive")}
      >
        <span className="relative flex w-1.5 h-1.5" aria-hidden>
          <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
          <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-500" />
        </span>
        {t("portalLive")}
      </button>
    );
  }

  if (isFresh) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-[11px] font-medium text-emerald-700"
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
  const { t } = useLanguage();
  const [tab, setTab] = useState(() => {
    // Honor ?tab= so the installed-app shortcuts (Schedule / Hours / Tips) and
    // any deep link open the right tab.
    try {
      const q = new URLSearchParams(window.location.search).get("tab");
      return ["schedule", "swaps", "hours", "tips", "alerts"].includes(q) ? q : "schedule";
    } catch {
      return "schedule";
    }
  });
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pinVerified, setPinVerified] = useState(false);

  // Data for each tab
  const [shifts, setShifts] = useState([]);
  const [hoursData, setHoursData] = useState(null);
  const [tipsData, setTipsData] = useState(null);

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

  // 1. Validate token on mount
  useEffect(() => {
    portalApi.get(`/portal/${token}`)
      .then((res) => {
        setInfo(res.data);
        // If no PIN, auto-verify
        if (!res.data.has_pin) setPinVerified(true);
        setLoading(false);
        // Remember this as the staff's portal so an INSTALLED app icon
        // (which launches to "/") can redirect straight back here instead
        // of the owner login. See PublicOrDashboard in App.jsx.
        try { localStorage.setItem("bonbox_portal_token", token); } catch { /* private mode */ }
      })
      .catch((err) => {
        setError(err.response?.data?.detail || "Link not found");
        setLoading(false);
      });
  }, [token]);

  // 2. Load data once verified
  const loadData = useCallback(() => {
    // Schedule — the freshness source of truth. On success we stamp
    // lastSynced (drives the "Synced" pill) and diff the published shifts
    // against the last-rendered signature to decide whether to toast.
    portalApi.get(`/portal/${token}/schedule`).then((res) => {
      const nextShifts = res.data.shifts || [];
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
    }).catch(() => {
      // Fail honest: do NOT advance lastSynced on a failed fetch, so the pill
      // keeps showing the real last-good time (or Offline) rather than lying.
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

  // Per-staff PWA manifest + iOS home-screen name. Point <link rel="manifest">
  // at THIS staff's manifest (served same-origin via a Vercel rewrite → backend)
  // so an Android/Chrome install opens to their schedule and is named after the
  // restaurant — not the generic owner app. iOS ignores the manifest for
  // Add-to-Home, so we also set apple-mobile-web-app-title to the restaurant
  // name. Both restore on unmount (the owner app uses the global values).
  useEffect(() => {
    if (!token || typeof document === "undefined") return;
    const link = document.querySelector('link[rel="manifest"]');
    const prevHref = link?.getAttribute("href");
    if (link) link.setAttribute("href", `/portal/${token}/app.webmanifest`);
    const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    const prevApple = apple?.getAttribute("content");
    if (apple && info?.restaurant_name) apple.setAttribute("content", info.restaurant_name);
    return () => {
      if (link && prevHref) link.setAttribute("href", prevHref);
      if (apple && prevApple) apple.setAttribute("content", prevApple);
    };
  }, [token, info]);

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
    try {
      const res = await portalApi.put(`/portal/${token}/email`, { email: emailInput.trim(), phone: phoneInput.trim() });
      setInfo({ ...info, email: res.data.email, phone: res.data.phone });
      setEmailMsg("Saved!");
      setTimeout(() => { setEmailMsg(""); setShowEmailEdit(false); }, 1500);
    } catch (err) {
      setEmailMsg(err.response?.data?.detail || "Failed to save");
    } finally {
      setEmailSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur-xl border-b border-gray-200 pt-[env(safe-area-inset-top)]">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">
              {tab === "schedule" ? t("portalTitleSchedule", "My schedule")
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
              onClick={() => { setShowEmailEdit(!showEmailEdit); setEmailInput(info?.email || ""); setPhoneInput(info?.phone || ""); setEmailMsg(""); }}
              className="w-9 h-9 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-sm font-bold text-gray-700"
              title="Edit email"
            >
              {info?.staff_name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
            </button>
          </div>
        </div>
        {/* Email edit panel */}
        {showEmailEdit && (
          <div className="max-w-lg mx-auto px-4 pb-3">
            <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-3">
              <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold">Notifications</div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Email</label>
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Phone (for WhatsApp)</label>
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
                {emailSaving ? "Saving..." : "Save"}
              </button>
              {emailMsg && (
                <div className={`text-xs ${emailMsg === "Saved!" ? "text-gray-700" : "text-red-400"}`}>{emailMsg}</div>
              )}
              <div className="text-[10px] text-gray-400">
                {info?.email || info?.phone
                  ? `${info.email ? "📧 " + info.email : ""}${info.email && info.phone ? " · " : ""}${info.phone ? "📱 " + info.phone : ""}`
                  : "Add your email or phone to get notified when your schedule changes."}
              </div>
              {/* Native Web Push opt-in moved to the prominent
                  InstallNotifyCard on the Schedule tab — far better
                  discovery than buried behind the avatar. */}
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="max-w-lg mx-auto px-4 py-4">
        {tab === "schedule" && <InstallNotifyCard token={token} />}
        {tab === "schedule" && (
          <ScheduleTab
            shifts={shifts}
            staffName={info?.staff_name}
            token={token}
            onShiftsChanged={loadData}
          />
        )}
        {tab === "swaps" && (
          <SwapTab token={token} ownShifts={shifts} onChanged={loadData} />
        )}
        {tab === "hours" && <HoursTab data={hoursData} maxHours={info?.max_hours_month} />}
        {tab === "tips" && <TipsTab data={tipsData} />}
        {tab === "alerts" && <AlertsTab token={token} staffName={info?.staff_name} />}
      </div>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-xl border-t border-gray-200 z-20">
        <div className="max-w-lg mx-auto flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              aria-current={tab === item.key ? "page" : undefined}
              className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors ${
                tab === item.key ? "text-gray-900" : "text-gray-400"
              }`}
            >
              <item.Icon className="w-[18px] h-[18px]" strokeWidth={2} aria-hidden />
              <span className="text-[10px] font-semibold">{t(item.labelKey, item.labelFallback)}</span>
            </button>
          ))}
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
            className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-medium shadow-lg"
          >
            <RefreshCw className="w-4 h-4" strokeWidth={2} aria-hidden />
            {t("portalScheduleUpdated")}
          </button>
        </div>
      )}
    </div>
  );
}
