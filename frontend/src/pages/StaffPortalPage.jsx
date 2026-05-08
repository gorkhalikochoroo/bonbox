/**
 * Staff Portal — what your staff sees when they open their magic link.
 * Mobile-first, dark theme, no login required.
 * Route: /s/:token
 */
import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import portalApi from "../services/portalApi";

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

const ROLE_COLORS = {
  bartender: { bg: "bg-amber-500/15", text: "text-amber-400", icon: "🍺" },
  server: { bg: "bg-blue-500/15", text: "text-blue-400", icon: "🍽" },
  cook: { bg: "bg-red-500/15", text: "text-red-400", icon: "👨‍🍳" },
  chef: { bg: "bg-red-500/15", text: "text-red-400", icon: "👨‍🍳" },
  manager: { bg: "bg-purple-500/15", text: "text-purple-400", icon: "📋" },
  cleaner: { bg: "bg-teal-500/15", text: "text-teal-400", icon: "🧹" },
  host: { bg: "bg-pink-500/15", text: "text-pink-400", icon: "🎙" },
  default: { bg: "bg-gray-500/15", text: "text-gray-400", icon: "👤" },
};

function getRoleStyle(role) {
  return ROLE_COLORS[(role || "").toLowerCase()] || ROLE_COLORS.default;
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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-xs text-center">
        <div className="w-16 h-16 bg-green-500/15 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <span className="text-3xl">🔐</span>
        </div>
        <h1 className="text-xl font-bold text-white mb-1">Enter PIN</h1>
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
              className="w-14 h-14 text-center text-2xl font-bold bg-white/5 border border-white/10 rounded-xl text-white focus:border-green-500 focus:ring-2 focus:ring-green-500/30 outline-none"
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
        className="w-full px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-sm font-medium text-gray-200 transition flex items-center justify-center gap-2"
      >
        🤒 Call in sick
      </button>
    );
  }

  // 14-day forward window matches the backend MAX_FUTURE_DAYS soft cap;
  // backend allows up to 60 but most call-ins are same-day or near.
  const maxIso = toLocalISO(addDaysToDate(new Date(), 14));

  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-white text-sm">🤒 Call in sick</div>
        <button
          onClick={() => { setOpen(false); setError(""); setReason(""); }}
          className="text-gray-500 hover:text-gray-300 text-lg leading-none w-6 h-6 flex items-center justify-center"
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
          className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm text-white outline-none focus:border-amber-500/40"
        />
        {matchingShift && (
          <div className="mt-1 text-[11px] text-gray-500">
            Shift: {matchingShift.start_time} – {matchingShift.end_time}
          </div>
        )}
      </div>
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">
          Reason <span className="text-gray-600">(optional, only your owner sees this)</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="e.g. fever 39C, doctor advised rest"
          className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm text-white placeholder:text-gray-600 outline-none focus:border-amber-500/40 resize-none"
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
      <div className="text-[10px] text-gray-600 text-center leading-snug">
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


