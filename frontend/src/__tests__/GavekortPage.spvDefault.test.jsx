/**
 * Gavekort vs MOMS P0-2 — the class on the sell screen and its words.
 *
 * The old help called MPV "Standard for de fleste gavekort". The sell screen
 * now explains BOTH classes neutrally (neither is called the usual one) and
 * sends the owner to their revisor when in doubt.
 *
 * Owner decision 12 Oct 2026: the DEFAULT stays MPV (today's behaviour) until
 * the revisor confirms (GavekortPage DEFAULT_VOUCHER_CLASS + its backend twin
 * in app/models/gift_card.py). The owner can pick SPV ("Ét formål"), and the
 * card is then minted SPV — MOMS counted at sale.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", business_type: "restaurant" } }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));

const GavekortPage = (await import("../pages/GavekortPage")).default;

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: { pending_count: 0, orders: [], summary: {}, cards: [] } });
  post.mockResolvedValue({ data: {
    id: "c1", short_code: "GK-AAAA-BBBB-C", code_last4: "BBBC", qr_token: "BB1.G.x",
    face_value_minor: 50000, balance_minor: 50000, voucher_class: "spv", status: "active",
  } });
});

const sell = async (container) => {
  const amount = container.querySelector('input[aria-label="gkAmountLabel"]');
  fireEvent.change(amount, { target: { value: "500" } });
  const btn = screen.getAllByRole("button").find((b) => /^gkSellCta/.test(b.textContent.trim()));
  await waitFor(() => expect(btn).not.toBeDisabled());
  fireEvent.click(btn);
  await waitFor(() => expect(post).toHaveBeenCalled());
  return post.mock.calls[0][1];
};

describe("sell a gavekort — the class", () => {
  it("is pre-selected MPV (until the revisor confirms) and says MOMS at redemption", async () => {
    const { container } = render(<MemoryRouter><GavekortPage /></MemoryRouter>);
    expect(await screen.findByText("gkMomsAtRedemption")).toBeInTheDocument();
    expect((await sell(container)).voucher_class).toBe("mpv");
  });

  it("explains both classes and the revisor, and the owner can pick SPV", async () => {
    const { container } = render(<MemoryRouter><GavekortPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(/gkAddRecipient/));
    const help = screen.getByTestId("gk-class-help");
    expect(help.textContent).toContain("gkClassSpvHelp");
    expect(help.textContent).toContain("gkClassMpvHelp");
    expect(help.textContent).toContain("gkClassAskRevisor");
    expect(screen.getByRole("button", { name: "gkClassMpv" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "gkClassSpv" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "gkClassSpv" }));
    expect(screen.getByText("gkMomsAtIssue")).toBeInTheDocument();
    expect((await sell(container)).voucher_class).toBe("spv");
  });
});

describe("the words (real dictionaries)", () => {
  it("call neither class the standard; SPV says 25 % and MOMS at sale; both ask the revisor", () => {
    expect(da.gkClassMpvHelp).not.toMatch(/Standard for de fleste/);
    expect(en.gkClassMpvHelp).not.toMatch(/Standard for most/);
    for (const s of [da.gkClassMpvHelp, da.gkClassSpvHelp]) expect(s).not.toMatch(/de fleste|standard/i);
    for (const s of [en.gkClassMpvHelp, en.gkClassSpvHelp]) expect(s).not.toMatch(/\bmost\b|standard/i);
    expect(da.gkClassSpvHelp).toMatch(/25 %/);
    expect(da.gkClassSpvHelp).toMatch(/når kortet sælges/);
    expect(da.gkClassMpvHelp).toMatch(/når kortet bliver brugt/);
    expect(da.gkClassAskRevisor).toBe("Spørg din revisor, hvis du er i tvivl.");
    expect(en.gkClassAskRevisor).toBe("Ask your revisor if you are unsure.");
  });
});
