// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";
import { Clock, Users, SlidersHorizontal } from "lucide-react";
import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { useAsyncData } from "../hooks/useAsyncData";
import { displayCurrency, formatOwnerMoney, isMoneyRejected, moneyLocale, parseMoneyInput } from "../utils/currency";
import MoneyField from "../components/ui/MoneyField";
import Chip from "../components/ui/Chip";
import { localIso, localDaysAgo, dateLocale, businessTodayIso } from "../utils/dateFormat";
import { formatHours, formatHoursNumber } from "../utils/hours";
import { StaggerContainer, StaggerItem } from "../components/AnimationKit";
import { PageHeader, TabPills, Icon, Button, LoadFailed } from "../components/ui";
import { errText } from "../utils/errText";

/* ═══════════════════════════════════════════════════════════
   SPLIT METHOD DEFINITIONS
   ═══════════════════════════════════════════════════════════ */
// `id` is the split_method the API stores; label + description are display
// copy, looked up through t() at render.
const SPLIT_METHODS = [
  {
    id: "hours", icon: Clock,
    labelKey: "stfTipSplitHours", labelFallback: "By Hours Worked",
    descKey: "stfTipSplitHoursDesc", descFallback: "Proportional to hours worked in the period",
  },
  {
    id: "role", icon: Users,
    labelKey: "stfTipSplitRole", labelFallback: "By Role Share",
    descKey: "stfTipSplitRoleDesc", descFallback: "Full-time = 1.0, Part-time/Student = 0.5",
  },
  {
    id: "custom", icon: SlidersHorizontal,
    labelKey: "stfTipSplitCustom", labelFallback: "Custom Ratio",
    descKey: "stfTipSplitCustomDesc", descFallback: "Set your own percentages",
  },
];

/** Localized name of a stored split_method; an unknown one shows as stored. */
function splitMethodLabel(id, t) {
  const m = SPLIT_METHODS.find((x) => x.id === id);
  return m ? t(m.labelKey, m.labelFallback) : id;
}

// Role / employment names as the owner reads them. `role` here is free text
// (staff_members.role, or employment_type, or the "full-time" default below)
// and it also drives getRoleShare(), so the stored value is never rewritten —
// only what is shown. Same map as the twins in StaffSchedulePage,
// StaffPayrollPage and StaffPortalPage; unknown roles (and the salon
// vocabulary, Danish in both languages) show exactly as typed.
const ROLE_NAME_KEYS = {
  chef: ["stfRoleChef", "Chef"],
  server: ["stfRoleServer", "Server"],
  dishwasher: ["stfRoleDishwasher", "Dishwasher"],
  manager: ["teamRoleManager", "Manager"],
  kitchen: ["roleKitchen", "Kitchen"],
  bar: ["roleBar", "Bar"],
  floor: ["roleFloor", "Floor"],
  full: ["contractFull", "Full-time"],
  part: ["contractPart", "Part-time"],
  hourly: ["contractHourly", "Hourly"],
  "full-time": ["contractFull", "Full-time"],
  full_time: ["contractFull", "Full-time"],
  "part-time": ["contractPart", "Part-time"],
  part_time: ["contractPart", "Part-time"],
  student: ["contractStudent", "Student"],
};

// The language's decimal mark, as the hours beside it (utils/hours): "23,1 %"
// in Danish, "23.1%" in English. This was Danish for everyone, so an English
// session read "23,1" — a comma an English reader takes for thousands.
function pct(v, lang) {
  const n = new Intl.NumberFormat(lang === "da" ? "da-DK" : "en-GB", { maximumFractionDigits: 1 })
    .format(Number(v) || 0);
  return lang === "da" ? `${n} %` : `${n}%`;
}

function roleName(role, t) {
  const hit = ROLE_NAME_KEYS[String(role || "").trim().toLowerCase()];
  return hit ? t(hit[0], hit[1]) : role;
}

// The codes the staff table actually stores ("full", "part", "hourly") were
// missing, so a part-timer weighed 1.0 like everyone else.
const ROLE_SHARES = {
  "full": 1.0,
  "part": 0.5,
  "hourly": 1.0,
  "full-time": 1.0,
  "full_time": 1.0,
  "manager": 1.0,
  "part-time": 0.5,
  "part_time": 0.5,
  "student": 0.5,
  "intern": 0.5,
  "trainee": 0.5,
};

function getRoleShare(role) {
  if (!role) return 1.0;
  return ROLE_SHARES[role.toLowerCase()] ?? 1.0;
}

// The business day, as on Timer: at 01:00 tonight's hours are on yesterday.
function today() {
  return businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
}

/* ═══════════════════════════════════════════════════════════
   MONEY — øre, not floats
   ═══════════════════════════════════════════════════════════ */
// Hundredths as a whole number: kroner to øre, hours or percent to hundredths.
// Taken from the same 2-decimal values the page SENDS, so the server's own
// recompute (routers/staff.py `_split_ore`) works from identical weights.
const hundredths = (v) => Math.round((Number(v) || 0) * 100);
const round2 = (v) => hundredths(v) / 100;

/**
 * Split `totalOre` in proportion to `weights` so the parts add up to EXACTLY
 * the pot — the largest-remainder method, and the server's rule to the øre.
 * Everyone gets the floor of their exact share; the øre left over go one each
 * to the largest remainders, ties to whoever is earlier in the list. Returns
 * the parts plus which rows got one of those spare øre, so the page can say so.
 *
 * Each share used to be rounded on its own: 100,00 kr. over three people came
 * to 3 × 33,33 = 99,99 kr., with "Afrundingsforskel: 0,01 kr." given to nobody.
 */
function splitOre(totalOre, weights) {
  const w = weights.map((x) => Math.max(0, hundredths(x)));
  const sum = w.reduce((a, b) => a + b, 0);
  const bumped = new Set();
  if (!(totalOre > 0) || !(sum > 0)) return { parts: w.map(() => 0), bumped };
  const parts = w.map((wi) => Math.floor((totalOre * wi) / sum));
  const rest = w.map((wi) => (totalOre * wi) % sum);
  let left = totalOre - parts.reduce((a, b) => a + b, 0);
  const order = w.map((_, i) => i).sort((i, j) => rest[j] - rest[i] || i - j);
  for (const i of order) {
    if (left <= 0) break;
    parts[i] += 1;
    bumped.add(i);
    left -= 1;
  }
  return { parts, bumped };
}

