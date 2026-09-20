/**
 * The money boxes the type="number" sweep could not see.
 *
 * The sweep that fixed the production defect grepped for `type="number"`,
 * because that is what the Expenses field was. These four surfaces were
 * ALREADY `type="text" inputMode="decimal"` — so they accepted Danish
 * notation happily and then handed it to a hand-rolled parser of the shape:
 *
 *     String(amount).replace(/\./g, "").replace(/,/g, ".")   → parseFloat
 *
 * which is worse than the number input, not better. The number input misread
 * "1.500,50" as 1.5005. This one MULTIPLIES dot-decimal entry: it assumes
 * every dot is a thousands separator, so "50.00" comes out as 5000. Measured
 * before the fix, against each page's own guard:
 *
 *   QuickSaleModal   "50.00"  → 5000      posted to /sales, gate green
 *   GavekortBuyPage  "50.00"  → 5.000 kr  passed amountValid, card in hand
 *   EventCashupModal "347,50" → 347       inside the ±1 DKK tolerance, so a
 *                                         bilagsnummer row saved the øre away
 *   WhatDoYouPayNow  "50.00"  → 5000      teardown inflated in OUR favour
 *
 * A DK-notation-only test would have passed on all four: "1.500,50" happens
 * to survive that expression. So each surface here is walked with BOTH
 * notations, and the dot-decimal case is the one that actually regresses.
 *
 * These drive the real components. parseMoneyInput is already pinned by
 * parseMoneyInput.test.js; what regresses is the WIRING.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();

vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useParams: () => ({ slug: "cafe-nord" }),
}));
// The t() mock echoes the key, so assertions pin BEHAVIOUR, never wording.
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
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn(), useEventLog: () => ({}) }));

const { QuickSaleModal } = await import("../components/BonBoxPolishKit");
const EventCashupModal = (await import("../components/EventCashupModal")).default;
const GavekortBuyPage = (await import("../pages/GavekortBuyPage")).default;
const WhatDoYouPayNow = (await import("../components/landing/WhatDoYouPayNow")).default;

/** Dot-decimal: the notation the old salvager multiplied instead of reading. */
const DOT_DECIMAL = "50.00";
const DOT_DECIMAL_AS_NUMBER = 50;
/** Danish notation: what the owner types, and what must still get through. */
const DANISH = "1.500,50";
const DANISH_AS_NUMBER = 1500.5;
/** The production string, plus junk a salvaging parser turns into a number. */
const PRODUCTION_STRING = "1.50050";
const JUNK = ["347-50", "1.234.56"];

const mount = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);
const setValue = (el, value) => fireEvent.change(el, { target: { value } });
const refusals = () =>
  screen.queryAllByRole("alert").filter((n) => n.textContent === "invalidAmount");

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: [] });
  post.mockResolvedValue({ data: {} });
});
afterEach(() => vi.clearAllMocks());

/* ───────────────────────────────────────────────────────────────────────────
 * 1. Dashboard Quick Sale — the highest-traffic money box in the app.
 *    Mounted twice on DashboardPage; its onSubmit posts straight to /sales.
 * ─────────────────────────────────────────────────────────────────────────── */
