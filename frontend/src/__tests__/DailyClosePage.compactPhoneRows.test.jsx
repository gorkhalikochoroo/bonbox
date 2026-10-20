/**
 * The close's amount lines on a phone (20 Oct 2026).
 *
 * The owner, on the Kasserapport page on his phone: "why do we have these much
 * gap boxes and long in mob view". Each amount was its label on a line of its
 * own over a full-width 50 px box, 16 px from the next line: five payment
 * methods took 434 px of a 390 px-wide screen. Below sm the lines are now
 * receipt lines — the name on the left, a 40 px box on the right, one step's
 * lines in one card with hairlines.
 *
 * This is a MONEY-ENTRY screen and the change is layout only, so these tests
 * pin three things:
 *   1. the structure: label and box share one row on a phone, the rows of a
 *      step share one group, and every class the change adds is phone-gated
 *      (max-sm:) — or sm: where it puts back the spacing the step gave the
 *      rows before they were grouped — so 640 px and up render as before;
 *   2. ids, label association, type, inputMode and placeholder of every
 *      payment method of every venue type, exactly as they were;
 *   3. typing still goes through the same handlers: the totals move, the
 *      tie-out verdict follows, and the lock sends what was typed.
 *
 * jsdom has no media queries, so (1) asserts the classes, and the measured
 * phone heights are in bonbox-lab-state/gate-dc-compact-phone/.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ branchType: "restaurant" }));
const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
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
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: state.branchType, hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

// The page's shared box chrome, as it was before this change. It must still
// be on every box, whole: from 640 px up it is the only chrome that applies.
const INPUT_CLASS = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400 text-right text-[16px] tabular-nums";
const LABEL_CLASS = "text-[13px] font-medium text-gray-600 dark:text-gray-300";

beforeEach(() => {
  state.branchType = "restaurant";
  window.scrollTo = () => {};
  window.confirm = () => true;
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => {
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: { has_data: false } });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { id: 1, status: "draft" } });
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);

const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};

const enterManually = async () => {
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
};

const toStep = async (container, sel) => {
  // From the scan card, or onward from the step the wizard is on.
  if (!screen.queryByText(/^stepN/)) await enterManually();
  for (let i = 0; i < 6 && !container.querySelector(sel); i++) {
    tapNext();
    await new Promise((r) => setTimeout(r, 0));
  }
  await waitFor(() => expect(container.querySelector(sel)).not.toBeNull());
};

const tokens = (el) => String(el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
/** The row = the nearest ancestor of the box that also holds its label. */
const rowOf = (input) => {
  const label = document.querySelector(`label[for="${input.id}"]`);
  let el = input.parentElement;
  while (el && !el.contains(label)) el = el.parentElement;
  return el;
};
/** Classes that only apply below 640 px — or sm: ones that apply from 640 up. */
const phoneOnly = (cls) => cls.every((c) => c.startsWith("max-sm:"));

/** One amount line on a phone: label + box in one wrapping flex row, 40 px box on the right. */
const expectCompactRow = (input, { group = true } = {}) => {
  const row = rowOf(input);
  const label = row.querySelector(`label[for="${input.id}"]`);
  expect(label, `label for ${input.id}`).not.toBeNull();
  // Label and box are in ONE row on a phone.
  expect(tokens(row)).toEqual(expect.arrayContaining(["max-sm:flex", "max-sm:flex-wrap", "max-sm:items-center", "max-sm:px-3"]));
  expect(tokens(label)).toEqual(expect.arrayContaining(["max-sm:flex-1", "max-sm:min-w-0", "max-sm:wrap-anywhere", "max-sm:[&>svg]:shrink-0"]));
  // The box: fixed width on the right, 40 px, text still 16 px (iOS zoom).
  expect(tokens(input)).toEqual(expect.arrayContaining(["max-sm:w-36", "max-sm:shrink-0", "max-sm:h-10", "max-sm:py-0"]));
  expect(input.className).toContain("text-[16px]");
  // MoneyField's wrapper steps out of the way on a phone, so its error line
  // is a full-width line under the row, not a column under the box.
  if (input.parentElement !== row) expect(tokens(input.parentElement)).toContain("max-sm:contents");
  if (group) {
    // One card per step, hairlines between the lines; on desktop the group
    // gives its lines back the 16 px the step's space-y-4 gave them.
    expect(tokens(row.parentElement)).toEqual(expect.arrayContaining(["sm:space-y-4", "max-sm:rounded-xl", "max-sm:border", "max-sm:divide-y"]));
  }
  return { row, label };
};

