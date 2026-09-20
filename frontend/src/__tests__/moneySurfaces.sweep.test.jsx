/**
 * The rest of the app's keyed money boxes, walked the way a Danish owner
 * walks them.
 *
 * The defect these close is the one reproduced on production 2026-09-20 in
 * the Expenses amount field, on a browser whose locale is English — a laptop
 * bought abroad, a Chrome profile in English, ordinary in Copenhagen:
 *
 *     typed              "1.500,50"
 *     input.value        "1.50050"     ← the comma dropped, the dot kept
 *     valueAsNumber      1.5005
 *     validity.badInput  FALSE         ← no error, nothing to see
 *
 * `parseFloat` then returned 1.5005 — positive — so the submit gate unlocked.
 * EntryCard (Sales + Expenses) was fixed in 565584a6. Every OTHER keyed money
 * box in the app had the same type="number" + parseFloat pair, and several
 * had the worse `parseFloat(e.target.value) || 0` idiom in their onChange,
 * which does not merely truncate — it FABRICATES a 0 on a money column.
 *
 * These tests drive the real page components, not the parser (parseMoneyInput
 * is already pinned by parseMoneyInput.test.js, and MoneyField by
 * MoneyField.test.jsx). What regresses is the WIRING, so each surface is
 * asserted three ways:
 *
 *   1. the box is TEXT with a decimal keypad — a number input cannot come back
 *   2. the production string "1.50050" is refused, visibly
 *   3. a real Danish "1.500,50" is accepted and reaches the API as 1500.5
 *
 * Money-shaped-but-not-money fields are asserted too, in the last block: a
 * quantity or an FX rate that got converted would be its own bug.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    put: (...a) => put(...a),
    patch: (...a) => patch(...a),
    delete: (...a) => del(...a),
  },
}));
// A DKK account: moneyLocale("DKK") is "da-DK", which is the notation the
// production defect was reported in.
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, currency: "DKK", business_type: "restaurant", full_name: "Ejer" },
    refreshUser: vi.fn(),
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true, plan: "pro" }),
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useUndoToast", () => ({
  useUndoToast: () => ({ showUndo: vi.fn(), undoToastUI: null }),
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => vi.fn() }));

const CashBookPage = (await import("../pages/CashBookPage")).default;
const BudgetPage = (await import("../pages/BudgetPage")).default;
const WastePage = (await import("../pages/WastePage")).default;
const KhataPage = (await import("../pages/KhataPage")).default;
const CompetitorPage = (await import("../pages/CompetitorPage")).default;
const StaffingPage = (await import("../pages/StaffingPage")).default;
const ExpensesPage = (await import("../pages/ExpensesPage")).default;
const InventoryPage = (await import("../pages/InventoryPage")).default;
const PersonalPage = (await import("../pages/PersonalPage")).default;
const StaffTipsPage = (await import("../pages/StaffTipsPage")).default;
const FakturaPage = (await import("../pages/FakturaPage")).default;
const LoanTrackerPage = (await import("../pages/LoanTrackerPage")).default;
const SalesPage = (await import("../pages/SalesPage")).default;
const RecurringExpensesPanel = (await import("../components/RecurringExpensesPanel")).default;
const WineListPage = (await import("../pages/WineListPage")).default;

/** The exact string the English-locale browser handed over on production. */
const PRODUCTION_STRING = "1.50050";
/** What the owner actually typed, and what must now get through. */
const DANISH_AMOUNT = "1.500,50";
const DANISH_AMOUNT_AS_NUMBER = 1500.5;
/** Junk that a salvaging parser would turn into a plausible positive number. */
const JUNK = ["347-50", "1.234.56", "1,234"];

const mount = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

/** Every money box on screen. They are the only inputmode="decimal" fields. */
const moneyBoxes = (container) =>
  Array.from(container.querySelectorAll('input[inputmode="decimal"]'));

const setValue = (el, value) => fireEvent.change(el, { target: { value } });
const refusals = () => screen.queryAllByRole("alert").filter((n) => n.textContent === "invalidAmount");

beforeEach(() => {
  // jsdom ships neither of these, and two of the pages under test call them
  // during an ordinary render. Without the stubs the failure is a crash that
  // looks nothing like the money defect these tests are about.
  if (!URL.createObjectURL) URL.createObjectURL = () => "blob:stub";
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.clearAllMocks();
  get.mockResolvedValue({ data: [] });
  post.mockResolvedValue({ data: {} });
  put.mockResolvedValue({ data: {} });
  patch.mockResolvedValue({ data: {} });
});
afterEach(() => { vi.clearAllMocks(); });

