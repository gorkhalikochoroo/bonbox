/**
 * The Staff back-office tab strip must not offer a tab that 403s.
 *
 * Drikkepenge and Løn are money end to end: /api/staff/tips is denied to every
 * delegated seat, and all three payroll reads became owner-only when the
 * manager estimate carve-out closed (18 Sep 2026). Leaving the tabs in place
 * would have produced the two failure shapes this file exists to prevent —
 *
 *   • StaffTipsPage catches its 403 into an empty history and renders "no tips
 *     yet" over a tip history that exists. A screen that states a falsehood.
 *   • StaffPayrollPage renders its period picker above nothing, which every
 *     manager reads as "the app is broken", not as "this is not for me".
 *
 * So the tabs are dropped for a staff seat AND for a curtained shared device
 * (the same `isStaffMemberRole(role) || (shared && locked)` expression the
 * sidebar, the More grid and ⌘K already gate owner-financials on), and a deep
 * link into a dropped tab renders WagePrivacyNotice INSTEAD of mounting the
 * page — so the denied request is never sent in the first place.
 *
 * The page stubs below assert exactly that: "did this component mount?" is the
 * only honest proxy for "did its fetch fire?" without re-mounting four real
 * pages and their whole dependency trees.
 *
 * The positive controls (owner, and an owner who has entered the reveal PIN)
 * are half the file. A gate that hides the tabs from everyone would satisfy
 * every negative assertion here and quietly cost the owner their lønkørsel.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import StaffBackOfficePage from "../pages/StaffBackOfficePage";

// t() → the key, so assertions read against the label keys themselves.
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));

const authState = vi.hoisted(() => ({ role: "owner" }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, role: authState.role, currency: "DKK" }, loading: false }),
}));

const deviceState = vi.hoisted(() => ({ ready: true, enabled: false, locked: false }));
vi.mock("../hooks/useDeviceShare", () => ({
  useDeviceShare: () => ({
    ready: deviceState.ready, enabled: deviceState.enabled,
    hasPin: true, locked: deviceState.locked,
  }),
}));

// Stub the four tab bodies. Rendering one is the observable proof that its
// data fetch would have fired; NOT rendering it is the proof that it would not.
vi.mock("../pages/StaffHoursPage", () => ({ default: () => <div>stub-hours</div> }));
vi.mock("../pages/TimeRegistrationPage", () => ({ default: () => <div>stub-time</div> }));
vi.mock("../pages/StaffTipsPage", () => ({ default: () => <div>stub-tips</div> }));
vi.mock("../pages/StaffPayrollPage", () => ({ default: () => <div>stub-payroll</div> }));

function renderHub(tab) {
  const url = tab ? `/staff/hours?tab=${tab}` : "/staff/hours";
  return render(
    <MemoryRouter initialEntries={[url]}>
      <StaffBackOfficePage />
    </MemoryRouter>,
  );
}

const tabNames = () =>
  screen.getAllByRole("tab").map((el) => el.textContent.trim());

beforeEach(() => {
  authState.role = "owner";
  deviceState.ready = true;
  deviceState.enabled = false;
  deviceState.locked = false;
});

describe("the tab strip", () => {
  it("gives the owner all four tabs", () => {
    renderHub();
    expect(tabNames()).toEqual([
      "staffHours", "staffTimeReg", "staffTips", "staffPayroll",
    ]);
  });

  it.each(["manager", "cashier", "viewer"])(
    "drops Drikkepenge and Løn for a %s seat",
    (role) => {
      authState.role = role;
      renderHub();
      expect(tabNames()).toEqual(["staffHours", "staffTimeReg"]);
    },
  );

  it("drops them on a curtained shared device, where the actor IS the owner", () => {
    deviceState.enabled = true;
    deviceState.locked = true;
    renderHub();
    expect(tabNames()).toEqual(["staffHours", "staffTimeReg"]);
  });

  it("gives them back the moment the reveal PIN lifts the curtain", () => {
    // POSITIVE CONTROL. Shared mode alone must not cost the owner their own
    // numbers — that is what the PIN is for.
    deviceState.enabled = true;
    deviceState.locked = false;
    renderHub();
    expect(tabNames()).toContain("staffPayroll");
    expect(tabNames()).toContain("staffTips");
  });

  it("still lets a staff seat run a shift from the Timer tab", () => {
    authState.role = "manager";
    renderHub();
    expect(screen.getByText("stub-hours")).toBeTruthy();
  });
});

describe("a deep link into a dropped tab", () => {
  it.each(["tips", "payroll"])(
    "says why instead of mounting the ?tab=%s page",
    (tab) => {
      authState.role = "manager";
      renderHub(tab);

      // The honest state, in the copy that already ships in en + da.
      expect(screen.getByText("hovRoleCannotSee")).toBeTruthy();
      // …and the denied fetch never happens, because the page never mounts.
      expect(screen.queryByText(`stub-${tab}`)).toBeNull();
    },
  );

  it("offers a way out rather than a dead end", () => {
    authState.role = "manager";
    renderHub("payroll");
    // The action is labelled with the tab it sends them to (Timer), which is
    // where the hours and clock-ins they came for actually live.
    expect(screen.getByRole("button", { name: "staffHours" })).toBeTruthy();
  });

  it("curtains the deep link on a shared device too", () => {
    deviceState.enabled = true;
    deviceState.locked = true;
    renderHub("payroll");
    expect(screen.queryByText("stub-payroll")).toBeNull();
    // …but it must NOT say "your role can't see this". The viewer here IS the
    // owner: their role is not the obstacle, the curtain is, and they can lift
    // it. Saying otherwise tells them something false and then sends them to
    // ask themselves for a number they already own.
    expect(screen.queryByText("hovRoleCannotSee")).toBeNull();
    expect(screen.getByText("curtainTitle")).toBeTruthy();
  });

  it("gives the curtained owner the PIN, not a jump to another tab", () => {
    deviceState.enabled = true;
    deviceState.locked = true;
    renderHub("payroll");
    // The same words the global DeviceShareChip uses for the same act.
    expect(screen.getByRole("button", { name: "deviceRevealNumbers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "staffHours" })).toBeNull();
  });

  it("keeps the role copy for an actual member seat on a shared device", () => {
    // Both conditions at once. A manager cannot lift the curtain either, so
    // the PIN would be a dead end — role is the binding reason and the one to
    // state.
    authState.role = "manager";
    deviceState.enabled = true;
    deviceState.locked = true;
    renderHub("payroll");
    expect(screen.getByText("hovRoleCannotSee")).toBeTruthy();
    expect(screen.queryByText("curtainTitle")).toBeNull();
  });

  it("does not mount a wage page before the curtain state has landed", () => {
    // enabled/locked both default to FALSE until /auth/device-pin/status
    // answers, so a hard refresh at ?tab=payroll used to mount the page and
    // fire the owner-only read before the answer arrived.
    deviceState.ready = false;
    deviceState.enabled = true;
    deviceState.locked = true;
    renderHub("payroll");
    expect(screen.queryByText("stub-payroll")).toBeNull();
  });

  it("still opens Løn for the owner", () => {
    // POSITIVE CONTROL for the deep link: the person who runs the lønkørsel
    // must keep their bookmark.
    renderHub("payroll");
    expect(screen.getByText("stub-payroll")).toBeTruthy();
    expect(screen.queryByText("hovRoleCannotSee")).toBeNull();
  });
});
