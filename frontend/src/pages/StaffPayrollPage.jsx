// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useConfirm } from "../hooks/useConfirm";
import { Fragment, useState, useEffect, useMemo, useRef } from "react";
import api from "../services/api";
import { saveFile } from "../utils/download";
import { stepPayPeriod } from "../utils/payPeriod";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { readViewedPeriod, writeViewedPeriod } from "../utils/viewedPeriod";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useAsyncData } from "../hooks/useAsyncData";
import { displayCurrency, formatOwnerMoney } from "../utils/currency";
import { formatHours } from "../utils/hours";
import { localIso, dateLocale } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";
import DismissibleTip from "../components/DismissibleTip";
import { UpgradeNudge, PageHeader, Button, SectionBanner, Icon, LoadFailed } from "../components/ui";
import { isStaffMemberRole } from "../config/navManifest";
import { contractLabel } from "../config/scheduleGrid";

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
// Role names as the owner reads them. staff_members.role is free text, so the
// stored value is never rewritten — only what is shown. Same map as the twins
// in StaffSchedulePage, StaffTipsPage and StaffPortalPage; unknown roles (and
// the salon vocabulary, Danish in both languages) show exactly as typed.
//
// It also covers every code the revisor CSV and the lønseddel translate
// (backend services/pay_labels.py): "bar" printed raw on this screen while
// the file made from the same row said "Bar".
const ROLE_NAME_KEYS = {
  chef: ["stfRoleChef", "Chef"],
  cook: ["stfRoleChef", "Chef"],
  server: ["stfRoleServer", "Server"],
  waiter: ["stfRoleServer", "Server"],
  dishwasher: ["stfRoleDishwasher", "Dishwasher"],
  manager: ["teamRoleManager", "Manager"],
  kitchen: ["roleKitchen", "Kitchen"],
  bar: ["roleBar", "Bar"],
  bartender: ["stfRoleBartender", "Bartender"],
  barista: ["stfRoleBarista", "Barista"],
  host: ["stfRoleHost", "Host"],
  runner: ["stfRoleRunner", "Runner"],
  cleaner: ["stfRoleCleaner", "Cleaner"],
  floor: ["roleFloor", "Floor"],
  "full-time": ["contractFull", "Full-time"],
  full_time: ["contractFull", "Full-time"],
  "part-time": ["contractPart", "Part-time"],
  part_time: ["contractPart", "Part-time"],
  student: ["contractStudent", "Student"],
};
function roleName(role, t) {
  const hit = ROLE_NAME_KEYS[String(role || "").trim().toLowerCase()];
  return hit ? t(hit[0], hit[1]) : role;
}

// A catalogue sentence whose {slot} holds markup (a bold phrase): split on the
// placeholder so each language can put the phrase where its grammar wants it.
function fillSlots(text, slots) {
  return String(text).split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in slots ? <Fragment key={i}>{slots[m[1]]}</Fragment> : part;
  });
}
// MONEY, the account's way — not the browser's.
//
// This built its own string with toLocaleString(undefined, ...), and
// `undefined` means the BROWSER's locale, not the account's. On a DKK account
// opened in an English session the payroll screen read "988.90 DKK" where the
// Hours tab beside it read "988,90 kr." — the same figure, two notations, and
// the wrong one on the screen where the owner decides what to pay. It also
// printed the raw ISO code instead of the unit a Dane writes.
//
// formatOwnerMoney is the one source: DKK routes through formatKr ("988,90
// kr.", da-DK), everything else through formatMoney with locale-correct
// grouping and the code. `cur` is kept in the signature so the 16 call sites
// stay untouched.
function fmtMoney(n, cur) {
  if (n == null) return "—";
  return formatOwnerMoney(n, cur, { decimals: 2 });
}

// Hours are NOT formatted here. The unit belongs to the language — this page
// typed a hardcoded "h", so a Danish owner read an English unit on a payroll
// figure. formatHours() from utils/hours.js is the one source; these are pay
// QUANTITIES multiplied by a rate, so they keep the decimal form (6,8 t),
// not the spoken duration form (6 t 48 min).

// The window the way Timer prints it — "1. sep. – 30. sep." (StaffHoursPage
// fmtPeriod) — in the app's date locale. This tab printed "01/09/26 –
// 30/09/26" one tap away from Timer's "1. sep. – 30. sep." for the same
// month. The year only when the window is not this year's, or `always` — a
// file that leaves the building is read without this screen around it.
const noonOf = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};
function dayLabel(iso, withYear = false) {
  return noonOf(iso).toLocaleDateString(
    dateLocale(),
    withYear ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" },
  );
}
function periodLabel(start, end, { always = false } = {}) {
  if (!start || !end) return "—";
  const thisYear = new Date().getFullYear();
  const a = noonOf(start).getFullYear();
  const b = noonOf(end).getFullYear();
  if (!always && a === thisYear && b === thisYear) return `${dayLabel(start)} – ${dayLabel(end)}`;
  // One year on both ends is said once, at the end: "1. sep. – 30. sep. 2026".
  return `${dayLabel(start, a !== b)} – ${dayLabel(end, true)}`;
}

// Another tab of the Hours hub, on the window on screen (utils/viewedPeriod):
// Timer's Detaljer is where the period is approved and open shifts answered.
function hubHref(tab, period, extra = {}) {
  const q = new URLSearchParams({ tab, ...extra });
  if (period?.period_start && period?.period_end) {
    q.set("from", period.period_start);
    q.set("to", period.period_end);
  }
  return `/staff/hours?${q.toString()}`;
}
// Where the revisor's address is kept: Profile → the #billing section
// (ProfilePage "Revisor-kontakt"), the same target ConnectionsProgressCard uses.
const REVISOR_EMAIL_HREF = "/profile#billing";

// `value` is what the API stores (weather_condition); the label is t(labelKey).
// `icon` is a Lucide name for <Icon>, not an emoji: the list and the select
// rendered a face, a house, a cloud and a memo, drawn differently on every
// platform and announced to a screen reader as just that.
const REASON_OPTIONS = [
  { value: "sick", labelKey: "sickReasonSick", fallback: "Sick", icon: "Thermometer" },
  { value: "personal", labelKey: "sickReasonPersonal", fallback: "Personal", icon: "Home" },
  { value: "weather", labelKey: "sickReasonWeather", fallback: "Weather", icon: "CloudRain" },
  { value: "other", labelKey: "sickReasonOther", fallback: "Other", icon: "FileText" },
];

// The three lønperioder this select offers. Timer can also SAVE "weekly" and
// "biweekly" to the same shared config (StaffHoursPage FRAME_OPTIONS); when it
// has, that value is shown here as it is instead of falling to the first
// option — a select reading "Kalendermåned" over a weekly period is a setting
// the owner never chose.
const PAY_PERIOD_TYPES = ["monthly_1st", "monthly_15th", "custom"];
const SAVED_ELSEWHERE_FRAME_KEYS = {
  weekly: ["hovFrameWeekly", "Every week (Mon–Sun)"],
  biweekly: ["hovFrameBiweekly", "Every 2 weeks"],
};

// Phone controls are 40px at the least (the house floor, Sep-27). Selects and
// number inputs get no help from the coarse-pointer button rule in index.css.
const PHONE_FIELD = "min-h-[40px] sm:min-h-0";

