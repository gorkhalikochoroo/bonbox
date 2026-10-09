/**
 * The period-bundle card's "who a send goes to" line (History → Send til
 * revisor) for an owner whose revisor mail is HELD — own e-mail not
 * confirmed, or "Har du selv oprettet denne konto?" unanswered (R-a
 * follow-up, 9 Oct). It used to say "Send går til {revisor} · …" while a tap
 * on Send mails the revisor nothing and offers the file for the owner's own
 * mail. It now says that, with the one tap that lifts the hold.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";
import { en } from "../i18n/en";
import { da } from "../i18n/da";

const get = vi.fn();
const post = vi.fn();
let entitled = true;
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

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const yesterday = (() => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

const OWNER = { currency: "DKK", business_type: "restaurant", email: "ejer@cafe.dk" };

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  entitled = true;
  authUser = { ...OWNER, email_verified: true, claim_question_open: false };
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => {
    if (url === "/daily-close") {
      return Promise.resolve({ data: [{
        id: "L1", date: yesterday, status: "confirmed", revenue_total: 1000,
        revenue_breakdown: { food: 1000 }, payment_breakdown: { card: 1000 }, payment_total: 1000,
        moms_total: 200, revenue_ex_moms: 800, closed_by: "Lars",
      }] });
    }
    if (url === "/business") return Promise.resolve({ data: { accountant_email: "anna@revisor.dk", company_name: "Café Solsikken ApS" } });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { ok: true, sent_to: "anna@revisor.dk" } });
});

const openHistory = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};

describe("period card send line — revisor mail held", () => {
  it("an unconfirmed owner: says the revisor gets nothing yet, the own-mail file, and Bekræft nu", async () => {
    authUser = { ...OWNER, email_verified: false };
    await openHistory();
    const line = await screen.findByTestId("dc-send-to-line-held");
    expect(line.textContent).toMatch(/^dcSendToLineHeldUnverified:anna@revisor\.dk\|Excel/);
    expect(screen.queryByText(/^dcSendToLine:/)).toBeNull();
    expect(screen.getByTestId("dc-send-to-line-verify-now").getAttribute("href")).toBe("/verify-email?now=1");
    expect(screen.queryByTestId("dc-send-to-line-claim-resend")).toBeNull();
  });

  it("a confirmed owner whose 'did you create it?' question is open: names the question, no Bekræft nu", async () => {
    authUser = { ...OWNER, email_verified: true, claim_question_open: true };
    await openHistory();
    const line = await screen.findByTestId("dc-send-to-line-held");
    expect(line.textContent).toMatch(/^dcSendToLineHeldClaimOpen:anna@revisor\.dk\|Excel/);
    expect(screen.queryByText(/^dcSendToLine:/)).toBeNull();
    expect(screen.getByTestId("dc-send-to-line-claim-resend")).toBeInTheDocument();
    expect(screen.queryByTestId("dc-send-to-line-verify-now")).toBeNull();
  });

  it("a confirmed owner with no open question keeps 'Send går til {revisor}'", async () => {
    await openHistory();
    expect(await screen.findByText(/^dcSendToLine:anna@revisor\.dk\|Excel/)).toBeInTheDocument();
    expect(screen.queryByTestId("dc-send-to-line-held")).toBeNull();
  });

  it("Free (own-mail path) is unchanged for an unconfirmed owner — Send never mails the revisor there", async () => {
    entitled = false;
    authUser = { ...OWNER, email_verified: false };
    await openHistory();
    expect(await screen.findByText(/^dcSendToLineOwnMail:/)).toBeInTheDocument();
    expect(screen.queryByTestId("dc-send-to-line-held")).toBeNull();
  });

  it("the held line and Send agree: a tap mails nothing and offers the owner's own mail", async () => {
    authUser = { ...OWNER, email_verified: false };
    await openHistory();
    await screen.findByTestId("dc-send-to-line-held");
    const btn = screen.getByRole("button", { name: /sendToAccountantBtn/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText("dcSendViaOwnMail")).toBeInTheDocument();
    expect(post.mock.calls.some(([u]) => String(u).includes("send-to-accountant"))).toBe(false);
  });
});

describe("the held line's copy (real dictionaries)", () => {
  it("is in Danish and English, never promises 'Send går til'", () => {
    for (const k of ["dcSendToLineHeldUnverified", "dcSendToLineHeldClaimOpen"]) {
      expect(en[k]).toBeTruthy();
      expect(da[k]).toBeTruthy();
      expect(da[k]).not.toEqual(en[k]);
      expect(da[k]).not.toMatch(/Send går til/);
      expect(en[k]).not.toMatch(/Send goes to/);
      expect(da[k]).toContain("{email}");
      expect(da[k]).toContain("{format}");
    }
    expect(da.dcSendToLineHeldUnverified).toMatch(/bekræftet/);
    expect(da.dcSendToLineHeldClaimOpen).toMatch(/Har du selv oprettet denne konto\?/);
  });
});
