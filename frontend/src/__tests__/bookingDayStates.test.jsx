/**
 * Honest date states on the public booking page (booking push p1).
 *
 * Every unbookable day used to read "lukket" — a booked-out Friday, a table
 * venue with no table for the party, tonight after the lead time, a salon
 * with no shift published. The server now names the reason and the page says
 * it (utils/dayState.js): "lukket" only for a declared closed day; "fuldt",
 * "kun tlf.", "for sent"; anything it can't name reads neutral. Paused online
 * booking is one calm panel with the phone, never a strip of dead days under
 * a "Pick a time" button with nowhere to go. Party sizes 1–10 sit in two rows
 * of five 40px chips on a phone.
 *
 * The clock is pinned (Date only) to Tuesday 8 January 2030, 09:00, so every
 * weekday and month below is fixed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), lang: "da" }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    const dict = h.lang === "en" ? EN : DA;
    let s = dict[k] ?? EN[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return {
    useLanguage: () => ({ lang: h.lang, setLang: () => {}, t }),
    LanguageProvider: ({ children }) => children,
  };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const TODAY = "2030-01-08";
const plus = (n) => {
  const d = new Date(2030, 0, 8 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const PAGE = {
  business_name: "Bistro Test", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Gade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false,
};

/** A 14-day summary; `reasons[i]` null = open, a string = closed for that reason. */
function summary(reasons = [], { closedReason, days = 14 } = {}) {
  const list = Array.from({ length: days }, (_, i) => {
    const r = i < reasons.length ? reasons[i] : null;
    return { date: plus(i), has_slots: r === null, reason: r };
  });
  const first = list.find((d) => d.has_slots);
  return {
    from: TODAY, party_size: 2, next_open_day: first ? first.date : null, days: list,
    ...(closedReason ? { closed_reason: closedReason } : {}),
  };
}

