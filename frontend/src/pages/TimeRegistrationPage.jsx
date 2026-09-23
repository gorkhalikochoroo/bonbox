// Tidsregistrering — owner view of DK working-time compliance.
// Reads /staff/time-registration (compliance summary over HoursLogged) and
// lets the owner scan each employee's status, drill into a daily register,
// and download the inspection-ready CSV. Starter+ (gated server-side; we
// render an upgrade card on a 402).
import { useState, useEffect, useCallback } from "react";
import api from "../services/api";
import { saveFile } from "../utils/download";
import { errText } from "../utils/errText";
import { dateLocale } from "../utils/dateFormat";
import { useLanguage } from "../hooks/useLanguage";
// This page printed "6.8 t" — a Danish unit wearing an English decimal, on an
// English screen — because it typed the unit itself instead of asking
// utils/hours.js. That is the exact hybrid hours.js was opened to end.
// formatHoursMinutes, not formatHours, because this is a working-time
// register: it answers "how long was this person here", and nobody, least of
// all an inspector, thinks in 6,8 t.
import { formatHours, formatHoursMinutes } from "../utils/hours";
import { PageHeader, Button, StatCard, Card, Empty, Icon, LoadFailed } from "../components/ui";
import UpgradeNudge from "../components/ui/UpgradeNudge";
import { isNativeApp } from "../utils/platform";
import { Clock } from "lucide-react";

/** Local-date ISO. toISOString() alone is UTC, so a Copenhagen owner opening
    the page late in the evening got yesterday's boundary. */
const iso = (x) => {
  const o = x.getTimezoneOffset() * 60000;
  return new Date(x.getTime() - o).toISOString().slice(0, 10);
};

export const TREG_MODES = ["month", "quarter", "year", "custom"];

/**
 * The window the register covers.
 *
 * A month was the only option, which is the wrong default for half the
 * reasons an owner opens this page: Arbejdstidsloven's weekly cap is averaged
 * over four months, an accountant asks for a quarter, and an Arbejdstilsynet
 * request names its own dates. Quarter and custom are not conveniences here,
 * they are the shapes the questions actually come in.
 */
export function periodBounds(mode, cursor, customFrom, customTo) {
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  if (mode === "quarter") {
    const q0 = Math.floor(m / 3) * 3;
    return { from: iso(new Date(y, q0, 1)), to: iso(new Date(y, q0 + 3, 0)) };
  }
  if (mode === "year") {
    return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 12, 0)) };
  }
  if (mode === "custom") {
    // Incomplete custom dates fall back to the month rather than querying a
    // half-open range — an empty register reads as "nobody worked", which is
    // the one thing this page must never imply by accident.
    if (!customFrom || !customTo) return periodBounds("month", cursor);
    return customFrom <= customTo
      ? { from: customFrom, to: customTo }
      : { from: customTo, to: customFrom };
  }
  return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
}

/** Step one whole period, not one month, or "next" on a quarter lands inside
    the same quarter and nothing appears to change. */
export function stepCursor(mode, cursor, dir) {
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  if (mode === "quarter") return new Date(y, m + dir * 3, 1);
  if (mode === "year") return new Date(y + dir, 0, 1);
  return new Date(y, m + dir, 1);
}

// `rail` is a 2px left edge, and only the two states that need the owner to DO
// something carry one. Compliant rows get none — a tick on every line is
// wallpaper, and once everything is coloured nothing is. On a venue where one
// person in sixteen has a rest issue, that single amber edge is the whole
// point of the screen.
const STATUS = {
  ok:   { dot: "bg-green-500", text: "text-green-700 dark:text-green-400", key: "tregOk",     fb: "Compliant",           rail: "" },
  warn: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400", key: "tregWarn",   fb: "Rest issue",          rail: "border-l-2 border-amber-400 dark:border-amber-500" },
  over: { dot: "bg-red-500",   text: "text-red-700 dark:text-red-400",     key: "tregOver",   fb: "Over weekly cap",     rail: "border-l-2 border-red-500 dark:border-red-500" },
  gap:  { dot: "bg-gray-300",  text: "text-gray-500",                       key: "tregGap",    fb: "No time registered",  rail: "" },
};

