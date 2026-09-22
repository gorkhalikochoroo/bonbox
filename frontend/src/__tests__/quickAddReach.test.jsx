/**
 * The phone tab bar's centre "+" must always resolve to SOMETHING.
 *
 * It opened the QuickAdd sheet with
 *
 *     document.querySelector("[data-quickadd-toggle]")?.click();
 *
 * and Layout unmounted QuickAdd wholesale on /subscription so its floating FAB
 * would not compete with the plan cards. The optional chaining then turned a
 * missing sheet into silence: on the route an owner reaches from the rail's own
 * "Abonnement & betaling" row, the biggest button on the phone did nothing at
 * all. A dead CTA is this repo's top trust defect, and nothing in a build, an
 * eslint pass or an i18n check can see it.
 *
 * One route, not two. The suppression list also named /pricing, which since the
 * C7 collapse is a `<Navigate>` redirect and never a rendered surface — testing
 * it here would have asserted a page that is not there (MemoryRouter renders
 * Layout at any path you hand it, redirect or not).
 *
 * Two halves, because the defect had two:
 *   1. REACH — Layout must mount the sheet on every route, including those two.
 *   2. NEVER SILENT — and if a trigger is ever missing anyway (a lazy chunk
 *      still in flight, a future refactor), the button must do something the
 *      owner can SEE rather than nothing.
 *
 * Half 2 is asserted against the component in isolation with no QuickAdd in
 * the DOM at all, which is the only honest way to test "what happens when it
 * is not there".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { modules: [] } }), put: vi.fn(), post: vi.fn() },
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [{ code: "da", short: "DK" }] }),
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, business_type: "cafe", role: "owner", business_name: "Café Test", currency: "DKK" },
    logout: vi.fn(),
    loading: false,
  }),
}));
vi.mock("../components/BranchSelector", () => ({
  default: () => null,
  useBranch: () => ({ branchType: null, businessTypes: ["cafe"] }),
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
vi.mock("../hooks/useEventLog", () => ({ usePageTracking: () => {}, trackEvent: () => {} }));
vi.mock("../utils/statusBar", () => ({ syncStatusBar: () => {} }));
vi.mock("../components/NotificationCenter", () => ({ default: () => null }));
vi.mock("../components/TrialChip", () => ({ default: () => null }));
vi.mock("../components/DeviceShareChip", () => ({ default: () => null }));

/* QuickAdd / BonBoxAgent / SupportChip stand in for the real (heavy, lazy)
   components. Each records that it MOUNTED — which is the thing under test.
   The assertion is about Layout's decision to render them, never about what
   the stand-in draws. */
const mounted = { quickAdd: 0, agent: 0, support: 0 };
vi.mock("../components/QuickAdd", () => ({
  default: () => { mounted.quickAdd += 1; return null; },
}));
vi.mock("../components/BonBoxAgent", () => ({
  default: () => { mounted.agent += 1; return null; },
}));
vi.mock("../components/SupportChip", () => ({
  default: () => { mounted.support += 1; return null; },
}));
vi.mock("../components/SmartLanguageToast", () => ({ default: () => null }));
vi.mock("../components/AccountantViewBanner", () => ({ default: () => null }));
vi.mock("../components/SoftErrorBanner", () => ({ default: () => null }));
vi.mock("../components/InstallAppPrompt", () => ({ default: () => null }));
vi.mock("../components/GlobalSearchModal", () => ({ default: () => null }));

import Layout from "../components/Layout";
import MobileBottomNav from "../components/MobileBottomNav";

beforeEach(() => {
  mounted.quickAdd = 0;
  mounted.agent = 0;
  mounted.support = 0;
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true, writable: true });
  try { localStorage.clear(); } catch { /* stubbed storage */ }
});
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true, writable: true });
});

/* Renders without `await act(...)` on purpose — same reasoning as
   LayoutSidebar.shell.test.jsx: it deadlocks against Layout's seven lazy
   children under React 19 + vitest. The callers poll with vi.waitFor instead,
   because the thing under test (did Layout render the widget at all?) is only
   settled once the lazy chunk resolves. */
