/**
 * I dag's motion (components/today/todayMotion.jsx + today.css): Vagtplan's
 * feel on the owner's today page, held to the house rules.
 *
 *   • Reduced motion (or a browser that cannot say): every figure is its
 *     final value from the first paint, nothing carries td-intro.
 *   • The figures rise into place as ONE piece each (the clock-in figure's
 *     entrance, CLOCK-MOTION-SPEC 2.2): the exact final text from the first
 *     DOM the page ever has — never a 0, a digit in between or a lone
 *     separator — and a screen reader hears that same text (nothing
 *     aria-hidden, no second copy).
 *   • One beat: the hero stands still while its figures rise; a card's
 *     figures rise only once that card has landed.
 *   • Once per visit: the intro plays the first time this account sees this
 *     business day in this session (sessionStorage), never on a poll, a
 *     refresh on the freshness bus or a return to the page; a new business
 *     day plays it once.
 *   • The end re-renders nothing (the class is the DOM's), and it waits for a
 *     card whose data came late to finish its entrance (never past the cap).
 *   • Press: Vagtplan's controller is installed while the page is up. Haptics
 *     only on an outcome — Skjul (feel.soft) and a real segment change
 *     (feel.tick); navigation is silent (PREMIUM-FEEL-SPEC A.5, 1.4).
 *   • today.css: transform/opacity only, no loop, every entrance gated by
 *     .td-intro, Vagtplan's press scales, grouped rows only tint (also under
 *     reduce), the tab press names its own transition properties.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Profiler } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: vi.fn() } }));
vi.mock("../lib/swrCache", () => ({ peekGet: () => null }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "da",
    t: (k, vars) => (vars && typeof vars === "object" ? `${k}(${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join(",")})` : k),
  }),
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1", business_type: "restaurant", currency: "DKK", role: "owner" } }) }));
vi.mock("../hooks/usePillars", () => ({ usePillars: () => ({ hiddenPillars: new Set() }) }));
const feelSpy = vi.hoisted(() => ({ soft: vi.fn(), tick: vi.fn(), warm: vi.fn(), done: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock("../components/staff/feel", () => ({ feel: feelSpy, resetFeelForTests: () => {} }));

import TodayDashboard from "../components/today/TodayDashboard";
import { INTRO_CAP_MS, INTRO_KEY, INTRO_MS, introStamp } from "../components/today/todayMotion";
import { formatOwnerMoney } from "../utils/currency";
import { laborLine, salesTile, staffSummary, tonightCovers } from "../components/today/todayModel";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = fs.readFileSync(path.join(SRC, "components/today/today.css"), "utf8");
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");   // the rules, without their comments
const t = (k, vars) => (vars && typeof vars === "object" ? `${k}(${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join(",")})` : k);

function payload(over = {}) {
  return {
    business_day: "2026-11-12",
    weekday: 3,
    now: "14:32",
    now_minutes: 14 * 60 + 32,
    cutoff_hour: 6,
    hours: { open: "11:00", close: "23:00" },
    day_state: "open",
    sales: { today: 9840, today_closed: false, today_sale_count: 31, yesterday: 16200, last_week_same_day: 15100, trend: null, uses_daily_close: true, confirmed_closes_30d: 20 },
    reservations: {
      has_book: true, seats: 28, count: 2, covers: 6, requested: 1, waitlist: 0,
      peak: { time: "19:00", covers: 28, full: true },
      slots: [{ t: "18:00", m: 1080, covers: 4 }, { t: "18:30", m: 1110, covers: 6 }],
      items: [
        { id: "r1", time: "18:00", name: "Larsen", party: 4, tables: ["T4"], status: "confirmed", allergy: false, occasion: null },
        { id: "r2", time: "12:00", name: "Petersen", party: 2, tables: ["T3"], status: "confirmed", allergy: false, occasion: null },
      ],
    },
    staff: {
      uses_clock: false, clocked_in_now: null,
      shifts: [
        { id: "s1", staff_id: "a", name: "Sangita", role: "Køkkenchef", start_time: "09:00", end_time: "17:00", status: "published", confirmed_at: "2026-11-10T10:00:00" },
        { id: "s2", staff_id: "b", name: "Emil", role: "Bartender", start_time: "16:00", end_time: "23:00", status: "published", confirmed_at: "2026-11-10T10:00:00" },
      ],
    },
    close: {
      today: { date: "2026-11-12", status: "none", revenue: null, closed_at: null, steps: {} },
      yesterday: { date: "2026-11-11", status: "confirmed", revenue: 16200, closed_at: "23:42", steps: { photo: true, sales: true, payments: true, locked: true } },
      days: [{ date: "2026-11-11", status: "confirmed", revenue: 16200, venue_closed: false }],
    },
    schedule: { week_start: "2026-11-09", week_number: 46, drafts: 0 },
    labor: { week_start: "2026-11-09", week_number: 46, planned_by_day: [0, 34, 36, 41, 46, 48, 38], logged_by_day: [0, 33.5, 36.5, 14.5, 0, 0, 0], planned_total: 243, logged_total: 84.5, labor_pct_ex_moms: 0.3125, settled_days: 2, target_pct: 0.3, missing_wage: 0 },
    revisor: { has_accountant_email: true, schedule: null },
    badges: {},
    ...over,
  };
}
const FORESIGHT = { available: true, deadline: { date: "2027-03-01", days_until: 109, period_label: "2. halvår" }, moms: { realized: 83520, expected: 113834 }, action: { weekly_rate: 230063, weeks: 15, already_covered: false } };
const FINDINGS = [{ code: "unconfirmed_reservations", severity: "info", deep_link: "/reservations", meta: { count: 1 } }];

let today = payload();
function serve() {
  get.mockImplementation((url) => {
    if (url === "/today") return Promise.resolve({ data: today });
    if (url === "/cashflow/forecast") return Promise.resolve({ data: { foresight: FORESIGHT } });
    if (url === "/diagnostics/needs-you") return Promise.resolve({ data: { findings: FINDINGS } });
    return Promise.resolve({ data: null });
  });
}
function mount(data = today, { onCommit = null } = {}) {
  const page = <TodayDashboard initial={data} initialAt={null} />;
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="*" element={onCommit ? <Profiler id="today" onRender={onCommit}>{page}</Profiler> : page} />
      </Routes>
    </MemoryRouter>,
  );
}
/** Let the page's first reads (a 0 ms timer + resolved promises) land, and time pass. */
async function flush(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}
function motionPref({ reduce }) {
  window.matchMedia = (q) => ({
    matches: !!reduce && /reduce/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

// The figures, by where they sit.
const tileV = (href) => document.querySelector(`a.td-tile[href="${href}"] .td-tile-v`);
const momsBig = () => document.querySelector('section[aria-labelledby="td-moms-h"] .td-big');
const hoursBig = () => document.querySelector('section[aria-labelledby="td-hours-h"] .td-big');
const laborLineEl = () => document.querySelector('section[aria-labelledby="td-hours-h"] .td-k-foot span > span');
const page = () => document.querySelector(".td-page");
const intro = () => page().classList.contains("td-intro");
// What a screen reader gets: every text node outside an aria-hidden subtree.
const spoken = (node) => {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute("aria-hidden") === "true") return "";
  return [...node.childNodes].map(spoken).join("");
};

// The model's own answers, formatted the way the page formats them.
function expected(data = today) {
  const money = (v) => formatOwnerMoney(v, "DKK");
  const nowMin = data.now_minutes;
  const sum = staffSummary(data.staff.shifts, nowMin, data.cutoff_hour);
  const fmtH = (h) => String(Math.round((h || 0) * 10) / 10).replace(".", ",");
  return {
    sales: money(salesTile(data.sales, data.day_state).amount),
    covers: String(tonightCovers(data.reservations, data.cutoff_hour).covers),
    staff: t("tdXofY", { x: sum.onNow, y: sum.total }),
    moms: `~${money(FORESIGHT.action.weekly_rate)}`,
    hours: fmtH(data.labor.logged_total),
    labor: t("tdLaborPct", { pct: laborLine(data.labor).pct }),
  };
}
const figures = () => ({
  sales: tileV("/sales"), covers: tileV("/reservations"), staff: tileV("/staff/schedule"),
  moms: momsBig(), labor: laborLineEl(),
});

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  today = payload();
  serve();
  sessionStorage.clear();
  Object.values(feelSpy).forEach((f) => f.mockReset());
});
afterEach(() => {
  delete window.matchMedia;
  vi.useRealTimers();
});

