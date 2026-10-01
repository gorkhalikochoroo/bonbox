/**
 * Drikkepenge, walked the way an owner splits a week's tip jar.
 *
 * What each block pins, and the defect it came from:
 *
 *   1. A pool covers a PERIOD. The form had one date and fetched that one
 *      day's hours, so a week's jar was split by whoever worked on Sunday.
 *      Now: from/to, defaulting to the last 7 business days, quick chips, and
 *      every entry in the range summed per person.
 *   2. No øre lost. 100,00 kr. over three people stored 99,99 kr. and printed
 *      "Afrundingsforskel: 0,01 kr." for a øre given to nobody.
 *   3. The rows are there BEFORE an amount is typed — the banner told the
 *      owner to enter hours "above" while there was nothing above.
 *   4. A failed read is never "nothing": not "no staff", not "no history",
 *      and nothing can be saved on top of it.
 *   5. History names people, prints the period in words, and locking or
 *      deleting a pool asks first, through useConfirm.
 *   6. No emoji anywhere on the screen; status chips amber/emerald, no yellow.
 *
 * t() returns the English fallback, so assertions read shipped copy; money is
 * DKK, which formats Danish whatever the language.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    delete: (...a) => del(...a),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, currency: "DKK", role: "owner" } }),
}));
const fill = (s, vars) =>
  vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => (typeof fb === "string" ? fill(fb, vars) : fill(k, fb)),
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
const confirmDialog = vi.fn();
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmDialog }));

const StaffTipsPage = (await import("../pages/StaffTipsPage")).default;

// Wednesday 23 September 2026, midday: the business day is the 23rd.
const NOW = new Date(2026, 8, 23, 12, 0, 0);

const MEMBERS = [
  { id: "a", name: "Ali", contract_type: "full", role: "kitchen", active: true },
  { id: "b", name: "Sara", contract_type: "part", role: "bar", active: true },
  { id: "c", name: "Mia", contract_type: "full", role: "server", active: true },
];
// Ali's week is two entries; everyone ends on 37,5 t.
const ENTRIES = [
  { staff_id: "a", date: "2026-09-18", total_hours: 7.5, entry_method: "clock", end_time: "22:00" },
  { staff_id: "a", date: "2026-09-21", total_hours: 30, entry_method: "quick", end_time: "23:00" },
  { staff_id: "b", date: "2026-09-19", total_hours: 37.5, entry_method: "quick", end_time: "23:00" },
  { staff_id: "c", date: "2026-09-20", total_hours: 37.5, entry_method: "quick", end_time: "23:00" },
];
const POOL = {
  id: "t1", date: "2026-09-20", period_start: "2026-09-14", total_amount: 1000,
  split_method: "hours", confirmed: false, created_at: "2026-09-20T22:00:00",
  distributions: [
    { id: "d1", tip_id: "t1", staff_id: "a", staff_name: "Ali", amount: 750, share_pct: 75, hours: 37.5 },
    { id: "d2", tip_id: "t1", staff_id: "b", staff_name: "Sara", amount: 250, share_pct: 25, hours: 12.5 },
  ],
};

let responses;
const respond = (overrides = {}) => {
  responses = {
    "/staff/members": () => Promise.resolve({ data: MEMBERS }),
    "/staff/hours": () => Promise.resolve({ data: ENTRIES }),
    "/staff/tips": () => Promise.resolve({ data: [POOL] }),
    ...overrides,
  };
  get.mockImplementation((url) => (responses[url] || (() => Promise.resolve({ data: [] })))());
};
const fail = () => Promise.reject({ response: { status: 500 } });

const mount = () => render(<MemoryRouter><StaffTipsPage /></MemoryRouter>);
const hoursCalls = () => get.mock.calls.filter(([url]) => url === "/staff/hours").map(([, cfg]) => cfg.params);
const amountBox = (container) => container.querySelector('input[type="text"][inputmode="decimal"]');
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}]|\u{FE0F}/u;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.setItem("lang", "da");
  get.mockReset(); post.mockReset(); del.mockReset(); confirmDialog.mockReset();
  post.mockResolvedValue({ data: {} });
  del.mockResolvedValue({ data: { ok: true } });
  respond();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("a pool covers a period", () => {
  it("defaults to the last 7 business days and sums every entry per person", async () => {
    const { container } = mount();
    await waitFor(() => expect(hoursCalls()).toContainEqual({ from: "2026-09-17", to: "2026-09-23" }));
    // Ali's two entries are one row of 37,5 t — before any amount is typed.
    await waitFor(() => expect(screen.getByLabelText(/Ali/)).toBeTruthy());
    expect(screen.getByLabelText(/Ali/).value).toBe("37.5");
    expect(amountBox(container).value).toBe("");
    expect(screen.queryByText(/No hours logged/)).toBeNull();
  });

  it("this week and last week are one tap each", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("This week")).toBeTruthy());
    fireEvent.click(screen.getByText("This week"));
    await waitFor(() => expect(hoursCalls()).toContainEqual({ from: "2026-09-21", to: "2026-09-23" }));
    fireEvent.click(screen.getByText("Last week"));
    await waitFor(() => expect(hoursCalls()).toContainEqual({ from: "2026-09-14", to: "2026-09-20" }));
  });

  it("a custom range that ends before it starts is refused, not fetched", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Pick dates")).toBeTruthy());
    fireEvent.click(screen.getByText("Pick dates"));
    const [from] = screen.getAllByDisplayValue("2026-09-17");
    const before = hoursCalls().length;
    fireEvent.change(from, { target: { value: "2026-09-25" } });
    expect(screen.getByText("The period has to start before it ends.")).toBeTruthy();
    expect(hoursCalls().length).toBe(before);
  });
});

describe("øre are never lost", () => {
  it("100,00 kr. over three equal shares is 100,00 kr., and the spare øre is named", async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Ali/)).toBeTruthy());
    fireEvent.change(amountBox(container), { target: { value: "100,00" } });
    const table = container.querySelector("table");
    expect(within(table).getByText("33,34 kr.")).toBeTruthy();
    expect(within(table).getAllByText("33,33 kr.").length).toBe(2);
    expect(within(table.querySelector("tfoot")).getByText("100,00 kr.")).toBeTruthy();
    expect(screen.getAllByText("0,01 kr. extra to Ali (rounding)").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Rounding difference/)).toBeNull();
  });

  it("saves the period and a split that adds up to the øre", async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Ali/)).toBeTruthy());
    fireEvent.change(amountBox(container), { target: { value: "100,00" } });
    fireEvent.click(screen.getByRole("button", { name: /^Distribute 100,00 kr\./ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/staff/tips");
    expect(body.date).toBe("2026-09-23");
    expect(body.period_start).toBe("2026-09-17");
    expect(body.total_amount).toBe(100);
    const ore = body.distribution.map((d) => Math.round(d.amount * 100));
    expect(ore.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(body.staff_hours.map((s) => s.hours)).toEqual([37.5, 37.5, 37.5]);
  });
});

describe("a failed read is never an answer", () => {
  it("a failed roster says so, and nothing can be saved", async () => {
    respond({ "/staff/members": fail });
    const { container } = mount();
    await waitFor(() => expect(screen.getByText("Couldn't load your staff.")).toBeTruthy());
    expect(screen.queryByText("No staff found")).toBeNull();
    fireEvent.change(amountBox(container), { target: { value: "500" } });
    expect(screen.getByRole("button", { name: /^Distribute/ }).disabled).toBe(true);
    expect(screen.getByText(/Saving is paused/)).toBeTruthy();
  });

  it("failed hours are not a page of zeros", async () => {
    respond({ "/staff/hours": fail });
    mount();
    await waitFor(() => expect(screen.getByText("Couldn't load the hours for this period.")).toBeTruthy());
    expect(screen.queryByLabelText(/Ali/)).toBeNull();
    expect(screen.queryByText(/No hours logged/)).toBeNull();
  });

  it("a failed history is not 'no tip distributions yet'", async () => {
    respond({ "/staff/tips": fail });
    mount();
    fireEvent.click(screen.getByText("History"));
    await waitFor(() => expect(screen.getByText("Couldn't load the tip history.")).toBeTruthy());
    expect(screen.queryByText("No tip distributions yet")).toBeNull();
  });
});

describe("history", () => {
  const openHistory = async () => {
    const utils = mount();
    fireEvent.click(screen.getByText("History"));
    await waitFor(() => expect(screen.getByText("14.–20. sep.")).toBeTruthy());
    return utils;
  };

  it("names people, prints the period in words and reads hours as 37,5 t", async () => {
    const { container } = await openHistory();
    expect(screen.getByText("Ali: 750,00 kr.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Staff #|Medarbejder #/);
    expect(container.textContent).not.toMatch(/2026-09-14/);
    fireEvent.click(screen.getByText("14.–20. sep."));
    expect(screen.getByText("37,5 t · 75 %")).toBeTruthy();
    expect(screen.getByText("12,5 t · 25 %")).toBeTruthy();
  });

  it("amber for a pool still to decide, never yellow", async () => {
    const { container } = await openHistory();
    const chip = screen.getByText("Pending");
    expect(chip.className).toMatch(/amber/);
    expect(container.innerHTML).not.toMatch(/yellow-/);
  });

  it("locking asks first, naming the amount and the period", async () => {
    await openHistory();
    fireEvent.click(screen.getByText("14.–20. sep."));
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: /Confirm Distribution/ }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    const asked = confirmDialog.mock.calls[0][0];
    expect(asked.message).toContain("1.000,00 kr.");
    expect(asked.message).toContain("14.–20. sep.");
    expect(asked.message).toMatch(/can't be changed/);
    expect(post).not.toHaveBeenCalled();

    confirmDialog.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: /Confirm Distribution/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/staff/tips/t1/confirm"));
  });

  it("an unconfirmed pool can be deleted, after a destructive confirm", async () => {
    await openHistory();
    fireEvent.click(screen.getByText("14.–20. sep."));
    confirmDialog.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/staff/tips/t1"));
    expect(confirmDialog.mock.calls[0][0].destructive).toBe(true);
  });

  it("a confirmed pool offers neither", async () => {
    respond({ "/staff/tips": () => Promise.resolve({ data: [{ ...POOL, confirmed: true }] }) });
    await openHistory();
    fireEvent.click(screen.getByText("14.–20. sep."));
    expect(screen.getByText("Confirmed", { selector: "span" }).className).toMatch(/emerald/);
    expect(screen.queryByRole("button", { name: /^Delete$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirm Distribution/ })).toBeNull();
  });
});

it("no emoji anywhere on either tab", async () => {
  const { container } = mount();
  await waitFor(() => expect(screen.getByLabelText(/Ali/)).toBeTruthy());
  fireEvent.change(amountBox(container), { target: { value: "100,00" } });
  expect(container.textContent).not.toMatch(EMOJI);
  fireEvent.click(screen.getByText("History"));
  await waitFor(() => expect(screen.getByText("14.–20. sep.")).toBeTruthy());
  fireEvent.click(screen.getByText("14.–20. sep."));
  expect(container.textContent).not.toMatch(EMOJI);
});
