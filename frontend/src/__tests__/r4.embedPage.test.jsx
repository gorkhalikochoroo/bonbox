/**
 * Booking R4 — "the embed fits any website", on the real booking page.
 *
 *  E7  the compact header (&compact=1, embed only): no logo, name or
 *      address — the restaurant's own page shows them — one row of step dots
 *      and DA/EN over the trust line; the name stays the one h1 for a screen
 *      reader. Step 2 and the paused page keep their rules.
 *  #5  party chips 44 px on a phone, 40 px from sm (embed and standalone).
 *      the card follows the owner's chosen width up to 560 in the embed;
 *      standalone keeps max-w-md.
 *  E2  the height message every snippet listens for is unchanged — so a
 *      snippet pasted before R4 keeps sizing itself.
 *
 * The clock is pinned (Date only) to Tuesday 8 January 2030, 09:00.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const TIMES = ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00"];

function summary({ closedReason = null } = {}) {
  const days = Array.from({ length: 14 }, (_, i) => ({
    date: plus(i),
    has_slots: !closedReason,
    reason: closedReason,
  }));
  return {
    from: TODAY, party_size: 2, next_open_day: closedReason ? null : TODAY, days,
    ...(closedReason ? { closed_reason: closedReason } : {}),
  };
}

function routes({ page = PAGE, sum = () => summary(), avail = () => ({ slots: TIMES }) } = {}) {
  h.get.mockImplementation((url, cfg) => {
    const p = cfg?.params || {};
    if (url === "/public/reservations/x") {
      const out = typeof page === "function" ? page() : page;
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
    if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: sum(p) });
    if (url === "/public/reservations/x/availability") return Promise.resolve({ data: avail(p) });
    if (url === "/public/reservations/x/floor") return Promise.resolve({ data: { tables: [] } });
    return Promise.resolve({ data: {} });
  });
}

const renderAt = (p = "/r/x") =>
  render(
    <MemoryRouter initialEntries={[p]}>
      <Routes>
        <Route path="/r/:slug" element={<ReservationPublicPage />} />
      </Routes>
    </MemoryRouter>,
  );

const partyChips = () => within(screen.getByRole("radiogroup", { name: da.rsvpPartySize })).getAllByRole("radio");

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
  document.documentElement.classList.remove("bb-embed-card");
});

describe("E7 · the compact header (&compact=1)", () => {
  it("step 1: one row of step dots + DA/EN over the trust line; no logo, name or address on show", async () => {
    routes();
    renderAt("/r/x?embed=1&compact=1");
    await settle();
    const head = screen.getByTestId("rsvp-compact-header");
    // The one h1 is the venue's name, for a screen reader only.
    const h1s = document.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Bistro Test");
    expect(h1s[0].className).toContain("sr-only");
    expect(head.contains(h1s[0])).toBe(true);
    // Nothing the host page already shows.
    expect(within(head).queryByText("Gade 1")).toBeNull();
    expect(head.querySelector('a[href^="tel:"]')).toBeNull();
    expect(head.querySelector("img")).toBeNull();
    expect(within(head).queryByText("BT")).toBeNull(); // the monogram tile
    expect(within(head).queryByText(da.rsvpBookATable)).toBeNull(); // the eyebrow
    // What stays: the trust line, the language switch, the step dots — once.
    expect(within(head).getByText(da.rsvpTrustLine)).toBeInTheDocument();
    expect(within(head).getByRole("group", { name: "Sprog · Language" })).toBeInTheDocument();
    const dots = within(head).getByRole("progressbar");
    expect(dots).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    // The dots and DA/EN share ONE row, above the trust line.
    const row = dots.parentElement.parentElement;
    expect(within(row).getByRole("group", { name: "Sprog · Language" })).toBeInTheDocument();
    expect(row.compareDocumentPosition(within(head).getByText(da.rsvpTrustLine)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The booking itself is untouched: party, dates and times are there.
    expect(partyChips()).toHaveLength(10);
    expect(screen.getAllByRole("radio").some((r) => r.textContent.trim() === "19:00")).toBe(true);
  });

  it("step 2: the dots say 2, DA/EN stays, no trust line (as in the full header)", async () => {
    routes();
    renderAt("/r/x?embed=1&compact=1");
    await settle();
    await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "19:00")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
    await settle(4);
    const head = screen.getByTestId("rsvp-compact-header");
    expect(within(head).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(within(head).queryByText(da.rsvpTrustLine)).toBeNull();
    expect(within(head).getByRole("group", { name: "Sprog · Language" })).toBeInTheDocument();
    expect(document.getElementById("rsvp-name")).not.toBeNull();
  });

  it("paused: no dots, no trust line — DA/EN and the venue's phone panel stay", async () => {
    routes({ sum: () => summary({ closedReason: "not_accepting" }) });
    renderAt("/r/x?embed=1&compact=1");
    await settle();
    const head = screen.getByTestId("rsvp-compact-header");
    expect(screen.getByTestId("rsvp-paused")).toBeInTheDocument();
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(within(head).queryByText(da.rsvpTrustLine)).toBeNull();
    expect(within(head).getByRole("group", { name: "Sprog · Language" })).toBeInTheDocument();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("a snippet pasted before R4 (?embed=1 alone) keeps the full header", async () => {
    routes();
    renderAt("/r/x?embed=1");
    await settle();
    expect(screen.queryByTestId("rsvp-compact-header")).toBeNull();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Bistro Test");
    expect(h1.className).not.toContain("sr-only");
    expect(screen.getByText("Gade 1")).toBeInTheDocument();
    expect(screen.getByText(da.rsvpTrustLine)).toBeInTheDocument();
    // The dots stand on their own row under the header, as before.
    expect(screen.getByRole("banner").contains(screen.getByRole("progressbar"))).toBe(false);
  });

  it("only in the embed: the standalone page ignores &compact=1", async () => {
    routes();
    renderAt("/r/x?compact=1");
    await settle();
    expect(screen.queryByTestId("rsvp-compact-header")).toBeNull();
    expect(screen.getByText("Gade 1")).toBeInTheDocument();
  });

  it("works for a salon's words too (no party question; the name is still the h1)", async () => {
    routes({ page: { ...PAGE, business_name: "Salon Test", business_type: "frisor", behandlinger: [] } });
    renderAt("/r/x?embed=1&compact=1");
    await settle();
    const head = screen.getByTestId("rsvp-compact-header");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")).toHaveTextContent("Salon Test");
    expect(within(head).getByRole("group", { name: "Sprog · Language" })).toBeInTheDocument();
  });
});

describe("#5 · party chips: 44 px on a phone, 40 px from sm", () => {
  const isPhone44 = (c) => {
    expect(c.className).toMatch(/(^|\s)h-11!(\s|$)/);
    expect(c.className).toMatch(/(^|\s)sm:h-10!(\s|$)/);
    expect(c.className).toContain("min-h-0!");
    expect(c.className).not.toMatch(/(^|\s)h-10!(\s|$)/); // no bare 40 px on a phone
  };

  it.each(["/r/x?embed=1", "/r/x?embed=1&compact=1", "/r/x"])("the 1–10 grid on %s", async (path) => {
    routes();
    renderAt(path);
    await settle();
    for (const c of partyChips()) isPhone44(c);
  });

  it("the swipe row for a ceiling above 10", async () => {
    routes({ page: { ...PAGE, max_party_size: 12 } });
    renderAt("/r/x?embed=1");
    await settle();
    const chips = partyChips();
    expect(chips).toHaveLength(12);
    for (const c of chips) isPhone44(c);
  });
});

describe("the card follows the owner's chosen width (embed only)", () => {
  it("embed: main and the bottom bar's row grow with the frame up to 560 px", async () => {
    routes();
    renderAt("/r/x?embed=1&compact=1");
    await settle();
    const main = document.querySelector("main");
    expect(main.className).toMatch(/(^|\s)max-w-\[560px\](\s|$)/);
    expect(main.className).not.toMatch(/(^|\s)max-w-md(\s|$)/);
    const row = screen.getByTestId("rsvp-cta-bar").firstElementChild;
    expect(row.className).not.toContain("max-w-md");
    expect(row.className).toContain("px-4");
  });

  it("standalone: max-w-md everywhere, as before", async () => {
    routes();
    renderAt("/r/x");
    await settle();
    expect(document.querySelector("main").className).toMatch(/(^|\s)max-w-md(\s|$)/);
    const row = screen.getByTestId("rsvp-cta-bar").firstElementChild;
    expect(row.className).toContain("max-w-md mx-auto");
  });

  it("the loading card in the embed has the same cap, so nothing jumps when the page lands", async () => {
    routes({ page: () => new Promise(() => {}) });
    const { container } = renderAt("/r/x?embed=1");
    await settle(2);
    const card = container.querySelector('[class*="max-w-[560px]"]');
    expect(card).not.toBeNull();
    expect(card.className).toContain("min-[450px]:rounded-[16px]");
  });
});

describe("E2 · the height message is unchanged (old snippets keep sizing themselves)", () => {
  let parentDesc;
  let rectSpy;
  afterEach(() => {
    if (parentDesc) Object.defineProperty(window, "parent", parentDesc);
    rectSpy?.mockRestore();
  });

  it("posts {type:'bonbox:height', height:<whole px>} to the host, with '*'", async () => {
    const postMessage = vi.fn();
    parentDesc = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { value: { postMessage }, configurable: true });
    rectSpy = vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue({ height: 776.2 });
    routes();
    renderAt("/r/x?embed=1&compact=1");
    await settle();
    expect(postMessage).toHaveBeenCalledWith({ type: "bonbox:height", height: 777 }, "*");
    for (const [msg, target] of postMessage.mock.calls) {
      expect(Object.keys(msg).sort()).toEqual(["height", "type"]);
      expect(Number.isInteger(msg.height)).toBe(true);
      expect(target).toBe("*");
    }
  });
});