/* Reports the current path into the DOM rather than into a closure variable:
   the React Compiler lint rules (rightly) refuse a component that reassigns
   something outside itself, and the DOM is the honest place to read it from. */
function Probe() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}
function whereAreWe() {
  return screen.getByTestId("where").textContent;
}

function renderShell(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Layout />
    </MemoryRouter>,
  );
}

describe("the sheet the centre + opens is mounted on every route", () => {
  for (const path of ["/dashboard", "/subscription"]) {
    it(`mounts QuickAdd on ${path}`, async () => {
      renderShell(path);
      // The floating widgets are React.lazy behind a null Suspense fallback,
      // so "mounted" is settled a tick after the first paint, not during it.
      await vi.waitFor(() => expect(mounted.quickAdd).toBeGreaterThan(0));
    });
  }

  it("mounts BonBoxAgent on /subscription too — the header ✨ clicks its trigger", async () => {
    renderShell("/subscription");
    await vi.waitFor(() => expect(mounted.agent).toBeGreaterThan(0));
  });

  it("mounts SupportChip on /subscription — both Help entries are only its listener", async () => {
    // SupportChip has no button of its own; suppressing it did nothing but
    // silence the header "?" and the sidebar's Help & feedback row.
    renderShell("/subscription");
    await vi.waitFor(() => expect(mounted.support).toBeGreaterThan(0));
  });
});

describe("the header ✨ is never a no-op either", () => {
  it("goes somewhere visible when the assistant's trigger is not there", () => {
    // BonBoxAgent is mocked to render nothing, which is exactly the DOM a lazy
    // chunk still in flight produces — the one state this fallback exists for.
    renderShell("/dashboard");
    expect(document.querySelector("[data-bonbox-agent-toggle]")).toBeNull();

    fireEvent.click(screen.getByLabelText("openBonBoxAi"));

    // It used to dispatch bonbox:open-support here. That event's only listener
    // is SupportChip — a lazy sibling of the component we just failed to find —
    // so the fallback was provably silent in the only case it ran. A fallback
    // may not depend on a sibling of the thing that was missing.
    expect(whereAreWe()).not.toBe("/dashboard");
    expect(whereAreWe()).toBe("/feedback");
  });
});

describe("the centre + is never a no-op", () => {
  /* Render the bar alone (no QuickAdd anywhere) and report where we end up. */
  function renderBareBar() {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Probe />
        <Routes>
          <Route path="*" element={<MobileBottomNav />} />
        </Routes>
      </MemoryRouter>,
    );
    return () => screen.getByTestId("where").textContent;
  }

  it("navigates somewhere useful when no QuickAdd trigger exists", () => {
    expect(document.querySelector("[data-quickadd-toggle]")).toBeNull(); // the premise
    const where = renderBareBar();

    fireEvent.click(screen.getByRole("button", { name: "add" }));

    // The defect: `?.click()` here left the owner exactly where they were,
    // with no sheet and no feedback. Anything visible beats that.
    expect(where()).not.toBe("/dashboard");
    expect(where()).toBe("/sales");
  });

  it("opens the sheet — and does NOT navigate — when the trigger is there", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-quickadd-toggle", "");
    const opened = vi.fn();
    trigger.addEventListener("click", opened);
    document.body.appendChild(trigger);

    // try/finally, not a trailing remove(): RTL's auto-cleanup only unmounts
    // its own container, so on a failing assertion this node would outlive the
    // test and hand the next one a [data-quickadd-toggle] it never created —
    // turning one real failure into a cascade in the sibling test whose whole
    // premise is that no trigger exists.
    try {
      const where = renderBareBar();
      fireEvent.click(screen.getByRole("button", { name: "add" }));

      expect(opened).toHaveBeenCalledTimes(1);
      expect(where()).toBe("/dashboard"); // the sheet is not a route change
    } finally {
      trigger.remove();
    }
  });
});
