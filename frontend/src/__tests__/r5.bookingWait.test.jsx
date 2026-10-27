/**
 * Booking R5 — "something useful on screen within ~1 s on slow 4G" (rubric
 * E10/G13): the booking page's wait, from the very first paint.
 *
 *  • ONE skeleton (components/booking/bookingWait.js) for all three moments:
 *    index.html's first paint (skeletonHtml, written by the parse-time
 *    script), the route's Suspense fallback (BookingSkeleton) and the page's
 *    own loading state — the same markup, so nothing moves between them;
 *  • the parse-time script (scripts/bookingBoot.mjs) only acts on a booking
 *    address, picks the page's own look (card / flat / desktop / phone),
 *    starts the page's chunk and its data with the page, never in the native
 *    apps, and asks only plain GETs (no credentials, no custom header);
 *  • index.html puts the wait inside #root; a booking page gets no owner-app
 *    manifest and no service worker; the dictionary preload stays away.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BookingSkeleton from "../components/booking/BookingSkeleton";
import { SKELETON_VARIANTS, skeletonHtml, skeletonVariant, variantForHere } from "../components/booking/bookingWait";
import { RESERVED_SLUGS } from "../lib/bookingPath";
import { PROBE_TIMEOUT_MS, bookingBootScript, bookingBootSource } from "../../scripts/bookingBoot.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.resolve(SRC, "..");
const INDEX = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
const CONFIG = fs.readFileSync(path.join(FRONTEND, "vite.config.js"), "utf8");

// tag / class / text tree of a DOM node
const shape = (el) => ({
  tag: el.tagName.toLowerCase(),
  cls: el.getAttribute("class") || "",
  text: el.children.length ? null : el.textContent,
  kids: [...el.children].map(shape),
});
const fromHtml = (html) => {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box.firstElementChild;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("one wait, three moments", () => {
  it.each(SKELETON_VARIANTS)("%s: the HTML index.html paints IS the route's fallback (same tags, classes, empty word line)", (v) => {
    const html = fromHtml(skeletonHtml(v));
    const { container } = render(<BookingSkeleton variant={v} />);
    const react = container.firstElementChild;
    expect(shape(react)).toEqual(shape(html));
    expect(html.getAttribute("data-bb-wait")).toBe(v);
    expect(react.getAttribute("data-bb-wait")).toBe(v);
    expect(html.getAttribute("aria-hidden")).toBe("true");
    expect(react.getAttribute("aria-hidden")).toBe("true");
  });

  it("the page's own loading state is the same skeleton with its word", () => {
    const { container } = render(<BookingSkeleton variant="plain" word="Henter…" />);
    expect(container.textContent).toBe("Henter…");
    expect(container.firstElementChild.hasAttribute("aria-hidden")).toBe(false); // the word is read out
    const page = fs.readFileSync(path.join(SRC, "pages/ReservationPublicPage.jsx"), "utf8");
    expect(page).toMatch(/<BookingSkeleton\s+key="loading"\s+variant=\{skeletonVariant\(\{ embed: isEmbed, flat, wide \}\)\}\s+word=\{t\("rsvpLoading", "Loading…"\)\}/);
  });

  it("keeps R3/R4's geometry: the embed's card from 450 px capped at 560, the desktop's two columns", () => {
    const card = fromHtml(skeletonHtml("embedCard"));
    expect(card.className).toContain("min-[450px]:bg-transparent");
    expect(card.firstElementChild.className).toContain("max-w-[560px]");
    expect(card.firstElementChild.className).toContain("min-[450px]:rounded-[16px]");
    expect(card.className).not.toContain("min-h-screen");
    const flat = fromHtml(skeletonHtml("embedFlat"));
    expect(flat.firstElementChild.className).not.toContain("min-[450px]:rounded-[16px]");
    const wide = fromHtml(skeletonHtml("wide"));
    expect(wide.querySelector(".grid.max-w-5xl").children).toHaveLength(2);
    const plain = fromHtml(skeletonHtml("plain"));
    expect(plain.className).toContain("min-h-screen");
    expect(plain.firstElementChild.className).toContain("max-w-md");
  });

  it("the look follows the page's own rule", () => {
    expect(skeletonVariant({ embed: true })).toBe("embedCard");
    expect(skeletonVariant({ embed: true, flat: true })).toBe("embedFlat");
    expect(skeletonVariant({ embed: true, wide: true })).toBe("embedCard");
    expect(skeletonVariant({ wide: true })).toBe("wide");
    expect(skeletonVariant({})).toBe("plain");
  });

  it("variantForHere (the route's fallback, before the page's code) reads the address and the screen", () => {
    window.history.replaceState({}, "", "/r/cafe?embed=1&flat=1");
    expect(variantForHere()).toBe("embedFlat");
    window.history.replaceState({}, "", "/r/cafe?embed=1");
    expect(variantForHere()).toBe("embedCard");
    const mm = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes("1024"), addEventListener() {}, removeEventListener() {} });
    window.history.replaceState({}, "", "/cafe-nordlys");
    expect(variantForHere()).toBe("wide");
    window.matchMedia = mm;
    window.history.replaceState({}, "", "/");
  });

  it("App.jsx: the guest route waits on it (no blank page, no spinner)", () => {
    const app = fs.readFileSync(path.join(SRC, "App.jsx"), "utf8");
    expect(app).toContain("<Suspense fallback={<BookingSkeleton variant={variantForHere()} />}>");
  });
});

// ── the parse-time script ────────────────────────────────────────────
function runBoot({
  path: p = "/cafe-nordlys", search = "", host = "www.bonbox.dk", apiUrl = "https://api.bonbox.dk/api",
  preload = [], framed = false, wide = false, capacitor = false, protocol = "https:",
} = {}) {
  const fetched = [];
  const links = [];
  const classes = new Set();
  const fakeFetch = (url, opts) => {
    fetched.push({ url, opts });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ url }) });
  };
  const w = { Capacitor: capacitor ? {} : undefined, matchMedia: () => ({ matches: wide }), fetch: fakeFetch, AbortController };
  w.self = w;
  w.top = framed ? {} : w;
  const doc = {
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => links.push(el) },
    documentElement: { classList: { add: (c) => classes.add(c) } },
  };
  const loc = { pathname: p, search, protocol, hostname: host };
  new Function("window", "location", "document", "fetch", bookingBootSource({ apiUrl, preload }))(w, loc, doc, fakeFetch);
  return { boot: w.__bbBooking, fetched, links, classes };
}

describe("the parse-time script", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 0, 8, 9, 0));
  });

  it.each([
    ["/cafe-nordlys", "cafe-nordlys"],
    ["/cafe-nordlys/", "cafe-nordlys"],
    ["/r/cafe", "cafe"],
    ["/r/staff", "staff"],
  ])("%s is a booking page (%s)", (p, slug) => {
    const { boot } = runBoot({ path: p });
    expect(boot.slug).toBe(slug);
  });

  it.each(["/", "/dashboard", "/Dashboard", "/staff", "/login", "/reservations/stand", "/s/tok", "/r/cafe/extra", "/%E0%A4%A"])(
    "%s is not: nothing marked, nothing fetched, nothing preloaded",
    (p) => {
      const { boot, fetched, links, classes } = runBoot({ path: p, preload: ["/assets/x.js"] });
      expect(boot).toBeUndefined();
      expect(fetched).toEqual([]);
      expect(links).toEqual([]);
      expect(classes.size).toBe(0);
    },
  );

  it("carries the frontend's reserved list (itself the backend's)", () => {
    expect(bookingBootSource()).toContain(JSON.stringify(RESERVED_SLUGS));
  });

  it("never in the native apps", () => {
    expect(runBoot({ capacitor: true }).boot).toBeUndefined();
    expect(runBoot({ protocol: "capacitor:" }).boot).toBeUndefined();
  });

  it("picks the page's own look", () => {
    expect(runBoot().boot.ph).toBe(skeletonHtml("plain"));
    expect(runBoot({ wide: true }).boot.ph).toBe(skeletonHtml("wide"));
    expect(runBoot({ wide: true, framed: true }).boot.ph).toBe(skeletonHtml("plain"));
    const card = runBoot({ path: "/r/cafe", search: "?embed=1&compact=1", wide: true });
    expect(card.boot.ph).toBe(skeletonHtml("embedCard"));
    expect(card.boot.embed).toBe(true);
    expect(card.classes.has("bb-embed-card")).toBe(true); // the host's ground shows from the first paint
    const flat = runBoot({ path: "/r/cafe", search: "?embed=1&flat=1" });
    expect(flat.boot.ph).toBe(skeletonHtml("embedFlat"));
    expect(flat.classes.has("bb-embed-card")).toBe(false);
  });

  it("starts the page's chunk alongside the app's (modulepreload, crossorigin)", () => {
    const { links } = runBoot({ preload: ["/assets/ReservationPublicPage-x.js", "/assets/booking-dict-y.js"] });
    expect(links).toEqual([
      { tag: "link", rel: "modulepreload", crossOrigin: "", href: "/assets/ReservationPublicPage-x.js" },
      { tag: "link", rel: "modulepreload", crossOrigin: "", href: "/assets/booking-dict-y.js" },
    ]);
  });

  it("asks for the page, today's times and the 14-day summary: plain GETs, no credentials, no custom header", async () => {
    const { boot, fetched } = runBoot({ path: "/cafe-nordlys" });
    expect(fetched.map((f) => f.url)).toEqual([
      "https://api.bonbox.dk/api/public/reservations/cafe-nordlys",
      "https://api.bonbox.dk/api/public/reservations/cafe-nordlys/availability?day=2030-01-08&party=2",
      "https://api.bonbox.dk/api/public/reservations/cafe-nordlys/availability-summary?from=2030-01-08&days=14&party=2",
    ]);
    for (const f of fetched) {
      expect(f.opts.credentials).toBe("omit");
      expect(f.opts.headers).toBeUndefined();
      expect(f.opts.method).toBeUndefined();
    }
    expect(boot.page.base).toBe("https://api.bonbox.dk/api");
    expect(boot.avail).toMatchObject({ day: "2030-01-08", party: 2 });
    expect(boot.summary).toMatchObject({ from: "2030-01-08", days: 14, party: 2 });
    await expect(boot.page.promise).resolves.toEqual({ ok: true, status: 200, data: { url: fetched[0].url } });
    expect(boot.page.done).toEqual({ ok: true, status: 200, data: { url: fetched[0].url } });
  });

  it("takes the link's ?d= and ?party= as its guess (a past day is today)", () => {
    expect(runBoot({ search: "?d=2030-01-20&party=4" }).boot.avail).toMatchObject({ day: "2030-01-20", party: 4 });
    expect(runBoot({ search: "?d=2029-12-01" }).boot.avail).toMatchObject({ day: "2030-01-08", party: 2 });
    expect(runBoot({ search: "?party=0" }).boot.avail).toMatchObject({ party: 2 });
  });

  it("a receipt link (?booking=&token=) asks for the page only", () => {
    const { fetched, boot } = runBoot({ search: "?booking=abc&token=t" });
    expect(fetched).toHaveLength(1);
    expect(boot.avail).toBeUndefined();
  });

  it("the API: the build's address; else api.bonbox.dk on bonbox.dk; else nothing (a local preview asks itself)", () => {
    expect(runBoot({ apiUrl: "" }).fetched[0].url).toMatch(/^https:\/\/api\.bonbox\.dk\/api\//);
    expect(runBoot({ apiUrl: "", host: "localhost" }).fetched).toEqual([]);
    expect(runBoot({ apiUrl: "http://localhost:8000/api/", host: "localhost" }).fetched[0].url).toBe(
      "http://localhost:8000/api/public/reservations/cafe-nordlys",
    );
  });

  it("gives up after 15 s (the page then asks itself, with its retries)", () => {
    expect(PROBE_TIMEOUT_MS).toBe(15000);
    expect(bookingBootSource()).toContain("c.abort()},15000)");
  });

  it("a failed request is an answer the page can read, never a thrown error", async () => {
    const w = { matchMedia: () => ({ matches: false }), AbortController };
    w.self = w;
    w.top = w;
    const failing = () => Promise.reject(new Error("offline"));
    w.fetch = failing;
    new Function("window", "location", "document", "fetch", bookingBootSource({ apiUrl: "https://api.bonbox.dk/api" }))(
      w, { pathname: "/cafe", search: "", protocol: "https:", hostname: "www.bonbox.dk" },
      { createElement: () => ({}), head: { appendChild() {} }, documentElement: { classList: { add() {} } } },
      failing,
    );
    await expect(w.__bbBooking.page.promise).resolves.toEqual({ ok: false, status: 0, data: null });
  });

  it("is safe inside an inline <script> (no early </script>)", () => {
    const tag = bookingBootScript({ preload: ["/a.js"] });
    expect(tag.startsWith("<script>")).toBe(true);
    expect(tag.slice(8, -9)).not.toMatch(/<\/script/i);
  });
});

describe("index.html and the build", () => {
  it("puts the wait inside #root, where React's first commit replaces it", () => {
    const m = INDEX.match(/<div id="root"><script>([\s\S]*?)<\/script><\/div>/);
    expect(m).not.toBeNull();
    const inserted = [];
    const fakeScript = { insertAdjacentHTML: (where, html) => inserted.push([where, html]) };
    new Function("window", "document", m[1])({ __bbBooking: { ph: "<div>wait</div>" } }, { currentScript: fakeScript });
    expect(inserted).toEqual([["beforebegin", "<div>wait</div>"]]);
    inserted.length = 0;
    new Function("window", "document", m[1])({}, { currentScript: fakeScript });
    expect(inserted).toEqual([]);
  });

  it("a booking page gets no owner-app manifest", () => {
    const script = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).find((x) => x.includes("function setManifest"));
    document.head.querySelectorAll('link[rel="manifest"]').forEach((l) => l.remove());
    window.history.replaceState({}, "", "/cafe-nordlys");
    window.__bbBooking = { slug: "cafe-nordlys" };
    new Function(script)();
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();
    delete window.__bbBooking;
    window.history.replaceState({}, "", "/dashboard");
    new Function(script)();
    expect(document.head.querySelector('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.json");
    document.head.querySelectorAll('link[rel="manifest"]').forEach((l) => l.remove());
    window.history.replaceState({}, "", "/");
  });

  it("no service worker on a booking page", () => {
    expect(INDEX).toContain('if ("serviceWorker" in navigator && !window.__bbBooking) {');
  });

  it("vite.config: the booking script goes first in <head> (it runs after the two preloads, each inserting after <meta charset>)", () => {
    const plugins = CONFIG.match(/plugins: \[([^\]]*)\]/)[1];
    const order = ["preloadDictionary()", "preloadLanding()", "bookingBoot()"].map((p) => plugins.indexOf(p));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const fn = CONFIG.slice(CONFIG.indexOf("function bookingBoot()"), CONFIG.indexOf("// https://vite.dev/config/"));
    expect(fn).toContain("html.replace(charset, charset + script)");
    expect(fn).toMatch(/ReservationPublicPage\\\.jsx\$/);
    expect(fn).toContain("config.env && config.env.VITE_API_URL");
  });
});

describe("one switch each", () => {
  it("the parse-time script is on (vite.config.js BOOKING_BOOT), and off means index.html is left as it was", async () => {
    expect(CONFIG).toContain("export const BOOKING_BOOT = true");
    expect(CONFIG).toMatch(/handler\(html, ctx\) \{\s*if \(!BOOKING_BOOT\) return html/);
  });

  it("the page's own words are on (lib/pageDict PAGE_WORDS_ON), read by the provider and the gate", async () => {
    const { PAGE_WORDS_ON } = await import("../lib/pageDict");
    expect(PAGE_WORDS_ON).toBe(true);
    const lang = fs.readFileSync(path.join(SRC, "hooks/useLanguage.jsx"), "utf8");
    expect(lang).toMatch(/const onBookingPage = \(code\) => PAGE_WORDS_ON && /);
    expect(lang).toMatch(/const pageReady = \(\) => PAGE_WORDS_ON && isBookingPathNow\(\);/);
    const app = fs.readFileSync(path.join(SRC, "App.jsx"), "utf8");
    expect(app).toContain("!(PAGE_WORDS_ON && isBookingPath(pathname))");
  });
});