function ScheduleTab({ shifts, staffName, token, onShiftsChanged }) {
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

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
          <div className="text-[11px] text-gray-500 mb-1">This week</div>
          <div className="text-2xl font-bold text-white">{thisWeekHours} <span className="text-sm text-gray-500">hrs</span></div>
          <div className="text-[11px] text-gray-500">{thisWeekShifts.length} shifts</div>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
          <div className="text-[11px] text-gray-500 mb-1">Next shift</div>
          {nextShift ? (
            <>
              <div className="text-lg font-bold text-white">
                {isToday(nextShift.date) ? "Today" : fmtShort(nextShift.date)}
              </div>
              <div className="text-[11px] text-gray-500">{nextShift.start_time} – {nextShift.end_time}</div>
            </>
          ) : (
            <div className="text-lg font-bold text-gray-600">None</div>
          )}
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
      <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.04] ${past ? "opacity-40" : "opacity-50"}`}>
        <div className="w-10 text-center">
          <div className="text-[10px] font-semibold text-gray-600">{dayName}</div>
          <div className="text-sm font-bold text-gray-600">{dayNum}</div>
        </div>
        <div className="flex-1">
          <div className="text-sm text-gray-600">OFF</div>
        </div>
      </div>
    );
  }

  const role = getRoleStyle(shift.role_on_shift);

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] ${past && !today ? "opacity-50" : ""} ${today ? "border-green-500/30 bg-green-500/[0.06]" : ""}`}>
      <div className="w-10 text-center">
        <div className="text-[10px] font-semibold text-gray-500">{dayName}</div>
        <div className={`text-sm font-bold ${today ? "text-green-400" : "text-white"}`}>{dayNum}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-white">{shift.start_time} – {shift.end_time}</div>
        <div className="text-[11px] text-gray-500">{role.icon} {shift.role_on_shift || "Staff"}</div>
      </div>
      <div>
        {today ? (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-green-500/15 text-green-400">Today</span>
        ) : past ? (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-green-500/10 text-green-600">Done</span>
        ) : (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-white/[0.06] text-gray-400">{shift.net_hours}h</span>
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
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
          <div className="text-[11px] text-gray-500 mb-1">Hours worked</div>
          <div className="text-2xl font-bold text-white">
            {data.total_hours} {maxHours ? <span className="text-sm text-gray-500">/ {maxHours}</span> : null}
          </div>
          {pct !== null && (
            <>
              <div className="h-1.5 bg-white/[0.06] rounded-full mt-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-green-500"}`}
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
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
          <div className="text-[11px] text-gray-500 mb-1">Shifts logged</div>
          <div className="text-2xl font-bold text-white">{data.entries.length}</div>
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
            <div className="text-sm text-gray-600 py-4 text-center">No hours logged yet this period</div>
          )}
          {data.entries.map((h, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06]">
              <span className="text-sm text-gray-400">
                {fmtDate(h.date)} {h.start_time && h.end_time ? `· ${h.start_time}-${h.end_time}` : ""}
              </span>
              <span className="text-sm font-semibold text-white">{h.total_hours} hrs</span>
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
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
          <div className="text-[10px] text-gray-500 mb-1">Last 30 days</div>
          <div className="text-lg font-bold text-green-400">{Math.round(data.total_tips_30d).toLocaleString()}</div>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
          <div className="text-[10px] text-gray-500 mb-1">Last shift</div>
          <div className="text-lg font-bold text-white">{lastTip ? Math.round(lastTip.amount) : "—"}</div>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
          <div className="text-[10px] text-gray-500 mb-1">Avg / shift</div>
          <div className="text-lg font-bold text-white">{Math.round(avgPerShift)}</div>
        </div>
      </div>

      {/* Tip history */}
      <div>
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Tip history</div>
        <div className="space-y-1.5">
          {data.entries.length === 0 && (
            <div className="text-sm text-gray-600 py-4 text-center">No tips recorded yet</div>
          )}
          {data.entries.map((t, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06]">
              <span className="text-sm text-gray-400">{fmtDate(t.date)}</span>
              {t.share_pct && <span className="text-[11px] text-gray-600">{t.share_pct.toFixed(1)}% share</span>}
              <span className="text-sm font-semibold text-green-400">{Math.round(t.amount)} DKK</span>
            </div>
          ))}
        </div>
      </div>

      {data.entries.length > 0 && (
        <div className="text-center text-[11px] text-gray-600">
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
      ? "bg-emerald-500/20 text-emerald-300"
      : "bg-gray-500/20 text-gray-400";

  return (
    <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide font-medium text-gray-500">
          {swap.direction === "outgoing" ? "Outgoing" : "Incoming"}
        </span>
        <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${statusPill}`}>
          {swap.status}
        </span>
      </div>
      <div className="text-sm text-white">
        <span className="font-semibold">{swap.from_staff_name}</span>
        <span className="text-gray-500"> → </span>
        <span className="font-semibold">{swap.to_staff_name}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="bg-white/[0.03] rounded p-1.5">
          <div className="text-[10px] text-gray-500">Gives</div>
          <div className="text-white">{swap.from_shift_date}</div>
          <div className="text-gray-400">{swap.from_shift_time}</div>
        </div>
        <div className="bg-white/[0.03] rounded p-1.5">
          <div className="text-[10px] text-gray-500">Gets</div>
          <div className="text-white">{swap.to_shift_date}</div>
          <div className="text-gray-400">{swap.to_shift_time}</div>
        </div>
      </div>
      {swap.reason && (
        <div className="text-[11px] text-gray-400 italic">"{swap.reason}"</div>
      )}
      {swap.owner_note && (
        <div className="text-[11px] text-gray-400">
          <span className="text-gray-500">Owner:</span> {swap.owner_note}
        </div>
      )}

      {/* Actions */}
      {swap.status === "proposed" && swap.direction === "incoming" && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => respond(true)}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
          >
            Accept
          </button>
          <button
            onClick={() => respond(false)}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded bg-white/[0.06] hover:bg-white/[0.1] text-gray-300 disabled:opacity-50"
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
            className="text-xs font-medium px-2.5 py-1 rounded bg-white/[0.06] hover:bg-white/[0.1] text-gray-300 disabled:opacity-50"
          >
            Withdraw
          </button>
        </div>
      )}
      {swap.status === "accepted" && (
        <div className="text-[11px] text-emerald-300 pt-1">
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
    <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-white text-sm">🔄 Offer to swap</div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 text-lg w-6 h-6 flex items-center justify-center"
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
          className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm text-white outline-none focus:border-emerald-500/40"
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
            className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm text-white outline-none focus:border-emerald-500/40"
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
          Reason <span className="text-gray-600">(optional)</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="e.g. family wedding, doctor appt"
          className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm text-white placeholder:text-gray-600 outline-none focus:border-emerald-500/40 resize-none"
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
      <div className="text-[10px] text-gray-600 text-center leading-snug">
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
          <h3 className="text-base font-semibold text-white mb-1">No notifications yet</h3>
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
            <div key={n.id} className="flex items-start gap-3 px-3 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06]">
              <div className="text-lg mt-0.5">{evt.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white">{n.subject || evt.label}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-gray-500">{channelIcon} {n.channel}</span>
                  <span className="text-[11px] text-gray-600">{timeAgo}</span>
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
        <div className="h-20 bg-white/[0.04] rounded-xl" />
        <div className="h-20 bg-white/[0.04] rounded-xl" />
      </div>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-14 bg-white/[0.04] rounded-xl" />
      ))}
    </div>
  );
}


