/**
 * Egenkontrol on the I dag rail (the Nov 2026 merge of Egenkontrol R1a/R1b
 * with the I dag redesign) — the real Layout, not the manifest alone:
 *
 *   • a café owner's rail shows "Egenkontrol" in Administration, right after
 *     Lager — an explicit place, not the collapsed "Mere" it would default to;
 *   • its count (missing readings + open deviations, GET /egenkontrol/status)
 *     is drawn in the rail's own badge shape, amber for a missing reading and
 *     red once a deviation is open (the tones I dag's "Kræver dig" gives the
 *     same server finding); nothing at 0;
 *   • the owner app still has ONE "I dag" (the Today page), and a salon's
 *     rail has no Egenkontrol row at all.
 *
 * Mocks follow LayoutSidebar.shell.test.jsx (t() → the key).
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.rail
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const net = vi.hoisted(() => ({ status: null }));
vi.mock("../services/api", () => ({
  default: {
    get: vi.fn((url) => (url === "/egenkontrol/status"
      ? Promise.resolve({ data: net.status })
      : Promise.resolve({ data: { modules: [] } }))),
    put: vi.fn(),
    post: vi.fn(),
  },
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [{ code: "da", short: "DK" }] }),
}));
const auth = vi.hoisted(() => ({ type: "cafe" }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, business_type: auth.type, role: "owner", business_name: "Test", currency: "DKK" },
    logout: vi.fn(),
    loading: false,
  }),
}));
vi.mock("../components/BranchSelector", () => ({
  default: () => null,
  useBranch: () => ({ branchType: null, businessTypes: [auth.type] }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: new Set(), isReady: true, setPillarHidden: vi.fn() }),
}));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({
    activatedPillars: new Set(["inventory", "reservations", "events", "staff"]),
    isActivated: () => true,
    usageDormantPillars: new Set(),
    usageKnownDormant: new Set(),
    isInScope: false,
    activationEnabled: false,
    isReady: true,
    refresh: vi.fn(),
  }),
}));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false }) }));
vi.mock("../hooks/useDarkMode", () => ({ useDarkMode: () => [false, vi.fn()] }));
vi.mock("../hooks/useRouteHistory", () => ({
  useRouteHistory: () => ({ history: [] }),
  useRouteHistoryRecorder: () => {},
}));
vi.mock("../hooks/useAppLifecycle", () => ({ useAppLifecycle: () => {} }));
vi.mock("../hooks/useKeyboardAvoidance", () => ({ useKeyboardAvoidance: () => {} }));
vi.mock("../hooks/useEventLog", () => ({ usePageTracking: () => {} }));
vi.mock("../hooks/useNavBadges", () => ({ useNavBadges: () => ({}) }));
vi.mock("../utils/statusBar", () => ({ syncStatusBar: () => {} }));
vi.mock("../components/NotificationCenter", () => ({ default: () => null }));
vi.mock("../components/TrialChip", () => ({ default: () => null }));
vi.mock("../components/DeviceShareChip", () => ({ default: () => null }));
vi.mock("../components/QuickAdd", () => ({ default: () => null }));
vi.mock("../components/BonBoxAgent", () => ({ default: () => null }));
vi.mock("../components/SupportChip", () => ({ default: () => null }));
vi.mock("../components/SmartLanguageToast", () => ({ default: () => null }));
vi.mock("../components/AccountantViewBanner", () => ({ default: () => null }));
vi.mock("../components/SoftErrorBanner", () => ({ default: () => null }));
vi.mock("../components/InstallAppPrompt", () => ({ default: () => null }));
vi.mock("../components/GlobalSearchModal", () => ({ default: () => null }));

import Layout from "../components/Layout";
import { __resetEgenkontrolStatus } from "../components/egenkontrol/useEgenkontrolStatus";

const rail = () => document.getElementById("primary-navigation");
const railHrefs = () => Array.from(rail().querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Layout />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.type = "cafe";
  net.status = null;
  __resetEgenkontrolStatus();
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true, writable: true });
  try { localStorage.clear(); } catch { /* stubbed storage */ }
});

describe("Egenkontrol on the I dag rail", () => {
  it("sits in Administration right after Lager, never under the collapsed Mere", () => {
    renderShell();
    const hrefs = railHrefs();
    expect(hrefs).toContain("/egenkontrol");
    expect(hrefs.indexOf("/egenkontrol")).toBe(hrefs.indexOf("/inventory") + 1);
    // Mere starts closed; the row is visible without opening it.
    expect(screen.getByText("navEgenkontrol")).toBeInTheDocument();
  });

  it("draws the missing readings in the rail's badge shape — amber for a missing reading", async () => {
    net.status = { missing_now: 2, open_deviations: 0 };
    renderShell();
    const badge = await screen.findByTestId("ek-nav-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge.className).toContain("td-badge");
    expect(badge.className).toContain("b-warn");
    expect(badge.closest("a").getAttribute("href")).toBe("/egenkontrol");
  });

  it("turns red once a deviation is open", async () => {
    net.status = { missing_now: 1, open_deviations: 1 };
    renderShell();
    const badge = await screen.findByTestId("ek-nav-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge.className).toContain("b-urgent");
  });

  it("says nothing at 0", async () => {
    net.status = { missing_now: 0, open_deviations: 0 };
    renderShell();
    // let the status poll answer
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("ek-nav-badge")).toBeNull();
  });

  it("keeps ONE I dag in the owner app", () => {
    renderShell();
    // the rail's row and the phone tab bar's first tab — both the Today page
    const iDag = screen.getAllByText("navTodayHome").map((el) => el.closest("a")?.getAttribute("href"));
    expect(new Set(iDag)).toEqual(new Set(["/dashboard"]));
    expect(Array.from(rail().querySelectorAll("a")).filter((a) => /navTodayHome/.test(a.textContent))).toHaveLength(1);
    const ek = screen.getByText("navEgenkontrol").closest("a");
    expect(ek.textContent).not.toMatch(/navTodayHome/);
  });

  it("is not on a salon's rail", () => {
    auth.type = "salon";
    renderShell();
    expect(railHrefs()).not.toContain("/egenkontrol");
  });
});
