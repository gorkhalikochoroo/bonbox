import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";
import { dateLocale } from "../../../utils/dateFormat";
import { formatHours } from "../../../utils/hours";
import DemoTag from "./DemoTag";
import {
  DEMO_ROTA,
  formatKr,
  isoWeek,
  rotaLabourPct,
  rotaTotals,
  todayIndex,
  weekDates,
} from "./demoData";

/**
 * Landing v2 — the "You build the week" schedule-builder artifact.
 *
 * This is a *picture* of the roster builder, not the builder itself, so the
 * toolbar chips are rendered as static text rather than <button>s: a real
 * button here would be a dead-end CTA. The whole block is a <figure> with a
 * screen-reader caption that says what it is, and a visible demo label.
 *
 * Push 9: the week is the CURRENT week (it was frozen at week 31, 27 Jul –
 * 2 Aug), the people and their shifts come from the one demo rota
 * (./demoData) the phones and the hero use too, and the day, role and
 * department names are dictionary keys (the Danish page printed MON/TUE and
 * Kitchen/Bar/Floor). The footer says "estimated wage cost" — no
 * "feriepenge" (BonBox does not do payroll) — and the autopilot note names
 * the two rules it actually checks: the 11-hour rest and the 48-hour week
 * (backend services/schedule_autopilot.py).
 *
 * Sums are derived, never typed: five people, a cook and a server every
 * evening, 15 shifts, 82 t, ≈ 14.650 kr., 29 % of the week's expected revenue
 * ex MOMS (target 30 %). Hours are printed through utils/hours, so a Danish
 * visitor reads "6,25 t" and an English one "6.25 h" — with the same number
 * of decimals on a shift, a row total and the week total, so one row never
 * shows 18,75 beside 18,8.
 */

const DEPARTMENTS = {
  kitchen: { dot: "bg-red-500", edge: "border-l-red-500" },
  bar: { dot: "bg-blue-500", edge: "border-l-blue-500" },
  floor: { dot: "bg-bb-green-bright", edge: "border-l-green-500" },
};

const LEGEND = ["kitchen", "bar", "floor"];

const GRID = "grid grid-cols-[168px_repeat(7,minmax(0,1fr))_74px]";