describe("reduced motion: the final values at once", () => {
  it("prefers-reduced-motion → no intro, every figure final (one plain text) from the first paint", async () => {
    motionPref({ reduce: true });
    mount();
    // Before any read has answered: already the exact values.
    expect(intro()).toBe(false);
    expect(tileV("/sales").textContent).toBe(expected().sales);
    expect(tileV("/reservations").textContent).toBe(expected().covers);
    expect(tileV("/staff/schedule").textContent).toBe(expected().staff);
    await flush(1);
    expect(momsBig().textContent).toBe(expected().moms);
    expect(hoursBig().childNodes[0].nodeValue).toBe(expected().hours);
    expect(laborLineEl().textContent).toBe(expected().labor);
    for (const [k, fig] of Object.entries(figures())) expect(fig.childElementCount, k).toBe(0);
    await flush(INTRO_MS + 100);
    expect(intro()).toBe(false);
  });

  it("a browser that cannot say (no matchMedia) is treated as reduced", () => {
    mount();
    expect(intro()).toBe(false);
    expect(tileV("/sales").textContent).toBe(expected().sales);
  });
});

describe("the intro: the figures rise into place, each the exact value from its first frame", () => {
  it("a figure never shows anything but its final text: no 0, no digit in between, no lone separator — and aria hears the same", async () => {
    motionPref({ reduce: false });
    // Every text any figure ever has, from the very first DOM on (a
    // MutationObserver sees each commit before the browser could paint it).
    const seen = new Set();
    const look = () => document.querySelectorAll(".td-fig").forEach((n) => seen.add(n.textContent));
    const mo = new MutationObserver(look);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      mount();
      look();
      expect(intro()).toBe(true);
      await flush(1);
      await flush(INTRO_MS + 100);
      look();
    } finally {
      mo.disconnect();
    }
    const want = expected();
    const finals = new Set([...document.querySelectorAll(".td-fig")].map((n) => n.textContent));
    expect([...seen].filter((s) => !finals.has(s))).toEqual([]);
    for (const [k, fig] of Object.entries(figures())) {
      expect(fig.classList.contains("td-fig"), k).toBe(true);
      expect(fig.textContent, k).toBe(want[k]);
      expect(spoken(fig), k).toBe(want[k]);
      expect(fig.querySelector("[aria-hidden], .sr-only"), k).toBeNull();
    }
    expect(hoursBig().childNodes[0].nodeValue).toBe(want.hours);
    expect(hoursBig().querySelector("small").textContent).toBe("tdOfPlannedHours(hours=243)");
    // Danish format, unmistakably: the dot thousands separator and " kr.".
    expect(want.sales).toBe("9.840 kr.");
    expect(want.moms).toBe("~230.063 kr.");
    expect(document.querySelector(".vp-roll, .vp-roll-cell")).toBeNull();
  });

  it("one beat: the hero stands still (no rise of its own); a card's figures rise once their card has landed", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    const hero = document.querySelector("section.td-hero");
    expect(hero.classList.contains("td-rise")).toBe(false);
    expect(hero.style.animationDelay).toBe("");
    // The hero's figures carry no delay of their own: today.css's 80 ms.
    for (const href of ["/sales", "/reservations", "/staff/schedule"]) expect(tileV(href).style.animationDelay).toBe("");
    // A card's figure starts when its card's tdRise (0.5 s) has ended.
    const riseS = Number(BARE.match(/\.td-intro \.td-rise \{ animation: tdRise ([\d.]+)s /)[1]);
    const landed = (sec) => `${parseInt(sec.style.animationDelay, 10) + riseS * 1000}ms`;
    const moms = document.querySelector('section[aria-labelledby="td-moms-h"]');
    const hours = document.querySelector('section[aria-labelledby="td-hours-h"]');
    expect(momsBig().style.animationDelay).toBe(landed(moms));
    expect(hoursBig().style.animationDelay).toBe(landed(hours));
    expect(laborLineEl().style.animationDelay).toBe(landed(hours));
    expect(landed(moms)).toBe("840ms");
    // …and that is inside the intro: the card's figure has landed by its end.
    expect(840 + 460).toBeLessThan(INTRO_MS);
  });
});

