/**
 * Phone R1 (PHONE-OWNER-PLAN 5.2/5.3) — the owner shell, rendered: while the
 * owner Layout is mounted, html carries data-owner-shell and Vagtplan's press
 * controller runs ONCE (one pointerdown listener, from Layout); when it
 * unmounts, both are gone. The phone's tab bar is the floating dock.
 *
 * Mocks: the same set quickAddReach.test.jsx renders Layout with.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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
vi.mock("../components/QuickAdd", () => ({ default: () => null }));
vi.mock("../components/BonBoxAgent", () => ({ default: () => null }));
vi.mock("../components/SupportChip", () => ({ default: () => null }));
vi.mock("../components/SmartLanguageToast", () => ({ default: () => null }));
vi.mock("../components/AccountantViewBanner", () => ({ default: () => null }));
vi.mock("../components/SoftErrorBanner", () => ({ default: () => null }));
vi.mock("../components/InstallAppPrompt", () => ({ default: () => null }));
vi.mock("../components/GlobalSearchModal", () => ({ default: () => null }));

import Layout from "../components/Layout";

afterEach(() => cleanup());

function touch(el, type) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerType: "touch", isPrimary: true, clientX: 5, clientY: 5 });
  el.dispatchEvent(e);
}

describe("the owner shell while Layout is mounted", () => {
  it("sets html[data-owner-shell], installs the press once, and takes both away on unmount", () => {
    const add = vi.spyOn(document, "addEventListener");
    const { unmount } = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Layout />
      </MemoryRouter>,
    );
    const html = document.documentElement;
    expect(html.hasAttribute("data-owner-shell")).toBe(true);
    const presses = add.mock.calls.filter(([type, , o]) => type === "pointerdown" && o && o.capture);
    expect(presses).toHaveLength(1);
    add.mockRestore();

    // A finger presses from data-pressed (never :active).
    const menu = document.querySelector('button[aria-controls="primary-navigation"]');
    touch(menu, "pointerdown");
    expect(html.dataset.modality).toBe("touch");
    expect(menu.hasAttribute("data-pressed")).toBe(true);
    touch(menu, "pointerup");
    expect(menu.hasAttribute("data-pressed")).toBe(false);

    // The phone's tab bar is the floating dock, at the old bar's layer (z-50).
    const dock = document.querySelector('nav[data-owner-dock]');
    expect(dock).not.toBeNull();
    expect(dock.className).toMatch(/(^|\s)z-50(\s|$)/);
    expect(dock.className).toMatch(/(^|\s)md:hidden(\s|$)/);

    unmount();
    expect(html.hasAttribute("data-owner-shell")).toBe(false);
    expect(html.dataset.modality).toBeUndefined();
  });
});
