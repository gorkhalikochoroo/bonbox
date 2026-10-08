/**
 * Danish first 15 minutes, item 3 — onboarding without demo traps.
 *
 *   • The revisor e-mail step says plainly that BonBox sends the revisor
 *     nothing automatically until the owner ticks it, and the tick is there,
 *     OFF by default, only usable with an address; what is saved is the tick.
 *   • The revisor invite (step 4) is optional and says so.
 *   • "Udforsk med eksempeldata" is the quiet secondary path and asks the
 *     server to keep the owner's own profile (POST /demo/seed?keep_profile).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({ data: { ok: true } })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  navigate: vi.fn(),
  features: new Set(["close_auto_email"]),
}));

vi.mock("../services/api", () => ({
  default: { get: h.get, post: h.post, put: h.put, patch: h.patch },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: "u1", business_name: "Café Solsikken", business_type: "cafe",
      currency: "DKK", role: "owner", onboarding_completed_at: null,
    },
    refreshUser: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "en",
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({
    plan: "trial", isReady: true, hasFeature: (f) => h.features.has(f),
  }),
}));
vi.mock("react-router-dom", async (orig) => {
  const mod = await orig();
  return { ...mod, useNavigate: () => h.navigate };
});

import OnboardingPage from "../pages/OnboardingPage";

beforeEach(() => {
  h.get.mockReset();
  h.get.mockImplementation((url) => {
    if (url === "/pillars/preset") return Promise.resolve({ data: { suggested: [] } });
    return Promise.resolve({ data: {} });
  });
  h.post.mockClear();
  h.put.mockClear();
  h.patch.mockClear();
  h.navigate.mockClear();
  h.features = new Set(["close_auto_email"]);
});

async function toStep3() {
  render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
  fireEvent.click(screen.getByText("onbStep1Cta"));
  await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
  await screen.findByTestId("onb-acct-no-mail");
}

async function toStep4() {
  await toStep3();
  await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
  await screen.findByTestId("onb-explore-sample");
}

const lastBusinessPut = () => {
  const calls = h.put.mock.calls.filter(([url]) => url === "/business");
  return calls[calls.length - 1]?.[1];
};

describe("step 3 — the revisor e-mail never mails on its own", () => {
  it("says so, and the tick is off and unusable without an address", async () => {
    await toStep3();
    expect(screen.getByTestId("onb-acct-no-mail").textContent)
      .toMatch(/won't send your revisor anything automatically until you tick/);
    const box = screen.getByTestId("onb-acct-auto-send");
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
  });

  it("an address without the tick is saved with auto-send OFF", async () => {
    await toStep3();
    fireEvent.change(document.getElementById("onb-acct-email"), { target: { value: "Revisor@Regnskab.dk" } });
    const box = screen.getByTestId("onb-acct-auto-send");
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(false);
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    expect(lastBusinessPut()).toMatchObject({
      accountant_email: "revisor@regnskab.dk",
      accountant_auto_send: false,
    });
  });

  it("the tick, explained with the address, is what is saved", async () => {
    await toStep3();
    fireEvent.change(document.getElementById("onb-acct-email"), { target: { value: "revisor@regnskab.dk" } });
    fireEvent.click(screen.getByTestId("onb-acct-auto-send"));
    expect(screen.getByText(/e-mails that day's kasserapport as a PDF to revisor@regnskab.dk/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    expect(lastBusinessPut()).toMatchObject({ accountant_auto_send: true });
  });

  it("emptying the address takes the tick with it", async () => {
    await toStep3();
    const input = document.getElementById("onb-acct-email");
    fireEvent.change(input, { target: { value: "revisor@regnskab.dk" } });
    fireEvent.click(screen.getByTestId("onb-acct-auto-send"));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "ny@revisor.dk" } });
    expect(screen.getByTestId("onb-acct-auto-send").checked).toBe(false);
  });

  it("no address → no revisor fields sent at all (unchanged)", async () => {
    await toStep3();
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    const body = lastBusinessPut();
    expect(body).not.toHaveProperty("accountant_email");
    expect(body).not.toHaveProperty("accountant_auto_send");
  });

  it("a plan without the lock mail cannot tick it", async () => {
    h.features = new Set();
    await toStep3();
    fireEvent.change(document.getElementById("onb-acct-email"), { target: { value: "revisor@regnskab.dk" } });
    expect(screen.getByTestId("onb-acct-auto-send").disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
    expect(lastBusinessPut()).toMatchObject({ accountant_auto_send: false });
  });
});

describe("step 4 — the invite is optional, the demo keeps the owner's business", () => {
  it("says the revisor invite is optional", async () => {
    await toStep4();
    expect(screen.getByTestId("onb-revisor-optional").textContent).toMatch(/Optional\. Leave it empty to skip/);
  });

  it("'Explore with sample data' seeds with keep_profile and says the owner's details stay", async () => {
    await toStep4();
    expect(screen.getByText(/Your own details stay as you typed them/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId("onb-explore-sample")); });
    await waitFor(() => expect(h.navigate).toHaveBeenCalled());
    expect(h.post).toHaveBeenCalledWith("/demo/seed", null, { params: { keep_profile: true } });
    // seeding never PUTs the profile
    const putsAfterSeed = h.put.mock.calls.filter(([url]) => url === "/business").length;
    expect(putsAfterSeed).toBe(2); // step 2 + step 3 saves only
  });
});