/* ═══════════════════════════════════════════════════════════
   PERIOD — a pool covers days, not a day
   ═══════════════════════════════════════════════════════════ */
// Same cap as the server (schemas/staff.py TIP_POOL_MAX_DAYS): a week of the
// jar, sometimes two, at most a pay period.
const TIP_POOL_MAX_DAYS = 62;

// Calendar arithmetic on LOCAL days. new Date("2026-09-20") is UTC midnight —
// the evening before, anywhere west of Greenwich — so build the date from its
// parts, at noon, where no daylight-saving shift can move it.
function isoToDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
function shiftIso(iso, days) {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + days);
  return localIso(d);
}
function daysInclusive(fromIso, toIso) {
  return Math.round((isoToDate(toIso) - isoToDate(fromIso)) / 86400000) + 1;
}
function mondayOf(iso) {
  return shiftIso(iso, -((isoToDate(iso).getDay() + 6) % 7));
}

const PERIOD_PRESETS = [
  { id: "last7", key: "stTipPeriodLast7", fallback: "Last 7 days" },
  { id: "thisWeek", key: "stTipPeriodThisWeek", fallback: "This week" },
  { id: "lastWeek", key: "stTipPeriodLastWeek", fallback: "Last week" },
  { id: "custom", key: "stTipPeriodCustom", fallback: "Pick dates" },
];

function presetRange(id, todayIso) {
  if (id === "thisWeek") return { from: mondayOf(todayIso), to: todayIso };
  if (id === "lastWeek") {
    const monday = shiftIso(mondayOf(todayIso), -7);
    return { from: monday, to: shiftIso(monday, 6) };
  }
  // The default: the seven business days ending today — a week of the jar,
  // whatever weekday the owner sits down to split it.
  return { from: shiftIso(todayIso, -6), to: todayIso };
}

/**
 * A pool's period the way the language writes a range — "14.–20. sep." in
 * Danish, "14–20 Sept" in English — in the app's date locale, never raw ISO.
 * The year only when it is not this one. A one-day pool (period_start NULL,
 * every row from before periods) is just its day.
 */
