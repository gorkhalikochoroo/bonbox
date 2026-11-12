/**
 * I dag's motion (components/today/todayMotion.jsx + today.css): Vagtplan's
 * feel on the owner's today page, held to the house rules.
 *
 *   • Reduced motion (or a browser that cannot say): every figure is its
 *     final value from the first paint, nothing carries td-intro, no roll.
 *   • Screen readers get the final value only — never a "0", never a lone
 *     digit — while the figures roll; the drawn roll is aria-hidden.
 *   • Once per visit: the intro plays the first time this account sees this
 *     business day in this session (sessionStorage), never on a poll, a
 *     refresh on the freshness bus or a return to the page; a new business
 *     day plays it once.
 *   • The roll starts from 0 (the only digit ever shown besides the final
 *     ones), keeps the Danish format at every frame, and ENDS on exactly the
 *     model's formatted value, as plain text.
 *   • The 0 is never committed at rest: the swap to the real value happens in
 *     the same synchronous commit (so before any paint).
 *   • Press: Vagtplan's controller is installed while the page is up; one
 *     light haptic (feel.soft) on a primary action, a tick on a real segment
 *     change, nothing on navigation rows.
 *   • today.css: transform/opacity only, no loop, every entrance gated by
 *     .td-intro, the reduce block undoes the press scale.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
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
import { INTRO_KEY, INTRO_MS, RollIn, introStamp } from "../components/today/todayMotion";
import { ROLL_MS } from "../components/staff/RollingDigits";
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
function mount(data = today) {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="*" element={<TodayDashboard initial={data} initialAt={null} />} />
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
// What a screen reader gets: every text node outside an aria-hidden subtree.
const spoken = (node) => {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute("aria-hidden") === "true") return "";
  return [...node.childNodes].map(spoken).join("");
};
// What the eye gets: the drawn roll without the outgoing digits.
const seen = (fig) => {
  const live = fig.querySelector(".vp-roll").cloneNode(true);
  live.querySelectorAll(".sr-only, .vp-roll-out").forEach((n) => n.remove());
  return live.textContent;
};
const outgoing = (fig) => [...fig.querySelectorAll(".vp-roll-out")].map((n) => n.textContent);

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

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  today = payload();
  serve();
  Object.values(feelSpy).forEach((f) => f.mockReset());
});
afterEach(() => {
  delete window.matchMedia;
  vi.useRealTimers();
});

describe("reduced motion: the final values at once", () => {
  it("prefers-reduced-motion → no intro, no roll, every figure final from the first paint", async () => {
    motionPref({ reduce: true });
    mount();
    // Before any read has answered: already the exact values.
    expect(page().classList.contains("td-intro")).toBe(false);
    expect(document.querySelector(".vp-roll-cell, .vp-roll")).toBeNull();
    expect(tileV("/sales").textContent).toBe(expected().sales);
    expect(tileV("/reservations").textContent).toBe(expected().covers);
    expect(tileV("/staff/schedule").textContent).toBe(expected().staff);
    await flush(1);
    expect(momsBig().textContent).toBe(expected().moms);
    expect(hoursBig().childNodes[0].nodeValue).toBe(expected().hours);
    expect(laborLineEl().textContent).toBe(expected().labor);
    expect(document.querySelector(".vp-roll-cell, .vp-roll")).toBeNull();
    // Nothing is remembered as "played" that never played … but nothing plays later either.
    await flush(INTRO_MS + ROLL_MS);
    expect(page().classList.contains("td-intro")).toBe(false);
  });

  it("a browser that cannot say (no matchMedia) is treated as reduced", () => {
    mount();
    expect(page().classList.contains("td-intro")).toBe(false);
    expect(tileV("/sales").textContent).toBe(expected().sales);
    expect(document.querySelector(".vp-roll")).toBeNull();
  });
});

describe("the intro: figures roll up from 0 once; aria hears the final value", () => {
  it("rolls every figure from 0, keeps the format at every frame, and a screen reader only ever gets the final text", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    expect(page().classList.contains("td-intro")).toBe(true);
    const want = expected();
    const figs = {
      sales: tileV("/sales"), covers: tileV("/reservations"), staff: tileV("/staff/schedule"),
      moms: momsBig(), labor: laborLineEl(),
    };
    for (const [k, fig] of Object.entries(figs)) {
      // A roll is drawn …
      expect(fig.querySelector(".vp-roll-cell"), k).not.toBeNull();
      // … aria-hidden, with ONE visually hidden copy that is the final text.
      expect(fig.querySelector(".vp-roll").getAttribute("aria-hidden"), k).toBe("true");
      expect(spoken(fig), k).toBe(want[k]);
      // The eye: the final string's own separators and units, at every frame.
      expect(k === "moms" ? `~${seen(fig)}` : seen(fig), k).toBe(want[k]);
      // From 0 only: no digit in between is ever drawn.
      expect(outgoing(fig).every((d) => d === "0" || /\D/.test(d)), k).toBe(true);
    }
    // The hours figure: "84,5" rolls; the plan beside it stands still.
    const hours = hoursBig();
    expect(spoken(hours).startsWith(`${want.hours} `)).toBe(true);
    expect(hours.querySelector("small").textContent).toBe("tdOfPlannedHours(hours=243)");
    // Only the count rolls in "1 af 2": the plan (2) is no cell.
    const staffIn = [...figs.staff.querySelectorAll(".vp-roll-in")].map((n) => n.textContent);
    expect(staffIn).toEqual(["1"]);
    // Sales "9.840 kr." from "0 kr.": the units column already reads 0 and
    // stays; 9, 8 and 4 rise into place around the standing "." and " kr.".
    expect(outgoing(figs.sales)).toEqual([]);
    expect([...figs.sales.querySelectorAll(".vp-roll-in")].map((n) => n.textContent).join("")).toBe("984");
  });

  it("ends on exactly the model's formatted value, as plain text, and the page is still", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    await flush(INTRO_MS + ROLL_MS);
    const want = expected();
    expect(page().classList.contains("td-intro")).toBe(false);
    expect(document.querySelector(".vp-roll, .vp-roll-cell, .sr-only.vp-roll")).toBeNull();
    for (const [k, fig] of Object.entries({ sales: tileV("/sales"), covers: tileV("/reservations"), staff: tileV("/staff/schedule") })) {
      expect(fig.textContent, k).toBe(want[k]);
      expect(fig.childElementCount, k).toBe(0);       // one plain text node
    }
    expect(momsBig().textContent).toBe(want.moms);
    expect(momsBig().childElementCount).toBe(0);
    expect(hoursBig().childNodes[0].nodeValue).toBe(want.hours);
    expect(laborLineEl().textContent).toBe(want.labor);
    expect(laborLineEl().childElementCount).toBe(0);
    // Danish format, unmistakably: the dot thousands separator and " kr.".
    expect(want.sales).toBe("9.840 kr.");
    expect(want.moms).toBe("~230.063 kr.");
  });
});

describe("once per visit", () => {
  it("is remembered for the account + business day at the start, and a poll or the freshness bus never replays it", async () => {
    motionPref({ reduce: false });
    mount();
    await flush(1);
    expect(page().classList.contains("td-intro")).toBe(true);
    expect(sessionStorage.getItem(INTRO_KEY)).toBe(introStamp("u1", "2026-11-12"));
    await flush(INTRO_MS + ROLL_MS);
    expect(page().classList.contains("td-intro")).toBe(false);

    // A refresh with a new figure: it simply IS the new figure.
    today = payload({ sales: { ...payload().sales, today: 10500 } });
    await act(async () => { window.dispatchEvent(new Event("bonbox-data-changed")); });
    await flush(1);
    expect(tileV("/sales").textContent).toBe(formatOwnerMoney(10500, "DKK"));
    expect(document.querySelector(".vp-roll-cell")).toBeNull();
    expect(page().classList.contains("td-intro")).toBe(false);

    // The five-minute poll: same.
    today = payload({ sales: { ...payload().sales, today: 11200 } });
    await flush(5 * 60 * 1000);
    expect(tileV("/sales").textContent).toBe(formatOwnerMoney(11200, "DKK"));
    expect(document.querySelector(".vp-roll-cell")).toBeNull();
  });

  it("back on the page (a new mount) the same day: no intro, final values at once", async () => {
    motionPref({ reduce: false });
    const first = mount();
    await flush(200);                       // leaves mid-intro
    first.unmount();
    mount();
    expect(page().classList.contains("td-intro")).toBe(false);
    expect(document.querySelector(".vp-roll")).toBeNull();
    expect(tileV("/sales").textContent).toBe(expected().sales);
  });

  it("a new business day plays it once more", async () => {
    motionPref({ reduce: false });
    const first = mount();
    await flush(1);
    first.unmount();
    today = payload({ business_day: "2026-11-13" });
    mount(today);
    expect(page().classList.contains("td-intro")).toBe(true);
    expect(sessionStorage.getItem(INTRO_KEY)).toBe(introStamp("u1", "2026-11-13"));
  });

  it("sessionStorage that throws never breaks the page (it just plays, and shows the truth)", async () => {
    motionPref({ reduce: false });
    const spy = vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const spy2 = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    mount();
    expect(spoken(tileV("/sales"))).toBe(expected().sales);
    spy.mockRestore(); spy2.mockRestore();
  });
});

describe("RollIn", () => {
  const seenOf = (host) => {
    const live = host.querySelector(".vp-roll").cloneNode(true);
    live.querySelectorAll(".sr-only, .vp-roll-out").forEach((n) => n.remove());
    return live.textContent;
  };

  it("never commits the 0 at rest: the swap lands in the same synchronous commit (before any paint)", () => {
    motionPref({ reduce: false });
    const was = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<RollIn value="12.345 kr." from="0 kr." play />));
      // Synchronously after the first commit: already rolling TO the value.
      expect(host.querySelector(".vp-roll-cell")).not.toBeNull();
      expect(seenOf(host)).toBe("12.345 kr.");
      expect(host.querySelector(".vp-roll").getAttribute("data-value")).toBe("12.345 kr.");
      expect(spoken(host)).toBe("12.345 kr.");
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = was;
    }
  });

  it("…and in a normal (non-sync) render too: the first look at the DOM after that task is already the roll", async () => {
    // A MutationObserver callback is a microtask: it runs right after the
    // task that committed, before the next task — and a browser never paints
    // in the middle of a task. Had the swap waited for a later task (a
    // passive effect, a rAF), this first look would find "0 kr." at rest.
    vi.useRealTimers();
    motionPref({ reduce: false });
    const was = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      const firstLook = new Promise((done) => {
        const mo = new MutationObserver(() => {
          mo.disconnect();
          done({ rolling: !!host.querySelector(".vp-roll-cell"), seen: host.querySelector(".vp-roll") && seenOf(host), spoken: spoken(host) });
        });
        mo.observe(host, { childList: true, subtree: true, characterData: true });
      });
      root.render(<RollIn value="230.063 kr." from="0 kr." play />);
      const look = await firstLook;
      expect(look).toEqual({ rolling: true, seen: "230.063 kr.", spoken: "230.063 kr." });
    } finally {
      root.unmount();
      host.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = was;
    }
  });

  it("play off: the plain text; a figure with no digit or equal to its 0 never rolls", () => {
    const { container, rerender } = render(<p><RollIn value="9.840 kr." from="0 kr." play={false} /></p>);
    expect(container.firstChild.innerHTML).toBe("9.840 kr.");
    rerender(<p><RollIn key="b" value="0 kr." from="0 kr." play /></p>);
    expect(container.querySelector(".vp-roll-cell")).toBeNull();
    expect(spoken(container.firstChild)).toBe("0 kr.");
  });

  it("a value that changes during the intro rolls from the previous REAL value, never from 0 again", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<p><RollIn value="9.840 kr." from="0 kr." play /></p>);
    act(() => { vi.advanceTimersByTime(ROLL_MS + 10); });
    rerender(<p><RollIn value="9.850 kr." from="0 kr." play /></p>);
    expect([...container.querySelectorAll(".vp-roll-out")].map((n) => n.textContent)).toEqual(["4"]);
    expect(spoken(container.firstChild)).toBe("9.850 kr.");
    rerender(<p><RollIn value="9.850 kr." from="0 kr." play={false} /></p>);
    expect(container.firstChild.innerHTML).toBe("9.850 kr.");
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

  it("one light haptic on a primary action; none on a navigation row; a tick only on a real segment change", async () => {
    mount();
    await flush(1);
    fireEvent.click(document.querySelector(".td-head-actions .td-btn-brass"));
    expect(feelSpy.soft).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector("a.td-brow"));
    fireEvent.click(document.querySelector("a.td-tile"));
    expect(feelSpy.soft).toHaveBeenCalledTimes(1);
    // Kræver dig's answer button
    fireEvent.click(document.querySelector("#td-needs .td-btn"));
    expect(feelSpy.soft).toHaveBeenCalledTimes(2);
    // Lunch (12:00) + dinner (18:00): the segment shows; tapping the chosen one is no change.
    const seg = document.querySelector(".td-seg");
    const [lunch, dinner] = seg.querySelectorAll("button");
    const chosen = lunch.getAttribute("aria-pressed") === "true" ? lunch : dinner;
    const other = chosen === lunch ? dinner : lunch;
    fireEvent.click(chosen);
    expect(feelSpy.tick).not.toHaveBeenCalled();
    fireEvent.click(other);
    expect(feelSpy.tick).toHaveBeenCalledTimes(1);
  });
});

describe("today.css: calm by construction", () => {
  const keyframes = [...CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)];

  it("every keyframe moves transform and opacity only, and nothing loops", () => {
    expect(keyframes.length).toBeGreaterThan(5);
    for (const [, name, body] of keyframes) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(["transform", "opacity"], `${name}: ${p}`).toContain(p);
    }
    expect(CSS).not.toMatch(/\binfinite\b/);
    expect(CSS).not.toMatch(/animation[^;]*\b(pulse|breathe|ping|glow)/i);
  });

  it("every entrance plays only under .td-intro; the roll runs on Vagtplan's values", () => {
    const animated = [...BARE.matchAll(/^([^@{}\n][^{}]*)\{[^}]*\banimation:\s*td(Rise|BarIn|GrowX|Fade)\b/gm)].map((m) => m[1].trim());
    expect(animated.length).toBeGreaterThanOrEqual(6);
    for (const sel of animated) for (const part of sel.split(",")) expect(part.trim()).toMatch(/^\.td-intro /);
    expect(CSS).toMatch(/\.td-page \.vp-roll-up > \.vp-roll-in \{ animation: tdRollInUp 460ms var\(--td-spring-soft\) 80ms backwards; \}/);
    expect(CSS).toMatch(/--td-dur-press: 0\.11s;/);
    expect(CSS).toMatch(/--td-spring: cubic-bezier\(\.34, 1\.4, \.64, 1\);/);
  });

  it("the press: .97 buttons, .94 the small ✕, .98 cards, a tint for grouped rows; reduce dims instead of scaling", () => {
    expect(CSS).toMatch(/\.td-page :is\(\.td-btn, \.td-link, \.td-seg button\)\[data-pressed\]:not\(:disabled\) \{\s*scale: \.97;/);
    expect(CSS).toMatch(/\.td-page \.td-x\[data-pressed\]:not\(:disabled\) \{\s*scale: \.94;/);
    expect(CSS).toMatch(/\.td-page \.td-tile\[data-pressed\] \{\s*scale: \.98;/);
    expect(CSS).toMatch(/\.td-row\.vp-tint\[data-pressed\] \{\s*scale: none;\s*background-color: var\(--td-press-tint\);/);
    const reduce = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(CSS.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
    expect(reduce).toMatch(/html\[data-modality="touch"\] \.td-page \.td-tile\[data-pressed\] \{ scale: none; opacity: \.72; \}/);
    expect(reduce).toMatch(/\.td-tab:active \{ scale: none; opacity: \.72; \}/);
  });
});
