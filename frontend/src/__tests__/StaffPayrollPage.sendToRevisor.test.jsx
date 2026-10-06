/**
 * Løn: "Send til revisor" says who, what and how approved — and Enter does
 * not mail it.
 *
 * The confirm read "Send lønrapporten til din revisor? 8 medarbejdere, 1. sep.
 * 26 – 30. sep. 26. Du får en kopi." — not WHO receives it (a hover tooltip a
 * phone never shows), not WHAT is attached, nothing about approval, and the
 * focus sat on Send. Locks:
 *   • the confirm names the recipient (read the way the send endpoint reads
 *     it), the attachment and its period, and the hours' approval state, with
 *     "Gå til Timer" to the same period; it is `irreversible` (focus on
 *     Annuller, Enter does not send);
 *   • no revisor address → the button is disabled with a reason and a link;
 *   • the send path's open-punch refusal is the translated sentence, never the
 *     server's English `message`;
 *   • the dates read like Timer's, every export says what it is for, the
 *     total's breakdown is on the page.
 * And useConfirm's `irreversible` keyboard rule itself.
 *
 * t() returns the English fallback with vars filled, so these read shipped copy.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, currency: "DKK", role: "owner" } }),
}));
const fill = (s, vars) =>
  vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => (typeof fb === "string" ? fill(fb, vars) : fill(k, fb)),
    lang: "da", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
const confirmMock = vi.fn(async () => false);
vi.mock("../hooks/useConfirm", async (orig) => ({
  ...(await orig()),
  useConfirm: () => confirmMock,
}));

const StaffPayrollPage = (await import("../pages/StaffPayrollPage")).default;

const YEAR = new Date().getFullYear();
const CURRENT = { start_date: `${YEAR}-09-01`, end_date: `${YEAR}-09-30`, period_type: "monthly_1st", custom_start_day: null };
const MEMBERS = [
  { id: "a", name: "Ali", role: "bar", contract_type: "hourly" },
  { id: "b", name: "Sara", role: "kitchen", contract_type: "part" },
];
const SUMMARY = [
  { staff_id: "a", total_hours: 37.5, total_earned: 5625.5, tips_received: 0, overtime_hours: 0, entries_count: 30, approved_count: 28, needs_answer_count: 2 },
  { staff_id: "b", total_hours: 20, total_earned: 3000, tips_received: 0, overtime_hours: 0, entries_count: 11, approved_count: 10, needs_answer_count: 1 },
];
const ESTIMATE = {
  staff_count: 2,
  totals: { gross: 44317.67, am_bidrag: 1, a_skat: 1, net_pay: 1, atp: 189.33, feriepenge: 5539.7, employer_total_cost: 50046.7, hours: 57.5 },
  skat_remit: { total: 2, am_bidrag: 1, a_skat: 1 },
  per_staff: [],
  estimate_note: "x",
};

let responses;
const respond = (overrides = {}) => {
  responses = {
    "/staff/pay-period/current": () => Promise.resolve({ data: CURRENT }),
    "/staff/members": () => Promise.resolve({ data: MEMBERS }),
    "/staff/hours/summary": () => Promise.resolve({ data: SUMMARY }),
    "/staff/payroll/estimate": () => Promise.resolve({ data: ESTIMATE }),
    "/weather/sick-calls": () => Promise.resolve({ data: [] }),
    "/weather/sick-calls/stats": () => Promise.resolve({ data: { this_month: 0, last_month: 0, weather_related: 0 } }),
    "/business": () => Promise.resolve({ data: { accountant_email: " Anna@Revisor.dk ", accountant_name: "Anna Hansen" } }),
    ...overrides,
  };
  get.mockImplementation((url) => (responses[url] || (() => Promise.resolve({ data: [] })))());
};

let where = "";
function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  return null;
}
const mount = () => render(
  <MemoryRouter initialEntries={["/staff/hours?tab=payroll"]}>
    <Routes><Route path="*" element={<><StaffPayrollPage /><Where /></>} /></Routes>
  </MemoryRouter>,
);
const sendBtn = () => screen.getByRole("button", { name: /Send to accountant/ });
// The hours (and so their approval state) have arrived.
const ready = async () => {
  await screen.findByTestId("pay-approval");
  await waitFor(() => expect(sendBtn().disabled).toBe(false));
};

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  get.mockReset(); post.mockReset();
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => false);
  respond();
});

describe("the send confirm says who, what and how approved", () => {
  it("names the recipient, the attachment and the approval state; Annuller holds the focus", async () => {
    mount();
    await ready();
    // On the page too, before the tap.
    expect(screen.getByTestId("pay-send-recipient").textContent).toContain("Anna Hansen · anna@revisor.dk");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const opts = confirmMock.mock.calls[0][0];
    expect(opts.irreversible).toBe(true);
    expect(opts.extraLabel).toBe("Go to Hours");
    const { container } = render(<div>{opts.message}</div>);
    const text = container.textContent;
    expect(text).toContain("To: Anna Hansen · anna@revisor.dk");
    expect(text).toMatch(/Attached: payroll report \(PDF\), 1\.? Sep\w*\.? – 30\.? Sep\w*\.? \d{4} · 2 employees/i);
    expect(text).toContain("38 of 41 entries approved · 3 shifts need an answer");
    expect(post).not.toHaveBeenCalled();     // answered "no"
  });

  it("'Gå til Timer' opens Timer's per-staff view on the same period", async () => {
    confirmMock.mockImplementation(async () => "extra");
    mount();
    await ready();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(where).toContain("view=details"));
    const q = new URLSearchParams(where.split("?")[1]);
    expect(q.get("tab")).toBe("hours");
    expect(q.get("from")).toBe(`${YEAR}-09-01`);
    expect(q.get("to")).toBe(`${YEAR}-09-30`);
    expect(post).not.toHaveBeenCalled();
  });

  it("a yes sends — the owner decides, unapproved or not", async () => {
    confirmMock.mockImplementation(async () => true);
    post.mockResolvedValue({ data: { ok: true, sent_to: "anna@revisor.dk", cc_self: true } });
    mount();
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(post).toHaveBeenCalledWith("/staff/payroll/send-to-accountant", expect.objectContaining({
      period_start: `${YEAR}-09-01`, period_end: `${YEAR}-09-30`,
    })));
  });

  it("with no revisor address the button is disabled, says why, and links to where it is set", async () => {
    respond({ "/business": () => Promise.resolve({ data: { accountant_email: null } }) });
    mount();
    await waitFor(() => expect(screen.getByText(/to send from here/)).toBeTruthy());
    expect(sendBtn().disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Profile" }).getAttribute("href")).toBe("/profile#billing");
  });

  it("the send path's open-punch refusal is the translated sentence, not the server's English", async () => {
    confirmMock.mockImplementation(async () => true);
    post.mockRejectedValue({ response: { status: 409, data: { detail: {
      code: "open_punches", count: 1, list: "Sara 26/9", message: "1 shift has no clock-out (server English).",
    } } } });
    mount();
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByText(/1 shift has no clock-out \(Sara 26\/9\)\. Fix it under Timer first/)).toBeTruthy());
    expect(screen.queryByText(/server English/)).toBeNull();
    // …and the fix is one tap away.
    expect(screen.getAllByRole("link", { name: /Go to Hours/ }).length).toBeGreaterThan(0);
  });
});

describe("the rest of the tab", () => {
  it("dates read like Timer's, not '01/09/26 – 30/09/26'", async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId("pay-send-recipient").textContent).toContain("anna@revisor.dk"));
    expect(container.textContent).not.toMatch(/01\/09\/\d\d/);
    expect(container.textContent).toMatch(/1\.? Sep\w*\.? – 30\.? Sep\w*\.?/i);
  });

  it("every export says what it is for, and the revisor's path is the primary one", async () => {
    mount();
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    expect(screen.getByText(/the file your revisor needs/)).toBeTruthy();
    expect(screen.getByText(/The same report your revisor gets/)).toBeTruthy();
    expect(screen.getByText(/For whoever keys the pay into DataLøn or Zenegy/)).toBeTruthy();
    expect(screen.getByText(/One lønseddel for each employee/)).toBeTruthy();
    expect(screen.getByText(/not for your revisor/)).toBeTruthy();
    // The accent (green) button is Send; the downloads are secondary.
    expect(sendBtn().className).toMatch(/bg-emerald-600/);
    expect(screen.getByRole("button", { name: /Download payroll report/ }).className).not.toMatch(/bg-emerald/);
  });

  it("the total shows how it is made", async () => {
    mount();
    const line = await screen.findByTestId("pay-cost-breakdown");
    expect(line.textContent).toBe("Gross wages 44.317,67 kr. + feriepenge 5.539,70 kr. + ATP 189,33 kr. = 50.046,70 kr.");
  });

  it("the approval state is on the page, with the way to Timer", async () => {
    mount();
    const el = await screen.findByTestId("pay-approval");
    expect(el.textContent).toContain("38 of 41 entries approved · 3 shifts need an answer");
    expect(el.className).toMatch(/amber/);
  });
});

// ── useConfirm: `irreversible` ───────────────────────────────────────────

describe("useConfirm irreversible", () => {
  it("focuses Cancel, Enter does not confirm, and the extra way out resolves 'extra'", async () => {
    const { ConfirmProvider, useConfirm: realUseConfirm } = await vi.importActual("../hooks/useConfirm");
    let answer;
    function Asker({ opts }) {
      const ask = realUseConfirm();
      return <button onClick={async () => { answer = await ask(opts); }}>ask</button>;
    }
    const { unmount } = render(
      <ConfirmProvider><Asker opts={{ title: "Send?", message: "x", confirmLabel: "Send", irreversible: true, extraLabel: "Go to Hours" }} /></ConfirmProvider>,
    );
    fireEvent.click(screen.getByText("ask"));
    const cancel = await screen.findByRole("button", { name: /dlgCancel|Cancel/ });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    // Enter on a guarded dialog does nothing.
    fireEvent.keyDown(document, { key: "Enter" });
    await act(async () => {});
    expect(answer).toBeUndefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to Hours" }));
    await waitFor(() => expect(answer).toBe("extra"));
    unmount();
  });
});
