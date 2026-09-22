/**
 * "Nobody has opened it" and "we did not ask" are different answers.
 *
 * THE DEFECT this model exists to kill:
 *   StaffSchedulePage rendered "Your team sees these shifts in the BonBox
 *   Scheduler app" unconditionally — under the week toolbar, for every owner,
 *   including a brand-new account with no staff and no link ever sent. Across
 *   51 venues not a single staff link has ever been opened, so that sentence
 *   was false on every screen where it mattered, and it is a large part of why
 *   the failure stayed invisible: the owner shared the week, read a line saying
 *   the team could see it, and stopped looking.
 *
 * WHY A MODEL AND NOT AN `if`:
 *   The tempting fix is `rows.some(r => r.last_accessed)`. That is a boolean,
 *   and a boolean has already thrown away the case this product keeps getting
 *   wrong — the request that failed, the manager seat the owner-only endpoint
 *   403s, the call that was never made because the sheet was never opened. All
 *   three arrive as "no rows", and a boolean turns them into `false`, which the
 *   page would print as the confident sentence "no one has opened their link
 *   yet". That is a second false claim replacing the first one.
 *
 *   So: null = not known (render nothing), opened === 0 = genuinely nobody,
 *   opened > 0 = the only state in which a screen may speak about reach.
 */
import { describe, expect, it } from "vitest";
import { linkWasOpened, summarizePortalReach } from "../utils/portalReach";

const row = (id, last_accessed = null) => ({
  staff_id: id,
  staff_name: `Medarbejder ${id}`,
  portal_url: `/s/tok${id}`,
  last_accessed,
});

describe("not knowing is its own outcome", () => {
  it("returns null when the call never ran", () => {
    expect(summarizePortalReach(undefined)).toBeNull();
    expect(summarizePortalReach(null)).toBeNull();
  });

  it("returns null for a body that is not a list of rows", () => {
    // A 402/403 payload, an HTML error page parsed as JSON, a shape change —
    // none of these are evidence that nobody opened their link.
    expect(summarizePortalReach({ detail: "Forbidden" })).toBeNull();
    expect(summarizePortalReach("")).toBeNull();
  });

  it("an empty roster is known-and-empty, not unknown", () => {
    // The owner has no staff. We DID ask; there is simply nobody to reach. The
    // page suppresses the line on `staff === 0`, but it must be able to tell
    // this apart from a failed request.
    expect(summarizePortalReach([])).toEqual({
      staff: 0,
      opened: 0,
      neverOpened: 0,
      lastOpenedAt: null,
    });
  });
});

describe("the genuine zero — the answer the audit was looking for", () => {
  it("counts a roster where nobody has ever opened their link", () => {
    const out = summarizePortalReach([row("a"), row("b"), row("c")]);
    expect(out).toEqual({ staff: 3, opened: 0, neverOpened: 3, lastOpenedAt: null });
  });

  it("treats an unusable timestamp as NOT opened", () => {
    // A read receipt is the one thing on this screen that must never be
    // invented. Anything that does not parse is not a receipt.
    expect(linkWasOpened({ last_accessed: "" })).toBe(false);
    expect(linkWasOpened({ last_accessed: "not a date" })).toBe(false);
    expect(linkWasOpened({})).toBe(false);
    expect(linkWasOpened(null)).toBe(false);
    expect(summarizePortalReach([row("a", "not a date")]).opened).toBe(0);
  });
});

describe("somebody did open it", () => {
  it("counts only the rows that carry a real timestamp", () => {
    const out = summarizePortalReach([
      row("a", "2026-09-12T08:31:00"),
      row("b"),
      row("c", "2026-09-19T16:02:00"),
    ]);
    expect(out.staff).toBe(3);
    expect(out.opened).toBe(2);
    expect(out.neverOpened).toBe(1);
  });

  it("reports the MOST RECENT open, not the last row in the list", () => {
    // The server returns rows in roster order, so "the last one with a value"
    // is an arbitrary staffer, and the owner would read a stale date as the
    // team's last sign of life.
    const out = summarizePortalReach([
      row("a", "2026-09-19T16:02:00"),
      row("b", "2026-09-12T08:31:00"),
    ]);
    expect(out.lastOpenedAt).toBe("2026-09-19T16:02:00");
  });

  it("a naive UTC timestamp from the API is accepted as-is", () => {
    // The column is a bare DateTime populated by utc_now() (naive), so FastAPI
    // serialises it WITHOUT a Z. Requiring an offset here would have quietly
    // downgraded every real read receipt in production to "never opened".
    expect(linkWasOpened({ last_accessed: "2026-09-12T08:31:00" })).toBe(true);
    expect(linkWasOpened({ last_accessed: "2026-09-12T08:31:00Z" })).toBe(true);
  });
});
