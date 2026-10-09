/**
 * Release R-c — two false sentences already in production (release gate R-b,
 * final pass, 9 Oct):
 *
 *   (c) After "Lås op" in History, the top card kept saying "Aftenens
 *       kasserapport er låst · kl. … af …" (with its mail line and Send igen)
 *       over a close that is a draft again — until a reload or ✕. The page's
 *       fresh lock result for that close now goes with the unlock.
 *   (d) An owner with a revisor saved but automatic sending to the revisor
 *       OFF locked a close; only the owner's own copy was tried, and it
 *       failed. The card and the History row said "Ikke sendt til revisor —
 *       …" — the revisor was never a recipient. They now name the owner's
 *       copy ("Din kopi blev ikke sendt — …. Revisoren var ikke modtager af
 *       denne mail."): from the lock's accountant_skip_reason on the card, and
 *       from the close's email_error marker ("revisor_auto_send_off;…") in
 *       History after a reload. A send that included the revisor still says
 *       "Ikke sendt til revisor".
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";
import { closeEmailState, revisorLeftOut } from "../utils/closeEmail";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant", email_verified: true, role: "owner" }, refreshUser: vi.fn() }),
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
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const profile = { accountant_email: "anna@revisor.dk", company_name: "Mirabelle ApS", accountant_auto_send: false };
let rows = [];
let lockRitual = null;

const lockedRow = (extra = {}) => ({
  id: "c1", date: today, status: "confirmed", revenue_total: 1234.5, revenue_breakdown: { food: 1234.5 },
  payment_breakdown: { card: 1234.5 }, payment_total: 1234.5, moms_total: 246.9, revenue_ex_moms: 987.6,
  closed_by: "Test", closed_at: `${today}T21:40:00`, email_sent_to: [], ...extra,
});

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  rows = [];
  lockRitual = { email_status: "sent", sent_to: ["owner@mirabelle.dk"], accountant_skip_reason: "auto_send_off" };
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: rows });
    if (url === "/business") return Promise.resolve({ data: profile });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url, body) => {
    if (url === "/daily-close" && body?.status === "confirmed") {
      rows = [lockedRow({ email_status: lockRitual.email_status, email_error: lockRitual.email_error ?? null,
        email_sent_to: lockRitual.sent_to || [] })];
      return Promise.resolve({ data: { ...lockedRow(), date: body.date, close_ritual: lockRitual } });
    }
    if (url === "/daily-close/c1/unlock") {
      rows = [lockedRow({ status: "draft", unlock_reason: body?.reason })];
      return Promise.resolve({ data: { ok: true } });
    }
    return Promise.resolve({ data: {} });
  });
});

const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};

const lockToday = async () => {
  const view = render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  const { container } = view;
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
  fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1234,50" } });
  tapNext();
  await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
  fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "1234,50" } });
  for (let i = 0; i < 4 && !screen.queryByText("confirmAndLock"); i++) {
    tapNext();
    await new Promise((r) => setTimeout(r, 0));
  }
  fireEvent.click(await screen.findByText("confirmAndLock"));
  await screen.findByText(/^closeLockedTitle:/);
  return view;
};

describe("(c) an unlock from History ends the top card's \"låst\"", () => {
  it("tonight locked, then unlocked with a reason: the card no longer says the kasserapport is locked", async () => {
    await lockToday();
    // History lists tonight's close as locked: its "Lås op".
    const rowUnlock = await screen.findByRole("button", { name: /^dcUnlock$/ });
    fireEvent.click(rowUnlock);
    const reason = await screen.findByPlaceholderText("dcUnlockReasonPlaceholder");
    fireEvent.change(reason, { target: { value: "Kortterminal talt forkert" } });
    const buttons = screen.getAllByRole("button", { name: /dcUnlock$/ });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/daily-close/c1/unlock", { reason: "Kortterminal talt forkert" }));
    // History read again: the close is a draft — and the card says nothing
    // of a lock (nor its mail line / Send igen).
    await waitFor(() => expect(screen.queryByText(/^closeLockedTitle:/)).toBeNull());
    expect(document.body.textContent).toContain("dcUnlockedReason:Kortterminal talt forkert");
  });

  it("an unlock refused by the server keeps the card (the close is still locked)", async () => {
    await lockToday();
    post.mockImplementation((url) => (url === "/daily-close/c1/unlock"
      ? Promise.reject(Object.assign(new Error("nope"), { response: { status: 403, data: { detail: "no" } } }))
      : Promise.resolve({ data: {} })));
    fireEvent.click(await screen.findByRole("button", { name: /^dcUnlock$/ }));
    fireEvent.change(await screen.findByPlaceholderText("dcUnlockReasonPlaceholder"), { target: { value: "x" } });
    const buttons = screen.getAllByRole("button", { name: /dcUnlock$/ });
    fireEvent.click(buttons[buttons.length - 1]);
    await screen.findByText(/dcUnlockStillLocked/);
    expect(screen.getByText(/^closeLockedTitle:/)).toBeInTheDocument();
  });
});

describe("(d) the owner's own copy failed and the revisor was never a recipient", () => {
  it("the state: from the lock's skip reason, or the close's marker after a reload", () => {
    const fromLock = closeEmailState({ status: "failed_skipped", sentTo: [], skip: "auto_send_off",
      error: "email_not_configured", profile });
    expect(fromLock.kind).toBe("failed_owner_only");
    const fromHistory = closeEmailState({ status: "failed_skipped", sentTo: [],
      error: "revisor_auto_send_off;email_not_configured", profile });
    expect(fromHistory.kind).toBe("failed_owner_only");
    for (const skip of ["daily_cap", "demo_close", "unchanged"]) {
      expect(revisorLeftOut(skip, null)).toBe(true);
      expect(revisorLeftOut(null, `revisor_${skip};send_error: x`)).toBe(true);
    }
    // A revisor that WAS a recipient: still "Ikke sendt til revisor".
    expect(closeEmailState({ status: "failed_skipped", sentTo: [], error: "email_not_configured", profile }).kind).toBe("failed");
    expect(closeEmailState({ status: "send_failed", sentTo: [], skip: null, error: "send_error: x", profile }).kind).toBe("failed");
    // Not a left-out reason: the same address, or a held send (said by its own line).
    expect(revisorLeftOut("same_as_owner", null)).toBe(false);
    expect(revisorLeftOut(null, "revisor_email_unverified;send_error: x")).toBe(false);
    expect(revisorLeftOut(null, "revisor_unchanged")).toBe(true);
    // The owner's copy sent: unchanged (owner_only).
    expect(closeEmailState({ status: "sent", sentTo: ["owner@mirabelle.dk"], skip: "auto_send_off", profile }).kind).toBe("owner_only");
  });

  it("the lock card and History name the owner's copy, never \"Ikke sendt til revisor\" (the lock as the server answers it now)", async () => {
    lockRitual = { email_status: "failed_skipped", email_error: "revisor_auto_send_off;email_not_configured", sent_to: [], accountant_skip_reason: "auto_send_off" };
    const { container } = await lockToday();
    await waitFor(() => expect(container.textContent).toContain("dcMailOwnerCopyFailedNotRevisor:dcMailErrNotConfigured"));
    expect(container.textContent).not.toMatch(/dcMailNotSent:/);
  });

  it("the card reads the lock's skip reason even from a server that kept the bare error (deploy order)", async () => {
    lockRitual = { email_status: "failed_skipped", email_error: "email_not_configured", sent_to: [], accountant_skip_reason: "auto_send_off" };
    const { container } = await lockToday();
    const card = screen.getByText(/^closeLockedTitle:/).closest("section, article, div[class*='rounded']");
    await waitFor(() => expect(container.textContent).toContain("dcMailOwnerCopyFailedNotRevisor:dcMailErrNotConfigured"));
    expect(card).not.toBeNull();
  });

  it("History after a reload reads the close's marker: the owner's copy, never \"Ikke sendt til revisor\"", async () => {
    rows = [lockedRow({ date: "2026-10-01", id: "h1", email_status: "failed_skipped",
      email_error: "revisor_auto_send_off;email_not_configured", email_attempt_at: "2026-10-01T21:40:00" })];
    const { container } = render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
    await waitFor(() => expect(container.textContent).toContain("dcMailOwnerCopyFailedNotRevisor:dcMailErrNotConfigured"));
    expect(container.textContent).not.toMatch(/dcMailNotSent:/);
    // Its button says what tapping does: the revisor gets it.
    expect(screen.getAllByRole("button", { name: /dcMailSendToRevisor/ }).length).toBeGreaterThan(0);
  });

  it("a send that included the revisor still says \"Ikke sendt til revisor\" in History", async () => {
    rows = [lockedRow({ date: "2026-10-01", id: "h1", email_status: "failed_skipped",
      email_error: "email_not_configured", email_attempt_at: "2026-10-01T21:40:00" })];
    const { container } = render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
    await waitFor(() => expect(container.textContent).toMatch(/dcMailNotSent:dcMailErrNotConfigured/));
    expect(container.textContent).not.toContain("dcMailOwnerCopyFailedNotRevisor");
  });

  it("the sentence, in Danish and English", () => {
    expect(da.dcMailOwnerCopyFailedNotRevisor).toBe("Din kopi blev ikke sendt — {reason}. Revisoren var ikke modtager af denne mail.");
    expect(en.dcMailOwnerCopyFailedNotRevisor).toBe("Your copy was not sent — {reason}. Your revisor was not a recipient of this mail.");
    expect(da.dcDateMovedCopiedLocked).toBe("Kopieret til {to} — {from} er låst og står uændret");
    expect(en.dcDateMovedCopiedLocked).toBe("Copied to {to} — {from} is locked and stays as it is");
  });
});