export default function ScheduleGridV2() {
  const { t, lang } = useLanguage();
  // Up to two decimals everywhere (6.25), trailing zeros dropped (utils/hours):
  // shifts, contracts, row totals and the week total round the same way.
  const hrs = (v, decimals = 2) => formatHours(v, { lang, decimals });

  const draft = t("landingV2.schedule.draftBadge", "DRAFT");
  const now = new Date();
  const dates = weekDates(now);
  const today = todayIndex(now);
  const fmt = (d, opts) => {
    try {
      return new Intl.DateTimeFormat(dateLocale(), opts).format(d).replace(/\.$/, "");
    } catch {
      return "";
    }
  };
  const DAYS = dates.map((d, i) => ({
    key: `d${i}`,
    label: fmt(d, { weekday: "short" }).toUpperCase(),
    date: `${d.getDate()}/${d.getMonth() + 1}`,
  }));
  const weekLabel = t("landingV2.schedule.week", "Week {n} · {range}", {
    n: isoWeek(dates[0]),
    range: `${fmt(dates[0], { day: "numeric", month: "short" })} – ${fmt(dates[6], { day: "numeric", month: "short" })} ${dates[6].getFullYear()}`,
  });
  const totals = rotaTotals();
  const dept = (key) => t(`landingV2.schedule.dept.${key}`, key);
  const role = (key) => t(`landingV2.schedule.role.${key}`, key);

  return (
    <div>
      <div className="mb-[14px] flex items-center gap-2.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        <span className="h-px w-[18px] bg-slate-300" aria-hidden="true" />
        {t("landingV2.schedule.eyebrow", "You build the week")}
        <DemoTag className="ml-auto normal-case tracking-normal" />
      </div>

      <figure className="m-0 overflow-hidden rounded-2xl bg-white shadow-[0_16px_36px_-26px_rgba(15,23,42,0.35)]">
        <figcaption className="sr-only">
          {t(
            "landingV2.schedule.caption",
            "Preview of the BonBox schedule builder: a draft week for five staff, with hours and wage estimates."
          )}
        </figcaption>

        {/* Week navigation + toolbar */}
        <div className="flex flex-wrap items-center gap-[9px] px-[18px] pb-[14px] pt-4">
          <span className="inline-flex items-center gap-1.5 rounded-[9px] border border-slate-200 px-3 py-2 text-[12.5px] text-slate-600">
            <ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
            {t("landingV2.schedule.prev", "Previous")}
          </span>
          <span className="rounded-[9px] border border-slate-200 px-[14px] py-2 text-[13px] font-semibold text-slate-900">
            {weekLabel}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-[9px] border border-slate-200 px-3 py-2 text-[12.5px] text-slate-600">
            {t("landingV2.schedule.next", "Next")}
            <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
          </span>

          <span className="ml-auto flex flex-wrap gap-[9px]">
            <span className="rounded-[9px] border border-slate-200 px-[13px] py-2 text-[12.5px] font-medium text-slate-900">
              {t("landingV2.schedule.addShift", "+ Add Shift")}
            </span>
            <span className="rounded-[9px] border border-slate-200 px-[13px] py-2 text-[12.5px] font-medium text-slate-600">
              {t("landingV2.schedule.copyLastWeek", "Copy Last Week")}
            </span>
            <span className="inline-flex items-center gap-[7px] rounded-[9px] bg-slate-900 px-[13px] py-2 text-[12.5px] font-medium text-white">
              <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
              {t("landingV2.schedule.autopilot", "Autopilot")}
            </span>
            <span className="rounded-[9px] bg-bb-green px-[14px] py-2 text-[12.5px] font-semibold text-white">
              {t("landingV2.schedule.publish", "Publish Week · {n}", { n: totals.shifts })}
            </span>
          </span>
        </div>

        {/* Shift-colour legend */}
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 border-b border-slate-200 px-[18px] pb-[14px] text-[12px] text-slate-500">
          <span>{t("landingV2.schedule.legend", "Shift colours")}</span>
          {LEGEND.map((id) => (
            <span key={id} className="inline-flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${DEPARTMENTS[id].dot}`}
                aria-hidden="true"
              />
              {dept(id)}
            </span>
          ))}
          <span className="ml-auto text-slate-400">
            {t("landingV2.schedule.draftNote", "Draft — nothing sent yet")}
          </span>
        </div>

        {/* Staff × days grid — scrolls sideways instead of collapsing.
            On a phone only ~2 of the 7 day columns are visible, so the
            scroll needs saying out loud or the rest of the week is
            undiscoverable. Hidden once the grid fits. */}
        <div className="px-[18px] pb-1 text-[12px] font-medium text-slate-500 min-[1041px]:hidden">
          {t("landingV2.schedule.swipeHint", "Swipe to see the whole week →")}
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[820px]">
            {/* Header row */}
            <div className={`${GRID} border-b border-slate-200 bg-slate-50`}>
              <div className="px-4 py-3 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {t("landingV2.schedule.colStaff", "Staff")}
              </div>
              {DAYS.map((day, i) => (
                <div
                  key={day.key}
                  className={`border-l border-slate-200 px-2 py-2.5 text-center ${
                    i === today ? "bg-white" : ""
                  }`}
                >
                  <div
                    className={`text-[11px] font-semibold tracking-[0.1em] ${
                      i === today ? "text-slate-900" : "text-slate-500"
                    }`}
                  >
                    {day.label}
                  </div>
                  <div
                    className={`text-[11px] ${
                      i === today ? "text-slate-500" : "text-slate-400"
                    }`}
                  >
                    {day.date}
                  </div>
                  {i === today && (
                    <div className="text-[10px] font-medium text-bb-green">
                      {t("landingV2.schedule.booked", "2 booked")}
                    </div>
                  )}
                </div>
              ))}
              <div className="border-l border-slate-200 px-2 py-3 text-right text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {t("landingV2.schedule.colHours", "Hours")}
              </div>
            </div>

            {/* Staff rows */}
            {DEMO_ROTA.map((row, rowIndex) => (
              <div
                key={row.name}
                className={`${GRID} items-stretch ${
                  rowIndex < DEMO_ROTA.length - 1 ? "border-b border-slate-200" : ""
                }`}
              >
                <div className="flex items-center gap-[9px] px-4 py-3.5">
                  <span
                    className="h-[7px] w-[7px] flex-none rounded-full bg-bb-green-bright"
                    aria-hidden="true"
                  />
                  <div>
                    <div className="text-[14px] font-semibold text-slate-900">
                      {row.name}
                    </div>
                    <div className="text-[11.5px] text-slate-400">
                      {role(row.role)}
                      {row.contract ? ` · ${hrs(row.contract)}` : ""}
                    </div>
                  </div>
                </div>

                {DAYS.map((day, dayIndex) => {
                  const shift = row.shifts[dayIndex];
                  if (!shift) {
                    return (
                      <div key={day.key} className="border-l border-slate-100" />
                    );
                  }
                  const look = DEPARTMENTS[shift.dept];
                  return (
                    <div
                      key={day.key}
                      className="border-l border-slate-100 px-[7px] py-2"
                    >
                      <div
                        className={`rounded-lg border border-slate-200 border-l-[3px] bg-white px-[9px] py-2 ${look.edge}`}
                      >
                        <div className="text-[12px] font-semibold text-slate-900">
                          {shift.from}–{shift.to}
                        </div>
                        <div className="mt-0.5 text-[10.5px] text-slate-500">
                          {hrs(shift.hours)} · {dept(shift.dept)}
                        </div>
                        <div className="mt-[3px] text-[10px] font-semibold text-amber-700">
                          {draft} · ≈{formatKr(shift.wage)} {t("landingV2HeroKr", "kr.")}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="border-l border-slate-100 px-2.5 py-3.5 text-right font-display text-[15px] font-bold tracking-[-0.01em] text-slate-900">
                  {hrs(Object.values(row.shifts).reduce((a, x) => a + x.hours, 0))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer totals */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 border-t border-slate-200 bg-slate-50 px-[18px] py-3.5 text-[13px] text-slate-500">
          <span>
            <strong className="font-semibold text-slate-900">{hrs(totals.hours)}</strong>{" "}
            {t("landingV2.schedule.totalRostered", "rostered")}
          </span>
          <span>
            <strong className="font-semibold tabular-nums text-slate-900">≈{formatKr(totals.wage)} {t("landingV2HeroKr", "kr.")}</strong>{" "}
            {t("landingV2.schedule.totalWage", "estimated wage cost")}
          </span>
          <span className="font-medium text-bb-green">
            {t(
              "landingV2.schedule.totalLabour",
              "{pct} % of the week's expected sales — target 30 %",
              { pct: rotaLabourPct() },
            )}
          </span>
          <span className="ml-auto text-slate-500">
            {t(
              "landingV2.schedule.autopilotNote",
              "Autopilot checked the weather, the forecast and the 11-hour and 48-hour rules"
            )}
          </span>
        </div>
      </figure>
    </div>
  );
}
