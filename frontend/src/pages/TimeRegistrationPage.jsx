// Tidsregistrering — owner view of DK working-time compliance.
// Reads /staff/time-registration (compliance summary over HoursLogged) and
// lets the owner scan each employee's status, drill into a daily register,
// and download the inspection-ready CSV. Starter+ (gated server-side; we
// render an upgrade card on a 402).
import { useState, useEffect, useCallback } from "react";
import api from "../services/api";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { PageHeader, Button, StatCard, Card, Empty, Icon } from "../components/ui";

function monthBounds(d) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const iso = (x) => {
    const o = x.getTimezoneOffset() * 60000;
    return new Date(x.getTime() - o).toISOString().slice(0, 10);
  };
  return { from: iso(start), to: iso(end) };
}

const STATUS = {
  ok:   { dot: "bg-green-500", text: "text-green-700 dark:text-green-400", key: "tregOk",     fb: "Compliant" },
  warn: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400", key: "tregWarn",   fb: "Rest issue" },
  over: { dot: "bg-red-500",   text: "text-red-700 dark:text-red-400",     key: "tregOver",   fb: "Over weekly cap" },
  gap:  { dot: "bg-gray-300",  text: "text-gray-500",                       key: "tregGap",    fb: "No time registered" },
};

function fmtDay(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: "short" });
}

export default function TimeRegistrationPage() {
  const { t } = useLanguage();
  const [cursor, setCursor] = useState(() => new Date());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [expanded, setExpanded] = useState(null);   // staff_id whose register is open
  const [detail, setDetail] = useState({});          // staff_id -> register rows
  const [downloading, setDownloading] = useState(false);

  const { from, to } = monthBounds(cursor);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/staff/time-registration", { params: { from, to } });
      setData(res.data);
      setLocked(false);
    } catch (e) {
      if (e?.response?.status === 402) setLocked(true);
      else setData({ staff: [], totals: {} });
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

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
    try {
      const res = await api.get("/staff/time-registration/export.csv", { params: { from, to }, responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `tidsregistrering_${from}_${to}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const monthLabel = cursor.toLocaleDateString("da-DK", { month: "long", year: "numeric" });

  if (locked) {
    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto page-enter">
        <PageHeader eyebrow={t("navStaff", "Staff")} title={t("tregTitle", "Tidsregistrering")} />
        <Card variant="emphasis" className="mt-4">
          <div className="flex flex-col items-start gap-3 p-1">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Icon name="Clock" size={18} strokeWidth={1.75} /> {t("tregLockedTitle", "Legal time-registration — Starter+")}
            </span>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t("tregLockedBody", "Danish law (Arbejdstidsloven, since 2024) requires you to register every employee's working hours. BonBox turns your clock-ins into a compliant, inspection-ready register — on Starter and Pro.")}
            </p>
            <Link to="/subscription"><Button variant="primary">{t("seePlans", "See plans")}</Button></Link>
          </div>
        </Card>
      </div>
    );
  }

  const staff = data?.staff || [];
  const totals = data?.totals || {};

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto page-enter space-y-4">
      <PageHeader
        eyebrow={t("navStaff", "Staff")}
        title={t("tregTitle", "Tidsregistrering")}
        subtitle={t("tregSubtitle", "Lovpligtig arbejdstidsregistrering — klar til Arbejdstilsynet")}
        actions={
          <Button variant="secondary" onClick={downloadCsv} disabled={downloading || !staff.length}>
            <Icon name="Download" size={15} strokeWidth={1.75} className="mr-1.5" />
            {downloading ? t("downloading", "Downloading…") : t("tregDownload", "Download register")}
          </Button>
        }
      />

      {/* Month nav */}
      <div className="flex items-center justify-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
          <Icon name="ChevronLeft" size={18} />
        </Button>
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 capitalize min-w-[140px] text-center">{monthLabel}</span>
        <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
          <Icon name="ChevronRight" size={18} />
        </Button>
      </div>

      {/* Compliance rollup */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label={t("tregStaff", "Employees")} value={String(totals.staff_count ?? staff.length)} />
        <StatCard label={t("tregAllOk", "All compliant")} value={totals.all_compliant ? t("yes", "Yes") : t("no", "No")} />
        <StatCard label={t("tregRestIssues", "Rest issues")} value={String(totals.with_rest_violations ?? 0)} />
        <StatCard label={t("tregOverCap", "Over 48h/wk")} value={String(totals.over_weekly_cap ?? 0)} />
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
      ) : !staff.length ? (
        <Empty
          icon="Clock"
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
              <Card key={s.staff_id} className="!p-0 overflow-hidden">
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
                    <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{s.total_hours} t</div>
                    <div className="text-[11px] text-gray-400">{s.days_registered} {t("tregDays", "days")} · ⌀ {s.weekly_avg_hours} t/{t("tregWk", "wk")}</div>
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
                              <td className="py-1.5 text-right tabular-nums">{e.hours.toFixed(1)}</td>
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
                            ⚠ {fmtDay(v.after_date)} → {fmtDay(v.next_date)}: {v.rest_hours}t {t("tregRestGap", "rest")} ({v.shortfall_hours}t {t("tregShort", "short")})
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