describe("the end of the intro", () => {
  it("comes at INTRO_MS by itself and re-renders nothing (the class is the DOM's)", async () => {
    motionPref({ reduce: false });
    let commits = 0;
    mount(today, { onCommit: () => { commits += 1; } });
    await flush(1);
    expect(intro()).toBe(true);
    const fig = tileV("/sales");
    const before = commits;
    await flush(INTRO_MS - 10);
    expect(intro()).toBe(true);
    await flush(20);
    expect(intro()).toBe(false);
    expect(commits).toBe(before);
    // The very same node, the very same text.
    expect(tileV("/sales")).toBe(fig);
    expect(fig.textContent).toBe(expected().sales);
  });

  it("waits for a card that is still entering (its data came late), then goes; never past the cap", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    let finish;
    const late = {
      animationName: "tdGrowX", playState: "running",
      effect: { getTiming: () => ({ iterations: 1 }) },
      finished: new Promise((res) => { finish = res; }),
    };
    // A loader's loop and a press transition never hold it.
    const spin = { animationName: "spin", playState: "running", effect: { getTiming: () => ({ iterations: Infinity }) }, finished: new Promise(() => {}) };
    const press = { transitionProperty: "scale", playState: "running", effect: { getTiming: () => ({ iterations: 1 }) }, finished: new Promise(() => {}) };
    let running = [late, spin, press];
    page().getAnimations = () => running;
    await flush(INTRO_MS + 10);
    expect(intro()).toBe(true);           // the MOMS meter is still filling
    late.playState = "finished";
    running = [spin, press];
    await act(async () => { finish(); });
    await flush(1);
    expect(intro()).toBe(false);
  });

  it("an entrance that never ends is cut at the cap, and only there", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    page().getAnimations = () => [{ animationName: "tdRise", playState: "running", effect: { getTiming: () => ({ iterations: 1 }) }, finished: new Promise(() => {}) }];
    await flush(INTRO_CAP_MS - 20);
    expect(intro()).toBe(true);
    await flush(30);
    expect(intro()).toBe(false);
  });

  it("only the page's own entrances count: nothing running but a loader → it goes at INTRO_MS", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    page().getAnimations = () => [{ animationName: "spin", playState: "running", effect: { getTiming: () => ({ iterations: Infinity }) }, finished: new Promise(() => {}) }];
    await flush(INTRO_MS + 10);
    expect(intro()).toBe(false);
  });
});

