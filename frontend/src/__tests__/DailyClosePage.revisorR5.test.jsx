/**
 * Revisor artifacts, round 5 — a demo day says it is an example.
 *
 * 1. History marks a demo seeder's sample day with an "Eksempel" chip.
 * 2. A locked demo day never offers "Send til revisor" / "Send igen" (the
 *    server always answers 409 demo_close): the row says "Eksempeldag —
 *    sendes aldrig til revisoren" under the owner-only copy line, which stays.
 * 3. A real day in the same list keeps its send button.
 * 4. The own-mail fallback never greets the sample revisor by name when it
 *    has no recipient; a real revisor who opted out keeps their name (only
 *    the address is not pre-filled).
 * 5. With the sample revisor, a demo day keeps the "save your own revisor on
 *    Profile" link — it is a link, not a send.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const confirmMock = vi.fn();
const ownMail = vi.fn();
let closes = [];
let profile = {};
let entitled = true;
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant", email: "login@x.dk" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmMock }));
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
  useEntitlements: () => ({
    hasFeature: (k) => (k === "direct_accountant_email" ? entitled : true),
    minPlanForFeature: () => null, isReady: true,
  }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/shareDailyCloseRange", () => ({
  sendDailyCloseRangeToAccountant: (...a) => ownMail(...a),
}));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const close = (id, date, status = "confirmed", extra = {}) => ({
  id, date, status, revenue_total: 1000, revenue_breakdown: { food: 1000 },
  payment_breakdown: { card: 1000 }, payment_total: 1000, moms_total: 200,
  revenue_ex_moms: 800, closed_by: "Lars", email_sent_to: [], ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00"));
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(false);
  ownMail.mockReset();
  ownMail.mockResolvedValue({ ok: true, channel: "mailto" });
  entitled = true;
  // A REAL revisor saved after trying the demo.
  profile = { accountant_email: "pia@realrevisor.dk", accountant_name: "Pia Jensen", company_name: "Mirabelle ApS" };
  closes = [];
  window.URL.createObjectURL = () => "blob:http://localhost/x";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/business") return Promise.resolve({ data: profile });
    if (url === "/billing/me") return Promise.resolve({ data: { plan: "starter", caps: { daily_close_export_days: 31 } } });
    if (url === "/daily-close/accountant-sends") return Promise.resolve({ data: [] });
    if (url === "/daily-close/range-counts") return Promise.resolve({ data: {} });
    if (String(url).startsWith("/daily-close/export.") || String(url).endsWith("/pdf")) {
      return Promise.resolve({ data: new Blob(["x"]), headers: {} });
    }
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: {} });
});
afterEach(() => {
  vi.useRealTimers();
});

const openHistory = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};

const card = (id) => document.querySelector(`[data-close-id="${id}"]`);

describe("a locked demo day in History", () => {
  it("has an Eksempel chip, the demo line and no send button; the owner-only line stays", async () => {
    closes = [close("D1", "2026-10-06", "confirmed", {
      notes: "sample · demo", email_status: "sent", email_sent_to: ["login@x.dk"],
      email_sent_at: "2026-10-06T21:12:00",
    })];
    await openHistory();
    const line = await screen.findByTestId("dc-mail-demo-day");
    expect(line).toHaveTextContent("dcMailDemoDayNever");
    const c = card("D1");
    expect(within(c).getByTestId("dc-demo-chip")).toHaveTextContent("dcDemoChip");
    // The owner-only copy wording stays.
    expect(within(c).getByText(/dcMailOwnerOnly:/)).toBeInTheDocument();
    // …but nothing offers a send the server always refuses.
    expect(within(c).queryByRole("button", { name: /dcMailSendToRevisor/ })).toBeNull();
    expect(within(c).queryByRole("button", { name: /dcMailSendAgain/ })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("a failed or auto-off demo day offers no Send igen either", async () => {
    closes = [
      close("D1", "2026-10-06", "confirmed", { notes: "sample · demo", email_status: "send_failed", email_error: "send_error: x" }),
      close("D2", "2026-10-05", "confirmed", { notes: "sample · demo", email_status: "skipped_preference_off" }),
    ];
    await openHistory();
    await waitFor(() => expect(screen.getAllByTestId("dc-mail-demo-day")).toHaveLength(2));
    for (const id of ["D1", "D2"]) {
      expect(within(card(id)).queryByRole("button", { name: /dcMailSendAgain|dcMailSendToRevisor/ })).toBeNull();
    }
  });

  it("a real day beside it keeps its chip-less card and its send button", async () => {
    closes = [
      close("R1", "2026-10-06", "confirmed", { notes: "rigtig dag", email_status: "sent", email_sent_to: ["login@x.dk"] }),
      close("D1", "2026-10-05", "confirmed", { notes: "sample · demo", email_status: "sent", email_sent_to: ["login@x.dk"] }),
    ];
    await openHistory();
    await screen.findByTestId("dc-mail-demo-day");
    const real = card("R1");
    expect(within(real).queryByTestId("dc-demo-chip")).toBeNull();
    expect(within(real).queryByTestId("dc-mail-demo-day")).toBeNull();
    expect(within(real).getByRole("button", { name: /dcMailSendToRevisor/ })).toBeInTheDocument();
  });

  it("with the sample revisor, the Profile link stays — and still no send button", async () => {
    profile = { accountant_email: "anna@revisor.dk", accountant_name: "Anna Hansen",
      accountant_is_demo: true, company_name: "Mirabelle ApS" };
    closes = [close("D1", "2026-10-06", "confirmed", {
      notes: "sample · demo", email_status: "sent", email_sent_to: ["login@x.dk"],
      email_sent_at: "2026-10-06T21:12:00",
    })];
    await openHistory();
    await screen.findByTestId("dc-mail-demo-day");
    const c = card("D1");
    expect(within(c).getByText(/dcMailOwnerOnlyDemoRevisor:/)).toBeInTheDocument();
    // The way to replace the sample revisor is a link, not a send.
    const link = within(c).getByRole("link", { name: "dcRevisorIsDemoCta" });
    expect(link).toHaveAttribute("href", "/profile");
    expect(within(c).queryByRole("button", { name: /dcMailSendToRevisor|dcMailSendAgain/ })).toBeNull();
  });

  it("a seeded day nobody sent (no status) shows the chip and no send line", async () => {
    closes = [close("D1", "2026-10-06", "confirmed", { notes: "sample · demo", email_status: null })];
    await openHistory();
    await waitFor(() => expect(within(card("D1")).getByTestId("dc-demo-chip")).toBeInTheDocument());
    expect(within(card("D1")).queryByRole("button", { name: /dcMailSendToRevisor/ })).toBeNull();
  });
});

describe("own-mail fallback with the sample revisor", () => {
  it("opens with no recipient AND no sample name in the greeting", async () => {
    // A seeded profile: the server says the company is the sample's too.
    profile = { accountant_email: "anna@revisor.dk", accountant_name: "Anna Hansen",
      accountant_is_demo: true, identity_is_demo: true, company_name: "Mirabelle ApS" };
    closes = [close("O1", "2026-10-06", "confirmed", { email_status: "sent", email_sent_to: ["login@x.dk"] })];
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(ownMail).toHaveBeenCalled());
    expect(ownMail.mock.calls[0][0].accountantEmail).toBe("");
    expect(ownMail.mock.calls[0][0].accountantName).toBe("");
  });

  it("a real saved revisor is still named", async () => {
    // Free path: no direct send, so Send opens the owner's own mail.
    entitled = false;
    closes = [close("O1", "2026-10-06", "confirmed", { email_status: "sent", email_sent_to: ["login@x.dk"] })];
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(ownMail).toHaveBeenCalled());
    expect(ownMail.mock.calls[0][0].accountantEmail).toBe("pia@realrevisor.dk");
    expect(ownMail.mock.calls[0][0].accountantName).toBe("Pia Jensen");
  });

  it("a real revisor who opted out is not pre-filled but is still greeted by name", async () => {
    profile = { accountant_email: "pia@realrevisor.dk", accountant_name: "Pia Jensen",
      accountant_opted_out: true, company_name: "Mirabelle ApS" };
    closes = [close("O1", "2026-10-06", "confirmed", { email_status: "sent", email_sent_to: ["login@x.dk"] })];
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(ownMail).toHaveBeenCalled());
    expect(ownMail.mock.calls[0][0].accountantEmail).toBe("");
    expect(ownMail.mock.calls[0][0].accountantName).toBe("Pia Jensen");
  });
});
