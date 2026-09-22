/**
 * Timer & løn must never end in a wall, and must never price a shift it
 * cannot price.
 *
 * TWO DEFECTS, both found in the end-to-end audit of the six core jobs, both
 * on the pay surface, both invisible to a green build.
 *
 * ── 1. THE EMPTY-ROSTER DEAD END ───────────────────────────────────────────
 * The Oversigt empty state carried exactly one button, "Registrér timer", and
 * it moved the owner to the Log tab. QuickLogForm's staff <select> is built
 * from GET /staff/members, so on a venue that has never added anybody it holds
 * one disabled placeholder and nothing else; the submit button reads
 * `disabled={... || !staffId ...}` and can therefore never light up. The front
 * door of the job led to a form that cannot be submitted, and no screen on the
 * way said why. A non-technical owner reads that as a broken app, not as a
 * missing prerequisite — and this is the FIRST screen a new venue opens.
 *
 * The fix has to distinguish THREE outcomes, not two. `staffList.length === 0`
 * is also what a FAILED fetch leaves behind, and telling an owner with nine
 * staff to "add your first team member" would be the comforting-and-false
 * answer this page has spent its whole history removing. So: asked-and-nobody
 * → the CTA becomes a link to the roster; could-not-ask → the old CTA stays
 * and LoadFailed explains itself.
 *
 * ── 2. THE CONFIDENT ZERO ON THE PAY ROW ───────────────────────────────────
 * A staff member with no wage rate set is costed by the backend at
 * `float(staff.base_rate or 0)`, so every shift they work stores earned = 0.
 * /staff/hours/summary then sends `hourly_rate: null, earned: 0` and the row
 * printed "— | 0 kr. | 0 kr.": an em-dash admitting the rate is unknown, one
 * cell away from a wage figure asserting it is nothing. The owner reads the
 * number, not the dash. 0 kr. for somebody who worked 34 hours is the most
 * expensive sentence this table could say, and the totals row summed those
 * zeros into a period wage total that looked complete.
 *
 * `hourly_rate: null` has two causes and only one of them is this one: a
 * delegated seat gets every money field nulled by design. The tests below pin
 * both, because collapsing them would either re-state the zero or blank a
 * screen for a manager who is allowed to see the hours.
 *
 * t() is mocked to return the KEY, so these assertions survive the Danish
 * wording landing in the catalogue — they are about which sentence is shown,
 * not about how it is phrased.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, role: "owner", currency: "DKK" }, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));

import api from "../services/api";
import StaffHoursPage from "../pages/StaffHoursPage";

const PERIOD = { period_type: "monthly_1st", start_date: "2026-09-01", end_date: "2026-09-30" };

/** An overview payload with no logged hours — the branch that carries the CTA. */
const EMPTY_OVERVIEW = {
  has_any_hours: false,
  hours: { scheduled_total: 0 },
  period: { is_complete: false },
};

/** One person, 34 hours worked, and NOBODY EVER SET THEIR RATE. This is the
 *  exact shape /staff/hours/summary sends for that venue: the rate is null
 *  because it does not exist, and `earned` is a real stored 0 derived from it. */
const ROW_NO_RATE = {
  staff_id: "s-1",
  staff_name: "Agnes",
  actual_hours: 34,
  scheduled_hours: 34,
  hourly_rate: null,
  earned: 0,
  tips: 0,
  total: 0,
  work_limit: null,
  worst_state: "matched",
  needs_answer_count: 0,
};

/** The control: same table, a rate that exists, and a real wage. */
const ROW_WITH_RATE = {
  staff_id: "s-2",
  staff_name: "Bo",
  actual_hours: 10,
  scheduled_hours: 10,
  hourly_rate: 150,
  earned: 1500,
  tips: 0,
  total: 1500,
  work_limit: null,
  worst_state: "matched",
  needs_answer_count: 0,
};

/** A delegated seat: the server nulls EVERY money field, rate included. */
const ROW_REDACTED = {
  staff_id: "s-3",
  staff_name: "Cem",
  actual_hours: 12,
  scheduled_hours: 12,
  hourly_rate: null,
  earned: null,
  tips: null,
  total: null,
  work_limit: null,
  worst_state: "matched",
  needs_answer_count: 0,
};

/**
 * @param {object} o
 * @param {"ok"|"fail"} o.staff   did GET /staff/members answer at all?
 * @param {any[]}       o.roster  what it answered with
 * @param {any}         o.overview
 * @param {any[]}       o.summary
 */
function mountPage({ staff = "ok", roster = [], overview = EMPTY_OVERVIEW, summary = [] } = {}) {
  api.get.mockImplementation((url) => {
    if (url === "/staff/members") {
      return staff === "fail"
        ? Promise.reject(Object.assign(new Error("boom"), { response: { status: 500 } }))
        : Promise.resolve({ data: roster });
    }
    if (url === "/staff/pay-period/current") return Promise.resolve({ data: PERIOD });
    if (url === "/staff/hours/summary") return Promise.resolve({ data: summary });
    if (url === "/staff/hours/overview") return Promise.resolve({ data: overview });
    if (url === "/staff/hours") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: null });
  });
  return render(
    <MemoryRouter>
      <StaffHoursPage />
    </MemoryRouter>,
  );
}

const openTab = async (key) => {
  const tab = await screen.findByRole("tab", { name: key });
  fireEvent.click(tab);
};

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

describe("Oversigt, with nobody on the roster", () => {
  it("offers a way to ADD a staff member instead of a form that cannot be submitted", async () => {
    mountPage({ roster: [] });

    // The CTA is a real destination, not the Log tab.
    const cta = await screen.findByRole("link", { name: /hovEmptyAddStaff/ });
    expect(cta).toHaveAttribute("href", "/staff/schedule");

    // And the button that led into the wall is gone from this state.
    expect(screen.queryByRole("button", { name: "logHours" })).not.toBeInTheDocument();
  });

  it("says WHY there is nothing to log, rather than only that there is nothing", async () => {
    mountPage({ roster: [] });
    expect(await screen.findByText("hovEmptyNoStaff")).toBeInTheDocument();
  });
});

