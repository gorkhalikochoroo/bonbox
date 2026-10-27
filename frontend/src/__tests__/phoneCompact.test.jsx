/**
 * Phone-compact pass (21 Oct 2026): below 640px Manoj's six owner screens
 * size to their content — one row where a row fits, no lone button on a row
 * of its own, no card taller than what it holds.
 *
 * WHAT THIS PINS.
 *   1. Every class the pass added is phone-only: `max-sm:`-prefixed, or the
 *      base half of a pair that `sm:` restores. Tablet and desktop must stay
 *      pixel-identical (the browser gate lives in the lab folder; jsdom applies
 *      no Tailwind, so here it is the class contract that is checked).
 *   2. Nothing was removed: the controls, ids, aria, handlers and texts of
 *      every touched file are still there (counts pinned against origin/main
 *      d6a27b72, comments ignored), and the merged/hidden texts stay in the DOM.
 *   3. The 6 new phone labels exist in English AND Danish, as real keys
 *      (and in Turkish, the third offered language).
 *   4. The review fix round (21 Oct 2026, later): strip text >= 13px, the
 *      tappable strip cells keep their chevron, the week comparison is
 *      visible, Timer + Kasserapport KPIs are strips, the Lager stock list is
 *      one grouped list, "+ Open shift" is one line, and the rest of the
 *      critics' cheap minors — each pinned as phone-only.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import { tr } from "../i18n/tr";

vi.mock("../hooks/useLanguage", async () => {
  const { en: EN } = await import("../i18n/en");
  return {
    useLanguage: () => ({ t: (k, fb) => (EN[k] != null ? EN[k] : typeof fb === "string" ? fb : k), lang: "en", setLang: () => {}, LANGUAGES: [] }),
    LanguageProvider: ({ children }) => children,
  };
});
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { business_type: "restaurant" } }) }));
vi.mock("../lib/swrCache", async (orig) => ({ ...(await orig()), peekGet: () => null }));
const apiGet = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => apiGet(...a) } }));

const PageHeader = (await import("../components/ui/PageHeader")).default;
const StatCard = (await import("../components/ui/StatCard")).default;
const KpiStrip = (await import("../components/dashboard/KpiStrip")).default;
const TodayOnShiftCard = (await import("../components/dashboard/TodayOnShiftCard")).default;
const TabPills = (await import("../components/ui/TabPills")).default;
const phone = await import("../components/ui/phone");
const ui = await import("../components/ui");

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
const toks = (s) => String(s || "").split(/\s+/).filter(Boolean);
const isPhoneOnly = (t) => t.startsWith("max-sm:");
const added = (before, after) => toks(after).filter((t) => !toks(before).includes(t));
const removed = (before, after) => toks(before).filter((t) => !toks(after).includes(t));
// A string literal is resolved the way the components concatenate them.
const PHONE = {
  PHONE_H40: "max-sm:h-10 max-sm:min-h-0!",
  PHONE_CTRL: "max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]",
  PHONE_ICON40: "max-sm:h-10 max-sm:w-10 max-sm:min-h-0! max-sm:px-0 max-sm:gap-0",
};

// origin/main d6a27b72, renderToStaticMarkup — the "all phone props off"
// output must stay byte-identical for every caller that does not opt in.
const ORIGIN = {
  statDefault: '<div class="rounded-xl border text-left transition px-4 py-3.5 bg-[rgb(var(--surface-card))] border-[rgb(var(--surface-line))] "><div class="flex items-start justify-between gap-2 min-h-[2.125rem] sm:min-h-0"><p class="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Revenue today</p></div><p class="text-[22px] sm:text-[26px] font-bold tabular-nums leading-tight mt-0.5 text-gray-900 dark:text-gray-100">12,480</p><p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">vs 9,830</p></div>',
  statDense: '<div class="rounded-xl border text-left transition px-3 py-2.5 sm:px-4 sm:py-3.5 bg-[rgb(var(--surface-card))] border-[rgb(var(--surface-line))] max-sm:col-span-2"><div class="flex items-start justify-between gap-2 min-h-[2.125rem] sm:min-h-0"><p class="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Covers</p></div><p class="text-[20px] sm:text-[26px] font-bold tabular-nums leading-tight mt-0.5 text-amber-600 dark:text-amber-400">38</p></div>',
  statClickSel: '<button type="button" aria-pressed="true" aria-expanded="true" aria-controls="p" class="rounded-xl border text-left transition px-4 py-3.5 ring-1 ring-gray-900 dark:ring-gray-100 bg-[rgb(var(--surface-subtle))] border-[rgb(var(--surface-line-strong))] cursor-pointer hover:bg-[rgb(var(--surface-subtle))] hover:border-[rgb(var(--surface-line-strong))] focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1 focus-visible:ring-offset-[rgb(var(--surface-card))] active:scale-[0.99] "><div class="flex items-start justify-between gap-2 min-h-[2.125rem] sm:min-h-0"><p class="text-[11px] font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-100">Low stock</p><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down text-gray-400 dark:text-gray-500 transition-transform shrink-0 rotate-180" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></div><p class="text-[22px] sm:text-[26px] font-bold tabular-nums leading-tight mt-0.5 text-red-600 dark:text-red-400">3</p></button>',
  statClick: '<button type="button" aria-pressed="false" class="rounded-xl border text-left transition px-4 py-3.5 bg-[rgb(var(--surface-card))] border-[rgb(var(--surface-line))] cursor-pointer hover:bg-[rgb(var(--surface-subtle))] hover:border-[rgb(var(--surface-line-strong))] focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1 focus-visible:ring-offset-[rgb(var(--surface-card))] active:scale-[0.99] "><div class="flex items-start justify-between gap-2 min-h-[2.125rem] sm:min-h-0"><p class="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Priced</p><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right text-gray-400 dark:text-gray-500 transition-transform shrink-0" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg></div><p class="text-[22px] sm:text-[26px] font-bold tabular-nums leading-tight mt-0.5 text-gray-900 dark:text-gray-100">4/10</p></button>',
  headerFull: '<header class="mb-6 sm:mb-8 flex flex-col lg:flex-row lg:items-end sm:justify-between gap-3 sm:gap-4 x"><div class="min-w-0"><p class="text-[11px] font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-1.5">HOME</p><h1 class="text-[21px] sm:text-[28px] font-semibold tracking-[-0.025em] text-gray-900 dark:text-gray-100 leading-tight">Hello</h1><p class="text-[14px] text-gray-600 dark:text-gray-400 mt-1 leading-relaxed">Sub</p></div><div class="shrink-0 flex items-center gap-2 flex-wrap"><button>A</button></div></header>',
  headerBare: '<header class="mb-6 sm:mb-8 flex flex-col lg:flex-row lg:items-end sm:justify-between gap-3 sm:gap-4 "><div class="min-w-0"><h1 class="text-[21px] sm:text-[28px] font-semibold tracking-[-0.025em] text-gray-900 dark:text-gray-100 leading-tight">Hello</h1></div></header>',
};

describe("1a. the shared phone tokens", () => {
  it("every token in components/ui/phone.js is max-sm: only, and ui re-exports them", () => {
    const names = ["PHONE_H40", "PHONE_CTRL", "PHONE_ICON40", "PHONE_STRIP", "PHONE_EMPTY_LINE"];
    for (const n of names) {
      expect(typeof phone[n]).toBe("string");
      expect(toks(phone[n]).length).toBeGreaterThan(0);
      expect(toks(phone[n]).filter((t) => !isPhoneOnly(t))).toEqual([]);
      expect(ui[n]).toBe(phone[n]);
    }
    for (const [n, v] of Object.entries(PHONE)) expect(phone[n]).toBe(v);
    // every 40px control releases index.css's coarse-pointer 44px floor
    for (const n of ["PHONE_H40", "PHONE_CTRL", "PHONE_ICON40"]) expect(toks(phone[n])).toContain("max-sm:min-h-0!");
  });
});

describe("1b. PageHeader: phoneRow / phoneQuiet / phoneCorner", () => {
  it("all three off → byte-identical to origin/main", () => {
    expect(renderToStaticMarkup(<PageHeader eyebrow="HOME" title="Hello" subtitle="Sub" actions={<button>A</button>} className="x" />)).toBe(ORIGIN.headerFull);
    expect(renderToStaticMarkup(<PageHeader title="Hello" />)).toBe(ORIGIN.headerBare);
  });

  it("on, they add only max-sm: classes, remove none, and never touch the title block", () => {
    const off = render(<PageHeader eyebrow="HOME" title="Hello" subtitle="Sub" actions={<button>A</button>} />).container;
    const on = render(<div><PageHeader eyebrow="HOME" title="Hello" subtitle="Sub" actions={<button>A</button>} phoneRow phoneQuiet phoneCorner /></div>).container;
    const pick = (c) => {
      const h = c.querySelector("header");
      const h1 = h.querySelector("h1");
      return { header: h.className, block: h1.parentElement.className, eyebrow: h1.previousElementSibling.className, h1: h1.className, subtitle: h1.nextElementSibling.className, actions: h.lastElementChild.className };
    };
    const a = pick(off), b = pick(on);
    for (const k of Object.keys(a)) {
      expect(added(a[k], b[k]).filter((t) => !isPhoneOnly(t)), k).toEqual([]);
      expect(removed(a[k], b[k]), k).toEqual([]);
    }
    expect(b.block).toBe("min-w-0");
    expect(b.h1).toBe(a.h1);
    expect(toks(b.header)).toEqual(expect.arrayContaining(["max-sm:flex-row", "max-sm:items-center", "max-sm:justify-between", "max-sm:relative"]));
    expect(toks(b.eyebrow)).toEqual(expect.arrayContaining(["max-sm:hidden", "max-sm:pr-10"]));
    expect(toks(b.subtitle)).toContain("max-sm:hidden");
    // texts stay in the DOM (hidden on a phone by CSS only)
    expect(screen.getAllByText("HOME").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sub").length).toBeGreaterThan(0);
  });
});

describe("1c. StatCard: strip + shortLabel", () => {
  it("strip off and no shortLabel → byte-identical to origin/main", () => {
    expect(renderToStaticMarkup(<StatCard label="Revenue today" value="12,480" helper="vs 9,830" />)).toBe(ORIGIN.statDefault);
    expect(renderToStaticMarkup(<StatCard label="Covers" value={38} dense accent="warn" className="max-sm:col-span-2" />)).toBe(ORIGIN.statDense);
    expect(renderToStaticMarkup(<StatCard label="Low stock" value={3} accent="critical" onClick={() => {}} selected expandable ariaControls="p" />)).toBe(ORIGIN.statClickSel);
    expect(renderToStaticMarkup(<StatCard label="Priced" value="4/10" onClick={() => {}} />)).toBe(ORIGIN.statClick);
  });

  it("strip adds only phone classes; the only base swaps are ones sm: restores", () => {
    const parts = (el) => {
      const row = el.firstElementChild;
      return { root: el.className, row: row.className, label: row.querySelector("p").className, chevron: row.querySelector("svg")?.getAttribute("class") || "", value: el.children[1].className, helper: el.children[2]?.className || "" };
    };
    for (const props of [{}, { onClick: () => {}, expandable: true }, { onClick: () => {}, selected: true }]) {
      const a = parts(render(<StatCard label="Items" value={10} helper="h" dense {...props} />).container.firstElementChild);
      const b = parts(render(<StatCard label="Items" value={10} helper="h" dense strip {...props} />).container.firstElementChild);
      const allowedBase = new Set(["px-2", "py-2", "text-lg"]);
      for (const k of Object.keys(a)) {
        expect(added(a[k], b[k]).filter((t) => !isPhoneOnly(t) && !allowedBase.has(t)), k).toEqual([]);
      }
      // the swapped base tokens are exactly the phone sizes, and sm: restores the tile
      expect(removed(a.root, b.root).sort()).toEqual(["px-3", "py-2.5"]);
      expect(toks(b.root)).toEqual(expect.arrayContaining(["sm:px-4", "sm:py-3.5"]));
      expect(removed(a.value, b.value)).toEqual(["text-[20px]"]);
      expect(toks(b.value)).toEqual(expect.arrayContaining(["text-lg", "sm:text-[26px]", "leading-tight", "font-bold"]));
      for (const k of ["row", "label", "chevron", "helper"]) expect(removed(a[k], b[k]), k).toEqual([]);
    }
  });

  it("shortLabel renders in a sm:hidden span, the full label in a max-sm:hidden span", () => {
    render(<StatCard label="Revenue this week" shortLabel="This week" value="7.074" strip dense />);
    const s = screen.getByText("This week");
    const f = screen.getByText("Revenue this week");
    expect(s.tagName).toBe("SPAN");
    expect(s.className).toBe("sm:hidden");
    expect(f.tagName).toBe("SPAN");
    expect(f.className).toBe("max-sm:hidden");
    expect(s.parentElement).toBe(f.parentElement);
  });

  it("a clickable strip cell is still the same button: aria, handler, chevron", () => {
    const onClick = vi.fn();
    render(<StatCard label="Low stock" value={3} strip onClick={onClick} selected expandable ariaControls="inventory-stat-panel" />);
    const b = screen.getByRole("button");
    expect(b).toHaveAttribute("aria-pressed", "true");
    expect(b).toHaveAttribute("aria-expanded", "true");
    expect(b).toHaveAttribute("aria-controls", "inventory-stat-panel");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    const chev = b.querySelector("svg");
    expect(chev).not.toBeNull();
    // The chevron is the only sign the cell opens a panel: never hidden.
    expect(toks(chev.getAttribute("class"))).not.toContain("max-sm:hidden");
    expect(getComputedStyle(chev).display).not.toBe("none");
  });
});

describe("1d. Home KPI strip", () => {
  const ctx = { summary: { todayRevenue: 0, weekRevenue: 7074, month_revenue: 165106 }, weekComparison: { weekDeltaPct: -12 } };

  it("3 tiles = one 3-across phone strip; every added grid class is phone-only", () => {
    const { container } = render(<KpiStrip tiles={["today", "week", "month"]} showDelta ctx={ctx} />);
    const grid = container.querySelector('[data-component="KpiStrip"]');
    const desktop = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3";
    expect(grid.className.startsWith(desktop + " ")).toBe(true);
    expect(added(desktop, grid.className).filter((t) => !isPhoneOnly(t))).toEqual([]);
    expect(toks(grid.className)).toEqual(expect.arrayContaining(["max-sm:grid-cols-3", ...toks(phone.PHONE_STRIP)]));
    expect(grid.children.length).toBe(3);
    // no orphan span any more
    expect(grid.innerHTML).not.toContain("col-span-2");
  });

  it("the week tile keeps its full label + delta text; the phone hides only by CSS", () => {
    render(<KpiStrip tiles={["today", "week", "month"]} showDelta ctx={ctx} />);
    expect(screen.getByText(en.kpiWeekShort).className).toBe("sm:hidden");
    expect(screen.getByText(en.liveRevenueWeek).className).toBe("max-sm:hidden");
    expect(screen.getByText(en.liveRevenueToday)).toBeInTheDocument();
    expect(screen.getByText(en.liveRevenueMonth)).toBeInTheDocument();
    // The comparison basis is VISIBLE on a phone (its own line under the
    // word), never sr-only: a bare "Down" does not say against what.
    const vs = screen.getByText(en.vsLastWeek);
    expect(toks(vs.className)).toEqual(["text-gray-500", "dark:text-gray-400"]);
    expect(vs.className).not.toMatch(/sr-only|hidden/);
    const delta = vs.parentElement;
    expect(toks(delta.className)).toEqual(["inline-flex", "items-center", "gap-1", "text-xs", "max-sm:flex", "max-sm:flex-col", "max-sm:items-start", "max-sm:gap-0", "max-sm:text-[13px]", "max-sm:leading-4"]);
    expect(screen.getByText(en.trendDown)).toBeInTheDocument();
  });

  it("money values carry the phone wrap guard", () => {
    const { container } = render(<KpiStrip tiles={["today", "week", "month"]} ctx={ctx} />);
    const amounts = [...container.querySelectorAll("span.items-baseline")];
    expect(amounts.length).toBe(3);
    for (const a of amounts) expect(toks(a.className)).toContain("max-sm:flex-wrap");
  });

  it("2 and 4 tiles keep a 2-across strip; 1 tile is one column", () => {
    const grid = (tiles) => render(<KpiStrip tiles={tiles} ctx={ctx} />).container.querySelector('[data-component="KpiStrip"]');
    const two = grid(["today", "week"]);
    expect(two.children.length).toBe(2);
    expect(toks(two.className)).toContain("max-sm:grid-cols-2");
    const four = grid(["today", "week", "month", "complianceNext"]);
    expect(four.children.length).toBe(4);
    expect(toks(four.className)).toContain("max-sm:grid-cols-2");
    expect(toks(four.className)).not.toContain("max-sm:grid-cols-3");
    const one = grid(["month"]);
    expect(toks(one.className)).toContain("max-sm:grid-cols-1");
  });
});

describe("1e. Today on shift", () => {
  it("empty: the phone line is added, the desktop sentence + 'Open schedule' stay in the DOM", async () => {
    apiGet.mockResolvedValueOnce({ data: { shifts: [] } });
    const { container } = render(<MemoryRouter><TodayOnShiftCard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(en.todayOnShiftNone)).toBeInTheDocument());
    const none = screen.getByText(en.todayOnShiftNone);
    expect(toks(none.className)).toContain("sm:hidden");
    const cta = screen.getByText(en.todayOnShiftEmptyCta);
    expect(cta.closest("a")).toHaveAttribute("href", "/staff/schedule");
    expect(toks(cta.closest("div").className)).toEqual(["text-sm", "text-gray-500", "dark:text-gray-400", "max-sm:hidden"]);
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/staff/schedule", "/staff/schedule"]);
    const head = links[0];
    expect(head.textContent).toContain(en.todayOnShiftViewPlan);
    expect(toks(head.className)).toEqual(expect.arrayContaining([...toks(phone.PHONE_CTRL), "max-sm:shrink-0"]));
    const row = head.parentElement;
    expect(toks(row.className)).toEqual(expect.arrayContaining(["mb-3", "max-sm:mb-0"]));
  });

  it("with shifts: no phone empty line, the header keeps mb-3 everywhere", async () => {
    apiGet.mockResolvedValueOnce({ data: { shifts: [{ id: 1, name: "Mads K.", role: "kitchen", start_time: "16:00", end_time: "22:00" }] } });
    const { container } = render(<MemoryRouter><TodayOnShiftCard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Mads K.")).toBeInTheDocument());
    expect(screen.queryByText(en.todayOnShiftNone)).toBeNull();
    const row = container.querySelector("a").parentElement;
    expect(toks(row.className)).toContain("mb-3");
    expect(toks(row.className)).not.toContain("max-sm:mb-0");
    // Phone: the times are one right-aligned column; the "·" before the time
    // hides there (CSS only — still in the DOM).
    const time = screen.getByText("16:00–22:00");
    expect(toks(time.className)).toEqual(["tabular-nums", "text-gray-600", "dark:text-gray-300", "shrink-0", "max-sm:ml-auto", "max-sm:pl-2"]);
    const dot = time.previousElementSibling;
    expect(dot.textContent.trim()).toBe("·");
    expect(toks(dot.className)).toEqual(["text-gray-300", "dark:text-gray-500", "max-sm:hidden"]);
  });
});

describe("1f. the page edits: every added fragment is phone-only (or sm:-restored)", () => {
  // [file, exact source fragment the pass added, sm:-restored base tokens allowed]
  const FRAGMENTS = [
    ["pages/DashboardPage.jsx", 'className="relative max-sm:absolute max-sm:-top-3 max-sm:-right-2"', ["relative"]],
    ["pages/DashboardPage.jsx", 'className="sm:hidden h-[94px] rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 animate-pulse"', "SM_HIDDEN"],
    ["pages/DashboardPage.jsx", 'gap-3 max-sm:hidden">', ["gap-3"]],
    ["components/dashboard/TodayOnShiftCard.jsx", '"flex items-center justify-between max-sm:gap-3 " + (hasShifts ? "mb-3" : "mb-3 max-sm:mb-0")', ["flex", "items-center", "justify-between", "mb-3"]],
    ["components/dashboard/TodayOnShiftCard.jsx", 'className="flex items-center gap-2 max-sm:min-w-0"', ["flex", "items-center", "gap-2"]],
    ["components/dashboard/TodayOnShiftCard.jsx", '<div className="max-sm:min-w-0">', []],
    ["components/dashboard/TodayOnShiftCard.jsx", '<p className="sm:hidden text-[13px] text-gray-500 dark:text-gray-400">{t("todayOnShiftNone")}</p>', "SM_HIDDEN"],
    ["components/dashboard/TodayOnShiftCard.jsx", 'rounded px-1 max-sm:shrink-0 " + PHONE_CTRL', ["rounded", "px-1"]],
    ["components/dashboard/TodayOnShiftCard.jsx", '"text-sm text-gray-500 dark:text-gray-400 max-sm:hidden"', ["text-sm", "text-gray-500", "dark:text-gray-400"]],
    ["components/DailyBriefCard.jsx", "p-5 sm:p-7 animate-pulse", ["p-5", "sm:p-7", "animate-pulse"]],
    ["components/dashboard/KpiStrip.jsx", '"inline-flex items-center gap-1 text-xs max-sm:flex max-sm:flex-col max-sm:items-start max-sm:gap-0 max-sm:text-[13px] max-sm:leading-4"', ["inline-flex", "items-center", "gap-1", "text-xs"]],
    ["components/dashboard/KpiStrip.jsx", 'const PHONE_COLS = { 1: "max-sm:grid-cols-1", 2: "max-sm:grid-cols-2", 4: "max-sm:grid-cols-2" };', []],
    ["pages/StaffSchedulePage.jsx", 'const TOOL_PHONE = PHONE_CTRL + " max-sm:px-1.5 max-sm:min-w-10";', []],
    ["pages/StaffSchedulePage.jsx", 'className="max-sm:mb-0"', []],
    ["pages/StaffSchedulePage.jsx", "dark:border-gray-700 p-4 max-sm:p-3", ["dark:border-gray-700", "p-4"]],
    ["pages/StaffSchedulePage.jsx", "justify-between gap-4 max-sm:gap-3", ["justify-between", "gap-4"]],
    ["pages/StaffSchedulePage.jsx", 'className="max-sm:h-10 max-sm:min-w-[40px] max-sm:min-h-0!"', []],
    ["pages/StaffSchedulePage.jsx", "transition max-sm:h-10 max-sm:min-h-0! max-sm:py-0", ["transition"]],
    ["pages/StaffSchedulePage.jsx", "w-full lg:w-auto max-sm:gap-1.5 max-sm:[&>*]:grow", ["w-full", "lg:w-auto"]],
    ["pages/StaffSchedulePage.jsx", "dark:text-gray-400 max-sm:mt-1 max-sm:-mb-2 max-sm:text-[13px]", ["dark:text-gray-400"]],
    ["pages/StaffSchedulePage.jsx", "dark:text-amber-400 max-sm:mt-1 max-sm:-mb-2 max-sm:text-[13px]", ["dark:text-amber-400"]],
    ["pages/StaffSchedulePage.jsx", "gap-3 max-sm:flex-nowrap max-sm:gap-2 max-sm:py-1.5 max-sm:pl-4 max-sm:pr-1.5", ["gap-3"]],
    ["pages/StaffSchedulePage.jsx", "dark:text-gray-300 max-sm:text-[13px] max-sm:min-w-0", ["dark:text-gray-300"]],
    ["pages/StaffSchedulePage.jsx", '<span className="sm:hidden">{t("schedEmptyWeekShort")}</span><span className="max-sm:hidden">{t("schedEmptyWeekBody", "No shifts this week yet.")}</span>', "SPANS"],
    ["pages/StaffSchedulePage.jsx", 'className={PHONE_CTRL + " max-sm:px-3 max-sm:shrink-0"}', []],
    ["pages/StaffSchedulePage.jsx", "px-5 py-4 mt-4 max-sm:mt-0", ["px-5", "py-4", "mt-4"]],
    ["pages/StaffSchedulePage.jsx", 'className={"shrink-0 " + PHONE_CTRL + " max-sm:[&>span]:inline-flex max-sm:[&>span]:items-center max-sm:[&>span]:gap-1.5"}', ["shrink-0"]],
    ["pages/StaffSchedulePage.jsx", "py-1.5 max-sm:text-[13px] max-sm:text-gray-500 max-sm:dark:text-gray-400", ["py-1.5"]],
    ["components/ScheduleConfirmationCard.jsx", "py-2.5 mb-4 max-sm:mb-0 flex", ["py-2.5", "mb-4", "flex"]],
    ["pages/StaffHoursPage.jsx", 'className="max-sm:mb-4"', []],
    ["pages/StaffHoursPage.jsx", "justify-between gap-2 max-sm:p-1 max-sm:gap-1", ["justify-between", "gap-2"]],
    ["pages/StaffHoursPage.jsx", "focus-visible:ring-gray-400 max-sm:h-10 max-sm:min-h-0! max-sm:py-0 max-sm:mx-0", ["focus-visible:ring-gray-400"]],
    ["pages/StaffHoursPage.jsx", "flex justify-center max-sm:mt-0 max-sm:pb-1", ["flex", "justify-center"]],
    ["pages/ReservationsPage.jsx", '" max-sm:bg-[radial-gradient(65%_10rem_at_50%_0%,rgb(var(--brand-green-accent)/0.14),transparent_70%)]"', []],
    ["pages/ReservationsPage.jsx", '" max-sm:dark:bg-[radial-gradient(65%_10rem_at_50%_0%,rgb(var(--brand-green-accent)/0.08),transparent_70%)]"', []],
    ["pages/InventoryPage.jsx", "space-y-6 max-sm:space-y-4", ["space-y-6"]],
    ["pages/InventoryPage.jsx", 'className="max-sm:mb-4"', []],
    ["pages/InventoryPage.jsx", 'lg:grid-cols-5 gap-3 max-sm:grid-cols-6 " + PHONE_STRIP', ["lg:grid-cols-5", "gap-3"]],
    ["pages/InventoryPage.jsx", 'className="max-sm:col-span-2"', []],
    ["pages/InventoryPage.jsx", 'className="max-sm:col-span-4"', []],
    ["pages/InventoryPage.jsx", "p-5 sm:p-6 rounded-xl", ["p-5", "sm:p-6", "rounded-xl"]],
    ["components/InventoryAutopilotPanel.jsx", 'dark:text-gray-400 " + PHONE_EMPTY_LINE', ["dark:text-gray-400"]],
    ["components/InventoryAutopilotPanel.jsx", '"px-4 py-8 text-center " + PHONE_EMPTY_LINE', ["px-4", "py-8", "text-center"]],
    ["components/InventoryAutopilotPanel.jsx", "mb-3 max-sm:shrink-0 max-sm:mx-0 max-sm:mb-0 max-sm:w-4 max-sm:h-4", ["mb-3"]],
    ["components/InventoryAutopilotPanel.jsx", "dark:text-gray-300 max-sm:text-[13px]", ["dark:text-gray-300"]],
    ["pages/DailyClosePage.jsx", "mt-3 flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-1", ["mt-3", "flex", "flex-wrap", "gap-2"]],
    // ── review fix round ──
    ["pages/StaffHoursPage.jsx", '"grid grid-cols-2 lg:grid-cols-4 gap-3 " + PHONE_STRIP', ["grid", "grid-cols-2", "lg:grid-cols-4", "gap-3"]],
    ["components/LiveKpisToday.jsx", '"grid grid-cols-2 sm:grid-cols-4 gap-3 " + PHONE_STRIP', ["grid", "grid-cols-2", "sm:grid-cols-4", "gap-3"]],
    ["pages/InventoryPage.jsx", '"md:hidden p-3 space-y-2" + (filtered.length > 0 ? " max-sm:p-0 max-sm:space-y-0" : "")', ["md:hidden", "p-3", "space-y-2", "(filtered.length", ">", "0"]],
    ["pages/InventoryPage.jsx", "dark:border-gray-700 max-sm:justify-end max-sm:gap-1.5 max-sm:pt-0 max-sm:mt-2 max-sm:border-t-0", ["dark:border-gray-700"]],
    ["pages/InventoryPage.jsx", '<span className="flex-1 max-sm:hidden" aria-hidden="true" />', ["<span", "flex-1", "aria-hidden=", "true", "/>"]],
    ["pages/InventoryPage.jsx", "bg-red-600 max-sm:flex-none max-sm:px-3 max-sm:h-10 max-sm:min-h-0! text-white text-[12px] max-sm:text-[13px]", ["bg-red-600", "text-white", "text-[12px]"]],
    ["pages/DailyClosePage.jsx", 'className="mb-4 max-sm:last:mb-0"', ["mb-4"]],
    ["components/InventoryAutopilotPanel.jsx", "dark:text-gray-400 max-sm:flex-col max-sm:items-start max-sm:gap-0.5 max-sm:mb-3 max-sm:text-[13px]", ["dark:text-gray-400"]],
    ["pages/ReservationsPage.jsx", 'className="max-sm:-mt-2"', []],
    ["components/ui/TabPills.jsx", '"max-sm:h-10 max-sm:min-h-0! max-sm:min-w-10 max-sm:px-0 max-sm:rounded-none max-sm:text-[13px] "', []],
    // R7 (track C) split the underline row into UNDERLINE_ROW + its gap, so
    // the salon's five tabs can spread (phoneSpread). The default row keeps
    // the same classes; the merge (27 Oct 2026) pins the new spelling.
    ["components/ui/TabPills.jsx", '"max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:-mx-4 max-sm:px-4 "', []],
    ["components/ui/TabPills.jsx", 'UNDERLINE_ROW + " max-sm:gap-5"', []],
    ["components/ui/TabPills.jsx", 'UNDERLINE_ROW + " max-sm:gap-3 max-sm:justify-between"', []],
    ["components/SickCallNotificationCard.jsx", "flex items-center gap-2 flex-wrap max-sm:gap-y-1", ["flex", "items-center", "gap-2", "flex-wrap"]],
    ["components/SickCallNotificationCard.jsx", "text-gray-600 dark:text-gray-300 max-sm:order-1", ["text-gray-600", "dark:text-gray-300"]],
    ["components/SickCallNotificationCard.jsx", "dark:text-gray-400 max-sm:order-3 max-sm:basis-full max-sm:text-[13px] max-sm:leading-snug", ["dark:text-gray-400"]],
    ["components/SickCallNotificationCard.jsx", '<span className="sm:hidden text-gray-600 dark:text-gray-400"> · {absence.reason}</span>', "SM_HIDDEN"],
    ["components/SickCallNotificationCard.jsx", "${statusBadge} max-sm:order-2", ["${statusBadge"]],
    ["components/SickCallNotificationCard.jsx", "mt-1 leading-snug max-sm:hidden", ["mt-1", "leading-snug"]],
    // ── review fix round 2 ──
    ["components/SickCallNotificationCard.jsx", "rounded-xl p-4 sm:p-5 max-sm:p-3", ["rounded-xl", "p-4", "sm:p-5"]],
    ["components/SickCallNotificationCard.jsx", 'className="flex items-start gap-2 mb-3 max-sm:mb-2"', ["flex", "items-start", "gap-2", "mb-3"]],
    ["components/SickCallNotificationCard.jsx", "dark:text-amber-300/80 mt-0.5 max-sm:text-[13px]", ["dark:text-amber-300/80", "mt-0.5"]],
    ["components/SickCallNotificationCard.jsx", 'className="space-y-2 max-sm:space-y-0"', ["space-y-2"]],
    ["pages/StaffSchedulePage.jsx", "flex items-center gap-1.5 min-w-0 max-sm:flex-wrap max-sm:gap-y-0.5", ["flex", "items-center", "gap-1.5", "min-w-0"]],
    ["pages/StaffSchedulePage.jsx", '<span className="truncate max-sm:overflow-visible max-sm:whitespace-normal">{roleName(member.role, t)}</span>', ["truncate", ">{roleName(member.role", "t)}</span>"]],
    ["pages/ReservationsPage.jsx", 'className="relative h-11 max-sm:h-10 max-sm:min-h-0!', ["relative", "h-11"]],
    ["components/ui/TabPills.jsx", '"max-sm:flex-1 max-sm:h-10 max-sm:min-h-0! max-sm:px-2 max-sm:text-[13px] max-sm:rounded-lg "', []],
  ];
  // Class-like tokens of a source fragment: split on spaces and quotes, drop
  // the JS around the strings (className=, +, ?, :, braces, CONSTANT names).
  const classTokens = (frag) => frag.split(/[\s"]+/)
    .map((t) => t.replace(/^className=\{?|[,;]$|\}$/g, ""))
    .filter((t) => t && !/^(\{|\}|\+|\(|\)|\?|:|const|=|;|\d+:|\(hasShifts|<\w+|\/?>)$/.test(t) && !/^[A-Z_0-9]+\}?$/.test(t) && !/^PHONE_/.test(t));

  it("the fragment check itself catches an un-prefixed class (and reads JS around strings)", () => {
    const extra = (frag, base) => classTokens(frag).filter((t) => !isPhoneOnly(t) && !base.includes(t));
    expect(extra('className="p-4 max-sm:p-3 shrink-0"', ["p-4"])).toEqual(["shrink-0"]);
    expect(extra('"mb-3 " + (hasShifts ? "mb-3" : "mb-3 lg:mb-0")', ["mb-3"])).toEqual(["lg:mb-0"]);
    expect(extra('className={PHONE_CTRL + " max-sm:px-3 grow"}', [])).toEqual(["grow"]);
    expect(extra('" max-sm:bg-[radial-gradient(65%_10rem_at_50%_0%,rgb(var(--x)/0.1),transparent_70%)]"', [])).toEqual([]);
  });

  it.each(FRAGMENTS)("%s has %s", (file, frag, base) => {
    const src = read(file);
    expect(src.includes(frag)).toBe(true);
    if (base === "SM_HIDDEN" || base === "SPANS") return; // phone-only node: display:none from sm: up
    const extra = classTokens(frag).filter((t) => !isPhoneOnly(t) && !base.includes(t));
    expect(extra).toEqual([]);
  });

  it("the Vagtplan toolbar: all five week actions use TOOL_PHONE (>= 40px wide); every state icon hides on a phone, the spinner does not", () => {
    const src = read("pages/StaffSchedulePage.jsx");
    expect((src.match(/className=\{TOOL_PHONE\}/g) || []).length).toBe(5);
    for (const name of ["Plus", "Copy", "Sparkles", "Share2"]) {
      expect(src).toContain(`<Icon name="${name}" size={14} className="max-sm:hidden" />`);
    }
    // "Published" is text-only on a phone like its neighbours (the word says
    // the state), inline so it shares their baseline; sm: and up keep the tick.
    expect(src).toContain('<span className="inline-flex items-center gap-1 max-sm:inline">\n                    <Icon name="CheckCircle2" size={14} className="max-sm:hidden" />');
    expect(src).not.toContain('<Icon name="CheckCircle2" size={14} />');
    // busy={...} still renders Button's spinner (no class can hide it)
    expect((src.match(/busy=\{(copying|autopilotLoading|publishing|sharing \|\| emailing \|\| exporting)\}/g) || []).length).toBeGreaterThanOrEqual(4);
    // the empty week's own Copy keeps its icon
    expect(src).toMatch(/max-sm:shrink-0"\}\s*iconLeft=\{<Icon name="Copy" size=\{14\} \/>\}/);
    // the pop-out stays desktop-only, as before
    expect(src).toContain('className="max-sm:hidden"\n                  onClick={() =>\n                    window.open("/staff/schedule/stand"');
  });

  it("Home: every PageHeader with the header actions opts into phoneCorner; the skeleton header does not", () => {
    const src = read("pages/DashboardPage.jsx");
    const tags = [...src.matchAll(/<PageHeader[\s\S]*?\/>/g)].map((m) => m[0]);
    const withActions = tags.filter((t) => t.includes("actions={headerActions}"));
    expect(withActions.length).toBe(2);
    for (const t of withActions) expect(t).toContain("phoneCorner");
    for (const t of tags.filter((x) => !x.includes("actions={headerActions}"))) expect(t).not.toContain("phoneCorner");
    // the "…" keeps its name, popup semantics and handler
    expect(src).toMatch(/className=\{PHONE_ICON40\}\s*onClick=\{\(\) => setOverflowOpen\(\(v\) => !v\)\}\s*aria-label=\{t\("moreActions", "More actions"\)\}\s*aria-haspopup="menu"\s*aria-expanded=\{overflowOpen\}/);
  });

  it("the phone-quiet headers are the generic ones only (Vagtplan, Timer) — never Home's status eyebrow or date", () => {
    expect(read("pages/StaffSchedulePage.jsx")).toMatch(/<PageHeader\s+phoneRow\s+phoneQuiet\s+className="max-sm:mb-0"/);
    expect(read("pages/StaffHoursPage.jsx")).toMatch(/<PageHeader\s+phoneQuiet\s+className="max-sm:mb-4"/);
    expect(read("pages/DashboardPage.jsx")).not.toContain("phoneQuiet");
  });
});

describe("2. nothing removed: controls, ids, aria, handlers and texts per touched file", () => {
  // Pinned from origin/main d6a27b72 with the same counter (comments stripped).
  // tKeys = distinct t("…") keys; the pass adds exactly the listed new ones.
  const ORIGIN_COUNTS = {
    "components/ui/PageHeader.jsx": { tKeys: 0 },
    "components/ui/StatCard.jsx": { onClick: 1, ariaExpanded: 1, ariaControls: 1, ariaPressed: 1, button: 1, tKeys: 0 },
    "components/dashboard/KpiStrip.jsx": { tKeys: 13 },
    "pages/DashboardPage.jsx": { onClick: 6, onSubmit: 2, ariaLabel: 1, ariaExpanded: 1, ariaHaspopup: 1, role: 4, title: 3, Button: 3, button: 3, Link: 1, to: 1, tKeys: 13 },
    "components/dashboard/TodayOnShiftCard.jsx": { Link: 2, to: 2, tKeys: 4 },
    "components/DailyBriefCard.jsx": { onClick: 5, ariaLabel: 4, role: 1, title: 3, button: 5, Link: 2, disabled: 2, to: 2, tKeys: 12 },
    // R1 fix round (24 Oct 2026) ADDED to StaffSchedulePage, nothing removed:
    // the "already booked on those days" banner (+1 title, to, testid) and
    // the sheet's online-booking hint (+1 testid), 5 new t() keys. Was
    // { title: 51, testid: 11, to: 4, tKeys: 449 }.
    "pages/StaffSchedulePage.jsx": { onClick: 96, onChange: 49, onSubmit: 3, ariaLabel: 40, ariaExpanded: 3, ariaPressed: 4, role: 12, title: 52, id: 15, testid: 13, Button: 20, button: 66, disabled: 29, to: 5, tKeys: 454 },
    "components/ScheduleConfirmationCard.jsx": { role: 1, tKeys: 3 },
    "pages/StaffHoursPage.jsx": { onClick: 36, onChange: 21, onSubmit: 6, ariaLabel: 4, ariaExpanded: 1, ariaPressed: 4, role: 13, title: 14, id: 8, testid: 1, Button: 18, button: 22, Link: 4, disabled: 20, to: 6, tKeys: 230 },
    // R1 (24 Oct 2026) ADDED to ReservationsPage, nothing removed: the owner
    // e-mail switch (+1 onClick, ariaLabel, role, button, disabled), the salon
    // no-service CTA (+1 Link, to), status/test hooks (+1 role, +7 testid) and
    // 7 new t() keys. Was { onClick: 85, ariaLabel: 65, role: 32, testid: 6,
    // button: 56, Link: 4, disabled: 29, to: 4, tKeys: 678 }.
    // R1 fix round ADDED, nothing removed: the held drawer's "Booket til",
    // the away-stylist flag (2 rows), the online card's line (+4 testid) and
    // 9 more t() keys (rsvpHeldWhy moved to utils/bookingHeld.js). Was
    // { testid: 13, tKeys: 685 }.
    // Fix round 2 ADDED, nothing removed: 2 t() keys (the "mailed if the
    // budget allows" decline line, the "budget spent" toast). Was
    // { tKeys: 694 }.
    // R1a ADDED, nothing removed: 4 t() keys, the customer's words for a
    // held booking on an appointment book (the decline confirm's two lines,
    // the budget toast, the approve conflict). Was { tKeys: 696 }.
    // R9 (27 Oct 2026) MOVED, nothing removed: the link card (its form,
    // field and Save — onSubmit, onChange, id, testid, Button, disabled and
    // 7 t() keys) to components/reservations/BookingLinkCard.jsx; the hours
    // and rules Gem rows (2 Button, the hours' onClick) to
    // components/reservations/CardSaveBar.jsx; rsvpPacingHint gave way to
    // rsvpPacingGuestsHint(Appt) — the label means guests now. ADDED: 6 ids
    // (the cards' anchors and the hours title), 5 testids, 1 role (the
    // closed-day chip) and 27 t() keys. Was { onClick: 86, onChange: 62,
    // onSubmit: 11, role: 34, id: 22, testid: 17, Button: 32, disabled: 30,
    // tKeys: 700 }.
    // The merge of tracks A, B and C (27 Oct 2026), recounted: R9's pins
    // above + track C's R6–R11 change (track A's R5/R12 mounts change none
    // of these counts) − R8's own "not saved" note (1 testid, 1 t() key),
    // which gave way to R9's CardSaveBar on the hours card. Track C MOVED,
    // nothing removed (audited at the merge): the hours editor's "Brug
    // mandag på alle", closed box and Opens/Closes fields to
    // WeekHoursEditor.jsx (R8); a service's Aktiv toggle and delete to
    // BehandlingRow.jsx (R6); a chair's delete to StylistRow.jsx (R7); the
    // allergy mark's title and label to AllergyWords.jsx (R11, now a
    // sentence); "Det er mig" became a form with a name field (R7). ADDED:
    // 1 onSubmit, 4 roles, 2 ids, 3 testids, 1 button, 2 t() keys net. Was
    // { onClick: 85, onChange: 61, onSubmit: 10, ariaLabel: 66,
    // ariaPressed: 4, role: 35, title: 26, id: 27, testid: 21, button: 57,
    // tKeys: 719 }.
    // Fix round 27 Oct (L) MOVED, nothing removed: the edit sheet
    // (EditBookingSheet — 7 onClick, 7 onChange, 1 onSubmit, 2 aria-label,
    // 1 aria-pressed, 3 role, 7 id, 5 Button, 2 button, 2 disabled) to
    // components/reservations/EditBookingSheet.jsx, so the door screen's
    // own build can load it on first use (MERGE §5 item 4); the sheets'
    // keyboard hooks (the 2 role= in their dialog selector) to
    // hooks/useSheetFocus.js; snapStart to utils/snapStart.js. 15 t() keys
    // only those said left the page with them; each moved file is pinned
    // below. Was { onClick: 81, onChange: 60, onSubmit: 11, ariaLabel: 61,
    // ariaPressed: 3, role: 39, id: 29, Button: 29, button: 54,
    // disabled: 29, tKeys: 720 }.
    // Fix round 5 (27 Oct) ADDED, nothing removed: the door screen's "couldn't
    // load the tables — trying again" line (+1 role, +1 button with its
    // onClick "Try again") and its 3 t() keys (rsvpRoomUnknown,
    // rsvpRoomUnknownAppt, tryAgain). Was { onClick: 74, role: 34,
    // button: 52, tKeys: 705 }.
    // Fix round 6 (27 Oct) ADDED, nothing removed: the drop-in sheet's
    // "couldn't load the tables" box (+1 role, +2 button with their onClick:
    // "Try again" and "Add to waitlist"), with the existing words (no new
    // t() keys). Was { onClick: 75, role: 35, button: 53 }.
    "pages/ReservationsPage.jsx": { onClick: 77, onChange: 53, onSubmit: 10, ariaLabel: 59, ariaExpanded: 3, ariaHaspopup: 2, ariaPressed: 2, role: 36, title: 24, id: 22, testid: 23, Button: 24, button: 55, Link: 5, disabled: 27, to: 5, href: 3, tKeys: 708 },
    "components/reservations/EditBookingSheet.jsx": { onClick: 7, onChange: 7, onSubmit: 1, ariaLabel: 2, ariaPressed: 1, role: 3, id: 7, Button: 5, button: 2, disabled: 2, tKeys: 30 },
    "hooks/useSheetFocus.js": { role: 2, tKeys: 0 },
    "utils/snapStart.js": { tKeys: 4 },
    "pages/InventoryPage.jsx": { onClick: 61, onChange: 38, onSubmit: 1, ariaLabel: 27, role: 1, title: 27, id: 7, Button: 5, button: 41, Link: 2, disabled: 3, to: 2, tKeys: 165 },
    "components/InventoryAutopilotPanel.jsx": { onClick: 5, onChange: 1, ariaLabel: 1, Button: 4, button: 1, disabled: 1, tKeys: 35 },
    "components/LiveKpisToday.jsx": { ariaLabel: 2, title: 1, tKeys: 14 },
    "components/SickCallNotificationCard.jsx": { onClick: 4, button: 4, disabled: 4, tKeys: 22 },
    "components/ui/TabPills.jsx": { onClick: 1, ariaLabel: 1, role: 2, button: 1, tKeys: 0 },
    "pages/DailyClosePage.jsx": { onClick: 84, onChange: 25, ariaLabel: 5, ariaExpanded: 1, ariaPressed: 1, role: 16, title: 23, id: 22, testid: 57, Button: 44, button: 31, Link: 18, disabled: 36, to: 18, href: 2, tKeys: 573 },
  };
  const NEW_KEYS = {
    "components/dashboard/KpiStrip.jsx": ["kpiWeekShort"],
    "components/dashboard/TodayOnShiftCard.jsx": ["todayOnShiftNone"],
    "pages/StaffSchedulePage.jsx": ["schedEmptyWeekShort"],
    "pages/InventoryPage.jsx": ["invKpiItemsShort", "invKpiLowShort", "invKpiFreshShort"],
  };
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const PATS = { onClick: /\bonClick=/g, onChange: /\bonChange=/g, onSubmit: /\bonSubmit=/g, ariaLabel: /\baria-label=/g, ariaExpanded: /\baria-expanded=/g, ariaControls: /\baria-controls=/g, ariaHaspopup: /\baria-haspopup=/g, ariaPressed: /\baria-pressed=/g, role: /\brole=/g, title: /\btitle=/g, id: /\sid=/g, testid: /\bdata-testid=/g, Button: /<Button\b/g, button: /<button\b/g, Link: /<Link\b/g, disabled: /\bdisabled=/g, to: /\sto=/g, href: /\shref=/g };

  it.each(Object.keys(ORIGIN_COUNTS))("%s", (file) => {
    const src = strip(read(file));
    const now = {};
    for (const [k, re] of Object.entries(PATS)) { const n = (src.match(re) || []).length; if (n) now[k] = n; }
    const keys = new Set([...src.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)].map((m) => m[1]));
    const fresh = NEW_KEYS[file] || [];
    for (const k of fresh) expect(keys.has(k), k).toBe(true);
    now.tKeys = keys.size - fresh.length;
    expect(now).toEqual(ORIGIN_COUNTS[file]);
  });
});

describe("3. the six new phone labels", () => {
  const KEYS = {
    todayOnShiftNone: ["No shifts today", "Ingen vagter i dag"],
    kpiWeekShort: ["This week", "Denne uge"],
    schedEmptyWeekShort: ["No shifts yet.", "Ingen vagter endnu."],
    invKpiItemsShort: ["Items", "Varer"],
    // "Lav beholdning" (95px at 13px) truncated beside the chevron at 360px;
    // "Lavt lager" is the app's own phrase (lowStockItems "Lavt lager varer").
    invKpiLowShort: ["Low stock", "Lavt lager"],
    invKpiFreshShort: ["Fresh items", "Friskvarer"],
  };
  it.each(Object.entries(KEYS))("%s exists in en and da, with different text", (k, [e, d]) => {
    expect(en[k]).toBe(e);
    expect(da[k]).toBe(d);
    expect(en[k]).not.toBe(da[k]);
  });
  it("each is called as a bare t(key) — never t(key) || \"fallback\"", () => {
    const files = ["components/dashboard/KpiStrip.jsx", "components/dashboard/TodayOnShiftCard.jsx", "pages/StaffSchedulePage.jsx", "pages/InventoryPage.jsx"];
    const all = files.map(read).join("\n");
    for (const k of Object.keys(KEYS)) {
      expect(all).toContain(`t("${k}")`);
      expect(all).not.toMatch(new RegExp(`t\\("${k}"[^)]*\\)\\s*\\|\\|`));
      expect(all).not.toMatch(new RegExp(`t\\("${k}",`));
    }
  });
});

describe("4. review fix round", () => {
  it("strip text is never under 13px on a phone: label, helper and the money token", () => {
    const el = render(<StatCard label="Items" value={10} helper="h" strip />).container.firstElementChild;
    const label = el.firstElementChild.querySelector("p");
    const value = el.children[1];
    const helper = el.children[2];
    expect(toks(label.className)).toEqual(expect.arrayContaining(["max-sm:text-[13px]", "max-sm:leading-4", "max-sm:truncate", "max-sm:normal-case"]));
    expect(toks(label.className)).not.toContain("max-sm:text-xs");
    expect(toks(helper.className)).toContain("max-sm:text-[13px]");
    expect(toks(value.className)).toEqual(expect.arrayContaining(["max-sm:[&_[data-amount-token]]:text-[13px]", "max-sm:[&_[data-amount-token]]:leading-none"]));
    // and all of it is phone-only
    const plain = render(<StatCard label="Items" value={10} helper="h" />).container.firstElementChild;
    expect(added(plain.children[2].className, helper.className).filter((t) => !isPhoneOnly(t))).toEqual([]);
  });

  it("a clickable strip cell keeps its 12px chevron beside a min-w-0 truncating label", () => {
    const b = render(<StatCard label="Low stock" value={1} strip onClick={() => {}} expandable />).container.querySelector("button");
    const row = b.firstElementChild;
    expect(toks(row.className)).toEqual(expect.arrayContaining(["max-sm:items-center", "max-sm:gap-1", "max-sm:min-h-0"]));
    const chev = row.querySelector("svg");
    expect(chev.getAttribute("width")).toBe("12");
    expect(toks(chev.getAttribute("class"))).toEqual(expect.arrayContaining(["text-gray-400", "dark:text-gray-500", "transition-transform", "shrink-0"]));
    expect(toks(chev.getAttribute("class")).filter((c) => /hidden|max-sm:/.test(c))).toEqual([]);
    expect(toks(row.querySelector("p").className)).toEqual(expect.arrayContaining(["max-sm:min-w-0", "max-sm:truncate"]));
  });

  it("Timer and Kasserapport KPIs are phone strips: the grid wears PHONE_STRIP and all four tiles are strip cells", () => {
    for (const [file, gridFrag] of [["pages/StaffHoursPage.jsx", '"grid grid-cols-2 lg:grid-cols-4 gap-3 " + PHONE_STRIP'], ["components/LiveKpisToday.jsx", '"grid grid-cols-2 sm:grid-cols-4 gap-3 " + PHONE_STRIP']]) {
      const src = read(file);
      const at = src.indexOf(gridFrag);
      expect(at, file).toBeGreaterThan(-1);
      const block = src.slice(at, src.indexOf("</div>", at));
      expect((block.match(/<StatCard\b/g) || []).length, file).toBe(4);
      expect((block.match(/^\s+strip$/gm) || []).length, file).toBe(4);
    }
  });

  it("Lager stock list: phone-only row + 40px icon-button tokens, used on every action", () => {
    const src = read("pages/InventoryPage.jsx");
    const row = src.match(/const PHONE_ITEM_ROW =\s*([\s\S]*?);\n/)[1].replace(/["+\n]/g, " ");
    const btn = src.match(/const PHONE_ITEM_BTN = "([^"]+)";/)[1];
    expect(toks(row).filter((t) => !isPhoneOnly(t))).toEqual([]);
    expect(toks(row)).toEqual(expect.arrayContaining(["max-sm:border-x-0", "max-sm:border-t-0", "max-sm:last:border-b-0"]));
    expect(toks(btn)).toEqual(["max-sm:flex-none", "max-sm:w-10", "max-sm:h-10", "max-sm:min-h-0!"]);
    // Pour, Smart usage, Compare price, Edit, Delete: all five icon buttons
    expect((src.match(/className=\{PHONE_ITEM_BTN \+ " flex-1 min-h-\[44px\]/g) || []).length).toBe(5);
    expect(src).toContain("} ${PHONE_ITEM_ROW}`}");
    // the two filler cells still render (desktop keeps the 5 slots), hidden on a phone
    expect((src.match(/<span className="flex-1 max-sm:hidden" aria-hidden="true" \/>/g) || []).length).toBe(2);
  });

  it("+ Open shift: the Button's label span is an inline row on a phone (the + was on a line of its own)", async () => {
    const Button = (await import("../components/ui/Button")).default;
    const cls = "shrink-0 " + phone.PHONE_CTRL + " max-sm:[&>span]:inline-flex max-sm:[&>span]:items-center max-sm:[&>span]:gap-1.5";
    const b = render(<Button variant="secondary" size="sm" className={cls}><svg data-testid="plus" />Open shift</Button>).container.querySelector("button");
    // the svg and the text share Button's one label <span> — the child the selector targets
    const span = b.querySelector(":scope > span");
    expect(span.querySelector('[data-testid="plus"]')).not.toBeNull();
    expect(span.textContent).toBe("Open shift");
    expect(added("", cls).filter((t) => !isPhoneOnly(t))).toEqual(["shrink-0"]);
  });

  it("Reservations tabs: >= 40px wide targets and an 8px title gap, phone-only", () => {
    const { container } = render(<TabPills tabs={[{ id: "a", label: "Borde" }, { id: "b", label: "Indsigt" }]} activeId="a" onChange={() => {}} size="lg" phone="underline" className="max-sm:-mt-2" />);
    const list = container.querySelector('[role="tablist"]');
    expect(toks(list.className)).toEqual(expect.arrayContaining(["max-sm:gap-5", "max-sm:-mt-2"]));
    expect(toks(list.className)).not.toContain("max-sm:gap-6");
    for (const tab of list.querySelectorAll("button")) expect(toks(tab.className)).toContain("max-sm:min-w-10");
    const md = render(<TabPills tabs={[{ id: "a", label: "A" }]} activeId="a" onChange={() => {}} />).container.querySelector('[role="tablist"]');
    expect(md.className).toBe("flex flex-wrap gap-1.5");
  });

  it("the six phone labels also exist in Turkish (offered in the picker), and the Danish low-stock label fits its cell", () => {
    for (const k of ["todayOnShiftNone", "kpiWeekShort", "schedEmptyWeekShort", "invKpiItemsShort", "invKpiLowShort", "invKpiFreshShort"]) {
      expect(typeof tr[k], k).toBe("string");
      expect(tr[k].length, k).toBeGreaterThan(0);
      expect(tr[k], k).not.toBe(en[k]);
    }
    // "Lav beholdning" (95px at 13px) truncated beside the chevron at 360px.
    expect(da.invKpiLowShort).toBe("Lavt lager");
  });
});

describe("5. base-class swaps: each is restored by sm: (desktop identical)", () => {
  // [file, origin/main d6a27b72 fragment, phone-compact fragment]. A base token
  // may change only where the same property is set by an sm: token in both,
  // or where the new base equals origin's sm: value (that value now applies
  // at every width, and from sm: up it is what applied before).
  const SWAPS = [
    ["components/DailyBriefCard.jsx", "border-gray-100 dark:border-gray-700/60 p-6 sm:p-7 animate-pulse", "border-gray-100 dark:border-gray-700/60 p-5 sm:p-7 animate-pulse"],
    ["components/DailyBriefCard.jsx", 'border-[rgb(var(--surface-line))] p-6 sm:p-7">', 'border-[rgb(var(--surface-line))] p-5 sm:p-7">'],
    ["pages/StaffHoursPage.jsx", '"text-xs sm:text-sm font-semibold text-gray-900 dark:text-gray-100 truncate"', '"text-sm font-semibold text-gray-900 dark:text-gray-100 truncate"'],
    ["pages/InventoryPage.jsx", "dark:bg-[rgb(var(--surface-card))] p-6 rounded-xl", "dark:bg-[rgb(var(--surface-card))] p-5 sm:p-6 rounded-xl"],
  ];
  const prop = (t) => { const m = t.replace(/^sm:/, "").match(/^(-?(?:p[xytblr]?|m[xytblr]?|gap(?:-[xy])?|leading))-|^(text)-(?:xs|sm|base|lg|[0-9]?xl|\[\d+px\])$/); return m ? (m[1] || m[2]) : null; };
  const violations = (o, n) => {
    const O = toks(o.replace(/["{}>]/g, " ")), N = toks(n.replace(/["{}>]/g, " "));
    const out = [];
    for (const t of [...O.filter((x) => !N.includes(x)), ...N.filter((x) => !O.includes(x))]) {
      if (isPhoneOnly(t)) continue;
      const p = prop(t);
      if (!p) { out.push(t); continue; }
      const smO = O.filter((x) => x.startsWith("sm:") && prop(x) === p), smN = N.filter((x) => x.startsWith("sm:") && prop(x) === p);
      const sameSm = smO.length > 0 && smO.every((x) => smN.includes(x));
      const baseIsOldSm = smN.length === 0 && smO.length === 1 && N.includes(smO[0].slice(3));
      const newSmRestoresOldBase = smN.some((x) => O.includes(x.slice(3)));
      if (!(sameSm || baseIsOldSm || newSmRestoresOldBase)) out.push(t);
    }
    return out;
  };
  it("the rule itself rejects an unrestored swap", () => {
    expect(violations("p-6 rounded-xl", "p-5 rounded-xl")).toEqual(["p-6", "p-5"]);
    expect(violations("text-xs sm:text-sm", "text-base")).toEqual(["text-xs", "sm:text-sm", "text-base"]);
    expect(violations("p-6 sm:p-7", "p-5 sm:p-7")).toEqual([]);
  });
  it.each(SWAPS)("%s: %s -> %s", (file, o, n) => {
    const src = read(file);
    expect(src.includes(n)).toBe(true);
    expect(src.includes(o)).toBe(false);
    expect(violations(o, n)).toEqual([]);
  });
});

describe("6. review fix round 2: the minors finished", () => {
  it("absence: one amber card on a phone, each absence a hairline row of it (no white card inside), phone-only", () => {
    const src = read("components/SickCallNotificationCard.jsx");
    const row = src.match(/const PHONE_ABSENCE_ROW =\s*([\s\S]*?);\n/)[1].replace(/["+\n]/g, " ");
    expect(toks(row).filter((t) => !isPhoneOnly(t))).toEqual([]);
    expect(toks(row)).toEqual(expect.arrayContaining(["max-sm:bg-transparent", "max-sm:dark:bg-transparent", "max-sm:rounded-none", "max-sm:px-0", "max-sm:border-x-0", "max-sm:border-t-0", "max-sm:last:border-b-0", "max-sm:first:pt-0", "max-sm:last:pb-0"]));
    // the row's own chrome (sm: and up) is untouched, the phone tokens appended
    expect(src).toContain('className={"bg-white dark:bg-gray-800/40 rounded-xl px-3 py-2.5 border border-amber-100 dark:border-amber-900/20 " + PHONE_ABSENCE_ROW}');
  });

  it("Reservations: the day stepper and the List/Floor/Timeline segments are 40px targets inside their 1px border (were 38)", () => {
    const src = read("pages/ReservationsPage.jsx");
    expect(src).not.toContain("max-sm:h-[38px]");
    expect((src.match(/className="relative h-11 max-sm:h-10 max-sm:min-h-0! flex flex-col/g) || []).length).toBe(2);
    expect(read("components/ui/TabPills.jsx")).not.toContain("max-sm:h-[38px]");
    const { container } = render(<TabPills tabs={[{ id: "l", label: "List" }, { id: "f", label: "Floor" }, { id: "t", label: "Timeline" }]} activeId="l" onChange={() => {}} phone="segmented" />);
    for (const tab of container.querySelectorAll('[role="tablist"] button')) {
      expect(toks(tab.className)).toEqual(expect.arrayContaining(["max-sm:h-10", "max-sm:min-h-0!"]));
    }
  });

  it("Lager strip: spans 2/2/2 then 2/4 on a 6-col phone grid, so row 2's divider continues row 1's first", () => {
    const src = read("pages/InventoryPage.jsx");
    const at = src.indexOf('max-sm:grid-cols-6 " + PHONE_STRIP');
    const block = src.slice(at, src.indexOf("</div>", at));
    const spans = [...block.matchAll(/className="max-sm:col-span-(\d)"/g)].map((m) => Number(m[1]));
    expect(spans).toEqual([2, 2, 2, 2, 4]);
    expect(spans.slice(0, 3).reduce((a, b) => a + b)).toBe(6);
    expect(spans.slice(3).reduce((a, b) => a + b)).toBe(6);
  });
});