function periodLabel(fromIso, toIso) {
  if (!toIso) return "";
  const a = isoToDate(fromIso || toIso);
  const b = isoToDate(toIso);
  const thisYear = new Date().getFullYear();
  const opts = { day: "numeric", month: "short" };
  if (a.getFullYear() !== thisYear || b.getFullYear() !== thisYear) opts.year = "numeric";
  const f = new Intl.DateTimeFormat(dateLocale(), opts);
  if (!fromIso || fromIso >= toIso) return f.format(b);
  return typeof f.formatRange === "function" ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`;
}

/**
 * One row per person in the pool. Hours are SUMMED over every entry in the
 * period — seven evenings of the week, and both halves of a split shift.
 *
 * Who is on it: everyone who logged hours in the period, including someone
 * deactivated since (they worked it). With no hours logged at all, the active
 * roster at 0 t, so the owner can type them in. Roster order (the server sorts
 * by name) is also the tie-break for a spare øre, here and on the server.
 */
function buildRoster(members, entries) {
  const hoursBy = new Map();
  // Every open clock-in, as WHO and WHICH DAY: the warning names them and
  // links to Timer, where the owner answers it. A bare count ("1 vagt …")
  // left the owner to go and find whose shift it was.
  const openPunches = [];
  for (const h of entries || []) {
    const id = String(h.staff_id);
    hoursBy.set(id, (hoursBy.get(id) || 0) + (Number(h.total_hours ?? h.hours) || 0));
    // An open clock-in stores 0 hours — say so, rather than quietly paying
    // that evening as nothing.
    if (h.entry_method === "clock" && !h.end_time) openPunches.push({ staff_id: id, date: h.date });
  }
  const row = (id, m, hours) => ({
    staff_id: id,
    name: m?.name || m?.full_name || "",
    // The split's promise is "part-time = 0,5" — that's the CONTRACT,
    // not the job title ("kitchen", "bar" all weighed 1.0).
    role: m?.contract_type || m?.employment_type || m?.role || "full-time",
    hours: round2(hours),
  });
  const list = members || [];
  const known = new Set(list.map((m) => String(m.id)));
  const worked = list.filter((m) => (hoursBy.get(String(m.id)) || 0) > 0)
    .map((m) => row(String(m.id), m, hoursBy.get(String(m.id))));
  // Hours from someone no longer on the roster at all still count.
  for (const [id, h] of hoursBy) {
    if (h > 0 && !known.has(id)) worked.push(row(id, null, h));
  }
  const rows = worked.length
    ? worked
    : list.filter((m) => m.active !== false).map((m) => row(String(m.id), m, 0));
  return { rows, openPunches };
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function StaffTipsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [tab, setTab] = useState("new"); // new | history

  // THREE outcomes per request, not two (hooks/useAsyncData). Both of these
  // used to `.catch(() => {})` into an empty list, so a failed history read as
  // "Endnu ingen fordelinger" and a failed roster as a page with nobody on it.
  // include_inactive: someone who worked the period and has left since is
  // still owed their share of it.
  const staffQ = useAsyncData(
    () => api.get("/staff/members", { params: { include_inactive: true } }),
    [],
    { initial: [] },
  );
  const historyQ = useAsyncData(
    () => api.get("/staff/tips", { params: { from: localDaysAgo(90), to: today() } }),
    [],
    { initial: [] },
  );

  return (
    <div className="p-4 sm:p-6 max-w-6xl 2xl:max-w-[1400px] mx-auto space-y-6">
      <PageHeader
        eyebrow={t("shpEyebrow", "STAFF")}
        title={t("tips", "Tips")}
        subtitle={t("tipsDesc", "Distribute tips fairly — by hours, role, or custom split")}
      />

      {/* Tab bar */}
      <TabPills
        tabs={[
          { id: "new", label: t("newTipEntry", "New Entry") },
          { id: "history", label: t("tipHistory", "History") },
        ]}
        activeId={tab}
        onChange={setTab}
        ariaLabel={t("stTipsViewAria", "Tips view")}
      />

      {tab === "new" && (
        <TipEntryForm
          currency={currency}
          t={t}
          staffQ={staffQ}
          onDone={() => { historyQ.reload(); setTab("history"); }}
        />
      )}
      {tab === "history" && (
        <TipHistoryView
          historyQ={historyQ}
          currency={currency}
          t={t}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   TIP ENTRY FORM
   ═══════════════════════════════════════════════════════════ */
function TipEntryForm({ currency, t, staffQ, onDone }) {
  // `t` arrives as a prop here, so there is no hook call in this component and
  // `lang` was not in scope — the hours total below needs it for the decimal
  // mark, and a bare reference would have thrown at render, which a green
  // build cannot see.
  const { lang } = useLanguage();
  // The tip pot is money the owner types — text box, strict parser, the
  // ACCOUNT's notation (this form receives it as `currency`). The hours and
  // percentage columns beside it stay number inputs: neither is kroner.
  // See components/ui/MoneyField.jsx.
  const mLocale = moneyLocale(currency);
  const oreText = (ore) => formatOwnerMoney(ore / 100, currency, { decimals: 2 });
  // A row with no name on file reads "Staff #12" — resolved at render so it
  // follows the language, never baked into the row.
  const nameOf = (s) => s.name || t("stfStaffNumber", "Staff #{id}", { id: String(s.staff_id).slice(0, 8) });

  // The pool's PERIOD. It was one date, and the hours fetched were that one
  // day's — so a week's jar was split by whoever happened to work on Sunday.
  const todayIso = today();
  const [period, setPeriod] = useState(() => ({ preset: "last7", ...presetRange("last7", todayIso) }));
  const [totalAmount, setTotalAmount] = useState("");
  const [splitMethod, setSplitMethod] = useState("hours");
  // What the owner typed over the logged figures, by staff_id. Cleared with
  // every period change (in changePeriod, not an effect): a new period starts
  // from what was logged in it.
  const [hoursEdits, setHoursEdits] = useState({});
  const [ratioEdits, setRatioEdits] = useState({});
  // No separate "Preview distribution" step: the table below IS the live
  // preview (every row, share and øre, updated as the owner types), and the
  // button repeated it in a second card.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const changePeriod = (next) => {
    // Only a different RANGE starts over; opening "Pick dates" on the same
    // days keeps what the owner already typed.
    if (next.from !== period.from || next.to !== period.to) {
      setHoursEdits({});
      setRatioEdits({});
    }
    setPeriod(next);
    setError("");
  };
  const pickPreset = (id) => {
    changePeriod(id === "custom"
      ? { ...period, preset: "custom" }
      : { preset: id, ...presetRange(id, todayIso) });
  };

  const span = period.from && period.to ? daysInclusive(period.from, period.to) : 0;
  const periodError = !period.from || !period.to
    ? t("stTipPeriodMissing", "Pick a from and a to date.")
    : period.from > period.to
      ? t("stTipPeriodBackwards", "The period has to start before it ends.")
      : period.to > todayIso
        ? t("stTipPeriodFuture", "The period can't end after today.")
        : span > TIP_POOL_MAX_DAYS
          ? t("stTipPeriodTooLong", "A pool can cover at most {n} days.", { n: TIP_POOL_MAX_DAYS })
          : "";
  const periodValid = !periodError;
  const periodText = periodValid ? periodLabel(period.from, period.to) : "";

  // Every hour in the period, summed per person below. Held while the period
  // is not a real one, so an un-asked question is never shown as a failure.
  const hoursQ = useAsyncData(
    () => api.get("/staff/hours", { params: { from: period.from, to: period.to } }),
    [period.from, period.to],
    { initial: [], enabled: periodValid },
  );

  const members = staffQ.data;
  const entries = hoursQ.data;
  const roster = useMemo(() => buildRoster(members, entries), [members, entries]);
  const staffHours = useMemo(
    () => roster.rows.map((r) => (r.staff_id in hoursEdits ? { ...r, hours: hoursEdits[r.staff_id] } : r)),
    [roster, hoursEdits],
  );

  // An even split of 100 %, to the hundredth, as the custom split's starting
  // point — the same largest-remainder rule as the money, so it sums to 100.
  const evenPct = useMemo(() => {
    const { parts } = splitOre(10000, roster.rows.map(() => 1));
    return Object.fromEntries(roster.rows.map((r, i) => [r.staff_id, (parts[i] / 100).toFixed(2)]));
  }, [roster]);
  const ratioOf = (id) => ratioEdits[id] ?? evenPct[id] ?? "";

  // Loads this form cannot save without. A failed staff list or hours read
  // must never become a split of the wrong people or of zero hours.
  const staffFailed = staffQ.failed;
  const hoursFailed = periodValid && hoursQ.failed;
  const loadsPending = staffQ.loading || (periodValid && hoursQ.loading);
  const loadsFailed = staffFailed || hoursFailed;
  const rosterReady = periodValid && !loadsPending && !loadsFailed;

  // parseMoneyInput, not parseFloat: this is what the whole distribution is
  // divided by, so a "1.500,50" read as 1.5005 would hand every staff member
  // a thousandth of their share.
  const amountParsed = parseMoneyInput(totalAmount, mLocale);
  const amount = Number.isFinite(amountParsed) && amountParsed > 0 ? amountParsed : 0;
  const amountOre = hundredths(amount);
  const amountRejected = isMoneyRejected(totalAmount, mLocale);

  const totalHours = useMemo(
    () => staffHours.reduce((sum, s) => sum + round2(s.hours), 0),
    [staffHours],
  );

  const totalCustomPercent = staffHours.reduce((sum, s) => sum + round2(ratioOf(s.staff_id)), 0);

  // The split, computed for every row from the moment the period loads — not
  // only once an amount is typed. The rows were hidden until then, while the
  // banner below already told the owner to "enter hours above".
  const split = useMemo(() => {
    const weights = staffHours.map((s) => {
      const h = round2(s.hours);
      if (splitMethod === "hours") return h;
      // A role split counts who WORKED — or, with no hours logged in the
      // period, everyone on the list. It gave everyone 0 % without hours,
      // while the banner told the owner to switch to exactly this split.
      if (splitMethod === "role") return (totalHours === 0 || h > 0) ? getRoleShare(s.role) : 0;
      return round2(ratioEdits[s.staff_id] ?? evenPct[s.staff_id] ?? 0);
    });
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const { parts, bumped } = splitOre(amountOre, weights);
    const rows = staffHours.map((s, i) => ({
      ...s,
      weight: weights[i],
      share_pct: splitMethod === "custom"
        ? round2(weights[i])
        : (weightSum > 0 ? round2((weights[i] / weightSum) * 100) : 0),
      share_ore: parts[i],
      bumped: bumped.has(i),
    }));
    return { rows, distributedOre: parts.reduce((a, b) => a + b, 0) };
  }, [staffHours, splitMethod, totalHours, ratioEdits, evenPct, amountOre]);

  // Where the spare øre went, in words — the honest version of the old
  // "Afrundingsforskel", which named a difference and gave it to nobody.
  const bumpedNames = split.rows.filter((r) => r.bumped).map(nameOf);
  const roundingNote = !bumpedNames.length ? "" : bumpedNames.length === 1
    ? t("stTipRoundingOne", "{amount} extra to {name} (rounding)", { amount: oreText(1), name: bumpedNames[0] })
    : t("stTipRoundingMany", "{amount} extra each to {names} (rounding)", {
      amount: oreText(1),
      names: new Intl.ListFormat(lang === "da" ? "da" : "en", { type: "conjunction" }).format(bumpedNames),
    });

  // The open clock-ins, by name. Names come from the roster this page already
  // loads (include_inactive, so a leaver's shift is still named); the hours
  // rows carry only staff_id. One person → that person's answer sheet opens on
  // Timer (?resolve=, the same deep link the schedule's chip uses).
  const openShifts = roster.openPunches;
  const openNames = [];
  if (openShifts.length) {
    const byId = new Map((members || []).map((m) => [String(m.id), m.name || m.full_name || ""]));
    const seen = new Set();
    for (const p of openShifts) {
      if (seen.has(p.staff_id)) continue;
      seen.add(p.staff_id);
      openNames.push(nameOf({ staff_id: p.staff_id, name: byId.get(p.staff_id) }));
    }
  }
  const timerHref = (() => {
    const q = new URLSearchParams({ tab: "hours", view: "details", from: period.from, to: period.to });
    if (openNames.length === 1 && openShifts.length) q.set("resolve", openShifts[0].staff_id);
    return `/staff/hours?${q.toString()}`;
  })();
  const openShiftText = openShifts.length === 1
    ? t("stfTipOpenShiftOne", "A shift for {name} on {date} has no clock-out, so it counts as 0 hours.", {
      name: openNames[0], date: periodLabel(null, openShifts[0].date),
    })
    : t("stfTipOpenShiftMany", "{n} shifts in this period have no clock-out and count as 0 hours: {names}.", {
      n: openShifts.length,
      names: new Intl.ListFormat(lang === "da" ? "da" : "en", { type: "conjunction" }).format(openNames),
    });

  // Below `sm` the table keeps three columns — person, the one column the
  // owner types in, amount — and the rest moves to a second line under the
  // name ("39,91 t · 30,2 %"). Five columns were 409 px in a 356 px card on a
  // 390 px phone and cut BELØB off. A custom split is typed in the share
  // column, so there the share stays and hours move to the line instead.
  const hoursCol = splitMethod === "custom" ? "hidden sm:table-cell" : "";
  const shareCol = splitMethod === "custom" ? "" : "hidden sm:table-cell";
  const rowFacts = (row) => [
    round2(row.hours) > 0 ? formatHours(round2(row.hours), { lang, decimals: 2 }) : null,
    splitMethod === "custom" ? null : pct(row.share_pct, lang),
  ].filter(Boolean).join(" · ");

  const updateStaffHours = (staffId, value) => {
    const h = Math.min(TIP_POOL_MAX_DAYS * 24, Math.max(0, parseFloat(value) || 0));
    setHoursEdits((prev) => ({ ...prev, [staffId]: h }));
  };

  const updateCustomRatio = (staffId, value) => {
    setRatioEdits((prev) => ({ ...prev, [staffId]: value }));
  };

  // `!success`: the saved message stays up for a beat before the history
  // opens, and the button under it must not save the same pool twice.
  const canSave = rosterReady && !saving && !success && amountOre > 0 && !amountRejected && staffHours.length > 0;

  const handleSubmit = async () => {
    if (!rosterReady) return;
    if (!amountOre) {
      setError(t("stErrEnterAmount", "Please enter a tip amount."));
      return;
    }
    if (staffHours.length === 0) {
      setError(t("stErrNoStaff", "No staff available for distribution."));
      return;
    }
    if (splitMethod === "custom" && (Math.abs(totalCustomPercent - 100) > 0.5 || split.distributedOre !== amountOre)) {
      setError(t("stErrCustomTotal", "Custom percentages must add up to 100%."));
      return;
    }
    if (splitMethod === "hours" && totalHours === 0) {
      setError(t("stErrNoHours", "No hours logged. Enter hours manually or switch to another split method."));
      return;
    }

    setSaving(true);
    setError("");
    try {
      await api.post("/staff/tips", {
        // `date` is the pool's LAST day — payroll buckets tips by it.
        date: period.to,
        period_start: period.from,
        total_amount: amountOre / 100,
        split_method: splitMethod,
        staff_hours: staffHours.map((s) => ({
          staff_id: s.staff_id,
          hours: round2(s.hours),
        })),
        // Only the people who get money. The server stores this split as
        // shown when it adds up to the øre, which by construction it does.
        distribution: split.rows.filter((d) => d.share_ore > 0).map((d) => ({
          staff_id: d.staff_id,
          amount: d.share_ore / 100,
          percentage: d.share_pct,
        })),
      });
      setSuccess(t("stSuccessDistributed", "Tips distributed successfully!"));
      setTimeout(() => {
        setSuccess("");
        onDone();
      }, 1500);
    } catch (err) {
      setError(errText(err, t("stErrSaveFailed", "Failed to save tip distribution.")));
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400 text-right text-lg";
  const labelClass = "text-sm font-medium text-gray-600 dark:text-gray-300";
  const dateClass = "w-full min-h-[44px] px-3 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400";

  return (
    <div className="space-y-4">
      {/* Period & Amount Card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 sm:p-6 space-y-5">
        <h2 className="text-lg font-bold dark:text-white">{t("stTipDetails", "Tip Details")}</h2>

        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className={labelClass} id="tip-period-label">{t("stTipPeriod", "Period")}</span>
            {periodValid && (
              <span className="text-sm text-gray-900 dark:text-gray-100 tabular-nums text-right">
                {periodText}
                <span className="text-gray-500 dark:text-gray-400">
                  {" · "}
                  {span === 1 ? t("stTipPeriodOneDay", "1 day") : t("stTipPeriodDays", "{n} days", { n: span })}
                </span>
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="tip-period-label">
            {PERIOD_PRESETS.map((p) => (
              <Chip key={p.id} selected={period.preset === p.id} onClick={() => pickPreset(p.id)}>
                {t(p.key, p.fallback)}
              </Chip>
            ))}
          </div>
          {period.preset === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className={labelClass}>{t("stTipPeriodFrom", "From")}</span>
                <input
                  type="date"
                  value={period.from}
                  max={period.to || todayIso}
                  onChange={(e) => changePeriod({ ...period, from: e.target.value })}
                  className={dateClass}
                />
              </label>
              <label className="block space-y-1">
                <span className={labelClass}>{t("stTipPeriodTo", "To")}</span>
                <input
                  type="date"
                  value={period.to}
                  min={period.from || undefined}
                  max={todayIso}
                  onChange={(e) => changePeriod({ ...period, to: e.target.value })}
                  className={dateClass}
                />
              </label>
            </div>
          )}
          {periodError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{periodError}</p>
          )}
        </div>

        <div className="sm:max-w-sm">
          <label htmlFor="tip-total-amount" className={labelClass}>{t("stTotalTips", "Total Tips")} ({currency})</label>
          <MoneyField
            id="tip-total-amount"
            locale={mLocale}
            placeholder="0,00"
            value={totalAmount}
            onChange={e => setTotalAmount(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {/* Split Method Card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 sm:p-6 space-y-4">
        <h2 className="text-lg font-bold dark:text-white">{t("stSplitMethod", "Split Method")}</h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {SPLIT_METHODS.map(method => (
            <button
              key={method.id}
              type="button"
              onClick={() => setSplitMethod(method.id)}
              aria-pressed={splitMethod === method.id}
              // Selected = the ink edge, light AND dark (the Chip rule). It was
              // a gray-300 edge on gray-50 — next to the unselected gray-200
              // on white, the owner could not tell which split was on.
              className={`p-3 rounded-xl border-2 text-left transition-all ${
                splitMethod === method.id
                  ? "border-gray-900 bg-gray-50 dark:border-gray-100 dark:bg-gray-700/50"
                  : "border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500"
              }`}
            >
              <div className="flex items-center gap-2">
                <method.icon className="w-4 h-4 text-gray-500 dark:text-gray-400" strokeWidth={1.75} aria-hidden="true" />
                <span className="text-sm font-semibold text-gray-900 dark:text-white">
                  {t(method.labelKey, method.labelFallback)}
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                {t(method.descKey, method.descFallback)}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Staff Distribution Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="p-5 sm:p-6 pb-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold dark:text-white">{t("stStaffDistribution", "Staff Distribution")}</h2>
            {amountOre > 0 && (
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                {oreText(amountOre)}
              </span>
            )}
          </div>

          {/* Failure first, and INSTEAD of the table: a roster read from a
              failed request is the wrong people, or everyone at 0 t. */}
          {staffFailed && (
            <LoadFailed
              className="mb-5"
              title={t("stfStaffLoadFailed", "Couldn't load your staff.")}
              onRetry={staffQ.reload}
            />
          )}
          {!staffFailed && hoursFailed && (
            <LoadFailed
              className="mb-5"
              title={t("stTipHoursFailed", "Couldn't load the hours for this period.")}
              onRetry={hoursQ.reload}
            />
          )}

          {!loadsFailed && periodValid && loadsPending && (
            <div className="text-center py-8 text-gray-400">
              <div className="animate-spin inline-block w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full mb-2" />
              <p className="text-sm">{t("stLoadingHours", "Loading staff hours...")}</p>
            </div>
          )}

          {rosterReady && staffHours.length === 0 && (
            <div className="text-center py-8">
              <Icon name="Users" size={28} className="mx-auto mb-2 text-gray-400 dark:text-gray-500" />
              <p className="font-semibold dark:text-white">{t("stNoStaffFound", "No staff found")}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t("stNoStaffHint", "Add staff members first, or check that hours are logged in {date}.", { date: periodText })}
              </p>
            </div>
          )}
        </div>

        {rosterReady && staffHours.length > 0 && (
          // overflow-x-auto stays as the last resort only: at 356 px the
          // three phone columns fit without it (no fixed widths below sm).
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700">
                  <th className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider pl-4 pr-2 sm:px-5 py-3">
                    {t("stColStaff", "Staff")}
                  </th>
                  <th className={`text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-2 sm:px-3 py-3 sm:w-24 ${hoursCol}`}>
                    {t("stColHours", "Hours")}
                  </th>
                  {splitMethod === "role" && (
                    <th className="hidden sm:table-cell text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-3 py-3 sm:w-20">
                      {t("stColWeight", "Weight")}
                    </th>
                  )}
                  <th className={`text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-2 sm:px-3 py-3 sm:w-24 ${shareCol}`}>
                    {t("stColShare", "Share %")}
                  </th>
                  <th className="text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider pl-2 pr-4 sm:px-5 py-3 sm:w-28">
                    {t("stColAmount", "Amount")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {split.rows.map(row => {
                  const facts = rowFacts(row);
                  return (
                    <tr key={row.staff_id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                      <td className="pl-4 pr-2 sm:px-5 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white break-words">{nameOf(row)}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{roleName(row.role, t)}</p>
                          {/* Phone only: what the hidden columns said. */}
                          {facts && (
                            <p className="sm:hidden text-xs text-gray-500 dark:text-gray-400 tabular-nums" data-testid="tip-row-facts">
                              {facts}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className={`px-2 sm:px-3 py-3 text-right ${hoursCol}`}>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.5"
                          min="0"
                          max={TIP_POOL_MAX_DAYS * 24}
                          value={row.hours || ""}
                          onChange={e => updateStaffHours(row.staff_id, e.target.value)}
                          aria-label={`${t("stColHours", "Hours")} — ${nameOf(row)}`}
                          className="w-[4.5rem] sm:w-20 px-2 py-1.5 min-h-[44px] sm:min-h-0 text-sm text-right tabular-nums border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-400"
                          placeholder="0"
                        />
                      </td>
                      {splitMethod === "role" && (
                        <td className="hidden sm:table-cell px-3 py-3 text-right">
                          <span className="text-sm text-gray-600 dark:text-gray-300 tabular-nums">
                            {formatHoursNumber(getRoleShare(row.role), lang)}x
                          </span>
                        </td>
                      )}
                      <td className={`px-2 sm:px-3 py-3 text-right ${shareCol}`}>
                        {splitMethod === "custom" ? (
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            max="100"
                            value={ratioOf(row.staff_id)}
                            onChange={e => updateCustomRatio(row.staff_id, e.target.value)}
                            aria-label={`${t("stColShare", "Share %")} — ${nameOf(row)}`}
                            className="w-[4.5rem] sm:w-20 px-2 py-1.5 min-h-[44px] sm:min-h-0 text-sm text-right tabular-nums border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-400"
                            placeholder="0"
                          />
                        ) : (
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 tabular-nums">
                            {pct(row.share_pct, lang)}
                          </span>
                        )}
                      </td>
                      <td className="pl-2 pr-4 sm:px-5 py-3 text-right whitespace-nowrap">
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                          {row.share_ore > 0 ? oreText(row.share_ore) : "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50">
                  <td className="pl-4 pr-2 sm:px-5 py-3 text-sm font-bold text-gray-900 dark:text-white">{t("total", "Total")}</td>
                  <td className={`px-2 sm:px-3 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-300 tabular-nums ${hoursCol}`}>
                    {/* formatHoursNumber, not formatHours: the unit is
                        already in this column's header, and the cells above
                        are raw number inputs the owner typed — stamping a unit
                        on the total alone would read as a different notation
                        from the column it sums. toFixed(1) handed a Danish
                        owner "38.5" where they write "38,5". */}
                    {totalHours > 0 ? formatHoursNumber(totalHours, lang, 2) : "—"}
                  </td>
                  {splitMethod === "role" && <td className="hidden sm:table-cell px-3 py-3" />}
                  <td className={`px-2 sm:px-3 py-3 text-right ${shareCol}`}>
                    <span className={`text-sm font-semibold tabular-nums ${
                      splitMethod === "custom" && Math.abs(totalCustomPercent - 100) > 0.5
                        ? "text-red-600 dark:text-red-400"
                        : "text-gray-900 dark:text-gray-300"
                    }`}>
                      {splitMethod === "custom"
                        ? pct(totalCustomPercent, lang)
                        : pct(split.rows.reduce((s, d) => s + d.share_pct, 0), lang)
                      }
                    </span>
                  </td>
                  <td className="pl-2 pr-4 sm:px-5 py-3 text-right whitespace-nowrap text-sm font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                    {split.distributedOre > 0 ? oreText(split.distributedOre) : "—"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Notes under the table — quiet unless something needs the owner. */}
        {rosterReady && staffHours.length > 0 && roundingNote && (
          <p className="mx-5 mt-3 mb-1 text-xs text-gray-500 dark:text-gray-400 text-right">{roundingNote}</p>
        )}

        {/* Amber: it needs the owner. WHOSE shift, and one tap to Timer on
            this same period, where it is answered. */}
        {rosterReady && openShifts.length > 0 && (
          <div
            data-testid="tip-open-shifts"
            className="mx-4 sm:mx-5 my-3 px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-sm text-amber-800 dark:text-amber-200"
          >
            <p>
              <Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" />
              {openShiftText}
            </p>
            <div className="flex flex-wrap items-center gap-x-3">
              <Link
                to={timerHref}
                className="inline-flex items-center gap-1 min-h-[40px] font-semibold underline underline-offset-2 decoration-amber-400 hover:text-amber-900 dark:hover:text-amber-100"
              >
                {openShifts.length === 1
                  ? t("stfTipOpenShiftFixOne", "Fix it under Hours")
                  : t("stfTipOpenShiftFixMany", "Fix them under Hours")}
                <Icon name="ChevronRight" size={14} />
              </Link>
              <span className="text-xs text-amber-700 dark:text-amber-300">
                {t("stfTipOpenShiftOr", "Or type the hours in the table above.")}
              </span>
            </div>
          </div>
        )}

        {rosterReady && splitMethod === "custom" && Math.abs(totalCustomPercent - 100) > 0.5 && totalCustomPercent > 0 && (
          <div className="mx-5 my-3 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 rounded-xl text-sm text-red-600 dark:text-red-400">
            {t("stPercentTotalPrefix", "Percentages total")} {pct(totalCustomPercent, lang)} — {t("stMustEqual100", "must equal 100%")}
          </div>
        )}

        {rosterReady && splitMethod === "hours" && totalHours === 0 && staffHours.length > 0 && (
          <div className="mx-5 my-3 px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-sm text-amber-700 dark:text-amber-300">
            <Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" />
            {t("stNoHoursBanner", "No hours logged in {date}. Enter hours above, or switch to Role or Custom split.", { date: periodText })}
          </div>
        )}
        <div className="h-2" />
      </div>

      {/* Submit — the table above is the preview. */}
      {amountOre > 0 && (staffHours.length > 0 || loadsFailed) && (
        <div className="space-y-3">
          {/* Error / Success */}
          {error && (
            <div role="alert" className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-4 py-3 rounded-xl text-sm font-medium text-center inline-flex w-full items-center justify-center gap-2">
              <Icon name="Check" size={16} className="text-emerald-600 dark:text-emerald-400" />
              {success}
            </div>
          )}

          {/* The shared primary: gray-900 in light, gray-100 in dark. The
              hand-rolled bg-gray-900 had no dark pair and vanished into the
              dark page. */}
          <Button
            variant="primary"
            size="lg"
            className="w-full text-base font-semibold"
            onClick={handleSubmit}
            disabled={!canSave}
            busy={saving}
          >
            {saving ? t("stDistributing", "Distributing...") : `${t("stDistribute", "Distribute")} ${oreText(amountOre)}`}
          </Button>
          {loadsFailed && (
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
              {t("stTipSaveBlocked", "Saving is paused until your staff and their hours have loaded.")}
            </p>
          )}

          {/* Tax reminder */}
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-xs text-amber-700 dark:text-amber-300">
            <strong>{t("stTaxNoteLabel", "Tax note:")}</strong> {t("stTaxNoteBody", "Tips must be reported per local tax law. Share distribution records with your accountant.")}
          </div>
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   TIP HISTORY VIEW
   ═══════════════════════════════════════════════════════════ */
// Status chips: amber = still the owner's to decide, emerald = done. The same
// soft 50/700 pairs as Timer's method badges. "Afventer" was yellow, a colour
// with no meaning anywhere else in the app.
const CHIP_PENDING = "bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/25 dark:text-amber-300 dark:ring-amber-900/40";
const CHIP_CONFIRMED = "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-900/25 dark:text-emerald-300 dark:ring-emerald-900/40";

function TipHistoryView({ historyQ, currency, t }) {
  // `t` arrives as a prop, but the hour unit is the LANGUAGE's, not the
  // catalogue's — so this view reads `lang` straight from the hook.
  const { lang } = useLanguage();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null); // { id, msg }
  const [expandedId, setExpandedId] = useState(null);
  const money = (n) => formatOwnerMoney(parseFloat(n) || 0, currency, { decimals: 2 });
  const nameOf = (d) => d.staff_name || t("stfStaffNumber", "Staff #{id}", { id: String(d.staff_id).slice(0, 8) });

  const data = historyQ.data || [];

  // Locking is one tap from irreversible: say what it does, to how much, for
  // which period — it locked on a single tap with no question at all.
  const handleConfirm = async (tip) => {
    const ok = await confirm({
      title: t("stTipConfirmTitle", "Confirm the split?"),
      message: t(
        "stTipConfirmBody",
        "{amount} for {period} is locked once you confirm. It can't be changed or deleted afterwards.",
        { amount: money(tip.total_amount), period: periodLabel(tip.period_start, tip.date) },
      ),
      confirmLabel: t("stTipConfirmCta", "Confirm and lock"),
    });
    if (!ok) return;
    setBusyId(tip.id);
    setActionError(null);
    try {
      await api.post(`/staff/tips/${tip.id}/confirm`);
      historyQ.reload();
    } catch (err) {
      // It failed silently: the button came back and the pool still said
      // "Afventer", which reads like the tap did not register.
      setActionError({ id: tip.id, msg: errText(err, t("stTipConfirmFailed", "Couldn't confirm the split. Try again.")) });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (tip) => {
    const ok = await confirm({
      title: t("stTipDeleteTitle", "Delete this split?"),
      message: t(
        "stTipDeleteBody",
        "The {amount} split for {period} will be deleted. This can't be undone.",
        { amount: money(tip.total_amount), period: periodLabel(tip.period_start, tip.date) },
      ),
      confirmLabel: t("delete", "Delete"),
      destructive: true,
    });
    if (!ok) return;
    setBusyId(tip.id);
    setActionError(null);
    try {
      await api.delete(`/staff/tips/${tip.id}`);
      setExpandedId(null);
      historyQ.reload();
    } catch (err) {
      setActionError({ id: tip.id, msg: errText(err, t("stTipDeleteFailed", "Couldn't delete the split. Try again.")) });
    } finally {
      setBusyId(null);
    }
  };

  // THE THIRD STATE. A failed read is never "no distributions yet". With
  // nothing loaded it is only the failure; with an earlier answer on screen,
  // that answer stays and is labelled stale.
  if (historyQ.failed && data.length === 0) {
    return (
      <LoadFailed
        title={t("stTipHistoryFailed", "Couldn't load the tip history.")}
        onRetry={historyQ.reload}
      />
    );
  }
  // Nothing on screen yet, so a spinner — including the reload right after
  // the first save, which otherwise flashed a "0 kr. · 0/0" summary.
  if (historyQ.loading && data.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 dark:text-gray-500">
        <div className="animate-spin inline-block w-6 h-6 border-2 border-gray-300 border-t-transparent rounded-full mb-3" />
        <p className="text-sm">{t("loading", "Loading…")}</p>
      </div>
    );
  }
  if (historyQ.isEmpty) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <Icon name="Coins" size={32} className="mx-auto mb-3 text-gray-400 dark:text-gray-500" />
        <p className="font-semibold dark:text-white">{t("stNoDistributions", "No tip distributions yet")}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t("stNoDistributionsHint", "Create your first tip distribution to see history here.")}
        </p>
      </div>
    );
  }

  // Newest pool first: by its last day, then by when it was saved.
  const sorted = [...data].sort((a, b) =>
    (b.date || "").localeCompare(a.date || "") || (b.created_at || "").localeCompare(a.created_at || ""));

  // Stats summary
  const totalTips = data.reduce((s, d) => s + (parseFloat(d.total_amount) || 0), 0);
  const confirmedCount = data.filter(d => d.status === "confirmed" || d.confirmed).length;

  return (
    <div className="space-y-4">
      {historyQ.failed && (
        <LoadFailed
          onRetry={historyQ.reload}
          body={t("loadFailedStale", "These are the last figures that loaded — they may be out of date.")}
        />
      )}

      {/* Summary Row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("stTotalDistributed", "Total Distributed")}</p>
          <p className="text-lg font-bold text-gray-900 dark:text-gray-100 mt-1 tabular-nums">
            {money(totalTips)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("stDistributions", "Distributions")}</p>
          <p className="text-lg font-bold dark:text-white mt-1 tabular-nums">{data.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("stConfirmedLabel", "Confirmed")}</p>
          <p className="text-lg font-bold dark:text-white mt-1 tabular-nums">
            {confirmedCount}/{data.length}
          </p>
        </div>
      </div>

      {/* Tip Cards */}
      <StaggerContainer className="space-y-3">
        {sorted.map(tip => {
          const isConfirmed = tip.status === "confirmed" || tip.confirmed;
          const isPending = !isConfirmed;
          const isExpanded = expandedId === tip.id;
          const distributions = tip.distribution || tip.distributions || [];
          const busy = busyId === tip.id;

          return (
            <StaggerItem key={tip.id}>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden">
                {/* Card Header */}
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : tip.id)}
                  aria-expanded={isExpanded}
                  className="w-full p-4 sm:p-5 text-left"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-bold text-gray-900 dark:text-white">
                        {tip.date ? periodLabel(tip.period_start, tip.date) : t("stUnknownDate", "Unknown date")}
                      </h3>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                        {/* No `capitalize`: the label is already cased per
                            language, and CSS would Title-Case the Danish
                            ("Efter Rolle"). */}
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {splitMethodLabel(tip.split_method, t)}
                        </span>
                        <span className="text-xs text-gray-300 dark:text-gray-600" aria-hidden="true">{"·"}</span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {distributions.length === 1
                            ? t("stfStaffCountOne", "1 staff member")
                            : `${distributions.length} ${t("stStaffCountSuffix", "staff")}`}
                        </span>
                      </div>
                    </div>
                    <div className="text-right flex flex-col items-end gap-2 shrink-0">
                      <p className="text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                        {money(tip.total_amount)}
                      </p>
                      {isConfirmed ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${CHIP_CONFIRMED}`}>
                          <Icon name="Check" size={12} />
                          {t("stConfirmedBadge", "Confirmed")}
                        </span>
                      ) : (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${CHIP_PENDING}`}>
                          {t("stPendingBadge", "Pending")}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Collapsed preview: first 3 staff */}
                  {!isExpanded && distributions.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {distributions.slice(0, 3).map((d, i) => (
                        <span key={i} className="px-2 py-1 bg-gray-50 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 rounded-lg text-xs font-medium tabular-nums">
                          {nameOf(d)}: {money(d.amount)}
                        </span>
                      ))}
                      {distributions.length > 3 && (
                        <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-lg text-xs">
                          +{distributions.length - 3} {t("stMoreSuffix", "more")}
                        </span>
                      )}
                    </div>
                  )}
                </button>

                {/* Expanded Breakdown */}
                {isExpanded && (
                  <div className="px-4 sm:px-5 pb-4 sm:pb-5 border-t border-gray-100 dark:border-gray-700">
                    <div className="pt-4 space-y-2">
                      {distributions.map((d, i) => {
                        // Hours as a pay quantity ("37,5 t"), not a duration
                        // ("37 t 30 min"); the share the API stores is
                        // share_pct — `percentage` was read and never present.
                        const facts = [
                          d.hours != null && Number(d.hours) > 0 ? formatHours(Number(d.hours), { lang, decimals: 2 }) : null,
                          d.share_pct != null ? pct(d.share_pct, lang) : null,
                        ].filter(Boolean);
                        return (
                          <div key={i} className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl">
                            <div>
                              <p className="text-sm font-medium dark:text-white">{nameOf(d)}</p>
                              {facts.length > 0 && (
                                <p className="text-xs text-gray-500 dark:text-gray-400">{facts.join(" · ")}</p>
                              )}
                            </div>
                            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                              {money(d.amount)}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {actionError?.id === tip.id && (
                      <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{actionError.msg}</p>
                    )}

                    {/* An unconfirmed pool: lock it, or throw it away. */}
                    {isPending && (
                      <div className="mt-4 flex flex-col sm:flex-row gap-2">
                        <Button
                          variant="primary"
                          size="lg"
                          className="w-full sm:flex-1"
                          onClick={() => handleConfirm(tip)}
                          disabled={busy}
                          busy={busy}
                          iconLeft={<Icon name="Lock" size={16} />}
                        >
                          {t("stConfirmDistribution", "Confirm Distribution")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="lg"
                          className="w-full sm:w-auto"
                          onClick={() => handleDelete(tip)}
                          disabled={busy}
                          iconLeft={<Icon name="Trash2" size={16} />}
                        >
                          {t("delete", "Delete")}
                        </Button>
                      </div>
                    )}
                    {/* What confirming DOES, on the card — it was only said in
                        the dialog after the tap. True since the staff portal
                        shows confirmed pools only (routers/staff_portal.py). */}
                    {isPending && (
                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="tip-confirm-hint">
                        {t("stfTipConfirmHint", "Locks the split and shows it to your staff.")}
                      </p>
                    )}

                    {isConfirmed && (
                      <div className="mt-4 px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 rounded-xl text-sm text-gray-600 dark:text-gray-300 font-medium inline-flex w-full items-center justify-center gap-2">
                        <Icon name="Lock" size={14} />
                        {t("stLockedNotice", "Locked — This distribution has been confirmed")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </StaggerItem>
          );
        })}
      </StaggerContainer>
    </div>
  );
}
