/**
 * Release gate R-b (9 Oct) — Daily close History, small truth fixes.
 *
 *   • The period count said "1 låste · 1 i kladde": one locked close is
 *     "1 låst" (singular), on the range line and in the "sent from here"
 *     record.
 *   • The held-owner period line said "Indtil da giver Send dig Excel-filen",
 *     but Send first shows a notice whose button "Send fra min egen mail"
 *     hands over the file: the line now says exactly that.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
let entitled = true;
let cap = 31;
let closes = [];
let sends = [];
let profile = {};
let rangeCounts = null;
let authUser = {};
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authUser, refreshUser: vi.fn(async () => authUser) }),
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
  useEntitlements: () => ({
    hasFeature: (k) => (k === "direct_accountant_email" ? entitled : true),
    minPlanForFeature: () => null,
    isReady: true,
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
  sendDailyCloseRangeToAccountant: () => Promise.resolve({ ok: true, channel: "mailto" }),
}));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const close = (id, date, status = "confirmed", extra = {}) => ({
  id, date, status, revenue_total: 1000, revenue_breakdown: { food: 1000 },
  payment_breakdown: { card: 1000 }, payment_total: 1000, moms_total: 200,
  revenue_ex_moms: 800, closed_by: "Lars", email_sent_to: [], ...extra,
});

const realConfirm = window.confirm;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00"));
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  entitled = true;
  cap = 31;
  sends = [];
  rangeCounts = null;
  authUser = { currency: "DKK", business_type: "restaurant", email: "login@x.dk" };
  profile = { accountant_email: "anna@revisor.dk", company_name: "Mirabelle ApS", email: "info@mirabelle.dk" };
  closes = [
    close("S1", "2026-09-10"), close("S2", "2026-09-12"), close("S3", "2026-09-14", "draft"),
    close("O1", "2026-10-06"), close("O2", "2026-10-05", "draft"),
  ];
  window.URL.createObjectURL = () => "blob:http://localhost/x";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/business") return Promise.resolve({ data: profile });
    if (url === "/billing/me") return Promise.resolve({ data: { plan: cap < 31 ? "free" : "starter", caps: { daily_close_export_days: cap } } });
    if (url === "/daily-close/accountant-sends") return Promise.resolve({ data: sends });
    if (url === "/daily-close/range-counts") return Promise.resolve({ data: rangeCounts || {} });
    if (String(url).startsWith("/daily-close/export.") || String(url).endsWith("/pdf")) {
      return Promise.resolve({ data: new Blob(["x"]), headers: {} });
    }
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { ok: true, sent_to: "anna@revisor.dk" } });
});
afterEach(() => {
  vi.useRealTimers();
  window.confirm = realConfirm;
});

const openHistory = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};
const exportCalls = () => get.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/daily-close/export."));

import { da } from "../i18n/da";
import { en } from "../i18n/en";

describe("one locked close is singular", () => {
  it("the range line: '1 låst · 1 i kladde', not '1 låste'", async () => {
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    expect(await screen.findByText(/dcRangeLockedOneAndDrafts:1/)).toBeInTheDocument();
    expect(screen.queryByText(/dcRangeLockedAndDrafts:1\|1/)).toBeNull();
    expect(da.dcRangeLockedOneAndDrafts.replace("{drafts}", "1")).toBe("1 låst · 1 i kladde");
  });

  it("two or more keep the plural line", async () => {
    closes = [...closes, close("O3", "2026-10-04")];
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    expect(await screen.findByText(/dcRangeLockedAndDrafts:2\|1/)).toBeInTheDocument();
  });

  it("the 'sent from here' record of one close: '1 låst'", async () => {
    sends = [{ sent_at: "2026-10-06T07:14:00", recipient: "anna@revisor.dk", format: "xlsx",
      from: "2026-10-06", to: "2026-10-06", n_closes: 1, n_drafts: 0 }];
    await openHistory();
    const rec = await screen.findByTestId("dc-recent-sends");
    expect(rec.textContent).toContain("dcRecentSendLineOne:");
    expect(rec.textContent).not.toContain("dcRecentSendLine:");
    expect(da.dcRecentSendLineOne).toContain("· 1 låst ·");
    expect(en.dcRecentSendLineOne).toContain("· 1 locked ·");
  });
});

describe("the held-owner period line says what Send does", () => {
  it("names the button the owner taps for the file — never 'Send giver dig {format}-filen'", () => {
    for (const k of ["dcSendToLineHeldUnverified", "dcSendToLineHeldClaimOpen"]) {
      expect(da[k]).toContain(da.dcSendViaOwnMail);
      expect(en[k]).toContain(en.dcSendViaOwnMail);
      expect(da[k]).not.toMatch(/giver Send dig/);
      expect(en[k]).not.toMatch(/Send gives you/);
      expect(da[k]).toContain("{format}");
      expect(da[k]).toContain("{email}");
    }
  });

  it("…and Send does that: a notice with that button, no mail to the revisor", async () => {
    authUser = { ...authUser, email_verified: false };
    window.confirm = vi.fn(() => true);
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    const line = await screen.findByTestId("dc-send-to-line-held");
    expect(line.textContent).toMatch(/^dcSendToLineHeldUnverified:/);
    const btn = screen.getByRole("button", { name: /sendToAccountantBtn/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText("dcSendViaOwnMail")).toBeInTheDocument();
    expect(post.mock.calls.some(([u]) => String(u).includes("send-to-accountant"))).toBe(false);
  });
});
