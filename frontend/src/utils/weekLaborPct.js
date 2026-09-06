/**
 * weekLaborPct.js — the week's labor% headline, honest in both directions.
 *
 * THE DEFECT THIS REPLACES
 *
 * The server used to return `week.labor_pct_gross = week_gross / week_rev`:
 * a whole week of rostered cost divided by whatever revenue had actually
 * happened. Two failure modes, both invisible from the screen:
 *
 *   • Mid-week — numerator covers 7 days, denominator covers 2. The headline
 *     read ~110% red on a week that was fine.
 *   • Future week — denominator is 0, so the headline read "—". Dead during
 *     the one task the number exists for: deciding whether the roster you are
 *     BUILDING is affordable.
 *
 * The server now returns a matched pair over settled days only (see the
 * comment on `week.settled` in staff.py). That is a true actuals number and it
 * is still blank on a week that has not started. This module supplies the
 * other half: the forecast the grid is ALREADY showing.
 *
 * WHY THIS IS CLIENT-SIDE
 *
 * The grid fetches /staff/schedules/forecast for the per-day "demand ~40h"
 * overlay. Computing the headline from that same payload guarantees the two
 * numbers on one screen come from one forecast. Recomputing it inside
 * /schedules/week-cost would mean two Open-Meteo fetches minutes apart, and a
 * headline that can quietly disagree with the day cells beneath it — the
 * defect class where one surface contradicts a fact stated on another.
 *
 * HONESTY RULES (each one is a test in weekLaborPct.test.js)
 *
 *  1. A day contributes to the denominator only when it has a number we did
 *     not invent: settled actual revenue, or a forecast with a real basis.
 *  2. A day with neither is excluded from BOTH sides. Excluding it from the
 *     denominator alone would inflate labor%; from the numerator alone would
 *     deflate it. It is counted in `daysUnknown` so the UI can say so.
 *  3. Forecast days use the SAME gate as the demand overlay (sample_count >=
 *     3). Below that the grid already refuses to draw a demand line; the
 *     headline must not be braver than the cell.
 *  4. Salons forecast appointment density, not kroner — `signal !== "revenue"`
 *     means no forecast denominator exists, so we fall back to actuals rather
 *     than converting bookings into revenue we cannot support.
 *  5. `isForecast` is true whenever any forecast entered the denominator. The
 *     caller MUST label it (forventet). A projected number wearing an actuals
 *     label is the thing this file exists to prevent.
 *  6. No denominator at all → null. Never 0, never a guess.
 */

/** Same gate as the per-day demand overlay in StaffSchedulePage. */
const MIN_FORECAST_SAMPLES = 3;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @param {object}   a
 * @param {Array}    a.daily     week-cost `daily` rows (date, cost_gross,
 *                               cost_loaded, revenue, settled)
 * @param {object}   a.forecast  /staff/schedules/forecast payload, or null
 * @param {"gross"|"loaded"} a.costBasis
 * @returns {{
 *   pct: number|null, isForecast: boolean, cost: number, revenue: number,
 *   revenueActual: number, revenueForecast: number,
 *   daysActual: number, daysForecast: number, daysUnknown: number,
 *   confidence: string|null
 * }}
 */
export function expectedWeekLabor({ daily, forecast, costBasis = "gross" }) {
  const empty = {
    pct: null,
    isForecast: false,
    cost: 0,
    revenue: 0,
    revenueActual: 0,
    revenueForecast: 0,
    daysActual: 0,
    daysForecast: 0,
    daysUnknown: 0,
    confidence: null,
  };
  if (!Array.isArray(daily) || daily.length === 0) return empty;

  // Rule 4: only a revenue-signal forecast can serve as a kroner denominator.
  const fcUsable = forecast?.signal === "revenue" && Array.isArray(forecast?.days);
  const fcByDate = {};
  if (fcUsable) for (const d of forecast.days) fcByDate[d.date] = d;

  let cost = 0;
  let revenueActual = 0;
  let revenueForecast = 0;
  let daysActual = 0;
  let daysForecast = 0;
  let daysUnknown = 0;

  for (const row of daily) {
    const dayCost = num(costBasis === "loaded" ? row.cost_loaded : row.cost_gross) ?? 0;
    const actual = num(row.revenue);

    // `settled` is the SERVER's judgement — it owns the venue timezone and the
    // DK 06:00 business-day cutoff. Deriving it from the browser clock would
    // misfile the 00:00-06:00 window for a venue the owner is not standing in.
    if (row.settled && actual !== null && actual > 0) {
      cost += dayCost;
      revenueActual += actual;
      daysActual += 1;
      continue;
    }

    const fc = fcByDate[row.date];
    const predicted = num(fc?.predicted_revenue);
    const samples = num(fc?.sample_count) ?? 0;
    // Rule 3.
    if (predicted !== null && predicted > 0 && samples >= MIN_FORECAST_SAMPLES) {
      cost += dayCost;
      revenueForecast += predicted;
      daysForecast += 1;
      continue;
    }

    // Rule 2 — out of both sums, and said out loud.
    daysUnknown += 1;
  }

  const revenue = revenueActual + revenueForecast;
  return {
    // Rule 6.
    pct: revenue > 0 ? cost / revenue : null,
    // Rule 5.
    isForecast: daysForecast > 0,
    cost,
    revenue,
    revenueActual,
    revenueForecast,
    daysActual,
    daysForecast,
    daysUnknown,
    confidence: daysForecast > 0 ? forecast?.confidence ?? null : null,
  };
}
