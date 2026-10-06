/**
 * Drikkepenge — what testers hit on the split card (Oct 2026).
 *
 *   a. Dark mode: the "Fordel 2.340,00 kr." button was a hand-rolled
 *      bg-gray-900 with no dark pair and vanished on the dark page. It is the
 *      shared <Button variant="primary"> now (gray-100 in dark).
 *   b. Phone: five columns were 409 px in a 356 px card and cut BELØB off.
 *      Below sm the share % column is hidden and "37,5 t · 33,3 %" sits under
 *      the name; a custom split keeps the share (it's typed there) and moves
 *      the hours to that line instead.
 *   c. The open-shift warning said "1 vagt …" without saying whose, as plain
 *      text. It names the person and links to Timer on the same period.
 *   d. "Bekræft fordeling" said what confirming does only in the next dialog.
 *      The card says it under the button.
 *   e. "Forhåndsvis fordeling" repeated the table already on screen. Gone.
 *   f. The tip total's <label> was not tied to its input.
 *
 * Same mocks as StaffTipsPage.poolPeriod.test.jsx: t() returns the English
 * fallback, money is DKK (Danish notation), the language is Danish.
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

// Wednesday 23 September 2026, midday: the default period is 17–23 Sept.
const NOW = new Date(2026, 8, 23, 12, 0, 0);

const MEMBERS = [
  { id: "a", name: "Ali", contract_type: "full", role: "kitchen", active: true },
  { id: "b", name: "Sara", contract_type: "part", role: "bar", active: true },
  { id: "c", name: "Mia", contract_type: "full", role: "server", active: true },
];
const ENTRIES = [
  { staff_id: "a", date: "2026-09-18", total_hours: 37.5, entry_method: "quick", end_time: "22:00" },
  { staff_id: "b", date: "2026-09-19", total_hours: 37.5, entry_method: "quick", end_time: "23:00" },
  { staff_id: "c", date: "2026-09-20", total_hours: 37.5, entry_method: "quick", end_time: "23:00" },
];
// Sara clocked in on the 21st and never out: 0 hours on the books.
const SARA_OPEN = { staff_id: "b", date: "2026-09-21", total_hours: 0, entry_method: "clock", end_time: null };
const MIA_OPEN = { staff_id: "c", date: "2026-09-22", total_hours: 0, entry_method: "clock", end_time: null };
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

const mount = () => render(<MemoryRouter><StaffTipsPage /></MemoryRouter>);
const ready = () => waitFor(() => expect(screen.getByLabelText(/Hours — Ali/)).toBeTruthy());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.setItem("lang", "da");
  get.mockReset(); post.mockReset(); del.mockReset(); confirmDialog.mockReset();
  post.mockResolvedValue({ data: {} });
  respond();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("the open-shift warning says whose shift and goes to Timer", () => {
  it("one open shift: names the person and the day, links to Timer on this period", async () => {
    respond({ "/staff/hours": () => Promise.resolve({ data: [...ENTRIES, SARA_OPEN] }) });
    mount();
    await ready();
    const box = await screen.findByTestId("tip-open-shifts");
    expect(box.textContent).toContain("A shift for Sara on 21. sep. has no clock-out, so it counts as 0 hours.");
    const link = within(box).getByRole("link", { name: /Fix it under Hours/ });
    const href = new URL(link.getAttribute("href"), "http://x");
    expect(href.pathname).toBe("/staff/hours");
    expect(href.searchParams.get("tab")).toBe("hours");
    expect(href.searchParams.get("view")).toBe("details");
    expect(href.searchParams.get("from")).toBe("2026-09-17");
    expect(href.searchParams.get("to")).toBe("2026-09-23");
    // One person: Timer opens straight on her answer sheet.
    expect(href.searchParams.get("resolve")).toBe("b");
    // Amber — it needs the owner — never red.
    expect(box.className).toMatch(/amber/);
    expect(box.className).not.toMatch(/red-/);
  });

  it("the link follows the period on screen", async () => {
    respond({ "/staff/hours": () => Promise.resolve({ data: [...ENTRIES, SARA_OPEN] }) });
    mount();
    await ready();
    fireEvent.click(screen.getByText("This week"));
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /Fix it under Hours/ });
      expect(link.getAttribute("href")).toContain("from=2026-09-21&to=2026-09-23");
    });
  });

  it("several open shifts name everyone, and no single sheet is pre-opened", async () => {
    respond({ "/staff/hours": () => Promise.resolve({ data: [...ENTRIES, SARA_OPEN, MIA_OPEN] }) });
    mount();
    await ready();
    const box = await screen.findByTestId("tip-open-shifts");
    expect(box.textContent).toContain("2 shifts in this period have no clock-out and count as 0 hours: Sara og Mia.");
    const link = within(box).getByRole("link", { name: /Fix them under Hours/ });
    expect(link.getAttribute("href")).not.toContain("resolve=");
  });

  it("no open shift, no warning", async () => {
    mount();
    await ready();
    expect(screen.queryByTestId("tip-open-shifts")).toBeNull();
  });
});

describe("the split card", () => {
  it("the tip total is a labelled field", async () => {
    mount();
    await ready();
    const box = screen.getByLabelText(/Total Tips/);
    expect(box.tagName).toBe("INPUT");
    fireEvent.change(box, { target: { value: "100,00" } });
    expect(screen.getByRole("button", { name: /^Distribute 100,00 kr\./ })).toBeTruthy();
  });

  it("there is no second 'Preview distribution' — the table is the preview", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText(/Total Tips/), { target: { value: "100,00" } });
    expect(screen.queryByText(/Preview Distribution/i)).toBeNull();
    expect(screen.queryByText(/Distribution Preview/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
  });

  it("the save button is the shared primary, with its dark-mode pair", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText(/Total Tips/), { target: { value: "2340" } });
    const save = screen.getByRole("button", { name: /^Distribute 2\.340,00 kr\./ });
    expect(save.className).toMatch(/\bbg-gray-900\b/);
    expect(save.className).toMatch(/dark:bg-gray-100/);
    expect(save.className).toMatch(/dark:text-gray-900/);
  });

  it("below sm the share % column hides and the share moves under the name", async () => {
    const { container } = mount();
    await ready();
    const shareHead = screen.getByRole("columnheader", { name: "Share %" });
    expect(shareHead.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(shareHead.className).toMatch(/sm:table-cell/);
    // Every share cell and the total follow the header.
    const rows = container.querySelectorAll("tbody tr");
    rows.forEach((tr) => {
      const cells = tr.querySelectorAll("td");
      expect(cells[2].className).toMatch(/hidden sm:table-cell/);
    });
    // The person, the hours they typed in, the amount: always visible.
    expect(screen.getByRole("columnheader", { name: "Amount" }).className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByRole("columnheader", { name: "Hours" }).className).not.toMatch(/(^|\s)hidden(\s|$)/);
    // Danish numbers, phone-only line.
    const facts = screen.getAllByTestId("tip-row-facts");
    expect(facts[0].textContent).toBe("37,5 t · 33,3 %");
    expect(facts[0].className).toMatch(/sm:hidden/);
  });

  it("a custom split keeps the share column (it's typed there) and moves hours to the line", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByText("Custom Ratio"));
    expect(screen.getByRole("columnheader", { name: "Share %" }).className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByRole("columnheader", { name: "Hours" }).className).toMatch(/hidden sm:table-cell/);
    expect(screen.getAllByTestId("tip-row-facts")[0].textContent).toBe("37,5 t");
  });

  it("the role split's weight column is desktop-only too", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByText("By Role Share"));
    expect(screen.getByRole("columnheader", { name: "Weight" }).className).toMatch(/hidden sm:table-cell/);
  });

  it("the selected split has a visible edge in light and dark", async () => {
    mount();
    await ready();
    const on = screen.getByRole("button", { name: /By Hours Worked/ });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.className).toMatch(/border-gray-900/);
    expect(on.className).toMatch(/dark:border-gray-100/);
  });
});

describe("confirming, explained on the card", () => {
  it("a pending pool says what 'Confirm Distribution' does, right under it", async () => {
    mount();
    fireEvent.click(screen.getByText("History"));
    await waitFor(() => expect(screen.getByText("14.–20. sep.")).toBeTruthy());
    fireEvent.click(screen.getByText("14.–20. sep."));
    expect(screen.getByRole("button", { name: /Confirm Distribution/ })).toBeTruthy();
    expect(screen.getByTestId("tip-confirm-hint").textContent)
      .toBe("Locks the split and shows it to your staff.");
  });

  it("a confirmed pool does not carry the hint", async () => {
    respond({ "/staff/tips": () => Promise.resolve({ data: [{ ...POOL, confirmed: true }] }) });
    mount();
    fireEvent.click(screen.getByText("History"));
    await waitFor(() => expect(screen.getByText("14.–20. sep.")).toBeTruthy());
    fireEvent.click(screen.getByText("14.–20. sep."));
    expect(screen.queryByTestId("tip-confirm-hint")).toBeNull();
  });
});