describe("phone: a close step's amounts are receipt lines (layout only)", () => {
  it("payments: every method is label + box in one row, all in ONE group, chrome above 640 px untouched", async () => {
    const { container } = renderPage();
    await toStep(container, "#dc-pay-card");
    const inputs = Array.from(container.querySelectorAll('input[id^="dc-pay-"]'));
    expect(inputs.map((i) => i.id)).toEqual(["dc-pay-cash", "dc-pay-card", "dc-pay-mobilepay", "dc-pay-gift_card", "dc-pay-invoice"]);
    const groups = new Set();
    for (const input of inputs) {
      const { row, label } = expectCompactRow(input);
      groups.add(row.parentElement);
      // The desktop chrome is the old one, whole; the label keeps 13 px.
      expect(input.className.startsWith(INPUT_CLASS)).toBe(true);
      expect(label.className.startsWith(LABEL_CLASS)).toBe(true);
      // Everything the change ADDED is phone-gated, so ≥640 px renders as before.
      expect(phoneOnly(tokens(row))).toBe(true);
      expect(phoneOnly(tokens(label).filter((c) => !LABEL_CLASS.split(" ").includes(c)))).toBe(true);
      expect(phoneOnly(tokens(input).filter((c) => !INPUT_CLASS.split(" ").includes(c) && !c.startsWith("aria-[")))).toBe(true);
      expect(phoneOnly(tokens(input.parentElement))).toBe(true);
    }
    expect(groups.size).toBe(1);
    const [group] = groups;
    expect(tokens(group).filter((c) => !c.startsWith("max-sm:"))).toEqual(["sm:space-y-4"]);
    // The total block stays outside the group, as before.
    expect(group.contains(screen.getByText("paymentTotal"))).toBe(false);
  });

  it("revenue, cash and tips: the same rows, one group per step", async () => {
    const { container } = renderPage();
    await enterManually();
    const rev = Array.from(container.querySelectorAll('input[id^="dc-rev-"]'));
    expect(rev.map((i) => i.id)).toEqual(["dc-rev-food", "dc-rev-drinks", "dc-rev-takeaway"]);
    rev.forEach((i) => expectCompactRow(i));
    expect(new Set(rev.map((i) => rowOf(i).parentElement)).size).toBe(1);
    // The add-category row stays its own line under the group.
    const add = container.querySelector('input[placeholder="addCategory"]');
    expect(rowOf(rev[0]).parentElement.contains(add)).toBe(false);

    await toStep(container, "#cash-counted");
    const counted = container.querySelector("#cash-counted");
    const float = container.querySelector("#cash-float");
    expectCompactRow(counted);
    expectCompactRow(float);
    expect(rowOf(counted).parentElement).toBe(rowOf(float).parentElement);
    // The float row was already a row at every width: that stays.
    expect(tokens(rowOf(float))).toEqual(expect.arrayContaining(["flex", "items-center", "justify-between", "gap-3"]));
    // The count's hint is long: on a phone it may end in "…" rather than be cut.
    expect(tokens(counted)).toEqual(expect.arrayContaining(["max-sm:text-ellipsis", "max-sm:placeholder:text-[13px]"]));

    await toStep(container, "#dc-tips-total");
    const tips = container.querySelector("#dc-tips-total");
    const staff = container.querySelector("#dc-staff-count");
    expectCompactRow(tips);
    expectCompactRow(staff);
    expect(rowOf(tips).parentElement).toBe(rowOf(staff).parentElement);
    expect(tokens(staff)).toEqual(expect.arrayContaining(["max-sm:text-ellipsis", "max-sm:placeholder:text-[13px]"]));
  });

  it("an unreadable amount: the error is still on the box, and on a phone it takes its own full line", async () => {
    const { container } = renderPage();
    await toStep(container, "#dc-pay-card");
    const card = container.querySelector("#dc-pay-card");
    fireEvent.change(card, { target: { value: "1.2.3,,4" } });
    expect(card.getAttribute("aria-invalid")).toBe("true");
    const err = container.querySelector("#dc-pay-card-err");
    expect(err).not.toBeNull();
    expect(card.getAttribute("aria-describedby")).toBe("dc-pay-card-err");
    const row = rowOf(card);
    expect(row.contains(err)).toBe(true);
    expect(tokens(row)).toContain("max-sm:[&_[role=alert]]:basis-full");
  });
});