describe("once per visit", () => {
  it("is remembered for the account + business day at the start, and a poll or the freshness bus never replays it", async () => {
    motionPref({ reduce: false });
    mount();
    expect(intro()).toBe(true);
    expect(sessionStorage.getItem(INTRO_KEY)).toBe(introStamp("u1", "2026-11-12"));
    await flush(1);
    await flush(INTRO_MS + 100);
    expect(intro()).toBe(false);

    // A refresh with a new figure: it simply IS the new figure.
    today = payload({ sales: { ...payload().sales, today: 10500 } });
    await act(async () => { window.dispatchEvent(new Event("bonbox-data-changed")); });
    await flush(1);
    expect(tileV("/sales").textContent).toBe(formatOwnerMoney(10500, "DKK"));
    expect(intro()).toBe(false);

    // The five-minute poll: same.
    today = payload({ sales: { ...payload().sales, today: 11200 } });
    await flush(5 * 60 * 1000);
    expect(tileV("/sales").textContent).toBe(formatOwnerMoney(11200, "DKK"));
    expect(intro()).toBe(false);
  });

  it("a day that rolls over under a poll on the same mount never plays; it is only remembered", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    await flush(INTRO_MS + 100);
    today = payload({ business_day: "2026-11-13" });
    await act(async () => { window.dispatchEvent(new Event("bonbox-data-changed")); });
    await flush(1);
    expect(intro()).toBe(false);
    expect(sessionStorage.getItem(INTRO_KEY)).toBe(introStamp("u1", "2026-11-13"));
  });

  it("back on the page (a new mount) the same day: no intro, final values at once", async () => {
    motionPref({ reduce: false });
    const first = mount();
    await flush(200);                       // leaves mid-intro
    first.unmount();
    mount();
    expect(intro()).toBe(false);
    expect(tileV("/sales").textContent).toBe(expected().sales);
  });

  it("a new business day plays it once more", async () => {
    motionPref({ reduce: false });
    const first = mount();
    await flush(1);
    first.unmount();
    today = payload({ business_day: "2026-11-13" });
    mount(today);
    expect(intro()).toBe(true);
    expect(sessionStorage.getItem(INTRO_KEY)).toBe(introStamp("u1", "2026-11-13"));
  });

  it("sessionStorage that throws never breaks the page (it just plays, and shows the truth)", async () => {
    motionPref({ reduce: false });
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const spy2 = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      mount();
      expect(intro()).toBe(true);
      expect(spoken(tileV("/sales"))).toBe(expected().sales);
    } finally {
      spy.mockRestore(); spy2.mockRestore();
    }
  });
});

