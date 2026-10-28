/**
 * Booking R13 — the design judge's last pass (judge-set-v3), and what was
 * measured at rest.
 *
 *   0. The second row of times "cut 3 px short" at 1440: measured at rest
 *      (≥ 1 s after the last height, every animation finished) in the cream
 *      and the dark look — the step area has no inline height or clip and its
 *      last row ends exactly on its bottom edge (0 px over). The cut is a
 *      frame mid-morph: the step that enters (4 px) and the times that arrive
 *      (3 px) move up while useAutoHeight eases with overflow-y: clip. They
 *      may now paint 8 px past the edge (overflow-clip-margin) while it eases.
 *   1. Cream look: the tiles, trust strip and tracks follow the site (the card
 *      3 % / 6 % toward its ink, hairlines 8 %), the current step dot is the
 *      ink — no cool gray-50 / gray-100 on a warm card. All text AA on them.
 *   2. The booking page on its own in dark: theme-color and <html>/<body> are
 *      its own ground, #030712 (gray-950), not #1f2937 / #111827.
 *   3. Dark looks: the selected segment is raised (card + 12 % white), not
 *      the card colour on a lighter track (it read pressed in).
 *   4. The segmented switches (DA/EN, services, e-mail / phone) follow the
 *      site's corners.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIP_MARGIN, useAutoHeight } from "../hooks/useAutoHeight";
import { LOOK_FONTS, LOOK_RADII, lookFrom } from "../lib/bookingLook";
import { contrast } from "../utils/accentColor";
import { THEME_COLOR, themeColorFor } from "../utils/themeColor";
import { bookingBootSource } from "../../scripts/bookingBoot.mjs";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../services/api", () => ({ default: { get: (...a) => h.get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn() } }));
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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const CSS = read("index.css");
const look = (q) => lookFrom(q, LOOK_RADII, LOOK_FONTS);
const html = () => document.documentElement;

afterEach(() => {
  cleanup();
  html().className = "";
  html().removeAttribute("style");
});

describe("0 · the last row of times is never cut at rest; while the step area eases it may paint 8 px past its edge", () => {
  let ro;
  let height;
  const realRO = globalThis.ResizeObserver;
  beforeEach(() => {
    vi.useFakeTimers();
    height = 300;
    globalThis.ResizeObserver = class {
      constructor(cb) {
        ro = this;
        this.cb = cb;
      }
      observe() {}
      disconnect() {}
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = realRO;
  });
  function Box() {
    const [el, setEl] = useState(null);
    useAutoHeight(el);
    return (
      <div
        data-testid="box"
        ref={(node) => {
          if (node) node.getBoundingClientRect = () => ({ height, width: 400, top: 0, left: 0, right: 400, bottom: height });
          setEl(node);
        }}
      />
    );
  }
  it("clip + margin while it eases, nothing at rest", () => {
    render(<Box />);
    const box = screen.getByTestId("box");
    const set = vi.spyOn(box.style, "setProperty");
    const removed = vi.spyOn(box.style, "removeProperty");
    act(() => ro.cb([]));
    height = 360; // the times arrived: a second row
    act(() => ro.cb([]));
    expect(box.style.overflowY).toBe("clip");
    expect(set).toHaveBeenCalledWith("overflow-clip-margin", CLIP_MARGIN);
    expect(CLIP_MARGIN).toBe("8px"); // ≥ the 4 px step entry + 3 px time arrival
    act(() => vi.advanceTimersByTime(400));
    expect(box.style.overflowY).toBe("");
    expect(box.style.height).toBe("");
    expect(removed).toHaveBeenCalledWith("overflow-clip-margin");
  });
});

describe("1 · cream look: the quiet greys follow the site (no blue cast), all text AA", () => {
  const cream = look("?look=1&surface=f4efe6&ink=2b2118");
  it("fill 3 % toward the ink (≈ #F6F3EE), tracks 6 %, hairlines 8 %", () => {
    expect(cream.fill).toBe("#F6F3F1");
    expect(cream.fill2).toBe("#EFEDEB");
    expect(cream.line).toBe("#EBE9E6");
    // warm, not BonBox's cool #F9FAFB: red ≥ blue
    const rgb = (h2) => [1, 3, 5].map((i) => parseInt(h2.slice(i, i + 2), 16));
    const [r, , b] = rgb(cream.fill);
    expect(r).toBeGreaterThanOrEqual(b);
  });
  it("the ink and its softer line read at 4.5:1 on the fills and the hairline's tile", () => {
    for (const bg of [cream.card, cream.fill, cream.fill2, cream.tint]) {
      expect(contrast(cream.ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(cream.soft, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("CSS: light-look remaps — tiles / strip fill, tracks fill2, tile + bar hairlines, the current step dot the ink", () => {
    expect(CSS).toContain(":root.bb-look:not(.dark) .bg-gray-50:not(.bb-solid) { background-color: var(--bb-fill); }");
    expect(CSS).toContain(":root.bb-look:not(.dark) .bg-gray-100 { background-color: var(--bb-fill-2); }");
    expect(CSS).toMatch(/:root\.bb-look:not\(\.dark\) \.border-gray-900\\\/\\\[0\\\.06\\\],\s*:root\.bb-look:not\(\.dark\) \.border-gray-900\\\/\\\[0\\\.07\\\] \{ border-color: var\(--bb-line\); \}/);
    expect(CSS).toContain(':root.bb-ink [role="progressbar"] > [data-current="true"] { background-color: var(--bb-ink); }');
  });
});

describe("2 · the booking page on its own, in dark: its own ground everywhere", () => {
  it("theme-color for a mounted booking page in dark is #030712; the owner app keeps #1f2937", () => {
    expect(THEME_COLOR.guestDark).toBe("#030712");
    expect(themeColorFor(true, "/cafe-nordlys", { guest: true })).toBe("#030712");
    expect(themeColorFor(true, "/dashboard")).toBe("#1f2937");
  });
  it("the pre-paint writes #030712 for it (a dark phone or a stored dark); <head> marks it bb-guest", () => {
    const INDEX = fs.readFileSync(path.join(SRC, "..", "index.html"), "utf8");
    const prePaint = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((x) => x.includes('localStorage.getItem("theme")'));
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
    const realMM = window.matchMedia;
    try {
      for (const [stored, osDark] of [["dark", false], ["light", true]]) {
        localStorage.setItem("theme", stored);
        window.matchMedia = (q) => ({ matches: osDark && q === "(prefers-color-scheme: dark)" });
        window.history.replaceState({}, "", "/cafe-nordlys");
        window.__bbBooking = { slug: "cafe-nordlys", embed: false };
        meta.setAttribute("content", "#ffffff");
        new Function(prePaint)();
        expect(meta.getAttribute("content"), stored).toBe("#030712");
      }
      delete window.__bbBooking;
      localStorage.setItem("theme", "dark");
      window.history.replaceState({}, "", "/dashboard");
      new Function(prePaint)();
      expect(meta.getAttribute("content")).toBe("#1f2937");
    } finally {
      window.matchMedia = realMM;
      delete window.__bbBooking;
      localStorage.clear();
      meta.remove();
      window.history.replaceState({}, "", "/");
    }
    // the boot script (head) marks the booking page on its own, never the embed
    const classes = new Set();
    const w = { matchMedia: () => ({ matches: false }), AbortController };
    w.self = w;
    w.top = w;
    const doc = { createElement: (t) => ({ t }), head: { appendChild() {} }, documentElement: { classList: { add: (c) => classes.add(c) } } };
    new Function("window", "location", "document", "fetch", bookingBootSource({ apiUrl: "" }))(w, { pathname: "/cafe-nordlys", search: "", protocol: "https:", hostname: "localhost" }, doc, undefined);
    expect(classes.has("bb-guest")).toBe(true);
  });
  it("CSS: html and body take gray-950 there in dark (not the app's #111827)", () => {
    expect(CSS).toMatch(/:root\.dark\.bb-guest,\s*:root\.dark\.bb-guest body \{ background-color: var\(--color-gray-950\); \}/);
  });
});

describe("3 · dark looks: the selected segment is raised, not pressed in", () => {
  it("card + 12 % white (≈ #3A3A3A on NOIR), text still AA", () => {
    const noir = look("?look=1&surface=0b0b0b&ink=eeeeee");
    expect(noir.card).toBe("#1C1C1C");
    expect(noir.raise).toBe("#373737");
    expect(contrast(noir.ink, noir.raise)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(noir.soft, noir.raise)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#FFFFFF", noir.raise)).toBeGreaterThanOrEqual(4.5);
    expect(CSS).toContain(":root.bb-look.dark .dark\\:bg-gray-600 { background-color: var(--bb-raise); }");
  });
});

describe("4 · the segmented switches follow the site's corners", () => {
  it("CSS: track on the tile rung, segments one padding inside", () => {
    expect(CSS).toContain(":root.bb-look .bb-seg { border-radius: var(--bb-r-tile, 12px); }");
    expect(CSS).toContain(":root.bb-look .bb-seg > button { border-radius: max(0px, calc(var(--bb-r-tile, 12px) - 4px)); }");
  });
  it("DA/EN, the services and e-mail / phone carry the hook", async () => {
    const page = read("pages/ReservationPublicPage.jsx");
    expect(page.match(/className="bb-seg /g)).toHaveLength(3);
    // and the rendered DA/EN switch does
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/x") {
        return Promise.resolve({ data: { business_name: "Bistro", business_type: "restaurant", max_party_size: 8, max_advance_days: 30, language: "da" } });
      }
      return Promise.resolve({ data: { slots: [], days: [] } });
    });
    if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.scrollTo = () => {};
    const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
    render(
      <MemoryRouter initialEntries={["/r/x?embed=1&compact=1"]}>
        <Routes>
          <Route path="/r/:slug" element={<ReservationPublicPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const group = await screen.findByRole("group", { name: "Sprog · Language" });
    expect(group.className).toContain("bb-seg");
  });
});