function fmtDay(iso) {
  if (!iso) return "";
  // Was hardcoded "da-DK", so an English or Turkish session read Danish
  // weekday names beside English labels. The register is a DK artifact; the
  // SCREEN is whatever language the owner chose.
  return new Date(iso + "T00:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
}

export default function TimeRegistrationPage() {
  const { t, lang } = useLanguage();
  const [cursor, setCursor] = useState(() => new Date());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // The third outcome. `loading` and `data` alone could not tell "the request
  // failed" from "the answer is nothing", and this page renders a compliance
  // verdict — the one thing that must never be guessed.
  const [failed, setFailed] = useState(false);
  const [locked, setLocked] = useState(false);
  const [expanded, setExpanded] = useState(null);   // staff_id whose register is open
  const [detail, setDetail] = useState({});          // staff_id -> register rows
  const [downloading, setDownloading] = useState(false);
  // Payroll-adjacent export: a failure has to be visible, not an
  // unhandled rejection that looks exactly like success.
  const [downloadError, setDownloadError] = useState("");
  const [mode, setMode] = useState("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [prefLoaded, setPrefLoaded] = useState(false);
  const [savingPref, setSavingPref] = useState(false);
  const [prefSaved, setPrefSaved] = useState(false);

  // The owner's saved default. Loaded once; a failure just leaves the month
  // default in place — a view preference must never block the register.
  useEffect(() => {
    let alive = true;
    api.get("/staff/time-registration/preference")
      .then((res) => {
        if (!alive) return;
        const p = res.data || {};
        if (TREG_MODES.includes(p.mode)) setMode(p.mode);
        if (p.custom_from) setCustomFrom(p.custom_from);
        if (p.custom_to) setCustomTo(p.custom_to);
      })
      .catch(() => {})
      .finally(() => { if (alive) setPrefLoaded(true); });
    return () => { alive = false; };
  }, []);

  const { from, to } = periodBounds(mode, cursor, customFrom, customTo);

  const saveDefault = async () => {
    setSavingPref(true);
    setPrefSaved(false);
    try {
      await api.post("/staff/time-registration/preference", {
        mode,
        custom_from: mode === "custom" ? from : null,
        custom_to: mode === "custom" ? to : null,
      });
      setPrefSaved(true);
    } catch (e) {
      setDownloadError(errText(e, t("tregPrefSaveFailed", "Could not save that as your default.")));
    } finally {
      setSavingPref(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await api.get("/staff/time-registration", { params: { from, to } });
      setData(res.data);
      setLocked(false);
    } catch (e) {
      if (e?.response?.status === 402) setLocked(true);
      else {
        // NOT `setData({ staff: [], totals: {} })`. That made a dropped
        // request indistinguishable from a measured result: `totals` came
        // back empty, `totals.all_compliant` was undefined, and the tile
        // above rendered "All compliant: No" in critical red — a confident
        // verdict about Arbejdstidsloven compliance derived from a request
        // that never arrived. Same for the rest-breach and 48h counts, which
        // fell to a fabricated 0.
        setData(null);
        setFailed(true);
      }
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  // Wait for the saved default before the first fetch, or the page loads the
  // month, then immediately reloads the owner's real period — two requests and
  // a visible flash of the wrong window.
  useEffect(() => { if (prefLoaded) load(); }, [load, prefLoaded]);

  const openStaff = async (sid) => {
    if (expanded === sid) { setExpanded(null); return; }
    setExpanded(sid);
    if (!detail[sid]) {
      try {
        const res = await api.get(`/staff/time-registration/${sid}`, { params: { from, to } });
        setDetail((d) => ({ ...d, [sid]: res.data }));
      } catch { /* leave empty — row still shows the summary */ }
    }
  };

  const downloadCsv = async () => {
    setDownloading(true);
    setDownloadError("");
    try {
      const res = await api.get("/staff/time-registration/export.csv", { params: { from, to }, responseType: "blob" });
      const out = await saveFile(res.data, `tidsregistrering_${from}_${to}.csv`, { type: "text/csv;charset=utf-8;" });
      if (!out.ok) setDownloadError(t("timeRegExportFailed"));
    } catch (e) {
      // try/finally with no catch made a 402 or a dead connection an unhandled
      // rejection: the spinner stopped and the screen was identical to success.
      // This is payroll-adjacent — the owner has to know it did not happen.
      setDownloadError(errText(e, t("timeRegExportFailed")));
    } finally {
      setDownloading(false);
    }
  };

  const periodLabel = (() => {
    const loc = dateLocale();
    if (mode === "quarter") {
      // "K3 2026" in Danish — a Dane writes kvartal, not quarter.
      const q = Math.floor(cursor.getMonth() / 3) + 1;
      return `${t("tregQuarterShort", "Q")}${q} ${cursor.getFullYear()}`;
    }
    if (mode === "year") return String(cursor.getFullYear());
    if (mode === "custom") {
      const d = (s) => new Date(s + "T00:00:00").toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" });
      return `${d(from)} – ${d(to)}`;
    }
    return cursor.toLocaleDateString(loc, { month: "long", year: "numeric" });
  })();

  const MODE_LABELS = {
    month: t("tregModeMonth", "Month"),
    quarter: t("tregModeQuarter", "Quarter"),
    year: t("tregModeYear", "Year"),
    custom: t("tregModeCustom", "Custom dates"),
  };

  if (locked) {
    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto page-enter">
        <PageHeader eyebrow={t("navStaff", "Staff")} title={t("tregTitle", "Time tracking")} />
        {/* APP STORE 3.1.1. This used to be a hand-rolled upgrade card that
            named the tier ("Starter+", "on Starter and Pro") and linked to
            /subscription — and it shipped in the iOS bundle, reachable by a
            Free owner in one tap, because neither this page nor the tab row
            carries a native gate. UpgradeNudge exists precisely to prevent
            that: it returns null on native (UpgradeNudge.jsx:141, "a single
            missed CTA on iOS = another rejection"). 32 other files already go
            through it, including this tab's own sibling StaffPayrollPage.
            Web keeps the full nudge; native gets a purely informational note
            with no tier name, no price and no purchase link. */}
        {isNativeApp() ? (
          <Card className="mt-4">
            <div className="flex items-start gap-2.5 p-1">
              <Icon name="Clock" size={18} strokeWidth={1.75} className="shrink-0 mt-0.5 text-gray-400" />
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t("tregNativeUnavailable")}
              </p>
            </div>
          </Card>
        ) : (
          <UpgradeNudge
            intent="card"
            tier="starter"
            iconName="Clock"
            benefit={t("tregLockedBody")}
            ctaLabel={t("seePlans", "See plans")}
            className="mt-4"
          />
        )}
      </div>
    );
  }

  const staff = data?.staff || [];
  const totals = data?.totals || {};
  // "We asked, and this is the answer." False while the first request is still
  // in flight and false if it failed — the compliance tiles below key off this
  // rather than off the shape of an empty object.
  const measured = !loading && !failed && data != null;

  return (
    <div className="p-4 sm:p-6 max-w-6xl 2xl:max-w-[1400px] mx-auto page-enter space-y-4">
      <PageHeader
        eyebrow={t("navStaff", "Staff")}
        title={t("tregTitle", "Time tracking")}
        subtitle={t("tregSubtitle", "Lovpligtig arbejdstidsregistrering — klar til Arbejdstilsynet")}
        actions={
          <Button variant="secondary" onClick={downloadCsv} disabled={downloading || !staff.length}>
            <Icon name="Download" size={15} strokeWidth={1.75} className="mr-1.5" />
            {downloading ? t("downloading", "Downloading…") : t("tregDownload", "Download register")}
          </Button>
        }
      />

      {downloadError && (
        <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-400 -mt-2">
          {downloadError}
        </p>
      )}

      {/* Period: how the register is framed, and the owner's default. */}
      <Card className="px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mr-1">
            {t("tregPeriodLabel", "Period")}
          </span>
          {TREG_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setPrefSaved(false); }}
              aria-pressed={mode === m}
              className={
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors " +
                (mode === m
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700")
              }
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {mode === "custom" ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => { setCustomFrom(e.target.value); setPrefSaved(false); }}
              aria-label={t("tregFrom", "From")}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm tabular-nums"
            />
            <span className="text-gray-400 text-sm">–</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => { setCustomTo(e.target.value); setPrefSaved(false); }}
              aria-label={t("tregTo", "To")}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm tabular-nums"
            />
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setCursor(stepCursor(mode, cursor, -1))} aria-label={t("previousPeriod", "Previous period")}>
              <Icon name="ChevronLeft" size={18} />
            </Button>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 capitalize min-w-[150px] text-center">{periodLabel}</span>
            <Button variant="ghost" size="sm" onClick={() => setCursor(stepCursor(mode, cursor, 1))} aria-label={t("nextPeriod", "Next period")}>
              <Icon name="ChevronRight" size={18} />
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-0.5">
          <span className="text-[11px] text-gray-400 tabular-nums">{from} → {to}</span>
          <button
            type="button"
            onClick={saveDefault}
            disabled={savingPref || (mode === "custom" && (!customFrom || !customTo))}
            className="text-[11px] font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 underline disabled:opacity-40 disabled:no-underline"
          >
            {prefSaved
              ? t("tregPrefSaved", "Saved as your default")
              : savingPref
                ? t("saving", "Saving…")
                : t("tregSetDefault", "Make this my default")}
          </button>
        </div>
      </Card>

      {/* Compliance rollup */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Colour marks an EXCEPTION, never a value. A headcount is a fact and
            stays gray; a zero stays gray because zero problems is not an
            achievement to celebrate, it is the normal state. Only a real
            breach takes a colour, so on a compliant venue this row reads as
            one calm block and the one day something is wrong, it is the only
            thing on the page wearing a colour. */}
        {/* NOT MEASURED YET IS NOT A VERDICT. This grid sits ABOVE the
            `loading ?` ternary below, so it rendered on first paint — before
            any request had been made — and `totals` was {} then too. Between
            them, the two bugs meant an owner opening this page saw "All
            compliant: No" in critical red, and a failed request left it there.
            An Arbejdstidsloven verdict the product has not computed reads as
            an em-dash, in gray, until it has. */}
        <StatCard
          label={t("tregStaff", "Employees")}
          value={measured ? String(totals.staff_count ?? staff.length) : "—"}
        />
        <StatCard
          label={t("tregAllOk", "All compliant")}
          value={
            // null from the server means "no employees in this period, so
            // there is nothing to be compliant ABOUT" — a third answer, not a
            // No. Python's all([]) used to make that an emerald Yes.
            measured && totals.all_compliant != null
              ? (totals.all_compliant ? t("yes", "Yes") : t("no", "No"))
              : "—"
          }
          accent={
            measured && totals.all_compliant === false
              ? "critical"
              : measured && totals.all_compliant === true
                ? "success"
                : "neutral"
          }
        />
        <StatCard
          label={t("tregRestIssues", "Rest issues")}
          value={measured ? String(totals.with_rest_violations ?? 0) : "—"}
          accent={measured && (totals.with_rest_violations ?? 0) > 0 ? "warn" : "neutral"}
        />
        <StatCard
          label={t("tregOverCap", "Over 48h/wk")}
          value={measured ? String(totals.over_weekly_cap ?? 0) : "—"}
          accent={measured && (totals.over_weekly_cap ?? 0) > 0 ? "critical" : "neutral"}
        />
      </div>

      {/* Legal note */}
      <Card>
        <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
          <Icon name="Scale" size={13} strokeWidth={1.75} className="inline mr-1 -mt-0.5" />
          {t("tregLegal", "Arbejdstidsloven: register each employee's daily working time. Verify 11h rest (hviletid) and max 48h/week averaged over 4 months. Records kept 5 years and accessible to the employee.")}
        </p>
      </Card>

      {/* Per-employee */}
      {loading ? (
        <Card><p className="text-sm text-gray-400">{t("loading", "Loading…")}</p></Card>
      ) : failed ? (
        // The register never arrived. Previously this fell through to the
        // empty state — "No registered time yet" — which tells an owner with a
        // full roster that nobody clocked in, on the page an Arbejdstilsynet
        // request is answered from.
        <LoadFailed onRetry={load} />
      ) : !staff.length ? (
        <Empty
          icon={Clock}
          title={t("tregEmptyTitle", "No registered time yet")}
          body={t("tregEmptyBody", "Time registration builds from clocked hours (Stempelur) or hours you log. Ask staff to clock in, or log their hours, and their register appears here.")}
        />
      ) : (
        <div className="space-y-2">
          {staff.map((s) => {
            const st = STATUS[s.days_registered === 0 ? "gap" : s.status] || STATUS.ok;
            const open = expanded === s.staff_id;
            const reg = detail[s.staff_id]?.register;
            return (
              <Card key={s.staff_id} className={`!p-0 overflow-hidden ${st.rail}`}>
                <button
                  onClick={() => openStaff(s.staff_id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.dot}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{s.staff_name}</div>
                    <div className={`text-xs ${st.text}`}>
                      {t(st.key, st.fb)}{s.rest_violation_count > 0 ? ` · ${s.rest_violation_count} ${t("tregRestShort", "rest")}` : ""}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                      {/* "No time registered" is a GAP, not a measured zero —
                          the backend gives 0 because there were no rows, and
                          the status beside this already says so. "0 min" would
                          assert somebody worked none. */}
                      {s.status === "gap" ? "\u2014" : formatHoursMinutes(s.total_hours, { lang })}
                    </div>
                    {/* The 4-month average stays DECIMAL on purpose: it is the
                        figure Arbejdstidsloven's 48 t/uge cap is measured
                        against, so it should read like the cap it is compared
                        to, not like a duration someone worked. */}
                    <div className="text-[11px] text-gray-400">{s.days_registered} {t("tregDays", "days")} · {t("tregRefWkAvg", "4-mo avg")} {formatHours(s.weekly_avg_hours, { lang, decimals: 2 })}/{t("tregWk", "wk")}</div>
                  </div>
                  <Icon name={open ? "ChevronUp" : "ChevronDown"} size={16} className="text-gray-400 shrink-0" />
                </button>

                {open && (
                  <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 bg-gray-50/60 dark:bg-gray-900/40">
                    {!reg ? (
                      <p className="text-xs text-gray-400">{t("loading", "Loading…")}</p>
                    ) : !reg.length ? (
                      <p className="text-xs text-amber-600 dark:text-amber-400">{t("tregNoneForStaff", "No time registered for this employee this period — not compliant. They must clock in or you must log their hours.")}</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-400 text-left">
                            <th className="font-medium pb-1.5">{t("tregDate", "Date")}</th>
                            <th className="font-medium pb-1.5">{t("tregStart", "Start")}</th>
                            <th className="font-medium pb-1.5">{t("tregEnd", "End")}</th>
                            <th className="font-medium pb-1.5 text-right">{t("tregHours", "Hours")}</th>
                            <th className="font-medium pb-1.5 text-right">{t("tregSource", "Source")}</th>
                          </tr>
                        </thead>
                        <tbody className="text-gray-700 dark:text-gray-300">
                          {reg.map((e, i) => (
                            <tr key={i} className="border-t border-gray-100/70 dark:border-gray-800/70">
                              <td className="py-1.5">{fmtDay(e.date)}</td>
                              <td className="py-1.5 tabular-nums">{e.start || "—"}</td>
                              <td className="py-1.5 tabular-nums">{e.end || "—"}</td>
                              <td className="py-1.5 text-right tabular-nums">{formatHoursMinutes(e.hours, { lang })}</td>
                              <td className="py-1.5 text-right">
                                <span className="text-[10px] uppercase tracking-wide text-gray-400">
                                  {e.source === "clock" ? t("tregClock", "Clock") : t("tregLogged", "Logged")}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {detail[s.staff_id]?.rest_violations?.length > 0 && (
                      <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                        {detail[s.staff_id].rest_violations.map((v, i) => (
                          <div key={i}>
                            ⚠ {fmtDay(v.after_date)} → {fmtDay(v.next_date)}: {formatHoursMinutes(v.rest_hours, { lang })} {t("tregRestGap", "rest")} ({formatHoursMinutes(v.shortfall_hours, { lang })} {t("tregShort", "short")})
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