let calls = [];
function routes({ page = PAGE, sum = () => summary(), avail = () => ({ slots: ["19:00", "19:30"] }), prov, behandlinger } = {}) {
  calls = [];
  h.get.mockImplementation((url, cfg) => {
    calls.push([url, cfg?.params]);
    const p = cfg?.params || {};
    if (url === "/public/reservations/x") return Promise.resolve({ data: page });
    if (url === "/public/reservations/x/availability-summary") {
      const out = sum(p);
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
    if (url === "/public/reservations/x/availability") {
      const out = avail(p);
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
    if (url === "/public/reservations/x/provider-availability") return Promise.resolve({ data: prov ? prov(p) : { slots: [] } });
    if (url === "/public/reservations/x/behandlinger") {
      return Promise.resolve({ data: { behandlinger: behandlinger || [{ id: "b1", name: "Dameklip", duration_min: 45, price_kr: 450 }] } });
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

const dateRadios = async (name = da.rsvpPickDate) => {
  const group = await screen.findByRole("radiogroup", { name });
  return within(group).getAllByRole("radio");
};
const chipFor = (radios, iso, lang = "da") => radios.find((r) => r.getAttribute("aria-label")?.startsWith(dayLabel(iso, lang)));
const dayLabel = (iso, lang = "da") =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === "en" ? "en-GB" : "da-DK", { weekday: "long", day: "numeric", month: "long" });
const pageText = () => document.body.textContent;
const ariaText = () => [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" | ");
const summaryCalls = () => calls.filter(([u]) => u.endsWith("/availability-summary")).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 0, 8, 9, 0));
  h.get.mockReset();
  h.post.mockReset();
  h.lang = "da";
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the date strip says why a day can't be booked", () => {
  it('da: a full night says "fuldt", a closed day says "lukket"', async () => {
    routes({ sum: () => summary(["full", "closed"]) });
    renderAt();
    await settle();
    const radios = await dateRadios();
    const full = chipFor(radios, plus(0));
    const shut = chipFor(radios, plus(1));
    expect(full.disabled).toBe(true);
    expect(full.textContent).toContain("fuldt");
    expect(full.getAttribute("aria-label")).toBe(`${dayLabel(plus(0))} — fuldt booket`);
    expect(shut.disabled).toBe(true);
    expect(shut.textContent).toContain("lukket");
    expect(shut.getAttribute("aria-label")).toBe(`${dayLabel(plus(1))} — lukket`);
    expect(chipFor(radios, plus(2)).disabled).toBe(false);
  });

  it("en: too late, by phone, closed", async () => {
    h.lang = "en";
    routes({ sum: () => summary(["too_late", "no_fit", "closed"]) });
    renderAt();
    await settle();
    const radios = await dateRadios(en.rsvpPickDate);
    expect(chipFor(radios, plus(0), "en").textContent).toContain("too late");
    expect(chipFor(radios, plus(1), "en").textContent).toContain("by phone");
    expect(chipFor(radios, plus(1), "en").getAttribute("aria-label")).toMatch(/— table for 2 by phone only$/);
    expect(chipFor(radios, plus(2), "en").textContent).toContain("closed");
    expect(chipFor(radios, plus(2), "en").getAttribute("aria-label")).toMatch(/— closed$/);
  });

  it('retired and unknown reasons read neutral, never "lukket"', async () => {
    routes({
      sum: () => summary([null, "closed_or_full", "out_of_window", "zzz"]),
      avail: () => ({ slots: [] }),
    });
    renderAt();
    await settle();
    const radios = await dateRadios();
    for (const i of [1, 2, 3]) {
      const chip = chipFor(radios, plus(i));
      expect(chip.disabled).toBe(true);
      expect(chip.textContent).toMatch(/jan/i); // the month name, no state word
      expect(chip.getAttribute("aria-label")).toBe(`${dayLabel(plus(i))} — ingen ledige tider`);
    }
    await screen.findByText(da.rsvpNoSlotsDay);
    expect(pageText()).not.toMatch(/Lukket denne dag/);
    expect(pageText()).not.toMatch(/lukket/i);
  });

  it("the strip ends at the booking window", async () => {
    routes({ page: { ...PAGE, max_advance_days: 7 } });
    renderAt();
    await settle();
    const radios = await dateRadios();
    expect(radios).toHaveLength(8);
    const ahead = screen.getByTestId("rsvp-book-ahead");
    expect(ahead.textContent).toBe("Book op til 7 dage frem");
    // In the header row, beside the heading — no extra line under the strip.
    expect(ahead.parentElement.querySelector("h2").textContent).toBe(da.rsvpPickDate);
    expect(screen.queryByRole("button", { name: da.rsvpOtherDate })).toBeNull();
  });

  it("max_advance_days 0 and missing", async () => {
    routes({ page: { ...PAGE, max_advance_days: 0 } });
    renderAt();
    await settle();
    expect(await dateRadios()).toHaveLength(1);
    expect(screen.getByTestId("rsvp-book-ahead").textContent).toBe("Kun i dag");
    cleanup();

    const { max_advance_days: _drop, ...noMax } = PAGE;
    routes({ page: noMax });
    renderAt();
    await settle();
    expect(await dateRadios()).toHaveLength(14);
    expect(screen.getByRole("button", { name: da.rsvpOtherDate })).toBeTruthy();
  });

  it("a day beyond the rail stands apart", async () => {
    routes();
    renderAt(`/r/x?d=${plus(20)}`);
    await settle();
    const radios = await dateRadios();
    expect(radios).toHaveLength(15);
    expect(radios[14].className).toContain("ml-4");
    expect(radios[13].className).not.toContain("ml-4");
  });

  it("too late today moves to tomorrow", async () => {
    routes({ sum: () => summary(["too_late"]) });
    renderAt();
    await settle();
    const radios = await dateRadios();
    expect(chipFor(radios, plus(0)).textContent).toContain("for sent");
    expect(chipFor(radios, plus(1)).getAttribute("aria-checked")).toBe("true");
  });

  it("a failed summary invents nothing", async () => {
    routes({ sum: () => Promise.reject(new Error("Network Error")) });
    renderAt();
    await settle();
    const radios = await dateRadios();
    expect(radios.every((r) => !r.disabled)).toBe(true);
    const strip = radios.map((r) => r.textContent).join(" ");
    for (const w of ["lukket", "fuldt", "kun tlf.", "for sent"]) expect(strip).not.toContain(w);
    expect(screen.getByRole("radiogroup", { name: da.rsvpPartySize })).toBeTruthy();
  });
});

describe("paused online booking: one panel, nothing that leads nowhere", () => {
  const paused = () => summary(Array(14).fill("not_accepting"), { closedReason: "not_accepting" });
  const BANNED = /fuld|full|plan|free|gratis|flere|more/i;

  const expectPausedPanel = ({ phone = true, title = da.rsvpNotAcceptingOnline } = {}) => {
    const panel = screen.getByTestId("rsvp-paused");
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.textContent).toContain(title);
    expect(panel.textContent).not.toMatch(BANNED);
    expect(screen.queryAllByRole("radiogroup")).toHaveLength(0);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(pageText()).not.toContain(da.rsvpTrustLine);
    expect(screen.queryByRole("button", { name: da.rsvpPickTimeShort })).toBeNull();
    expect(screen.queryByRole("button", { name: da.rsvpOtherDate })).toBeNull();
    expect(pageText()).not.toContain(da.rsvpContinue);
    const links = within(panel).queryAllByRole("link");
    const buttons = within(panel).queryAllByRole("button");
    expect(buttons).toHaveLength(0);
    if (phone) {
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute("href")).toMatch(/^tel:/);
      expect(links[0].className).toContain("h-10");
      expect(links[0].className).toContain("min-h-0!");
    } else {
      expect(links).toHaveLength(0);
      expect(panel.textContent).toContain(da.rsvpContactVenueDirect);
    }
  };

  it("paused: one panel, no pickers, no dead button", async () => {
    routes({ sum: paused });
    renderAt();
    await settle();
    await screen.findByTestId("rsvp-paused");
    expectPausedPanel();
    // The venue header stays: name and phone.
    expect(pageText()).toContain("Bistro Test");
  });

  it("paused (embed)", async () => {
    routes({ sum: paused });
    renderAt("/r/x?embed=1");
    await settle();
    await screen.findByTestId("rsvp-paused");
    expectPausedPanel();
  });

  it("paused without a phone", async () => {
    const { phone: _p, ...noPhone } = PAGE;
    routes({ page: noPhone, sum: paused });
    renderAt();
    await settle();
    await screen.findByTestId("rsvp-paused");
    expectPausedPanel({ phone: false });
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("an older server (every day not_accepting, no flag) pauses too", async () => {
    routes({ sum: () => summary(Array(14).fill("not_accepting")) });
    renderAt();
    await settle();
    await screen.findByTestId("rsvp-paused");
  });

  it("/availability not_accepting alone pauses the page", async () => {
    routes({ avail: () => ({ slots: [], closed_reason: "not_accepting", reason: "not_accepting" }) });
    renderAt();
    await settle();
    await screen.findByTestId("rsvp-paused");
    expectPausedPanel();
  });

  it("a 409 not_accepting shows one panel", async () => {
    routes();
    h.post.mockRejectedValue({ response: { status: 409, data: { detail: { error: "not_accepting" } } } });
    renderAt();
    await settle();
    fireEvent.click(await screen.findByRole("radio", { name: "19:00" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpContinue) }));
    await settle();
    fireEvent.change(document.getElementById("rsvp-name"), { target: { value: "Anna" } });
    fireEvent.change(document.getElementById("rsvp-email"), { target: { value: "anna@example.com" } });
    await settle(2);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpConfirm) }));
    await settle();
    await screen.findByTestId("rsvp-paused");
    expectPausedPanel({ title: da.rsvpErrClosed });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("capped salon shows the paused panel", async () => {
    routes({
      page: { ...PAGE, business_type: "salon", providers: [{ id: "r1", name: "Mia" }] },
      sum: paused,
    });
    renderAt();
    await settle();
    await screen.findByTestId("rsvp-paused");
    expect(document.getElementById("rsvp-behandling")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("the time area names the reason and offers the next step", () => {
  it("no table for 7 → call", async () => {
    routes({
      sum: () => summary(Array(14).fill("no_fit")),
      avail: () => ({ slots: [], reason: "no_fit" }),
    });
    renderAt("/r/x?party=7");
    await settle();
    await screen.findByText("Vi kan ikke finde et bord til 7 online.");
    expect(screen.getByText(da.rsvpNoFitCallHint)).toBeTruthy();
    const tel = screen.getByRole("link", { name: /Ring til os: \+45 12 34 56 78/ });
    expect(tel.className).toContain("h-10");
    expect(tel.className).toContain("min-h-0!");
    expect(tel.className).toContain("text-[13px]");
    expect(screen.queryByRole("button", { name: /^Vis / })).toBeNull();
    cleanup();

    // A later day is open (today is not in the summary): the jump is offered.
    routes({
      sum: () => ({ ...summary([null]), days: summary([null]).days.slice(1), next_open_day: plus(1) }),
      avail: (p) => (p.day === TODAY ? { slots: [], reason: "no_fit" } : { slots: ["19:00"] }),
    });
    renderAt("/r/x?party=7");
    await settle();
    await screen.findByText("Vi kan ikke finde et bord til 7 online.");
    expect(screen.getByRole("button", { name: new RegExp(`^Vis ${dayLabel(plus(1))}`) })).toBeTruthy();
  });

  it("full selected day still jumps forward", async () => {
    routes({
      sum: () => ({ ...summary([null]), days: summary([null]).days.slice(1), next_open_day: plus(1) }),
      avail: (p) => (p.day === TODAY ? { slots: [], reason: "full" } : { slots: ["19:00"] }),
    });
    renderAt();
    await settle();
    await screen.findByText(`Fuldt booket til 2 gæster denne dag. Næste ledige dag: ${dayLabel(plus(1))}`);
    fireEvent.click(screen.getByRole("button", { name: `Vis ${dayLabel(plus(1))}` }));
    await settle();
    expect(await screen.findByRole("radio", { name: "19:00" })).toBeTruthy();
    expect(calls.some(([u, p]) => u.endsWith("/availability") && p?.day === plus(1))).toBe(true);
  });

  it("nothing open in a short window", async () => {
    const reasons = [...Array(8).fill("closed").map((r, i) => (i % 2 ? "full" : r)), ...Array(6).fill("not_yet_bookable")];
    routes({
      page: { ...PAGE, max_advance_days: 7 },
      sum: () => summary(reasons),
      avail: () => ({ slots: [], reason: "closed" }),
    });
    renderAt();
    await settle();
    await screen.findByText(/Ingen ledige tider de næste 8 dage\./);
    expect(pageText()).not.toMatch(/14 dage/);
    expect(screen.getByRole("link", { name: /Ring til os/ }).className).toContain("min-h-0!");
  });

  it("nothing open in 14 days offers another date", async () => {
    routes({
      sum: () => summary(Array(14).fill("full")),
      avail: () => ({ slots: [], reason: "full" }),
    });
    renderAt();
    await settle();
    await screen.findByText(`Fuldt booket til 2 gæster denne dag. ${da.rsvpFullOrClosedWeek}`);
    const times = document.getElementById("rsvp-times").parentElement;
    fireEvent.click(within(times).getByRole("button", { name: da.rsvpOtherDate }));
    await settle(2);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: da.rsvpNextMonth })).toBeTruthy();
  });

  it('salon: a stylist with no time never reads "Lukket"', async () => {
    // Both days open per the summary; the stylist has no time tomorrow for
    // this behandling. The old page said "Lukket denne dag. Næste ledige:
    // <today>" — closed, and a jump backwards.
    routes({
      page: { ...PAGE, business_type: "salon", providers: [{ id: "r1", name: "Mia" }] },
      sum: () => summary([]),
      prov: (p) => (p.day === TODAY ? { slots: [{ start: `${TODAY}T10:00:00`, resource_id: "r1", staff_id: null, duration_min: 45 }] } : { slots: [] }),
    });
    renderAt();
    await settle(14);
    await screen.findByRole("radio", { name: "10:00" });
    fireEvent.click(chipFor(await dateRadios(), plus(1)));
    await settle(6);
    await screen.findByText(da.rsvpNoSlotsDay);
    expect(pageText()).not.toMatch(/lukket/i);
    expect(screen.queryByRole("button", { name: /^Vis / })).toBeNull();
  });

  it.each([
    ["salon", { business_type: "salon", providers: [{ id: "r1", name: "Mia" }] }, "prov"],
    ["clothing", { business_type: "clothing" }, "avail"],
  ])("%s speaks no table words", async (_label, extra, via) => {
    const tableWords = /bord|table|gæst|guest/i;
    for (const [reason, sentence] of [
      ["full", da.rsvpReasonFullAppt],
      ["no_fit", da.rsvpReasonNoFitAppt],
    ]) {
      routes({
        page: { ...PAGE, ...extra },
        sum: () => ({ ...summary([null, "full", "no_fit", "too_late", "closed"]), days: summary([null, "full", "no_fit", "too_late", "closed"]).days.slice(1), next_open_day: null }),
        avail: () => ({ slots: [], reason }),
        prov: () => ({ slots: [], ...(via === "prov" ? {} : { reason }) }),
      });
      renderAt();
      await settle(14);
      if (via === "avail") await screen.findByText(new RegExp(sentence.replace(/[.]/g, "\\.")));
      // The strip names each state in appointment words ("kun via telefon").
      await waitFor(() => expect(ariaText()).toContain(`${dayLabel(plus(2))} — ${da.rsvpDayPhoneAriaAppt}`));
      expect(ariaText()).toContain(`${dayLabel(plus(1))} — ${da.rsvpDayFullAria}`);
      expect(pageText()).not.toMatch(tableWords);
      expect(ariaText()).not.toMatch(tableWords);
      cleanup();
    }
  });

  it("a late reason for another party never shows", async () => {
    let release;
    routes({
      avail: (p) =>
        Number(p.party) === 7
          ? new Promise((r) => { release = () => r({ data: { slots: [], reason: "no_fit" } }); })
          : { slots: ["19:00"] },
    });
    renderAt("/r/x?party=7");
    await settle();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const party = screen.getByRole("radiogroup", { name: da.rsvpPartySize });
    fireEvent.click(within(party).getByRole("radio", { name: "2 gæster" }));
    await settle();
    await act(async () => { release(); });
    await settle();
    expect(pageText()).not.toMatch(/bord til 7/);
    expect(pageText()).not.toMatch(/Vi kan ikke finde et bord/);
    // Positive control: the same answer for the party ON screen does show.
    h.get.mockImplementation((url, cfg) => {
      if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: [], reason: "no_fit" } });
      if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: summary() });
      return Promise.resolve({ data: url === "/public/reservations/x" ? PAGE : {} });
    });
    fireEvent.click(within(party).getByRole("radio", { name: "7 gæster" }));
    await settle();
    expect(await screen.findByText("Vi kan ikke finde et bord til 7 online.")).toBeTruthy();
  });
});