describe("press + haptics", () => {
  function pointer(target, type, { pointerType = "touch" } = {}) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerType, isPrimary: true, clientX: 10, clientY: 10 });
    target.dispatchEvent(e);
  }

  it("Vagtplan's press controller runs while the page is up: buttons at once, cards and grouped rows 70 ms late", () => {
    const { unmount } = mount();
    const btn = document.querySelector(".td-head-actions .td-btn");
    pointer(btn, "pointerdown");
    expect(document.documentElement.dataset.modality).toBe("touch");
    expect(btn.hasAttribute("data-pressed")).toBe(true);
    pointer(btn, "pointerup");
    const tile = document.querySelector("a.td-tile");
    expect(tile.classList.contains("vp-row")).toBe(true);
    pointer(tile, "pointerdown");
    expect(tile.hasAttribute("data-pressed")).toBe(false);
    act(() => { vi.advanceTimersByTime(80); });
    expect(tile.hasAttribute("data-pressed")).toBe(true);
    pointer(tile, "pointerup");
    const row = document.querySelector("a.td-brow");
    expect(row.classList.contains("vp-tint")).toBe(true);
    expect(document.querySelector("a.td-step").classList.contains("vp-tint")).toBe(true);
    unmount();
    expect(document.documentElement.dataset.modality).toBeUndefined();
  });

  it("navigation is silent: no haptic on any link or on Kræver dig's answer (it only opens a page)", async () => {
    mount();
    await flush(1);
    const navs = [
      ...document.querySelectorAll(".td-head-actions a, .td-quick a, a.td-brow, a.td-tile, a.td-step, .td-k-foot a.td-btn"),
      ...document.querySelectorAll("#td-needs .td-btn"),
    ];
    expect(navs.length).toBeGreaterThan(8);
    for (const el of navs) fireEvent.click(el);
    expect(feelSpy.soft).not.toHaveBeenCalled();
    expect(feelSpy.tick).not.toHaveBeenCalled();
    // The source keeps it that way: feel.soft appears once, on Skjul.
    const src = fs.readFileSync(path.join(SRC, "components/today/TodayDashboard.jsx"), "utf8");
    expect(src.match(/feel\.soft\(\)/g)).toHaveLength(1);
    expect(src).toMatch(/className="td-x" onClick=\{\(\) => \{ feel\.soft\(\); onDismiss\(item\); \}\}/);
  });

  it("Skjul (an outcome, here and now) gives one light tap; a tick only on a real segment change", async () => {
    mount();
    await flush(1);
    fireEvent.click(document.querySelector("#td-needs .td-x"));
    expect(feelSpy.soft).toHaveBeenCalledTimes(1);
    // Lunch (12:00) + dinner (18:00): the segment shows; tapping the chosen one is no change.
    const seg = document.querySelector(".td-seg");
    const [lunch, dinner] = seg.querySelectorAll("button");
    const chosen = lunch.getAttribute("aria-pressed") === "true" ? lunch : dinner;
    const other = chosen === lunch ? dinner : lunch;
    fireEvent.click(chosen);
    expect(feelSpy.tick).not.toHaveBeenCalled();
    fireEvent.click(other);
    expect(feelSpy.tick).toHaveBeenCalledTimes(1);
    expect(feelSpy.soft).toHaveBeenCalledTimes(1);
  });
});

