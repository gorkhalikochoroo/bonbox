/**
 * Round 20 — the removal audit's U4, restored: the lock card names the
 * owner's own address when the owner's copy went too.
 *
 * Round 19 hid the plain "Sendt til …" line whenever the status line named a
 * recipient. The revisor line ("Afleveret til mailserveren — til din revisor
 * (revisor@firma.dk)") names the revisor only, so the owner's own copy — and
 * address — was said nowhere. The plain line is a repeat only when the
 * revisor was the one recipient (or the owner-only line already says it).
 * Real Danish strings: the recipients are filled into "Sendt til {recipients}".
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      const hit = da[k] ?? (typeof fallbackOrVars === "string" ? fallbackOrVars : k);
      return vars ? hit.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m)) : hit;
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

const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
let profile = {};
let lockAnswer = null;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  profile = {};
  lockAnswer = null;
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: [] });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    if (url === "/business") return Promise.resolve({ data: profile });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url, body) => {
    if (url === "/daily-close" && body?.status === "confirmed" && lockAnswer) return Promise.resolve({ data: lockAnswer(body) });
    return Promise.resolve({ data: { id: "d1", status: "draft", date: body?.date } });
  });
});

const lockOne = async () => {
  const view = render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByText(da.skipEnterManually));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value: "1234,50" } });
  for (let i = 0; i < 6 && !view.container.querySelector("#dc-notes"); i++) {
    const next = [...document.querySelectorAll("button")].find((x) => /^Næste/.test(x.textContent.trim()));
    if (next) fireEvent.click(next);
    await new Promise((r) => setTimeout(r, 0));
  }
  const lock = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(da.confirmAndLock));
  fireEvent.click(lock);
  return view;
};
const answer = (sentTo) => (body) => ({
  id: "c1", status: "confirmed", date: body.date, revenue_total: 1234.5, closed_by: "Test",
  closed_at: "2026-10-07T05:20:00", email_status: "sent", email_sent_to: sentTo,
  close_ritual: { email_status: "sent", sent_to: sentTo },
});

describe("U4 — the lock card names the owner's own address when the owner's copy went too", () => {
  it("revisor + the owner's copy: the revisor line, and \"Sendt til\" with both addresses", async () => {
    profile = { accountant_email: "revisor@firma.dk" };
    lockAnswer = answer(["revisor@firma.dk", "ejer@cafe.dk"]);
    const { container } = await lockOne();
    await waitFor(() => expect(container.textContent).toContain("revisor@firma.dk"));
    expect(container.textContent).toContain("Sendt til revisor@firma.dk, ejer@cafe.dk");
  });

  it("the revisor the only recipient: said once, by the revisor line", async () => {
    profile = { accountant_email: "revisor@firma.dk" };
    lockAnswer = answer(["revisor@firma.dk"]);
    const { container } = await lockOne();
    await waitFor(() => expect(container.textContent).toContain("revisor@firma.dk"));
    expect(container.textContent).not.toContain("Sendt til revisor@firma.dk");
    expect(container.textContent.match(/revisor@firma\.dk/g)).toHaveLength(1);
  });
});