describe("party sizes on a phone", () => {
  it("party 1–10 sit in a 2x5 grid at 40 px", async () => {
    routes();
    renderAt();
    await settle();
    const group = await screen.findByRole("radiogroup", { name: da.rsvpPartySize });
    const chips = within(group).getAllByRole("radio");
    expect(chips).toHaveLength(10);
    expect(group.className).toMatch(/(^|\s)grid(\s|$)/);
    expect(group.className).not.toContain("overflow-x-auto");
    expect(group.style.getPropertyValue("--party-cols-phone")).toBe("5");
    for (const c of chips) {
      expect(c.className).toContain("h-10!");
      expect(c.className).toContain("min-h-0!");
      expect(c.className).not.toMatch(/(^|\s)h-11(\s|$)/);
    }
    chips[4].focus();
    fireEvent.keyDown(chips[4], { key: "ArrowRight" });
    expect(document.activeElement).toBe(chips[5]);
    expect(chips[5].getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    [7, "7"],
    [8, "4"],
  ])("party columns follow the ceiling (max %i → %s per row)", async (max, cols) => {
    routes({ page: { ...PAGE, max_party_size: max } });
    renderAt();
    await settle();
    const group = await screen.findByRole("radiogroup", { name: da.rsvpPartySize });
    expect(group.style.getPropertyValue("--party-cols-phone")).toBe(cols);
    expect(group.className).not.toContain("overflow-x-auto");
  });

  it("a ceiling above 10 keeps the swipe row", async () => {
    routes({ page: { ...PAGE, max_party_size: 14 } });
    renderAt();
    await settle();
    const group = await screen.findByRole("radiogroup", { name: da.rsvpPartySize });
    expect(group.className).toContain("overflow-x-auto");
    expect(within(group).getAllByRole("radio")[0].className).toContain("h-11");
  });

  it("group and phone rules survive the grid", async () => {
    routes({ avail: (p) => (Number(p.party) >= 8 ? { slots: ["18:00"], group_request: true } : { slots: ["19:00"] }) });
    renderAt();
    await settle();
    const group = await screen.findByRole("radiogroup", { name: da.rsvpPartySize });
    fireEvent.click(within(group).getByRole("radio", { name: "8 gæster" }));
    await settle();
    expect(calls.some(([u, p]) => u.endsWith("/availability") && Number(p?.party) === 8)).toBe(true);
    expect(await screen.findByRole("heading", { name: da.rsvpPickWishedTime })).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "10 gæster" }));
    await settle();
    expect(pageText()).toContain("Er I flere end 10? Ring til os");
    expect(document.querySelectorAll('a[href^="tel:"]').length).toBeGreaterThan(1);
  });
});

