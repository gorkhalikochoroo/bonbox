/**
 * "Has tonight's kasserapport been locked?" — a question Home never asked.
 *
 * THE DEFECT: DashboardPage's ctx carried `dailyCloseRanToday: false` as a
 * HARDCODED literal, with a comment claiming CloserPromptCard "self-detects
 * whether daily close ran". It does not — that card fetches /output-channels
 * and detects whether a CLOSER is configured. Nothing on the dashboard ever
 * looked at a close.
 *
 * The one predicate that read the flag then compounded it:
 *
 *     !ctx?.dailyCloseRanToday && (ctx?.summary?.todaySales ?? 0) > 0
 *
 * The first half was a no-op against a constant. The second half required
 * BonBox to BE the till — and the ICP, a 5-12 staff cafe running its own POS
 * and typing the Z-report in at closing time, has todaySales === 0 every
 * single night. So the dashboard's only close-aware surface never rendered
 * for the segment it was written for, and the flag it was gated on could
 * never have changed the answer anyway.
 *
 * The third state is the part that is easy to lose again: the flag is now
 * true / false / null, where null means the lookup failed or has not
 * returned. `!null` is `true`, so a `!ctx.dailyCloseRanToday` predicate would
 * quietly turn a dropped request into "you have not closed yet" — nagging an
 * owner about a day they already locked. Every reader must test `=== false`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DASHBOARD_CARD_SET } from "../config/dashboardCardSets";
import { businessTodayIso, localIso, localDaysAgo } from "../utils/dateFormat";
import { findConfirmedCloseFor } from "../utils/dailyCloseDay";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH = readFileSync(join(HERE, "..", "pages", "DashboardPage.jsx"), "utf8");

const CODE = DASH
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

const closerCard = DASHBOARD_CARD_SET.zone3.find((c) => c.id === "closer");

/** A ctx with the shape the close predicate reads. */
const ctx = (over = {}) => ({ summary: { todaySales: 0 }, ...over });

describe("the flag is computed, not asserted", () => {
  it("the hardcoded literal is gone", () => {
    expect(CODE).not.toMatch(/dailyCloseRanToday:\s*false/);
  });

  it("it is wired to the derived close state", () => {
    expect(CODE).toMatch(/dailyCloseRanToday:\s*dailyClose\.ranToday/);
    expect(CODE).toMatch(/const dailyClose = useMemo\(/);
  });

  it('"could not check" is its own outcome, not a false', () => {
    // A boolean here would collapse "loading", "the request 403'd" and "the
    // day really is still open" into one answer, and the answer it would
    // give is the one that nags.
    expect(CODE).toMatch(/ranToday:\s*null/);
    expect(CODE).toMatch(/closeListState === "failed" \? "failed" : "loading"/);
  });
});

describe("the close-aware card renders for the ICP", () => {
  it("shows when tonight's close is known to be open, with no BonBox sales", () => {
    // The exact ICP night: the cafe rang everything through its own POS, so
    // todaySales is 0, and the kasserapport has not been locked. This is the
    // case the old predicate excluded by construction.
    expect(closerCard.renderIf(ctx({ dailyCloseRanToday: false, summary: { todaySales: 0 } }))).toBe(true);
  });

  it("hides once the close is locked", () => {
    expect(closerCard.renderIf(ctx({ dailyCloseRanToday: true }))).toBe(false);
  });

  it("hides when we could not check", () => {
    expect(closerCard.renderIf(ctx({ dailyCloseRanToday: null }))).toBe(false);
    expect(closerCard.renderIf(ctx({}))).toBe(false);
    expect(closerCard.renderIf(undefined)).toBe(false);
  });

  it("no longer depends on BonBox being the till", () => {
    expect(String(closerCard.renderIf)).not.toMatch(/todaySales/);
  });
});

describe("todaySales was a phantom reading as a measured zero", () => {
  it("the missing count is no longer coerced to 0", () => {
    // `summary?.today_sale_count || 0` read a key NO endpoint in this product
    // sends — grep the backend, it does not exist. So ctx.summary.todaySales
    // was 0 for every account on every night, which is what made
    // `todaySales > 0` a branch that could never be taken while reading like
    // a rule about venues with sales. Null says "never measured"; 0 claims
    // the till was counted and came to nothing.
    expect(CODE).not.toMatch(/today_sale_count \|\| 0/);
    expect(CODE).toMatch(/todaySales: summary\?\.today_sale_count \?\? null/);
  });
});

describe("the fetch window can always contain the business day", () => {
  it("[yesterday, today] covers businessTodayIso for every cutoff hour", () => {
    // businessTodayIso returns YESTERDAY's date whenever the clock is before
    // the cutoff, so a one-day window would miss the close a 06:00 venue
    // locked at 01:30 and invite the owner to close the same day twice —
    // the bug utils/dailyCloseDay.js was written to kill, re-entering
    // through the query range instead of the comparison.
    const from = localDaysAgo(1);
    const to = localIso();
    for (let cutoff = 0; cutoff <= 23; cutoff += 1) {
      const businessDay = businessTodayIso(cutoff);
      expect(businessDay >= from).toBe(true);
      expect(businessDay <= to).toBe(true);
    }
  });

  it("a confirmed row for the business day is what counts as done", () => {
    // Fixed dates: the two rows have to stay DISTINCT from each other no
    // matter what hour the suite runs at.
    const rows = [
      { id: 1, date: "2026-09-21", status: "draft" },
      { id: 2, date: "2026-09-20", status: "confirmed" },
    ];
    // A kladde is not a locked kasserapport, and yesterday's lock is not
    // tonight's — so neither row makes 21 Sep "done".
    expect(findConfirmedCloseFor(rows, "2026-09-21")).toBeNull();
    expect(
      findConfirmedCloseFor([{ id: 3, date: "2026-09-21", status: "confirmed" }], "2026-09-21").id,
    ).toBe(3);
  });
});