// A person on the roster with nothing logged in the period: a real zero,
// because the hours read DID answer (a failed read never reaches the table).
const NO_PAY = { hours: 0, base_earned: 0, overtime: 0, overtime_hours: 0, tips: 0, total: 0 };

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function StaffPayrollPage() {
  const { user } = useAuth();
  const { t, lang } = useLanguage();
  const currency = displayCurrency(user?.currency);
  // A manager reaches this tab (/staff/hours is not an ownerOnly destination)
  // and keeps the wage-cost estimate they build rotas against. The two payroll
  // ARTEFACTS are a different thing — the CSV is a payroll-bureau handoff and
  // the Lønseddel is every colleague's payslip. The server denies both to any
  // staff seat (_MANAGER_READ_DENY_PREFIXES); hiding them here keeps that from
  // reading as a broken button.
  const isStaffSeat = isStaffMemberRole(user?.role);

  // ─── Reads ───
  // THREE outcomes per read (hooks/useAsyncData), never two. Every fetch on
  // this tab used to `.catch()` into something that looked like an answer: a
  // failed hours read became "5 medarbejdere · 0 t · 0,00 kr. i alt", a failed
  // estimate "registrér medarbejdertimer først", a failed roster "no staff",
  // and a failed pay period a made-up fortnight ending today — all of them
  // exportable. A failure is now LoadFailed with a retry, and the exports wait
  // for it (exportBlocked below).

  // ─── Pay Period ───
  // /pay-period/current carries the saved frame as well (period_type +
  // custom_start_day), so ONE read hydrates the window and the select. The
  // separate GET /pay-period it used to make could fail on its own and leave
  // the select — and the Previous/Next stepping — on a frame nobody chose.
  const currentQ = useAsyncData(() => api.get("/staff/pay-period/current"), []);
  const serverPeriod = useMemo(() => {
    const d = currentQ.data;
    if (!d) return null;
    // Backend returns { start_date, end_date }; the rest of this page
    // reads period_start / period_end. Normalise here so we don't have
    // to thread the legacy key names through every consumer below.
    return {
      period_start: d.period_start || d.start_date || null,
      period_end: d.period_end || d.end_date || null,
    };
  }, [currentQ.data]);
  const serverCfg = useMemo(() => ({
    period_type: currentQ.data?.period_type || "monthly_1st",
    custom_start_day: currentQ.data?.custom_start_day || 16,
  }), [currentQ.data]);
  // Where Previous/Next has stepped to; null = the server's current window.
  // Seeded from the URL: the window the owner was looking at in Timer comes
  // with them (utils/viewedPeriod.js) — approving September there and landing
  // on October's payroll here is how the wrong month reaches the revisor.
  const [searchParams, setSearchParams] = useSearchParams();
  const [periodOverride, setPeriodOverride] = useState(() => {
    const p = readViewedPeriod(searchParams);
    return p ? { period_start: p.from, period_end: p.to } : null;
  });
  const period = periodOverride || serverPeriod;
  // …and the window on screen goes back into the URL for the next tab.
  useEffect(() => {
    if (!serverPeriod) return;
    writeViewedPeriod(
      searchParams, setSearchParams,
      periodOverride ? { from: periodOverride.period_start, to: periodOverride.period_end } : null,
      { from: serverPeriod.period_start, to: serverPeriod.period_end },
    );
  }, [periodOverride, serverPeriod, searchParams, setSearchParams]);
  // Owner-configurable DK lønperiode (calendar month / 15th→14th / custom day):
  // what was last SAVED, and what is being typed into the controls right now.
  const [lastSavedCfg, setLastSavedCfg] = useState(null);
  const [cfgDraft, setCfgDraft] = useState(null);
  const periodCfg = cfgDraft || lastSavedCfg || serverCfg;
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgError, setCfgError] = useState("");

  // ─── Staff & Hours ───
  const staffQ = useAsyncData(() => api.get("/staff/members"), [], { initial: [] });
  const staffList = useMemo(() => staffQ.data || [], [staffQ.data]);
  // Who is LEFT OUT, rather than who is in: everyone starts selected without an
  // effect copying the roster into state, as the first load always did.
  const [deselected, setDeselected] = useState(() => new Set());
  const selectedIds = useMemo(
    () => new Set(staffList.map((s) => s.id).filter((id) => !deselected.has(id))),
    [staffList, deselected],
  );
  const hoursQ = useAsyncData(
    () => api.get("/staff/hours/summary", {
      params: { from: period.period_start, to: period.period_end },
    }),
    [period?.period_start, period?.period_end],
    { initial: [], enabled: !!period },
  );
  const hoursSummary = useMemo(() => hoursQ.data || [], [hoursQ.data]);
  // Staff list collapses by default — 16+ checkboxes was too much scroll on
  // the way to the preview + export buttons. Header shows the count; tap to open.
  const [staffOpen, setStaffOpen] = useState(false);
  // Per-staff preview table also collapses by default — same scroll problem.
  // Collapsed state still shows the grand total (staff · hours · payout).
  const [previewOpen, setPreviewOpen] = useState(false);

  // ─── PDF ───
  const [pdfLoading, setPdfLoading] = useState(false);

  // ─── Sick Calls ───
  const sickQ = useAsyncData(async () => {
    const [calls, stats] = await Promise.all([
      api.get("/weather/sick-calls"),
      api.get("/weather/sick-calls/stats"),
    ]);
    return { calls: calls.data || [], stats: stats.data || null };
  }, []);
  const sickCalls = sickQ.data?.calls || [];
  const sickStats = sickQ.data?.stats || null;
  const sickLoading = sickQ.loading && !sickQ.data;
  const [sickForm, setSickForm] = useState({
    staff_name: "",
    date: localIso(),
    reason: "",
    notes: "",
  });
  const [sickSuccess, setSickSuccess] = useState("");

  // ─── Error ───
  // { text, action } — `action` names the one place that fixes it ("timer"
  // for a shift with no clock-out, "profile" for a missing revisor address),
  // so a refusal is never a dead end. "Ret dem under Timer først" used to
  // stop there, with no way to get to Timer but finding the tab.
  const [error, setErrorState] = useState(null);
  const setError = (text, action = null) => setErrorState(text ? { text, action } : null);
  // The refusal renders below the export buttons — on a phone that was under
  // the bottom bar, so a tap looked like it did nothing. Bring it into view.
  const errorRef = useRef(null);
  useEffect(() => {
    if (error && errorRef.current?.scrollIntoView) {
      errorRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [error]);
  // A shift with no clock-out, named — the same words on every export path.
  // The send path printed the server's ENGLISH sentence where the PDF beside
  // it printed this Danish one.
  const openPunchText = (detail) => (detail.count === 1
    ? t("payrollOpenPunchesOne", "1 shift has no clock-out ({list}). Fix it under Timer first — an open shift would be paid as 0 kr.", { list: detail.list })
    : t("payrollOpenPunches", "{n} shifts have no clock-out ({list}). Fix them under Timer first — an open shift would be paid as 0 kr.", { n: detail.count, list: detail.list }));

  // ─── Who "Send til revisor" mails ───
  // Read the way the send endpoint reads it (BusinessProfile.accountant_email,
  // trimmed and lower-cased — routers/staff.py send_payroll_to_accountant), so
  // the confirm names the address the server will actually use. The only hint
  // used to be a hover tooltip, which a phone never shows. Three outcomes like
  // every read here: a failed profile is never "you have no revisor email".
  const profileQ = useAsyncData(() => api.get("/business"), []);
  const revisorEmail = String(profileQ.data?.accountant_email || "").trim().toLowerCase();
  const revisorName = String(profileQ.data?.accountant_name || "").trim();
  const profileKnown = !profileQ.loading && !profileQ.failed;
  const navigate = useNavigate();

  // ─── Danish payroll estimate (only relevant for DKK users) ───
  const isDanish = user?.currency === "DKK";
  const dkQ = useAsyncData(
    () => api.get("/staff/payroll/estimate", {
      params: { period_start: period.period_start, period_end: period.period_end },
    }),
    [period?.period_start, period?.period_end],
    { enabled: !!period && isDanish },
  );
  const dkEstimate = dkQ.data;
  const dkLoading = dkQ.loading;

  // Every export waits for the reads it is made from. A file produced while
  // this screen could not read the period, the roster or the hours is a file
  // the owner had no way to check — and the CSV and the lønseddel are built
  // from the same window the estimate failed to load.
  const exportBlocked =
    !period || currentQ.failed || staffQ.failed || hoursQ.failed || (isDanish && dkQ.failed);

  /* ─── Save lønperiode config → reload the computed current period ─── */
  const savePeriodCfg = async (periodType, customDay) => {
    const day = Math.min(28, Math.max(1, Number(customDay) || 16));
    const next = { period_type: periodType, custom_start_day: day };
    setSavingCfg(true);
    setCfgError("");
    setCfgDraft(next);
    try {
      await api.post("/staff/pay-period", {
        period_type: periodType,
        custom_start_day: periodType === "custom" ? day : null,
      });
    } catch {
      // Put the select back. It went on showing the frame that failed to
      // save while every number and export below still used the old one.
      setCfgDraft(null);
      setCfgError(t("payrollPeriodSaveFailed", "Couldn't save the pay period. Try again."));
      setSavingCfg(false);
      return;
    }
    // Saved. Back to the current window of the new frame, through the same
    // read as the first load — so if it fails, it says so (LoadFailed) instead
    // of keeping the old window under the new frame's name.
    setLastSavedCfg(next);
    setCfgDraft(null);
    setPeriodOverride(null);
    await currentQ.reload();
    setSavingCfg(false);
  };

  /* ─── Period navigation ─── */
  const navigatePeriod = (direction) => {
    if (!period) return;
    // FRAME-AWARE, via the shared definition the Timer tab uses.
    //
    // This stepped by a raw day count: len = (end - start) + 1, then shift
    // both ends by that. On a calendar-month venue standing on 1.-31. marts
    // that walks backwards 31 days to 28. jan - 27. feb — four days of
    // January pulled into "February" and 28. februar dropped — while the
    // Timer tab's "Previous", one tab away on the same screen, correctly
    // snapped to 1.-28. feb.
    //
    // This window is what /staff/payroll/estimate, the revisor CSV and the
    // LØNSEDDEL PDF are all built from, and the PDF filename prints the dates
    // as though somebody chose them. The frame selector directly below still
    // said "Calendar month (1st -> end)". Nothing on screen contradicted it.
    const stepped = stepPayPeriod(
      periodCfg.period_type,
      periodCfg.custom_start_day,
      period.period_start,
      period.period_end,
      direction === "next" ? "next" : "prev",
    );
    setPeriodOverride({ period_start: stepped.from, period_end: stepped.to });
  };

  /* ─── Selection helpers ─── */
  const toggleStaff = (id) => {
    setDeselected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === staffList.length) {
      setDeselected(new Set(staffList.map(s => s.id)));
    } else {
      setDeselected(new Set());
    }
  };

  /* ─── Pay per person, for the period (merge staff list + hours) ─── */
  // One map for BOTH the staff picker and the preview. The picker added up
  // keys the summary never sends (base_earned, tips), so its "earned" line was
  // each person's tips alone while the table under it showed their wages.
  const payById = useMemo(() => {
    const map = {};
    hoursSummary.forEach(h => {
      // Backend `/staff/hours/summary` returns: total_hours, total_earned,
      // overtime_hours, tips_received. We accept legacy field names too
      // (base_earned / overtime_pay / tips) so a stale schema mid-deploy
      // won't render zeros — multi-layer fallback.
      const baseEarned = h.total_earned ?? h.base_earned ?? 0;
      const overtimePay = h.overtime_pay ?? 0; // not yet computed by backend
      const tips = h.tips_received ?? h.tips ?? 0;
      map[h.staff_id] = {
        hours: h.total_hours || 0,
        base_earned: baseEarned,
        overtime: overtimePay,
        overtime_hours: h.overtime_hours || 0,
        tips,
        total: baseEarned + overtimePay + tips,
      };
    });
    return map;
  }, [hoursSummary]);

  const payrollRows = useMemo(() => {
    return staffList
      .filter(s => selectedIds.has(s.id))
      .map(s => ({
        id: s.id,
        name: s.name || s.staff_name || "—",
        // Display-only; the fallback words are resolved at render (t()).
        role: s.role || null,
        contract_type: s.contract_type || null,
        ...(payById[s.id] || NO_PAY),
      }));
  }, [staffList, payById, selectedIds]);

  /* ─── Grand totals ─── */
  const totals = useMemo(() => {
    return payrollRows.reduce(
      (acc, r) => ({
        hours: acc.hours + r.hours,
        base_earned: acc.base_earned + r.base_earned,
        overtime: acc.overtime + r.overtime,
        tips: acc.tips + r.tips,
        total: acc.total + r.total,
      }),
      { hours: 0, base_earned: 0, overtime: 0, tips: 0, total: 0 }
    );
  }, [payrollRows]);

  /* ─── Are the hours in this report approved? ─── */
  // Timer's own counts (ApprovalBar in StaffHoursPage, from the same summary
  // this tab already reads): entries the owner has ticked out of entries
  // logged, and shifts still waiting for an answer — over the people the
  // report covers. Null when the server sends no counts, or there is nothing
  // to count: say nothing rather than guess.
  const approval = useMemo(() => {
    const picked = new Set([...selectedIds].map(String));
    const rows = hoursSummary.filter((h) => picked.has(String(h.staff_id)));
    if (!rows.some((r) => r.entries_count != null)) return null;
    const total = rows.reduce((n, r) => n + (r.entries_count || 0), 0);
    const approved = rows.reduce((n, r) => n + Math.min(r.approved_count || 0, r.entries_count || 0), 0);
    const needsAnswer = rows.reduce((n, r) => n + (r.needs_answer_count || 0), 0);
    if (total === 0 && needsAnswer === 0) return null;
    return { total, approved, needsAnswer, done: approved >= total && needsAnswer === 0 };
  }, [hoursSummary, selectedIds]);
  // "38 af 41 registreringer godkendt · 3 vagter mangler svar"
  const approvalText = (a) => {
    if (!a) return "";
    if (a.done) {
      return a.total === 1
        ? t("payApprovedAllOne", "The one entry is approved")
        : t("payApprovedAll", "All {n} entries approved", { n: a.total });
    }
    const parts = [];
    if (a.total > 0) parts.push(t("payApprovedSome", "{a} of {n} entries approved", { a: a.approved, n: a.total }));
    if (a.needsAnswer > 0) {
      parts.push(a.needsAnswer === 1
        ? t("payNeedsAnswerOne", "1 shift needs an answer")
        : t("payNeedsAnswer", "{n} shifts need an answer", { n: a.needsAnswer }));
    }
    return parts.join(" · ");
  };
  const timerHref = hubHref("hours", period, { view: "details" });

  /* ─── PDF export ─── */
  const generatePdf = async () => {
    if (exportBlocked || selectedIds.size === 0) return;
    setPdfLoading(true);
    setError("");
    try {
      const res = await api.post(
        "/staff/payroll/pdf",
        {
          period_start: period.period_start,
          period_end: period.period_end,
          staff_ids: Array.from(selectedIds),
        },
        { responseType: "blob" }
      );
      const out = await saveFile(res.data, `payroll_${period.period_start}_${period.period_end}.pdf`, {
        type: "application/pdf",
      });
      if (!out.ok) setError(t("payrollPdfFailed", "Could not generate PDF. Please try again."));
    } catch (err) {
      // Surface the actual server detail when available — `responseType: "blob"`
      // means axios delivers the error body as a Blob, so we read it as text first.
      let detail = t("payrollPdfFailed", "Could not generate PDF. Please try again.");
      try {
        const data = err?.response?.data;
        if (data instanceof Blob) {
          const txt = await data.text();
          try {
            const parsed = JSON.parse(txt);
            if (parsed?.detail) detail = parsed.detail;
          } catch {
            if (txt) detail = txt.slice(0, 200);
          }
        } else if (data?.detail) {
          detail = data.detail;
        }
      } catch { /* fall through to generic */ }
      // A non-blob 422 makes data.detail an ARRAY ([{type,loc,msg,input}]);
      // rendering that as a child would crash. Keep the parsed string as-is,
      // else fall back to the generic message.
      // The open-punch refusal is structured — name the shifts in the
      // owner's language instead of "Could not generate PDF".
      if (detail && typeof detail === "object" && detail.code === "open_punches") {
        setError(openPunchText(detail), "timer");
      } else {
        setError(typeof detail === "string" ? detail : t("payrollPdfFailed", "Could not generate PDF. Please try again."));
      }
    }
    setPdfLoading(false);
  };

  /* ─── Email payroll PDF directly to accountant ───
   *
   * Mirrors the daily-close-to-accountant pattern: one button → server
   * renders the PDF and ships it via Resend with the owner set as
   * reply-to. With no revisor address on Profile the button is disabled
   * and says where to set it (see the export card below).
   */
  const [sending, setSending] = useState(false);
  const [sendToast, setSendToast] = useState("");
  const confirm = useConfirm();
  // UpgradeNudge state — shown as a dialog when a Free user tries
  // to send payroll to the accountant (Starter+ gated feature).
  const [upgradeNudge, setUpgradeNudge] = useState(null);
  // Who it goes to, as one string: "Anna Hansen · anna@revisor.dk".
  const recipientLabel = revisorName ? `${revisorName} · ${revisorEmail}` : revisorEmail;
  // Not while the hours are still loading either: the confirm states their
  // approval, and a confirm built before they arrive would silently omit it.
  const canSend =
    !exportBlocked && !sending && !pdfLoading && selectedIds.size > 0 && profileKnown && !!revisorEmail
    && !hoursQ.loading;
  // The CSV and the lønseddel are DK documents and owner-only (the server
  // denies both to any staff seat). Shown while the estimate loads — disabled,
  // so the list does not jump — and on a failed estimate, disabled with the
  // reason; hidden only once the estimate says there is nobody to pay.
  const showDkFiles = isDanish && !isStaffSeat
    && !(dkEstimate && !dkQ.failed && !dkLoading && dkEstimate.staff_count === 0);

  const sendToAccountant = async () => {
    if (!canSend) return;
    // A pay report leaves the building on this tap. The confirm used to read
    // "8 medarbejdere, 1. sep. 26 – 30. sep. 26. Du får en kopi." — not WHO
    // gets it (a hover tooltip said "angiv adressen under Profil"), not WHAT
    // is attached, nothing about approval, and Enter on the focused Send
    // mailed it. Now: recipient, attachment, the approval state of the hours
    // in it, a way to Timer, and Annuller holds the focus. Unapproved hours
    // can still go — the owner decides — but never without being told.
    const staffCount = selectedIds.size === 1
      ? t("paySendStaffOne", "1 employee")
      : t("paySendStaff", "{n} employees", { n: selectedIds.size });
    const toFix = !!approval && !approval.done;
    const answer = await confirm({
      title: t("payrollSendConfirmTitle", "Send the payroll report to your revisor?"),
      message: (
        <>
          <span className="block text-gray-900 dark:text-gray-100">
            {t("paySendTo", "To:")} <span className="font-semibold break-all">{recipientLabel}</span>
          </span>
          <span className="block">
            {t("paySendAttached", "Attached: payroll report (PDF), {period} · {staff}", {
              period: periodLabel(period.period_start, period.period_end, { always: true }),
              staff: staffCount,
            })}
          </span>
          <span className="block">{t("paySendCopy", "You get a copy.")}</span>
          {approval && (
            <span className={`block mt-3 font-medium ${toFix ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-400"}`}>
              {approvalText(approval)}
            </span>
          )}
          {toFix && (
            <span className="block">
              {t("paySendAsIs", "Send now and your revisor gets the hours as they stand.")}
            </span>
          )}
        </>
      ),
      confirmLabel: t("payrollSendConfirmCta", "Send"),
      // Annuller has the focus and Enter does not send — without painting a
      // monthly routine red (hooks/useConfirm).
      irreversible: true,
      extraLabel: toFix ? t("payGoToTimer", "Go to Hours") : undefined,
    });
    if (answer === "extra") {
      navigate(timerHref);
      return;
    }
    if (answer !== true) return;
    setSending(true);
    setError("");
    setSendToast("");
    try {
      const r = await api.post("/staff/payroll/send-to-accountant", {
        period_start: period.period_start,
        period_end: period.period_end,
        staff_ids: Array.from(selectedIds),
        cc_self: true,
      });
      if (r.data?.ok) {
        setSendToast(
          (t("payrollSentToPlain", "Sent to") + " " + r.data.sent_to) +
          (r.data.cc_self ? ` (${t("ccdYou", "you cc'd")})` : "")
        );
        setTimeout(() => setSendToast(""), 7000);
      }
    } catch (err) {
      const detail = err?.response?.data?.detail;
      // 402 plan_required — surface as the tasteful UpgradeNudge dialog
      // instead of a red error message. Free user can still download
      // the PDF and attach it manually via the "Generate PDF" button.
      if (err?.response?.status === 402 &&
          detail?.code === "plan_required" &&
          detail?.feature === "direct_accountant_email") {
        setUpgradeNudge({
          tier: detail.required_plan || "starter",
          benefit: t("nudgePayrollSend", "Email payroll to your bogholder in one tap"),
          iconName: "Send",
        });
      } else if (detail?.code === "open_punches") {
        // The server's `message` is English; this is the sentence the PDF
        // and the lønseddel already show, in the owner's language.
        setError(openPunchText(detail), "timer");
      } else if (detail?.code === "no_accountant_email") {
        // Taken off Profile since this page read it — say so, and read again.
        setError(t("paySendNoEmail", "Add your revisor's email under Profile to send from here."), "profile");
        profileQ.reload();
      } else {
        // Never the raw server sentence: on this endpoint it is English
        // ("Couldn't send right now…", "Could not render payroll PDF: …").
        setError(t("paySendFailed", "The payroll report wasn't sent. Try again, or download the PDF and email it yourself."));
      }
    } finally {
      setSending(false);
    }
  };

  /* ─── The two DK payroll files: the CSV and the lønseddel ─── */
  // A blob request returns its JSON error as a Blob — read it, so an open
  // punch is named instead of "could not generate".
  const blobDetail = async (e) => {
    try { return JSON.parse(await e?.response?.data?.text?.())?.detail ?? null; } catch { return null; }
  };
  // A busy flag each, so a second tap while the file is being built is not a
  // second download.
  const [csvLoading, setCsvLoading] = useState(false);
  const [loenLoading, setLoenLoading] = useState(false);
  const downloadCsv = async () => {
    if (exportBlocked || csvLoading) return;
    setCsvLoading(true);
    setError("");
    try {
      const res = await api.get("/staff/payroll/csv", {
        params: { period_start: period.period_start, period_end: period.period_end },
        responseType: "blob",
      });
      const out = await saveFile(res.data, `bonbox_payroll_${period.period_start}_${period.period_end}.csv`, { type: "text/csv;charset=utf-8;" });
      if (!out.ok) setError(t("payrollCsvFailed", "Could not generate CSV."));
    } catch (e) {
      // Name the open shift, like the lønseddel does — the CSV said only
      // "Kunne ikke generere CSV."
      const detail = await blobDetail(e);
      if (e?.response?.status === 409 && detail?.code === "open_punches") setError(openPunchText(detail), "timer");
      else setError(t("payrollCsvFailed", "Could not generate CSV."));
    } finally {
      setCsvLoading(false);
    }
  };
  const downloadLoenseddel = async () => {
    if (exportBlocked || loenLoading) return;
    setLoenLoading(true);
    setError("");
    try {
      const res = await api.get("/staff/payroll/loenseddel", {
        params: { period_start: period.period_start, period_end: period.period_end },
        responseType: "blob",
      });
      const out = await saveFile(res.data, `bonbox_loenseddel_${period.period_start}_${period.period_end}.pdf`, { type: "application/pdf" });
      if (!out.ok) setError(t("payrollLoenseddelFailed", "Could not generate Lønseddel."));
    } catch (e) {
      const detail = await blobDetail(e);
      if (e?.response?.status === 409 && detail?.code === "open_punches") setError(openPunchText(detail), "timer");
      else setError(e?.response?.status === 404
        ? t("payrollNoHoursLogged", "No staff hours logged in this period.")
        : t("payrollLoenseddelFailed", "Could not generate Lønseddel."));
    } finally {
      setLoenLoading(false);
    }
  };

  /* ─── Log sick call ─── */
  const logSickCall = async (e) => {
    e.preventDefault();
    if (!sickForm.staff_name) return;
    try {
      await api.post("/weather/sick-calls", {
        staff_name: sickForm.staff_name,
        date: sickForm.date,
        weather_condition: sickForm.reason === "weather" ? "weather" : sickForm.reason || null,
        notes: sickForm.notes || null,
      });
      setSickForm({ staff_name: "", date: localIso(), reason: "", notes: "" });
      setSickSuccess(t("sickCallLogged", "Sick call logged"));
      setTimeout(() => setSickSuccess(""), 2500);
    } catch {
      setError(t("couldNotLogSickCall", "Could not log sick call"));
      return;
    }
    // Outside the try: the call IS logged. A failed refresh after it used to
    // land in the catch above and tell the owner it was not.
    sickQ.reload();
  };

  /* ─── LOADING STATE ─── */
  if (!period && currentQ.loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="mb-3 animate-pulse text-gray-400">
            <Icon name="FileText" size={36} className="mx-auto" />
          </div>
          <p className="text-gray-500 dark:text-gray-400">{t("loadingPayroll", "Loading payroll...")}</p>
        </div>
      </div>
    );
  }

  /* ─── NO PERIOD ─── */
  // Everything on this tab is a sum over the pay period, so without one there
  // is nothing to show — and nothing to export. It used to invent a fortnight
  // ending today and carry on as if the owner had picked it.
  if (!period) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl 2xl:max-w-[1400px] mx-auto space-y-6">
        <PageHeader
          eyebrow={t("shpEyebrow", "STAFF")}
          title={t("payroll", "Payroll")}
          subtitle={t("payrollSubtitle", "Generate payroll reports for your revisor")}
        />
        <LoadFailed
          title={t("payrollPeriodLoadFailed", "Couldn't load your pay period.")}
          onRetry={currentQ.reload}
        />
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */
  return (
    <div className="p-4 sm:p-6 max-w-6xl 2xl:max-w-[1400px] mx-auto space-y-6">
      <PageHeader
        eyebrow={t("shpEyebrow", "STAFF")}
        title={t("payroll", "Payroll")}
        subtitle={t("payrollSubtitle", "Generate payroll reports for your revisor")}
      />

      {/* v2: the copy changed, so an owner who closed the old one sees it.
          "BonBox kører i lønhjælp-tilstand … opsummerings-CSV (DKK,
          semikolon-separeret til Excel)" — two coined terms and a file
          format, in the first thing the tab says. */}
      <DismissibleTip
        id="payroll-intro-v2"
        iconName="Briefcase"
        title={t("payrollTipTitle", "DK payroll, the easy way")}
      >
        <p className="mb-1.5">
          {t(
            "payIntroBody",
            "From the hours you log, BonBox estimates AM-bidrag (8%), A-skat (about 36% after personfradrag), ATP and feriepenge. Send the payroll report to your revisor in one tap — each employee's lønseddel and a spreadsheet for your payroll system are under Export.",
          )}
        </p>
        <p className="text-xs opacity-75">
          {t(
            "stfPayrollTipScope",
            "Built for hourly (timelønnet) staff — salaried funktionærer run through your payroll system. We don’t store CPR, run eIndkomst, or file with SKAT — your payroll system and revisor sign off on the final numbers.",
          )}
        </p>
      </DismissibleTip>

      {/* ─── PERIOD SELECTOR ─── */}
      <FadeIn delay={0.05}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigatePeriod("prev")}
              iconLeft={<Icon name="ChevronLeft" size={14} />}
            >
              {t("payrollPrevPeriod", "Previous")}
            </Button>
            <div className="text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">{t("payPeriod")}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {period ? periodLabel(period.period_start, period.period_end) : "—"}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigatePeriod("next")}
              iconRight={<Icon name="ChevronRight" size={14} />}
            >
              {t("next", "Next")}
            </Button>
          </div>
          {/* DK lønperiode is often mid-month (16.→15., 25.→24.) rather than the
              calendar month — let the owner set it. Staff Hours + payroll totals
              follow automatically (the backend computes from this config). */}
          {/* This is the SAVED lønperiode (POST /staff/pay-period), the same
              shared config Timer's frame picker writes — not a viewing frame.
              Previous/Next above is how the owner looks at another window. */}
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-center gap-2 text-xs">
            <span className="text-gray-500 dark:text-gray-400">{t("payPeriodLabel", "Pay period")}:</span>
            <select
              value={periodCfg.period_type}
              onChange={(e) => savePeriodCfg(e.target.value, periodCfg.custom_start_day)}
              disabled={savingCfg}
              className={`${PHONE_FIELD} px-2.5 py-1.5 sm:px-2 sm:py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-[13px] sm:text-xs focus:ring-2 focus:ring-gray-400 outline-none disabled:opacity-50`}
              aria-label={t("payPeriodLabel", "Pay period")}
            >
              {!PAY_PERIOD_TYPES.includes(periodCfg.period_type) && SAVED_ELSEWHERE_FRAME_KEYS[periodCfg.period_type] && (
                <option value={periodCfg.period_type}>
                  {t(...SAVED_ELSEWHERE_FRAME_KEYS[periodCfg.period_type])}
                </option>
              )}
              <option value="monthly_1st">{t("payPeriodMonth1", "Calendar month (1st → end)")}</option>
              <option value="monthly_15th">{t("payPeriodMonth15", "15th → 14th")}</option>
              <option value="custom">{t("payPeriodCustomOpt", "Custom start day…")}</option>
            </select>
            {periodCfg.period_type === "custom" && (
              <span className="inline-flex items-center gap-1">
                <span className="text-gray-500 dark:text-gray-400">{t("payPeriodStarts", "starts on the")}</span>
                <input
                  type="number"
                  min="1"
                  max="28"
                  value={periodCfg.custom_start_day}
                  onChange={(e) => setCfgDraft({ ...periodCfg, custom_start_day: e.target.value })}
                  onBlur={(e) => savePeriodCfg("custom", e.target.value)}
                  disabled={savingCfg}
                  className={`${PHONE_FIELD} w-16 sm:w-14 px-2 py-1.5 sm:py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-[13px] sm:text-xs tabular-nums focus:ring-2 focus:ring-gray-400 outline-none disabled:opacity-50`}
                  aria-label={t("payPeriodStartDay", "Start day of month")}
                />
              </span>
            )}
          </div>
          {cfgError && (
            <p role="alert" className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{cfgError}</p>
          )}
          {/* The window could not be (re)loaded — after a frame change, say.
              The dates above may belong to the old frame, so say so. */}
          {currentQ.failed && (
            <div className="mt-3">
              <LoadFailed
                title={t("payrollPeriodLoadFailed", "Couldn't load your pay period.")}
                onRetry={currentQ.reload}
              />
            </div>
          )}
        </div>
      </FadeIn>

      {/* ─── STAFF SELECTOR ─── */}
      <FadeIn delay={0.1}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <button
              type="button"
              onClick={() => setStaffOpen((o) => !o)}
              className="flex items-center gap-2 text-left"
              aria-expanded={staffOpen}
            >
              <span className={`text-gray-400 transition-transform ${staffOpen ? "rotate-90" : ""}`}>›</span>
              <h2 className="font-bold text-gray-900 dark:text-gray-100">{t("staffSelection")}</h2>
              {!staffQ.failed && !staffQ.loading && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 tabular-nums">
                  {selectedIds.size}/{staffList.length}
                </span>
              )}
            </button>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={staffList.length > 0 && selectedIds.size === staffList.length}
                onChange={toggleAll}
                disabled={staffQ.failed || staffList.length === 0}
                className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-gray-400"
              />
              <span className="text-sm text-gray-600 dark:text-gray-400">{t("selectAll")}</span>
            </label>
          </div>

          {/* A failed roster is not "no staff members found" — and it is shown
              whether or not the list is open, because the exports below are
              waiting on it. */}
          {staffQ.failed ? (
            <LoadFailed
              title={t("stfStaffLoadFailed", "Couldn't load your staff.")}
              onRetry={staffQ.reload}
            />
          ) : staffOpen && (staffQ.loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <Icon name="Users" size={24} className="mx-auto mb-2 text-gray-400 animate-pulse" />
                <p className="text-sm text-gray-400">{t("payrollLoadingStaff", "Loading staff...")}</p>
              </div>
            </div>
          ) : staffList.length === 0 ? (
            <div className="text-center py-8">
              <Icon name="Users" size={28} className="mx-auto mb-2 text-gray-400 dark:text-gray-500" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("payrollNoStaffFound", "No staff members found. Add staff from the Staffing page to get started.")}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {staffList.map(s => {
                // "—" while the hours are not known: a failed or pending read
                // is not "0 t · 0,00 kr." for this person.
                const pay = hoursQ.failed || hoursQ.loading ? null : (payById[s.id] || NO_PAY);

                return (
                  <label
                    key={s.id}
                    className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition border ${
                      selectedIds.has(s.id)
                        ? "bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-800"
                        : "bg-gray-50 dark:bg-gray-700/50 border-gray-100 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleStaff(s.id)}
                      className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-gray-400"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800 dark:text-white truncate">
                          {s.name || s.staff_name || "—"}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                          {s.role ? roleName(s.role, t) : t("teamRoleStaff", "Staff")}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                          {contractLabel(s.contract_type, t) || t("stfContractHourly", "Hourly")}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 tabular-nums">
                        {pay ? formatHours(pay.hours, { lang, decimals: 2 }) : "—"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                        {pay ? fmtMoney(pay.total, currency) : "—"}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          ))}
          {!staffOpen && !staffQ.failed && staffList.length > 0 && (
            <button
              type="button"
              onClick={() => setStaffOpen(true)}
              className="w-full text-left text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              {t("payrollStaffSelectedTap", "{selected} of {total} staff selected — tap to change")
                .replace("{selected}", selectedIds.size)
                .replace("{total}", staffList.length)}
            </button>
          )}
        </div>
      </FadeIn>

      {/* ─── PAYROLL PREVIEW TABLE ─── */}
      <FadeIn delay={0.15}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setPreviewOpen((o) => !o)}
            className="flex items-center gap-2 text-left mb-4 w-full"
            aria-expanded={previewOpen}
          >
            <span className={`text-gray-400 transition-transform ${previewOpen ? "rotate-90" : ""}`}>›</span>
            <h2 className="font-bold text-gray-900 dark:text-gray-100">{t("payrollPreview")}</h2>
            {payrollRows.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 tabular-nums">
                {payrollRows.length}
              </span>
            )}
          </button>

          {/* The hours read failed (or the roster did): say so, instead of
              the "5 medarbejdere · 0 t · 0,00 kr. i alt" it used to print. */}
          {staffQ.failed || hoursQ.failed ? (
            <LoadFailed
              title={staffQ.failed
                ? t("stfStaffLoadFailed", "Couldn't load your staff.")
                : t("payrollHoursLoadFailed", "Couldn't load the hours for this pay period.")}
              onRetry={staffQ.failed ? staffQ.reload : hoursQ.reload}
            />
          ) : staffQ.loading || hoursQ.loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("loading", "Loading…")}</p>
          ) : payrollRows.length === 0 ? (
            <div className="text-center py-8">
              <Icon name="BarChart3" size={28} className="mx-auto mb-2 text-gray-400 dark:text-gray-500" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("payrollSelectToPreview", "Select staff members above to preview payroll")}
              </p>
            </div>
          ) : previewOpen ? (
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-sm">
                <thead>
                  {/* One neutral header row. Overtime and tips had amber and
                      emerald headers — colour that says "attention" and "done"
                      about two ordinary columns of pay. */}
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("navStaff")}</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("hoursLabel")}</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("baseEarned")}</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("overtime")}</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("tips", "Tips")}</th>
                    <th className="text-right py-3 px-2 text-gray-500 dark:text-gray-400 font-medium">{t("total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {payrollRows.map(row => (
                    <tr key={row.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
                      <td className="py-3 px-2">
                        <p className="font-medium text-gray-800 dark:text-white">{row.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {row.role ? roleName(row.role, t) : t("teamRoleStaff", "Staff")}
                          {" · "}
                          {contractLabel(row.contract_type, t) || t("stfContractHourly", "Hourly")}
                        </p>
                      </td>
                      <td className="text-right py-3 px-2 text-gray-700 dark:text-gray-300 tabular-nums">
                        {formatHours(row.hours, { lang, decimals: 2 })}
                      </td>
                      <td className="text-right py-3 px-2 text-gray-700 dark:text-gray-300 tabular-nums">
                        {fmtMoney(row.base_earned, currency)}
                      </td>
                      <td className="text-right py-3 px-2 tabular-nums">
                        {row.overtime > 0 ? (
                          <span className="text-gray-900 dark:text-gray-100">
                            {fmtMoney(row.overtime, currency)}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="text-right py-3 px-2 tabular-nums">
                        {row.tips > 0 ? (
                          <span className="text-gray-900 dark:text-gray-100">
                            {fmtMoney(row.tips, currency)}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="text-right py-3 px-2 font-semibold text-gray-800 dark:text-white tabular-nums">
                        {fmtMoney(row.total, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50">
                    <td className="py-3 px-2 font-bold text-gray-800 dark:text-white">
                      {t("payrollGrandTotal", "Grand Total ({count} staff)").replace("{count}", payrollRows.length)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {formatHours(totals.hours, { lang, decimals: 2 })}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {fmtMoney(totals.base_earned, currency)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {fmtMoney(totals.overtime, currency)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {fmtMoney(totals.tips, currency)}
                    </td>
                    <td className="text-right py-3 px-2 font-bold text-gray-800 dark:text-white tabular-nums">
                      {fmtMoney(totals.total, currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="w-full text-left text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              {/* Says what its total IS. "46.657,67 kr. i alt" (wages plus
                  tips) sat above a "Samlet lønomkostning" of 50.046,70 kr.
                  (wages plus feriepenge and ATP) with nothing to tell the two
                  apart; the wages here are the bruttoløn of the line below. */}
              {t("payPreviewTap", "{count} staff · {hours} · {money} — tap to see per staff", {
                count: payrollRows.length,
                hours: formatHours(totals.hours, { lang, decimals: 2 }),
                money: totals.tips > 0
                  ? t("payPreviewWagesTips", "wages {wages} + tips {tips}", {
                    wages: fmtMoney(totals.base_earned + totals.overtime, currency),
                    tips: fmtMoney(totals.tips, currency),
                  })
                  : t("payPreviewWages", "wages {wages}", { wages: fmtMoney(totals.base_earned + totals.overtime, currency) }),
              })}
            </button>
          )}
        </div>
      </FadeIn>

      {/* ─── DANISH PAYROLL ESTIMATE — A-skat / AM-bidrag / ATP / Feriepenge ─── */}
      {isDanish && (
        <FadeIn delay={0.15}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
            <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
              <div>
                <h2 className="font-bold text-gray-900 dark:text-gray-100">{t("danishPayrollBreakdown")}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t("stfPayrollSkatNote", "Estimate for SKAT remittance and FerieKonto. Submit via your payroll system.")}
                </p>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                {t("payrollEstimateBadge", "Estimate")}
              </span>
            </div>

            {/* A failed estimate told the owner to "log staff hours first" —
                to a venue that had logged them. */}
            {dkQ.failed ? (
              <LoadFailed
                title={t("payrollEstimateLoadFailed", "Couldn't load the estimate for this pay period.")}
                onRetry={dkQ.reload}
              />
            ) : dkLoading || !dkEstimate ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">{t("payrollLoadingEstimate", "Loading estimate…")}</div>
            ) : dkEstimate.staff_count === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {t("payrollNoActiveStaff", "No active staff or hours logged in this period.")}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <DkStat label={t("stfPayrollGrossWages", "Gross wages")} value={dkEstimate.totals.gross} currency={currency} accent="gray" />
                  {/* "AM-bidrag" is a locked DK term — the same label in every language. */}
                  <DkStat label="AM-bidrag (8%)" value={dkEstimate.totals.am_bidrag} currency={currency} accent="blue" />
                  <DkStat label={t("stfPayrollASkatEst", "A-skat (est. 36%)")} value={dkEstimate.totals.a_skat} currency={currency} accent="blue" />
                  <DkStat label={t("stfPayrollNetToStaff", "Net to staff")} value={dkEstimate.totals.net_pay} currency={currency} accent="green" />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <DkStat label="ATP" value={dkEstimate.totals.atp} currency={currency} small />
                  <DkStat label={t("stfPayrollFeriepenge", "Feriepenge (12.5%)")} value={dkEstimate.totals.feriepenge} currency={currency} small />
                  <DkStat label={t("stfPayrollEmployerCost", "Employer total cost")} value={dkEstimate.totals.employer_total_cost} currency={currency} small accent="dark" />
                </div>
                {/* ONE cost, and how it is made. Timer's cost tile shows this
                    same figure (same /payroll/estimate); the per-person rows
                    there and the preview here are bruttoløn alone — this line
                    is why they are lower. */}
                <p className="mt-2 mb-4 text-xs text-gray-600 dark:text-gray-400 tabular-nums" data-testid="pay-cost-breakdown">
                  {t("payCostBreakdown", "Gross wages {gross} + feriepenge {ferie} + ATP {atp} = {total}", {
                    gross: fmtMoney(dkEstimate.totals.gross, currency),
                    ferie: fmtMoney(dkEstimate.totals.feriepenge, currency),
                    atp: fmtMoney(dkEstimate.totals.atp, currency),
                    total: fmtMoney(dkEstimate.totals.employer_total_cost, currency),
                  })}
                </p>

                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 px-3 py-2.5 text-xs text-gray-800 dark:text-gray-200">
                  <div className="font-semibold mb-0.5">{t("skatRemittance")}</div>
                  <div>{fmtMoney(dkEstimate.skat_remit.total, currency)} = AM-bidrag {fmtMoney(dkEstimate.skat_remit.am_bidrag, currency)} + A-skat {fmtMoney(dkEstimate.skat_remit.a_skat, currency)}</div>
                </div>

                {/* The API's estimate_note is one fixed English paragraph
                    (payroll_service.py). It is rendered from the catalogue so a
                    Danish owner reads it in Danish — if the backend's wording
                    changes, change stfPayrollEstimateNote with it. */}
                {dkEstimate.estimate_note && (
                  <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                    {t(
                      "stfPayrollEstimateNote",
                      "A-skat varies per employee — typical hovedkort is ~36% after personfradrag, bikort is ~42% (no personfradrag), frikort is 0% until the annual limit. BonBox uses each staff member's trækkort type when set, otherwise defaults to hovedkort. The official A-skat comes from each employee's eSkattekort and your payroll system's eIndkomst submission — use this estimate for planning the 10th-of-month deadline only.",
                    )}
                  </p>
                )}
              </>
            )}

            {!dkQ.failed && !dkLoading && dkEstimate?.staff_count > 0 && (
              <>
                {dkEstimate.per_staff?.length > 0 && (
                  <details className="mt-3">
                    {/* py-3 on a phone: a 16px-tall disclosure is not a target
                        a thumb can hit. */}
                    <summary className="cursor-pointer py-3 sm:py-1 text-xs font-medium text-gray-700 dark:text-gray-300 select-none">
                      {t("payrollPerEmployeeBreakdown", "Per-employee breakdown ({count})").replace("{count}", dkEstimate.per_staff.length)}
                    </summary>
                    <div className="overflow-x-auto mt-2">
                      <table className="w-full text-xs text-gray-700 dark:text-gray-300">
                        <thead className="text-[10px] uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                          <tr>
                            <th className="text-left py-1.5 px-2">{t("name", "Name")}</th>
                            <th className="text-right py-1.5 px-2">{t("hoursLabel")}</th>
                            <th className="text-right py-1.5 px-2">{t("gross")}</th>
                            {/* AM(-bidrag) and A-skat are locked DK terms — same in every language. */}
                            <th className="text-right py-1.5 px-2">AM</th>
                            <th className="text-right py-1.5 px-2">A-skat</th>
                            <th className="text-right py-1.5 px-2">{t("netLabel", "Net")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dkEstimate.per_staff.map((s) => (
                            <tr key={s.staff_id} className="border-b border-gray-100 dark:border-gray-800">
                              <td className="py-1.5 px-2">{s.name}</td>
                              <td className="py-1.5 px-2 text-right">{formatHours(s.hours, { lang, decimals: 2 })}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(s.gross, currency)}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(s.am_bidrag, currency)}</td>
                              <td className="py-1.5 px-2 text-right">{fmtMoney(s.a_skat, currency)}</td>
                              <td className="py-1.5 px-2 text-right font-semibold">{fmtMoney(s.net_pay, currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        </FadeIn>
      )}

      {/* ─── EXPORT — the revisor's path first, then every other file and who it is for ─── */}
      {/* Four exports sat side by side — "Generér PDF", "Download
          opsummerings-CSV (til DataLøn / Zenegy)" and "Lønseddel PDF (én pr.
          medarbejder)" here, "Hent register" one tab over — and nothing said
          which one the revisor needs. The revisor's path is now first and
          green; every other file says what it is FOR and who gets it. None
          was removed. */}
      <FadeIn delay={0.2}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <h2 className="font-bold text-gray-900 dark:text-gray-100">{t("exportLabel", "Export")}</h2>
          <p className="mt-1 text-[13px] text-gray-600 dark:text-gray-400">
            {t("paySendLead", "The payroll report (PDF) for {period} — the file your revisor needs.", {
              period: periodLabel(period.period_start, period.period_end),
            })}
          </p>

          <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-x-4 gap-y-2">
            <Button
              variant="primary"
              size="lg"
              className="w-full sm:w-auto shrink-0"
              onClick={sendToAccountant}
              disabled={!canSend}
              busy={sending}
              iconLeft={!sending && <Icon name="Send" size={16} />}
            >
              {sending ? t("payrollSending", "Sending…") : t("payrollSendToAccountant", "Send to accountant")}
            </Button>
            {/* WHO it goes to, on the page — or why it cannot go yet and where
                that is fixed. The only hint was a hover tooltip a phone never
                shows. Nothing is said about a profile that did not load. */}
            <p className="text-[13px] text-gray-600 dark:text-gray-400 min-w-0" data-testid="pay-send-recipient">
              {profileQ.failed ? (
                <>
                  {t("paySendProfileFailed", "Couldn't read your revisor's email.")}{" "}
                  <button
                    type="button"
                    onClick={profileQ.reload}
                    className="font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2"
                  >
                    {t("retry", "Try again")}
                  </button>
                </>
              ) : !profileKnown ? null : revisorEmail ? (
                <>
                  {t("paySendTo", "To:")}{" "}
                  <span className="font-medium text-gray-900 dark:text-gray-100 break-all">{recipientLabel}</span>
                  {" · "}
                  {t("paySendCopyShort", "you get a copy")}
                </>
              ) : (
                fillSlots(t("paySendNeedsEmail", "Add your revisor's email under {profile} to send from here."), {
                  profile: (
                    <Link
                      to={REVISOR_EMAIL_HREF}
                      className="font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2"
                    >
                      {t("paySendProfileLink", "Profile")}
                    </Link>
                  ),
                })
              )}
            </p>
          </div>

          {/* Are the hours in this report approved — Timer's own count, on
              the page before the tap as well as in the confirm. */}
          {approval && (
            <p
              className={`mt-3 text-[13px] flex flex-wrap items-center gap-x-2 gap-y-1 ${
                approval.done ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"
              }`}
              data-testid="pay-approval"
            >
              <Icon name={approval.done ? "CheckCircle2" : "AlertTriangle"} size={15} className="shrink-0" />
              <span className="tabular-nums">{approvalText(approval)}</span>
              {!approval.done && (
                <Link
                  to={timerHref}
                  className="inline-flex items-center gap-0.5 min-h-[40px] sm:min-h-0 font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2"
                >
                  {t("payGoToTimer", "Go to Hours")}
                  <Icon name="ChevronRight" size={14} />
                </Link>
              )}
            </p>
          )}

          {(exportBlocked || selectedIds.size === 0) && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {exportBlocked
                ? t("payrollExportBlocked", "Exports are paused until the figures above have loaded.")
                : t("payrollSelectToExport", "Select at least one staff member to export")}
            </p>
          )}
          {sendToast && (
            <div className="mt-3">
              <SectionBanner severity="success" title={sendToast} />
            </div>
          )}
          {error && (
            <div className="mt-3" ref={errorRef}>
              <SectionBanner severity="critical" title={error.text}>
                {/* The place that fixes it, one tap away. */}
                {error.action === "timer" && (
                  <Link to={timerHref} className="inline-flex items-center gap-0.5 min-h-[40px] sm:min-h-0 font-medium underline underline-offset-2">
                    {t("payGoToTimer", "Go to Hours")}
                    <Icon name="ChevronRight" size={14} />
                  </Link>
                )}
                {error.action === "profile" && (
                  <Link to={REVISOR_EMAIL_HREF} className="inline-flex items-center gap-0.5 min-h-[40px] sm:min-h-0 font-medium underline underline-offset-2">
                    {t("paySetEmail", "Set your revisor's email")}
                    <Icon name="ChevronRight" size={14} />
                  </Link>
                )}
              </SectionBanner>
            </div>
          )}

          {/* Every other file — what it is FOR, and who gets it. */}
          <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-700">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("payOtherFiles", "Other files")}
            </h3>
            <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
              <ExportRow
                title={t("payFileReport", "Payroll report (PDF)")}
                purpose={t("payFileReportFor", "The same report your revisor gets — for your own records, or to email it yourself.")}
              >
                <Button
                  variant="secondary"
                  size="md"
                  className="max-sm:h-10 max-sm:text-[13px]"
                  onClick={generatePdf}
                  disabled={exportBlocked || pdfLoading || sending || selectedIds.size === 0}
                  busy={pdfLoading}
                  iconLeft={!pdfLoading && <Icon name="Download" size={15} />}
                  aria-label={t("payFileReportGet", "Download payroll report (PDF)")}
                >
                  {t("payFileGet", "Download")}
                </Button>
              </ExportRow>
              {showDkFiles && (
                <ExportRow
                  title={t("payFileCsv", "Spreadsheet for your payroll system (CSV)")}
                  purpose={t("payFileCsvFor", "For whoever keys the pay into DataLøn or Zenegy. Opens in Excel.")}
                >
                  <Button
                    variant="secondary"
                    size="md"
                    className="max-sm:h-10 max-sm:text-[13px]"
                    onClick={downloadCsv}
                    disabled={exportBlocked || dkLoading || csvLoading}
                    busy={csvLoading}
                    iconLeft={!csvLoading && <Icon name="Download" size={15} />}
                    aria-label={t("payFileCsvGet", "Download spreadsheet for your payroll system (CSV)")}
                  >
                    {t("payFileGet", "Download")}
                  </Button>
                </ExportRow>
              )}
              {showDkFiles && (
                <ExportRow
                  title={t("payrollLoenseddelPdf", "Lønseddel PDF (one per employee)")}
                  purpose={t("payFileLoenseddelFor", "One lønseddel for each employee — to hand to your staff.")}
                >
                  <Button
                    variant="secondary"
                    size="md"
                    className="max-sm:h-10 max-sm:text-[13px]"
                    onClick={downloadLoenseddel}
                    disabled={exportBlocked || dkLoading || loenLoading}
                    busy={loenLoading}
                    iconLeft={!loenLoading && <Icon name="Download" size={15} />}
                    aria-label={t("payFileLoenseddelGet", "Download lønseddel PDF")}
                  >
                    {t("payFileGet", "Download")}
                  </Button>
                </ExportRow>
              )}
              {/* "Hent register" lives on Tidsregistrering. It is named here
                  so the one list of files says what each is for — this is
                  the one the revisor does NOT need. */}
              {isDanish && (
                <ExportRow
                  title={t("payFileRegister", "Working-time register")}
                  purpose={fillSlots(
                    t("payFileRegisterFor", "For Arbejdstilsynet if they inspect — not for your revisor. Download it under {timeReg}."),
                    {
                      timeReg: (
                        <Link
                          to={hubHref("time", period)}
                          className="font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2"
                        >
                          {t("staffTimeReg", "Time tracking")}
                        </Link>
                      ),
                    },
                  )}
                />
              )}
            </ul>
          </div>
        </div>
      </FadeIn>

      {/* ─── SICK CALL TRACKER ─── */}
      <FadeIn delay={0.25}>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
          <h2 className="font-bold text-gray-900 dark:text-gray-100 mb-4">
            {t("sickCallTracker", "Sick Calls")}
          </h2>

          {/* A failed read is not "No sick calls recorded yet". */}
          {sickQ.failed && (
            <LoadFailed
              className="mb-4"
              title={t("payrollSickLoadFailed", "Couldn't load sick calls.")}
              onRetry={sickQ.reload}
            />
          )}

          {/* Stats cards */}
          {sickLoading ? (
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-xl text-center animate-pulse">
                  <div className="h-8 w-10 bg-gray-200 dark:bg-gray-600 rounded mx-auto mb-1" />
                  <div className="h-3 w-16 bg-gray-200 dark:bg-gray-600 rounded mx-auto" />
                </div>
              ))}
            </div>
          ) : sickStats ? (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] p-3 text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">{sickStats.this_month ?? 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("thisMonth", "This Month")}</p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] p-3 text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">{sickStats.last_month ?? 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("lastMonth", "Last Month")}</p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] p-3 text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">{sickStats.weather_related ?? 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("weatherDays", "Weather Days")}</p>
              </div>
            </div>
          ) : null}

          {/* Quick log form */}
          <form onSubmit={logSickCall} className="flex flex-wrap gap-2 mb-4">
            <input
              placeholder={t("staffName", "Name")}
              value={sickForm.staff_name}
              onChange={e => setSickForm(f => ({ ...f, staff_name: e.target.value }))}
              className={`${PHONE_FIELD} flex-1 min-w-[120px] px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white placeholder-gray-400`}
            />
            <input
              type="date"
              value={sickForm.date}
              onChange={e => setSickForm(f => ({ ...f, date: e.target.value }))}
              className={`${PHONE_FIELD} px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white`}
            />
            <select
              value={sickForm.reason}
              onChange={e => setSickForm(f => ({ ...f, reason: e.target.value }))}
              className={`${PHONE_FIELD} px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white`}
            >
              <option value="">{t("reason", "Reason")}</option>
              {REASON_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey, opt.fallback)}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              type="submit"
              disabled={!sickForm.staff_name}
            >
              {t("log", "Log")}
            </Button>
          </form>
          {sickSuccess && (
            <p className="text-gray-700 dark:text-emerald-400 text-sm mb-3">{sickSuccess}</p>
          )}

          {/* Recent sick calls */}
          {sickLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3 py-2 animate-pulse">
                  <div className="h-4 w-24 bg-gray-200 dark:bg-gray-600 rounded" />
                  <div className="flex-1" />
                  <div className="h-3 w-16 bg-gray-200 dark:bg-gray-600 rounded" />
                </div>
              ))}
            </div>
          ) : sickCalls.length > 0 ? (
            <div className="space-y-2">
              {sickCalls.slice(0, 10).map((sc, i) => {
                const reasonObj = REASON_OPTIONS.find(r => r.value === sc.weather_condition) || REASON_OPTIONS.find(r => r.value === "other");
                // The stored code, shown in the owner's language. A code this
                // form does not offer (rain / snow / storm from the weather
                // flow) is shown as stored rather than folded into "Other".
                const reasonCode = sc.weather_condition || "other";
                const reasonHit = REASON_OPTIONS.find(r => r.value === reasonCode);
                const reasonText = reasonHit ? t(reasonHit.labelKey, reasonHit.fallback) : reasonCode;
                return (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <div className="flex items-center gap-2">
                      <Icon name={reasonObj?.icon || "FileText"} size={18} className="text-gray-400 dark:text-gray-500 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{sc.staff_name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {reasonText} · {sc.date ? dayLabel(sc.date, noonOf(sc.date).getFullYear() !== new Date().getFullYear()) : ""}
                        </p>
                      </div>
                    </div>
                    {sc.notes && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[120px]">{sc.notes}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : sickQ.failed ? null : (
            <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
              {t("noSickCalls", "No sick calls recorded yet")}
            </p>
          )}
        </div>
      </FadeIn>

      {/* Upgrade nudge — Free user trying gated payroll send. The
          modal explains the value sentence + founding rate price +
          a "See plans" link. Closing returns them to the page so
          they can still hit "Generate PDF" and email manually. */}
      {upgradeNudge && (
        <UpgradeNudge
          intent="dialog"
          tier={upgradeNudge.tier}
          benefit={upgradeNudge.benefit}
          iconName={upgradeNudge.iconName}
          ctaLabel={t("nudgeSeePlans", "See plans")}
          onTry={() => setUpgradeNudge(null)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   One file in the export list: what it is, what it is FOR, its button
   ═══════════════════════════════════════════════════════════ */
function ExportRow({ title, purpose, children = null }) {
  return (
    <li className="py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-gray-900 dark:text-gray-100">{title}</p>
        <p className="mt-0.5 text-xs leading-snug text-gray-500 dark:text-gray-400">{purpose}</p>
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </li>
  );
}

/* ═══════════════════════════════════════════════════════════
   DK payroll stat tile
   ═══════════════════════════════════════════════════════════ */
function DkStat({ label, value, currency, accent = "gray", small = false }) {
  const accentClass =
    accent === "blue" ? "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40"
    : accent === "green" ? "border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/50"
    : accent === "dark" ? "border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700/40"
    : "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40";
  return (
    <div className={`rounded-lg border ${accentClass} px-3 py-2.5`}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">{label}</div>
      {/* Øre, as everywhere else on this tab: "12.345,50 kr.". These tiles
          rounded to the krone, so the gross on the tile and the gross in the
          table under it disagreed by up to 50 øre — on the lønseddel figures. */}
      <div className={`mt-0.5 font-bold text-gray-900 dark:text-white tabular-nums ${small ? "text-base" : "text-lg"}`}>
        {value == null ? "—" : formatOwnerMoney(value, currency, { decimals: 2 })}
      </div>
    </div>
  );
}
