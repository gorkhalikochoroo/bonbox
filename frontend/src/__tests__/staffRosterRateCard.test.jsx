/**
 * The roster's rate card, mounted for real — because a green build is not a
 * rendered screen.
 *
 * TWO THINGS ARE PINNED HERE, and the second one is why the first one matters.
 *
 * 1. AN UNSET RATE IS NOT ZERO KRONER. The add form on this very panel used to
 *    coerce a blank rate box to `base_rate: 0` (parseMoneyInput("") is NaN by
 *    design, and the fallback was the literal 0), and "Tilføj" is deliberately
 *    live with that box empty — so an owner who builds the roster first and
 *    sets wages later got a stored 0 on every person. Downstream, 0 is a FACT:
 *    _pick_rate returns it, every logged shift is costed at it, and Timer & løn
 *    tells the owner they pay this person nothing for a real week of work. The
 *    payload now sends null, and null has to SHOW as "—" on the one line of
 *    this roster that states a wage. This test mounts the page and reads that
 *    line, rather than trusting the payload change on its own.
 *
 * 2. THE RATE IS MONEY, AND HOURS ARE HOURS. The card printed
 *    `${rates.base}${currency}/hr` — the raw Numeric out of the payload with no
 *    grouping, the currency CODE glued to it, and an English unit, on a Danish
 *    wage line. 137,5 rendered as "137.5DKK/hr". It now goes through
 *    formatOwnerMoney and hoursUnit(), the same two helpers the Timer & løn
 *    rate column uses, so the two screens that show one person's rate cannot
 *    drift apart again. Øre survive on purpose: 137,50 kr./t is a rate people
 *    really type, and rounding it to 138 hands the owner a payroll row they
 *    cannot reproduce against the `earned` the server derived from 137,50.
 *
 * t() is mocked to the KEY, so `title="baseRate"` is the stable handle on the
 * two rate spans and the assertions survive the Danish wording landing.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, role: "owner", currency: "DKK", business_type: "cafe" },
    loading: false,
  }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ isAtCap: () => false, cap: () => 25, isReady: true, plan: "pro", data: {} }),
}));
vi.mock("../hooks/useDeviceShare", () => ({
  useDeviceShare: () => ({ ready: true, enabled: false, hasPin: false, locked: false }),
}));

import api from "../services/api";
import StaffSchedulePage from "../pages/StaffSchedulePage";

/** Three rows, one per outcome the rate field has to tell apart. */
const ROSTER = [
  // Nobody ever set a rate. NOT the same fact as "this person costs nothing".
  { id: "a", name: "Uden sats", role: "server", active: true, contract_type: "full", base_rate: null },
  // A real rate with øre — the case that catches a formatter rounding to 138.
  { id: "b", name: "Med sats", role: "server", active: true, contract_type: "full", base_rate: 137.5 },
  // A rate the owner deliberately typed as zero (unpaid trial week, the owner's
  // own row). This one IS a figure and must keep reading as one.
  { id: "c", name: "Nul sats", role: "server", active: true, contract_type: "full", base_rate: 0 },
];

async function openRoster() {
  api.get.mockImplementation((url) =>
    String(url).includes("/staff/members")
      ? Promise.resolve({ data: ROSTER })
      : Promise.resolve({ data: [] }),
  );
  render(
    <MemoryRouter>
      <StaffSchedulePage />
    </MemoryRouter>,
  );
  const toggle = await screen.findByText("schedManageStaff", {}, { timeout: 8000 });
  fireEvent.click(toggle.closest("button"));
  await screen.findByText("addNewStaffMember");
  // The rate span on each roster row, in roster order.
  return Array.from(document.querySelectorAll('[title="baseRate"]')).map((el) =>
    el.textContent.replace(/\s+/g, " ").trim(),
  );
}

beforeEach(() => {
  api.get.mockReset();
});

describe("the roster rate card", () => {
  it("renders an unset rate as an em-dash and never as a wage", async () => {
    const [unset] = await openRoster();
    expect(unset).toBe("baseRate: —");
    expect(unset).not.toMatch(/\d/);
  });

  it("renders a real rate in Danish money notation with the house hour unit", async () => {
    const [, real] = await openRoster();
    // Not "137.5DKK/hr": decimal comma, a spaced "kr.", and "t" for a Danish
    // session — the same three rules the Timer & løn rate column follows.
    expect(real).toBe("baseRate: 137,50 kr./t");
  });

  it("still states a deliberate zero as zero", async () => {
    const [, , zero] = await openRoster();
    // The whole point of preserving null is that 0 gets to keep its meaning.
    // If this row went "—" too, the fix would have swapped one lie for another.
    expect(zero).toBe("baseRate: 0 kr./t");
  });
});