describe("ids, labels, inputMode and placeholders are unchanged for every payment method", () => {
  const EXPECTED = {
    restaurant: [["cash", "dcPayCash"], ["card", "dcPayCard"], ["mobilepay", "MobilePay"], ["gift_card", "dcPayGiftCard"], ["invoice", "dcPayInvoice"]],
    workshop: [["cash", "dcPayCash"], ["card", "dcPayCard"], ["bank_transfer", "dcPayBankTransfer"], ["invoice", "dcPayInvoiceCredit"]],
    retail: [["cash", "dcPayCash"], ["card", "dcPayCard"], ["mobilepay", "MobilePay"], ["gift_card", "dcPayGiftCard"]],
    grocery: [["cash", "dcPayCash"], ["card", "dcPayCard"], ["mobilepay", "MobilePay"]],
    ecommerce: [["card", "dcPayCardOnline"], ["mobilepay", "MobilePay"], ["bank_transfer", "dcPayBankTransfer"], ["paypal", "PayPal"]],
  };
  for (const [type, methods] of Object.entries(EXPECTED)) {
    it(`${type}`, async () => {
      state.branchType = type;
      const { container } = renderPage();
      await toStep(container, `#dc-pay-${methods[0][0]}`);
      const inputs = Array.from(container.querySelectorAll('input[id^="dc-pay-"]'));
      expect(inputs.map((i) => i.id)).toEqual(methods.map(([k]) => `dc-pay-${k}`));
      for (const [key, labelText] of methods) {
        const input = container.querySelector(`#dc-pay-${key}`);
        expect(input.tagName).toBe("INPUT");
        expect(input.getAttribute("type")).toBe("text");
        expect(input.getAttribute("inputmode")).toBe("decimal");
        expect(input.getAttribute("autocomplete")).toBe("off");
        expect(input.getAttribute("placeholder")).toBe("0");
        expect(input.hasAttribute("aria-invalid")).toBe(false);
        expect(input.hasAttribute("aria-describedby")).toBe(false);
        // The label is still the box's accessible name, through htmlFor.
        const label = container.querySelector(`label[for="dc-pay-${key}"]`);
        expect(label.textContent.trim()).toBe(labelText);
        expect(screen.getByLabelText(labelText)).toBe(input);
        expect(label.querySelector("svg")).not.toBeNull();
      }
    });
  }

  it("the other steps' boxes keep their ids, placeholders and inputMode", async () => {
    const { container } = renderPage();
    await enterManually();
    for (const k of ["food", "drinks", "takeaway"]) {
      const el = container.querySelector(`#dc-rev-${k}`);
      expect([el.type, el.inputMode, el.placeholder]).toEqual(["text", "decimal", "0"]);
      expect(screen.getByLabelText(`dcCat${k[0].toUpperCase()}${k.slice(1)}`)).toBe(el);
    }
    await toStep(container, "#cash-counted");
    const counted = container.querySelector("#cash-counted");
    expect([counted.type, counted.inputMode, counted.placeholder]).toEqual(["text", "decimal", "countYourDrawer"]);
    expect(screen.getByLabelText("dcDrawerCounted")).toBe(counted);
    const float = container.querySelector("#cash-float");
    expect([float.type, float.inputMode, float.placeholder]).toEqual(["text", "decimal", "0"]);
    expect(screen.getByLabelText("dcCashFloat")).toBe(float);
    await toStep(container, "#dc-tips-total");
    const tips = container.querySelector("#dc-tips-total");
    expect([tips.type, tips.inputMode, tips.placeholder]).toEqual(["text", "decimal", "0"]);
    expect(screen.getByLabelText("totalTipsLabel")).toBe(tips);
    const staff = container.querySelector("#dc-staff-count");
    expect([staff.type, staff.inputMode, staff.placeholder]).toEqual(["number", "numeric", "staffCountPrompt"]);
    expect(screen.getByLabelText("staffCountLabel")).toBe(staff);
  });
});

