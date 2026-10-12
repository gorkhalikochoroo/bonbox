/**
 * Gavekort review 12 Oct 2026 (h): two owner-recorded exceptions.
 *
 *  - A card given away (sponsor, prize, goodwill) had no way to say so: it
 *    was recorded as sold, so an SPV card's face value carried MOMS that was
 *    never collected. "Gratis / sponsoreret" sends payment_method "free".
 *  - "Issued by mistake — no payment": a void with that reason takes the
 *    card's sale MOMS back out — only for an unused card in the MOMS period it
 *    was made (the server refuses otherwise, and the refusal is said).
 *
 * Strings are asserted by key (t echoes the key plus its values).
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

const CARD = {
  id: "c1", short_code: "GK-AAAA-BBBB-C", code_last4: "BBBC", voucher_class: "spv",
  status: "active", face_value_minor: 50000, balance_minor: 50000,
  issued_at: "2026-10-12T10:00:00", payment_method: "card",
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => {
    if (url === "/gavekort") return Promise.resolve({ data: { cards: [CARD], summary: {} } });
    if (url === "/gavekort/c1") return Promise.resolve({ data: { card: CARD, transactions: [] } });
    return Promise.resolve({ data: { pending_count: 0, orders: [], summary: {}, cards: [] } });
  });
  post.mockResolvedValue({ data: { ...CARD, qr_token: "BB1.G.x" } });
});

describe("a free / sponsored card", () => {
  it("is sent as payment_method 'free', with no MOMS at issue said", async () => {
    const { container } = render(<MemoryRouter><GavekortPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(/gkAddRecipient/));
    fireEvent.click(screen.getByTestId("gk-free"));
    expect(screen.getByText("gkFreeHelp")).toBeInTheDocument();
    fireEvent.change(container.querySelector('input[aria-label="gkAmountLabel"]'), { target: { value: "300" } });
    const btn = screen.getAllByRole("button").find((b) => /^gkSellCta/.test(b.textContent.trim()));
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe("/gavekort/issue");
    expect(post.mock.calls[0][1].payment_method).toBe("free");
  });
});

describe("void — why", () => {
  const openVoid = async () => {
    render(<MemoryRouter><GavekortPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("gkTabLedger"));
    fireEvent.click(await screen.findByText("···· BBBC"));
    fireEvent.click(await screen.findByText("gkVoidAction"));
  };

  it("an ordinary void sends no reason (the MOMS stays)", async () => {
    await openVoid();
    expect(screen.getByText("gkVoidReasonSoldHelp")).toBeInTheDocument();
    fireEvent.click(screen.getByText("gkVoidConfirm"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]).toEqual(["/gavekort/c1/void", {}]);
  });

  it("'issued by mistake' sends the reason, and a refusal is said in words", async () => {
    post.mockRejectedValueOnce({ response: { status: 409, data: { detail: { error: "void_error_period_closed" } } } });
    await openVoid();
    fireEvent.click(screen.getByTestId("gk-void-error"));
    fireEvent.click(screen.getByText("gkVoidConfirm"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]).toEqual(["/gavekort/c1/void", { reason: "issued_in_error" }]);
    expect(await screen.findByText("gkErrVoidErrorPeriod")).toBeInTheDocument();
  });
});

// QA 12 Oct 2026: on a phone the global 44px touch floor made the checkbox and
// the radios 44px tall, and with `items-start mt-*` their glyph sat 10-16px
// below the label's first line. Now each control is centred in a box one
// text-sm line tall (h-5), so it meets the FIRST line at any wrap; the
// label's touch padding keeps the 44px input inside its row (no shrink).
const expectFirstLineAligned = (input) => {
  expect(input.className).not.toMatch(/\bmt-/);
  const box = input.parentElement;
  expect(box.tagName).toBe("SPAN");
  for (const c of ["flex", "h-5", "shrink-0", "items-center"]) expect(box.classList.contains(c), c).toBe(true);
  const label = input.closest("label");
  expect(label.classList.contains("items-start")).toBe(true);
  expect(label.classList.contains("pointer-coarse:py-3")).toBe(true);
  // the touch floor itself is untouched: no min-h override on the control
  expect(input.className).not.toMatch(/min-h/);
};

describe("controls line up with their label's first line", () => {
  it("the Free / sponsored checkbox", async () => {
    render(<MemoryRouter><GavekortPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(/gkAddRecipient/));
    expectFirstLineAligned(screen.getByTestId("gk-free"));
  });

  it("both void-reason radios", async () => {
    render(<MemoryRouter><GavekortPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("gkTabLedger"));
    fireEvent.click(await screen.findByText("···· BBBC"));
    fireEvent.click(await screen.findByText("gkVoidAction"));
    const radios = [...document.querySelectorAll('input[name="gk-void-reason"]')];
    expect(radios).toHaveLength(2);
    radios.forEach(expectFirstLineAligned);
  });
});

describe("the words (real dictionaries)", () => {
  it("are real Danish and English", () => {
    for (const k of ["gkFreeLabel", "gkFreeHelp", "gkTenderFree", "gkVoidReasonSold", "gkVoidReasonSoldHelp",
      "gkVoidReasonError", "gkVoidReasonErrorHelp", "gkErrVoidErrorUsed", "gkErrVoidErrorPeriod", "gkOrdersClassLabel"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
    }
    expect(da.gkVoidReasonError).toMatch(/fejl/);
  });
});