describe("today.css: calm by construction", () => {
  const keyframes = [...CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)];

  it("every keyframe moves transform and opacity only, and nothing loops", () => {
    expect(keyframes.length).toBeGreaterThanOrEqual(5);
    for (const [, name, body] of keyframes) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(["transform", "opacity"], `${name}: ${p}`).toContain(p);
    }
    expect(CSS).not.toMatch(/\binfinite\b/);
    expect(CSS).not.toMatch(/animation[^;]*\b(pulse|breathe|ping|glow)/i);
  });

  it("every entrance plays only under .td-intro; the figure's rise is Vagtplan's vp-roll-in-up, as one piece", () => {
    const animated = [...BARE.matchAll(/^([^@{}\n][^{}]*)\{[^}]*\banimation:\s*td\w+/gm)].map((m) => m[1].trim());
    expect(animated.length).toBeGreaterThanOrEqual(7);
    for (const sel of animated) for (const part of sel.split(",")) expect(part.trim()).toMatch(/^\.td-intro /);
    expect(BARE).toMatch(/\.td-intro \.td-fig \{ animation: tdRollInUp 460ms var\(--td-spring-soft\) 80ms backwards; \}/);
    expect(BARE).toMatch(/@keyframes tdRollInUp \{ from \{ opacity: 0; transform: translateY\(\.6em\); \} \}/);
    // The digit-by-digit roll (and its lone separators) is gone; the hero has no entrance of its own.
    expect(BARE).not.toMatch(/vp-roll/);
    expect(BARE).not.toMatch(/\.td-pill-dot \{[^}]*animation/);
    expect(CSS).toMatch(/--td-dur-press: 0\.11s;/);
    expect(CSS).toMatch(/--td-spring: cubic-bezier\(\.34, 1\.4, \.64, 1\);/);
  });

  it("the press: .97 buttons, .94 the small ✕, .985 stand-alone cards, a tint for grouped rows; reduce dims instead of scaling", () => {
    expect(CSS).toMatch(/\.td-page :is\(\.td-btn, \.td-link, \.td-seg button\)\[data-pressed\]:not\(:disabled\) \{\s*scale: \.97;/);
    expect(CSS).toMatch(/\.td-page \.td-x\[data-pressed\]:not\(:disabled\) \{\s*scale: \.94;/);
    expect(CSS).toMatch(/\.td-page \.td-tile\[data-pressed\] \{\s*scale: \.985;/);
    expect(CSS).toMatch(/\.td-row\.vp-tint\[data-pressed\] \{\s*scale: none;\s*background-color: var\(--td-press-tint\);/);
    const reduce = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(CSS.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
    expect(reduce).toMatch(/html\[data-modality="touch"\] \.td-page \.td-tile\[data-pressed\] \{ scale: none; opacity: \.72; \}/);
    expect(reduce).toMatch(/\.td-tab:active \{ scale: none; opacity: \.72; \}/);
  });

  it("a grouped row only tints, with motion and under reduce: the plain-control press (and its dim) skips .vp-tint", () => {
    const plain = 'html[data-modality="touch"] :where(.td-page :is(button, a, [role="button"]):not(.vp-tint))[data-pressed]:not(:disabled)';
    const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(CSS.slice(0, at)).toContain(`${plain} { scale: .97; }`);
    expect(CSS.slice(at)).toContain(plain);           // the mirror, with the same selector text
    expect(BARE).not.toMatch(/:where\(\.td-page :is\(button, a, \[role="button"\]\)\)\[data-pressed\]/);
  });

  it("the tab press names its own properties, so index.css's touch `a:active { transition: scale 60ms }` cannot cut the list", () => {
    const rule = BARE.match(/\.td-tab:active \{([^}]*)\}/)[1];
    expect(rule).toMatch(/scale: \.96;/);
    expect(rule).toMatch(/transition-property: color, scale;/);
    expect(rule).toMatch(/transition-duration: var\(--td-dur-fast\), var\(--td-dur-press\);/);
  });
});
