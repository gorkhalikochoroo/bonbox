/**
 * The schedule surfaces must not assert a delivery that never happened.
 *
 * THE DEFECT (three instances, one shape — found in the end-to-end audit):
 *   1. StaffSchedulePage printed "Your team sees these shifts in the BonBox
 *      Scheduler app" unconditionally, under the week toolbar, for every owner
 *      — including one with no staff and no link ever sent.
 *   2. ScheduleConfirmationCard's none-state said "Schedule sent to {total}
 *      staff — none have confirmed yet", where {total} is `total_staff` from
 *      /staff/schedule-confirmation-summary: the count of distinct staff with a
 *      PUBLISHED SHIFT this week. A roster size. Nothing in that number, or
 *      anywhere else in that payload, records anything being sent to anybody.
 *   3. The publish sheet led with "{n} shifts are now live" and demoted "No
 *      affected staff had an email on file — nothing was sent" to grey 12px
 *      underneath it.
 *
 * WHY IT MATTERED: 0 of 51 venues have ever had a staff link opened. These
 * three sentences are the reason no owner found out. Each one answered the
 * question "did my team get this?" with a reassuring yes that nothing had
 * checked.
 *
 * These tests pin the INVARIANT — no screen in the schedule hand-off claims a
 * send — rather than any one wording, so a future rewrite of the copy cannot
 * quietly reintroduce the claim in either language.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn() },
}));

import api from "../services/api";
import { LanguageProvider } from "../hooks/useLanguage";
import ScheduleConfirmationCard from "../components/ScheduleConfirmationCard";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "pages", "StaffSchedulePage.jsx");

/** Any way either language says "was sent" about the vagtplan. */
const CLAIMS_A_SEND = /\bsent\b|\bsendt\b|\bsend(?:t)? til\b/i;

async function renderNoneConfirmed(lang) {
  localStorage.setItem("lang", lang);
  api.get.mockResolvedValue({
    data: {
      week_start: "2026-09-21",
      total_staff: 4,
      confirmed_staff: 0,
      all_confirmed: false,
      none_confirmed: true,
    },
  });
  const { unmount } = render(
    <LanguageProvider>
      <ScheduleConfirmationCard />
    </LanguageProvider>,
  );
  const node = await screen.findByRole("status");
  const text = node.textContent;
  unmount();
  return text;
}

describe("ScheduleConfirmationCard — the none-state describes confirmations, not deliveries", () => {
  beforeEach(() => {
    localStorage.clear();
    api.get.mockReset();
  });

  it.each(["en", "da"])("does not claim the vagtplan was sent (%s)", async (lang) => {
    const text = await renderNoneConfirmed(lang);
    expect(text).not.toMatch(CLAIMS_A_SEND);
  });

  it.each(["en", "da"])("still tells the owner how many people have shifts (%s)", async (lang) => {
    // The honest half of the old sentence. total_staff is a real measurement —
    // it just measures the roster for the week, not an outbox.
    const text = await renderNoneConfirmed(lang);
    expect(text).toContain("4");
  });

  it("renders a resolved sentence, never a raw catalogue key", async () => {
    // `t("key") || "fallback"` — the shape this file used to use — never fires
    // the fallback, because t() returns the KEY when the key is missing. The
    // owner reads "scheduleConfirmNoneHonest" as body text. t(key, fallback)
    // is the form that actually falls back.
    const text = await renderNoneConfirmed("en");
    expect(text).not.toMatch(/scheduleConfirm[A-Za-z]*/);
  });
});

describe("StaffSchedulePage — the Scheduler-app line is conditional on evidence", () => {
  const src = readFileSync(PAGE, "utf8");

  /* `.includes()` rather than `expect(src).not.toContain(...)`: the page is
     7k lines and a failing toContain prints the whole file as a diff. */
  const has = (needle) => src.includes(needle);

  it("no longer renders the unconditional 'your team sees these shifts' claim", () => {
    expect(has("scheduleStaffAppHint")).toBe(false);
  });

  it("every reach sentence sits behind the portalReach answer", () => {
    // Both branches live inside `{portalReach && portalReach.staff > 0 && (`,
    // so a null reach (never asked, owner-only endpoint 403'd, request failed)
    // renders nothing at all — no claim in either direction.
    const gate = src.indexOf("{portalReach && portalReach.staff > 0 && (");
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf("scheduleStaffOpenedCount")).toBeGreaterThan(gate);
    expect(src.indexOf("scheduleStaffNoneOpened")).toBeGreaterThan(gate);
  });

  it("the publish sheet leads with 'nobody was told' when nobody was told", () => {
    // The old body rendered the live-count paragraph FIRST and the nothing-was-
    // sent note after it. Order is the whole defect: an owner reads the
    // headline. `toldNobody` now decides the title, the icon and which sentence
    // is the big one.
    const nobody = src.indexOf("publishedNobodyToldBody");
    const saved = src.indexOf("publishedSavedNotSent");
    expect(nobody).toBeGreaterThan(-1);
    expect(saved).toBeGreaterThan(nobody);
    expect(has("const toldNobody =")).toBe(true);
  });

  it("an unknown notify count is neither 'notified' nor 'nobody was told'", () => {
    // Coercing the server's count with `|| 0` turned a missing field into a
    // confident zero, which is now a sentence on screen. Three outcomes.
    expect(has("publishedNotifyUnknown")).toBe(true);
    expect(has("notify_count) || 0")).toBe(false);
  });
});
