import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";

/**
 * Landing v2 — the "You build the week" schedule-builder artifact.
 *
 * This is a *picture* of the roster builder, not the builder itself, so the
 * toolbar chips are rendered as static text rather than <button>s: a real
 * button here would be a dead-end CTA. The whole block is a <figure> with a
 * screen-reader caption that says what it is.
 *
 * All figures are static demo values. Sums are internally consistent:
 * 8 shifts · 52.8 h · the wage total equals the sum of the chip estimates.
 */

const DEPARTMENTS = {
  kitchen: {
    dot: "bg-red-500",
    edge: "border-l-red-500",
    key: "landingV2.schedule.deptKitchen",
    en: "Kitchen",
  },
  bar: {
    dot: "bg-blue-500",
    edge: "border-l-blue-500",
    key: "landingV2.schedule.deptBar",
    en: "Bar",
  },
  floor: {
    dot: "bg-bb-green-bright",
    edge: "border-l-green-500",
    key: "landingV2.schedule.deptFloor",
    en: "Floor",
  },
};

const LEGEND = ["kitchen", "bar", "floor"];

const DAYS = [
  { key: "landingV2.schedule.dayMon", en: "MON", dateKey: "landingV2.schedule.dateMon", date: "27/7" },
  { key: "landingV2.schedule.dayTue", en: "TUE", dateKey: "landingV2.schedule.dateTue", date: "28/7" },
  { key: "landingV2.schedule.dayWed", en: "WED", dateKey: "landingV2.schedule.dateWed", date: "29/7" },
  { key: "landingV2.schedule.dayThu", en: "THU", dateKey: "landingV2.schedule.dateThu", date: "30/7" },
  { key: "landingV2.schedule.dayFri", en: "FRI", dateKey: "landingV2.schedule.dateFri", date: "31/7" },
  { key: "landingV2.schedule.daySat", en: "SAT", dateKey: "landingV2.schedule.dateSat", date: "1/8" },
  { key: "landingV2.schedule.daySun", en: "SUN", dateKey: "landingV2.schedule.dateSun", date: "2/8" },
];

const ROWS = [
  {
    name: "Agnes Kristensen",
    roleKey: "landingV2.schedule.roleServer",
    roleEn: "server",
    contract: "18.75 h",
    total: "18.8h",
    shifts: {
      0: { time: "16:00–23:00", hours: "6.25 h", dept: "floor", wage: "≈906 kr." },
      4: { time: "16:00–23:00", hours: "6.25 h", dept: "floor", wage: "≈906 kr." },
      6: { time: "16:00–23:00", hours: "6.25 h", dept: "floor", wage: "≈1.156 kr." },
    },
  },
  {
    name: "Aksel Olsen",
    roleKey: "landingV2.schedule.roleManager",
    roleEn: "manager",
    contract: null,
    total: "6.5h",
    shifts: {
      5: { time: "18:00–00:30", hours: "6.5 h", dept: "bar", wage: "≈1.235 kr." },
    },
  },
  {
    name: "Alma Rasmussen",
    roleKey: "landingV2.schedule.roleServer",
    roleEn: "server",
    contract: "12.5 h",
    total: "12.5h",
    shifts: {
      1: { time: "16:00–23:00", hours: "6.25 h", dept: "floor", wage: "≈925 kr." },
      5: { time: "16:00–23:00", hours: "6.25 h", dept: "floor", wage: "≈1.175 kr." },
    },
  },
  {
    name: "Clara Larsen",
    roleKey: "landingV2.schedule.roleKitchen",
    roleEn: "kitchen",
    contract: "25 h",
    total: "15.0h",
    shifts: {
      2: { time: "15:00–23:00", hours: "7.5 h", dept: "kitchen", wage: "≈1.410 kr." },
      3: { time: "15:00–23:00", hours: "7.5 h", dept: "kitchen", wage: "≈1.410 kr." },
    },
  },
];

const GRID = "grid grid-cols-[168px_repeat(7,minmax(0,1fr))_74px]";

