/**
 * Booking fix round 2 (24 Oct 2026) — the receipt never promises a mail
 * that will not come.
 *
 * The recheck found a real guest, held at a busy moment, whose "request
 * received" mail the venue's held-mail budget had held back — while the
 * receipt said "Vi svarer dig på {email} inden dagen", and the page stopped
 * polling after two minutes. The create answer now says `guest_mail`: when
 * it is false the page says to keep the page (the answer shows there), and a
 * confirmed booking with no mail coming says the page is the receipt. An
 * older server sends no flag: the page says what it always said.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { da } = await import("../i18n/da");

const TODAY = "2026-10-23"; // a Friday
const plus = (n) => {
  const d = new Date(2026, 9, 23 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const PAGE = {
  business_name: "Bistro Nørrebro", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Nørrebrogade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false, providers: [],
  allergen_set: [], logo_url: null, closures: [], paused_until: null,
};
function summary(dayOverrides = {}) {
  const days = Array.from({ length: 14 }, (_, i) => ({ date: plus(i), has_slots: true, reason: null, ...(dayOverrides[i] || {}) }));
  const first = days.find((d) => d.has_slots);
  return { from: TODAY, party_size: 2, next_open_day: first ? first.date : null, days };
}
let summaryCalls = 0;
function routes({ page = PAGE, sum = () => summary(), availability } = {}) {
  summaryCalls = 0;
  h.get.mockImplementation((url, cfg) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: page });
    if (url === "/public/reservations/x/availability-summary") { summaryCalls += 1; return Promise.resolve({ data: sum(cfg?.params || {}) }); }
    if (url === "/public/reservations/x/availability") {
      return Promise.resolve({ data: availability ? availability(cfg?.params || {}) : { slots: ["19:00", "19:30"], slot_remaining: {} } });
    }
    if (url === "/public/reservations/x/floor") return Promise.resolve({ data: { tables: [] } });
    return Promise.resolve({ data: {} });
  });
}
const renderAt = (path = "/r/x") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:slug" element={<ReservationPublicPage />} />
      </Routes>
    </MemoryRouter>,
  );
// Step 1 → 19:00 → Fortsæt → name + e-mail.
async function toDetails() {
  await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "19:00")); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
  await settle(4);
  await act(async () => { fireEvent.change(document.getElementById("rsvp-name"), { target: { value: "Sita Sharma" } }); });
  await act(async () => { fireEvent.change(document.getElementById("rsvp-email"), { target: { value: "sita@example.com" } }); });
}
const submit = async () => {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpConfirm) })); });
  await settle(6);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the receipt and the e-mail promise", () => {
  async function bookWith(answer) {
    routes();
    h.post.mockResolvedValue({ data: { id: "bk1", booking_token: "tok", ...answer } });
    h.get.mockImplementation((url, cfg) => {
      if (url === "/public/reservations/x") return Promise.resolve({ data: PAGE });
      if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: summary() });
      if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: ["19:00", "19:30"], slot_remaining: {} } });
      if (url.startsWith("/public/reservations/x/booking")) return Promise.resolve({ data: { status: answer.status } });
      return Promise.resolve({ data: {} });
    });
    renderAt();
    await settle();
    await toDetails();
    await submit();
  }

  it("a held request with no mail coming does not promise one", async () => {
    await bookWith({ status: "requested", guest_mail: false });
    expect(screen.getByText(da.rsvpRequestTitle)).toBeTruthy();
    expect(screen.getByText(da.rsvpRequestNextNoMail)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Vi svarer dig på");
    expect(document.body.textContent).not.toContain("sita@example.com inden dagen");
  });

  it("a request whose mail is coming says the usual (booked for today: 'om lidt')", async () => {
    await bookWith({ status: "requested", guest_mail: true });
    expect(screen.queryByText(da.rsvpRequestNextNoMail)).toBeNull();
    expect(screen.getByText(da.rsvpRequestNextToday)).toBeTruthy();
  });

  it("a confirmed booking with no mail coming says the page is the receipt", async () => {
    await bookWith({ status: "confirmed", guest_mail: false });
    expect(screen.getByText(da.rsvpNoMailReceipt)).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      da.rsvpEmailOnItsWay.replace("{email}", "sita@example.com"));
  });

  it("an older server (no flag) keeps the old promise", async () => {
    await bookWith({ status: "confirmed" });
    expect(screen.queryByText(da.rsvpNoMailReceipt)).toBeNull();
    expect(document.body.textContent).toContain(
      da.rsvpEmailOnItsWay.replace("{email}", "sita@example.com"));
  });

  // F5 (27 Oct 2026): the server says when the answer comes at the latest —
  // the time an unanswered request is declined — and the receipt names it,
  // so the promise always holds (a same-day dinner waits until 2 h before).
  it("a request names the server's own answer time: today", async () => {
    await bookWith({ status: "requested", guest_mail: true, answer_by: "2026-10-23T17:00" });
    expect(document.body.textContent).toContain("Vi svarer dig på sita@example.com senest i dag kl. 17.00.");
    expect(screen.queryByText(da.rsvpRequestNextToday)).toBeNull();
  });

  it("…and tomorrow, and another day, in the guest's words", async () => {
    const { answerByWords } = await import("../utils/guestLocale");
    const { en } = await import("../i18n/en");
    const tt = (dict) => (k, fb, v) => (dict[k] ?? fb).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] !== undefined ? String(v[n]) : m));
    expect(answerByWords("2026-10-24T06:30", TODAY, "da", tt(da))).toBe("i morgen kl. 06.30");
    expect(answerByWords("2026-10-24T06:30", TODAY, "en", tt(en))).toBe("tomorrow at 06:30");
    expect(answerByWords("2026-10-23T18:00", TODAY, "en", tt(en))).toBe("today at 18:00");
    expect(answerByWords("2026-10-27T13:00", TODAY, "da", tt(da))).toMatch(/^tirsdag 27\. oktober kl\. 13\.00$/);
    expect(answerByWords(null, TODAY, "da", tt(da))).toBe("");
  });

  it("a request too late to send online asks the guest to call, with the venue's phone, and keeps the form", async () => {
    routes();
    h.post.mockRejectedValue(Object.assign(new Error("409"), {
      response: { status: 409, data: { detail: { error: "request_too_late" } } },
    }));
    renderAt();
    await settle();
    await toDetails();
    await submit();
    expect(document.body.textContent).toContain(da.rsvpErrRequestTooLate);
    expect(screen.getByTestId("rsvp-refusal-call").getAttribute("href")).toContain("12");
    expect(document.getElementById("rsvp-name").value).toBe("Sita Sharma");
    expect(document.getElementById("rsvp-email").value).toBe("sita@example.com");
  });

  it("the new sentences exist in Danish and English, and differ", async () => {
    const { en } = await import("../i18n/en");
    for (const k of ["rsvpRequestNextNoMail", "rsvpNoMailReceipt", "rsvpRequestNextBy",
      "rsvpRequestNextByEmail", "rsvpWhenToday", "rsvpWhenTomorrow", "rsvpWhenDay",
      "rsvpErrRequestTooLate"]) {
      expect(typeof da[k]).toBe("string");
      expect(typeof en[k]).toBe("string");
      expect(da[k]).not.toBe(en[k]);
      expect(da[k]).not.toMatch(/e-mail på \{email\}/);
    }
  });
});