describe("the Other date calendar marks only what the page knows", () => {
  const open = async (embed) => {
    routes({ sum: () => summary([null, "full", "closed"]) });
    renderAt(embed ? "/r/x?embed=1" : "/r/x");
    await settle();
    const before = summaryCalls();
    fireEvent.click(await screen.findByRole("button", { name: da.rsvpOtherDate }));
    await settle(2);
    const legend = screen.getByTestId("calendar-legend");
    return { before, legend, cal: legend.parentElement };
  };

  it.each([[false], [true]])("calendar marks known days and explains only what it shows (embed: %s)", async (embed) => {
    const { before, legend, cal } = await open(embed);
    // The embed opens the calendar inline (a sheet would sit below the frame).
    if (embed) expect(screen.queryByRole("dialog")).toBeNull();
    else expect(screen.getByRole("dialog")).toBeTruthy();
    const full = within(cal).getAllByRole("button").find((b) => b.getAttribute("aria-label")?.startsWith(dayLabel(plus(1))));
    const shut = within(cal).getAllByRole("button").find((b) => b.getAttribute("aria-label")?.startsWith(dayLabel(plus(2))));
    expect(full.disabled).toBe(true);
    expect(full.querySelector('[data-mark="dot"]')).toBeTruthy();
    expect(full.className).not.toContain("line-through");
    expect(full.getAttribute("aria-label")).toMatch(/— fuldt booket$/);
    expect(shut.disabled).toBe(true);
    expect(shut.className).toContain("line-through");
    expect(shut.getAttribute("aria-label")).toMatch(/— lukket$/);
    expect(legend.textContent).toContain("lukket");
    expect(legend.textContent).toContain("fuldt");
    expect(legend.textContent).not.toContain("kun tlf.");
    expect(legend.textContent).not.toContain("Book op til"); // January holds no day past max
    // No request of its own.
    expect(summaryCalls()).toBe(before);
    // March 2030 holds days past max (8 Jan + 60 = 9 Mar): the window entry shows.
    fireEvent.click(within(cal).getByRole("button", { name: da.rsvpNextMonth }));
    fireEvent.click(within(cal).getByRole("button", { name: da.rsvpNextMonth }));
    await settle(2);
    expect(screen.getByTestId("calendar-legend").textContent).toBe("Book op til 60 dage frem");
    const past = within(cal).getAllByRole("button").find((b) => b.textContent === "20");
    expect(past.disabled).toBe(true);
    expect(past.getAttribute("aria-label")).toMatch(/— booking åbner /);
  });
});
