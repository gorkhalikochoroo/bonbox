/**
 * The USAGE GATE on the surfaces that are NOT the nav — the ones that could
 * each leave a door open into a pillar we just removed from the menu:
 *
 *   • PillarDiscovery — the discovery floor. Both of its lists must exclude a
 *     usage-gated pillar: "Slå til" (it would re-add the nav row we hid) and
 *     "Sæt op" (it would advertise setting up a feature we're not selling).
 *   • ModulesPage /modules — a switch reading "on" for a pillar that is
 *     nowhere in the nav is simply a lie. It uses usageKnownDormant, so the
 *     row must NOT disappear while the answer is still loading.
 *   • OnboardingPage's preset card — the gated pillar is not a chip, and the
 *     card itself must disappear when the remaining preset hides nothing
 *     (restaurant / salon / service / general), yet still show for cafe.
 *
 * The preset OFF-lists used below mirror backend services/pillars.py; the
 * backend side is pinned by tests/test_pillar_presets.py (including the
 * "no BUSINESS preset hides events" guard), so the two can't drift silently.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

// t() → the key, so assertions read against the pillar label keys.
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));

const pillarState = vi.hoisted(() => ({ hidden: new Set(), isReady: true }));
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({
    hiddenPillars: pillarState.hidden,
    isReady: pillarState.isReady,
    setPillarHidden: vi.fn().mockResolvedValue(undefined),
  }),
}));

const activationState = vi.hoisted(() => ({
  usageDormantPillars: new Set(),
  usageKnownDormant: new Set(),
  activated: new Set(["inventory", "reservations", "events", "staff"]),
  isInScope: false,
  activationEnabled: false,
  isReady: true,
}));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({
    usageDormantPillars: activationState.usageDormantPillars,
    usageKnownDormant: activationState.usageKnownDormant,
    activatedPillars: activationState.activated,
    isActivated: (p) => activationState.activated.has(p),
    isInScope: activationState.isInScope,
    activationEnabled: activationState.activationEnabled,
    loading: !activationState.isReady,
    isReady: activationState.isReady,
    refresh: vi.fn(),
  }),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, business_type: "cafe", role: "owner" }, loading: false }),
}));

vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchType: null, businessTypes: ["cafe"] }),
}));

import api from "../services/api";
import PillarDiscovery from "../components/PillarDiscovery";
import ModulesPage from "../pages/ModulesPage";
import { presetChipLists, presetCardIsEmpty } from "../pages/OnboardingPage";

const EVENTS = () => new Set(["events"]);

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue({ data: { plan: "free", modules_cap: 1, modules: [] } });
  pillarState.hidden = new Set();
  pillarState.isReady = true;
  activationState.usageDormantPillars = new Set();
  activationState.usageKnownDormant = new Set();
  activationState.activated = new Set(["inventory", "reservations", "events", "staff"]);
  activationState.isInScope = false;
  activationState.activationEnabled = false;
  activationState.isReady = true;
});

const renderDiscovery = () =>
  render(
    <MemoryRouter>
      <PillarDiscovery variant="more" />
    </MemoryRouter>,
  );

describe("PillarDiscovery — usage-gated pillars are not offered", () => {
  it('excludes a usage-gated pillar from the "Slå til" list', () => {
    // The owner has events hidden (a legacy preset row) AND it is usage-gated.
    pillarState.hidden = new Set(["events", "inventory"]);
    activationState.usageDormantPillars = EVENTS();
    renderDiscovery();
    // Inventory is the positive control — the section still renders, so a
    // missing Events tile means the filter worked, not that nothing rendered.
    expect(screen.getByLabelText(/pillarLabelInventory/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/pillarLabelEvents/)).not.toBeInTheDocument();
  });

  it('excludes a usage-gated pillar from the "Sæt op" list', () => {
    // Activation gate live + events dormant: without the usage filter this
    // would render a "Sæt op — Arrangementer" tile.
    activationState.isInScope = true;
    activationState.activationEnabled = true;
    activationState.activated = new Set(["inventory", "reservations", "staff"]);
    activationState.usageDormantPillars = EVENTS();
    const { container } = renderDiscovery();
    expect(screen.queryByLabelText(/pillarLabelEvents/)).not.toBeInTheDocument();
    // Nothing else to offer for a cafe → the whole affordance renders null.
    expect(container).toBeEmptyDOMElement();
  });

  it("still offers a hidden pillar that is NOT usage-gated", () => {
    pillarState.hidden = new Set(["events"]);
    activationState.usageDormantPillars = new Set();
    renderDiscovery();
    expect(screen.getByLabelText(/pillarLabelEvents/)).toBeInTheDocument();
  });
});

describe("ModulesPage — the Funktioner switch list", () => {
  const switchNamed = (key) => screen.queryByRole("switch", { name: new RegExp(key) });

  it("hides the switch for a KNOWN-dormant usage-gated pillar", async () => {
    activationState.usageKnownDormant = EVENTS();
    activationState.usageDormantPillars = EVENTS();
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await waitFor(() => expect(switchNamed("pillarLabelReservations")).toBeInTheDocument());
    expect(switchNamed("pillarLabelEvents")).not.toBeInTheDocument();
    // The other four are untouched.
    for (const key of ["pillarLabelReservations", "pillarLabelInventory", "pillarLabelStaff", "pillarLabelInsights"]) {
      expect(switchNamed(key)).toBeInTheDocument();
    }
  });

  it("does NOT remove the row while the answer is merely loading", async () => {
    // usageDormantPillars says hide (the NAV default while loading) but
    // usageKnownDormant is empty — nothing may move under the owner's finger.
    activationState.usageDormantPillars = EVENTS();
    activationState.usageKnownDormant = new Set();
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await waitFor(() => expect(switchNamed("pillarLabelEvents")).toBeInTheDocument());
  });
});

describe("OnboardingPage — the preset card after the gate", () => {
  // The suggested OFF-lists the backend now returns (services/pillars.py).
  const PRESETS = {
    restaurant: [],
    cafe: ["insights"],
    salon: [],
    service: [],
    general: [],
    takeaway: ["reservations", "inventory", "insights"],
  };

  it("never renders a chip for a usage-gated pillar", () => {
    for (const [type, off] of Object.entries(PRESETS)) {
      const { onPillars, offPillars } = presetChipLists(new Set(off));
      const ids = [...onPillars, ...offPillars].map((p) => p.id);
      expect(ids, type).not.toContain("events");
      expect(ids, type).toContain("reservations");
    }
  });

  it.each(["restaurant", "salon", "service", "general"])(
    "%s → no card (the preset hides nothing once Events is out of the catalog)",
    (type) => {
      const { onPillars, offPillars } = presetChipLists(new Set(PRESETS[type]));
      expect(presetCardIsEmpty(onPillars, offPillars)).toBe(true);
    },
  );

  it("cafe → the card still shows, with Insights as the only add", () => {
    const { onPillars, offPillars } = presetChipLists(new Set(PRESETS.cafe));
    expect(presetCardIsEmpty(onPillars, offPillars)).toBe(false);
    expect(offPillars.map((p) => p.id)).toEqual(["insights"]);
    expect(onPillars.map((p) => p.id)).toEqual(["reservations", "inventory", "staff"]);
  });

  it("takeaway → the card shows with its three adds", () => {
    const { onPillars, offPillars } = presetChipLists(new Set(PRESETS.takeaway));
    expect(presetCardIsEmpty(onPillars, offPillars)).toBe(false);
    expect(offPillars.map((p) => p.id).sort()).toEqual(["insights", "inventory", "reservations"]);
    expect(onPillars.map((p) => p.id)).toEqual(["staff"]);
  });

  it("a stale 'events' in a suggestion can never resurrect the chip", () => {
    // Defence in depth: even if a stale backend (or a cached response) still
    // suggests events, it is not in the catalog, so no chip and no card.
    const { onPillars, offPillars } = presetChipLists(new Set(["events"]));
    expect([...onPillars, ...offPillars].map((p) => p.id)).not.toContain("events");
    expect(presetCardIsEmpty(onPillars, offPillars)).toBe(true);
  });
});
