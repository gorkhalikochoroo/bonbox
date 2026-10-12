/**
 * Mobile walk, 12 Oct 2026 — each onboarding step opens at its top. On a
 * phone the owner taps "Næste" at the bottom of a long step, and steps 3 and
 * 4 opened where the previous one ended, below their own headings. The jump
 * is immediate (html's smooth scroll is lifted for it: utils/jumpToTop).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({ data: { ok: true } })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  navigate: vi.fn(),
}));
vi.mock("../services/api", () => ({ default: { get: h.get, post: h.post, put: h.put, patch: h.patch } }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u1", business_name: "Café Solsikke", business_type: "cafe", currency: "DKK", role: "owner", onboarding_completed_at: null },
    refreshUser: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: "da", t: (k, fb) => (typeof fb === "string" ? fb : k) }),
}));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ({ plan: "trial", isReady: true, hasFeature: () => false }) }));
vi.mock("react-router-dom", async (orig) => ({ ...(await orig()), useNavigate: () => h.navigate }));

import OnboardingPage from "../pages/OnboardingPage";

let scrollTo;
let behaviourDuringJump;
beforeEach(() => {
  localStorage.clear();
  h.get.mockReset();
  h.get.mockImplementation((url) => (url === "/pillars/preset"
    ? Promise.resolve({ data: { suggested: [] } })
    : Promise.resolve({ data: {} })));
  // The owner is 900 px down the step when they tap its button.
  Object.defineProperty(window, "scrollY", { value: 900, configurable: true, writable: true });
  Object.defineProperty(window, "pageYOffset", { value: 900, configurable: true, writable: true });
  behaviourDuringJump = [];
  document.documentElement.style.scrollBehavior = "smooth";
  scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {
    behaviourDuringJump.push(document.documentElement.style.scrollBehavior);
  });
});
afterEach(() => {
  scrollTo.mockRestore();
  document.documentElement.style.scrollBehavior = "";
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true, writable: true });
  Object.defineProperty(window, "pageYOffset", { value: 0, configurable: true, writable: true });
});

describe("each onboarding step opens at its top", () => {
  it("no jump on arrival (the route already put the page at the top)", async () => {
    await act(async () => { render(<MemoryRouter><OnboardingPage /></MemoryRouter>); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("Kom i gang → step 2, Næste → step 3, Næste → step 4: each time the page jumps to 0,0 at once", async () => {
    await act(async () => { render(<MemoryRouter><OnboardingPage /></MemoryRouter>); });
    await act(async () => { fireEvent.click(screen.getByText("onbStep1Cta")); });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    await screen.findByText("onbStep3Title");
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    await screen.findByText("onbStep4Title");
    expect(scrollTo).toHaveBeenCalledTimes(3);
    // immediate, not html's smooth scroll — and the smooth setting is back after
    expect(behaviourDuringJump).toEqual(["auto", "auto", "auto"]);
    expect(document.documentElement.style.scrollBehavior).toBe("smooth");
  });

  it("Tilbage lands at the top of the step too", async () => {
    await act(async () => { render(<MemoryRouter><OnboardingPage /></MemoryRouter>); });
    await act(async () => { fireEvent.click(screen.getByText("onbStep1Cta")); });
    await act(async () => { fireEvent.click(screen.getByText("onbBack")); });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
