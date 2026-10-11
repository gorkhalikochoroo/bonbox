/**
 * Push 6 (PQ-17, B1) — /register no longer asks the business type, so the
 * wizard does: an account whose type nobody chose starts with no tile
 * selected, and Næste asks for one instead of quietly saving "restaurant".
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({ data: { ok: true } })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  navigate: vi.fn(),
  user: null,
}));
vi.mock("../services/api", () => ({ default: { get: h.get, post: h.post, put: h.put, patch: h.patch } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user, refreshUser: vi.fn(() => Promise.resolve()) }) }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "da",
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ({ plan: "trial", isReady: true, hasFeature: () => false }) }));
vi.mock("react-router-dom", async (orig) => ({ ...(await orig()), useNavigate: () => h.navigate }));

import OnboardingPage from "../pages/OnboardingPage";

const owner = (business_type) => ({
  id: "u1", business_name: "Café Solsikke", business_type, currency: "DKK", role: "owner", onboarding_completed_at: null,
});

beforeEach(() => {
  localStorage.clear();
  h.get.mockReset();
  h.get.mockImplementation((url) => (url === "/pillars/preset"
    ? Promise.resolve({ data: { suggested: [] } })
    : Promise.resolve({ data: {} })));
  h.put.mockClear();
  h.patch.mockClear();
  h.post.mockClear();
  h.navigate.mockClear();
});

async function toStep2() {
  render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
  fireEvent.click(screen.getByText("onbStep1Cta"));
  await screen.findByRole("radiogroup", { name: "onbStep2BranchLabel" });
}
const checked = () => screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");

describe("the wizard asks the type nobody chose", () => {
  it("Google / Apple / e-mail-link account (business_type ''): no tile selected, Næste blocked with suOnbPickType", async () => {
    h.user = owner("");
    await toStep2();
    expect(checked()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    const err = screen.getByText("suOnbPickType");
    expect(err.getAttribute("role")).toBe("alert");
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    // and nothing is suggested for a type that is not there yet
    expect(h.get.mock.calls.filter(([u]) => u === "/pillars/preset")).toHaveLength(0);
    // picking one clears the message and lets the owner on
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(screen.queryByText("suOnbPickType")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    expect(h.patch).toHaveBeenCalledWith("/auth/profile", expect.objectContaining({ business_type: expect.any(String) }));
  });

  it("a /register sign-up left on the server's default (unasked + restaurant): no tile selected either", async () => {
    h.user = owner("restaurant");
    localStorage.setItem("bonbox_type_unasked", "u1");
    await toStep2();
    expect(checked()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    expect(screen.getByText("suOnbPickType")).toBeTruthy();
  });

  it("the note is per account: another account's note changes nothing", async () => {
    h.user = owner("restaurant");
    localStorage.setItem("bonbox_type_unasked", "someone-else");
    await toStep2();
    expect(checked()).toHaveLength(1);
  });

  it("a chosen type is preselected as before", async () => {
    h.user = owner("cafe");
    await toStep2();
    expect(checked()).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    expect(screen.queryByText("suOnbPickType")).toBeNull();
  });

  it("Spring over og udforsk still works and clears the note (the owner keeps restaurant)", async () => {
    h.user = owner("restaurant");
    localStorage.setItem("bonbox_type_unasked", "u1");
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    await act(async () => { fireEvent.click(screen.getByText("onbSkipExplore")); });
    expect(h.post).toHaveBeenCalledWith("/auth/onboarding/complete");
    expect(h.patch).not.toHaveBeenCalled();
    expect(localStorage.getItem("bonbox_type_unasked")).toBeNull();
  });

  it("Skip, Tilbage and Næste are 44 px tap targets", async () => {
    h.user = owner("cafe");
    await toStep2();
    for (const label of ["onbSkipExplore", "onbBack", "onbNext"]) {
      expect(screen.getByText(label).closest("button").className, label).toMatch(/\bmin-h-11\b/);
    }
  });
});

describe("the first screen after sign-up meets the contrast bar (push 6 review)", () => {
  // White on emerald-600 (the old `accent` buttons) is 3.65:1 at 14 px/500 —
  // under AA's 4.5. The wizard's own design note says gray-900 primary
  // (17.7:1): the buttons now are. The 11 px lines read gray-600 (gray-400
  // was 2.51:1 on the gray-50 ground).
  it("'Kom i gang' and every step's Næste are the gray-900 primary, never emerald", async () => {
    h.user = owner("cafe");
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    const start = screen.getByText("onbStep1Cta").closest("button");
    expect(start.className).toMatch(/\bbg-gray-900\b/);
    expect(start.className).not.toMatch(/emerald/);
    expect(screen.getByText("onbStep1Reassure").className).toMatch(/\btext-gray-600\b/);
    fireEvent.click(start);
    await screen.findByRole("radiogroup", { name: "onbStep2BranchLabel" });
    const next = screen.getByText("onbNext").closest("button");
    expect(next.className).toMatch(/\bbg-gray-900\b/);
    expect(next.className).not.toMatch(/emerald/);
  });

  it("no wizard text is gray-400 on the light ground (only aria-hidden icons may be)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../pages/OnboardingPage.jsx"), "utf8");
    const lines = src.split("\n").filter((l) => /(^|[\s"'])text-gray-400(?=[\s"'])/.test(l) && !/aria-hidden="true"/.test(l));
    expect(lines).toEqual([]);
    expect(src).not.toMatch(/variant="accent"/);
  });
});
