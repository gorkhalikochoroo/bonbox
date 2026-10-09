/**
 * R-b (R-a follow-up, 9 Oct) — the MOMS-angivelse send's failures are said in
 * the owner's language, and true for the failure. A Danish owner used to get
 * the server's English "Couldn't send email right now. The file is still
 * available to download." for a mail-service error, a missing mail setup and
 * a PDF that could not be built — and "Kunne ikke sende mail — prøv igen" for
 * a lost answer, where trying again can mail the revisor twice.
 *
 * t() reads the REAL Danish dictionary here (lang "da"), so these assert the
 * shipped Danish copy.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), refreshUser: vi.fn(),
  user: { id: 1, currency: "DKK", role: "owner", email_verified: true, claim_question_open: false },
  lang: "da",
}));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user, refreshUser: (...a) => h.refreshUser(...a) }) }));
const fill = (s, vars) =>
  vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
vi.mock("../hooks/useLanguage", async () => {
  const { da: daDict } = await import("../i18n/da");
  const { en: enDict } = await import("../i18n/en");
  return {
    useLanguage: () => {
      const dict = h.lang === "da" ? daDict : enDict;
      return {
        t: (k, fb, vars) => {
          const v = typeof fb === "object" ? fb : vars;
          return fill(dict[k] ?? (typeof fb === "string" ? fb : k), v);
        },
        lang: h.lang, setLang: () => {}, LANGUAGES: [],
      };
    },
    LanguageProvider: ({ children }) => children,
  };
});
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => "starter", isReady: true }),
}));
const confirmMock = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", async (orig) => ({ ...(await orig()), useConfirm: () => confirmMock }));

const TaxAutopilotPage = (await import("../pages/TaxAutopilotPage")).default;

const REVISOR = "pia@realrevisor.dk";
const TAX = {
  "/tax/overview": {
    tax_name: "Moms", authority: "Skattestyrelsen", rate_pct: 25, frequency: "quarterly",
    upcoming_deadlines: [{
      period_start: "2026-07-01", period_end: "2026-09-30", deadline: "2026-12-01",
      days_until: 54, status: "ok", estimated_amount: 1000, output_vat: 2000, input_vat: 1000,
    }],
    current_month: {}, ytd: {}, alerts: [],
  },
  "/tax/voucher-audit": { _error: true },
  "/business": { accountant_email: REVISOR, accountant_name: "Pia Jensen" },
  "/auth/me": {},
};
const SERVER_EN = "Couldn't send email right now. The file is still available to download.";
const fail = (status, detail) => ({ response: { status, data: { detail } } });

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  h.get.mockReset(); h.post.mockReset(); h.refreshUser.mockReset();
  h.refreshUser.mockResolvedValue({ ...h.user });
  h.lang = "da";
  h.get.mockImplementation((url) => Promise.resolve({ data: TAX[url] ?? [] }));
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => true);
});

const sendWith = async (rejection) => {
  h.post.mockImplementation((url) => (String(url).includes("/tax/filing-pdf/send-to-accountant")
    ? Promise.reject(rejection) : Promise.resolve({ data: {} })));
  render(<MemoryRouter><TaxAutopilotPage /></MemoryRouter>);
  const dict = h.lang === "da" ? da : en;
  const send = await screen.findByRole("button", { name: dict.taxPdfEmailRevisorAria });
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  await waitFor(() => expect(h.post).toHaveBeenCalled());
};

describe("MOMS-angivelse send failures, Danish owner", () => {
  it("502 mail-service error: Danish, 'sandsynligvis ikke', no copy, own mail — never the server's English", async () => {
    await sendWith(fail(502, { code: "email_send_failed", reason: "send_error: x", message: SERVER_EN, message_da: "server-da" }));
    expect(await screen.findByText(fill(da.filingPdfSendProviderFailed, { email: REVISOR }))).toBeInTheDocument();
    expect(screen.queryByText(SERVER_EN)).toBeNull();
  });

  it("503 nothing attempted (mail not set up): 'intet blev sendt'", async () => {
    await sendWith(fail(503, { code: "email_send_failed", reason: "email_not_configured", message: SERVER_EN }));
    expect(await screen.findByText(da.filingPdfSendNotConfigured)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_EN)).toBeNull();
  });

  it("500 PDF not built: 'intet blev sendt'", async () => {
    await sendWith(fail(500, { code: "pdf_generation_failed", message: "Could not generate the filing PDF, so nothing was sent. Please try again." }));
    expect(await screen.findByText(da.filingPdfSendBuildFailed)).toBeInTheDocument();
  });

  it("no answer: can't tell whether it arrived — never 'prøv igen' (a retry could mail it twice)", async () => {
    await sendWith(new Error("Network Error"));
    expect(await screen.findByText(fill(da.filingPdfSendUnknown, { email: REVISOR }))).toBeInTheDocument();
    expect(screen.queryByText(da.filingPdfSendFailed)).toBeNull();
  });

  it("any other worded refusal: the server's Danish twin for a Danish owner", async () => {
    await sendWith(fail(400, { code: "something_else", message: "English words", message_da: "Danske ord" }));
    expect(await screen.findByText("Danske ord")).toBeInTheDocument();
    expect(screen.queryByText("English words")).toBeNull();
  });

  it("an English owner gets the English", async () => {
    h.lang = "en";
    await sendWith(fail(502, { code: "email_send_failed", reason: "send_error: x", message: SERVER_EN }));
    expect(await screen.findByText(fill(en.filingPdfSendProviderFailed, { email: REVISOR }))).toBeInTheDocument();
  });
});

describe("the copy (real dictionaries)", () => {
  it("every new key has real en + da", () => {
    for (const k of ["filingPdfSendNotConfigured", "filingPdfSendProviderFailed", "filingPdfSendBuildFailed", "filingPdfSendUnknown"]) {
      expect(en[k]).toBeTruthy();
      expect(da[k]).toBeTruthy();
      expect(da[k]).not.toEqual(en[k]);
    }
    expect(da.filingPdfSendProviderFailed).toMatch(/sandsynligvis ikke frem/);
    expect(da.filingPdfSendNotConfigured).toMatch(/intet blev sendt/);
  });
});
