/**
 * Release gate R-b (9 Oct): the dashboard's "Prøv med eksempeldata" replaced
 * the owner's typed company, CVR and address with the sample company
 * (Mirabelle ApS) — DemoDataCard sent the default seed. And after seeding no
 * sample-data banner showed: the dashboard gated DemoActiveBanner on
 * user.is_demo_data_active, which the backend never sends.
 *
 *   • GET /demo/status says own_profile → the card seeds with keep_profile;
 *     an account without its own details keeps the default seed.
 *   • seedable === false (keep_profile would refuse: an account in use) →
 *     the card is not offered.
 *   • The banner is always asked (it reads /demo/status?scope=has_demo
 *     itself) and shows once sample data is on the account.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../services/api", () => ({ default: { get: h.get, post: h.post } }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da" }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1", role: "owner" } }) }));

import DemoDataCard from "../components/DemoDataCard";
import DemoActiveBanner from "../components/DemoActiveBanner";
import { DASHBOARD_CARD_SET } from "../config/dashboardCardSets";

const status = (s) => h.get.mockImplementation(() => Promise.resolve({ data: s }));

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.post.mockResolvedValue({ data: { ok: true } });
  localStorage.clear();
});

async function mountCard() {
  render(<DemoDataCard forceShow />);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("DemoDataCard — the owner's details are never overwritten", () => {
  it("an owner with their own details: seeds with keep_profile", async () => {
    status({ has_demo: false, has_real: false, own_profile: true, seedable: true });
    await mountCard();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByText("demoCardCta")); });
    } finally {
      vi.useRealTimers();
    }
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("/demo/seed", null, { params: { keep_profile: true } });
  });

  it("an account with no details of its own: the default seed, as before", async () => {
    status({ has_demo: false, has_real: false, own_profile: false, seedable: true });
    await mountCard();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByText("demoCardCta")); });
    } finally {
      vi.useRealTimers();
    }
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0][0]).toBe("/demo/seed");
    expect(h.post.mock.calls[0][2]?.params?.keep_profile).toBeUndefined();
  });

  it("an account in use (the seed would be refused): not offered", async () => {
    status({ has_demo: false, has_real: false, own_profile: true, seedable: false });
    await mountCard();
    expect(screen.queryByText("demoCardCta")).toBeNull();
  });

  it("an older server (no own_profile / seedable): shown as before", async () => {
    status({ has_demo: false, has_real: false });
    await mountCard();
    expect(screen.getByText("demoCardCta")).toBeInTheDocument();
  });
});

describe("the sample-data banner after seeding", () => {
  it("the dashboard always asks the banner (it self-detects) — never gated on a field the server does not send", () => {
    const demo = DASHBOARD_CARD_SET.notices.find((n) => n.id === "demo");
    expect(demo.component).toBe("DemoActiveBanner");
    expect(demo.renderIf({})).toBe(true);
    expect(demo.renderIf({ isDemoData: false })).toBe(true);
  });

  it("shows when the account holds sample data, read with the light has_demo scope", async () => {
    status({ has_demo: true });
    render(<DemoActiveBanner />);
    expect(await screen.findByText("demoActiveBanner")).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledWith("/demo/status", { params: { scope: "has_demo" } });
  });

  it("stays away on an account without sample data", async () => {
    status({ has_demo: false });
    render(<DemoActiveBanner />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText("demoActiveBanner")).toBeNull();
  });
});
