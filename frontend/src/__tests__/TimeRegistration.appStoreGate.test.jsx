/**
 * Tidsregistrering, tier-locked, on the NATIVE iOS build.
 *
 * This exists because a hand-rolled upgrade card shipped here. It named the
 * tier ("Legal time-registration — Starter+", "…on Starter and Pro") and
 * rendered <Link to="/subscription">, and it was reachable in the iOS owner
 * app by a Free-tier owner tapping one pill — the tab row carries no native
 * gate. It was confirmed present in the built bundle, not just in source.
 *
 * utils/platform.js says it plainly: "a single missed CTA on iOS = another
 * rejection." UpgradeNudge.jsx:141 is the guard the rest of the app uses
 * (`if (isNativeApp()) return null;`), and 32 files go through it — including
 * this tab's own sibling, StaffPayrollPage.
 *
 * So these assert the PROPERTY, not the markup: on native, this screen must
 * carry no tier name, no price, and no route to /subscription. Web keeps the
 * full nudge, because that revenue surface is legitimate there.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a) } }));

// t() returns the fallback so assertions read the real shipped copy.
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (_k, fb) => fb ?? "", lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));

const isNativeApp = vi.fn();
vi.mock("../utils/platform", () => ({
  isNativeApp: (...a) => isNativeApp(...a),
  canPurchaseInApp: () => false,
  isIPad: () => false,
  platform: { isNative: false },
}));

vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ ready: true, hasFeature: () => false, tier: "free", plan: "free" }),
}));

const TimeRegistrationPage = (await import("../pages/TimeRegistrationPage")).default;

/** The server gates this feature; a 402 is what puts the page in `locked`. */
const lock = () => get.mockRejectedValue({ response: { status: 402 } });

const renderPage = () =>
  render(
    <MemoryRouter>
      <TimeRegistrationPage />
    </MemoryRouter>,
  );

describe("Tidsregistrering — tier lock and App Store 3.1.1", () => {
  beforeEach(() => {
    get.mockReset();
    isNativeApp.mockReset();
  });

  it("carries no purchase surface at all on native", async () => {
    isNativeApp.mockReturnValue(true);
    lock();
    const { container } = renderPage();

    // The locked state has to actually be reached, or this test proves nothing.
    await waitFor(() =>
      expect(screen.getByText(/Arbejdstidsloven/i)).toBeTruthy(),
    );

    // No route to the purchase page, by any element.
    expect(container.querySelector('a[href*="subscription"]')).toBeNull();
    // No tier naming and no price language.
    const text = container.textContent || "";
    expect(text).not.toMatch(/Starter/i);
    expect(text).not.toMatch(/\bPro\b/);
    expect(text).not.toMatch(/See plans/i);
    expect(text).not.toMatch(/kr\./);
  });

  it("still shows the upgrade route on web, where it is legitimate", async () => {
    isNativeApp.mockReturnValue(false);
    lock();
    const { container } = renderPage();

    await waitFor(() =>
      expect(container.querySelector('a[href*="subscription"]')).toBeTruthy(),
    );
  });

  it("does not render the locked branch when the server does not gate it", async () => {
    isNativeApp.mockReturnValue(true);
    get.mockResolvedValue({ data: { staff: [], totals: {} } });
    const { container } = renderPage();

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.textContent || "").not.toMatch(/does not have time registration/i);
  });
});