// ─── Error / Not Found ────────────────────────────────────────────────────

function PortalError({ message }) {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <div className="text-4xl mb-3">😕</div>
        <h1 className="text-xl font-bold text-white mb-2">Link not working</h1>
        <p className="text-sm text-gray-500">{message || "This link may have expired or been deactivated. Ask your manager for a new one."}</p>
      </div>
    </div>
  );
}


// ─── Main Portal Page ─────────────────────────────────────────────────────

const TABS = [
  { key: "schedule", icon: "📅", label: "Schedule" },
  { key: "swaps", icon: "🔄", label: "Swaps" },
  { key: "hours", icon: "⏱", label: "Hours" },
  { key: "tips", icon: "💵", label: "Tips" },
  { key: "alerts", icon: "🔔", label: "Alerts" },
];

export default function StaffPortalPage() {
  const { token } = useParams();
  const [tab, setTab] = useState("schedule");
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pinVerified, setPinVerified] = useState(false);

  // Data for each tab
  const [shifts, setShifts] = useState([]);
  const [hoursData, setHoursData] = useState(null);
  const [tipsData, setTipsData] = useState(null);

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
      })
      .catch((err) => {
        setError(err.response?.data?.detail || "Link not found");
        setLoading(false);
      });
  }, [token]);

  // 2. Load data once verified
  const loadData = useCallback(() => {
    // Schedule
    portalApi.get(`/portal/${token}/schedule`).then((res) => {
      setShifts(res.data.shifts || []);
    }).catch(() => {});

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

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-green-500 border-t-transparent rounded-full" />
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
    <div className="min-h-screen bg-gray-950 text-white pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-gray-950/80 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-white">
              {tab === "schedule" ? "My schedule" : tab === "hours" ? "My hours" : tab === "tips" ? "My tips" : "Alerts"}
            </h1>
            {info?.restaurant_name && (
              <div className="text-[11px] text-gray-500">{info.restaurant_name}</div>
            )}
          </div>
          <button
            onClick={() => { setShowEmailEdit(!showEmailEdit); setEmailInput(info?.email || ""); setPhoneInput(info?.phone || ""); setEmailMsg(""); }}
            className="w-9 h-9 rounded-full bg-green-500/15 flex items-center justify-center text-sm font-bold text-green-400"
            title="Edit email"
          >
            {info?.staff_name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
          </button>
        </div>
        {/* Email edit panel */}
        {showEmailEdit && (
          <div className="max-w-lg mx-auto px-4 pb-3">
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 space-y-3">
              <div className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold">Notifications</div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Email</label>
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm text-white placeholder:text-gray-600 outline-none focus:border-green-500/40"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Phone (for WhatsApp)</label>
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="+45 12 34 56 78"
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-sm text-white placeholder:text-gray-600 outline-none focus:border-green-500/40"
                />
              </div>
              <button
                onClick={handleContactSave}
                disabled={emailSaving}
                className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-50"
              >
                {emailSaving ? "Saving..." : "Save"}
              </button>
              {emailMsg && (
                <div className={`text-xs ${emailMsg === "Saved!" ? "text-green-400" : "text-red-400"}`}>{emailMsg}</div>
              )}
              <div className="text-[10px] text-gray-600">
                {info?.email || info?.phone
                  ? `${info.email ? "📧 " + info.email : ""}${info.email && info.phone ? " · " : ""}${info.phone ? "📱 " + info.phone : ""}`
                  : "Add your email or phone to get notified when your schedule changes."}
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
      <nav className="fixed bottom-0 left-0 right-0 bg-gray-900/95 backdrop-blur-xl border-t border-white/[0.06] z-20">
        <div className="max-w-lg mx-auto flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors ${
                tab === t.key ? "text-green-400" : "text-gray-600"
              }`}
            >
              <span className="text-lg">{t.icon}</span>
              <span className="text-[10px] font-semibold">{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
