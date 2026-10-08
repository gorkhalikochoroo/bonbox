/**
 * Faktura Send when BonBox refuses to mail it (review, 8 Oct).
 *
 * handleSend first POSTs /send — the faktura is now marked sent, locked and
 * dated — and only then asks the server to mail it. The new third-party mail
 * rules answer 403 email_unverified or 429 invoice_mail_*_cap, and those used
 * to hit the generic 4xx branch: a toast, then `return`. The ledger held a
 * "sent" faktura the customer never got, and Send offered no working path —
 * even though the cap message itself says "send the PDF from your own mail".
 *
 * Now those refusals say why and fall through to the existing PDF + own-mail
 * fallback; an unconfirmed account also gets "Bekræft nu". Any other 4xx keeps
 * its old behaviour (say it, stop).
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const toast = vi.fn();
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));
const saveFile = vi.fn();
vi.mock("../utils/download", () => ({ saveFile: (...a) => saveFile(...a) }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, currency: "DKK", business_type: "cafe", email_verified: false },
    refreshUser: vi.fn(),
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn(), useEventLog: () => ({}) }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useUndoToast", () => ({
  useUndoToast: () => ({ showUndo: vi.fn(), undoToastUI: null }),
}));

const FakturaPage = (await import("../pages/FakturaPage")).default;

const INVOICE = {
  id: "inv-1", status: "draft", customer_id: 3, fakturanummer_formatted: "2026-0007",
  issue_date: "2026-10-08", due_date: "2026-10-22", currency: "DKK", total_gross: 1250,
  customer_lang: "da", is_credit_note: false,
};
const CUSTOMER = { id: 3, name: "Hansen ApS", email: "kunde@hansen.dk", is_company: true };

function refuse(status, code) {
  return Promise.reject({ response: { status, data: { detail: { code, message: "server english" } } } });
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/faktura"]}>
      <Routes>
        <Route path="/faktura" element={<FakturaPage />} />
        <Route path="/verify-email" element={<p>VERIFY PAGE</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function clickSend() {
  mount();
  const sends = await screen.findAllByText("send");
  fireEvent.click(sends[0].closest("button"));
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  get.mockImplementation((url) => {
    const u = String(url);
    if (u === "/invoices") return Promise.resolve({ data: [INVOICE] });
    if (u === "/customers") return Promise.resolve({ data: [CUSTOMER] });
    if (u.endsWith("/pdf")) return Promise.resolve({ data: new Blob(["%PDF"]) });
    return Promise.resolve({ data: null });
  });
  saveFile.mockResolvedValue({ ok: true });
});

const pdfFetched = () => get.mock.calls.some(([u]) => String(u) === "/invoices/inv-1/pdf");

describe("Faktura Send — BonBox refuses to mail it", () => {
  it("403 email_unverified: says why, saves the PDF for the owner's own mail, offers Bekræft nu", async () => {
    post.mockImplementation((url) =>
      String(url).endsWith("/send-email") ? refuse(403, "email_unverified") : Promise.resolve({ data: {} }),
    );
    await clickSend();
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/invoices/inv-1/send");
    expect(pdfFetched()).toBe(true);
    const notice = toast.mock.calls.map(([o]) => o).find((o) => o.message === "invoiceMailUnverifiedOwnMail");
    expect(notice).toBeTruthy();
    expect(notice.action.label).toBe("verifyEmailNowCta");
    // The one tap goes to the page that can actually confirm the address.
    await act(async () => notice.action.onClick());
    expect(await screen.findByText("VERIFY PAGE")).toBeTruthy();
  });

  it.each(["invoice_mail_daily_cap", "invoice_mail_recipient_cap"])(
    "429 %s: the PDF + own-mail fallback still runs",
    async (code) => {
      post.mockImplementation((url) =>
        String(url).endsWith("/send-email") ? refuse(429, code) : Promise.resolve({ data: {} }),
      );
      await clickSend();
      await waitFor(() => expect(saveFile).toHaveBeenCalled());
      const notice = toast.mock.calls.map(([o]) => o).find((o) => o.message === "invoiceMailCapOwnMail");
      expect(notice).toBeTruthy();
      expect(notice.action).toBeUndefined();
    },
  );

  it("if the PDF could not be saved, the owner is still told why BonBox did not mail it", async () => {
    post.mockImplementation((url) =>
      String(url).endsWith("/send-email") ? refuse(403, "email_unverified") : Promise.resolve({ data: {} }),
    );
    saveFile.mockResolvedValue({ ok: false });
    await clickSend();
    await waitFor(() =>
      expect(toast.mock.calls.some(([o]) => o.message === "invoicePdfSaveFailed")).toBe(true),
    );
    const msgs = toast.mock.calls.map(([o]) => o.message);
    expect(msgs).toContain("sendNeedsVerifiedEmail");
    expect(msgs).not.toContain("invoiceMailUnverifiedOwnMail"); // "PDF saved" would be false
  });

  it("any other 4xx keeps its old behaviour: say it, no fallback", async () => {
    post.mockImplementation((url) =>
      String(url).endsWith("/send-email") ? refuse(422, "no_recipient") : Promise.resolve({ data: {} }),
    );
    await clickSend();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({ message: "server english", severity: "critical" });
    expect(pdfFetched()).toBe(false);
    expect(saveFile).not.toHaveBeenCalled();
  });
});