/* ─────────────────────────────────────────────────────────────────────────
 * The shape assertion, applied to every converted surface.
 *
 * A box that is still type="number" is the defect itself, so this is run per
 * page rather than once: a single page reverting is exactly the regression.
 * ──────────────────────────────────────────────────────────────────────── */
describe("no keyed money box is a number input any more", () => {
  const surfaces = [
    ["cash book", <CashBookPage key="c" />, 1],
    ["budget limits", <BudgetPage key="b" />, 0],
    ["waste cost", <WastePage key="w" />, 1],
    ["khata credit ledger", <KhataPage key="k" />, 0],
    ["competitor prices", <CompetitorPage key="p" />, 0],
    ["staffing revenue bands", <StaffingPage key="s" />, 0],
  ];

  it.each(surfaces)("%s", async (_name, ui, minBoxes) => {
    const { container } = mount(ui);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const boxes = moneyBoxes(container);
    expect(boxes.length).toBeGreaterThanOrEqual(minBoxes);
    for (const b of boxes) {
      expect(b.getAttribute("type")).toBe("text");
      // The till keypad has to survive — these are typed standing up.
      expect(b.getAttribute("inputmode")).toBe("decimal");
      // `step` only ever validated the native submit path; on text it is noise.
      expect(b.hasAttribute("step")).toBe(false);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Cash book — the custom-amount box and its submit path.
 * ──────────────────────────────────────────────────────────────────────── */
describe("cash book — the amount that becomes a kasse entry", () => {
  const fillAndSubmit = async (container, amount) => {
    const [box] = moneyBoxes(container);
    setValue(box, amount);
    // A cash entry needs a description before it can go out at all.
    const desc = container.querySelector('input[type="text"]');
    if (desc) setValue(desc, "Bankindskud");
    fireEvent.click(screen.getByText("addIn", { selector: "button" }));
  };

  it("refuses the production string rather than booking 1,50 kr", async () => {
    const { container } = mount(<CashBookPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const [box] = moneyBoxes(container);
    setValue(box, PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    expect(box.getAttribute("aria-invalid")).toBe("true");
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const { container } = mount(<CashBookPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish amount and posts it as 1500.5", async () => {
    const { container } = mount(<CashBookPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await fillAndSubmit(container, DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0];
    expect(body.amount).toBe(DANISH_AMOUNT_AS_NUMBER);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Budget — a SAVE here replaces the month's limits wholesale, so a dropped
 * limit is a deleted limit. The gate matters more than the parse.
 * ──────────────────────────────────────────────────────────────────────── */
describe("budget limits — the save is a full replace, so it refuses a guess", () => {
  const openEditor = async () => {
    const { container } = mount(<BudgetPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    // The header CTA and the empty-state CTA carry the same label; either one
    // opens the editor, so take the first.
    fireEvent.click((await screen.findAllByText("setBudget"))[0].closest("button"));
    return container;
  };

  it("the total-budget box is text and refuses the production string", async () => {
    const container = await openEditor();
    const boxes = moneyBoxes(container);
    expect(boxes.length).toBeGreaterThan(0);
    setValue(boxes[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
  });

  it("holds a real Danish amount and does not complain", async () => {
    const container = await openEditor();
    const boxes = moneyBoxes(container);
    setValue(boxes[0], DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
    expect(boxes[0].value).toBe(DANISH_AMOUNT);
  });

  it("disables Save while a limit cannot be read", async () => {
    const container = await openEditor();
    const boxes = moneyBoxes(container);
    setValue(boxes[0], PRODUCTION_STRING);
    const save = screen.getByText("bgtSaveBudgets").closest("button");
    expect(save.disabled).toBe(true);
    setValue(boxes[0], DANISH_AMOUNT);
    expect(save.disabled).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Waste — the cost box used to be `estimated_cost: c || 0`, which turns a
 * typo into a free loss on the one page that exists to make losses visible.
 * ──────────────────────────────────────────────────────────────────────── */
describe("waste cost — a typo must not become a free loss", () => {
  it("refuses the production string", async () => {
    const { container } = mount(<WastePage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const { container } = mount(<WastePage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish amount", async () => {
    const { container } = mount(<WastePage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    setValue(moneyBoxes(container)[0], DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
  });

  /* The refusal used to be a bare `return` inside submit(), with the CTA left
     live: the owner tapped "Log waste" and got nothing, no message, no
     movement — while the row-edit Save one screen down was correctly disabled
     for the same reason. One page teaching two behaviours is how a disabled
     state stops meaning anything. */
  it("disables the log button while the cost cannot be read", async () => {
    const { container } = mount(<WastePage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const [item, qty] = container.querySelectorAll('input[type="text"], input[type="number"]');
    setValue(item, "Mælk");
    setValue(qty, "2");
    const logBtn = screen.getByRole("button", { name: "logWaste" });
    expect(logBtn).not.toBeDisabled();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(logBtn).toBeDisabled();
    fireEvent.click(logBtn);
    await waitFor(() => expect(post).not.toHaveBeenCalled());
  });

  it("re-enables the log button once the cost reads", async () => {
    const { container } = mount(<WastePage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const [item, qty] = container.querySelectorAll('input[type="text"], input[type="number"]');
    setValue(item, "Mælk");
    setValue(qty, "2");
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(screen.getByRole("button", { name: "logWaste" })).toBeDisabled();
    setValue(moneyBoxes(container)[0], DANISH_AMOUNT);
    expect(screen.getByRole("button", { name: "logWaste" })).not.toBeDisabled();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Khata — a credit ledger. Two money columns per line, and BOTH used
 * `parseFloat(...) || 0`, so an unreadable purchase was filed as a free one.
 * ──────────────────────────────────────────────────────────────────────── */
describe("khata — purchased and paid are both money", () => {
  const mountKhata = async () => {
    // The purchased/paid columns only exist once a customer's ledger is open.
    get.mockImplementation((url) => {
      if (String(url) === "/khata/customers") {
        return Promise.resolve({ data: [{ id: 7, name: "Hr. Jensen", total_credit: 0, total_paid: 0 }] });
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = mount(<KhataPage />);
    await waitFor(() => expect(screen.getByText("Hr. Jensen")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Hr. Jensen"));
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThanOrEqual(2));
    return container;
  };

  it("has at least the purchased + paid boxes, both text", async () => {
    const container = await mountKhata();
    expect(moneyBoxes(container).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses the production string in the purchased column", async () => {
    const container = await mountKhata();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
  });

  it("refuses the production string in the paid column", async () => {
    const container = await mountKhata();
    setValue(moneyBoxes(container)[1], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const container = await mountKhata();
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish amount in both columns at once", async () => {
    const container = await mountKhata();
    const [purchased, paid] = moneyBoxes(container);
    setValue(purchased, DANISH_AMOUNT);
    setValue(paid, "347,50");
    expect(refusals().length).toBe(0);
  });

  it("disables the add button while a column cannot be read", async () => {
    const container = await mountKhata();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    const add = screen.getAllByRole("button").find((b) => b.type === "submit" && b.textContent === "add");
    expect(add).toBeTruthy();
    expect(add.disabled).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Competitor prices — a misread price here does not hit the ledger, it hits
 * the owner's PRICING DECISION, which is worse per kroner.
 * ──────────────────────────────────────────────────────────────────────── */
describe("competitor prices — the comparison must not be off by a thousand", () => {
  const openPriceForm = async () => {
    get.mockImplementation((url) => {
      if (String(url).includes("competitors")) {
        return Promise.resolve({
          data: {
            competitors: [{ id: 1, name: "Café Nabo" }],
            price_checks: [],
            total_competitors: 1,
          },
        });
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = mount(<CompetitorPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    return container;
  };

  it("their-price and our-price are both text money boxes", async () => {
    const container = await openPriceForm();
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThanOrEqual(2));
    for (const b of moneyBoxes(container)) {
      expect(b.getAttribute("type")).toBe("text");
    }
  });

  it("refuses the production string and disables the log button", async () => {
    const container = await openPriceForm();
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThanOrEqual(2));
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    const btn = screen.getByText("logPriceCheck", { selector: "button" });
    expect(btn.disabled).toBe(true);
  });

  it("accepts a real Danish price and re-enables the log button", async () => {
    const container = await openPriceForm();
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThanOrEqual(2));
    setValue(moneyBoxes(container)[0], DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
    expect(screen.getByText("logPriceCheck", { selector: "button" }).disabled).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Staffing bands — a revenue THRESHOLD in kroner. parseFloat("10.000") is
 * 10, so the "busy day" rule fired on every ordinary day.
 * ──────────────────────────────────────────────────────────────────────── */
describe("staffing revenue bands — a threshold is money, a head count is not", () => {
  const mountStaffing = async () => {
    get.mockResolvedValue({ data: { rules: [], insights: null, logs: [] } });
    const { container } = mount(<StaffingPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    return container;
  };

  it("min/max revenue are text money boxes", async () => {
    const container = await mountStaffing();
    const boxes = moneyBoxes(container);
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    expect(boxes[0].getAttribute("type")).toBe("text");
  });

  it("refuses the production string in a band boundary", async () => {
    const container = await mountStaffing();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish threshold", async () => {
    const container = await mountStaffing();
    setValue(moneyBoxes(container)[0], "10.000");
    expect(refusals().length).toBe(0);
  });

  it("leaves the staff-count box a number input — it is a head count", async () => {
    const container = await mountStaffing();
    const staffNeeded = container.querySelector('input[placeholder="staffNeeded"]');
    expect(staffNeeded).toBeTruthy();
    expect(staffNeeded.getAttribute("type")).toBe("number");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Inventory — cost and sell price are money; quantity and min-stock are not.
 * The row editor's onChange was `parseFloat(e.target.value) || 0`, so an
 * unreadable cost became a free item and every margin below it was wrong.
 * ──────────────────────────────────────────────────────────────────────── */
describe("inventory — cost and sell price are money, quantity is not", () => {
  const mountInv = async () => {
    const { container } = mount(<InventoryPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThanOrEqual(2));
    return container;
  };

  it("cost and sell price are text money boxes", async () => {
    const container = await mountInv();
    for (const b of moneyBoxes(container)) expect(b.getAttribute("type")).toBe("text");
  });

  it("refuses the production string in the cost box", async () => {
    const container = await mountInv();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const container = await mountInv();
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish cost", async () => {
    const container = await mountInv();
    setValue(moneyBoxes(container)[0], DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
  });

  it("leaves quantity and min-stock as number inputs — they are counts", async () => {
    const container = await mountInv();
    for (const ph of ["quantity", "minStock"]) {
      const el = container.querySelector(`input[placeholder="${ph}"]`);
      expect(el, ph).toBeTruthy();
      // A money parser caps fractions at two digits and reads a 3-digit group
      // as thousands. Neither is true of 1.125 kg, so converting these would
      // have been its own bug.
      expect(el.getAttribute("type")).toBe("number");
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Personal budgets — the per-category limits drive the over-budget warnings,
 * so a limit read as 1/1000th switches the warnings on for everything.
 * ──────────────────────────────────────────────────────────────────────── */
describe("personal budgets", () => {
  const openEditor = async () => {
    // /loans/summary is read as an object (total_borrowed.toLocaleString()),
    // so the blanket [] default would crash the page before it renders.
    get.mockImplementation((url) => {
      if (String(url).includes("/loans/summary")) {
        return Promise.resolve({ data: { total_borrowed: 0, total_lent: 0, net_balance: 0, persons: [] } });
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = mount(<PersonalPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    fireEvent.click((await screen.findByText("setBudget")).closest("button"));
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThan(0));
    return container;
  };

  it("the total-budget box is text", async () => {
    const container = await openEditor();
    expect(moneyBoxes(container)[0].getAttribute("type")).toBe("text");
  });

  it("refuses the production string", async () => {
    const container = await openEditor();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const container = await openEditor();
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish amount and disables Save only while unreadable", async () => {
    const container = await openEditor();
    const box = moneyBoxes(container)[0];
    setValue(box, PRODUCTION_STRING);
    const save = screen.getByText("saveBudget").closest("button");
    expect(save.disabled).toBe(true);
    setValue(box, DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
    expect(save.disabled).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Tips — the pot is what the whole distribution is DIVIDED BY, so a
 * thousandfold misread hands every staff member a thousandth of their share.
 * ──────────────────────────────────────────────────────────────────────── */
describe("staff tips — the pot everything is divided by", () => {
  const mountTips = async () => {
    const { container } = mount(<StaffTipsPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThan(0));
    return container;
  };

  it("the total-tips box is text with a decimal keypad", async () => {
    const container = await mountTips();
    const box = moneyBoxes(container)[0];
    expect(box.getAttribute("type")).toBe("text");
    expect(box.getAttribute("inputmode")).toBe("decimal");
  });

  it("refuses the production string, and the Distribute block does not appear", async () => {
    // The distribute block renders on `amount > 0`. Under parseFloat the
    // production string WAS > 0 (1.5005), so it appeared and offered to split
    // a pot a thousand times too small. Now the amount is NaN, so there is
    // nothing to distribute and the field says why.
    const container = await mountTips();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    expect(screen.queryAllByText(/stDistribute/).length).toBe(0);
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const container = await mountTips();
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish pot", async () => {
    const container = await mountTips();
    setValue(moneyBoxes(container)[0], DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Faktura — a legal document. A unit price read as 1/1000th goes out to a
 * customer with a MOMS line computed from it.
 * ──────────────────────────────────────────────────────────────────────── */
describe("faktura line prices", () => {
  const openModal = async () => {
    get.mockImplementation((url) => {
      if (String(url).includes("customers")) {
        return Promise.resolve({ data: [{ id: 3, name: "ACME ApS", is_company: true }] });
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = mount(<FakturaPage />);
    fireEvent.click((await screen.findByText(/newInvoice/)).closest("button"));
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThan(0));
    return container;
  };

  it("the unit price is a text money box, the quantity is not", async () => {
    const container = await openModal();
    expect(moneyBoxes(container)[0].getAttribute("type")).toBe("text");
    const qty = container.querySelector('input[placeholder="qty"]');
    expect(qty).toBeTruthy();
    expect(qty.getAttribute("type")).toBe("number");
  });

  it("refuses the production string and will not create the draft", async () => {
    const container = await openModal();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    const create = screen.getByText("createDraft").closest("button");
    expect(create.disabled).toBe(true);
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const container = await openModal();
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish price and re-enables Create", async () => {
    const container = await openModal();
    setValue(moneyBoxes(container)[0], DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
    expect(screen.getByText("createDraft").closest("button").disabled).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Loan tracker — `parseFloat(txnForm.amount) || 0` posted a 0-kroner loan
 * line for anything it could not read: a row in the ledger that never
 * happened.
 * ──────────────────────────────────────────────────────────────────────── */
describe("loan tracker amount", () => {
  const openPerson = async () => {
    get.mockImplementation((url) => {
      if (String(url) === "/loans/persons") {
        return Promise.resolve({ data: [{ id: 2, name: "Farbror Ib", lent_balance: 0, borrowed_balance: 0 }] });
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = mount(<LoanTrackerPage />);
    fireEvent.click(await screen.findByText("Farbror Ib"));
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThan(0));
    return container;
  };

  it("is a text money box", async () => {
    const container = await openPerson();
    expect(moneyBoxes(container)[0].getAttribute("type")).toBe("text");
  });

  it("refuses the production string and keeps the row out of the ledger", async () => {
    const container = await openPerson();
    const box = moneyBoxes(container)[0];
    setValue(box, PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    // Scoped to the transaction form — the page also carries an add-person
    // form whose submit button is unrelated to this amount.
    const add = within(box.closest("form")).getAllByRole("button").find((b) => b.type === "submit");
    expect(add.disabled).toBe(true);
  });

  it.each(JUNK)("refuses %s", async (junk) => {
    const container = await openPerson();
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish amount", async () => {
    const container = await openPerson();
    const box = moneyBoxes(container)[0];
    setValue(box, DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
    const add = within(box.closest("form")).getAllByRole("button").find((b) => b.type === "submit");
    expect(add.disabled).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * The EDIT modals on Sales and Expenses — deliberately left out of the
 * original EntryCard fix so this sweep would carry them.
 *
 * These correct a row that ALREADY EXISTS, and their handler was the worst
 * variant in the app: `parseFloat(e.target.value) || 0` on the box, plus
 * `if (payload.amount === "") payload.amount = 0` on save. Between them, a
 * blank or unreadable box silently rewrote a real booked sale to zero.
 * ──────────────────────────────────────────────────────────────────────── */
describe("sales edit modal — correcting a row that is already booked", () => {
  const openEdit = async () => {
    get.mockImplementation((url) => {
      if (String(url).includes("/sales")) {
        return Promise.resolve({
          data: [{ id: 11, date: "2026-09-20", amount: "347.50", payment_method: "cash", status: "completed", notes: "" }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = mount(<SalesPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    // The row's overflow menu carries the Edit action.
    const menus = await screen.findAllByRole("button");
    for (const m of menus) {
      fireEvent.click(m);
      const edit = screen.queryAllByText("edit")[0];
      if (edit) { fireEvent.click(edit.closest("button") || edit); break; }
    }
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThan(1));
    return container;
  };

  it("the edit amount is a text money box, seeded with the booked figure", async () => {
    const container = await openEdit();
    // The logging EntryCard is box 0; the modal's is the one seeded non-empty.
    const box = moneyBoxes(container).find((b) => b.value === "347.5");
    expect(box).toBeTruthy();
    expect(box.getAttribute("type")).toBe("text");
  });

  it("refuses the production string and will not let Save through", async () => {
    const container = await openEdit();
    const box = moneyBoxes(container).find((b) => b.value === "347.5");
    setValue(box, PRODUCTION_STRING);
    expect(refusals().length).toBe(1);
    const save = screen.getAllByText("save").map((n) => n.closest("button")).find(Boolean);
    expect(save.disabled).toBe(true);
  });

  it("refuses a BLANK amount rather than rewriting the sale to 0", async () => {
    // The old save path did `if (payload.amount === "") payload.amount = 0`.
    const container = await openEdit();
    const box = moneyBoxes(container).find((b) => b.value === "347.5");
    setValue(box, "");
    const save = screen.getAllByText("save").map((n) => n.closest("button")).find(Boolean);
    expect(save.disabled).toBe(true);
  });

  it("accepts a real Danish correction and PUTs it as 1500.5", async () => {
    const container = await openEdit();
    const box = moneyBoxes(container).find((b) => b.value === "347.5");
    setValue(box, DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
    const save = screen.getAllByText("save").map((n) => n.closest("button")).find(Boolean);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].amount).toBe(DANISH_AMOUNT_AS_NUMBER);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Recurring expenses — this amount is posted EVERY MONTH, unattended. A
 * misread here is not one wrong row, it is a standing order for one.
 * ──────────────────────────────────────────────────────────────────────── */
describe("recurring expense amount", () => {
  const openForm = async () => {
    const { container } = mount(
      <RecurringExpensesPanel categories={[{ id: 1, name: "Husleje" }]} currency="DKK" />,
    );
    fireEvent.click((await screen.findByText("addRecurringShort")).closest("button"));
    await waitFor(() => expect(moneyBoxes(container).length).toBeGreaterThan(0));
    return container;
  };

  it("is a text money box with a decimal keypad", async () => {
    const container = await openForm();
    const box = moneyBoxes(container)[0];
    expect(box.getAttribute("type")).toBe("text");
    expect(box.getAttribute("inputmode")).toBe("decimal");
  });

  it("refuses the production string when the rule is saved", async () => {
    const container = await openForm();
    setValue(moneyBoxes(container)[0], PRODUCTION_STRING);
    const name = container.querySelector('input[type="text"]:not([inputmode])');
    if (name) setValue(name, "Husleje");
    const submit = screen.getAllByRole("button").find((b) => b.type === "submit");
    fireEvent.click(submit);
    // Two voices say the same thing here: the field's own inline refusal and
    // the form's error line. Both are correct; the point is that nothing was
    // posted.
    await waitFor(() => expect(screen.getAllByText("invalidAmount").length).toBeGreaterThan(0));
    expect(post).not.toHaveBeenCalled();
  });

  it.each(JUNK)("refuses %s at the field", async (junk) => {
    const container = await openForm();
    setValue(moneyBoxes(container)[0], junk);
    expect(refusals().length).toBe(1);
  });

  it("accepts a real Danish amount", async () => {
    const container = await openForm();
    setValue(moneyBoxes(container)[0], DANISH_AMOUNT);
    expect(refusals().length).toBe(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * What must NOT have been converted. A money parser refuses a 6-decimal FX
 * rate and a 3-decimal quantity, so converting one of these would break a
 * working field — a wrong conversion is worse than a missed one.
 * ──────────────────────────────────────────────────────────────────────── */
describe("fields that are not money stayed number inputs", () => {
  it("the Expenses FX RATE is still a number input", async () => {
    const { container } = mount(<ExpensesPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    // The FX block lives behind the card's "more fields" disclosure.
    fireEvent.click((await screen.findByText("moreFields")).closest("button"));
    fireEvent.click((await screen.findByText("fx.show")).closest("button"));
    // A rate legitimately carries 6 decimals and a leading zero ("0.134000"),
    // which parseMoneyInput correctly refuses — routing it through a money
    // parser would be actively wrong. step="0.000001" identifies it.
    const rate = container.querySelector('input[step="0.000001"]');
    expect(rate).toBeTruthy();
    expect(rate.getAttribute("type")).toBe("number");
  });

  it("the Waste QUANTITY is still a number input", async () => {
    const { container } = mount(<WastePage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const qty = container.querySelector('input[placeholder="qty"]');
    expect(qty).toBeTruthy();
    // kg / liters / pieces — not kroner. A money parser caps fractions at two
    // digits and reads a 3-digit group as thousands; neither is true of 1.125 kg.
    expect(qty.getAttribute("type")).toBe("number");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Wine menu editor — a required price, and what "cleared" has to mean.
 *
 * The bottle-price line used to read `parseFloat(e.sell_price) || w.sell_price`,
 * so an unreadable value silently kept the OLD price and reported a successful
 * save. Moving it to parseMoneyInput fixed the misread but dropped the
 * fallback, and NaN serialises to `null` over the wire: a cleared box erased
 * the price, and the next wine-list PDF export died on float(None).
 *
 * So empty is a refusal HERE specifically — sell_price is required — while
 * glass_price keeps empty-as-meaningful, because a null there is the real
 * answer "not sold by the glass".
 * ──────────────────────────────────────────────────────────────────────── */
describe("wine menu editor — a cleared bottle price must refuse, not erase", () => {
  const WINE = {
    id: 3, name: "Barolo", menu_name: "Barolo", producer: "P", wine_type: "red",
    sell_price: 495, glass_price: 95, cost_price: 200, stock_qty: 6,
    grape: "Nebbiolo", region: "Piemonte", vintage: 2019, margin_pct: 55,
  };

  const openMenuTab = async () => {
    get.mockImplementation((url) =>
      url.includes("/summary")
        ? Promise.resolve({ data: {} })
        : Promise.resolve({ data: [WINE] }),
    );
    const utils = mount(<WineListPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const tab = await screen.findByText(/wineTabMenuEditor/);
    fireEvent.click(tab);
    return utils;
  };

  // Bottle price is rendered FIRST, glass price second — both are text money
  // boxes, and the asymmetry between them is the whole point of this block.
  const bottleBox = (container) => moneyBoxes(container)[0];
  const glassBox = (container) => moneyBoxes(container)[1];

  it("keeps the bottle price a text money box", async () => {
    const { container } = await openMenuTab();
    const box = bottleBox(container);
    expect(box.getAttribute("type")).toBe("text");
    expect(box.getAttribute("inputmode")).toBe("decimal");
  });

  it("refuses to save a CLEARED bottle price instead of writing null", async () => {
    const { container } = await openMenuTab();
    setValue(bottleBox(container), "");
    // The row is dirty, so a Save appears — and it must be dead, because the
    // alternative is a PUT carrying sell_price: null.
    const save = await screen.findByText("wineSaveLabel");
    expect(save.closest("button")).toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(put).not.toHaveBeenCalled());
  });

  it("refuses the production string in the bottle price", async () => {
    const { container } = await openMenuTab();
    setValue(bottleBox(container), PRODUCTION_STRING);
    expect(refusals().length).toBeGreaterThan(0);
    const save = await screen.findByText("wineSaveLabel");
    expect(save.closest("button")).toBeDisabled();
  });

  it.each(JUNK)("refuses junk %s in the bottle price", async (junk) => {
    const { container } = await openMenuTab();
    setValue(bottleBox(container), junk);
    const save = await screen.findByText("wineSaveLabel");
    expect(save.closest("button")).toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(put).not.toHaveBeenCalled());
  });

  it("saves a real Danish price as a number", async () => {
    const { container } = await openMenuTab();
    setValue(bottleBox(container), DANISH_AMOUNT);
    const save = await screen.findByText("wineSaveLabel");
    expect(save.closest("button")).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].sell_price).toBe(DANISH_AMOUNT_AS_NUMBER);
  });

  it("still lets a cleared GLASS price mean 'not sold by the glass'", async () => {
    // The asymmetry is deliberate: null is a real answer for glass_price and
    // an erasure for sell_price. Converting both to refusals would take a
    // legitimate action away from the owner.
    const { container } = await openMenuTab();
    setValue(glassBox(container), "");
    const save = await screen.findByText("wineSaveLabel");
    expect(save.closest("button")).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].glass_price).toBe(null);
  });
});
