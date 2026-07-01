// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { useBranch } from "../components/BranchSelector";
import { displayCurrency, formatKr } from "../utils/currency";
import { errText } from "../utils/errText";
import { FadeIn } from "../components/AnimationKit";
import { UpgradeNudge, PageHeader, Button, SectionBanner, Icon } from "../components/ui";
import { X, Link2, Pencil, Trash2, Mail, Phone, Loader2, Plus, Check, MapPinOff, CalendarOff } from "lucide-react";
import OwnerChatDrawer from "../components/staff/OwnerChatDrawer";
// Slice 1 of the [L] drag layer — drag a shift block from one cell onto an
// EMPTY cell (different staff and/or day) to REASSIGN it. dnd-kit gives us an
// accessible (keyboard + pointer) drag with a 6px activation distance, so a
// plain click still opens the modal / blooms a draft. Desktop grid ONLY.
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCenter,
} from "@dnd-kit/core";
// C7 Intelligence collapse — weather + smart-staffing forecasts fold into a
// collapsed panel right here on the Schedule page (where shift decisions are
// made), replacing the standalone /weather + /staffing Intelligence pages.
import ScheduleForecastPanel from "../components/ScheduleForecastPanel";
import SickCallNotificationCard from "../components/SickCallNotificationCard";
import SwapRequestNotificationCard from "../components/SwapRequestNotificationCard";
import ScheduleConfirmationCard from "../components/ScheduleConfirmationCard";

/* ═══════════════════════════════════════════════════════════
   CONSTANTS & HELPERS
   ═══════════════════════════════════════════════════════════ */
const ROLES = ["Chef", "Bartender", "Server", "Runner", "Dishwasher", "Manager"];

// Staff roles are stored lowercase ("server", "kitchen"), but the shift-role
// <select> options are capitalized ("Server"). A raw `member.role` default left
// the select with no matching option → it snapped to the first one ("Chef").
// Map a staff role to the matching shift-role option so the New Shift modal
// defaults to the person's actual role.
const ROLE_TO_SHIFT_OPTION = {
  server: "Server", waiter: "Server", floor: "Server",
  manager: "Manager",
  dishwasher: "Dishwasher",
  chef: "Chef", cook: "Chef", kitchen: "Chef",
  barista: "Bartender", bartender: "Bartender", bar: "Bartender",
  runner: "Runner",
};
function roleToShiftOption(r) {
  if (!r) return ROLES[0];
  const exact = ROLES.find((x) => x.toLowerCase() === String(r).toLowerCase());
  if (exact) return exact;
  return ROLE_TO_SHIFT_OPTION[String(r).toLowerCase()] || ROLES[0];
}
const CONTRACT_TYPES = [
  { value: "full", label: "Full-time" },
  { value: "part", label: "Part-time" },
  { value: "student", label: "Student" },
  { value: "freelance", label: "Freelance" },
];

const ROLE_CATEGORY = {
  Chef: "kitchen",
  Dishwasher: "kitchen",
  Bartender: "bar",
  Server: "floor",
  Runner: "floor",
  Manager: "floor",
};

const ROLE_COLORS = {
  kitchen: {
    bg: "bg-red-100 dark:bg-red-900/20",
    text: "text-red-800 dark:text-red-300",
    border: "border-red-200 dark:border-red-800",
    dot: "bg-red-500",
    label: "Kitchen",
  },
  bar: {
    bg: "bg-blue-100 dark:bg-blue-900/20",
    text: "text-blue-800 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-800",
    dot: "bg-blue-500",
    label: "Bar",
  },
  floor: {
    bg: "bg-gray-100 dark:bg-gray-800/50",
    text: "text-gray-800 dark:text-gray-300",
    border: "border-gray-100 dark:border-gray-800",
    dot: "bg-emerald-500",
    label: "Floor",
  },
};

// Slice S: role as a 3px LEFT-BAR signal only (LOCKED design — no flood tint).
// kitchen=red (Køkken), bar=blue (Bar), floor=emerald (Floor). Keyed by the
// SAME category as ROLE_COLORS so the bar always agrees with the row dot
// (which is already red-500/blue-500/emerald-500). border-* = the left-bar hue.
const ROLE_BAR = {
  kitchen: "border-red-500",
  bar: "border-blue-500",
  floor: "border-emerald-500",
};