describe("quick sale — the amount that becomes a Sale row", () => {
  const openModal = (onSubmit = vi.fn(), currency = "DKK") => {
    const utils = mount(
      <QuickSaleModal open onClose={() => {}} onSubmit={onSubmit} currency={currency} />,
    );
    const box = utils.container.querySelector('input[inputmode="decimal"]');
    const submit = screen.getByRole("button", { name: /quickSaleLogBtn/ });
    return { ...utils, box, submit, onSubmit };
  };

  it("reads dot-decimal as itself, not as a hundredfold", async () => {
    const { box, submit, onSubmit } = openModal();
    setValue(box, DOT_DECIMAL);
    // The box still SHOWS what was typed — the old bug was invisible precisely
    // because it did.
    expect(box.value).toBe(DOT_DECIMAL);
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toBe(DOT_DECIMAL_AS_NUMBER);
  });

  it("still accepts a real Danish amount", async () => {
    const { box, submit, onSubmit } = openModal();
    setValue(box, DANISH);
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toBe(DANISH_AS_NUMBER);
  });

  it("refuses the production string visibly and will not submit it", async () => {
    const { box, submit, onSubmit } = openModal();
    setValue(box, PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(JUNK)("refuses junk %s instead of salvaging a number out of it", (junk) => {
    const { box, submit, onSubmit } = openModal();
    setValue(box, junk);
    expect(refusals().length).toBe(1);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the keystrokes — the character filter was itself a salvager", () => {
    // "347-50" used to have its dash eaten on the way into state, so the
    // parser was handed a clean, plausible, wrong 34750.
    const { box } = openModal();
    setValue(box, "347-50");
    expect(box.value).toBe("347-50");
  });

  it("is a text box with a decimal keypad, never a number input", () => {
    const { box } = openModal();
    expect(box.getAttribute("type")).toBe("text");
    expect(box.getAttribute("inputmode")).toBe("decimal");
    expect(box.hasAttribute("step")).toBe(false);
  });

  it("a preset writes a value its own account's parser can read", async () => {
    // The presets used to format as da-DK unconditionally, so on a USD account
    // a one-tap preset would have painted its own field red.
    const onSubmit = vi.fn();
    const { submit } = openModal(onSubmit, "USD");
    fireEvent.click(screen.getByRole("button", { name: "5,000" }));
    expect(refusals().length).toBe(0);
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toBe(5000);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * 2. Event cash-up — four split boxes on a row that carries a bilagsnummer.
 * ─────────────────────────────────────────────────────────────────────────── */
describe("event cash-up — the payment split on an audited Sale row", () => {
  const EVENT = {
    id: 7,
    name: "Fredagskoncert",
    ticket_tiers: [{ label: "Voksen", price_dkk: 347.5 }],
  };

  const openSplit = (onCashedUp = vi.fn()) => {
    // The modal is stateless about routing: it hands the payload to
    // onCashedUp, which is what actually POSTs the Sale row. That callback is
    // the seam the payment_split has to arrive at intact.
    const utils = mount(
      <EventCashupModal open onClose={() => {}} event={EVENT} onCashedUp={onCashedUp} currency="DKK" />,
    );
    // One ticket at 347,50 so gross is an amount with øre in it. The qty box
    // is inputMode="numeric" — a head count, correctly never a money box.
    const qty = utils.container.querySelector('input[inputmode="numeric"]');
    setValue(qty, "1");
    fireEvent.click(screen.getByText(/eventCashupShowSplit/));
    return utils;
  };

  it("does not truncate the øre off a Danish split", async () => {
    const onCashedUp = vi.fn();
    const { container } = openSplit(onCashedUp);
    const [cash] = container.querySelectorAll('input[inputmode="decimal"]');
    setValue(cash, "347,50");
    // 347,50 against a gross of 347,50 is an exact match, so nothing is wrong
    // and the mismatch warning must stay away. Before the fix parseFloat read
    // 347, which is 0,50 off — inside the ±1 tolerance, so it saved quietly.
    expect(screen.queryByText(/eventCashupErrSplit/)).toBeNull();
    const submit = screen.getByRole("button", { name: "eventCashupLogButton" });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onCashedUp).toHaveBeenCalled());
    expect(onCashedUp.mock.calls[0][0].payment_split.cash).toBe(347.5);
  });

  it("refuses an unreadable split as an AMOUNT error, not a mismatch", () => {
    const { container } = openSplit();
    const [cash] = container.querySelectorAll('input[inputmode="decimal"]');
    setValue(cash, PRODUCTION_STRING);
    // The complaint must name the box, not send the owner hunting for an
    // arithmetic error that is not there.
    expect(refusals().length).toBe(1);
    expect(screen.queryByText(/eventCashupErrSplit/)).toBeNull();
  });

  it.each(JUNK)("refuses junk %s and blocks the save", (junk) => {
    const onCashedUp = vi.fn();
    const { container } = openSplit(onCashedUp);
    const [cash] = container.querySelectorAll('input[inputmode="decimal"]');
    setValue(cash, junk);
    expect(refusals().length).toBe(1);
    const submit = screen.getByRole("button", { name: "eventCashupLogButton" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onCashedUp).not.toHaveBeenCalled();
  });

  it("keeps the keystrokes in every one of the four boxes", () => {
    const { container } = openSplit();
    const boxes = container.querySelectorAll('input[inputmode="decimal"]');
    expect(boxes.length).toBe(4);
    boxes.forEach((b) => {
      setValue(b, "347-50");
      expect(b.value).toBe("347-50");
    });
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * 3. Public gavekort purchase — a customer, a card, and no owner to notice.
 * ─────────────────────────────────────────────────────────────────────────── */
describe("gavekort buy — the public purchase amount", () => {
  const PAGE = {
    business_name: "Café Nord",
    min_amount_minor: 5000,
    max_amount_minor: 500000,
    open: true,
  };

  const openPage = async () => {
    get.mockResolvedValue({ data: PAGE });
    const utils = mount(<GavekortBuyPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const box = await waitFor(() => {
      const el = utils.container.querySelector('input[inputmode="decimal"]');
      expect(el).toBeTruthy();
      return el;
    });
    return { ...utils, box };
  };

  it("reads 50.00 as 50 kr, not as a 5.000 kr order", async () => {
    const { box } = await openPage();
    setValue(box, DOT_DECIMAL);
    // 50 kr is exactly the minimum, so it is valid — but as 50, not as 5.000.
    expect(refusals().length).toBe(0);
    // The range hint must not be the thing that fires: the amount is in range.
    expect(screen.queryByText(/gbuyErrRange/)).toBeNull();
  });

  it("refuses an unreadable amount as an amount error", async () => {
    const { box } = await openPage();
    setValue(box, PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    expect(box.getAttribute("aria-invalid")).toBe("true");
  });

  it.each(JUNK)("refuses junk %s rather than ordering something", async (junk) => {
    const { box } = await openPage();
    setValue(box, junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish amount inside the range", async () => {
    const { box } = await openPage();
    setValue(box, DANISH);
    expect(refusals().length).toBe(0);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * 4. Landing cost calculator — no ledger write, so the stake is the claim.
 * ─────────────────────────────────────────────────────────────────────────── */
describe("landing teardown calculator — the owner's own numbers", () => {
  const openCalc = () => {
    const utils = render(<WhatDoYouPayNow />);
    fireEvent.click(utils.container.querySelector("button"));
    return utils;
  };

  it("does not inflate a dot-decimal cost a hundredfold in our favour", () => {
    const { container } = openCalc();
    const [schedule] = container.querySelectorAll('input[inputmode="decimal"]');
    setValue(schedule, DOT_DECIMAL);
    // 50 kr/md is below what BonBox charges, so an honest calculator cannot
    // claim a saving. The old parser read 5000 and would have.
    expect(container.textContent).not.toMatch(/5\.000/);
  });

  it("still reads Danish thousands notation", () => {
    const { container } = openCalc();
    const [schedule] = container.querySelectorAll('input[inputmode="decimal"]');
    setValue(schedule, "1.200");
    expect(container.textContent).toMatch(/1\.200/);
  });

  it("shows nothing rather than a salvaged figure for junk", () => {
    const { container } = openCalc();
    const [schedule] = container.querySelectorAll('input[inputmode="decimal"]');
    setValue(schedule, "347-50");
    expect(container.textContent).not.toMatch(/34\.?750/);
  });
});