describe("Oversigt, when the roster is known to have people", () => {
  it("keeps the Log hours CTA — the form works, so the old route is the right one", async () => {
    mountPage({ roster: [{ id: "s-1", name: "Agnes" }] });
    expect(await screen.findByRole("button", { name: "logHours" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /hovEmptyAddStaff/ })).not.toBeInTheDocument();
  });
});

describe("Oversigt, when the roster fetch FAILED", () => {
  it("does not tell an owner with staff that they have none", async () => {
    mountPage({ staff: "fail" });
    // A failure leaves the same empty array as a genuinely empty venue. Only
    // one of those two facts may be stated, and it is not this one.
    expect(await screen.findByRole("button", { name: "logHours" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("hovEmptyNoStaff")).not.toBeInTheDocument(),
    );
  });
});

describe("the Log tab's name picker", () => {
  it("states the reason it is empty and links to the fix", async () => {
    mountPage({ roster: [] });
    await openTab(/^hovTabLog/);

    expect(await screen.findByText("shpNoStaffYetTitle")).toBeInTheDocument();
    const links = await screen.findAllByRole("link", { name: /hovEmptyAddStaff/ });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute("href", "/staff/schedule");
  });

  it("keeps quiet when there are people to pick", async () => {
    mountPage({ roster: [{ id: "s-1", name: "Agnes" }] });
    await openTab(/^hovTabLog/);
    await screen.findByText("shpQuickLogDesc");
    expect(screen.queryByText("shpNoStaffYetTitle")).not.toBeInTheDocument();
  });
});

describe("the period summary, for a staffer with no wage rate", () => {
  const openDetails = async (summary) => {
    mountPage({
      roster: [{ id: "s-1", name: "Agnes" }],
      overview: { ...EMPTY_OVERVIEW, has_any_hours: true, cost: {}, labor: {}, flags: {} },
      summary,
    });
    await openTab(/^hovTabPerStaff/);
    return screen.findByText("Agnes");
  };

  it("renders the earned column as unknown, never as 0 kr.", async () => {
    const name = await openDetails([ROW_NO_RATE]);
    const row = name.closest("tr");
    // Every money cell on this row must be free of a digit: a "0" here is the
    // app telling the owner what it pays Agnes, on a number nothing measured.
    const cells = within(row).getAllByRole("cell");
    const moneyText = cells.slice(4).map((c) => c.textContent).join(" ");
    expect(moneyText).not.toMatch(/\d/);
  });

  it("refuses to state a period wage total it cannot complete", async () => {
    await openDetails([ROW_NO_RATE, ROW_WITH_RATE]);
    // Bo's 1.500 kr. is real, but a total that adds Agnes in at zero is short
    // by whatever she is owed while LOOKING complete. The dash is the honest
    // answer; the note below it is what keeps the dash from being a dead end.
    const totalsRow = screen.getByText("shpTotalCount").closest("tr");
    const cells = within(totalsRow).getAllByRole("cell");
    expect(cells[cells.length - 1].textContent).toBe("—");
  });

  it("names the cause and offers the one tap that fixes it", async () => {
    await openDetails([ROW_NO_RATE]);
    expect(screen.getByText("shpMissingRateOne")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "shpSetWageRates" })).toHaveAttribute(
      "href",
      "/staff/schedule",
    );
  });

  it("leaves a priced row alone", async () => {
    mountPage({
      roster: [{ id: "s-2", name: "Bo" }],
      overview: { ...EMPTY_OVERVIEW, has_any_hours: true, cost: {}, labor: {}, flags: {} },
      summary: [ROW_WITH_RATE],
    });
    await openTab(/^hovTabPerStaff/);
    const row = (await screen.findByText("Bo")).closest("tr");
    // Earned AND Total both carry it — a priced row is priced twice over.
    expect(within(row).getAllByText(/1\.500/).length).toBe(2);
    expect(screen.queryByText("shpMissingRateOne")).not.toBeInTheDocument();
  });

  it("does not mistake a REDACTED rate for an unset one", async () => {
    mountPage({
      roster: [{ id: "s-3", name: "Cem" }],
      overview: { ...EMPTY_OVERVIEW, has_any_hours: true, cost: {}, labor: {}, flags: {} },
      summary: [ROW_REDACTED],
    });
    await openTab(/^hovTabPerStaff/);
    await screen.findByText("Cem");
    // A delegated seat already gets "—" everywhere from the null payload. It
    // must NOT also be told a colleague has no wage rate: that is a statement
    // about the roster, made from a redaction, and it is not true.
    expect(screen.queryByText("shpMissingRateOne")).not.toBeInTheDocument();
    expect(screen.queryByText("shpMissingRateMany")).not.toBeInTheDocument();
  });

  it("still reports a genuine zero as zero when nobody worked", async () => {
    const idle = { ...ROW_NO_RATE, actual_hours: 0, scheduled_hours: 8 };
    mountPage({
      roster: [{ id: "s-1", name: "Agnes" }],
      overview: { ...EMPTY_OVERVIEW, has_any_hours: true, cost: {}, labor: {}, flags: {} },
      summary: [idle],
    });
    await openTab(/^hovTabPerStaff/);
    await screen.findByText("Agnes");
    // No hours means earned really IS 0, whatever the rate would have been.
    // Blanking it here would trade one lie for a different one.
    expect(screen.queryByText("shpMissingRateOne")).not.toBeInTheDocument();
  });
});