// Role → its localized CATEGORY label (Køkken / Bar / Gulv in Danish). Used by
// BOTH the color legend AND the cross-role chip on a shift block so they always
// agree, and so the cryptic 3-char slice ("Che") is gone. DK terminology: a
// kitchen shift reads "Køkken", never the ambiguous "Chef" (= boss in Danish).
const ROLE_LABEL_KEY = { kitchen: "roleKitchen", bar: "roleBar", floor: "roleFloor" };
const ROLE_LABEL_FALLBACK = { kitchen: "Kitchen", bar: "Bar", floor: "Floor" };
function roleLabel(role, t) {
  const cat = ROLE_CATEGORY[role] || "floor";
  return t(ROLE_LABEL_KEY[cat], ROLE_LABEL_FALLBACK[cat]);
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTE_OPTIONS = ["00", "15", "30", "45"];

/** Returns Monday of the week containing the given date */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** Returns ISO week number */
function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Formats "Week 15: 7 Apr – 13 Apr 2026" */
function formatWeekRange(weekStart) {
  const ws = new Date(weekStart);
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const weekNum = getISOWeekNumber(ws);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const startStr = `${ws.getDate()} ${monthNames[ws.getMonth()]}`;
  const endStr = `${we.getDate()} ${monthNames[we.getMonth()]} ${we.getFullYear()}`;
  return `Week ${weekNum}: ${startStr} – ${endStr}`;
}

/** Returns array of 7 Date objects starting from weekStart (Monday) */
function getWeekDates(weekStart) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

/** Format date as YYYY-MM-DD */
function toISO(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format shift time at FULL precision: "16:00–23:00". Owners double-check
    these times, so we never crush "16:00" to a bare "16"; both sides are full
    HH:MM joined by a true en-dash (–). */
function formatShiftTime(start, end) {
  if (!start || !end) return "";
  return `${start.slice(0, 5)}–${end.slice(0, 5)}`;
}

/** Calculate hours between two HH:MM times minus break */
function calcHours(startTime, endTime, breakMinutes = 0) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let totalMinutes = (eh * 60 + em) - (sh * 60 + sm);
  if (totalMinutes < 0) totalMinutes += 24 * 60; // overnight shift
  totalMinutes -= breakMinutes;
  return Math.max(0, totalMinutes / 60);
}

/** DK convention: a shift past ~6h carries a 45-min pause. Mirrors the backend
    `suggested_break_minutes` so a shift seeded here defaults to the SAME break
    the punch clock and roster apply — never a hidden 0 that inflates the hours.
    A suggestion only (overenskomst varies) — always owner-overridable. */
function suggestedBreak(startTime, endTime) {
  return calcHours(startTime, endTime, 0) >= 6 ? 45 : 0;
}

/** Absence type → short owner-facing label for the grid chip. */
function absKindLabel(kind, t) {
  return {
    ferie: t("absenceKindFerie", "Holiday"),
    sick: t("absenceKindSick", "Sick"),
    barns_syg: t("absenceKindBarns", "Child's sick day"),
    andet: t("absenceKindAndet", "Other"),
  }[kind] || kind;
}

/** Sum a staffer's net hours across the visible week (uses the same per-cell
    getShiftForCell the grid renders, so the Timer column can never disagree
    with the blocks above it). */
function weeklyHoursFor(memberId, weekDates, getShiftForCell) {
  let total = 0;
  for (const d of weekDates) {
    const s = getShiftForCell(memberId, d);
    if (s) total += calcHours(s.start_time, s.end_time, s.break_minutes || 0);
  }
  return total;
}

/** Format hours for the Timer column: 1 decimal, trailing-zero trimmed, with
    the localized unit. DK uses a comma decimal + 't' (timer); EN uses '.' + 'h'
    so "32,5t" reads native in Danish and "32.5h" in English. */
function formatTimer(h, unit) {
  const r = Math.round(h * 10) / 10;
  let s = Number.isInteger(r) ? String(r) : r.toFixed(1);
  if (unit === "t") s = s.replace(".", ",");
  return `${s}${unit}`;
}

/** Per-shift / per-day hours: keeps 2-decimal precision (an 07:00–15:20 shift is
    8,33t, never crushed to 8,3 — matches the backend pay calc) and uses the
    localized unit + DK comma decimal. */
function formatShiftHours(hrs, unit) {
  let s = String(Math.round((hrs || 0) * 100) / 100);
  if (unit === "t") s = s.replace(".", ",");
  return `${s}${unit}`;
}

/* ─── Saved shift presets (Vagt-skabeloner) ───
   Reusable shift templates the owner defines once and drops onto cells.
   Client-side only (localStorage) — no backend, no PII, instant. Shape:
   { id, label, start, end, role, break_minutes }. */
const SHIFT_TEMPLATES_KEY = "bonbox_shift_templates_v1";

function loadShiftTemplates() {
  try {
    const arr = JSON.parse(localStorage.getItem(SHIFT_TEMPLATES_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((x) => x && x.start && x.end) : [];
  } catch {
    return [];
  }
}

function persistShiftTemplates(list) {
  try {
    localStorage.setItem(SHIFT_TEMPLATES_KEY, JSON.stringify(list));
  } catch {
    /* private mode — presets just won't persist across reloads */
  }
}

/** True if a shift row belongs to the given staff id (tolerates either
    field name the API has used: staff_id or staff_member_id). */
function shiftBelongsTo(s, id) {
  return !!s && !!id && (s.staff_id === id || s.staff_member_id === id);
}

/** Most-recent (latest date) shift for a staff id within a shift list —
    used to pre-fill the shift modal so owners don't re-type each time. */
function mostRecentShiftFor(shiftList, id) {
  if (!id) return null;
  const mine = (shiftList || [])
    .filter((s) => shiftBelongsTo(s, id) && s.start_time && s.end_time)
    .sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)); // latest first
  return mine[0] || null;
}

/* ─── Live labor-cost helpers (shared by page + grid + mobile) ─── */

/** Pick the cost field for a per-shift / daily / week record by basis.
    Returns a number, or null when the record/field is absent. */
function costByBasis(rec, basis) {
  if (!rec) return null;
  const v = basis === "loaded" ? rec.cost_loaded : rec.cost_gross;
  return typeof v === "number" ? v : null;
}

/** Whole-percent string from a 0..1 ratio, e.g. 0.285 → "29%". */
function pctLabel(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

/** Tailwind text-color classes for a labor% vs target, per the locked
    status-color rule: ≤target emerald, ≤target×1.15 amber, else red.
    target/ratio are 0..1. Returns gray when either is missing. */
function laborTone(ratio, target) {
  if (ratio == null || target == null || Number.isNaN(ratio) || Number.isNaN(target)) {
    return "text-gray-400 dark:text-gray-500";
  }
  if (ratio <= target) return "text-emerald-600 dark:text-emerald-400";
  if (ratio <= target * 1.15) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/** Footer/grid labor% tone — like laborTone but NEVER emerald: inside the grid
    green is the Floor ROLE signal, so "good/under-budget" stays neutral
    gray-900 and only over-budget colours (amber→red). Keeps the only greens in
    the grid the role bars. under→gray-900, near→amber, over→red. */
function laborToneFooter(ratio, target) {
  if (ratio == null || target == null || Number.isNaN(ratio) || Number.isNaN(target)) {
    return "text-gray-400 dark:text-gray-500";
  }
  if (ratio <= target) return "text-gray-900 dark:text-gray-100";
  if (ratio <= target * 1.15) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/** Per-staff confirmation rollup for the owner grid from the staff-side
    "Jeg har set det" (confirmed_at on each published shift this week).
    "all" → every published shift confirmed (green check); "partial"/"none" →
    amber; null → no published shifts OR confirmed_at isn't in the payload yet
    (degrade to NO badge — never a misleading "nobody confirmed"). HONESTY:
    green is gated strictly on every published shift carrying confirmed_at. */
function staffConfirmState(memberId, weekDates, getShiftForCell) {
  let published = 0;
  let confirmed = 0;
  let fieldSeen = false;
  for (const date of weekDates) {
    const s = getShiftForCell(memberId, date);
    if (s && s.status === "published") {
      published += 1;
      if ("confirmed_at" in s) fieldSeen = true;
      if (s.confirmed_at) confirmed += 1;
    }
  }
  if (published === 0 || !fieldSeen) return null;
  if (confirmed === published) return "all";
  return confirmed > 0 ? "partial" : "none";
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */

// Loading skeleton that mirrors the weekly grid (header + h-14 rows) so the
// page settles instead of jumping from a bare spinner to a full table.
function GridSkeleton() {
  const cols = 7;
  const rows = 5;
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden animate-pulse">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <th className="px-4 py-3 w-40">
                <div className="h-3 w-16 rounded bg-gray-200 dark:bg-gray-700" />
              </th>
              {Array.from({ length: cols }).map((_, i) => (
                <th key={i} className="px-2 py-3">
                  <div className="h-3 w-8 mx-auto rounded bg-gray-200 dark:bg-gray-700" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r}>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700" />
                    <div className="space-y-1">
                      <div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-700" />
                      <div className="h-2 w-12 rounded bg-gray-100 dark:bg-gray-700/60" />
                    </div>
                  </div>
                </td>
                {Array.from({ length: cols }).map((_, c) => (
                  <td key={c} className="px-1 py-2">
                    {(r + c) % 3 === 0 ? (
                      <div className="h-14 rounded-lg bg-gray-100 dark:bg-gray-700/50" />
                    ) : (
                      <div className="h-14" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Live "clocked in now" strip — who's currently on the clock (open punches),
// auto-updating ~30s. Staff self-clock from their portal → they appear here in
// near-real-time. Dark gray-900 chips = "in use", same language as the floor.
function ClockedInStrip() {
  const { t } = useLanguage();
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await api.get("/staff/clocked-in");
        if (alive) setRows(Array.isArray(res.data?.clocked_in) ? res.data.clocked_in : []);
      } catch {
        /* soft — strip just hides on error */
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!rows.length) return null;
  const fmtDur = (min) => {
    if (min == null) return "";
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}t ${m}m` : `${m}m`;
  };
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="relative flex h-2.5 w-2.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {t("schedClockedInNow", "Clocked in now")} · {rows.length}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <span
            key={r.staff_id}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 px-2.5 py-1 text-sm"
          >
            <span className="font-medium truncate max-w-[10rem]">{r.name}</span>
            <span className="text-[12px] opacity-80 tabular-nums">{r.since}</span>
            {r.elapsed_min != null && (
              <span className="text-[11px] font-semibold tabular-nums opacity-90">
                {fmtDur(r.elapsed_min)}
              </span>
            )}
            {r.unverified && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-amber-300 dark:text-amber-400"
                title={t("schedGeoUnverifiedChip", "Location not verified")}
              >
                <MapPinOff className="w-3 h-3 shrink-0" strokeWidth={2} aria-hidden />
                {t("schedGeoUnverifiedChip", "Location not verified")}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// Clock-in geofence (location lock) setup — opt-in. Owner taps "use my
// current location" while standing at the venue to set the anchor; staff
// clock-in then verifies device distance. Staff location is checked only at
// the punch, never stored (GDPR) — the staff card shows that notice.
function ClockGeofenceSettings() {
  const { t } = useLanguage();
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [savedMsg, setSavedMsg] = useState(""); // honest success confirmation
  useEffect(() => {
    let alive = true;
    api.get("/staff/clock-geofence")
      .then((r) => { if (alive) setCfg(r.data || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!cfg) return null;

  const save = async (patch) => {
    setBusy(true);
    setMsg("");
    setSavedMsg("");
    try {
      const res = await api.post("/staff/clock-geofence", { enabled: cfg.enabled, ...patch });
      setCfg(res.data);
      // Only confirm "location-bound" when a venue was actually anchored AND
      // the lock is on — never overclaim. (Honesty: a distance check at the
      // punch instant, not proof of presence.)
      if (patch.lat != null && patch.lng != null && res.data?.has_location && res.data?.enabled) {
        setSavedMsg(t("schedGeoSaved", "Venue anchored here. Staff clock-in is now location-bound."));
      }
    } catch {
      setMsg(t("schedGeoErr", "Couldn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const setHere = () => {
    if (!navigator.geolocation) {
      setMsg(t("schedGeoNoGps", "Location unavailable on this device."));
      return;
    }
    setBusy(true);
    setMsg("");
    navigator.geolocation.getCurrentPosition(
      (p) => save({ enabled: true, lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {
        setBusy(false);
        setMsg(t("schedGeoDenied", "Allow location to set the venue."));
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="w-full text-[12px] text-gray-500 dark:text-gray-400 leading-snug">
        {t("schedGeoHelp", "Staff can only clock in near the venue. Stand at the venue and set it as the anchor — their phone's location is checked at that moment only, never saved or tracked.")}
      </p>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!cfg.enabled}
          disabled={busy || !cfg.has_location}
          onChange={(e) => save({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900 disabled:opacity-50"
        />
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t("schedGeoTitle", "Only clock in at the venue")}
        </span>
      </label>
      <span className="text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">
        {cfg.has_location
          ? t("schedGeoSet", "Venue set · within {m} m", { m: cfg.radius_m })
          : t("schedGeoUnset", "No venue location set")}
      </span>
      <button
        type="button"
        onClick={setHere}
        disabled={busy}
        className="ml-auto inline-flex items-center justify-center min-h-[36px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
      >
        {cfg.has_location ? t("schedGeoReset", "Update location") : t("schedGeoUseHere", "Use my current location")}
      </button>
      {msg && <span className="w-full text-[12px] text-red-500 dark:text-red-400">{msg}</span>}
      {savedMsg && !msg && (
        <span className="w-full text-[12px] text-emerald-600 dark:text-emerald-400">{savedMsg}</span>
      )}
    </div>
  );
}

export default function StaffSchedulePage() {
  const { user } = useAuth();
  const { t, lang } = useLanguage();
  const confirm = useConfirm();
  const { branchId } = useBranch();
  const currency = displayCurrency(user?.currency);

  // Week navigation
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);

  // Data
  const [staff, setStaff] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [absences, setAbsences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Live labor-cost layer (server-computed, loaded/gross + labor% vs target).
  // Null when the endpoint fails — the UI falls back to the client `stats`
  // memo so the grid + summary still render. Never blocks shift rendering.
  const [weekCost, setWeekCost] = useState(null);

  // Owner display prefs (persisted so the choice sticks across sessions):
  //   showCost  — show per-shift lønkroner in grid/mobile cells (default on)
  //   costBasis — 'gross' (Løn) vs 'loaded' (Inkl. feriepenge) for all costs
  const [showCost, setShowCost] = useState(() => {
    try {
      return localStorage.getItem("bonbox_sched_showcost") !== "false";
    } catch {
      return true;
    }
  });
  const [costBasis, setCostBasis] = useState(() => {
    try {
      return localStorage.getItem("bonbox_sched_costbasis") === "loaded" ? "loaded" : "gross";
    } catch {
      return "gross";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("bonbox_sched_showcost", showCost ? "true" : "false");
    } catch { /* storage unavailable (private mode) — pref just won't persist */ }
  }, [showCost]);
  useEffect(() => {
    try {
      localStorage.setItem("bonbox_sched_costbasis", costBasis);
    } catch { /* storage unavailable */ }
  }, [costBasis]);

  // Staff management panel
  const [showManageStaff, setShowManageStaff] = useState(false);
  // Owner ↔ staff chat ("Beskeder") — drawer + launcher-badge unread count.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  // Poll the cheap aggregate-unread endpoint so the launcher badge lights up
  // when staff write. Pauses while the drawer is open (the drawer owns reads).
  useEffect(() => {
    if (chatOpen) return;
    let cancelled = false;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      api
        .get("/staff/chat/unread")
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
  }, [chatOpen]);

  // Shift modal
  const [shiftModal, setShiftModal] = useState(null); // { staffId, date, shift? }
  // Smart-default memory: the last shift the owner saved this session
  // ({ start, end, break_minutes, role }). When they open "Add Shift"
  // again for a staff with no prior shift this week, the modal pre-fills
  // from this so a run of similar shifts is 1 tap, not 5. Cleared on reload.
  const [lastShiftTemplate, setLastShiftTemplate] = useState(null);

  // Saved shift presets (Vagt-skabeloner) — reusable templates the owner keeps
  // across sessions (localStorage). Arming one makes the next empty-cell click
  // bloom from it instead of the most-recent-shift seed.
  const [shiftTemplates, setShiftTemplates] = useState(loadShiftTemplates);
  const [armedTemplateId, setArmedTemplateId] = useState(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const armedTemplate = useMemo(
    () => shiftTemplates.find((x) => x.id === armedTemplateId) || null,
    [shiftTemplates, armedTemplateId]
  );
  const addTemplate = useCallback((tpl) => {
    setShiftTemplates((prev) => {
      const next = [...prev, tpl];
      persistShiftTemplates(next);
      return next;
    });
    setShowTemplateModal(false);
  }, []);
  const removeTemplate = useCallback((id) => {
    setShiftTemplates((prev) => {
      const next = prev.filter((x) => x.id !== id);
      persistShiftTemplates(next);
      return next;
    });
    setArmedTemplateId((cur) => (cur === id ? null : cur));
  }, []);

  // Action states
  const [copying, setCopying] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Pre-publish confirm sheet (audit #248): holds a computed summary
  // { draftCount, staffCount, hours, cost, anyRate } while open; null = closed.
  // Publishing is the "money moment" staff see — owners get one calm glance at
  // what's about to go live before it does.
  const [publishConfirm, setPublishConfirm] = useState(null);
  // After a successful publish we keep the confirm sheet OPEN and swap it to a
  // success state (✓ + the server's real published/notify counts) — a durable
  // "it worked" moment beats a toast that blinks out. null = pre-publish.
  const [publishResult, setPublishResult] = useState(null);

  /* ─── Data fetching ─── */
  const fetchStaff = useCallback(async () => {
    try {
      const params = {};
      if (branchId) params.branch_id = branchId;
      const res = await api.get("/staff/members", { params });
      setStaff(res.data || []);
    } catch {
      // Staff list may not exist yet
      setStaff([]);
    }
  }, [branchId]);

  const fetchShifts = useCallback(async () => {
    const params = { week_start: toISO(weekStart) };
    if (branchId) params.branch_id = branchId;
    try {
      const res = await api.get("/staff/schedules", { params });
      setShifts(res.data || []);
    } catch {
      setShifts([]);
    }
    // Live labor cost — fetched alongside shifts so every refresh path
    // (initial load, copy-week, publish, autopilot-apply, modal save) keeps
    // the cost layer in sync. Fail-soft: on error null it out and let the
    // client `stats` fallback cover the summary. Does NOT block the grid.
    try {
      const costRes = await api.get("/staff/schedules/week-cost", { params });
      setWeekCost(costRes.data || null);
    } catch {
      setWeekCost(null);
    }
    // Standing "kan ikke" availability — painted as calm red cells on the grid
    // so the owner spots conflicts at a glance (at 15-30 rows especially). Not
    // week/branch scoped; fail-soft (never blocks the grid).
    try {
      const avRes = await api.get("/staff/availability");
      setAvailability(avRes.data?.availability || []);
    } catch {
      setAvailability([]);
    }
    // Approved/pending fravær (ferie, syg) — painted on the grid so the owner
    // sees who's off. include_resolved=true to also show 'covered' (still off);
    // 'cancelled' (declined) is filtered out client-side. Fail-soft.
    try {
      const absRes = await api.get("/staff/absences", {
        params: { days_back: 31, include_resolved: true },
      });
      setAbsences(absRes.data || []);
    } catch {
      setAbsences([]);
    }
  }, [weekStart, branchId]);

  // Map staff_id → their standing "unavailable" blocks; a soft signal the owner
  // sees but can still override (they can hand-place onto a red cell).
  const availByStaff = useMemo(() => {
    const m = {};
    for (const a of availability) {
      if (a.kind && a.kind !== "unavailable") continue; // 'preferred' never blocks
      (m[String(a.staff_id)] = m[String(a.staff_id)] || []).push(a);
    }
    return m;
  }, [availability]);

  const unavailFor = useCallback((staffId, date) => {
    const list = availByStaff[String(staffId)];
    if (!list || !list.length) return null;
    const iso = toISO(date);
    const pyWd = (date.getDay() + 6) % 7; // JS Sun=0 → DK/Python Mon=0
    for (const a of list) {
      const match = a.date ? a.date === iso : a.weekday === pyWd;
      if (match) return { ...a, timeLabel: a.start_time ? `${a.start_time}–${a.end_time}` : null };
    }
    return null;
  }, [availByStaff]);

  // Approved/pending fravær keyed by staff_id → { ISO date → row }. Excludes
  // declined ('cancelled'); a concrete absence outranks a standing "kan ikke".
  const absByStaff = useMemo(() => {
    const m = {};
    for (const a of absences) {
      if (a.status === "cancelled") continue;
      const sid = String(a.staff_id);
      (m[sid] = m[sid] || {})[a.date] = a;
    }
    return m;
  }, [absences]);

  const absenceFor = useCallback((staffId, date) => {
    const byDate = absByStaff[String(staffId)];
    return byDate ? byDate[toISO(date)] || null : null;
  }, [absByStaff]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    await Promise.all([fetchStaff(), fetchShifts()]);
    setLoading(false);
  }, [fetchStaff, fetchShifts]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* ─── Click-to-bloom (one-tap add) ─── */
  // Holds { id } of the just-bloomed draft for ~6s so a mis-tap is one tap to
  // remove (Fortryd). null = nothing to undo. Drafts never notify, so this is
  // a purely local convenience, NOT an "unsend".
  const [undoShift, setUndoShift] = useState(null);

  // Clicking an EMPTY cell drops a SEEDED DRAFT inline — no modal, no typing —
  // pre-filled from that staffer's most-recent shift (or this session's last
  // template). The modal stays as the deep-editor for OCCUPIED cells.
  // SAFE BY CONSTRUCTION: the POST omits `status`, so the backend defaults it
  // to 'draft' → a bloomed shift NEVER notifies staff. Only Publish notifies.
  const bloomDraft = useCallback(
    async (staffId, dateObj, memberRole) => {
      // An armed preset wins; else the staffer's most-recent shift; else the
      // session's last-used template. So tapping a preset then a day places it.
      const seed = armedTemplate || mostRecentShiftFor(shifts, staffId) || lastShiftTemplate || null;
      const startT = seed?.start_time || seed?.start || "16:00";
      const endT = seed?.end_time || seed?.end || "23:00";
      const payload = {
        staff_id: staffId,
        date: toISO(dateObj),
        start_time: startT,
        end_time: endT,
        // Respect a break the seed carries; otherwise default to the DK
        // suggestion for these times so a quick-placed 6h+ shift reads the
        // same hours as the punched/rostered one instead of a silent 0.
        break_minutes: seed?.break_minutes ?? suggestedBreak(startT, endT),
        role_on_shift: roleToShiftOption(seed?.role_on_shift || seed?.role || memberRole),
        branch_id: branchId || undefined,
        // status intentionally OMITTED → backend defaults 'draft' → no notify.
      };
      try {
        const res = await api.post("/staff/schedules", payload);
        const createdId = res?.data?.id ?? null;
        await fetchShifts();
        if (createdId != null) {
          setUndoShift({ id: createdId });
          setTimeout(
            () => setUndoShift((u) => (u && u.id === createdId ? null : u)),
            6000
          );
        }
      } catch (err) {
        if (
          err?.response?.status === 409 &&
          err?.response?.data?.detail?.code === "shift_overlap"
        ) {
          setError(
            t("schedSlotTaken", "That overlaps a shift they already have that day.")
          );
        } else {
          setError(errText(err, t("shiftCreateFailed", "Failed to create shift.")));
        }
      }
    },
    [shifts, lastShiftTemplate, armedTemplate, branchId, fetchShifts, t]
  );

  const undoBloom = useCallback(async () => {
    if (!undoShift) return;
    const id = undoShift.id;
    setUndoShift(null);
    try {
      await api.delete(`/staff/schedules/${id}`);
      await fetchShifts();
    } catch (err) {
      setError(errText(err, t("shiftDeleteFailed", "Failed to delete shift.")));
    }
  }, [undoShift, fetchShifts, t]);

  /* ─── Drag-to-move ([L] slice 1) ─── */
  // Holds { id, prevStaffId, prevDateIso } of the just-moved shift for ~6s so a
  // mis-drop is one tap to put it back (Fortryd). null = nothing to undo.
  const [undoMove, setUndoMove] = useState(null);

  // Reassign a shift to a NEW staff and/or day via PUT /staff/schedules/{id}
  // with the full payload where staff_id + date are the new target. Backend
  // update_schedule re-validates the staff belongs to the tenant. CRUCIALLY we
  // keep start/end/status UNCHANGED — update_schedule only notifies when a
  // PUBLISHED shift's start/end changed, so a move introduces NO notification.
  const moveShift = useCallback(
    async (shift, toStaffId, toDateIso) => {
      const prevStaffId = shift.staff_id ?? shift.staff_member_id;
      const prevDateIso = String(shift.date);
      const payload = {
        staff_id: toStaffId,
        date: toDateIso,
        start_time: shift.start_time,
        end_time: shift.end_time,
        break_minutes: shift.break_minutes || 0,
        role_on_shift: shift.role_on_shift,
        notes: shift.notes || undefined,
        status: shift.status,
        branch_id: branchId || undefined,
      };
      try {
        await api.put(`/staff/schedules/${shift.id}`, payload);
        setUndoMove({ id: shift.id, prevStaffId, prevDateIso });
        setTimeout(
          () => setUndoMove((u) => (u && u.id === shift.id ? null : u)),
          6000
        );
        await fetchShifts();
      } catch (err) {
        // 409 shift_overlap → the target staffer already works an overlapping
        // shift that day. Nothing moved (no undo to offer); just say so plainly.
        if (
          err?.response?.status === 409 &&
          err?.response?.data?.detail?.code === "shift_overlap"
        ) {
          setError(
            t("schedSlotTaken", "That overlaps a shift they already have that day.")
          );
        } else {
          setError(errText(err, t("shiftUpdateFailed", "Failed to update shift.")));
        }
      }
    },
    [branchId, fetchShifts, t]
  );

  const undoMoveAction = useCallback(async () => {
    if (!undoMove) return;
    const { id, prevStaffId, prevDateIso } = undoMove;
    setUndoMove(null);
    const s = shifts.find((x) => x.id === id);
    if (!s) return;
    try {
      await api.put(`/staff/schedules/${id}`, {
        staff_id: prevStaffId,
        date: prevDateIso,
        start_time: s.start_time,
        end_time: s.end_time,
        break_minutes: s.break_minutes || 0,
        role_on_shift: s.role_on_shift,
        notes: s.notes || undefined,
        status: s.status,
        branch_id: branchId || undefined,
      });
      await fetchShifts();
    } catch (err) {
      setError(errText(err, t("shiftUpdateFailed", "Failed to update shift.")));
    }
  }, [undoMove, shifts, branchId, fetchShifts, t]);

  /* ─── Week navigation ─── */
  const goToPrevWeek = () => {
    const prev = new Date(weekStart);
    prev.setDate(prev.getDate() - 7);
    setWeekStart(prev);
  };

  const goToNextWeek = () => {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + 7);
    setWeekStart(next);
  };

  const goToCurrentWeek = () => {
    setWeekStart(getWeekStart(new Date()));
  };

  /* ─── Actions ─── */
  const handleCopyLastWeek = async () => {
    setCopying(true);
    setError("");
    try {
      const prevWeek = new Date(weekStart);
      prevWeek.setDate(prevWeek.getDate() - 7);
      await api.post("/staff/schedules/copy-week", {
        source_week: toISO(prevWeek),
        target_week: toISO(weekStart),
        branch_id: branchId || undefined,
      });
      await fetchShifts();
    } catch (err) {
      setError(errText(err, "Failed to copy last week's schedule."));
    }
    setCopying(false);
  };

  // Frontend mirror of the backend's _pick_rate: weekend (Sat/Sun) > evening
  // (≥18:00) > base, using each member's REAL premium rates (null → base). Keeps
  // the publish summary's labor figure in lockstep with the grid's ≈ per-shift
  // costs instead of silently billing everything at base.
  const pickRate = (member, dateStr, startTime) => {
    const base = Number(member?.base_rate) || 0;
    const evening = Number(member?.evening_rate) || base;
    const weekend = Number(member?.weekend_rate) || base;
    const dow = new Date(`${dateStr}T00:00:00`).getDay(); // 0=Sun … 6=Sat
    if ((dow === 0 || dow === 6) && weekend > 0) return weekend;
    if (startTime && parseInt(String(startTime).slice(0, 2), 10) >= 18 && evening > 0) return evening;
    return base;
  };

  // Summarize the draft shifts that "Publish" will make live — computed from
  // already-loaded shifts + staff, so the confirm sheet is instant (no fetch).
  const computePublishSummary = () => {
    const drafts = (shifts || []).filter((s) => s.status === "draft");
    const staffIds = new Set();
    let hours = 0;
    let cost = 0;
    let anyRate = false;
    drafts.forEach((s) => {
      const sid = s.staff_id || s.staff_member_id;
      if (sid) staffIds.add(sid);
      const hrs = calcHours(s.start_time, s.end_time, s.break_minutes || 0);
      hours += hrs;
      const member = staff.find((m) => m.id === sid);
      const rate = pickRate(member, s.date, s.start_time);
      if (rate > 0) anyRate = true;
      cost += hrs * rate;
    });
    // Match the grid's basis: +12.5% feriepenge when "Inkl. feriepenge" is the
    // active view, so this figure equals the per-shift ≈ costs shown above it.
    if (costBasis === "loaded") cost *= 1.125;
    return {
      draftCount: drafts.length,
      staffCount: staffIds.size,
      hours: Math.round(hours * 10) / 10,
      cost: Math.round(cost),
      anyRate,
    };
  };

  // Persistent at-a-glance state for the toolbar CTA: how many shifts are still
  // unpublished. 0 → the week is fully live and the button reads "Published".
  const draftCount = useMemo(
    () => (shifts || []).filter((s) => s.status === "draft").length,
    [shifts],
  );

  // Step 1 — open the confirm sheet (the deliberate gate before going live).
  const requestPublish = () => {
    setError("");
    setPublishResult(null);
    setPublishConfirm(computePublishSummary());
  };

  // Step 2 — actually publish (called from the confirm sheet's CTA), then show
  // an HONEST success banner built from the server's real counts.
  const confirmPublish = async () => {
    setPublishing(true);
    setError("");
    try {
      const params = { week_start: toISO(weekStart) };
      if (branchId) params.branch_id = branchId;
      const res = await api.post("/staff/schedules/publish", null, { params });
      await fetchShifts();
      const d = res.data || {};
      // Keep the sheet OPEN and flip it to a success state built from the
      // server's real counts — the durable confirmation that was missing.
      setPublishResult({
        published: Number(d.published) || 0,
        notify: Number(d.notify_count) || 0,
      });
    } catch (err) {
      setError(errText(err, "Failed to publish schedule."));
    }
    setPublishing(false);
  };

  const [exporting, setExporting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [emailToast, setEmailToast] = useState("");
  // Staff v2 (2026-05-28) — "Share with staff" CTA mints/refreshes
  // StaffLink magic-links for every staff scheduled this week and emails
  // each their portal URL. Distinct from "Email staff" (text-only
  // change-summary): this CTA is the on-ramp that gives staff a bookmarkable
  // /s/{token} URL where every future schedule edit + push notification
  // converges. Tier-gated on `staff_portal_link` (Starter+/Trial).
  const [sharing, setSharing] = useState(false);
  const [shareToast, setShareToast] = useState("");
  // Unified "Share schedule" sheet (2026-05-29) — replaces the email-only
  // window.confirm() with a checkbox picker: Select all / individual, then
  // Copy links (the UNIVERSAL channel — works for staff with no email, paste
  // into WhatsApp/SMS) or Email those who have an address. Links are minted
  // via POST /staff/members/{id}/link and cached so re-copying is instant.
  const [shareSheet, setShareSheet] = useState(false);
  const [shareSel, setShareSel] = useState(() => new Set());
  const [shareLinks, setShareLinks] = useState({}); // staffId -> portal URL
  const [shareCodes, setShareCodes] = useState({}); // staffId -> short join code
  const [shareBusy, setShareBusy] = useState(false);
  const [shareCopiedN, setShareCopiedN] = useState(0);
  const [shareRowCopied, setShareRowCopied] = useState(null); // staffId just copied
  // UpgradeNudge state — bulk-staff-email is Pro+. Free/Starter
  // users still get the PDF download for printing/WhatsApp share.
  const [upgradeNudge, setUpgradeNudge] = useState(null);

  // Autopilot (Task #50 — Pro killer feature) — read 8 weeks of revenue
  // patterns + 7-day weather forecast + each staff's hourly cost, and
  // propose next week's schedule at minimum labor cost while respecting
  // DK labor law. Owner reviews → Apply materializes the draft shifts.
  const [autopilotLoading, setAutopilotLoading] = useState(false);
  const [autopilotApplying, setAutopilotApplying] = useState(false);
  const [autopilotSuggestion, setAutopilotSuggestion] = useState(null);
  const [autopilotToast, setAutopilotToast] = useState("");

  const handleRunAutopilot = async () => {
    setAutopilotLoading(true);
    setError("");
    setAutopilotToast("");
    try {
      const res = await api.post("/staff/schedules/autopilot", {
        week_start: toISO(weekStart),
        branch_id: branchId || undefined,
      });
      setAutopilotSuggestion(res.data);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 402 && detail?.code === "plan_required") {
        setUpgradeNudge({
          tier: detail.upgrade_to || "pro",
          benefit: t(
            "nudgeAutopilot",
            "Let BonBox propose next week's schedule from your sales history + weather"
          ),
          icon: "✨",
        });
      } else {
        setError(
          detail?.message ||
            (typeof detail === "string" ? detail : null) ||
            t("autopilotFailed", "Couldn't run autopilot.")
        );
      }
    } finally {
      setAutopilotLoading(false);
    }
  };

  const handleApplyAutopilot = async () => {
    if (!autopilotSuggestion) return;
    setAutopilotApplying(true);
    setError("");
    try {
      const shifts = autopilotSuggestion.days.flatMap((day) =>
        (day.shifts || []).map((s) => ({
          date: day.date,
          staff_id: s.staff_id,
          start: s.start,
          end: s.end,
          break_minutes: s.break_minutes,
          role: s.role,
        }))
      );
      const res = await api.post("/staff/schedules/autopilot/apply", {
        week_start: autopilotSuggestion.week_start,
        branch_id: branchId || undefined,
        shifts,
      });
      const n = res.data?.applied ?? shifts.length;
      setAutopilotToast(
        `✨ ${t("autopilotApplied", "Schedule applied")} — ${n} ${t(
          "autopilotShifts",
          "shifts scheduled"
        )}`
      );
      setTimeout(() => setAutopilotToast(""), 7000);
      setAutopilotSuggestion(null);
      await fetchShifts();
    } catch (err) {
      setError(
        errText(err, t("autopilotApplyFailed", "Couldn't apply the autopilot schedule."))
      );
    } finally {
      setAutopilotApplying(false);
    }
  };

  /** Email this week's schedule directly to every active staff
   *  member with an email on file. Reply-to is set server-side to
   *  the owner's address so staff replies come back to the owner.
   *
   *  We do a confirm() first because this fires a real email to
   *  every recipient — easy to surprise an owner who didn't realize
   *  the button does that. The confirm tells them up front how many
   *  emails are about to go out.
   */
  const handleEmailToStaff = async () => {
    const eligible = staff.filter(
      (s) => s.is_active !== false && (s.email || "").includes("@")
    );
    if (eligible.length === 0) {
      setError(
        t("scheduleEmailNoRecipients", "No active staff have an email yet. Add an email on each staff member.")
      );
      return;
    }
    const ok = await confirm({ message:
      (t("scheduleEmailConfirm", "Email this week's schedule to {n} staff?").replace("{n}", eligible.length))
      + "\n\n" + eligible.map(s => `• ${s.name} <${s.email}>`).join("\n")
    , destructive: false });
    if (!ok) return;

    setEmailing(true);
    setError("");
    setEmailToast("");
    try {
      const r = await api.post("/staff/schedules/email", {
        week_start: toISO(weekStart),
        lang: lang || "en",
        cc_self: true,
      });
      const sent = r.data?.sent || 0;
      const skipped = r.data?.skipped_no_email || 0;
      const failed = (r.data?.failed || []).length;
      let msg = `✓ ${sent} ${t("scheduleEmailSent", "sent")}`;
      if (skipped) msg += ` · ${skipped} ${t("scheduleEmailSkippedNoEmail", "skipped (no email)")}`;
      if (failed) msg += ` · ${failed} ${t("scheduleEmailFailed", "failed")}`;
      setEmailToast(msg);
      setTimeout(() => setEmailToast(""), 7000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      // 402 plan_required — surface as the UpgradeNudge dialog so the
      // owner sees a clean Pro pitch instead of a generic error toast.
      if (err?.response?.status === 402 &&
          detail?.code === "plan_required" &&
          detail?.feature === "bulk_staff_email") {
        setUpgradeNudge({
          tier: detail.required_plan || "pro",
          benefit: t("nudgeBulkStaffEmail", "Email this week's schedule to every staff member in one tap"),
          icon: "📧",
        });
      } else {
        setError(detail?.message || (typeof detail === "string" ? detail : null) || (t("scheduleEmailFailedAll", "Couldn't email the schedule.")));
      }
    } finally {
      setEmailing(false);
    }
  };

  /**
   *  handleShareWithStaff — calls /staff/schedules/share-with-staff which
   *  (a) ensures every staff scheduled this week has an active StaffLink
   *      magic-link (mints token_urlsafe(24) when missing), and
   *  (b) emails each staff their personal /s/{token} portal URL.
   *
   *  After the call lands, future schedule edits trigger push notifications
   *  via the staff's portal subscription — the "auto-sync" requirement
   *  Manoj wired into the spec.
   *
   *  402 plan_required → opens the UpgradeNudge so Free owners see a clean
   *  upsell instead of a raw error. Other errors land in the error banner.
   */
  const handleShareWithStaff = async () => {
    const eligible = staff.filter(
      (s) => s.is_active !== false && (s.email || "").includes("@")
    );
    if (eligible.length === 0) {
      setError(
        t(
          "scheduleShareNoRecipients",
          "No active staff have an email yet — add an email so they can receive their schedule link."
        )
      );
      return;
    }
    const ok = await confirm({ message:
      (t(
        "scheduleShareConfirm",
        "Share this week's schedule with {n} staff via a personal magic link?"
      ).replace("{n}", eligible.length)) +
        "\n\n" +
        eligible.map((s) => `• ${s.name} <${s.email}>`).join("\n")
    , destructive: false });
    if (!ok) return;

    setSharing(true);
    setError("");
    setShareToast("");
    try {
      const r = await api.post("/staff/schedules/share-with-staff", {
        week_start: toISO(weekStart),
      });
      const emailed = r.data?.emailed_count || 0;
      const issued = r.data?.links_issued || 0;
      const skipped = r.data?.skipped_no_email || 0;
      const failed = r.data?.email_failed_count || 0;
      let msg = `✓ ${emailed} ${t("scheduleShareEmailed", "links sent")}`;
      if (issued)
        msg += ` · ${issued} ${t("scheduleShareIssued", "new links minted")}`;
      if (skipped)
        msg += ` · ${skipped} ${t(
          "scheduleShareSkippedNoEmail",
          "skipped (no email)"
        )}`;
      if (failed) msg += ` · ${failed} ${t("scheduleShareFailed", "failed")}`;
      setShareToast(msg);
      setTimeout(() => setShareToast(""), 7000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      // 402 plan_required → UpgradeNudge (the Starter+ value gate).
      if (
        err?.response?.status === 402 &&
        detail?.code === "plan_required" &&
        detail?.feature === "staff_portal_link"
      ) {
        setUpgradeNudge({
          tier: detail.required_plan || "starter",
          benefit: t(
            "nudgeStaffPortalLink",
            "Send every staff a personal schedule link — they bookmark it, get push when shifts change"
          ),
          icon: "🔗",
        });
      } else {
        setError(
          detail?.message ||
            (typeof detail === "string" ? detail : null) ||
            t("scheduleShareFailedAll", "Couldn't share the schedule.")
        );
      }
    } finally {
      setSharing(false);
    }
  };

  const handleExportPdf = async () => {
    setExporting(true);
    setError("");
    try {
      const res = await api.get("/staff/schedules/pdf", {
        params: { week_start: toISO(weekStart), lang: lang || "en" },
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bonbox-schedule-${toISO(weekStart)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(errText(err, t("schedulePdfFailed") || "Couldn't export PDF."));
    } finally {
      setExporting(false);
    }
  };

  /* ─── Shift helpers ─── */
  const getShiftForCell = (staffId, date) => {
    const dateStr = toISO(date);
    return shifts.find(
      (s) => (s.staff_member_id === staffId || s.staff_id === staffId) && s.date === dateStr
    );
  };

  const activeStaff = useMemo(() => staff.filter((s) => s.is_active !== false), [staff]);

  /* ─── Stats ─── */
  const stats = useMemo(() => {
    let totalHours = 0;
    let totalCost = 0;
    shifts.forEach((s) => {
      const hrs = calcHours(s.start_time, s.end_time, s.break_minutes || 0);
      totalHours += hrs;
      const member = staff.find((m) => m.id === (s.staff_member_id || s.staff_id));
      const rate = member?.base_rate || 0;
      totalCost += hrs * rate;
    });
    return {
      totalHours: Math.round(totalHours * 10) / 10,
      totalCost: Math.round(totalCost),
      activeCount: activeStaff.length,
    };
  }, [shifts, staff, activeStaff]);

  /* ─── Live labor-cost derivations ─── */
  // Per-shift cost lookup for grid + mobile cells. Returns null (render
  // nothing) when the cost layer is off, missing, or the shift isn't priced.
  const costForShift = useCallback(
    (shiftId) => {
      if (!showCost || !weekCost?.per_shift) return null;
      return costByBasis(weekCost.per_shift[shiftId], costBasis);
    },
    [showCost, weekCost, costBasis]
  );

  // Headline week summary — prefers the server's cost layer; falls back to the
  // client `stats` for hours/cost when the endpoint is unavailable. Labor% is
  // ONLY shown from the server (it needs revenue we don't compute client-side).
  const targetPct = typeof weekCost?.target_labor_pct === "number" ? weekCost.target_labor_pct : null;
  const weekSummary = useMemo(() => {
    const w = weekCost?.week || null;
    const hours = typeof w?.hours === "number" ? w.hours : stats.totalHours;
    const cost = w ? costByBasis(w, costBasis) : stats.totalCost;
    const laborPct = w
      ? (costBasis === "loaded" ? w.labor_pct_loaded : w.labor_pct_gross)
      : null;
    return {
      hours: Math.round((hours || 0) * 10) / 10,
      cost: Math.round(cost ?? 0),
      laborPct: typeof laborPct === "number" ? laborPct : null,
      hasRevenue: w ? w.revenue != null : false,
    };
  }, [weekCost, costBasis, stats.totalHours, stats.totalCost]);

  // ─── Unified Share sheet helpers (this component owns the toolbar + state) ──
  const shareActiveStaff = () => activeStaff;

  const openShareSheet = () => {
    // Default selection = everyone active (the "share to all" path; owner
    // unchecks who they don't want).
    setShareSel(new Set(activeStaff.map((s) => s.id)));
    setShareCopiedN(0);
    setShareRowCopied(null);
    setShareSheet(true);
    // Pre-fetch every link in ONE call so "Copy links" is instant and runs
    // inside the click gesture (no per-staff POST storm). mintLinkFor reads
    // this cache first; if the fetch fails we fall back to per-staff mint.
    api.get("/staff/schedules/share-links")
      .then((r) => {
        const map = {};
        const codes = {};
        for (const row of r.data || []) {
          if (row.staff_id && row.portal_url) {
            map[row.staff_id] = `${window.location.origin}${row.portal_url}`;
          }
          if (row.staff_id && row.join_code) codes[row.staff_id] = row.join_code;
        }
        setShareLinks((prev) => ({ ...map, ...prev }));
        setShareCodes((prev) => ({ ...codes, ...prev }));
      })
      .catch(() => { /* fall back to per-staff mint on copy */ });
  };

  const shareAllSelected = () =>
    activeStaff.length > 0 && activeStaff.every((s) => shareSel.has(s.id));

  const toggleShareAll = () => {
    if (shareAllSelected()) setShareSel(new Set());
    else setShareSel(new Set(activeStaff.map((s) => s.id)));
  };

  const toggleShareOne = (id) => {
    setShareSel((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Mint (or reuse cached) a portal link for one staff member.
  const mintLinkFor = async (member) => {
    if (shareLinks[member.id]) return shareLinks[member.id];
    const res = await api.post(`/staff/members/${member.id}/link`);
    const fullUrl = `${window.location.origin}${res.data.portal_url}`;
    setShareLinks((prev) => ({ ...prev, [member.id]: fullUrl }));
    if (res.data.join_code) {
      setShareCodes((prev) => ({ ...prev, [member.id]: res.data.join_code }));
    }
    return fullUrl;
  };

  const _writeClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  // Copy one staff's link (per-row action).
  const copyOneLink = async (member) => {
    try {
      const url = await mintLinkFor(member);
      await _writeClipboard(url);
      setShareRowCopied(member.id);
      setTimeout(() => setShareRowCopied(null), 2000);
    } catch (err) {
      setError(errText(err, "Failed to generate link"));
    }
  };

  // Copy a combined "Name — url" block for every selected staff. UNIVERSAL:
  // works for staff with no email (paste into a WhatsApp/SMS group).
  // Mints in PARALLEL (a sequential await-loop crawled on a cold backend and
  // blew past the clipboard's user-gesture window for big teams). Cached
  // links resolve instantly, so re-copying is a no-op round-trip.
  const copySelectedLinks = async () => {
    const chosen = activeStaff.filter((s) => shareSel.has(s.id));
    if (chosen.length === 0) return;
    setShareBusy(true);
    try {
      const results = await Promise.all(
        chosen.map(async (m) => {
          try {
            return `${m.name} — ${await mintLinkFor(m)}`;
          } catch {
            return null; // skip per-staff failures; keep the rest
          }
        })
      );
      const lines = results.filter(Boolean);
      if (lines.length) {
        await _writeClipboard(lines.join("\n"));
        setShareCopiedN(lines.length);
        setTimeout(() => setShareCopiedN(0), 4000);
      }
    } finally {
      setShareBusy(false);
    }
  };

  const shareEmailableCount = () =>
    activeStaff.filter(
      (s) => shareSel.has(s.id) && (s.email || "").includes("@")
    ).length;

  /* ─── Render ─── */
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        eyebrow="STAFF"
        title={t("staffSchedule") || "Staff Schedule"}
        subtitle={t("staffScheduleDesc") || "Plan weekly shifts, manage staff, and track labor costs."}
      />

      {/* Live punch-clock — who's on the clock right now (staff self-clock
          from their portal, auto-updates ~30s). Hides when nobody's in. */}
      <ClockedInStrip />

      {/* Clock-in location lock (opt-in geofence). */}
      <ClockGeofenceSettings />

      {/* Fravær (ferie/sygdom) that need godkend/afvis. Interrupt-only —
          hides itself when nothing is pending. This card had no mount point
          anywhere in the app before; the Vagtplan is its natural home since
          the owner manages staff here. */}
      <SickCallNotificationCard />

      {/* Peer-confirmed shift swaps awaiting the owner's final approve/deny.
          Interrupt-only — hides when none pending. Built + endpoint-backed
          (/staff/swap-requests) but had no mount point before the 2026-07-01
          trust sweep, so the owner could never act on accepted swaps. */}
      <SwapRequestNotificationCard />

      {/* "3 of 4 staff confirmed this week's schedule" — the owner half of the
          bidirectional confirmation loop. Self-hides when nothing is published
          or once everyone has confirmed. */}
      <ScheduleConfirmationCard />

      {/* Week navigation + actions */}
      <FadeIn delay={0.05}>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* Week nav */}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={goToPrevWeek}>
                {"\u2190"} {t("schedPrevWeek", "Previous")}
              </Button>
              <button
                onClick={goToCurrentWeek}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 min-w-[220px] text-center hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                {formatWeekRange(weekStart)}
              </button>
              <Button variant="secondary" size="sm" onClick={goToNextWeek}>
                {t("schedNextWeek", "Next")} {"\u2192"}
              </Button>
            </div>

            {/* Action buttons — one accent (Publish = the money moment),
                rest secondary / ghost. */}
            {/* Mobile-first toolbar: 7 actions in one row.  On phones the
                verbose labels (Copy Last Week, Share with staff, Email
                staff) collapse to icon-only with title-tooltips, so they
                fit a 375px viewport in 2 rows max. Tablet+ shows full
                labels. */}
            <div className="flex items-center gap-2 flex-wrap justify-center sm:justify-end w-full sm:w-auto">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShiftModal({ staffId: null, date: null, shift: null })}
                iconLeft={<Icon name="Plus" size={14} />}
                title={t("schedAddShiftTitle", "Add shift")}
              >
                <span className="hidden sm:inline">{t("schedAddShift", "Add Shift")}</span>
                <span className="sm:hidden">{t("schedAddShort", "Add")}</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyLastWeek}
                disabled={copying}
                busy={copying}
                title={t("schedCopyLastWeekTitle", "Copy last week's schedule")}
                iconLeft={!copying && <Icon name="Copy" size={14} />}
              >
                {copying
                  ? "…"
                  : (<>
                      <span className="hidden sm:inline">{t("schedCopyLastWeek", "Copy Last Week")}</span>
                      <span className="sm:hidden">{t("schedCopyShort", "Copy")}</span>
                    </>)}
              </Button>
              {/* Autopilot (Pro+ killer feature) — proposes next week's
                  schedule from 8 weeks of sales + the 7-day forecast +
                  staff hourly cost. Tier-gated: Starter/Free see an
                  UpgradeNudge dialog on click; Pro/Trial run it. */}
              <Button
                variant="primary"
                size="sm"
                onClick={handleRunAutopilot}
                disabled={autopilotLoading}
                busy={autopilotLoading}
                iconLeft={!autopilotLoading && <Icon name="Sparkles" size={14} />}
                title={t(
                  "autopilotTitle",
                  "Let BonBox propose next week's schedule from your data"
                )}
              >
                {autopilotLoading
                  ? t("autopilotRunning", "…")
                  : t("autopilotButton", "Autopilot")}
              </Button>
              <Button
                variant={draftCount > 0 ? "accent" : "secondary"}
                size="sm"
                onClick={requestPublish}
                disabled={publishing}
                busy={publishing}
                title={draftCount > 0 ? t("schedPublishWeekTitle", "Publish week") : t("schedAllPublishedTitle", "All shifts published")}
              >
                {publishing ? (
                  "…"
                ) : draftCount > 0 ? (
                  <>
                    <span className="hidden sm:inline">{t("publishConfirmCta", "Publish Week")}</span>
                    <span className="sm:hidden">{t("publishShort", "Publish")}</span>
                    <span className="ml-1 tabular-nums opacity-80">· {draftCount}</span>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="CheckCircle2" size={14} />
                    {t("publishedState", "Published")}
                  </span>
                )}
              </Button>
              {/* PDF export — owners print this and pin it on the
                  back-of-house staff board. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExportPdf}
                disabled={exporting}
                iconLeft={<Icon name="FileText" size={14} />}
                title={t("schedulePdfTitle") || "Export schedule as PDF (for the staff board)"}
              >
                {exporting ? "…" : "PDF"}
              </Button>
              {/* Beskeder — owner ↔ staff 1:1 chat launcher. Unread badge polls
                  the cheap aggregate endpoint; opening the drawer marks read. */}
              <button
                onClick={() => setChatOpen(true)}
                title={t("ownerChatTitle", "Messages")}
                className="relative inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
              >
                <Icon name="MessageSquare" size={14} />
                <span className="hidden sm:inline">{t("navMessages", "Messages")}</span>
                {chatUnread > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[16px] text-center">
                    {chatUnread > 9 ? "9+" : chatUnread}
                  </span>
                )}
              </button>
              {/* Share with staff (Staff v2, Starter+) — mints/refreshes
                  StaffLink magic-links and emails each staff their personal
                  portal URL. The portal becomes the live coordination loop
                  (push notifications, shift confirmations, swap requests).
                  Icon-only on mobile keeps the toolbar from overflowing. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={openShareSheet}
                disabled={sharing || emailing || exporting}
                busy={sharing}
                iconLeft={!sharing && <Icon name="Link2" size={14} />}
                title={t(
                  "scheduleShareTitle",
                  "Send every staff a personal portal link — they bookmark it once and get push when the schedule changes"
                )}
              >
                {sharing
                  ? "…"
                  : (<>
                      <span className="hidden sm:inline">{t("scheduleShareButton", "Share with staff")}</span>
                      <span className="sm:hidden">{t("scheduleShareButtonShort", "Share")}</span>
                    </>)}
              </Button>
              {/* Email schedule to all active staff. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleEmailToStaff}
                disabled={emailing || exporting || sharing}
                busy={emailing}
                iconLeft={!emailing && <Icon name="Send" size={14} />}
                title={t("scheduleEmailTitle", "Email the week's schedule to every staff member with an email on file")}
              >
                {emailing
                  ? "…"
                  : (<>
                      <span className="hidden sm:inline">{t("scheduleEmailButton", "Email staff")}</span>
                      <span className="sm:hidden">{t("scheduleEmailButtonShort", "Email")}</span>
                    </>)}
              </Button>
            </div>
          </div>
        </div>
      </FadeIn>

      {/* C7 — Forecast & demand (weather-smart + smart-staffing), collapsed
          by default. Sits between the week toolbar and the grid so the
          owner can glance at next week's weather + recommended headcount
          while planning, without it dominating the page. */}
      <FadeIn delay={0.07}>
        <ScheduleForecastPanel />
      </FadeIn>

      {/* Error banner */}
      {error && (
        <SectionBanner
          severity="critical"
          title={error}
          icon="AlertTriangle"
          onDismiss={() => setError("")}
        />
      )}
      {/* Email-success toast (auto-dismisses after 7s \u2014 see handleEmailToStaff) */}
      {emailToast && (
        <SectionBanner
          severity="success"
          title={emailToast}
          icon="CheckCircle2"
          onDismiss={() => setEmailToast("")}
        />
      )}
      {/* Share-success toast (auto-dismisses after 7s \u2014 see handleShareWithStaff) */}
      {shareToast && (
        <SectionBanner
          severity="success"
          title={shareToast}
          icon="Link2"
          onDismiss={() => setShareToast("")}
        />
      )}
      {/* Autopilot-success toast (auto-dismisses after 7s) */}
      {autopilotToast && (
        <SectionBanner
          severity="success"
          title={autopilotToast}
          icon="Sparkles"
          onDismiss={() => setAutopilotToast("")}
        />
      )}
      {/* (Publish success now lives in the PublishConfirmModal's success state —
          a durable ✓ panel with the server's real counts, not a fleeting toast.
          The old publishToast SectionBanner was removed with its state.) */}

      {/* Autopilot suggestion review panel \u2014 Pro killer feature (Task #50).
          Renders ONLY when a suggestion is loaded. Owner reviews per-day
          predictions + suggested shifts then taps Apply (materializes draft
          rows) or Discard. */}
      {autopilotSuggestion && (
        <FadeIn delay={0.02}>
          <AutopilotPanel
            suggestion={autopilotSuggestion}
            currency={currency}
            staff={staff}
            applying={autopilotApplying}
            onApply={handleApplyAutopilot}
            onDiscard={() => setAutopilotSuggestion(null)}
            t={t}
          />
        </FadeIn>
      )}


      {/* Manage Staff collapsible */}
      <FadeIn delay={0.1}>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setShowManageStaff(!showManageStaff)}
            aria-expanded={showManageStaff}
            className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 transition rounded-xl"
          >
            <span className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Icon name="Users" size={16} className="text-gray-500" /> {t("schedManageStaff", "Manage Staff")}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                ({activeStaff.length} {t("schedActiveCount", "active")})
              </span>
            </span>
            <Icon name="ChevronDown" size={16} className={`text-gray-500 transition-transform ${showManageStaff ? "rotate-180" : ""}`} />
          </button>
          {showManageStaff && (
            <StaffPanel
              staff={staff}
              currency={currency}
              onRefresh={fetchStaff}
              branchId={branchId}
            />
          )}
        </div>
      </FadeIn>

      {/* Color legend */}
      <FadeIn delay={0.12}>
        <div className="flex items-center gap-4 flex-wrap text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium">{t("schedShiftColors", "Shift colors:")}</span>
          {Object.entries(ROLE_COLORS).map(([key, c]) => (
            <span key={key} className="flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded-full ${c.dot}`} />
              {t(ROLE_LABEL_KEY[key] || "", c.label)}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-gray-300 dark:bg-gray-600" />
            {t("schedOffNoShift", "OFF / No shift")}
          </span>
        </div>
      </FadeIn>

      {/* Saved shift presets — tap a chip to arm it, then tap a day to drop it. */}
      {!loading && activeStaff.length > 0 && (
        <FadeIn delay={0.13}>
          <ShiftTemplatesTray
            templates={shiftTemplates}
            armedId={armedTemplateId}
            onArm={setArmedTemplateId}
            onAddClick={() => setShowTemplateModal(true)}
            onRemove={removeTemplate}
            t={t}
          />
        </FadeIn>
      )}

      {/* Schedule Grid */}
      <FadeIn delay={0.15}>
        {loading ? (
          <GridSkeleton />
        ) : activeStaff.length === 0 ? (
          <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Ghosted grid backdrop — first-run still reads as "this is where
                your week lives"; the real first step is adding the team. */}
            <div className="pointer-events-none absolute inset-0 opacity-[0.35] dark:opacity-[0.18]" aria-hidden="true">
              <div className="grid grid-cols-7 gap-px p-4">
                {Array.from({ length: 28 }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-10 rounded-md ${i % 4 === 0 ? "bg-gray-200 dark:bg-gray-700" : "bg-gray-100 dark:bg-gray-700/40"}`}
                  />
                ))}
              </div>
            </div>
            <div className="relative px-6 py-14 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-900 text-white">
                <Icon name="CalendarDays" size={22} />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t("schedFirstRunTitle", "Build your first schedule")}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
                {t("schedFirstRunBody", "Add your team, then plan a week of shifts in seconds — click a day to drop a shift, or let Autopilot draft it.")}
              </p>
              <button
                type="button"
                onClick={() => setShowManageStaff(true)}
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gray-900 text-white px-5 py-2.5 text-sm font-semibold hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
              >
                <Icon name="Users" size={16} />
                {t("schedFirstRunCta", "Add staff members")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Desktop / tablet grid — tablets in portrait (≥ md = 768px)
                still get the full week table since they have the width.
                Phones in landscape at 640px deserve the mobile day-list
                experience, hence `md:` not `sm:`. */}
            <div className="hidden md:block">
              <ScheduleGrid
                staff={activeStaff}
                weekDates={weekDates}
                getShiftForCell={getShiftForCell}
                unavailFor={unavailFor}
                absenceFor={absenceFor}
                costForShift={costForShift}
                showCost={showCost}
                currency={currency}
                dailyCost={weekCost?.daily || null}
                costBasis={costBasis}
                targetPct={targetPct}
                t={t}
                onMoveShift={moveShift}
                onCellClick={(staffId, date, existingShift) =>
                  existingShift
                    ? setShiftModal({ staffId, date: toISO(date), shift: existingShift })
                    : bloomDraft(staffId, date, (activeStaff.find((m) => m.id === staffId) || {}).role)
                }
              />
            </div>
            {/* Mobile day-at-a-time list. Default day = today (within the
                current week range). Swipe arrows + day-strip switch the
                visible day. Same setShiftModal so the edit flow is
                identical across viewports. */}
            <div className="md:hidden">
              <MobileSchedule
                staff={activeStaff}
                weekDates={weekDates}
                getShiftForCell={getShiftForCell}
                unavailFor={unavailFor}
                absenceFor={absenceFor}
                currency={currency}
                costForShift={costForShift}
                showCost={showCost}
                weekCost={weekCost}
                costBasis={costBasis}
                targetPct={targetPct}
                t={t}
                onCellClick={(staffId, date, existingShift) =>
                  existingShift
                    ? setShiftModal({ staffId, date: toISO(date), shift: existingShift })
                    : bloomDraft(staffId, date, (activeStaff.find((m) => m.id === staffId) || {}).role)
                }
              />
            </div>
          </>
        )}
      </FadeIn>

      {/* Åbne vagter — unassigned slots staff claim one-tap. Portal-backed, so
          shown only for paid plans (Free can't share/claim); the create call is
          still server-gated on staff_portal_link as the real barrier. */}
      {user?.plan !== "free" && (
        <FadeIn delay={0.15}>
          <OpenShiftsPanel weekStart={weekStart} t={t} />
        </FadeIn>
      )}

      {/* Week summary bar — the live labor-cost headline. Hidden on mobile;
          MobileSchedule embeds the per-day cost + labor% strip inline, so a
          second summary here would be redundant. Hours/cost fall back to the
          client `stats` when the cost endpoint is unavailable; labor% only
          shows when the server returned revenue (never fabricated). */}
      <FadeIn delay={0.2}>
        <div className="hidden md:block bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-5">
            {/* Left: quiet KPI strip — scheduled hours · labor cost · staff.
                Stacked micro-label/value pairs so they read as calm context
                under the labor% hero, not a run-on sentence. */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              <div className="flex items-center gap-2.5">
                <Icon name="Clock" size={16} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                <div className="leading-tight">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    {t("schedTotalHours")}
                  </div>
                  <div className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    {weekSummary.hours}h
                  </div>
                </div>
              </div>

              <span className="hidden sm:block w-px h-9 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

              <div className="flex items-center gap-2.5">
                <Icon name="Banknote" size={16} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                <div className="leading-tight">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    <span>{t("schedTotalCost")}</span>
                    {costBasis === "loaded" && (
                      <span className="normal-case tracking-normal font-normal text-gray-400 dark:text-gray-500">
                        · {t("schedCostLoadedNote")}
                      </span>
                    )}
                  </div>
                  <div className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    ≈ {formatKr(weekSummary.cost, { decimals: 0 })}
                  </div>
                </div>
              </div>

              <span className="hidden sm:block w-px h-9 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

              <div className="flex items-center gap-2.5">
                <Icon name="Users" size={16} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                <div className="leading-tight">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    {t("schedStaffActive")}
                  </div>
                  <div className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                    {stats.activeCount}
                  </div>
                </div>
              </div>
            </div>

            {/* Right: labor% hero + cost controls */}
            <div className="flex items-center gap-5">
              {/* Labor % — the hero number, color-coded vs target. Set off by a
                  divider and sized well above the context metrics so it reads
                  first. */}
              <div className="text-right border-l border-gray-200 dark:border-gray-700 pl-5">
                <div className="flex items-center justify-end gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  <Icon name="TrendingUp" size={13} />
                  <span>{t("schedLaborPct")}</span>
                </div>
                {weekSummary.hasRevenue && weekSummary.laborPct != null ? (
                  <>
                    <div
                      className={`text-4xl font-bold leading-none tracking-tight tabular-nums mt-1 ${laborTone(
                        weekSummary.laborPct,
                        targetPct
                      )}`}
                    >
                      {pctLabel(weekSummary.laborPct)}
                    </div>
                    {targetPct != null && (
                      <div className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums mt-1">
                        {t("schedLaborTarget")} {pctLabel(targetPct)}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-4xl font-bold leading-none tracking-tight tabular-nums text-gray-300 dark:text-gray-600 mt-1">
                      —
                    </div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500 max-w-[13rem] leading-snug mt-1">
                      {t("schedLaborNoRev")}
                    </div>
                  </>
                )}
              </div>

              <CostControls
                showCost={showCost}
                onToggleShowCost={() => setShowCost((v) => !v)}
                costBasis={costBasis}
                onCostBasis={setCostBasis}
                t={t}
              />
            </div>
          </div>
          <p className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700/60 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
            {t("schedCostEstimateNote")}
          </p>
        </div>
      </FadeIn>

      {/* Click-to-bloom undo — a calm one-tap Fortryd for the just-added draft.
          Auto-dismisses after ~6s. Drafts never notify, so this is purely a
          local convenience (no "unsend"). */}
      {undoShift && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-gray-900 text-white px-4 py-2.5 shadow-lg">
          <span className="text-sm">{t("schedShiftAdded", "Shift added as draft")}</span>
          <button
            type="button"
            onClick={undoBloom}
            className="text-sm font-semibold underline underline-offset-2"
          >
            {t("schedUndo", "Undo")}
          </button>
        </div>
      )}

      {/* Drag-to-move undo — a calm one-tap Fortryd for the just-moved shift.
          Auto-dismisses after ~6s. A move never changes the time, so a published
          shift is NOT re-notified by the move (or by this undo). */}
      {undoMove && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-gray-900 text-white px-4 py-2.5 shadow-lg">
          <span className="text-sm">{t("schedMoved", "Shift moved")}</span>
          <button
            type="button"
            onClick={undoMoveAction}
            className="text-sm font-semibold underline underline-offset-2"
          >
            {t("schedUndo", "Undo")}
          </button>
        </div>
      )}

      {/* Shift Modal */}
      {showTemplateModal && (
        <TemplateCreateModal
          t={t}
          onClose={() => setShowTemplateModal(false)}
          onSave={addTemplate}
        />
      )}

      {shiftModal && (
        <ShiftModal
          modal={shiftModal}
          staff={activeStaff}
          shifts={shifts}
          weekDates={weekDates}
          lastTemplate={lastShiftTemplate}
          onTemplateSave={setLastShiftTemplate}
          onClose={() => setShiftModal(null)}
          onSaved={() => {
            setShiftModal(null);
            fetchShifts();
          }}
          branchId={branchId}
        />
      )}

      {/* Owner ↔ staff chat ("Beskeder") slide-over. Self-contained — owns its
          own fetches; onUnreadChange keeps the launcher badge honest. */}
      <OwnerChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onUnreadChange={setChatUnread}
      />

      {/* Publish-confirm sheet — the deliberate gate before draft shifts go
          live to staff. Shows what's about to change in one calm glance. */}
      {publishConfirm && (
        <PublishConfirmModal
          summary={publishConfirm}
          result={publishResult}
          currency={currency}
          weekStart={weekStart}
          publishing={publishing}
          onConfirm={confirmPublish}
          onClose={() => {
            setPublishConfirm(null);
            setPublishResult(null);
          }}
          t={t}
        />
      )}

      {/* Upgrade nudge — Free/Starter user trying bulk-email-staff
          (Pro+). The PDF download button stays available so they
          can still print or paste a link into WhatsApp. */}
      {upgradeNudge && (
        <UpgradeNudge
          intent="dialog"
          tier={upgradeNudge.tier}
          benefit={upgradeNudge.benefit}
          icon={upgradeNudge.icon}
          ctaLabel={t("nudgeSeePlans", "See plans")}
          onTry={() => setUpgradeNudge(null)}
        />
      )}

      {/* Unified Share sheet — Select all / per-staff, then Copy links
          (universal — works without email) or Email those with an address. */}
      {shareSheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShareSheet(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg max-w-md w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="p-5 pb-3 border-b border-gray-100 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-gray-900 dark:text-white">
                  {t("shareScheduleTitle", "Share this week's schedule")}
                </h3>
                <button onClick={() => setShareSheet(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t("shareScheduleSub", "Pick who to share with. The link needs no account — staff just open it.")}
              </p>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
                {t("shareJoinCodeHint", "No link? Staff can type their code at bonbox.dk/join.")}
              </p>
              <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={shareAllSelected()}
                  onChange={toggleShareAll}
                  className="w-4 h-4 rounded accent-gray-900 dark:accent-gray-100"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t("shareSelectAll", "Select all")}
                  <span className="text-gray-400 dark:text-gray-500 font-normal"> · {shareSel.size}/{shareActiveStaff().length}</span>
                </span>
              </label>
            </div>
            {/* Staff list */}
            <div className="flex-1 overflow-y-auto p-2">
              {shareActiveStaff().map((s) => {
                const sel = shareSel.has(s.id);
                const hasEmail = (s.email || "").includes("@");
                return (
                  <label
                    key={s.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer ${sel ? "bg-gray-50 dark:bg-gray-700/40" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={sel}
                      onChange={() => toggleShareOne(s.id)}
                      className="w-4 h-4 rounded accent-gray-900 dark:accent-gray-100"
                    />
                    <div className="w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-600 dark:text-gray-300 flex-shrink-0">
                      {(s.name || "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{s.name}</div>
                      <div className="text-[11px] text-gray-400 dark:text-gray-500 truncate flex items-center gap-1.5">
                        <span className="truncate">
                          {hasEmail ? `📧 ${s.email}` : t("shareNoEmail", "link only — no email")}
                        </span>
                        {shareCodes[s.id] && (
                          <span className="shrink-0 font-mono font-semibold tracking-wider text-gray-600 dark:text-gray-300">
                            · {t("shareJoinCodeShort", "code")} {shareCodes[s.id]}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); copyOneLink(s); }}
                      className="text-[11px] px-2 py-1 rounded text-emerald-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex-shrink-0"
                    >
                      {shareRowCopied === s.id ? "✓" : t("shareCopyOne", "copy")}
                    </button>
                  </label>
                );
              })}
            </div>
            {/* Footer actions */}
            <div className="p-4 border-t border-gray-100 dark:border-gray-700 space-y-2">
              <button
                onClick={copySelectedLinks}
                disabled={shareBusy || shareSel.size === 0}
                className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:opacity-50 transition"
              >
                {shareBusy
                  ? t("shareWorking", "Preparing…")
                  : shareCopiedN > 0
                    ? `✓ ${shareCopiedN} ${t("shareCopiedLinks", "links copied")}`
                    : `📋 ${t("shareCopyLinks", "Copy")} ${shareSel.size} ${shareSel.size === 1 ? t("shareLinkWord", "link") : t("shareLinksWord", "links")}`}
              </button>
              <button
                onClick={() => { setShareSheet(false); handleShareWithStaff(); }}
                disabled={sharing || shareEmailableCount() === 0}
                className="w-full px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 transition"
                title={shareEmailableCount() === 0 ? t("shareNoEmailable", "No selected staff have an email") : ""}
              >
                📧 {t("shareEmailWithAddress", "Email those with an address")}
                {shareEmailableCount() > 0 ? ` (${shareEmailableCount()})` : ""}
              </button>
              <p className="text-[11px] text-gray-400 dark:text-gray-600 text-center">
                {t("shareFootNote", "Paste copied links into WhatsApp or SMS — works for staff without email.")}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   AUTOPILOT REVIEW PANEL (Task #50 — Pro killer feature)

   Renders the AutopilotSuggestion the backend returned:
     • Header: week + predicted revenue, suggested cost, savings vs last week
     • Per-day card: weather chip, predicted revenue, suggested shifts table
     • Compliance warnings as amber chips
     • Apply (materializes draft Schedule rows) / Discard
   ═══════════════════════════════════════════════════════════ */
function weatherChip(weather) {
  if (!weather) return "";
  const t = weather.temp_c;
  const p = weather.precipitation_mm;
  let icon = "🌤️";
  if (weather.summary === "rainy") icon = "🌧️";
  else if (weather.summary === "sunny") icon = "☀️";
  else if (weather.summary === "cold") icon = "❄️";
  else if (weather.summary === "cloudy") icon = "☁️";
  const parts = [icon];
  if (t !== null && t !== undefined) parts.push(`${Math.round(t)}°C`);
  if (p && p >= 0.5) parts.push(`${p.toFixed(1)}mm`);
  return parts.join(" ");
}

function formatDayShort(iso) {
  const d = new Date(iso + "T00:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

function AutopilotPanel({ suggestion, currency, applying, onApply, onDiscard, t }) {
  // On phones the 7 day-cards stack into one ~1,200px column. Collapse them
  // behind a disclosure so the week summary + Apply/Discard stay above the
  // fold; always expanded from `sm:` up (desktop layout unchanged).
  const [showDays, setShowDays] = useState(false);
  const totalRevenue = suggestion.days.reduce(
    (sum, d) => sum + (d.predicted_revenue || 0),
    0
  );
  const compared = suggestion.compared_to_last_week || {};
  const dayCount = suggestion.days.length;
  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold tracking-wider uppercase text-gray-500 dark:text-gray-400">
            <Icon name="Sparkles" size={12} className="inline-block -mt-0.5 mr-1 text-gray-400 dark:text-gray-500" />
            {t("autopilotHeading", "Autopilot Suggestion")} ·{" "}
            {suggestion.confidence === "high"
              ? t("autopilotConfidenceHigh", "High confidence")
              : suggestion.confidence === "medium"
              ? t("autopilotConfidenceMedium", "Medium confidence")
              : t("autopilotConfidenceLow", "Low confidence — limited data")}
          </p>
          <h3 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white mt-0.5">
            {t("autopilotWeekOf", "Week of")} {formatDayShort(suggestion.week_start)}
          </h3>
          <div className="text-xs text-gray-600 dark:text-gray-400 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              {t("autopilotPredicted", "Predicted")}:{" "}
              <strong className="text-gray-900 dark:text-white">
                {totalRevenue.toLocaleString()} {currency}
              </strong>
            </span>
            <span>
              {t("autopilotLabor", "Suggested labor")}:{" "}
              <strong className="text-gray-900 dark:text-white">
                ≈ {Math.round(suggestion.week_total_cost).toLocaleString()} {currency}
              </strong>{" "}
              <span className="text-gray-500">
                · {suggestion.week_total_hours.toFixed(1)}h
              </span>
            </span>
            {totalRevenue > 0 && (
              <span>
                {t("schedLaborPct", "Labor %")}:{" "}
                <strong className={laborTone(suggestion.week_total_cost / totalRevenue, suggestion.basis?.target_labor_pct ?? null)}>
                  {pctLabel(suggestion.week_total_cost / totalRevenue)}
                </strong>
                {(suggestion.basis?.target_labor_pct ?? null) != null && (
                  <span className="text-gray-500">
                    {" "}· {t("schedLaborTarget", "target")} {pctLabel(suggestion.basis.target_labor_pct)}
                  </span>
                )}
              </span>
            )}
            {compared.savings_label && (
              <span
                className={
                  compared.delta_pct < 0
                    ? "text-gray-700 dark:text-emerald-400 font-medium"
                    : "text-amber-700 dark:text-amber-400"
                }
              >
                {compared.savings_label}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 w-full sm:w-auto">
          <button
            type="button"
            onClick={onDiscard}
            disabled={applying}
            className="flex-1 sm:flex-none px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-50"
          >
            {t("autopilotDiscard", "Discard")}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={applying}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50"
          >
            {applying ? (
              t("autopilotApplying", "Applying…")
            ) : (
              <>
                <Icon name="Check" size={15} />
                {t("autopilotApply", "Apply schedule")}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Compliance warnings */}
      {suggestion.compliance_warnings && suggestion.compliance_warnings.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestion.compliance_warnings.map((w, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs"
            >
              <Icon name="AlertTriangle" size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
              {w}
            </span>
          ))}
        </div>
      )}

      {/* Per-day cards — collapsed by default on phones (toggle below); the
          grid is always shown from `sm:` up so desktop is unchanged. */}
      <button
        type="button"
        onClick={() => setShowDays((v) => !v)}
        aria-expanded={showDays}
        className="sm:hidden w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-200"
      >
        <span>
          {showDays
            ? t("autopilotHideDays", "Hide daily plan")
            : t("autopilotShowDays", "View daily plan")}{" "}
          <span className="text-gray-400 font-normal tabular-nums">· {dayCount}</span>
        </span>
        <Icon
          name="ChevronDown"
          size={16}
          className={`transition-transform ${showDays ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`${showDays ? "grid" : "hidden"} sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3`}
      >
        {suggestion.days.map((day) => (
          <div
            key={day.date}
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-2.5 sm:p-3 space-y-1.5 sm:space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                  {day.weekday}
                </div>
                <div className="text-[11px] text-gray-500">
                  {formatDayShort(day.date)}
                </div>
              </div>
              <div className="text-xs text-gray-700 dark:text-gray-300 text-right whitespace-nowrap">
                {weatherChip(day.weather)}
              </div>
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5 sm:block sm:space-y-0.5">
              <div>
                {t("autopilotRevenue", "Revenue")}:{" "}
                <span className="text-gray-800 dark:text-gray-200 font-medium">
                  {Math.round(day.predicted_revenue || 0).toLocaleString()} {currency}
                </span>
              </div>
              <div>
                {t("autopilotDemand", "Demand")}:{" "}
                <span className="text-gray-800 dark:text-gray-200 font-medium">
                  {day.predicted_demand_hours.toFixed(1)}h
                </span>
              </div>
            </div>
            {day.shifts && day.shifts.length > 0 ? (
              <ul className="space-y-1">
                {day.shifts.map((s, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between text-xs gap-2 bg-gray-50 dark:bg-gray-900/40 px-2 py-1 sm:py-1.5 rounded-md"
                  >
                    <span className="truncate">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {s.staff_name}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">
                        {" "}
                        · {s.start}-{s.end}
                      </span>
                      {s.break_minutes > 0 && (
                        <span className="text-gray-400">
                          {" "}
                          · {s.break_minutes}m brk
                        </span>
                      )}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400 shrink-0">
                      ≈ {Math.round(s.cost)} {currency}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] italic text-gray-400 px-2 py-1.5">
                {t("autopilotNoShifts", "No shifts proposed")}
              </div>
            )}
            <div className="text-[11px] font-medium text-gray-700 dark:text-gray-300 border-t border-gray-100 dark:border-gray-700 pt-1.5">
              {t("autopilotTotal", "Total")}:{" "}
              ≈ {Math.round(day.total_cost).toLocaleString()} {currency}
              <span className="text-gray-400 font-normal">
                {" "}
                · {day.total_hours.toFixed(1)}h
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   STAFF DETAIL / EDIT MODAL  (Staff v2, #336)
   ═══════════════════════════════════════════════════════════

   Owners asked for a real "click a staff member → see + edit their
   details" surface instead of the cramped inline form that expanded a
   row. This is that surface: a centred card on desktop, a bottom-sheet /
   near-full-screen panel on mobile (notch-safe).

   It owns NO save logic of its own — every mutation is delegated to the
   handlers passed down from StaffPanel (handleUpdate / generateLink /
   handleDeactivate) so the endpoints + payloads stay byte-identical to
   the old inline path. The modal only drives `editForm` (the same shared
   state) via onChange and decides when to call those handlers.

   Props:
     member     — the staff row being viewed (name, role, email, phone,
                  contract_type, base_rate, is_active, …). null = closed.
     editForm   — shared edit state (already populated by openDetail).
     setEditForm
     currency   — "DKK" gates the Trækkort row (same rule as inline form).
     saving     — true while a save/PUT is in flight.
     rates      — { base, evening, weekend, holiday } from getRateCard.
     onSave     — () => handleUpdate(member.id) ; resolves true on success.
     onClose    — close without saving.
     onShare    — () => generateLink(member).
     onDeactivate — () => handleDeactivate(member.id).
     t          — translator from useLanguage.
*/
function StaffDetailModal({
  member,
  editForm,
  setEditForm,
  currency,
  saving,
  rates,
  onSave,
  onClose,
  onShare,
  onDeactivate,
  t,
}) {
  const cardRef = useRef(null);
  // Hold the latest onClose in a ref so the focus/Esc effect can depend only
  // on `member` (open/close). Without this, the parent re-renders on every
  // keystroke (editForm lives in StaffPanel), `onClose` gets a new identity,
  // the effect re-runs, and focus snaps back to the first field mid-typing.
  // The ref is updated in an effect (never during render) to satisfy the
  // react-hooks/refs lint rule.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Esc to close + focus management. We trap focus loosely: on open we
  // move focus into the dialog (first focusable / the card itself) and a
  // keydown handler keeps Tab within the card. Restores focus to whatever
  // was focused before open on unmount.
  useEffect(() => {
    if (!member) return undefined;
    const prevActive = document.activeElement;
    const card = cardRef.current;

    const focusables = () =>
      card
        ? Array.from(
            card.querySelectorAll(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];

    // Move focus into the dialog (name field if present, else the card).
    const first = focusables()[0];
    if (first) first.focus();
    else if (card) card.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    // Lock background scroll while the sheet/dialog is up.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      if (prevActive && typeof prevActive.focus === "function") prevActive.focus();
    };
    // Depend only on `member` — onClose is read via onCloseRef so the effect
    // doesn't tear down on every parent re-render (keystroke).
  }, [member]);

  if (!member) return null;

  const cat = ROLE_CATEGORY[member.role] || "floor";
  const colors = ROLE_COLORS[cat];
  const isInactive = member.is_active === false;
  const initial = (member.name || "?").trim().charAt(0).toUpperCase() || "?";

  // Shared input styling — rounded-xl, focus ring, dark mode.
  const inputCls =
    "w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none transition";
  const labelCls =
    "block text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5";

  const handleSave = async () => {
    const ok = await onSave();
    if (ok) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 sm:p-4"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("staffDetailsTitle", "Staff details") + " — " + member.name}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 max-h-[92vh] sm:max-h-[88vh] flex flex-col outline-none"
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-gray-100 dark:border-gray-700">
          <div className="flex-shrink-0 w-11 h-11 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-base font-semibold">
            {initial}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-gray-900 dark:text-white truncate">
                {member.name}
              </h2>
              <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${colors.bg} ${colors.text}`}>
                {member.role}
              </span>
              {isInactive && (
                <span className="text-xs text-red-500 font-medium">{t("inactive")}</span>
              )}
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {CONTRACT_TYPES.find((c) => c.value === member.contract_type)?.label || member.contract_type}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            className="flex-shrink-0 p-1.5 -mr-1 -mt-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — scrolls if it overflows */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Name */}
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="sd-name">{t("staffName", "Name")}</label>
              <input
                id="sd-name"
                type="text"
                value={editForm.name || ""}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className={inputCls}
                placeholder={t("staffName", "Name")}
              />
            </div>
            {/* Role */}
            <div>
              <label className={labelCls} htmlFor="sd-role">{t("staffRole", "Role")}</label>
              <select
                id="sd-role"
                value={editForm.role || ""}
                onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                className={inputCls}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            {/* Contract type */}
            <div>
              <label className={labelCls} htmlFor="sd-contract">{t("contractType", "Contract type")}</label>
              <select
                id="sd-contract"
                value={editForm.contract_type || ""}
                onChange={(e) => setEditForm({ ...editForm, contract_type: e.target.value })}
                className={inputCls}
              >
                {CONTRACT_TYPES.map((ct) => (
                  <option key={ct.value} value={ct.value}>{ct.label}</option>
                ))}
              </select>
            </div>
            {/* Email */}
            <div>
              <label className={labelCls} htmlFor="sd-email">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3 h-3" /> {t("staffEmail", "Email")}
                </span>
              </label>
              <input
                id="sd-email"
                type="email"
                value={editForm.email || ""}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                className={inputCls}
                placeholder={t("optional", "Optional")}
              />
            </div>
            {/* Phone */}
            <div>
              <label className={labelCls} htmlFor="sd-phone">
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="w-3 h-3" /> {t("staffPhone", "Phone")}
                </span>
              </label>
              <input
                id="sd-phone"
                type="tel"
                value={editForm.phone || ""}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                className={inputCls}
                placeholder={t("optional", "Optional")}
              />
            </div>
            {/* Base rate */}
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="sd-rate">{t("baseRate")} ({currency}/hr)</label>
              <input
                id="sd-rate"
                type="number"
                value={editForm.base_rate ?? ""}
                onChange={(e) => setEditForm({ ...editForm, base_rate: e.target.value })}
                min="0"
                step="0.5"
                className={`${inputCls} tabular-nums`}
                placeholder={`${t("baseRate")} (${currency}/hr)`}
              />
            </div>
          </div>

          {/* Premium rates — OPTIONAL. Empty = paid at base (what most small
              DK venues do). A real kr/hr figure here flows into the schedule's
              ≈ labor cost (evening after 18:00, weekend Sat/Sun). The suggested
              values are a starting point, never auto-applied. Holiday is
              deliberately omitted until a DK helligdag calendar lands. */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("premiumRatesTitle", "Premium rates (optional)")}
              </p>
              {Number(editForm.base_rate) > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setEditForm({
                      ...editForm,
                      evening_rate: Math.round(Number(editForm.base_rate) * 1.25),
                      weekend_rate: Math.round(Number(editForm.base_rate) * 1.45),
                    })
                  }
                  className="text-[11px] font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2 hover:opacity-70"
                >
                  {t("premiumUseSuggested", "Use suggested")}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelCls} htmlFor="sd-evening">{t("rateEvening", "Evening")} ({currency}/hr)</label>
                <input
                  id="sd-evening"
                  type="number"
                  min="0"
                  step="0.5"
                  value={editForm.evening_rate ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, evening_rate: e.target.value })}
                  className={`${inputCls} tabular-nums`}
                  placeholder={rates.suggestedEvening ? `${t("egAbbrev", "e.g.")} ${rates.suggestedEvening}` : t("optional", "Optional")}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="sd-weekend">{t("rateWeekend", "Weekend")} ({currency}/hr)</label>
                <input
                  id="sd-weekend"
                  type="number"
                  min="0"
                  step="0.5"
                  value={editForm.weekend_rate ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, weekend_rate: e.target.value })}
                  className={`${inputCls} tabular-nums`}
                  placeholder={rates.suggestedWeekend ? `${t("egAbbrev", "e.g.")} ${rates.suggestedWeekend}` : t("optional", "Optional")}
                />
              </div>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              {t("premiumRatesHint", "Leave blank to pay base rate. Evening applies after 18:00, weekend on Sat/Sun — and flows into the schedule's labor cost.")}
            </p>
          </div>

          {/* Trækkort — DK only, same values + conversion as the old inline
              form. UI shows %, handleUpdate divides by 100 on submit. */}
          {currency === "DKK" && (
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 space-y-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Trækkort
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select
                  value={editForm.tax_card_type || ""}
                  onChange={(e) => setEditForm({ ...editForm, tax_card_type: e.target.value })}
                  className={inputCls}
                  title="Trækkort type — affects A-skat estimate"
                  aria-label="Trækkort type"
                >
                  <option value="">{t("auto")}</option>
                  <option value="hovedkort">Hovedkort (~36%)</option>
                  <option value="bikort">Bikort (~42%)</option>
                  <option value="frikort">Frikort (0%)</option>
                </select>
                <input
                  type="number"
                  value={editForm.tax_card_rate ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, tax_card_rate: e.target.value })}
                  placeholder={t("rateOverridePct")}
                  min="0"
                  max="60"
                  step="0.1"
                  className={`${inputCls} tabular-nums`}
                  title="Paste exact rate from employee's eSkattekort (0–60%)"
                  aria-label={t("rateOverridePct")}
                />
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                {t("trækkortHint")}
              </p>
            </div>
          )}

          {/* (Read-only rate card removed — base + evening/weekend are now
              editable inputs above, and Holiday is deferred until a DK
              helligdag calendar lands, so we never show a rate we can't
              honestly apply to the schedule's cost.) */}
        </div>

        {/* Footer — primary actions + secondary (share / deactivate).
            Notch-safe bottom padding for the mobile bottom-sheet. */}
        <div className="border-t border-gray-100 dark:border-gray-700 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? t("saving", "Saving…") : t("saveChanges", "Save changes")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
            >
              {t("cancel", "Cancel")}
            </button>
          </div>
          {!isInactive && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onShare}
                className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition"
              >
                <Link2 className="w-4 h-4" />
                {t("shareLink", "Share link")}
              </button>
              <button
                type="button"
                onClick={onDeactivate}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
              >
                <Trash2 className="w-4 h-4" />
                {t("deactivate", "Deactivate")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STAFF MANAGEMENT PANEL
   ═══════════════════════════════════════════════════════════ */
function StaffPanel({ staff, currency, onRefresh, branchId }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  // `user` is referenced below for the admin-only WhatsApp setup block
  // (`user?.is_admin`). The parent had it via useAuth() but sub-components
  // each need their own destructure — this exact pattern crashed the
  // panel with `ReferenceError: user is not defined` and bounced the
  // whole /staff/schedule page through the global error boundary.
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState(ROLES[0]);
  const [contractType, setContractType] = useState("full");
  const [baseRate, setBaseRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({});
  // The staff member currently open in the detail/edit modal (#336). The
  // modal owns the edit now; `editForm` is the shared draft state it drives.
  const [detailMember, setDetailMember] = useState(null);
  const [panelError, setPanelError] = useState("");
  const [linkModal, setLinkModal] = useState(null); // { staffName, portalUrl, loading }
  const [linkCopied, setLinkCopied] = useState(false);

  const generateLink = async (member) => {
    setLinkModal({ staffName: member.name, portalUrl: null, loading: true });
    try {
      const res = await api.post(`/staff/members/${member.id}/link`);
      const origin = window.location.origin;
      const fullUrl = `${origin}${res.data.portal_url}`;
      setLinkModal({ staffName: member.name, portalUrl: fullUrl, loading: false });
    } catch (err) {
      setPanelError(errText(err, "Failed to generate link"));
      setLinkModal(null);
    }
  };

  const copyLink = async () => {
    if (!linkModal?.portalUrl) return;
    try {
      await navigator.clipboard.writeText(linkModal.portalUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = linkModal.portalUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const shareLink = async () => {
    if (!linkModal?.portalUrl) return;
    if (navigator.share) {
      const restaurant = user?.business_name || "BonBox";
      const firstName = (linkModal.staffName || "").trim().split(/\s+/)[0] || linkModal.staffName;
      try {
        await navigator.share({
          title: t("scheduleShareLinkTitle", "Your schedule · {restaurant}", { restaurant }),
          text: t(
            "scheduleShareText",
            "Hi {name} 👋 Here's your personal link to your shifts, hours and tips at {restaurant}:",
            { name: firstName, restaurant },
          ),
          url: linkModal.portalUrl,
        });
      } catch { /* user cancelled */ }
    } else {
      copyLink();
    }
  };

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setPanelError("");
    try {
      await api.post("/staff/members", {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        role,
        contract_type: contractType,
        base_rate: parseFloat(baseRate) || 0,
        branch_id: branchId || undefined,
      });
      setName("");
      setEmail("");
      setPhone("");
      setRole(ROLES[0]);
      setContractType("full");
      setBaseRate("");
      onRefresh();
    } catch (err) {
      setPanelError(errText(err, "Failed to add staff member."));
    }
    setSaving(false);
  };

  const handleUpdate = async (id) => {
    setSaving(true);
    setPanelError("");
    // Premium rates: "" (field cleared) -> null = remove the premium; a number
    // -> set it; undefined (untouched) -> omitted from the JSON so the server
    // keeps the stored value. (axios/JSON.stringify drops undefined keys.)
    const rateOrNull = (v) =>
      v === undefined ? undefined : v === "" || v === null ? null : parseFloat(v);
    try {
      await api.put(`/staff/members/${id}`, {
        name: editForm.name?.trim() || undefined,
        email: editForm.email !== undefined ? (editForm.email.trim() || null) : undefined,
        phone: editForm.phone !== undefined ? (editForm.phone.trim() || null) : undefined,
        role: editForm.role || undefined,
        contract_type: editForm.contract_type || undefined,
        base_rate: editForm.base_rate !== undefined ? parseFloat(editForm.base_rate) : undefined,
        evening_rate: rateOrNull(editForm.evening_rate),
        weekend_rate: rateOrNull(editForm.weekend_rate),
        // Trækkort fields — null/empty maps to NULL on server (treated as
        // hovedkort default by payroll service).
        tax_card_type: editForm.tax_card_type || null,
        tax_card_rate: editForm.tax_card_rate
          ? parseFloat(editForm.tax_card_rate) / 100  // UI shows %, backend stores decimal
          : null,
      });
      setEditForm({});
      onRefresh();
      setSaving(false);
      return true; // signals the detail modal to close on success
    } catch (err) {
      setPanelError(errText(err, "Failed to update staff member."));
    }
    setSaving(false);
    return false;
  };

  const handleDeactivate = async (id) => {
    if (!(await confirm({ message: "Deactivate this staff member? They won't appear in future schedules.", destructive: true }))) return;
    setPanelError("");
    try {
      await api.delete(`/staff/members/${id}`);
      onRefresh();
    } catch (err) {
      setPanelError(errText(err, "Failed to deactivate staff member."));
    }
  };

  // Build the shared `editForm` draft from a member row. Drives the detail/
  // edit modal (openDetail). Centralises the field set + the percent↔decimal
  // trækkort conversion so the PUT payload matches what the server expects.
  const buildEditDraft = (member) => ({
    name: member.name,
    email: member.email || "",
    phone: member.phone || "",
    // Normalise to a ROLES option (stored roles can be lowercase "server",
    // but the <select> options are capitalized "Server") so the dropdown
    // pre-selects the member's ACTUAL role instead of defaulting to "Chef".
    role: roleToShiftOption(member.role),
    contract_type: member.contract_type,
    base_rate: member.base_rate || "",
    evening_rate: member.evening_rate ?? "",
    weekend_rate: member.weekend_rate ?? "",
    tax_card_type: member.tax_card_type || "",
    // Backend stores decimal (0.36); UI shows percent (36)
    tax_card_rate: member.tax_card_rate
      ? Math.round(parseFloat(member.tax_card_rate) * 100 * 10) / 10
      : "",
  });

  // Open the detail/edit modal (#336). Populates the shared edit draft and
  // routes everything through the modal — the old cramped inline editor has
  // been retired, so the name + pencil affordances both land here.
  const openDetail = (member) => {
    setEditForm(buildEditDraft(member));
    setDetailMember(member);
  };

  const closeDetail = () => {
    setDetailMember(null);
    setEditForm({});
  };

  const getRateCard = (member) => {
    const base = member.base_rate || 0;
    // Premiums are REAL stored values, not derived — null means "not set"
    // (the shift is paid at base). We never fabricate a premium the owner
    // didn't enter, and the schedule's ≈ cost reads these same fields.
    const num = (v) =>
      v === null || v === undefined || v === "" ? null : Number(v);
    return {
      base,
      evening: num(member.evening_rate),
      weekend: num(member.weekend_rate),
      holiday: num(member.holiday_rate),
      // Suggested DK starting points — shown only as the input placeholder +
      // "Use suggested"; never applied until the owner saves a real rate.
      suggestedEvening: base ? Math.round(base * 1.25) : null,
      suggestedWeekend: base ? Math.round(base * 1.45) : null,
    };
  };

  return (
    <div className="px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700">
      {/* Add form */}
      <div className="pt-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t("addNewStaffMember")}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <input
            type="text"
            placeholder={t("staffName", "Name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <input
            type="email"
            placeholder={t("schedEmailOptional", "Email (optional)")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <input
            type="tel"
            placeholder={t("schedPhoneOptional", "Phone (optional)")}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            value={contractType}
            onChange={(e) => setContractType(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {CONTRACT_TYPES.map((ct) => (
              <option key={ct.value} value={ct.value}>{ct.label}</option>
            ))}
          </select>
          <input
            type="number"
            placeholder={`${t("schedBaseRate", "Base rate")} (${currency}/hr)`}
            value={baseRate}
            onChange={(e) => setBaseRate(e.target.value)}
            min="0"
            step="0.5"
            className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={saving || !name.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50"
          >
            {saving ? t("schedAdding", "Adding...") : t("schedAddShort", "Add")}
          </button>
        </div>
      </div>

      {panelError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 text-red-700 dark:text-red-300 text-xs">
          {panelError}
        </div>
      )}

      {/* Staff list */}
      {staff.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm text-center py-4">
          {t("schedNoStaffPanel", "No staff members yet. Add your first team member above.")}
        </p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("currentStaff")}</h3>
          <div className="divide-y divide-gray-100 dark:divide-gray-700 border border-gray-100 dark:border-gray-700 rounded-xl overflow-hidden">
            {staff.map((member) => {
              const cat = ROLE_CATEGORY[member.role] || "floor";
              const colors = ROLE_COLORS[cat];
              const rates = getRateCard(member);
              const isInactive = member.is_active === false;

              return (
                <div
                  key={member.id}
                  className={`px-4 py-3 bg-white dark:bg-gray-800 ${isInactive ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`px-2 py-0.5 rounded-md text-xs font-medium ${colors.bg} ${colors.text}`}>
                        {member.role}
                      </div>
                      {/* Click the name to open the detail/edit modal (#336).
                          Disabled for inactive members (their edit affordances
                          are hidden below). */}
                      {isInactive ? (
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {member.name}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openDetail(member)}
                          title={t("viewStaffDetails") || "View details"}
                          aria-label={`${t("viewStaffDetails") || "View details"} — ${member.name}`}
                          className="text-sm font-medium text-gray-900 dark:text-white truncate cursor-pointer hover:underline underline-offset-2 decoration-gray-300 dark:decoration-gray-600 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 transition"
                        >
                          {member.name}
                        </button>
                      )}
                      {member.email && (
                        <span className="text-xs text-emerald-600 dark:text-gray-300" title={member.email}>
                          @
                        </span>
                      )}
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {CONTRACT_TYPES.find((c) => c.value === member.contract_type)?.label || member.contract_type}
                      </span>
                      {isInactive && (
                        <span className="text-xs text-red-500 font-medium">{t("inactive")}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-4">
                      {/* Rate card */}
                      <div className="hidden sm:flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                        <span title={t("baseRate")}>{t("baseRate")}: {rates.base}{currency}/hr</span>
                        {rates.evening != null && (
                          <span title={t("rateEvening", "Evening")}>{t("rateEveShort", "Eve")}: {rates.evening}</span>
                        )}
                        {rates.weekend != null && (
                          <span title={t("rateWeekend", "Weekend")}>{t("rateWkndShort", "Wknd")}: {rates.weekend}</span>
                        )}
                        {rates.evening == null && rates.weekend == null && (
                          <span className="text-gray-300 dark:text-gray-600">{t("noPremiumSet", "No premium")}</span>
                        )}
                      </div>
                      {!isInactive && (
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => generateLink(member)}
                            title={t("sharePortalLink")}
                            aria-label={`${t("sharePortalLink")} — ${member.name}`}
                            className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition"
                          >
                            <Link2 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openDetail(member)}
                            title={t("editStaff", "Edit")}
                            aria-label={`${t("editStaff", "Edit")} — ${member.name}`}
                            className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeactivate(member.id)}
                            title={t("deactivate", "Deactivate")}
                            aria-label={`${t("deactivate", "Deactivate")} — ${member.name}`}
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* WhatsApp Setup Guide
          ──────────────────────────────────────────────────────────
          Hidden from regular customers — this card asks the owner to
          create their own Twilio account, find SID/Auth tokens, and
          paste env vars into BonBox's Render dashboard. That's a
          DevOps setup nobody-but-the-founder can complete (customers
          can't log into Render in the first place), and the Twilio
          sandbox path delivers a 24-hour-only experience that stops
          working silently for staff.

          Customers see a calm "Coming soon" tile instead.

          Production plan (Manoj's job, once):
            • Apply for Twilio WhatsApp Business approval (~3 weeks)
            • Pre-approve message templates with Meta
            • Use existing TWILIO_* env vars on Render (single shared
              sender for all customers)
            • Customer-facing toggle just sets whatsapp_enabled flag
          */}
      {!user?.is_admin && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 text-sm">
          <div className="flex items-start gap-3">
            <span className="text-2xl shrink-0">📱</span>
            <div className="flex-1">
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {t("whatsappComingSoonTitle") || "WhatsApp shift updates — coming soon"}
              </p>
              <p className="text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                {t("whatsappComingSoonBody") ||
                  "Add staff phone numbers below now. We'll send their first message the day this goes live — your numbers stay private until then."}
              </p>
            </div>
          </div>
        </div>
      )}
      {user?.is_admin && (
      <details className="group">
        <summary className="flex items-center justify-between cursor-pointer py-3 px-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-100 dark:border-gray-800/30 text-sm font-medium text-gray-800 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition">
          <span>📱 WhatsApp Notifications — Quick Setup (admin only)</span>
          <svg className="w-4 h-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </summary>
        <div className="mt-3 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 space-y-5 text-sm text-gray-600 dark:text-gray-400">

          {/* How it works */}
          <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-100 dark:border-gray-800/20">
            <p className="text-gray-800 dark:text-gray-200 font-medium text-xs uppercase tracking-wide mb-1">How it works</p>
            <p>When you publish or change a schedule, staff with a phone number get a WhatsApp message like:</p>
            <div className="mt-2 p-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 font-mono text-xs leading-relaxed">
              <p className="text-emerald-600 dark:text-gray-300">BonBox - Schedule Update</p>
              <p className="mt-1">Hi Jonas! Your shifts changed:</p>
              <p className="mt-1">Mon 14 Apr: 10:00 - 18:00</p>
              <p>Wed 16 Apr: start moved to 15:00</p>
              <p>Fri 18 Apr: shift removed</p>
            </div>
          </div>

          {/* 3 simple steps */}
          <div className="space-y-4">
            <p className="text-gray-800 dark:text-gray-200 font-semibold">3 steps to set it up:</p>

            {/* Step 1 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xs font-bold">1</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Sign up at twilio.com <span className="text-xs font-normal text-gray-500">(free, 2 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-xs space-y-1">
                  <p>Go to <span className="text-emerald-600 dark:text-gray-300 font-medium">twilio.com/try-twilio</span></p>
                  <p>Enter your email and create a password</p>
                  <p>Verify your phone number — done!</p>
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xs font-bold">2</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Turn on WhatsApp <span className="text-xs font-normal text-gray-500">(1 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-xs space-y-2">
                  <p>In Twilio, click <span className="font-medium text-gray-800 dark:text-gray-200">Messaging</span> in the left menu</p>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Try it out</span> &rarr; <span className="font-medium text-gray-800 dark:text-gray-200">Send a WhatsApp message</span></p>
                  <p>You'll see a sandbox number like <span className="font-mono text-emerald-600 dark:text-gray-300">+1 415 523 8886</span></p>
                  <p>And a join code like <span className="font-mono text-emerald-600 dark:text-gray-300">join bright-owl</span></p>
                  <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-800/50 rounded border border-gray-100 dark:border-gray-800/30">
                    <p className="text-gray-700 dark:text-gray-300">Copy these 3 things from your Twilio dashboard:</p>
                    <div className="mt-1 font-mono space-y-0.5 text-gray-700 dark:text-gray-300">
                      <p>Account SID: <span className="text-emerald-600 dark:text-gray-300">AC1234...abcd</span></p>
                      <p>Auth Token: <span className="text-emerald-600 dark:text-gray-300">ef5678...wxyz</span></p>
                      <p>WhatsApp #: <span className="text-emerald-600 dark:text-gray-300">+14155238886</span></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xs font-bold">3</span>
              <div className="flex-1">
                <p className="font-medium text-gray-800 dark:text-gray-200">Paste them in Render <span className="text-xs font-normal text-gray-500">(1 min)</span></p>
                <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-xs space-y-2">
                  <p>Go to your BonBox backend on <span className="font-medium text-gray-800 dark:text-gray-200">render.com</span></p>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Environment</span> in the sidebar</p>
                  <p>Add these 3 values:</p>
                  <div className="mt-1 font-mono bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-700 space-y-0.5 text-gray-700 dark:text-gray-300">
                    <p>TWILIO_ACCOUNT_SID = <span className="text-emerald-600 dark:text-gray-300">paste yours</span></p>
                    <p>TWILIO_AUTH_TOKEN = <span className="text-emerald-600 dark:text-gray-300">paste yours</span></p>
                    <p>TWILIO_WHATSAPP_NUMBER = <span className="text-emerald-600 dark:text-gray-300">+14155238886</span></p>
                  </div>
                  <p>Click <span className="font-medium text-gray-800 dark:text-gray-200">Save Changes</span> — Render restarts automatically</p>
                </div>
              </div>
            </div>
          </div>

          {/* Staff side */}
          <div className="p-3 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-100 dark:border-blue-800/20">
            <p className="text-gray-800 dark:text-gray-200 font-medium text-xs uppercase tracking-wide mb-2">What your staff does</p>
            <div className="text-xs space-y-2">
              <p><span className="font-medium text-gray-800 dark:text-gray-200">You:</span> Add their phone number here (e.g. <span className="font-mono text-blue-600 dark:text-blue-400">+4512345678</span>) using the edit button above</p>
              <p><span className="font-medium text-gray-800 dark:text-gray-200">Staff:</span> Opens WhatsApp, sends <span className="font-mono bg-white dark:bg-gray-900 px-1.5 py-0.5 rounded text-emerald-600 dark:text-gray-300">join bright-owl</span> to <span className="font-mono">+1 415 523 8886</span></p>
              <p><span className="font-medium text-gray-800 dark:text-gray-200">Done!</span> They'll now get WhatsApp messages when shifts change</p>
            </div>
          </div>

          <div className="p-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-lg text-xs text-amber-700 dark:text-amber-400">
            <strong>Tip:</strong> This uses Twilio's free sandbox (great for testing). When you're ready for production, upgrade to a Twilio WhatsApp Business number — staff won't need to send the join message anymore.
          </div>
        </div>
      </details>
      )}

      {/* Portal Link Modal */}
      {linkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setLinkModal(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-sm w-full p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-3xl mb-2">🔗</div>
              <h3 className="text-base font-bold text-gray-900 dark:text-white">{t("sharePortalLink")}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t("schedSendThisTo", "Send this to")} <strong>{linkModal.staffName}</strong> {t("schedPortalLinkDesc", "— they can see their schedule, hours, and tips.")}
              </p>
            </div>

            {linkModal.loading ? (
              <div className="flex justify-center py-4">
                <div className="animate-spin w-6 h-6 border-2 border-gray-300 border-t-transparent rounded-full" />
              </div>
            ) : (
              <>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-3 text-xs font-mono text-gray-600 dark:text-gray-400 break-all select-all">
                  {linkModal.portalUrl}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={copyLink}
                    className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition ${
                      linkCopied
                        ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                        : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                    }`}
                  >
                    {linkCopied ? `✓ ${t("schedCopied", "Copied!")}` : `📋 ${t("schedCopyBtn", "Copy")}`}
                  </button>
                  <button
                    onClick={shareLink}
                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition"
                  >
                    📱 {t("schedShareBtn", "Share")}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 dark:text-gray-600 text-center">
                  {t("schedPortalNoAccount", "No account needed. Staff just opens the link. You can deactivate it anytime.")}
                </p>
              </>
            )}

            <button
              onClick={() => setLinkModal(null)}
              className="w-full py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              {t("close", "Close")}
            </button>
          </div>
        </div>
      )}

      {/* Staff detail / edit modal (#336). Owns the edit; delegates the
          actual save/share/deactivate to the existing handlers so the
          endpoints + payloads are unchanged. */}
      <StaffDetailModal
        member={detailMember}
        editForm={editForm}
        setEditForm={setEditForm}
        currency={currency}
        saving={saving}
        rates={detailMember ? getRateCard(detailMember) : { base: 0, evening: 0, weekend: 0, holiday: 0 }}
        onSave={() => handleUpdate(detailMember.id)}
        onClose={closeDetail}
        onShare={() => generateLink(detailMember)}
        onDeactivate={() => handleDeactivate(detailMember.id)}
        t={t}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SCHEDULE GRID
   ═══════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   MOBILE SCHEDULE — day-at-a-time vertical list (Staff v2, #251)
   ═══════════════════════════════════════════════════════════

   Mobile owners check the schedule walking to work / between rushes — the
   JTBD is "who's on with me today?", not "plan the whole week". An 8-col
   table never works on 390px. This component renders ONE day at a time
   with a swipeable day-strip on top, per-day stats line, and a vertical
   staff list with tap-to-edit shift cells.

   Shares all state with the desktop ScheduleGrid via props (same `shifts`
   array, same `getShiftForCell`, same `onCellClick`) so the edit flow
   stays identical — owners can switch from phone to laptop mid-week
   without rebuilding mental model.
*/
/* ═══════════════════════════════════════════════════════════
   COST CONTROLS  (owner toggles in the week summary bar)
   Two calm, status-color-free controls:
     • "Show cost" switch — per-shift lønkroner in grid/mobile cells.
     • Løn / Inkl. feriepenge segmented control — gross vs holiday-loaded.
   Both persist to localStorage at the page level; this is pure UI.
   ═══════════════════════════════════════════════════════════ */
function CostControls({ showCost, onToggleShowCost, costBasis, onCostBasis, t }) {
  return (
    <div className="flex items-center gap-3">
      {/* Show-cost switch — h-9 hit area keeps it touch-friendly and on the
          same baseline as the segmented control beside it. */}
      <button
        type="button"
        role="switch"
        aria-checked={showCost}
        onClick={onToggleShowCost}
        className="flex items-center gap-2 h-9 px-1 text-xs font-medium text-gray-600 dark:text-gray-300 rounded-lg hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
      >
        <span
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
            showCost ? "bg-gray-900 dark:bg-white" : "bg-gray-200 dark:bg-gray-600"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white dark:bg-gray-900 shadow-sm transition-transform ${
              showCost ? "translate-x-[1.125rem]" : "translate-x-1"
            }`}
          />
        </span>
        <span>{t("schedCostShow")}</span>
      </button>

      {/* Gross / loaded segmented control — matched h-9 height, clean inset
          active state (gray-900 text on white), muted inactive. */}
      <div
        className="inline-flex h-9 items-center rounded-lg border border-gray-200 dark:border-gray-600 p-1 bg-gray-100 dark:bg-gray-700/50"
        role="group"
        aria-label={t("schedTotalCost")}
      >
        {[
          { v: "gross", label: t("schedCostGross") },
          { v: "loaded", label: t("schedCostLoaded") },
        ].map((opt) => {
          const active = costBasis === opt.v;
          return (
            <button
              key={opt.v}
              type="button"
              onClick={() => onCostBasis(opt.v)}
              aria-pressed={active}
              className={`h-full px-3 text-xs font-medium rounded-md transition-colors ${
                active
                  ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MobileSchedule({ staff, weekDates, getShiftForCell, costForShift, showCost, weekCost, costBasis, targetPct, t, onCellClick, unavailFor, absenceFor }) {
  // Default to today within the current week range. If the user navigated
  // to a different week (Previous/Next), today falls outside — pick the
  // middle of the week (Thursday) as a sensible default.
  const todayISO = toISO(new Date());
  const defaultIdx = (() => {
    const todayInWeek = weekDates.findIndex((d) => toISO(d) === todayISO);
    return todayInWeek >= 0 ? todayInWeek : 3; // 3 = Thu
  })();
  const [dayIdx, setDayIdx] = useState(defaultIdx);

  // Reset when weekDates changes (user clicked Previous/Next Week).
  useEffect(() => {
    setDayIdx(defaultIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekDates[0]?.toISOString()]);

  const selectedDate = weekDates[dayIdx];
  const selectedISO = toISO(selectedDate);
  const isSelectedToday = selectedISO === todayISO;

  // Per-day stats — hours, cost, staff-on-shift count. Prefers the server's
  // daily cost (loaded/gross + labor%); falls back to a client estimate from
  // base_rate when the cost layer is unavailable. Labor% only shows when the
  // server returned revenue for that day (never fabricated).
  const serverDay = useMemo(
    () => (weekCost?.daily || []).find((d) => d.date === selectedISO) || null,
    [weekCost, selectedISO]
  );
  const dayStats = useMemo(() => {
    let totalHours = 0;
    let totalCost = 0;
    let staffOn = 0;
    staff.forEach((member) => {
      const shift = getShiftForCell(member.id, selectedDate);
      if (!shift) return;
      const hrs = calcHours(shift.start_time, shift.end_time, shift.break_minutes || 0);
      totalHours += hrs;
      const rate = member.base_rate || 0;
      totalCost += hrs * rate;
      staffOn += 1;
    });
    const cost = serverDay ? costByBasis(serverDay, costBasis) : null;
    const laborPct = serverDay
      ? (costBasis === "loaded" ? serverDay.labor_pct_loaded : serverDay.labor_pct_gross)
      : null;
    return {
      hours: Math.round((serverDay && typeof serverDay.hours === "number" ? serverDay.hours : totalHours) * 10) / 10,
      cost: Math.round(cost ?? totalCost),
      staffOn,
      laborPct: typeof laborPct === "number" ? laborPct : null,
      hasRevenue: serverDay ? serverDay.revenue != null : false,
    };
  }, [staff, selectedDate, getShiftForCell, serverDay, costBasis]);

  const goPrev = () => setDayIdx((i) => Math.max(0, i - 1));
  const goNext = () => setDayIdx((i) => Math.min(6, i + 1));

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      {/* ── Day-strip: 7 pills, today/selected highlighted ── */}
      <div className="px-3 pt-3 pb-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            type="button"
            onClick={goPrev}
            disabled={dayIdx === 0}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={t("schedPrevDay", "Previous day")}
          >
            ←
          </button>
          <div className="flex-1 text-center">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {DAY_LABELS[dayIdx]} {selectedDate.getDate()}/{selectedDate.getMonth() + 1}
            </div>
            {isSelectedToday && (
              <div className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-semibold">
                {t("schedToday")}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={goNext}
            disabled={dayIdx === 6}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label={t("schedNextDay", "Next day")}
          >
            →
          </button>
        </div>
        {/* 7 day pills — tap to switch */}
        <div className="grid grid-cols-7 gap-1">
          {weekDates.map((date, i) => {
            const iso = toISO(date);
            const isToday = iso === todayISO;
            const isSelected = i === dayIdx;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setDayIdx(i)}
                className={`flex flex-col items-center py-1.5 rounded-lg transition-colors ${
                  isSelected
                    ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                    : isToday
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
                    : "bg-gray-50 text-gray-600 dark:bg-gray-700/40 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                aria-pressed={isSelected}
              >
                <span className="text-[10px] font-medium uppercase">{DAY_LABELS[i].charAt(0)}</span>
                <span className="text-xs font-semibold tabular-nums">{date.getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Per-day stats strip — staff · hours · (cost) · labor%. The labor%
          is pushed right and weighted as the day's headline; staff/hours/cost
          are quiet context. whitespace-nowrap + min-w-0 keep it on one line at
          320px even with a long cost figure. ── */}
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-900/30">
        <div className="flex items-center gap-2.5 text-xs whitespace-nowrap">
          {/* "N on shift" — least-important, truncates first if space is tight. */}
          <span className="text-gray-500 dark:text-gray-400 min-w-0 truncate">
            <strong className="text-gray-900 dark:text-gray-100 tabular-nums">{dayStats.staffOn}</strong> {t("schedOnShift")}
          </span>
          <span className="text-gray-300 dark:text-gray-600 flex-shrink-0" aria-hidden="true">·</span>
          <span className="text-gray-900 dark:text-gray-100 font-medium tabular-nums flex-shrink-0">{formatShiftHours(dayStats.hours, t("schedHoursUnit", "h"))}</span>
          {showCost && (
            <>
              <span className="text-gray-300 dark:text-gray-600 flex-shrink-0" aria-hidden="true">·</span>
              <span className="text-gray-900 dark:text-gray-100 font-medium tabular-nums flex-shrink-0">
                ≈ {formatKr(dayStats.cost, { decimals: 0 })}
              </span>
            </>
          )}
          {/* Labor% — the day headline, pushed to the right edge; never shrinks. */}
          <span className="ml-auto flex items-center gap-1 pl-1 flex-shrink-0">
            <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
              {t("schedLaborPct")}
            </span>
            {dayStats.hasRevenue && dayStats.laborPct != null ? (
              <span className={`text-sm font-bold tabular-nums ${laborTone(dayStats.laborPct, targetPct)}`}>
                {pctLabel(dayStats.laborPct)}
              </span>
            ) : (
              <span className="text-sm font-bold text-gray-300 dark:text-gray-600 tabular-nums">—</span>
            )}
          </span>
        </div>
      </div>

      {/* ── Staff list — one row per active staff member ── */}
      <div className="divide-y divide-gray-50 dark:divide-gray-700/50">
        {staff.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t("schedNoActiveStaff", "No active staff. Add staff members from the Manage Staff section above.")}
          </div>
        ) : (
          staff.map((member) => {
            const cat = ROLE_CATEGORY[member.role] || "floor";
            const colors = ROLE_COLORS[cat];
            const shift = getShiftForCell(member.id, selectedDate);
            const shiftCat = shift ? (ROLE_CATEGORY[shift.role_on_shift || member.role] || cat) : cat;
            const hrs = shift ? calcHours(shift.start_time, shift.end_time, shift.break_minutes || 0) : 0;
            const isDraft = shift?.status === "draft";
            const shiftCost = shift ? costForShift?.(shift.id) : null;
            // Same precedence as the desktop grid: a concrete fravær (indigo)
            // outranks a standing "kan ikke" (red); both only on empty rows.
            const mAbs = !shift ? (absenceFor?.(member.id, selectedDate) || null) : null;
            const mBlk = !shift && !mAbs ? (unavailFor?.(member.id, selectedDate) || null) : null;

            return (
              <button
                key={member.id}
                type="button"
                onClick={() => onCellClick(member.id, selectedDate, shift || null)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-750/50 transition-colors"
                aria-label={shift
                  ? t("schedEditShiftAria", "Edit {name}'s shift").replace("{name}", member.name)
                  : t("schedAddShiftAria", "Add shift for {name}").replace("{name}", member.name)}
              >
                {/* Role dot + initials avatar */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                  <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-700 dark:text-gray-300">
                    {(member.name || "?").charAt(0).toUpperCase()}
                  </div>
                </div>
                {/* Name + role */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                    {member.name}
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400">{member.role}</div>
                </div>
                {/* Shift chip OR "OFF / Add" */}
                {shift ? (
                  <div
                    className={`px-2.5 py-1.5 rounded-lg bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-gray-700 border-l-[3px] ${ROLE_BAR[shiftCat] || ROLE_BAR.floor} tabular-nums text-right leading-tight ${
                      isDraft ? "border-dashed" : ""
                    }`}
                  >
                    <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                      {formatShiftTime(shift.start_time, shift.end_time)}
                    </div>
                    <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                      {formatShiftHours(hrs, t("schedHoursUnit", "h"))}
                      {isDraft && <span className="ml-1 text-amber-500 dark:text-amber-400 font-medium">· {t("schedDraft")}</span>}
                    </div>
                    {/* Cost-per-shift — quietest line in the chip (matches grid). */}
                    {showCost && shiftCost != null && (
                      <div className="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums mt-px">
                        ≈ {formatKr(shiftCost, { decimals: 0 })}
                      </div>
                    )}
                  </div>
                ) : mAbs ? (
                  <span className="inline-flex items-center rounded-md px-2 py-1 bg-indigo-100/70 dark:bg-indigo-900/30">
                    <span className="text-[10px] font-semibold text-indigo-500 dark:text-indigo-300 uppercase tracking-wide">{absKindLabel(mAbs.kind, t)}</span>
                  </span>
                ) : mBlk ? (
                  <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 bg-red-100/70 dark:bg-red-900/30">
                    <CalendarOff className="w-3 h-3 text-red-400 dark:text-red-400" strokeWidth={2} aria-hidden />
                    <span className="text-[10px] font-medium text-red-400 dark:text-red-400 tabular-nums">{mBlk.timeLabel || t("schedKanIkkeCell", "Can't work")}</span>
                  </span>
                ) : (
                  <div className="text-[11px] text-gray-400 dark:text-gray-500 flex items-center gap-1">
                    <span>{t("schedOff", "OFF")}</span>
                    <span className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 font-bold">
                      +
                    </span>
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}


/* ─── Drag layer ([L] slice 1 — move only) ───
   Honesty / design invariants:
   • Only EMPTY cells accept a drop (occupied droppables are `disabled`) — this
     is how we forbid overwrite/stacking; you can never drop onto a filled cell.
   • A plain CLICK still fires the cell's onClick (modal / bloom) because the
     PointerSensor has a 6px activation distance — sub-6px pointer travel is a
     click, not a drag.
   • A move keeps the shift's time (start/end unchanged) → update_schedule sends
     NO notification even for a published shift. We never touch `status`.
   • prefers-reduced-motion: no rotate / no lift on the drag ghost. */
const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The shift block, made draggable. Wraps the EXISTING block markup (passed as
// children) so the cell's visual stays byte-identical; we only add grab cursor
// + a dim while the ghost flies. touch-action:none lets pointer drag work on
// touch/trackpad without the page scrolling underneath.
function DraggableShiftBlock({ shift, member, dateIso, children }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: shift.id,
    data: { shift, fromStaffId: member.id, fromDateIso: dateIso },
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ touchAction: "none" }}
      className={`cursor-grab active:cursor-grabbing ${isDragging ? "opacity-40" : ""}`}
    >
      {children}
    </div>
  );
}

// The grid cell, made a drop target. OCCUPIED cells pass `occupied` → the
// droppable is `disabled` (won't accept a drop), so the only legal targets are
// EMPTY cells. The existing <td> (classes / onClick / title / aria-label) is
// preserved verbatim; on hover-over we add a calm gray drop-ring (no rainbow).
function DroppableCell({ staffId, dateIso, occupied, className, onClick, title, "aria-label": ariaLabel, children }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `${staffId}::${dateIso}`,
    data: { staffId, dateIso },
    disabled: occupied,
  });
  const dropRing =
    isOver && active && !occupied
      ? " ring-2 ring-inset ring-gray-900/30 dark:ring-gray-100/30 rounded-lg"
      : "";
  return (
    <td
      ref={setNodeRef}
      className={`${className}${dropRing}`}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </td>
  );
}

/* ─── Saved shift presets — the "Skabeloner" tray ─────────────────────────
   A calm row of preset chips above the grid. Tap a chip to ARM it, then click
   any empty day to drop a draft seeded from that preset (bloomDraft prefers the
   armed template). Tap again to disarm. Pure client-side; the "New" button
   opens a tiny modal to define one. */
function ShiftTemplatesTray({ templates, armedId, onArm, onAddClick, onRemove, t }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mr-0.5">
        {t("schedTemplates", "Templates")}
      </span>
      {templates.map((tpl) => {
        const cat = ROLE_CATEGORY[tpl.role] || "floor";
        const armed = tpl.id === armedId;
        return (
          <div
            key={tpl.id}
            role="button"
            tabIndex={0}
            onClick={() => onArm(armed ? null : tpl.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onArm(armed ? null : tpl.id)}
            title={armed ? t("schedTemplateArmedHint", "Tap a day to place it · tap chip to cancel") : t("schedTemplateArmHint", "Tap, then tap a day to place it")}
            className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] cursor-pointer transition ${
              armed
                ? "border-gray-900 dark:border-gray-100 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600"
            }`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${(ROLE_COLORS[cat] || ROLE_COLORS.floor).dot}`} />
            <span className="font-medium max-w-[120px] truncate">{tpl.label}</span>
            <span className="tabular-nums opacity-70">{tpl.start}–{tpl.end}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(tpl.id); }}
              title={t("schedTemplateRemove", "Remove template")}
              className="opacity-0 group-hover:opacity-100 transition-opacity -mr-0.5 ml-0.5 hover:text-red-400"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAddClick}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 dark:border-gray-600 px-2.5 py-1 text-[12px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400"
      >
        <Plus className="w-3 h-3" />
        {t("schedTemplateNew", "New")}
      </button>
    </div>
  );
}

function TemplateCreateModal({ t, onClose, onSave }) {
  const [label, setLabel] = useState("");
  const [startH, setStartH] = useState("16");
  const [startM, setStartM] = useState("00");
  const [endH, setEndH] = useState("23");
  const [endM, setEndM] = useState("00");
  const [role, setRole] = useState("Server");
  const [err, setErr] = useState("");

  const selCls =
    "rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100";

  const save = () => {
    const start = `${startH}:${startM}`;
    const end = `${endH}:${endM}`;
    if (start === end) {
      setErr(t("schedTemplateSameTime", "Start and end can't be the same."));
      return;
    }
    onSave({
      id: `tpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      label: (label.trim() || `${start}–${end}`).slice(0, 28),
      start,
      end,
      role,
      // Default the template's break to the DK suggestion for its length, so
      // shifts placed from it inherit a correct pause instead of a hidden 0.
      break_minutes: suggestedBreak(start, end),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("schedTemplateNewTitle", "New shift template")}
          </h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("schedTemplateLabel", "Name (optional)")}
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("schedTemplateLabelPh", "e.g. Evening, Lunch")}
          className={`${selCls} w-full mb-3`}
          maxLength={28}
        />

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftTime", "Time")}
        </label>
        <div className="flex items-center gap-1.5 mb-3">
          <select value={startH} onChange={(e) => setStartH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={startM} onChange={(e) => setStartM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-gray-400 mx-1">–</span>
          <select value={endH} onChange={(e) => setEndH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={endM} onChange={(e) => setEndM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftRole", "Role")}
        </label>
        <select value={role} onChange={(e) => setRole(e.target.value)} className={`${selCls} w-full mb-4`}>
          {OPEN_ROLE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>{t(c.key, c.fallback)}</option>
          ))}
        </select>

        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

        <Button variant="primary" className="w-full justify-center" onClick={save}>
          {t("schedTemplateSave", "Save template")}
        </Button>
      </div>
    </div>
  );
}


/* ─── Åbne vagter (open shifts) — owner lane ───────────────────────────────
   A self-contained card under the grid: the owner posts UNASSIGNED slots that
   any staffer claims one-tap from their portal (first-come). Isolated from
   ScheduleGrid so it never touches the grid's drag/cost internals. Backend
   guards the rest (Starter+ gate, overlap, atomic claim). */

// Role choices for an open shift, mapped to a role value whose ROLE_CATEGORY
// resolves to the right category label (Køkken / Bar / Gulv).
const OPEN_ROLE_CHOICES = [
  { value: "Server", key: "roleFloor", fallback: "Floor" },
  { value: "Chef", key: "roleKitchen", fallback: "Kitchen" },
  { value: "Bartender", key: "roleBar", fallback: "Bar" },
];

function OpenShiftChip({ row, t, onCancel }) {
  const cat = ROLE_CATEGORY[row.role_on_shift] || "floor";
  if (row.status === "filled") {
    return (
      <div className="rounded-lg ring-1 ring-emerald-200 dark:ring-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1.5 text-[11px] leading-tight">
        <div className="flex items-center gap-1 text-emerald-800 dark:text-emerald-300 font-medium">
          <Check className="w-3 h-3 shrink-0" />
          <span className="truncate">{row.claimed_by_name || t("openTaken", "Taken")}</span>
        </div>
        <div className="text-emerald-700/80 dark:text-emerald-400/80 tabular-nums mt-0.5">
          {formatShiftTime(row.start_time, row.end_time)}
        </div>
      </div>
    );
  }
  // OPEN: a dashed gray box (intentionally gray on all 4 sides — no role flood);
  // the role shows as a dot + label so we never hit the border-color footgun.
  const dot = (ROLE_COLORS[cat] || ROLE_COLORS.floor).dot;
  return (
    <div className="group relative rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/30 px-2 py-1.5 text-[11px] leading-tight">
      <div className="flex items-center gap-1 font-medium text-gray-700 dark:text-gray-200 tabular-nums">
        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        {formatShiftTime(row.start_time, row.end_time)}
      </div>
      <div className="text-gray-400 dark:text-gray-500 mt-0.5">{roleLabel(row.role_on_shift, t)}</div>
      <button
        onClick={() => onCancel(row.id)}
        title={t("openCancel", "Remove")}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-red-500"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function OpenShiftCreateModal({ weekDates, t, onClose, onCreated }) {
  const [dateIso, setDateIso] = useState(toISO(weekDates[0]));
  const [startH, setStartH] = useState("16");
  const [startM, setStartM] = useState("00");
  const [endH, setEndH] = useState("23");
  const [endM, setEndM] = useState("00");
  const [role, setRole] = useState("Server");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setSaving(true);
    setErr("");
    try {
      await api.post("/staff/open-shifts", {
        date: dateIso,
        start_time: `${startH}:${startM}`,
        end_time: `${endH}:${endM}`,
        role_on_shift: role,
      });
      onCreated();
    } catch (e) {
      setErr(errText(e, t("openCreateFailed", "Couldn't add the open shift.")));
      setSaving(false);
    }
  };

  const selCls =
    "rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("openShiftAddTitle", "Add open shift")}
          </h3>
          <button onClick={onClose}>
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftDay", "Day")}
        </label>
        <select value={dateIso} onChange={(e) => setDateIso(e.target.value)} className={`${selCls} w-full mb-3`}>
          {weekDates.map((d, i) => (
            <option key={i} value={toISO(d)}>
              {DAY_LABELS[i]} · {d.getDate()}/{d.getMonth() + 1}
            </option>
          ))}
        </select>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftTime", "Time")}
        </label>
        <div className="flex items-center gap-1.5 mb-3">
          <select value={startH} onChange={(e) => setStartH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={startM} onChange={(e) => setStartM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-gray-400 mx-1">–</span>
          <select value={endH} onChange={(e) => setEndH(e.target.value)} className={selCls}>
            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <span className="text-gray-400">:</span>
          <select value={endM} onChange={(e) => setEndM(e.target.value)} className={selCls}>
            {MINUTE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {t("openShiftRole", "Role")}
        </label>
        <select value={role} onChange={(e) => setRole(e.target.value)} className={`${selCls} w-full mb-4`}>
          {OPEN_ROLE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>{t(c.key, c.fallback)}</option>
          ))}
        </select>

        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

        <Button variant="primary" className="w-full justify-center" onClick={submit} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t("openShiftAddCta", "Post open shift")}
        </Button>
      </div>
    </div>
  );
}

function OpenShiftsPanel({ weekStart, t }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  const wsIso = toISO(weekStart);

  const fetchOpen = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/staff/open-shifts?week_start=${wsIso}`);
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [wsIso]);

  useEffect(() => { fetchOpen(); }, [fetchOpen]);

  const cancelOpen = useCallback(async (id) => {
    try {
      await api.delete(`/staff/open-shifts/${id}`);
      await fetchOpen();
    } catch (err) {
      setError(errText(err, t("openCancelFailed", "Couldn't remove the open shift.")));
    }
  }, [fetchOpen, t]);

  const openCount = rows.filter((r) => r.status === "open").length;
  const byDate = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.date] ||= []).push(r);
    return m;
  }, [rows]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 px-5 py-4 mt-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            {t("openShiftsTitle", "Open shifts")}
            {openCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-[11px] font-medium tabular-nums">
                {openCount}
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("openShiftsSubtitle", "Slots anyone can pick up — first to take it, gets it.")}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShowCreate(true)} className="shrink-0">
          <Plus className="w-4 h-4" />
          {t("openShiftAdd", "Open shift")}
        </Button>
      </div>

      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

      {loading ? (
        <div className="h-12 rounded-lg bg-gray-100 dark:bg-gray-700/40 animate-pulse" />
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500 py-1.5">
          {t("openShiftsEmpty", "No open shifts this week.")}
        </p>
      ) : (
        <>
          {/* Desktop: 7-day columns aligned to the week. */}
          <div className="hidden md:grid grid-cols-7 gap-2">
            {weekDates.map((d, i) => {
              const dayRows = byDate[toISO(d)] || [];
              return (
                <div key={i} className="min-h-[1.5rem]">
                  <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
                    {DAY_LABELS[i]} {d.getDate()}
                  </div>
                  <div className="space-y-1.5">
                    {dayRows.map((r) => (
                      <OpenShiftChip key={r.id} row={r} t={t} onCancel={cancelOpen} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Mobile: a flat day-labelled list. */}
          <div className="md:hidden space-y-1.5">
            {weekDates.map((d, i) => {
              const dayRows = byDate[toISO(d)] || [];
              if (!dayRows.length) return null;
              return (
                <div key={i}>
                  <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
                    {DAY_LABELS[i]} {d.getDate()}/{d.getMonth() + 1}
                  </div>
                  <div className="space-y-1.5">
                    {dayRows.map((r) => (
                      <OpenShiftChip key={r.id} row={r} t={t} onCancel={cancelOpen} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {showCreate && (
        <OpenShiftCreateModal
          weekDates={weekDates}
          t={t}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchOpen(); }}
        />
      )}
    </div>
  );
}


function ScheduleGrid({
  staff,
  weekDates,
  getShiftForCell,
  unavailFor,
  absenceFor,
  onCellClick,
  onMoveShift,
  costForShift,
  showCost,
  dailyCost,
  costBasis,
  targetPct,
  t,
}) {
  // Map server `daily` entries by date for O(1) footer lookups.
  const dailyByDate = useMemo(() => {
    const m = {};
    for (const d of dailyCost || []) m[d.date] = d;
    return m;
  }, [dailyCost]);

  // Drag-to-move is POINTER-only. 6px activation distance = a plain click still
  // opens the modal / blooms a draft (sub-6px travel is not a drag). We do NOT
  // register a KeyboardSensor: dnd-kit's default keyboard movement nudges the
  // ghost by pixels and can't snap to grid cells, so a keyboard-only user could
  // never reliably land a drop — a misleading half-feature. Reassigning by
  // keyboard stays fully available via the cell → ShiftModal path (the modal
  // lets you change staff + date directly).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  // The shift currently being dragged — drives the DragOverlay ghost. null = idle.
  const [activeShift, setActiveShift] = useState(null);

  const handleDragStart = (event) => {
    setActiveShift(event.active?.data?.current?.shift || null);
  };
  const handleDragEnd = (event) => {
    setActiveShift(null);
    const { active, over } = event;
    if (!over || !over.data?.current || !active?.data?.current) return;
    const to = over.data.current; // { staffId, dateIso } of the EMPTY target cell
    const from = active.data.current; // { shift, fromStaffId, fromDateIso }
    // No-op if dropped back where it started (same staff + same day).
    if (to.staffId === from.fromStaffId && to.dateIso === from.fromDateIso) return;
    onMoveShift?.(from.shift, to.staffId, to.dateIso);
  };

  // Ghost block for the DragOverlay — same markup as the in-cell block (white +
  // 3px ROLE_BAR + the time line), lifted with a shadow and a tiny rotate. We
  // respect prefers-reduced-motion: no rotate when the OS asks for less motion.
  const ghostCat = activeShift
    ? ROLE_CATEGORY[activeShift.role_on_shift] || "floor"
    : "floor";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-40">
                {t("schedStaffCol")}
              </th>
              {weekDates.map((date, i) => {
                const isToday = toISO(date) === toISO(new Date());
                return (
                  <th
                    key={i}
                    className={`px-2 py-3 text-center text-xs font-semibold uppercase tracking-wider w-[calc((100%-13rem)/7)] ${
                      isToday
                        ? "text-gray-900 dark:text-gray-100 bg-gray-50/50 dark:bg-gray-800/50"
                        : "text-gray-500 dark:text-gray-400"
                    }`}
                  >
                    <div>{DAY_LABELS[i]}</div>
                    <div className="font-normal text-[10px] mt-0.5 opacity-70">
                      {date.getDate()}/{date.getMonth() + 1}
                    </div>
                  </th>
                );
              })}
              {/* Timer column — weekly net hours per staffer (right edge). */}
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-12">
                {t("schedTimerCol", "Hours")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {staff.map((member) => {
              const cat = ROLE_CATEGORY[member.role] || "floor";
              const colors = ROLE_COLORS[cat];

              return (
                <tr key={member.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-750/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${colors.dot} flex-shrink-0`} />
                      <div>
                        <div className="flex items-center gap-1">
                          <span className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[104px]">
                            {member.name}
                          </span>
                          {/* Confirmation badge — surfaces the staff-side "Jeg har
                              set det". Green ONLY when every published shift this
                              week is confirmed; amber otherwise; nothing when no
                              published shifts (or confirmed_at not in payload). */}
                          {(() => {
                            const cs = staffConfirmState(member.id, weekDates, getShiftForCell);
                            if (!cs) return null;
                            return cs === "all" ? (
                              <span title={t("schedConfirmedAll", "Confirmed")} className="shrink-0 leading-none">
                                <Icon name="CheckCircle2" size={13} className="text-emerald-500 dark:text-emerald-400" />
                              </span>
                            ) : (
                              <span title={t("schedConfirmedPartial", "Not everyone has confirmed yet")} className="shrink-0 leading-none">
                                <Icon name="AlertTriangle" size={12} className="text-amber-500 dark:text-amber-400" />
                              </span>
                            );
                          })()}
                        </div>
                        <div className="text-[10px] text-gray-400 dark:text-gray-500">{member.role}</div>
                      </div>
                    </div>
                  </td>
                  {weekDates.map((date, dayIdx) => {
                    const shift = getShiftForCell(member.id, date);
                    const isToday = toISO(date) === toISO(new Date());

                    if (!shift) {
                      // A concrete fravær (approved ferie/syg) outranks a standing
                      // "kan ikke" — both tint the empty cell so the owner sees
                      // who's off, but both stay legal drop targets (soft signals;
                      // the owner can still hand-place over them).
                      const abs = absenceFor?.(member.id, date) || null;
                      const blk = abs ? null : unavailFor(member.id, date);
                      const absLabel = abs ? absKindLabel(abs.kind, t) : "";
                      return (
                        <DroppableCell
                          key={dayIdx}
                          staffId={member.id}
                          dateIso={toISO(date)}
                          occupied={false}
                          className={`group px-1 py-2 text-center cursor-pointer transition-colors ${
                            abs
                              ? "bg-indigo-50/50 dark:bg-indigo-950/20"
                              : blk
                                ? "bg-red-50/60 dark:bg-red-950/20"
                                : isToday ? "bg-gray-50/60 dark:bg-gray-800/40" : ""
                          } hover:bg-gray-50 dark:hover:bg-gray-800/40`}
                          onClick={() => onCellClick(member.id, date, null)}
                          title={abs
                            ? (abs.reason ? `${absLabel} · ${abs.reason}` : absLabel)
                            : blk
                              ? (blk.note
                                  ? `${t("schedKanIkkeCell", "Can't work")} · ${blk.note}`
                                  : t("schedKanIkkeCell", "Can't work"))
                              : t("schedBloomHint", "Click to add a shift")}
                          aria-label={abs
                            ? t("schedFravaerAria", "{name} is off this day").replace("{name}", member.name)
                            : blk
                              ? t("schedKanIkkeAria", "{name} can't work this day").replace("{name}", member.name)
                              : t("schedAddShiftAria", "Add shift for {name}").replace("{name}", member.name)}
                        >
                          {/* Available cells render SILENCE — a single hover-Plus
                              advertises one-tap add so the grid stays calm at 16×7.
                              Fravær cells show a calm indigo kind-chip; "Kan ikke"
                              a quiet red chip. Both fade to the Plus on hover
                              (override). h-14 matches the occupied block. */}
                          <div className="h-14 relative flex items-center justify-center">
                            {abs && (
                              <span className="inline-flex items-center rounded-md px-1.5 py-0.5 bg-indigo-100/70 dark:bg-indigo-900/30 transition-opacity group-hover:opacity-0" aria-hidden>
                                <span className="text-[9px] font-semibold text-indigo-500 dark:text-indigo-300 uppercase tracking-wide">{absLabel}</span>
                              </span>
                            )}
                            {blk && (
                              <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 bg-red-100/70 dark:bg-red-900/30 transition-opacity group-hover:opacity-0" aria-hidden>
                                <CalendarOff className="w-[11px] h-[11px] text-red-400 dark:text-red-400" strokeWidth={2} />
                                {blk.timeLabel && (
                                  <span className="text-[9px] font-medium text-red-400 dark:text-red-400 tabular-nums">{blk.timeLabel}</span>
                                )}
                              </span>
                            )}
                            <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                              <Icon name="Plus" size={14} className="text-gray-300 dark:text-gray-600" />
                            </span>
                          </div>
                        </DroppableCell>
                      );
                    }

                    const shiftCat = ROLE_CATEGORY[shift.role_on_shift || member.role] || cat;
                    const hrs = calcHours(shift.start_time, shift.end_time, shift.break_minutes || 0);
                    const isDraft = shift.status === "draft";
                    const shiftCost = costForShift?.(shift.id);

                    return (
                      // FILLED cell = NOT a drop target (occupied) — forbids
                      // overwrite. Its block is the DRAG SOURCE. The cell's
                      // onClick (open modal) still fires on a plain click thanks
                      // to the 6px PointerSensor activation distance.
                      <DroppableCell
                        key={dayIdx}
                        staffId={member.id}
                        dateIso={toISO(date)}
                        occupied
                        className={`px-1 py-2 text-center cursor-pointer transition-colors ${
                          isToday ? "bg-gray-50/60 dark:bg-gray-800/40" : ""
                        } hover:bg-gray-100 dark:hover:bg-gray-700/50`}
                        onClick={() => onCellClick(member.id, date, shift)}
                      >
                        <DraggableShiftBlock shift={shift} member={member} dateIso={toISO(date)}>
                          <div
                            className={`min-h-[3.5rem] text-left rounded-lg pl-2.5 pr-2 py-1.5 leading-tight bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-gray-700 border-l-[3px] ${ROLE_BAR[shiftCat] || ROLE_BAR.floor} ${
                              isDraft ? "border-dashed" : ""
                            }`}
                          >
                            <div className="text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                              {formatShiftTime(shift.start_time, shift.end_time)}
                            </div>
                            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                              {formatShiftHours(hrs, t("schedHoursUnit", "h"))}
                              {shift.role_on_shift && shift.role_on_shift !== member.role && (
                                <span className="ml-1.5 inline-block rounded px-1 py-px bg-gray-100 dark:bg-gray-700 text-[9px] font-medium text-gray-500 dark:text-gray-400 align-middle leading-none">
                                  {roleLabel(shift.role_on_shift, t)}
                                </span>
                              )}
                            </div>
                            {/* Cost-per-shift is the quietest line in the cell —
                                kept smaller + lighter than the hours above so the
                                grid stays calm at 16 staff × 7 days. */}
                            {showCost && shiftCost != null && (
                              <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-px tabular-nums">
                                ≈ {formatKr(shiftCost, { decimals: 0 })}
                              </div>
                            )}
                            {isDraft && (
                              <div className="text-[9px] text-amber-500 dark:text-amber-400 mt-0.5 font-medium uppercase tracking-wide">
                                {t("schedDraft")}
                              </div>
                            )}
                          </div>
                        </DraggableShiftBlock>
                      </DroppableCell>
                    );
                  })}
                  {/* Timer — this staffer's weekly net hours; amber when over
                      their max_hours_week cap, with the over-amount beneath. */}
                  <td className="px-3 py-2 text-right align-middle">
                    {(() => {
                      const wh = weeklyHoursFor(member.id, weekDates, getShiftForCell);
                      if (wh <= 0) {
                        return <span className="text-[12px] text-gray-300 dark:text-gray-600">—</span>;
                      }
                      const cap = member.max_hours_week;
                      const over = cap && wh > cap;
                      const unit = t("schedHoursUnit", "h");
                      return (
                        <div className="leading-tight">
                          <div
                            className={`text-[13px] font-semibold tabular-nums ${
                              over
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-gray-900 dark:text-gray-100"
                            }`}
                            title={over ? t("schedOvertimeTip", "Over weekly hours") : undefined}
                          >
                            {formatTimer(wh, unit)}
                          </div>
                          {over && (
                            <div className="text-[10px] text-amber-500 dark:text-amber-400 tabular-nums">
                              +{formatTimer(wh - cap, unit)}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {/* Per-day footer — hours + (cost) + labor% per column, aligned to
              the day cells above. Only rendered when the server returned the
              daily cost layer; labor% color-codes vs target and shows "—" with
              no revenue. Compact + tabular-nums to stay calm under 16 rows. */}
          {dailyCost && dailyCost.length > 0 && (
            <tfoot>
              <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40">
                <td className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 align-top">
                  {t("schedDayTotals")}
                </td>
                {weekDates.map((date, i) => {
                  const iso = toISO(date);
                  const d = dailyByDate[iso];
                  const hrs = d && typeof d.hours === "number" ? d.hours : 0;
                  const cost = d ? costByBasis(d, costBasis) : null;
                  const laborPct = d
                    ? (costBasis === "loaded" ? d.labor_pct_loaded : d.labor_pct_gross)
                    : null;
                  const hasRev = d ? d.revenue != null : false;
                  return (
                    <td key={i} className="px-1 py-3 text-center align-top leading-tight">
                      {/* Per-day total hours — quiet context above the labor%. */}
                      <div className="text-[11px] text-gray-700 dark:text-gray-300 tabular-nums">
                        {formatShiftHours(hrs, t("schedHoursUnit", "h"))}
                      </div>
                      {showCost && cost != null && (
                        <div className="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums mt-px">
                          ≈ {formatKr(cost, { decimals: 0 })}
                        </div>
                      )}
                      {/* Labor% — the column headline, color-coded vs target. */}
                      <div className="mt-1">
                        {hasRev && typeof laborPct === "number" ? (
                          <span className={`inline-flex items-center gap-0.5 text-sm font-bold tabular-nums ${laborToneFooter(laborPct, targetPct)}`}>
                            {pctLabel(laborPct)}
                            {targetPct != null && laborPct > targetPct && (
                              <Icon name="TrendingUp" size={11} className="shrink-0" aria-hidden="true" />
                            )}
                          </span>
                        ) : (
                          <span className="text-sm font-bold text-gray-300 dark:text-gray-600 tabular-nums">—</span>
                        )}
                      </div>
                    </td>
                  );
                })}
                {/* Timer — the week's grand total hours across all staff. */}
                <td className="px-3 py-3 text-right align-top">
                  {(() => {
                    const total = staff.reduce(
                      (sum, m) => sum + weeklyHoursFor(m.id, weekDates, getShiftForCell),
                      0
                    );
                    return (
                      <div className="text-[13px] font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                        {formatTimer(total, t("schedHoursUnit", "h"))}
                      </div>
                    );
                  })()}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
    <DragOverlay dropAnimation={PREFERS_REDUCED_MOTION ? null : undefined}>
      {activeShift ? (
        <div
          className={`min-h-[3.5rem] text-left rounded-lg pl-2.5 pr-2 py-1.5 leading-tight bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-gray-700 border-l-[3px] ${ROLE_BAR[ghostCat] || ROLE_BAR.floor} shadow-lg cursor-grabbing`}
          style={PREFERS_REDUCED_MOTION ? undefined : { transform: "rotate(2deg)" }}
        >
          <div className="text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {formatShiftTime(activeShift.start_time, activeShift.end_time)}
          </div>
          <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
            {formatShiftHours(calcHours(activeShift.start_time, activeShift.end_time, activeShift.break_minutes || 0), t("schedHoursUnit", "h"))}
          </div>
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
}

/* ═══════════════════════════════════════════════════════════
   PUBLISH CONFIRM MODAL  (audit #248 P0 — the deliberate "go-live" gate)
   Owners are paying real money; publishing emails staff. So before we go
   live we show exactly what's about to ship: N draft shifts → M staff,
   total hours, and (when rates exist) the estimated labor cost. The
   summary is computed client-side from already-loaded shifts+staff, so
   the sheet is instant — no extra fetch. The post-publish success banner
   (built in confirmPublish) reports the server's REAL notified count, so
   we never fabricate "everyone was emailed".
   ═══════════════════════════════════════════════════════════ */
function StatTile({ icon, value, label }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-750 px-3 py-2.5">
      <div className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums leading-tight">
        {value}
      </div>
      <div className="flex items-center gap-1 mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
        <Icon name={icon} size={13} className="text-gray-400 dark:text-gray-500" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function PublishConfirmModal({ summary, result, currency, weekStart, publishing, onConfirm, onClose, t }) {
  const done = !!result; // success state shown after a publish completes
  const nothing = !summary || summary.draftCount === 0;
  const headerIcon = done ? "CheckCircle2" : "Send";
  const title = done
    ? (result.published === 0
        ? t("publishNothingTitle", "Nothing to publish")
        : t("publishedTitle", "Week published"))
    : (nothing
        ? t("publishNothingTitle", "Nothing to publish")
        : t("publishConfirmTitle", "Publish this week?"));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 w-full max-w-md p-6 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center shrink-0">
              <Icon name={headerIcon} size={done ? 20 : 18} className="text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white leading-tight">
                {title}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {formatWeekRange(weekStart)}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
            aria-label={t("close", "Close")}
          >
            {"×"}
          </button>
        </div>

        {done ? (
          /* ── Success — durable confirmation from the server's real counts ── */
          <div className="space-y-1.5">
            <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
              {result.published === 0
                ? t("publishedNothing", "Already up to date — nothing new to publish.")
                : t("publishedLiveCount", "{n} shift(s) are now live on your team's schedule.").replace("{n}", String(result.published))}
            </p>
            {result.published > 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                {result.notify > 0
                  ? t("publishedNotifyYes", "{m} staff notified about their changes.").replace("{m}", String(result.notify))
                  : t("publishedNotifyNo", "No affected staff had an email on file — nothing was sent.")}
              </p>
            )}
          </div>
        ) : nothing ? (
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            {t(
              "publishNothingBody",
              "Every shift this week is already published. Add or edit a shift, then publish to push the changes to your staff.",
            )}
          </p>
        ) : (
          <>
            {/* What's about to go live */}
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile
                icon="CalendarDays"
                value={summary.draftCount}
                label={t("publishStatShifts", "draft shifts")}
              />
              <StatTile
                icon="Users"
                value={summary.staffCount}
                label={t("publishStatStaff", "staff")}
              />
              <StatTile
                icon="Clock"
                value={`${summary.hours}h`}
                label={t("publishStatHours", "total hours")}
              />
              {summary.anyRate && (
                <StatTile
                  icon="Coins"
                  value={`≈ ${summary.cost.toLocaleString()} ${currency}`}
                  label={t("publishStatCost", "est. labor")}
                />
              )}
            </div>

            {/* Honest notify note — no count promised here; the success
                banner reports the server's real number after publish. */}
            <div className="flex items-start gap-2 rounded-lg bg-gray-50 dark:bg-gray-750 px-3 py-2.5">
              <Icon name="Mail" size={15} className="text-gray-400 dark:text-gray-500 mt-0.5 shrink-0" />
              <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                {t(
                  "publishNotifyNote",
                  "Staff whose shifts changed get an email (and a push if they've opened their portal).",
                )}
              </p>
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          {done ? (
            <Button variant="accent" size="sm" onClick={onClose} iconLeft={<Icon name="Check" size={14} />}>
              {t("publishDone", "Done")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {nothing ? t("close", "Close") : t("cancel", "Cancel")}
              </Button>
              {!nothing && (
                <Button
                  variant="accent"
                  size="sm"
                  onClick={onConfirm}
                  busy={publishing}
                  iconLeft={<Icon name="Send" size={14} />}
                >
                  {t("publishConfirmCta", "Publish Week")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHIFT MODAL
   ═══════════════════════════════════════════════════════════ */
function ShiftModal({ modal, staff, shifts = [], weekDates, lastTemplate, onTemplateSave, onClose, onSaved, branchId }) {
  const { t } = useLanguage();
  const existingShift = modal.shift;
  const isEdit = !!existingShift;

  /* Smart defaults (audit #248 P0): owners shouldn't re-type 16:00–23:00 +
     break + role on every cell. Seed precedence for a NEW shift:
       1. The selected staff's most-recent shift THIS week (their pattern).
       2. The last shift the owner saved this session (run of similar shifts).
       3. Hard fallback 16:00–23:00, no break, member's default role.
     Edit mode always uses the shift's own values. */
  const seed = useMemo(() => {
    if (existingShift) {
      return {
        start: existingShift.start_time,
        end: existingShift.end_time,
        break_minutes: existingShift.break_minutes || 0,
        role: existingShift.role_on_shift || null,
      };
    }
    const r = mostRecentShiftFor(shifts, modal.staffId);
    if (r) return { start: r.start_time, end: r.end_time, break_minutes: r.break_minutes || 0, role: r.role_on_shift || null };
    if (lastTemplate?.start && lastTemplate?.end) return { ...lastTemplate };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [staffId, setStaffId] = useState(modal.staffId || existingShift?.staff_member_id || existingShift?.staff_id || "");
  const [date, setDate] = useState(modal.date || (existingShift?.date) || toISO(weekDates[0]));
  const [startHour, setStartHour] = useState(() => (seed?.start ? seed.start.slice(0, 2) : "16"));
  const [startMin, setStartMin] = useState(() => (seed?.start ? seed.start.slice(3, 5) : "00"));
  const [endHour, setEndHour] = useState(() => (seed?.end ? seed.end.slice(0, 2) : "23"));
  const [endMin, setEndMin] = useState(() => (seed?.end ? seed.end.slice(3, 5) : "00"));
  const [breakMinutes, setBreakMinutes] = useState(
    () => seed?.break_minutes ?? suggestedBreak(seed?.start || "16:00", seed?.end || "23:00")
  );
  const [roleOnShift, setRoleOnShift] = useState(() => {
    if (seed?.role) return roleToShiftOption(seed.role);
    const member = staff.find((s) => s.id === (modal.staffId || existingShift?.staff_member_id || existingShift?.staff_id));
    return roleToShiftOption(member?.role);
  });
  const [notes, setNotes] = useState(existingShift?.notes || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modalError, setModalError] = useState("");
  // True once the owner edits any time/break field — stops auto re-seeding
  // on staff change so we never clobber a value they typed themselves.
  const [touched, setTouched] = useState(false);
  // Same staff + same calendar day in the PREVIOUS week, fetched lazily so
  // the "Last week" quick-fill can mirror a recurring rota. null = none.
  const [prevWeekShift, setPrevWeekShift] = useState(null);

  // When the owner picks a DIFFERENT staff in Add mode: default the role to
  // that member's role, and (unless they've touched the form) re-seed the
  // times from that staff's most recent shift this week.
  const prevStaffRef = useRef(staffId);
  useEffect(() => {
    if (isEdit) return;
    const changed = prevStaffRef.current !== staffId;
    prevStaffRef.current = staffId;
    if (!staffId) return;
    const member = staff.find((s) => s.id === staffId);
    if (member?.role) setRoleOnShift(roleToShiftOption(member.role));
    if (!changed || touched) return;
    const r = mostRecentShiftFor(shifts, staffId);
    if (r) {
      setStartHour(r.start_time.slice(0, 2));
      setStartMin(r.start_time.slice(3, 5));
      setEndHour(r.end_time.slice(0, 2));
      setEndMin(r.end_time.slice(3, 5));
      setBreakMinutes(r.break_minutes || 0);
      if (r.role_on_shift) setRoleOnShift(r.role_on_shift);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffId]);

  // Lazily fetch the same staff + same calendar day last week for "Last week".
  useEffect(() => {
    if (isEdit || !staffId || !date) { setPrevWeekShift(null); return; }
    let cancelled = false;
    const prevSameDay = new Date(date);
    prevSameDay.setDate(prevSameDay.getDate() - 7);
    const prevISO = toISO(prevSameDay);
    const params = { week_start: toISO(getWeekStart(prevSameDay)) };
    if (branchId) params.branch_id = branchId;
    api.get("/staff/schedules", { params })
      .then((res) => {
        if (cancelled) return;
        const match = (res.data || []).find(
          (s) => String(s.date) === prevISO && shiftBelongsTo(s, staffId) && s.start_time && s.end_time
        );
        setPrevWeekShift(match || null);
      })
      .catch(() => { if (!cancelled) setPrevWeekShift(null); });
    return () => { cancelled = true; };
  }, [staffId, date, isEdit, branchId]);

  // Apply a template shift (quick-fill chip) to the time/break/role fields.
  // User-initiated → mark touched so staff-change re-seeding stays out.
  const applyTemplate = (s) => {
    if (!s?.start_time || !s?.end_time) return;
    setStartHour(s.start_time.slice(0, 2));
    setStartMin(s.start_time.slice(3, 5));
    setEndHour(s.end_time.slice(0, 2));
    setEndMin(s.end_time.slice(3, 5));
    setBreakMinutes(s.break_minutes || 0);
    if (s.role_on_shift) setRoleOnShift(s.role_on_shift);
    setTouched(true);
  };

  const startTime = `${startHour}:${startMin}`;
  const endTime = `${endHour}:${endMin}`;
  const previewHours = calcHours(startTime, endTime, breakMinutes);

  const recentForStaff = useMemo(() => (isEdit ? null : mostRecentShiftFor(shifts, staffId)), [staffId, shifts, isEdit]);
  // arbejdstidsloven: a break is expected for shifts over 6h. Suggest 30 min
  // when none is set — one tap, fully overridable.
  const BREAK_SUGGEST = 30;
  const showBreakSuggest = previewHours >= 6 && (Number(breakMinutes) || 0) === 0;

  const handleSave = async () => {
    if (!staffId) {
      setModalError(t("shiftSelectStaffError", "Please select a staff member."));
      return;
    }
    if (!date) {
      setModalError(t("shiftSelectDateError", "Please select a date."));
      return;
    }

    setSaving(true);
    setModalError("");

    const payload = {
      staff_id: staffId,
      date,
      start_time: startTime,
      end_time: endTime,
      break_minutes: breakMinutes || 0,
      role_on_shift: roleOnShift,
      notes: notes.trim() || undefined,
      branch_id: branchId || undefined,
    };

    try {
      if (isEdit) {
        await api.put(`/staff/schedules/${existingShift.id}`, payload);
      } else {
        await api.post("/staff/schedules", payload);
      }
      // Remember this shift so the next "Add" pre-fills from it.
      onTemplateSave?.({ start: startTime, end: endTime, break_minutes: breakMinutes || 0, role: roleOnShift });
      onSaved();
    } catch (err) {
      const d = err.response?.data?.detail;
      const fallbackMsg = isEdit
        ? t("shiftUpdateFailed", "Failed to update shift.")
        : t("shiftCreateFailed", "Failed to create shift.");
      if (err.response?.status === 409 && d?.code === "shift_overlap") {
        setModalError(t("schedSlotTaken", "That overlaps a shift they already have that day."));
      } else {
        // errText safely coerces string / 422-array / {code,message} detail to a
        // string (never the raw object → no React-child crash).
        setModalError(errText(err, fallbackMsg));
      }
    }
    setSaving(false);
  };

  // Two-step delete: the "Delete Shift" button flips an in-modal confirm
  // (setConfirmDelete) instead of a native window.confirm() — consistent with
  // the rest of BonBox's dialogs, and (unlike the OS popup) actually testable.
  const handleDelete = async () => {
    if (!existingShift?.id) return;
    setDeleting(true);
    setModalError("");
    try {
      await api.delete(`/staff/schedules/${existingShift.id}`);
      onSaved(); // closes the modal on success
    } catch (err) {
      setModalError(errText(err, t("shiftDeleteFailed", "Failed to delete shift.")));
      setDeleting(false);
    }
  };

  // Date options for the dropdown: all 7 days of the current week
  const dateOptions = weekDates.map((d) => ({
    value: toISO(d),
    label: `${DAY_LABELS[d.getDay() === 0 ? 6 : d.getDay() - 1]} ${d.getDate()}/${d.getMonth() + 1}`,
  }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEdit ? t("shiftEditTitle", "Edit Shift") : t("shiftAddTitle", "Add Shift")}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
          >
            {"\u00D7"}
          </button>
        </div>

        {modalError && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 text-red-700 dark:text-red-300 text-xs">
            {modalError}
          </div>
        )}

        {/* Staff member */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("staffMember")}</label>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            <option value="">{t("selectStaff")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.role})
              </option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("shiftDateLabel", "Date")}</label>
          <select
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          >
            {dateOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Quick-fill chips (Add mode) — one tap to reuse this staff's most
            recent shift or their shift from the same day last week. Kills the
            "re-type every time" friction the audit flagged. */}
        {!isEdit && (recentForStaff || prevWeekShift) && (
          <div className="flex items-center gap-2 flex-wrap -mt-1">
            <span className="text-[11px] text-gray-400 dark:text-gray-500">{t("shiftQuickFill", "Quick fill")}:</span>
            {recentForStaff && (
              <button
                type="button"
                onClick={() => applyTemplate(recentForStaff)}
                title={t("shiftCopyRecentTitle", "Use this staff member's most recent shift this week")}
                className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition"
              >
                {t("shiftCopyRecent", "Latest shift")} · {formatShiftTime(recentForStaff.start_time, recentForStaff.end_time)}
              </button>
            )}
            {prevWeekShift && (
              <button
                type="button"
                onClick={() => applyTemplate(prevWeekShift)}
                title={t("shiftSameLastWeekTitle", "Use the same shift from last week")}
                className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                {t("shiftSameLastWeek", "Last week")} · {formatShiftTime(prevWeekShift.start_time, prevWeekShift.end_time)}
              </button>
            )}
          </div>
        )}

        {/* Time selectors */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("startTime")}</label>
            <div className="flex gap-1">
              <select
                value={startHour}
                onChange={(e) => { setStartHour(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span className="text-gray-400 self-center">:</span>
              <select
                value={startMin}
                onChange={(e) => { setStartMin(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {MINUTE_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("endTime")}</label>
            <div className="flex gap-1">
              <select
                value={endHour}
                onChange={(e) => { setEndHour(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span className="text-gray-400 self-center">:</span>
              <select
                value={endMin}
                onChange={(e) => { setEndMin(e.target.value); setTouched(true); }}
                className="flex-1 px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none"
              >
                {MINUTE_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Break + Role */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("shiftBreakLabel", "Break (minutes)")}</label>
            <input
              type="number"
              value={breakMinutes}
              onChange={(e) => { setBreakMinutes(e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value) || 0)); setTouched(true); }}
              min="0"
              max="120"
              step="5"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
            />
            {/* arbejdstidsloven nudge — a break is expected for 6h+ shifts.
                One tap to add 30 min; fully overridable. */}
            {showBreakSuggest && (
              <button
                type="button"
                onClick={() => { setBreakMinutes(BREAK_SUGGEST); setTouched(true); }}
                title={t("shiftBreakHint", "Recommended for shifts over 6 hours")}
                className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                + {t("shiftBreakSuggest", "Add {n} min break").replace("{n}", BREAK_SUGGEST)}
              </button>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("roleOnShift")}</label>
            <select
              value={roleOnShift}
              onChange={(e) => setRoleOnShift(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Preview */}
        <div className="bg-gray-50 dark:bg-gray-750 rounded-lg px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
          {t("shiftPreview", "Shift: {start} \u2013 {end} ({hours}h net)")
            .replace("{start}", startTime)
            .replace("{end}", endTime)
            .replace("{hours}", Math.round(previewHours * 100) / 100)}
          {breakMinutes > 0 && " " + t("shiftPreviewBreak", "with {n}min break").replace("{n}", breakMinutes)}
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t("shiftNotesLabel", "Notes (optional)")}</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("shiftNotesPlaceholder", "e.g. Training, covering for Anna...")}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-gray-400 focus:border-transparent outline-none"
          />
        </div>

        {/* Actions */}
        {confirmDelete ? (
          /* In-app delete confirmation — replaces the native window.confirm()
             so it matches BonBox's dialog style and is automatable/testable. */
          <div className="flex items-center justify-between gap-3 pt-3 mt-1 border-t border-gray-100 dark:border-gray-700">
            <span className="text-sm text-gray-700 dark:text-gray-200">
              {t("shiftDeleteConfirm", "Delete this shift?")}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-50"
              >
                {t("cancel", "Cancel")}
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50"
              >
                {deleting ? t("shiftDeleting", "Deleting...") : t("shiftDeleteBtn", "Delete Shift")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between pt-2">
            <div>
              {isEdit && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50"
                >
                  {t("shiftDeleteBtn", "Delete Shift")}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition"
              >
                {t("cancel", "Cancel")}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-50"
              >
                {saving ? t("shiftSaving", "Saving...") : isEdit ? t("shiftUpdateBtn", "Update Shift") : t("shiftAddTitle", "Add Shift")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
