/**
 * The owner shell's STRUCTURE — the four sidebar defects that a build, an
 * eslint pass and an i18n check all report as green:
 *
 *   • the phone drawer stacking UNDER the bottom tab bar (Log ud uncoverable)
 *   • ~28 links of an off-canvas rail sitting in the tab order
 *   • two <h1> claiming the document heading on every page
 *   • a deliberate group collapse being undone by the next navigation
 *
 * None of these are visible to a snapshot either, so they are asserted as
 * relationships (this z above that z; this attribute present when that state
 * holds) rather than as literal class strings.
 *
 * Everything the shell talks to is mocked down to an inert shape — this file
 * is about the shell's own geometry, not about what the nav is filtered to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { modules: [] } }), put: vi.fn(), post: vi.fn() },
}));

// t() → the key, so assertions read against label keys.
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
vi.mock("../hooks/useEventLog", () => ({ usePageTracking: () => {} }));
vi.mock("../utils/statusBar", () => ({ syncStatusBar: () => {} }));
vi.mock("../components/NotificationCenter", () => ({ default: () => null }));
vi.mock("../components/TrialChip", () => ({ default: () => null }));
vi.mock("../components/DeviceShareChip", () => ({ default: () => null }));
// Lazy children — mocked so Suspense resolves to something inert instead of
// pulling half the app (and its network calls) into this test.
vi.mock("../components/QuickAdd", () => ({ default: () => null }));
vi.mock("../components/BonBoxAgent", () => ({ default: () => null }));
vi.mock("../components/SupportChip", () => ({ default: () => null }));
vi.mock("../components/SmartLanguageToast", () => ({ default: () => null }));
vi.mock("../components/AccountantViewBanner", () => ({ default: () => null }));
vi.mock("../components/SoftErrorBanner", () => ({ default: () => null }));
vi.mock("../components/InstallAppPrompt", () => ({ default: () => null }));
vi.mock("../components/GlobalSearchModal", () => ({ default: () => null }));

import Layout from "../components/Layout";

const PHONE = 375;
const DESKTOP = 1280;

function setViewport(width) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

/** The numeric z-index a Tailwind class list declares — `z-50` or `z-[55]`. */
function zOf(el) {
  const m = (el?.getAttribute("class") || "").match(/(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/);
  return m ? Number(m[1]) : 0;
}

const aside = () => document.getElementById("primary-navigation");
const bottomNav = () => document.querySelector('nav[aria-label="bottomNav"]');
const scrim = () => Array.from(document.querySelectorAll("div")).find(
  (d) => typeof d.className === "string"
    && d.className.includes("inset-0")
    && d.className.includes("bg-black/40"),
);

/**
 * Render the shell at a route. Deliberately SYNCHRONOUS: every assertion here
 * is about markup the first paint already decides, and Layout's one async
 * dependency (/modules) is mocked empty and gates none of the destinations
 * asserted below. `await act(...)` is avoided on purpose — it deadlocks
 * against Layout's seven React.lazy children under React 19 + vitest.
 */
function renderShell(path = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Layout />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setViewport(DESKTOP);
  try { localStorage.clear(); } catch { /* stubbed storage */ }
});
afterEach(() => { setViewport(DESKTOP); });

describe("phone drawer stacking", () => {
  it("puts the open drawer ABOVE the tab bar, with a scrim that covers it too", () => {
    setViewport(PHONE);
    renderShell();
    fireEvent.click(screen.getByLabelText("openMenu"));

    // The defect: both were z-50 and MobileBottomNav renders LATER, so it won
    // the tie and sat on top of the bottom of the drawer — Log ud included.
    expect(zOf(aside())).toBeGreaterThan(zOf(bottomNav()));
    // A scrim that leaves the tab bar bright and tappable is not a scrim.
    expect(zOf(scrim())).toBeGreaterThan(zOf(bottomNav()));
    // ...and the drawer is still above its own scrim.
    expect(zOf(aside())).toBeGreaterThan(zOf(scrim()));
  });

  it("drops the rail back to the shared layer when the drawer is closed", () => {
    setViewport(PHONE);
    renderShell();
    // The DESKTOP rail must not be elevated: page-level modals render later at
    // z-50 and would slide underneath a permanently-raised sidebar.
    expect(zOf(aside())).toBe(50);
  });
});

describe("off-canvas rail is out of the tab order", () => {
  it("is inert while the phone drawer is closed", () => {
    setViewport(PHONE);
    renderShell();
    expect(aside()).toHaveAttribute("inert");
    expect(aside().style.visibility).toBe("hidden"); // no-inert fallback
  });

  it("is NOT inert while the phone drawer is open", () => {
    setViewport(PHONE);
    renderShell();
    fireEvent.click(screen.getByLabelText("openMenu"));
    expect(aside()).not.toHaveAttribute("inert");
    expect(aside().style.visibility).toBe("visible");
  });

  it("is inert when the owner has collapsed the DESKTOP rail", () => {
    localStorage.setItem("bonbox_sidebar_hidden", "1");
    setViewport(DESKTOP);
    renderShell();
    expect(aside()).toHaveAttribute("inert");
  });

  it("is live on desktop with the rail shown", () => {
    localStorage.setItem("bonbox_sidebar_hidden", "0");
    setViewport(DESKTOP);
    renderShell();
    expect(aside()).not.toHaveAttribute("inert");
  });
});

