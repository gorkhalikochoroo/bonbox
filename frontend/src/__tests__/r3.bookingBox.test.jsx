/**
 * Booking R3 — the booking box, calm and finished (judge 24 Oct 2026,
 * "Refined, finished", changes 1–12), on the real page.
 *
 *  1  the time grid never blinks on a fast answer; taps are blocked at once
 *  2  tiles: quiet rest, one calm pick, a closed day without a box
 *  3  geometry at the snippet widths: a date grid from 450 px, balanced times,
 *     a skeleton the shape of the times
 *  4  one elevation in the embed from 450 px; &flat=1 keeps it flat
 *  6  today's chip is right on the first paint (no white → ink flash)
 *  7  type on the scale, antialiased on the booking root
 *  8  step motion 220 ms / 4 px; 6 px step dots
 *  9  the bottom bar on a hairline; the main action's neutral contact shadow
 * 10  the bar's words arrive only when they change; the hero on the doctrine curve
 * 11  the step area eases between heights (the wrapper is there)
 *
 * The clock is pinned (Date only) to Tuesday 8 January 2030, 09:00.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const TODAY = "2030-01-08";
const plus = (n) => {
  const d = new Date(2030, 0, 8 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const wait = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const PAGE = {
  business_name: "Bistro Test", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Gade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false,
};
const ELEVEN = ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00"];

function summary(reasons = [], days = 14) {
  const list = Array.from({ length: days }, (_, i) => {
    const r = i < reasons.length ? reasons[i] : null;
    return { date: plus(i), has_slots: r === null, reason: r };
  });
  const first = list.find((d) => d.has_slots);
  return { from: TODAY, party_size: 2, next_open_day: first ? first.date : null, days: list };
}

function routes({ page = PAGE, sum = () => summary(), avail = () => ({ slots: ELEVEN }) } = {}) {
  h.get.mockImplementation((url, cfg) => {
    const p = cfg?.params || {};
    if (url === "/public/reservations/x") {
      const out = typeof page === "function" ? page() : page;
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
    if (url === "/public/reservations/x/availability-summary") {
      const out = sum(p);
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
    if (url === "/public/reservations/x/availability") {
      const out = avail(p);
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
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

const dateGroup = () => screen.getByRole("radiogroup", { name: da.rsvpPickDate });
const dateRadios = () => within(dateGroup()).getAllByRole("radio");
const partyRadios = () => within(screen.getByRole("radiogroup", { name: da.rsvpPartySize })).getAllByRole("radio");
const timeGroup = () => screen.getByRole("radiogroup", { name: da.rsvpGroupDinner });
const timeRadios = () => within(timeGroup()).getAllByRole("radio");
const html = () => document.documentElement;

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
  html().classList.remove("bb-embed-card");
});

describe("6 · today's chip is right on the first paint", () => {
  // The day used to be seeded by an effect AFTER the strip's first paint:
  // the chip was created unchecked and flipped to checked — a white → ink
  // fade ~650 ms into the load. Now it is created checked.
  const flips = [];
  let mo;
  const watch = () => {
    flips.length = 0;
    mo = new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.attributeName === "aria-checked" && r.oldValue === "false" && r.target.getAttribute("aria-checked") === "true") {
          flips.push(r.target.getAttribute("aria-label") || r.target.textContent);
        }
      }
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["aria-checked"] });
  };
  afterEach(() => mo?.disconnect());

  it("today: no day chip ever flips from unchecked to checked during the load", async () => {
    routes({ sum: () => new Promise(() => {}), avail: () => new Promise(() => {}) });
    watch();
    renderAt();
    await settle();
    const checked = dateRadios().filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toBe(dateRadios()[0]);
    expect(flips).toEqual([]);
    // The party chip too (2 by default).
    expect(partyRadios()[1].getAttribute("aria-checked")).toBe("true");
  });

  it("a ?d=&party= link: the link's day and party are checked from the first paint", async () => {
    routes({ sum: () => new Promise(() => {}), avail: () => new Promise(() => {}) });
    watch();
    renderAt(`/r/x?d=${plus(3)}&party=4`);
    await settle();
    const checked = dateRadios().filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toBe(dateRadios()[3]);
    expect(partyRadios()[3].getAttribute("aria-checked")).toBe("true");
    expect(flips).toEqual([]);
  });

  it("rescueDay still moves a closed today to the next open day once the summary says so", async () => {
    routes({ sum: () => summary(["closed"]) });
    renderAt();
    await settle();
    expect(dateRadios()[1].getAttribute("aria-checked")).toBe("true");
    expect(dateRadios()[0].disabled).toBe(true);
  });

  it("asks the summary once, for the seeded party (no second ask after a late seed)", async () => {
    routes();
    renderAt("/r/x?party=4");
    await settle();
    const asks = h.get.mock.calls.filter(([u]) => u.endsWith("/availability-summary"));
    expect(asks).toHaveLength(1);
    expect(asks[0][1].params.party).toBe(4);
  });
});

describe("1 · the time grid never blinks on a fast answer", () => {
  it("taps are blocked at once; it dims only after 180 ms; it comes back when the times land", async () => {
    let release;
    let n = 0;
    routes({
      avail: () => {
        n += 1;
        if (n === 1) return { slots: ELEVEN };
        return new Promise((r) => { release = () => r({ data: { slots: ELEVEN } }); });
      },
    });
    renderAt();
    await settle();
    const grid = screen.getByTestId("rsvp-time-grid");
    expect(grid.className).not.toContain("pointer-events-none");
    expect(grid.getAttribute("data-dim")).toBe("false");
    const before = timeRadios();
    await act(async () => { fireEvent.click(dateRadios()[2]); });
    // Blocked at once — not dimmed yet.
    expect(screen.getByTestId("rsvp-time-grid").className).toContain("pointer-events-none");
    expect(screen.getByTestId("rsvp-time-grid").getAttribute("data-dim")).toBe("false");
    expect(screen.getByTestId("rsvp-time-grid").className).toContain("opacity-100");
    await wait(220);
    expect(screen.getByTestId("rsvp-time-grid").getAttribute("data-dim")).toBe("true");
    expect(screen.getByTestId("rsvp-time-grid").className).toContain("opacity-60");
    expect(screen.getByTestId("rsvp-time-grid").className).not.toContain("opacity-50");
    await act(async () => { release(); });
    await settle();
    const g = screen.getByTestId("rsvp-time-grid");
    expect(g.className).not.toContain("pointer-events-none");
    expect(g.getAttribute("data-dim")).toBe("false");
    // The same times came back: the same nodes, nothing re-mounted.
    timeRadios().forEach((r, i) => expect(r).toBe(before[i]));
  });

  it("a fast answer (under 180 ms) never dims the grid", async () => {
    let n = 0;
    routes({
      avail: () => {
        n += 1;
        if (n === 1) return { slots: ELEVEN };
        return new Promise((r) => setTimeout(() => r({ data: { slots: ELEVEN } }), 60));
      },
    });
    renderAt();
    await settle();
    const seen = [];
    const mo = new MutationObserver(() => seen.push(screen.queryByTestId("rsvp-time-grid")?.getAttribute("data-dim")));
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-dim", "class"] });
    await act(async () => { fireEvent.click(dateRadios()[2]); });
    await wait(120);
    await settle();
    mo.disconnect();
    expect(seen).not.toContain("true");
    expect(screen.getByTestId("rsvp-time-grid").className).toContain("opacity-100");
  });

  it("no whole-grid fade on mount; a NEW time arrives (3 px / 200 ms on the page's curve)", async () => {
    routes();
    renderAt();
    await settle();
    expect(timeGroup().className).not.toContain("fadeIn");
    for (const r of timeRadios()) {
      expect(r.className).toContain("motion-safe:animate-[bbArrive_200ms_cubic-bezier(0.22,1,0.36,1)]");
    }
  });
});

describe("2 · tiles", () => {
  it("party, day and time are tiles: gray-50 at rest, gray-900 picked with a contact shadow", async () => {
    routes();
    renderAt();
    await settle();
    await act(async () => { fireEvent.click(timeRadios()[5]); });
    for (const group of [partyRadios(), dateRadios(), timeRadios()]) {
      const picked = group.filter((r) => r.getAttribute("aria-checked") === "true");
      expect(picked).toHaveLength(1);
      expect(picked[0].className).toContain("bb-tile");
      expect(picked[0].className).toContain("bg-gray-900");
      expect(picked[0].className).toMatch(/shadow-\[0_1px_2px/);
      const rest = group.find((r) => r.getAttribute("aria-checked") !== "true" && !r.disabled);
      expect(rest.className).toContain("bb-tile");
      expect(rest.className).toContain("bg-gray-50");
      expect(rest.className).toContain("pointer-fine:hover:bg-gray-100");
      expect(rest.className).not.toMatch(/(^|\s)bg-white(\s|$)/);
      // Not the shared ui/Chip (it announces aria-pressed on a radio).
      expect(rest.hasAttribute("aria-pressed")).toBe(false);
    }
  });

  it("a picked time keeps weight 500 — no 500 → 600 jump", async () => {
    routes();
    renderAt();
    await settle();
    await act(async () => { fireEvent.click(timeRadios()[5]); });
    const t = timeRadios()[5];
    expect(t.className).toContain("font-medium");
    expect(t.className).not.toContain("font-semibold");
  });

  it("a closed day has no box: transparent fill and line, still disabled with its word", async () => {
    routes({ sum: () => summary([null, "closed"]) });
    renderAt();
    await settle();
    const shut = dateRadios()[1];
    expect(shut.disabled).toBe(true);
    expect(shut.className).toContain("border-transparent");
    expect(shut.className).toContain("bg-transparent");
    expect(shut.className).not.toContain("bg-gray-50");
    expect(shut.textContent).toContain(da.rsvpDayClosed);
  });
});

describe("3 · geometry at the snippet widths (460 / 520 px)", () => {
  it("the date strip is a grid from 450 px: 8 days in one row, 14 in rows of 7", async () => {
    routes({ page: { ...PAGE, max_advance_days: 7 } });
    renderAt();
    await settle();
    expect(dateRadios()).toHaveLength(8);
    expect(dateGroup().style.getPropertyValue("--rail-cols")).toBe("8");
    expect(dateGroup().className).toContain("min-[450px]:grid");
    expect(dateGroup().className).toContain("min-[450px]:grid-cols-[repeat(var(--rail-cols),minmax(0,1fr))]");
    expect(dateGroup().className).not.toContain("sm:grid-cols-7");
    for (const r of dateRadios()) expect(r.className).toContain("min-[450px]:w-auto");
    cleanup();
    routes();
    renderAt();
    await settle();
    expect(dateGroup().style.getPropertyValue("--rail-cols")).toBe("7");
  });

  it("11 times: 4 across on a phone, 6 + 5 from 450 px (no lone 19:30)", async () => {
    routes();
    renderAt();
    await settle();
    expect(timeRadios()).toHaveLength(11);
    expect(timeGroup().className).toContain("grid-cols-4");
    expect(timeGroup().className).toContain("min-[450px]:grid-cols-6");
    expect(timeGroup().className).not.toContain("sm:grid-cols-5");
  });

  it("9 times: 5 + 4 on a phone", async () => {
    routes({ avail: () => ({ slots: ELEVEN.slice(0, 9) }) });
    renderAt();
    await settle();
    expect(timeGroup().className).toMatch(/(^|\s)grid-cols-5(\s|$)/);
  });

  it("the skeleton is three rows of tiles in the grid's own columns", async () => {
    routes({ avail: () => new Promise(() => {}) });
    renderAt();
    await settle();
    const sk = screen.getByTestId("rsvp-times-skeleton");
    expect(sk.className).toBe("grid grid-cols-4 min-[450px]:grid-cols-5 gap-2");
    expect(sk.children).toHaveLength(15);
    expect([...sk.children].filter((c) => c.className.includes("max-[450px]:hidden"))).toHaveLength(3);
    for (const c of sk.children) {
      expect(c.className).toContain("rounded-xl");
      expect(c.className).toContain("h-11");
      expect(c.className).not.toContain("rounded-lg");
    }
  });
});

describe("4 · one elevation in the embed, from 450 px", () => {
  it("embed: a transparent ground that pads one white card; html goes transparent; the bar follows the corners", async () => {
    routes();
    const view = renderAt("/r/x?embed=1");
    await settle();
    const root = screen.getByTestId("rsvp-root");
    expect(root.className).toContain("min-[450px]:bg-transparent");
    expect(root.className).toContain("min-[450px]:pb-6");
    const main = document.querySelector("main");
    expect(main.className).toContain("min-[450px]:bg-white");
    expect(main.className).toContain("min-[450px]:rounded-[16px]");
    expect(main.className).toMatch(/min-\[450px\]:shadow-\[0_0_0_1px_rgb\(16_24_40\/0\.05\)/);
    expect(main.className).not.toMatch(/(^|\s)m[btxy]?-\d/); // padding, never margin, around the card
    expect(screen.getByTestId("rsvp-cta-bar").className).toContain("min-[450px]:rounded-b-[16px]");
    expect(html().classList.contains("bb-embed-card")).toBe(true);
    view.unmount();
    expect(html().classList.contains("bb-embed-card")).toBe(false);
  });

  it("&flat=1 keeps the embed flat: no card, no transparent ground", async () => {
    routes();
    renderAt("/r/x?embed=1&flat=1");
    await settle();
    expect(screen.getByTestId("rsvp-root").className).not.toContain("min-[450px]:bg-transparent");
    expect(document.querySelector("main").className).not.toContain("rounded-[16px]");
    expect(screen.getByTestId("rsvp-cta-bar").className).not.toContain("rounded-b-[16px]");
    expect(html().classList.contains("bb-embed-card")).toBe(false);
  });

  it("the standalone page never wears the embed card", async () => {
    routes();
    renderAt();
    await settle();
    expect(screen.getByTestId("rsvp-root").className).not.toContain("min-[450px]:bg-transparent");
    expect(html().classList.contains("bb-embed-card")).toBe(false);
  });

  it("index.css: html and body go transparent only under .bb-embed-card, only from 450 px", () => {
    const css = read("index.css");
    expect(css).toMatch(/@media \(min-width: 450px\) \{\s*:root\.bb-embed-card,\s*:root\.bb-embed-card body \{ background-color: transparent !important; \}/);
  });
});

describe("7 · type on the scale, antialiased on the booking root", () => {
  it("H1 21, the bar's summary 15 / 13, the button 15 — no half-steps", async () => {
    routes();
    renderAt();
    await settle();
    expect(screen.getByTestId("rsvp-root").className).toContain("antialiased");
    expect(document.querySelector("h1").className).toContain("text-[21px]");
    const bar = screen.getByTestId("rsvp-cta-bar");
    expect(bar.innerHTML).not.toMatch(/text-\[(14\.5|12\.5|15\.5)px\]/);
    const [line1, line2] = bar.querySelectorAll("p");
    expect(line1.className).toContain("text-[15px]");
    expect(line2.className).toContain("text-[13px]");
    const cta = within(bar).getByRole("button", { name: da.rsvpPickTimeShort });
    expect(cta.className).toContain("text-[15px]!");
  });

  it("antialiased stays on the guest page, never global", () => {
    const css = read("index.css");
    expect(css).not.toMatch(/(^|\n)\s*(html|body|:root)[^{]*\{[^}]*font-smoothing/);
  });
});

describe("8 · loading and step motion", () => {
  it("step 1 enters over 220 ms from 4 px on the page's curve; the dots are 6 px, the current 20 px", async () => {
    routes();
    renderAt();
    await settle();
    const step = screen.getByRole("region", { name: da.rsvpBookATable });
    expect(step.className).toContain("motion-safe:animate-[bbStep_220ms_cubic-bezier(0.22,1,0.36,1)]");
    expect(step.className).not.toContain("fadeIn_0.35s");
    const dots = screen.getByRole("progressbar").querySelectorAll("span");
    expect(dots[0].className).toContain("h-1.5");
    expect(dots[0].className).toContain("w-5");
    expect(dots[1].className).toContain("w-1.5");
    expect(dots[0].className).toContain("ease-[cubic-bezier(0.22,1,0.36,1)]");
  });

  it("the step area is one wrapper the height morph can hold", async () => {
    routes();
    renderAt();
    await settle();
    const area = screen.getByTestId("rsvp-step-area");
    expect(area.contains(screen.getByRole("region", { name: da.rsvpBookATable }))).toBe(true);
    expect(area.contains(screen.getByTestId("rsvp-cta-bar"))).toBe(false);
  });

  it("index.css carries the booking keyframes; the step keyframe is its own (the shared fadeIn is untouched)", () => {
    const css = read("index.css");
    for (const k of ["bbStep", "bbArrive", "bbLabel", "bbBreathe", "bbLate", "bbFloat"]) {
      expect(css).toContain(`@keyframes ${k}`);
    }
    expect(css).toMatch(/@keyframes fadeIn \{\s*from \{ opacity: 0; transform: translateY\(8px\); \}/);
    expect(css).toMatch(/\.bb-late \{\s*opacity: 0;\s*animation: bbLate 200ms ease-out 600ms forwards;/);
  });
});

describe("5 · selection timing and touch release", () => {
  it(".bb-tile: 120 ms let-go, 200 ms new pick, scale in the tile's own list; the global press rule untouched", () => {
    const css = read("index.css");
    const rule = css.slice(css.indexOf(".bb-tile {"), css.indexOf("}", css.indexOf(".bb-tile {")));
    expect(rule).toContain("--bb-tile-dur: 120ms");
    expect(rule).toContain("scale 200ms var(--bb-ease)");
    expect(css).toContain('.bb-tile[aria-checked="true"] { --bb-tile-dur: 200ms; }');
    expect(css).toContain(":root { --bb-ease: cubic-bezier(0.22, 1, 0.36, 1); }");
    expect(css).toMatch(/button:active, a:active, \[role="button"\]:active \{\s*scale: 0\.97;\s*transition: scale 60ms ease-out;/);
  });
});

describe("9 · the bottom bar and the main action", () => {
  it("the bar rests on a hairline and floats only when it floats; the button's shadow is neutral, never green", async () => {
    routes();
    renderAt();
    await settle();
    const bar = screen.getByTestId("rsvp-cta-bar");
    expect(bar.className).toContain("bb-cta-bar");
    expect(bar.className).toContain("border-gray-900/[0.07]");
    expect(bar.className).not.toContain("border-gray-200/80");
    const cta = within(bar).getByRole("button", { name: da.rsvpPickTimeShort });
    expect(cta.className).toContain("bb-cta");
    expect(cta.className).toContain("disabled:shadow-none");
    expect(cta.className).toMatch(/shadow-\[[^\]]*0_1px_2px_rgb\(16_24_40\/0\.18\)\]/);
    expect(cta.className).not.toMatch(/shadow-[^\s]*(green|20_83_45)/);
    const css = read("index.css");
    expect(css).toMatch(/@supports \(animation-timeline: scroll\(\)\) \{\s*\.bb-cta-bar \{/);
  });
});

describe("10 · earned motion", () => {
  it("the summary's words arrive when they change, not on first paint", async () => {
    routes();
    renderAt();
    await settle();
    const bar = screen.getByTestId("rsvp-cta-bar");
    const first = bar.querySelector("p");
    expect(first.getAttribute("data-earned")).toBe("still");
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r())); });
    await act(async () => { fireEvent.click(timeRadios()[5]); });
    const line = screen.getByTestId("rsvp-cta-bar").querySelector("p");
    expect(line.textContent).toContain("19:30");
    expect(line.getAttribute("data-earned")).toBe("arrive");
    // The party line did not change: same node, still.
    expect(screen.getByTestId("rsvp-cta-bar").querySelectorAll("p")[1].getAttribute("data-earned")).toBe("still");
    // The button's label changed too ("Vælg tid" → "Fortsæt").
    const label = within(screen.getByTestId("rsvp-cta-bar")).getByText(da.rsvpContinue);
    expect(label.getAttribute("data-earned")).toBe("arrive");
  });

  it("the confirmation icon settles on the doctrine curve at 450 ms — no overshoot", () => {
    const src = read("pages/ReservationPublicPage.jsx");
    expect(src).not.toContain("cubic-bezier(0.2,0.9,0.3,1.2)");
    expect(src).toMatch(/data-testid="rsvp-hero-icon"[\s\S]{0,700}duration-\[450ms\] ease-\[cubic-bezier\(0\.22,1,0\.36,1\)\]/);
  });
});

describe("12 · dark parity on the standalone page", () => {
  it("every tile, skeleton and hairline class the page now uses has its dark pair", async () => {
    routes({ sum: () => summary([null, "closed"]) });
    renderAt();
    await settle();
    await act(async () => { fireEvent.click(timeRadios()[5]); });
    const els = [...partyRadios(), ...dateRadios(), ...timeRadios()];
    for (const el of els) {
      const c = el.className;
      if (c.includes("bg-gray-50")) expect(c).toMatch(/dark:bg-white\/\[0\.04\]/);
      if (c.includes("bg-gray-900")) expect(c).toContain("dark:bg-gray-100");
      if (c.includes("border-gray-900/[0.06]")) expect(c).toMatch(/dark:border-white\/\[0\.08\]/);
    }
    expect(screen.getByTestId("rsvp-cta-bar").className).toMatch(/dark:border-white\/\[0\.08\]/);
  });
});
