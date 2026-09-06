/**
 * The week labor% headline was knowingly wrong in both directions — ~110% red
 * on a healthy mid-week, and a dead "—" on the week the owner is building.
 * These pin the replacement's honesty rules one by one; each `it` name is the
 * rule it protects.
 */
import { describe, expect, it } from "vitest";
import { expectedWeekLabor } from "../utils/weekLaborPct";

const D = (n) => `2026-09-${String(n).padStart(2, "0")}`;

/** week-cost `daily` row. */
const day = (n, { cost = 1000, loaded = 1125, revenue = null, settled = false } = {}) => ({
  date: D(n),
  cost_gross: cost,
  cost_loaded: loaded,
  revenue,
  settled,
});

/** forecast `days` row. */
const fcDay = (n, { predicted = 5000, samples = 8 } = {}) => ({
  date: D(n),
  predicted_revenue: predicted,
  sample_count: samples,
});

const forecastOf = (days, extra = {}) => ({
  signal: "revenue",
  confidence: "high",
  days,
  ...extra,
});

describe("expectedWeekLabor", () => {
  it("pairs each day's cost with that day's own denominator", () => {
    // 2 settled days at 4.000 kr revenue each, 5 forecast days at 5.000 kr.
    // Cost is 1.000/day across all 7. The old math divided 7.000 kr of cost by
    // 8.000 kr of actual revenue = 87.5%. The truth is 7.000 / 33.000 = 21.2%.
    const daily = [
      day(1, { revenue: 4000, settled: true }),
      day(2, { revenue: 4000, settled: true }),
      ...[3, 4, 5, 6, 7].map((n) => day(n)),
    ];
    const forecast = forecastOf([3, 4, 5, 6, 7].map((n) => fcDay(n)));
    const r = expectedWeekLabor({ daily, forecast, costBasis: "gross" });

    expect(r.revenue).toBe(33000);
    expect(r.cost).toBe(7000);
    expect(r.pct).toBeCloseTo(7000 / 33000, 6);
    expect(r.daysActual).toBe(2);
    expect(r.daysForecast).toBe(5);
    expect(r.daysUnknown).toBe(0);
  });

  it("answers on a week that has not started yet — the planning case", () => {
    const daily = [1, 2, 3, 4, 5, 6, 7].map((n) => day(n));
    const forecast = forecastOf([1, 2, 3, 4, 5, 6, 7].map((n) => fcDay(n)));
    const r = expectedWeekLabor({ daily, forecast, costBasis: "gross" });

    expect(r.pct).toBeCloseTo(7000 / 35000, 6); // was null before — the dead case
    expect(r.isForecast).toBe(true);
    expect(r.daysActual).toBe(0);
  });

  it("flags isForecast whenever a projection entered the denominator", () => {
    const daily = [
      day(1, { revenue: 4000, settled: true }),
      day(2),
    ];
    const withFc = expectedWeekLabor({
      daily,
      forecast: forecastOf([fcDay(2)]),
      costBasis: "gross",
    });
    expect(withFc.isForecast).toBe(true);

    // A fully settled week is pure actuals — no forventet label.
    const closed = expectedWeekLabor({
      daily: [day(1, { revenue: 4000, settled: true }), day(2, { revenue: 4000, settled: true })],
      forecast: forecastOf([]),
      costBasis: "gross",
    });
    expect(closed.isForecast).toBe(false);
    expect(closed.pct).toBeCloseTo(2000 / 8000, 6);
  });

  it("drops a thin forecast from BOTH sides — same >=3 gate as the demand line", () => {
    const daily = [day(1, { revenue: 4000, settled: true }), day(2)];
    const r = expectedWeekLabor({
      daily,
      forecast: forecastOf([fcDay(2, { samples: 2 })]),
      costBasis: "gross",
    });
    // Day 2's 1.000 kr must NOT ride on day 1's revenue.
    expect(r.cost).toBe(1000);
    expect(r.revenue).toBe(4000);
    expect(r.daysUnknown).toBe(1);
    expect(r.isForecast).toBe(false);
  });

  it("drops a settled day that registered no revenue, rather than guessing", () => {
    // Closed Monday vs. an unregistered Monday are indistinguishable here.
    const daily = [
      day(1, { revenue: null, settled: true }),
      day(2, { revenue: 4000, settled: true }),
    ];
    const r = expectedWeekLabor({ daily, forecast: null, costBasis: "gross" });
    expect(r.daysUnknown).toBe(1);
    expect(r.cost).toBe(1000);
    expect(r.pct).toBeCloseTo(1000 / 4000, 6);
  });

  it("refuses an appointment forecast as a kroner denominator (salon)", () => {
    const daily = [day(1, { revenue: 4000, settled: true }), day(2)];
    const salonFc = {
      signal: "appointments",
      confidence: "high",
      // predicted_revenue is 0.0 on this path by construction.
      days: [{ date: D(2), predicted_revenue: 0, sample_count: 9 }],
    };
    const r = expectedWeekLabor({ daily, forecast: salonFc, costBasis: "gross" });
    expect(r.isForecast).toBe(false);
    expect(r.daysUnknown).toBe(1);
    expect(r.pct).toBeCloseTo(1000 / 4000, 6);
  });

  it("returns null, never 0, when nothing can be a denominator", () => {
    const r = expectedWeekLabor({
      daily: [1, 2, 3].map((n) => day(n)),
      forecast: null,
      costBasis: "gross",
    });
    expect(r.pct).toBeNull();
    expect(r.daysUnknown).toBe(3);
  });

  it("honours the loaded (feriepenge) basis", () => {
    const daily = [day(1, { revenue: 4000, settled: true })];
    const g = expectedWeekLabor({ daily, forecast: null, costBasis: "gross" });
    const l = expectedWeekLabor({ daily, forecast: null, costBasis: "loaded" });
    expect(g.pct).toBeCloseTo(1000 / 4000, 6);
    expect(l.pct).toBeCloseTo(1125 / 4000, 6);
  });

  it("carries confidence only when a forecast is actually in the number", () => {
    const settledOnly = expectedWeekLabor({
      daily: [day(1, { revenue: 4000, settled: true })],
      forecast: forecastOf([], { confidence: "low" }),
      costBasis: "gross",
    });
    expect(settledOnly.confidence).toBeNull();

    const mixed = expectedWeekLabor({
      daily: [day(1, { revenue: 4000, settled: true }), day(2)],
      forecast: forecastOf([fcDay(2)], { confidence: "low" }),
      costBasis: "gross",
    });
    expect(mixed.confidence).toBe("low");
  });

  it("survives a missing or malformed payload without throwing", () => {
    expect(expectedWeekLabor({ daily: null, forecast: null }).pct).toBeNull();
    expect(expectedWeekLabor({ daily: [], forecast: null }).pct).toBeNull();
    const r = expectedWeekLabor({
      daily: [{ date: D(1), cost_gross: null, revenue: "4000", settled: true }],
      forecast: { signal: "revenue", days: null },
      costBasis: "gross",
    });
    expect(r.pct).toBeNull(); // "4000" is not a number — not coerced, not trusted
    expect(r.daysUnknown).toBe(1);
  });
});
