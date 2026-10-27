// Weekday opening-hours editor — the one weekday-rows grid shared by the
// Settings hours card and the salon first-run card. Presentational: the
// parent owns the `hours` state plus setHourDay(day, patch) and
// onApplyMonToAll (the "copy Monday to every day" shortcut above the rows).
// The state and the stored shape: utils/bookingHours.js.
//
// R8 (27 Oct 2026, rubric R4 / R8):
//   • two periods a day — "Tilføj periode" splits the day (11–22 → lunch
//     11–14.30 and dinner 17.30–22; a salon's 09–17 → 09–12 and 12.30–17),
//     and × takes the second away again. Shown only when the server reads
//     the shape (`allowAddPeriod`); a stored second period is always shown.
//   • the last booking time per period (`lastBooking`, table venues): said
//     in words under the day's times — "Sidste booking 20.30 (auto) og
//     21.00" — and each is a picker: automatic, or any start on the grid.
// "Brug mandag på alle" copies the periods and their last booking times.
import { Fragment } from "react";
import { Plus, X } from "lucide-react";
import { hm } from "../../utils/bookingTimes";
import { weekdayName } from "../../utils/venueHours";
import {
  DAY_KEYS, MAX_PERIODS, addPeriod, autoLast, fitLast, gridTimes, removePeriod,
} from "../../utils/bookingHours";

const TIME_INPUT =
  "h-11 px-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-base sm:text-sm " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent";

const ROW_BUTTON =
  "inline-flex items-center justify-center h-11 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 " +
  "dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-green-accent))]";

/** The last booking line of one open day (table venues, R8). */
function LastBookingLine({ t, dayKey, lang, periods, step, sitting, apptWords, onPick }) {
  const day = weekdayName(dayKey, lang);
  const none = [];
  const pickers = periods.map((p, i) => {
    const auto = autoLast(p, step, sitting);
    if (!auto && !p.last) none.push(p);
    const grid = gridTimes(p, step);
    // A stored time off this grid (set by hand, or before the step changed)
    // is shown as what applies, never hidden behind a choice it is not.
    const extra = p.last && !grid.includes(p.last) ? p.last : null;
    return (
      <Fragment key={i}>
        {i > 0 && <span aria-hidden>{t("rsvpLastBookingAnd", "and")}</span>}
        <select
          value={p.last || ""}
          onChange={(e) => onPick(i, e.target.value)}
          aria-label={t("rsvpLastBookingFor", "Last booking, {day} {from}–{to}", { day, from: hm(p.open), to: hm(p.close) })}
          data-testid={`last-booking-${dayKey}-${i}`}
          className={
            "h-10 sm:h-8 px-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 " +
            "text-[13px] tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 " +
            (p.last ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-600 dark:text-gray-300")
          }
        >
          <option value="">
            {auto
              ? t("rsvpLastBookingAuto", "{time} (auto)", { time: hm(auto) })
              : t("rsvpLastBookingAutoNone", "none (auto)")}
          </option>
          {grid.map((g) => (
            <option key={g} value={g}>{hm(g)}</option>
          ))}
          {extra && <option value={extra}>{hm(extra)}</option>}
        </select>
      </Fragment>
    );
  });
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-gray-500 dark:text-gray-400">
        <span>{t("rsvpLastBookingLabel", "Last booking")}</span>
        {pickers}
      </div>
      {none.map((p) => (
        <p key={`${p.open}-${p.close}`} role="note" className="text-xs text-amber-700 dark:text-amber-400">
          {apptWords
            ? t("rsvpLastBookingNoneFitsAppt", "{from}–{to} is shorter than one booking ({min} min). Pick a last booking, or no one can book then.", { from: hm(p.open), to: hm(p.close), min: sitting })
            : t("rsvpLastBookingNoneFits", "{from}–{to} is shorter than the table time ({min} min). Pick a last booking, or no one can book then.", { from: hm(p.open), to: hm(p.close), min: sitting })}
        </p>
      ))}
    </div>
  );
}