describe("typing goes through the same handlers", () => {
  it("revenue + payments: totals follow, the verdict balances, and the lock sends the typed amounts", async () => {
    post.mockImplementation((url, body) => Promise.resolve({ data: { id: 1, status: body?.status || "draft" } }));
    const { container } = renderPage();
    await enterManually();
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1.500,50" } });
    fireEvent.change(container.querySelector("#dc-rev-drinks"), { target: { value: "500" } });
    expect(container.querySelector("#dc-rev-food").value).toBe("1.500,50");
    tapNext();
    await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "1.800,50" } });
    expect(container.querySelector("#dc-pay-card").value).toBe("1.800,50");
    expect(screen.getByText(/^dcPayBelowRevenue:/)).toBeInTheDocument();
    fireEvent.change(container.querySelector("#dc-pay-cash"), { target: { value: "200" } });
    expect(screen.getByText("balanced")).toBeInTheDocument();
    for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
    fireEvent.click(await screen.findByText("confirmAndLock"));
    await waitFor(() =>
      expect(post.mock.calls.some(([u, b]) => u === "/daily-close" && b?.status === "confirmed")).toBe(true),
    );
    const body = post.mock.calls.find(([u, b]) => u === "/daily-close" && b?.status === "confirmed")[1];
    expect(body.revenue_breakdown).toMatchObject({ food: 1500.5, drinks: 500 });
    expect(body.payment_breakdown).toMatchObject({ card: 1800.5, cash: 200 });
  });

  it("cash and tips: the count, the float, the tips and the staff count reach the close", async () => {
    post.mockImplementation((url, body) => Promise.resolve({ data: { id: 1, status: body?.status || "draft" } }));
    const { container } = renderPage();
    await enterManually();
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1.000" } });
    tapNext();
    await waitFor(() => expect(container.querySelector("#dc-pay-cash")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-pay-cash"), { target: { value: "1.000" } });
    await toStep(container, "#cash-counted");
    fireEvent.change(container.querySelector("#cash-float"), { target: { value: "500" } });
    fireEvent.change(container.querySelector("#cash-counted"), { target: { value: "1.500" } });
    expect(container.querySelector("#cash-counted").value).toBe("1.500");
    expect(container.querySelector("#cash-float").value).toBe("500");
    await toStep(container, "#dc-tips-total");
    fireEvent.change(container.querySelector("#dc-tips-total"), { target: { value: "300" } });
    fireEvent.change(container.querySelector("#dc-staff-count"), { target: { value: "3" } });
    expect(screen.getByText("perPerson")).toBeInTheDocument();
    for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
    fireEvent.click(await screen.findByText("confirmAndLock"));
    await waitFor(() =>
      expect(post.mock.calls.some(([u, b]) => u === "/daily-close" && b?.status === "confirmed")).toBe(true),
    );
    const body = post.mock.calls.find(([u, b]) => u === "/daily-close" && b?.status === "confirmed")[1];
    expect(body.tips_total).toBe(300);
    expect(body.tips_staff_count).toBe(3);
    // The count with the float taken off, and the float beside it.
    expect(body.cash_counted).toBe(1000);
    expect(body.cash_float).toBe(500);
  });
});

describe("the scan card's boxes on a phone", () => {
  it("are label + 40 px box rows; the empty-state amber is still on a missing line", async () => {
    post.mockResolvedValueOnce({
      data: {
        revenue_total: 17030,
        revenue: { food: 4200 },
        payments: { card: 17030 },
        raw_text: "KASSE 17030",
        ocr_available: true,
      },
    });
    const { container } = renderPage();
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    for (const id of ["scan-rev-food", "scan-rev-drinks", "scan-pay-card", "scan-pay-cash"]) {
      const input = container.querySelector(`#${id}`);
      expect(input, id).not.toBeNull();
      const row = input.parentElement.parentElement;
      expect(tokens(row)).toEqual(expect.arrayContaining(["max-sm:flex-row", "max-sm:flex-wrap", "max-sm:items-center"]));
      // Desktop row classes kept as they were.
      expect(tokens(row)).toEqual(expect.arrayContaining(["flex", "flex-col", "items-stretch", "gap-1", "sm:flex-row", "sm:items-center", "sm:gap-3"]));
      expect(tokens(input)).toEqual(expect.arrayContaining(["max-sm:w-36", "max-sm:shrink-0", "max-sm:h-10"]));
      expect(input.className.startsWith(INPUT_CLASS)).toBe(true);
      expect(tokens(input.parentElement)).toEqual(["flex-1", "min-w-0", "max-sm:contents"]);
      // The name may wrap on a phone instead of being cut to "Mo…".
      const name = row.firstElementChild;
      expect(tokens(name)).toEqual(expect.arrayContaining(["max-sm:flex-1", "max-sm:grid", "max-sm:[&>*:nth-child(n+4)]:col-start-3", "sm:w-52", "flex"]));
      // ✓/— , icon, name — the badge (if any) is the 4th child: under the name.
      expect(name.children[2].className).toContain("truncate");
      expect(tokens(name.querySelector(".truncate"))).toEqual(expect.arrayContaining(["max-sm:whitespace-normal", "max-sm:break-words"]));
    }
    // A missing revenue line keeps its amber box and its hint.
    const drinks = container.querySelector("#scan-rev-drinks");
    expect(drinks.className).toContain("border-amber-300");
    expect(drinks.className).toContain("bg-amber-50/30");
    expect(drinks.getAttribute("placeholder")).toBe("enterActualAmount");
    // The total: same box, 40 px on a phone.
    const total = container.querySelector("#scan-total");
    expect(tokens(total)).toEqual(expect.arrayContaining(["max-sm:h-10", "font-semibold"]));
    expect(total.className.startsWith(INPUT_CLASS)).toBe(true);
    // Typing on the card still lands in its box.
    fireEvent.change(drinks, { target: { value: "12.830" } });
    expect(container.querySelector("#scan-rev-drinks").value).toBe("12.830");
  });
});