export default function ScheduleGridV2() {
  const { t } = useLanguage();

  const draft = t("landingV2.schedule.draftBadge", "DRAFT");

  return (
    <div>
      <div className="mb-[14px] flex items-center gap-2.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        <span className="h-px w-[18px] bg-slate-300" aria-hidden="true" />
        {t("landingV2.schedule.eyebrow", "You build the week")}
      </div>

      <figure className="m-0 overflow-hidden rounded-2xl bg-white shadow-[0_16px_36px_-26px_rgba(15,23,42,0.35)]">
        <figcaption className="sr-only">
          {t(
            "landingV2.schedule.caption",
            "Preview of the BonBox schedule builder: a draft week for four staff, with hours and wage estimates."
          )}
        </figcaption>

        {/* Week navigation + toolbar */}
        <div className="flex flex-wrap items-center gap-[9px] px-[18px] pb-[14px] pt-4">
          <span className="inline-flex items-center gap-1.5 rounded-[9px] border border-slate-200 px-3 py-2 text-[12.5px] text-slate-600">
            <ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
            {t("landingV2.schedule.prev", "Previous")}
          </span>
          <span className="rounded-[9px] border border-slate-200 px-[14px] py-2 text-[13px] font-semibold text-slate-900">
            {t("landingV2.schedule.week", "Week 31 · 27 Jul – 2 Aug 2026")}
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
              {t("landingV2.schedule.publish", "Publish Week · 8")}
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
              {t(DEPARTMENTS[id].key, DEPARTMENTS[id].en)}
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
                    i === 0 ? "bg-white" : ""
                  }`}
                >
                  <div
                    className={`text-[11px] font-semibold tracking-[0.1em] ${
                      i === 0 ? "text-slate-900" : "text-slate-500"
                    }`}
                  >
                    {t(day.key, day.en)}
                  </div>
                  <div
                    className={`text-[11px] ${
                      i === 0 ? "text-slate-500" : "text-slate-400"
                    }`}
                  >
                    {t(day.dateKey, day.date)}
                  </div>
                  {i === 0 && (
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
            {ROWS.map((row, rowIndex) => (
              <div
                key={row.name}
                className={`${GRID} items-stretch ${
                  rowIndex < ROWS.length - 1 ? "border-b border-slate-200" : ""
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
                      {t(row.roleKey, row.roleEn)}
                      {row.contract ? ` · ${row.contract}` : ""}
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
                  const dept = DEPARTMENTS[shift.dept];
                  return (
                    <div
                      key={day.key}
                      className="border-l border-slate-100 px-[7px] py-2"
                    >
                      <div
                        className={`rounded-lg border border-slate-200 border-l-[3px] bg-white px-[9px] py-2 ${dept.edge}`}
                      >
                        <div className="text-[12px] font-semibold text-slate-900">
                          {shift.time}
                        </div>
                        <div className="mt-0.5 text-[10.5px] text-slate-500">
                          {shift.hours} · {t(dept.key, dept.en)}
                        </div>
                        <div className="mt-[3px] text-[10px] font-semibold text-amber-700">
                          {draft} · {shift.wage}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="border-l border-slate-100 px-2.5 py-3.5 text-right font-display text-[15px] font-bold tracking-[-0.01em] text-slate-900">
                  {row.total}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer totals */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 border-t border-slate-200 bg-slate-50 px-[18px] py-3.5 text-[13px] text-slate-500">
          <span>
            <strong className="font-semibold text-slate-900">52.8 h</strong>{" "}
            {t("landingV2.schedule.totalRostered", "rostered")}
          </span>
          <span>
            <strong className="font-semibold text-slate-900">≈9.123 kr.</strong>{" "}
            {t("landingV2.schedule.totalWage", "wage cost, feriepenge in")}
          </span>
          <span className="font-medium text-bb-green">
            {t(
              "landingV2.schedule.totalLabour",
              "18% of forecast sales — under your 30% target"
            )}
          </span>
          <span className="ml-auto text-slate-400">
            {t(
              "landingV2.schedule.autopilotNote",
              "Autopilot checked weather, forecast and DK labour law"
            )}
          </span>
        </div>
      </figure>
    </div>
  );
}