describe("drawer focus choreography", () => {
  it("moves focus into the drawer on open and back to the menu button on close", () => {
    setViewport(PHONE);
    renderShell();
    const menuButton = screen.getByLabelText("openMenu");

    fireEvent.click(menuButton);
    expect(document.activeElement).toBe(screen.getByLabelText("closeMenu"));

    fireEvent.click(screen.getByLabelText("closeMenu"));
    // Without this the browser drops focus on <body> the moment `inert`
    // lands, and the keyboard user restarts from the top of the document.
    expect(document.activeElement).toBe(menuButton);
  });
});

describe("document headings", () => {
  it("ships exactly one <h1> from the shell, at both breakpoints", () => {
    setViewport(PHONE);
    const { unmount } = renderShell();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    unmount();

    setViewport(DESKTOP);
    renderShell();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });
});

describe("group collapse survives navigation", () => {
  it("keeps a collapsed group collapsed when the owner opens a page inside it", () => {
    const { unmount } = renderShell("/dashboard");
    // Money is open by default, so its children are on screen.
    expect(screen.getByText("cashBook")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /navMoney/ }));
    expect(screen.queryByText("cashBook")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("bonbox_nav_groups")).money).toBe(false);
    unmount();

    // Re-enter the app ON a page inside that very group — the case the old
    // auto-expand effect turned into a forced re-open, and then persisted.
    renderShell("/cashbook");
    expect(screen.queryByText("cashBook")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("bonbox_nav_groups")).money).toBe(false);
  });

  it("still reveals the active group for an owner who has never touched it", () => {
    renderShell("/cashbook");
    expect(screen.getByText("cashBook")).toBeInTheDocument();
  });
});

/* ── The keyboard's view of the rail ──────────────────────────────────── */

describe("the rail is visible to a keyboard", () => {
  /** Every focusable control INSIDE the rail (drawer open so it isn't inert). */
  function railControls() {
    const rail = aside();
    return Array.from(rail.querySelectorAll("a[href], button, select"));
  }

  it("puts a focus ring on every control in the rail, not just the chrome", () => {
    renderShell("/dashboard");
    const controls = railControls();
    // Guards the guard: if the rail ever renders empty this test must fail,
    // not pass vacuously on zero controls.
    expect(controls.length).toBeGreaterThan(15);

    const ringless = controls
      .filter((el) => !(el.getAttribute("class") || "").includes("focus-visible:ring-"))
      .map((el) => el.textContent.trim() || el.getAttribute("aria-label") || el.tagName);

    // Layout shipped five focus-visible declarations and all five were on
    // chrome (skip link, hamburger, hide, close ×, floating re-open). The ~28
    // nav rows, the group headers and the whole footer fell back to the
    // browser default outline, which on a white rail beside a gray-100 hover
    // is close to invisible.
    expect(ringless, `rail controls with no focus ring: ${ringless.join(", ")}`).toEqual([]);
  });

  it("makes each group header announce whether it is open", () => {
    renderShell("/dashboard");
    const headers = Array.from(aside().querySelectorAll("button"))
      .filter((b) => /^(navMoney|navStock|navReportsMoms|navSettings)$/.test(b.textContent.trim()));
    expect(headers.length).toBeGreaterThan(2);

    // The chevron rotates; a screen reader cannot see a rotation.
    for (const h of headers) expect(h).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(headers[0]);
    expect(headers[0]).toHaveAttribute("aria-expanded", "false");
  });
});

/* ── The rail does not move itself ────────────────────────────────────── */

describe("only the owner collapses the rail", () => {
  it("leaves a rail the owner collapsed alone when the viewport changes", () => {
    // An EXPLICIT preference, made by clicking. This half always held — the
    // toggle writes bonbox_sidebar_hidden and even the old resize handler
    // returned early on a stored value — and it is pinned here because it is
    // the contract the rest of this fix must not break.
    setViewport(1280);
    renderShell("/dashboard");
    expect(aside()).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByLabelText("hideSidebar"));
    expect(aside()).toHaveAttribute("inert");

    // Widening must not hand it back unasked, any more than narrowing may
    // take it away: the click is the whole of the rule, in both directions.
    setViewport(1600);
    fireEvent(window, new Event("resize"));
    expect(aside()).toHaveAttribute("inert");
  });

  it("does not collapse on resize for an owner who has made no choice", () => {
    // No stored preference at all — the case the resize handler really did
    // own, and the one an owner actually hits: narrow a window mid-session and
    // the rail was yanked off-canvas without a single click, into the
    // 768-1023px band where the mobile top bar and the bottom tab bar are BOTH
    // md:hidden and one floating button is the whole of navigation.
    setViewport(1280);
    renderShell("/dashboard");
    expect(aside()).not.toHaveAttribute("inert");

    setViewport(900);
    fireEvent(window, new Event("resize"));
    expect(aside()).not.toHaveAttribute("inert");

    setViewport(820);
    fireEvent(window, new Event("orientationchange"));
    expect(aside()).not.toHaveAttribute("inert");
  });

  it("opens at first paint in the 768-1023px band, where nothing else navigates", () => {
    // The old first-paint guess (<1024px) could only ever apply here: the flag
    // reaches the DOM through `md:` classes alone, so below 768 it is inert.
    // Collapsing by default in this band left one unlabelled 44px button as the
    // owner's entire navigation, unasked.
    setViewport(820);
    renderShell("/dashboard");
    expect(aside()).not.toHaveAttribute("inert");
  });
});