export default function WeekHoursEditor({
  t, lang = "da", hours, setHourDay, onApplyMonToAll,
  allowAddPeriod = false, addMode = "meal", lastBooking = null, problemDay = null,
}) {
  // Static t() keys (not template literals) so the i18n grep can verify each
  // has an EN+DA entry. DK weeks start Monday.
  const dayLabel = {
    mon: t("rsvpDayMon", "Mon"),
    tue: t("rsvpDayTue", "Tue"),
    wed: t("rsvpDayWed", "Wed"),
    thu: t("rsvpDayThu", "Thu"),
    fri: t("rsvpDayFri", "Fri"),
    sat: t("rsvpDaySat", "Sat"),
    sun: t("rsvpDaySun", "Sun"),
  };
  const step = lastBooking?.step || 15;
  // Every period change keeps a chosen last booking time honest: inside its
  // period and on the grid (utils/bookingHours.fitLast), else automatic.
  const setPeriods = (k, periods) => {
    const fitted = lastBooking ? periods.map((p) => fitLast(p, step)) : periods;
    setHourDay(k, { periods: fitted });
  };
  const setPeriod = (k, i, patch) => {
    const periods = hours[k].periods.map((p, j) => (j === i ? { ...p, ...patch } : p));
    setPeriods(k, periods);
  };
  return (
    <div className="space-y-2">
      {onApplyMonToAll && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onApplyMonToAll}
            className="shrink-0 text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 underline-offset-2 hover:underline"
          >
            {t("rsvpHoursCopyMon", "Apply Monday to all")}
          </button>
        </div>
      )}
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {DAY_KEYS.map((k) => {
          const d = hours[k];
          const isOpen = !d.closed;
          const periods = d.periods || [];
          const flagged = problemDay === k;
          return (
            <div
              key={k}
              data-day={k}
              aria-invalid={flagged || undefined}
              className={
                "flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2 " +
                (flagged ? "rounded-lg ring-1 ring-red-300 dark:ring-red-800 px-2 -mx-2" : "")
              }
            >
              <span className="w-9 shrink-0 text-sm font-medium leading-[44px] text-gray-700 dark:text-gray-300">
                {dayLabel[k]}
              </span>
              {/* Open / closed — 44px tap target for the host stand. */}
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none shrink-0 min-h-[44px]">
                <input
                  type="checkbox"
                  checked={isOpen}
                  onChange={(e) => setHourDay(k, { closed: !e.target.checked })}
                  className="w-5 h-5 rounded border-gray-300 dark:border-gray-600 text-gray-900 accent-gray-900 dark:accent-gray-100 focus:ring-gray-400"
                />
                <span className="text-xs text-gray-500 dark:text-gray-400 w-12">
                  {isOpen ? t("rsvpHoursOpen", "Open") : t("rsvpHoursClosed", "Closed")}
                </span>
              </label>
              {isOpen ? (
                <div className="min-w-0 space-y-1.5 max-sm:basis-full sm:flex-1">
                  {periods.map((p, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-1.5" data-period={i}>
                      <input
                        type="time"
                        value={p.open}
                        onChange={(e) => setPeriod(k, i, { open: e.target.value })}
                        aria-label={i === 0 ? t("rsvpHoursOpenAt", "Opens") : t("rsvpHoursOpenAt2", "Opens (2nd period)")}
                        className={TIME_INPUT}
                      />
                      <span className="text-gray-400" aria-hidden>–</span>
                      <input
                        type="time"
                        value={p.close}
                        onChange={(e) => setPeriod(k, i, { close: e.target.value })}
                        aria-label={i === 0 ? t("rsvpHoursCloseAt", "Closes") : t("rsvpHoursCloseAt2", "Closes (2nd period)")}
                        className={TIME_INPUT}
                      />
                      {periods.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => setPeriods(k, removePeriod(periods, i))}
                          aria-label={t("rsvpHoursRemovePeriod", "Remove {from}–{to}", { from: hm(p.open), to: hm(p.close) })}
                          className={ROW_BUTTON + " w-11"}
                        >
                          <X className="w-4 h-4" strokeWidth={1.75} aria-hidden />
                        </button>
                      ) : allowAddPeriod && periods.length < MAX_PERIODS ? (
                        <button
                          type="button"
                          onClick={() => setPeriods(k, addPeriod(periods, addMode))}
                          aria-label={t("rsvpHoursAddPeriodAria", "Add period, {day}", { day: weekdayName(k, lang) })}
                          className={ROW_BUTTON + " gap-1 px-2 text-xs font-medium"}
                        >
                          <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
                          {t("rsvpHoursAddPeriod", "Add period")}
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {lastBooking && periods.length > 0 && (
                    <LastBookingLine
                      t={t}
                      dayKey={k}
                      lang={lang}
                      periods={periods}
                      step={step}
                      sitting={lastBooking.sitting}
                      apptWords={!!lastBooking.apptWords}
                      onPick={(i, value) => setPeriod(k, i, { last: value })}
                    />
                  )}
                </div>
              ) : (
                <span className="text-sm leading-[44px] text-gray-400 dark:text-gray-500">
                  {t("rsvpHoursClosedDay", "Closed all day")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
