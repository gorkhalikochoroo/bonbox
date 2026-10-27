/**
 * A full night on the guest booking page (booking R12, rubric G5).
 *
 * A full evening used to be a dead end: the "fuldt" chip could not be tapped
 * and the page jumped to the next open day. Now, when the venue takes waitlist
 * names (page.waitlist_on) and the server says a night is full, the guest can
 * pick that night and gets the nearest free times (one tap each) and "Skriv mig
 * på ventelisten" — a name, a phone, an optional time, the same invisible spam
 * signals as a booking — and a receipt with a signed link to leave the list.
 *
 * The clock is pinned (Date only) to Tuesday 8 January 2030, 09:00.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), lang: "da", confirm: vi.fn() }));
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { resetReceipts: _resetReceipts } = await import("../components/booking/fullNightKit");
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
  lead_time_min: 60, language: "da", guest_can_pick_table: false, waitlist_on: true,
};
const THU = plus(2);
const NIGHT = ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30"];
const FULL = {
  slots: [], reason: "full", evening_full: false,
  nearest: [
    { date: plus(1), times: ["18:30", "19:00", "19:30"] },
    { date: plus(3), times: ["18:00", "21:00"] },
  ],
  waitlist_open: true, waitlist_times: NIGHT,
};

function summary(reasons = []) {
  const list = Array.from({ length: 14 }, (_, i) => {
    const r = i < reasons.length ? reasons[i] : null;
    return { date: plus(i), has_slots: r === null, reason: r };
  });
  const first = list.find((d) => d.has_slots);
  return { from: TODAY, party_size: 2, next_open_day: first ? first.date : null, days: list };
}

let calls = [];
function routes({ page = PAGE, sum = () => summary([null, null, "full"]), avail } = {}) {
  calls = [];
  const answer = avail || ((p) => (p.day === THU ? FULL : { slots: ["18:00", "19:00"] }));
  h.get.mockImplementation((url, cfg) => {
    calls.push([url, cfg?.params]);
    const p = cfg?.params || {};
    if (url === "/public/reservations/x") return Promise.resolve({ data: page });
    if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: sum(p) });
    if (url === "/public/reservations/x/availability") {
      const out = answer(p);
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
    if (url.startsWith("/public/reservations/booking/waitlist/")) {
      return h.receipt ? h.receipt(url, p) : Promise.reject(Object.assign(new Error("x"), { response: { status: 404 } }));
    }
    return Promise.resolve({ data: {} });
  });
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}
const renderAt = (path = "/r/x") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:slug" element={<><ReservationPublicPage /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
const where = () => new URLSearchParams(screen.getByTestId("where").textContent);
const dayLabel = (iso, lang = "da") =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === "en" ? "en-GB" : "da-DK", { weekday: "long", day: "numeric", month: "long" });
const dateRadios = async (name = da.rsvpPickDate) =>
  within(await screen.findByRole("radiogroup", { name })).getAllByRole("radio");
const chipFor = (radios, iso, lang = "da") => radios.find((r) => r.getAttribute("aria-label")?.startsWith(dayLabel(iso, lang)));
const pickThursday = async () => {
  const chip = chipFor(await dateRadios(), THU);
  fireEvent.click(chip);
  await settle();
  return screen.findByTestId("rsvp-full-night");
};
const joinCta = () => screen.getByRole("button", { name: da.rsvpWlOfferCta });
const type = (el, value) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 0, 8, 9, 0));
  h.get.mockReset();
  h.post.mockReset();
  h.confirm.mockReset();
  h.confirm.mockResolvedValue(true);
  h.receipt = null;
  h.lang = "da";
  _resetReceipts();
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

describe("the strip: a full night is a choice when the venue takes waitlist names", () => {
  it('"fuldt" is a button with the waitlist on, and stays disabled without it', async () => {
    routes();
    renderAt();
    await settle();
    const chip = chipFor(await dateRadios(), THU);
    expect(chip.disabled).toBe(false);
    expect(chip.textContent).toContain("fuldt");
    expect(chip.getAttribute("aria-label")).toBe(`${dayLabel(THU)} — fuldt booket`);
    expect(chip.className).not.toContain("cursor-not-allowed");
    cleanup();
    routes({ page: { ...PAGE, waitlist_on: false } });
    renderAt();
    await settle();
    expect(chipFor(await dateRadios(), THU).disabled).toBe(true);
  });

  it("a closed day stays disabled, waitlist or not", async () => {
    routes({ sum: () => summary([null, "closed", "full"]) });
    renderAt();
    await settle();
    const radios = await dateRadios();
    expect(chipFor(radios, plus(1)).disabled).toBe(true);
    expect(chipFor(radios, THU).disabled).toBe(false);
  });

  it("a salon never gets the full-night choice", async () => {
    routes({ page: { ...PAGE, business_type: "salon", providers: [{ id: "r1", name: "Mia" }] } });
    renderAt();
    await settle();
    const chip = chipFor(await dateRadios(), THU);
    expect(chip.disabled).toBe(true);
  });
});

describe("the full night: nearest free times and the waitlist", () => {
  it("says why, offers the nearest times and the list, and the phone", async () => {
    routes();
    renderAt();
    await settle();
    const block = await pickThursday();
    expect(block.textContent).toContain("Fuldt booket til 2 gæster denne dag.");
    const near = within(screen.getByTestId("rsvp-nearest"));
    expect(near.getByText(da.rsvpNearestTitle)).toBeTruthy();
    expect(near.getAllByRole("button").map((b) => b.textContent)).toEqual(["18:30", "19:00", "19:30", "18:00", "21:00"]);
    expect(near.getByRole("button", { name: `Book ${dayLabel(plus(1))} kl. 19:00` })).toBeTruthy();
    expect(block.textContent).toContain("Det er ikke en reservation");
    expect(joinCta()).toBeTruthy();
    expect(within(block).getByRole("link", { name: /Ring til os/ }).getAttribute("href")).toBe("tel:%2B4512345678");
  });

  it("a nearest time on another day moves there with that time picked", async () => {
    routes();
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(screen.getByRole("button", { name: `Book ${dayLabel(plus(3))} kl. 18:00` }));
    await settle();
    const radios = await dateRadios();
    expect(chipFor(radios, plus(3)).getAttribute("aria-checked")).toBe("true");
    // The picked time stays picked once that day's times are in; the bar says Continue.
    const tile = screen.getAllByRole("radio").find((r) => r.textContent.trim() === "18:00");
    expect(tile.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: /Fortsæt|Continue/ })).toBeTruthy();
  });

  it("the page's first day still moves on from a full tonight (times on the first screen)", async () => {
    routes({ sum: () => summary(["full"]), avail: (p) => (p.day === TODAY ? FULL : { slots: ["19:00"] }) });
    renderAt();
    await settle();
    const radios = await dateRadios();
    expect(chipFor(radios, plus(1)).getAttribute("aria-checked")).toBe("true");
  });

  it("a ?d= link to a full night stays on it", async () => {
    routes();
    renderAt(`/r/x?d=${THU}`);
    await settle();
    expect(chipFor(await dateRadios(), THU).getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByTestId("rsvp-full-night")).toBeTruthy();
  });

  it("no offer from the server (an older backend): the page says what it said before", async () => {
    routes({ avail: (p) => (p.day === THU ? { slots: [], reason: "full" } : { slots: ["19:00"] }) });
    renderAt();
    await settle();
    fireEvent.click(chipFor(await dateRadios(), THU));
    await settle();
    expect(screen.queryByTestId("rsvp-full-night")).toBeNull();
    expect(document.body.textContent).toContain("Fuldt booket til 2 gæster denne dag.");
  });

  it("a closed list keeps the nearest times and the phone, with no form", async () => {
    routes({ avail: (p) => (p.day === THU ? { ...FULL, waitlist_open: false, waitlist_times: undefined } : { slots: ["19:00"] }) });
    renderAt();
    await settle();
    await pickThursday();
    expect(screen.getByTestId("rsvp-nearest")).toBeTruthy();
    expect(screen.queryByRole("button", { name: da.rsvpWlOfferCta })).toBeNull();
    expect(screen.queryByTestId("rsvp-wl-offer")).toBeNull();
  });

  it("a full evening on a day with lunch times: the lunch grid, then the evening's block", async () => {
    const EVE = {
      slots: ["12:00", "12:30", "15:30"], evening_full: true,
      nearest: [{ date: THU, times: ["15:30"] }, { date: plus(3), times: ["19:00"] }],
      waitlist_open: true, waitlist_times: NIGHT,
    };
    routes({ avail: (p) => (p.day === THU ? EVE : { slots: ["19:00"] }) });
    renderAt();
    await settle();
    fireEvent.click(chipFor(await dateRadios(), THU));
    await settle();
    const block = await screen.findByTestId("rsvp-full-night");
    expect(screen.getByTestId("rsvp-time-grid").textContent).toContain("12:30");
    expect(block.textContent).toContain("Aftenen er fuldt booket til 2 gæster.");
    // The same day's earlier times are already in the grid above.
    expect(within(screen.getByTestId("rsvp-nearest")).getAllByRole("button").map((b) => b.textContent)).toEqual(["19:00"]);
    fireEvent.click(joinCta());
    expect(screen.getByRole("option", { name: da.rsvpWlAnyTimeEvening })).toBeTruthy();
  });
});

describe("joining the list", () => {
  it("posts the guest's words with the spam signals, shows the receipt and keeps the link", async () => {
    routes();
    h.post.mockResolvedValue({ data: {
      id: "w-1", status: "waiting", waitlist_date: THU, party_size: 2, preferred_time: "19:30",
      erased: false, waitlist_token: "tok-1",
    } });
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    expect(form.textContent).toContain("Det er ikke en reservation.");
    type(within(form).getByLabelText(da.rsvpName), "  Agnes Holm ");
    type(within(form).getByLabelText(da.rsvpWlPhone), "+45  20 30 40 50");
    fireEvent.change(within(form).getByLabelText(da.rsvpWlPreferredTime), { target: { value: "19:30" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    await settle();
    expect(h.post).toHaveBeenCalledTimes(1);
    const [url, body] = h.post.mock.calls[0];
    expect(url).toBe("/public/reservations/x/waitlist");
    expect(body).toMatchObject({
      day: THU, party_size: 2, guest_name: "Agnes Holm", guest_phone: "+45 20 30 40 50",
      preferred_time: "19:30", lang: "da", website: "",
    });
    expect(typeof body.form_ms).toBe("number");
    const receipt = await screen.findByTestId("rsvp-wl-receipt");
    expect(receipt.textContent).toContain(da.rsvpWlDoneTitle);
    expect(receipt.textContent).toContain("omkring kl. 19:30");
    // The number never breaks across lines: no-break spaces on screen (G10 item 7).
    expect(receipt.textContent).toContain("kan Bistro Test kontakte dig på +45\u00a020\u00a030\u00a040\u00a050");
    expect(within(receipt).getByRole("button", { name: da.rsvpWlLeave })).toBeTruthy();
    expect(where().get("wl")).toBe("w-1");
    expect(where().get("wt")).toBe("tok-1");
  });

  it("the trap field sits out of reach, like the booking form's", async () => {
    routes();
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const hp = screen.getByTestId("rsvp-wl-hp");
    expect(hp.getAttribute("aria-hidden")).toBe("true");
    const input = hp.querySelector("input");
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("name")).toBe("bb_trap_7");
  });

  it("asks for a name and a phone before sending", async () => {
    routes();
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    expect(h.post).not.toHaveBeenCalled();
    expect(form.textContent).toContain(da.rsvpNameRequired);
    expect(form.textContent).toContain(da.rsvpWlPhoneNeeded);
    type(within(form).getByLabelText(da.rsvpName), "Agnes");
    type(within(form).getByLabelText(da.rsvpWlPhone), "12");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    expect(h.post).not.toHaveBeenCalled();
    expect(form.textContent).toContain(da.rsvpPhoneCheck);
  });

  it.each([
    // The number keeps together on screen (no-break spaces, fix round 5).
    [409, { error: "waitlist_unavailable" }, "Vi kan ikke skrive dig på ventelisten lige nu. Ring til os: +45\u00a012\u00a034\u00a056\u00a078"],
    [429, {}, "For mange forsøg — prøv igen senere."],
    [500, {}, "Noget gik galt"],
  ])("a %s keeps what was typed and says so", async (status, detail, words) => {
    routes();
    h.post.mockRejectedValue(Object.assign(new Error("x"), { response: { status, data: { detail } } }));
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    type(within(form).getByLabelText(da.rsvpName), "Agnes");
    type(within(form).getByLabelText(da.rsvpWlPhone), "20304050");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    await settle();
    expect(within(form).getByRole("alert").textContent).toContain(words);
    expect(within(form).getByLabelText(da.rsvpName).value).toBe("Agnes");
    expect(within(form).getByLabelText(da.rsvpWlPhone).value).toBe("20304050");
  });

  it("a 422 invalid_phone points at the phone field", async () => {
    routes();
    h.post.mockRejectedValue(Object.assign(new Error("x"), {
      response: { status: 422, data: { detail: [{ msg: "Value error, invalid_phone" }] } },
    }));
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    type(within(form).getByLabelText(da.rsvpName), "Agnes");
    type(within(form).getByLabelText(da.rsvpWlPhone), "20304050");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    await settle();
    expect(form.textContent).toContain(da.rsvpPhoneCheck);
  });

  it("a table that just opened up: says so and asks for the times again", async () => {
    routes();
    h.post.mockRejectedValue(Object.assign(new Error("x"), { response: { status: 409, data: { detail: { error: "not_full" } } } }));
    renderAt();
    await settle();
    await pickThursday();
    const before = calls.filter(([u, p]) => u.endsWith("/availability") && p?.day === THU).length;
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    type(within(form).getByLabelText(da.rsvpName), "Agnes");
    type(within(form).getByLabelText(da.rsvpWlPhone), "20304050");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    await settle();
    expect(document.body.textContent).toContain(da.rsvpWlErrNotFull);
    const after = calls.filter(([u, p]) => u.endsWith("/availability") && p?.day === THU).length;
    expect(after).toBeGreaterThan(before);
  });

  it("a receipt with no link (the server wrote nothing new) offers the phone to leave", async () => {
    routes();
    h.post.mockResolvedValue({ data: { id: "x", status: "waiting", waitlist_date: THU, party_size: 2, erased: false, waitlist_token: "" } });
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    type(within(form).getByLabelText(da.rsvpName), "Agnes");
    type(within(form).getByLabelText(da.rsvpWlPhone), "20304050");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    const receipt = await screen.findByTestId("rsvp-wl-receipt");
    expect(within(receipt).queryByRole("button", { name: da.rsvpWlLeave })).toBeNull();
    // No-break spaces in the number on screen (G10 item 7).
    expect(receipt.textContent).toContain("Vil du af listen, så ring på +45\u00a012\u00a034\u00a056\u00a078.");
    expect(where().get("wl")).toBeNull();
  });
});

describe("leaving, and coming back through the link", () => {
  it("leave asks first, erases, and drops the link", async () => {
    routes();
    h.post.mockImplementation((url) => (url.endsWith("/cancel")
      ? Promise.resolve({ data: { id: "w-1", status: "left", waitlist_date: THU, party_size: 2, erased: true } })
      : Promise.resolve({ data: { id: "w-1", status: "waiting", waitlist_date: THU, party_size: 2, erased: false, waitlist_token: "tok-1" } })));
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    type(within(form).getByLabelText(da.rsvpName), "Agnes");
    type(within(form).getByLabelText(da.rsvpWlPhone), "20304050");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    const receipt = await screen.findByTestId("rsvp-wl-receipt");
    await act(async () => {
      fireEvent.click(within(receipt).getByRole("button", { name: da.rsvpWlLeave }));
    });
    await settle();
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: da.rsvpWlLeaveConfirmTitle, destructive: true, confirmLabel: da.rsvpWlLeaveConfirmYes,
    }));
    expect(h.post).toHaveBeenLastCalledWith("/public/reservations/booking/waitlist/w-1/cancel", null, { params: { token: "tok-1" } });
    const after = screen.getByTestId("rsvp-wl-receipt");
    expect(after.textContent).toContain(da.rsvpWlLeft);
    expect(after.textContent).toContain(da.rsvpWlErased);
    expect(where().get("wl")).toBeNull();
  });

  it("a guest who changes their mind about leaving stays on the list", async () => {
    routes();
    h.confirm.mockResolvedValue(false);
    h.receipt = () => Promise.resolve({ data: { id: "w-9", status: "waiting", waitlist_date: THU, party_size: 4, preferred_time: null, erased: false } });
    renderAt("/r/x?wl=w-9&wt=tok-9");
    await settle();
    const card = await screen.findByTestId("rsvp-wl-return");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: da.rsvpWlLeave }));
    });
    expect(h.post).not.toHaveBeenCalled();
  });

  it("the link brings the place back (no name, no phone), and leave works there", async () => {
    routes();
    h.receipt = (url, p) => {
      expect(url).toBe("/public/reservations/booking/waitlist/w-9");
      expect(p).toEqual({ token: "tok-9" });
      return Promise.resolve({ data: { id: "w-9", status: "waiting", waitlist_date: THU, party_size: 4, preferred_time: null, erased: false } });
    };
    h.post.mockResolvedValue({ data: { id: "w-9", status: "left", waitlist_date: THU, party_size: 4, erased: true } });
    renderAt("/r/x?wl=w-9&wt=tok-9");
    await settle();
    const card = await screen.findByTestId("rsvp-wl-return");
    expect(card.textContent).toContain(da.rsvpWlDoneTitle);
    expect(card.textContent).toContain("4 gæster");
    expect(card.textContent).toContain("kan Bistro Test kontakte dig på telefon");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: da.rsvpWlLeave }));
    });
    await settle();
    expect(screen.getByTestId("rsvp-wl-return").textContent).toContain(da.rsvpWlLeft);
  });

  it.each([
    [{ status: "booked", booked_day: THU, booked_time: "21:00" }, "Bistro Test har reserveret et bord til dig"],
    [{ status: "closed", erased: true }, "Ventelisten for"],
  ])("the link says %o truthfully", async (extra, words) => {
    routes();
    h.receipt = () => Promise.resolve({ data: { id: "w-9", waitlist_date: THU, party_size: 2, erased: false, ...extra } });
    renderAt("/r/x?wl=w-9&wt=tok-9");
    await settle();
    const card = await screen.findByTestId("rsvp-wl-return");
    expect(card.textContent).toContain(words);
    expect(within(card).queryByRole("button", { name: da.rsvpWlLeave })).toBeNull();
  });

  it("an expired link says so", async () => {
    routes();
    renderAt("/r/x?wl=w-9&wt=old");
    await settle();
    expect((await screen.findByTestId("rsvp-wl-return-failed")).textContent).toContain(da.rsvpWlLinkFailed);
  });
});

describe("English", () => {
  it("speaks English on a full night", async () => {
    h.lang = "en";
    routes();
    renderAt();
    await settle();
    fireEvent.click(chipFor(await dateRadios(en.rsvpPickDate), THU, "en"));
    await settle();
    const block = await screen.findByTestId("rsvp-full-night");
    expect(block.textContent).toContain("Fully booked for 2 guests this day.");
    expect(block.textContent).toContain(en.rsvpNearestTitle);
    expect(screen.getByRole("button", { name: en.rsvpWlOfferCta })).toBeTruthy();
    expect(block.textContent).toContain("It isn't a booking — if a table frees up, Bistro Test may contact you by phone.");
  });
});

// Fix round 27 Oct — design judge G10 item 3: one main green on the full
// night. The sticky bar's "Vælg tid" led nowhere under the offer and under
// "Du er på ventelisten"; the nearest times stopped 16 px short of the row.
describe("G10 item 3: the full night has one main green and full rows", () => {
  it("no sticky bar while the offer is on screen; a nearest time picked brings it back", async () => {
    routes();
    renderAt();
    await settle();
    expect(screen.getByTestId("rsvp-cta-bar")).toBeTruthy();       // an open day: the bar (control)
    await pickThursday();
    expect(screen.queryByTestId("rsvp-cta-bar")).toBeNull();
    const near = screen.getByTestId("rsvp-nearest");
    for (const row of near.querySelectorAll("li > div")) {
      expect(row.className).toContain("grid-cols-3");
      expect(row.className).toContain("flex-1");
    }
    for (const tile of within(near).getAllByRole("button")) expect(tile.className).toMatch(/(^| )w-full( |$)/);
    fireEvent.click(within(near).getAllByRole("button")[0]);
    await settle();
    expect(screen.queryByTestId("rsvp-full-night")).toBeNull();
    expect(screen.getByTestId("rsvp-cta-bar")).toBeTruthy();
  });

  it("nor under the guest's place on the list once they joined", async () => {
    routes();
    h.post.mockResolvedValue({ data: {
      id: "w-1", status: "waiting", waitlist_date: THU, party_size: 2, preferred_time: null,
      erased: false, waitlist_token: "tok-1",
    } });
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    type(within(form).getByLabelText(da.rsvpName), "Agnes Holm");
    type(within(form).getByLabelText(da.rsvpWlPhone), "+45 20 30 40 50");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    await settle();
    expect(await screen.findByTestId("rsvp-wl-receipt")).toBeTruthy();
    expect(screen.queryByTestId("rsvp-cta-bar")).toBeNull();
    expect(screen.queryByRole("button", { name: da.rsvpPickTimeShort })).toBeNull();
  });
});

// Design judge G10 item 7: the receipt's numbers never break across lines,
// and "Meld mig af ventelisten" is a quiet bordered button (as the call
// button), not loose ghost text.
describe("G10 item 7: the waitlist receipt", () => {
  it("the leave button is bordered like the call button; the typed number keeps together", async () => {
    routes();
    h.post.mockResolvedValue({ data: {
      id: "w-1", status: "waiting", waitlist_date: THU, party_size: 2, preferred_time: null,
      erased: false, waitlist_token: "tok-1",
    } });
    renderAt();
    await settle();
    await pickThursday();
    fireEvent.click(joinCta());
    const form = screen.getByTestId("rsvp-wl-form");
    type(within(form).getByLabelText(da.rsvpName), "Agnes Holm");
    type(within(form).getByLabelText(da.rsvpWlPhone), "+45 22 33 44 66");
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: da.rsvpWlOfferCta }));
    });
    await settle();
    const receipt = await screen.findByTestId("rsvp-wl-receipt");
    expect(receipt.textContent).toContain("+45\u00a022\u00a033\u00a044\u00a066");
    expect(receipt.textContent).not.toContain("+45 22");
    const leave = within(receipt).getByRole("button", { name: da.rsvpWlLeave });
    for (const c of ["border", "border-gray-200", "h-10", "rounded-lg", "text-[13px]"]) expect(leave.className, c).toContain(c);
    expect(leave.className).not.toContain("-ml-3.5");
    // What was sent is what the guest typed (the spaces are for the eye only).
    expect(h.post.mock.calls[0][1].guest_phone).toBe("+45 22 33 44 66");
  });
});
