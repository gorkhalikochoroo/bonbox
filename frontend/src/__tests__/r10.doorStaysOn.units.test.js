/**
 * R10 — the door iPad stays on: the small pieces, one by one.
 *
 *   • The stand credential is read from the ADDRESS BAR at each request
 *     (services/standAuth), so the first request of a cold start is already
 *     the stand's — and a tab that leaves the stand stops being one.
 *   • A stand page is never sent to the owner login by a 401 (services/api).
 *   • The 20-second check (lib/bookLive): a book open is asked within 18 s,
 *     every wait spread at random, a backoff while BonBox cannot be reached,
 *     and the revision verdict.
 *   • Failures are words, never the server's code (utils/bookFailWords).
 *   • The home-screen icon of a paired device opens its book: the manifest
 *     choice in index.html, and the device's own manifest.
 *   • Every new key has real en + da text.
 *
 * Run: cd frontend && npx vitest run src/__tests__/r10.doorStaysOn.units.test.js
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearStandToken,
  getStandToken,
  rememberedStandToken,
  setStandToken,
  standRewrite,
  standTokenFromPath,
} from "../services/standAuth";
import { on401 } from "../services/api";
import {
  ALERT_POLL_MS,
  BOOK_POLL_MS,
  MAX_BACKOFF_MS,
  bookRevVerdict,
  nextPollDelay,
  safetyReloadMs,
  unwatchBook,
  watchBook,
  watchedBook,
} from "../lib/bookLive";
import { bookFailWords } from "../utils/bookFailWords";

const { en } = await import("../i18n/en");
const { da } = await import("../i18n/da");

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, "..", "..");
const PUBLIC = join(FRONTEND, "public");
const read = (p) => readFileSync(p, "utf8");

const go = (path) => window.history.pushState({}, "", path);
const TOKEN = "Zt4kQn9x_Sample-Token-0123456789ab";

beforeEach(() => {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* no storage */ }
  go("/");
});
afterEach(() => go("/"));

describe("the stand credential lives in the address bar", () => {
  it("reads the token of a /stand/<token> path, and nothing else", () => {
    expect(standTokenFromPath(`/stand/${TOKEN}`)).toBe(TOKEN);
    expect(standTokenFromPath(`/stand/${TOKEN}/anything`)).toBe(TOKEN);
    expect(standTokenFromPath("/stand")).toBeNull();
    expect(standTokenFromPath("/stand/")).toBeNull();
    // The owner's pop-out has a real session: never a device token.
    expect(standTokenFromPath("/reservations/stand")).toBeNull();
    expect(standTokenFromPath(undefined)).toBeNull();
  });

  it("is true from the very first request of a cold start — no adoption step", () => {
    // Nothing remembered, nothing in sessionStorage, no route rendered yet:
    // the live-alert poll's first request still goes to the stand.
    go(`/stand/${TOKEN}`);
    expect(getStandToken()).toBe(TOKEN);
    expect(standRewrite("/reservations/changes")).toBe(`/stand/${TOKEN}/changes`);
    expect(standRewrite("/reservations/reservations/r1/status")).toBe(`/stand/${TOKEN}/reservations/r1/status`);
    expect(standRewrite("/auth/me")).toBeNull();
  });

  it("a tab that leaves the stand stops being one (the stale-token leak)", () => {
    go(`/stand/${TOKEN}`);
    setStandToken(TOKEN); // remembered, as after a loaded book
    go("/reservations"); // e.g. the owner signs in in the same tab
    expect(getStandToken()).toBeNull();
    expect(standRewrite("/reservations/book")).toBeNull();
    // The pre-R10 tab cache is never read, and is cleared when seen.
    sessionStorage.setItem("bonbox_stand_token", TOKEN);
    expect(standRewrite("/reservations/book")).toBeNull();
    setStandToken(TOKEN);
    expect(sessionStorage.getItem("bonbox_stand_token")).toBeNull();
  });

  it("remembers the device's pairing, and forgets it on request", () => {
    expect(rememberedStandToken()).toBeNull();
    setStandToken(TOKEN);
    expect(rememberedStandToken()).toBe(TOKEN);
    clearStandToken();
    expect(rememberedStandToken()).toBeNull();
    // Junk in storage is not a pairing.
    localStorage.setItem("bonbox_stand_device", "../../evil path");
    expect(rememberedStandToken()).toBeNull();
  });
});

describe("a 401 never sends a door screen to the owner login", () => {
  it("/stand and /stand/<token>: no redirect, and no owner token wiped", () => {
    for (const path of ["/stand", `/stand/${TOKEN}`]) {
      const r = on401(path, "/reservations/changes");
      expect(r.redirect, path).toBe(false);
      expect(r.wipeToken, path).toBe(false);
    }
  });

  it("the owner's own pop-out and owner pages are unchanged", () => {
    expect(on401("/reservations/stand", "/reservations/book").redirect).toBe(true);
    expect(on401("/dashboard", "/sales").redirect).toBe(true);
    expect(on401("/r/cafe", "/billing/entitlements").redirect).toBe(false);
  });
});

describe("the 20-second check (lib/bookLive)", () => {
  it("a book open is asked within 18 s and never later; alerts alone within 20 s", () => {
    expect(nextPollDelay({ bookOpen: true, random: () => 0 })).toBe(BOOK_POLL_MS);
    expect(nextPollDelay({ bookOpen: true, random: () => 1 })).toBe(Math.round(BOOK_POLL_MS * 0.8));
    expect(nextPollDelay({ bookOpen: false, random: () => 0 })).toBe(ALERT_POLL_MS);
    for (let i = 0; i < 200; i++) {
      const d = nextPollDelay({ bookOpen: true });
      expect(d).toBeLessThanOrEqual(18000);
      expect(d).toBeGreaterThanOrEqual(14400);
    }
    // 18 s + the poll + the reload stays inside the 20 s promise.
    expect(BOOK_POLL_MS).toBeLessThanOrEqual(18000);
  });

  it("spreads the fleet: the waits are not all the same", () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(nextPollDelay({ bookOpen: true }));
    expect(seen.size).toBeGreaterThan(5);
  });

  it("backs off while BonBox cannot be reached, up to two minutes", () => {
    const at = (failures) => nextPollDelay({ failures, bookOpen: true, random: () => 0 });
    expect(at(1)).toBe(BOOK_POLL_MS); // one blip does not slow recovery
    expect(at(2)).toBe(BOOK_POLL_MS * 2);
    expect(at(3)).toBe(BOOK_POLL_MS * 4);
    expect(at(4)).toBe(MAX_BACKOFF_MS);
    expect(at(20)).toBe(MAX_BACKOFF_MS);
    expect(nextPollDelay({ failures: 9, random: () => 1 })).toBe(Math.round(MAX_BACKOFF_MS * 0.8));
    // A broken random never makes a negative or a NaN wait.
    expect(nextPollDelay({ bookOpen: true, random: () => NaN })).toBe(BOOK_POLL_MS);
    expect(nextPollDelay({ bookOpen: true, random: () => { throw new Error("x"); } })).toBe(BOOK_POLL_MS);
  });

  it("the safety-net reload slows down once revisions are known to work", () => {
    expect(safetyReloadMs(true, () => 0)).toBe(120000);
    expect(safetyReloadMs(false, () => 0)).toBe(75000);
    expect(safetyReloadMs(false, () => 1)).toBe(60000);
  });

  it("the revision verdict: changed, same, or nothing to compare", () => {
    const book = { day: "2026-10-27", rev: "aaaa" };
    expect(bookRevVerdict(book, { book_day: "2026-10-27", book_rev: "aaaa" })).toBe("same");
    expect(bookRevVerdict(book, { book_day: "2026-10-27", book_rev: "bbbb" })).toBe("changed");
    // Another day's answer (the host stepped to tomorrow meanwhile).
    expect(bookRevVerdict(book, { book_day: "2026-10-28", book_rev: "bbbb" })).toBeNull();
    // An older server sends no revision; a book still loading has none.
    expect(bookRevVerdict(book, { server_time: "x", changes: [] })).toBeNull();
    expect(bookRevVerdict({ day: "2026-10-27", rev: null }, { book_day: "2026-10-27", book_rev: "aaaa" })).toBeNull();
    expect(bookRevVerdict(null, { book_day: "2026-10-27", book_rev: "aaaa" })).toBeNull();
    expect(bookRevVerdict(book, null)).toBeNull();
  });

  it("one book on the page: the newest says what is on screen, and only it can leave", () => {
    watchBook("a", "2026-10-27", "r1");
    expect(watchedBook()).toEqual({ day: "2026-10-27", rev: "r1" });
    watchBook("b", "2026-10-28", null);
    unwatchBook("a"); // a stale unmount does not clear the live book
    expect(watchedBook()).toEqual({ day: "2026-10-28", rev: null });
    unwatchBook("b");
    expect(watchedBook()).toBeNull();
  });
});

describe("failures are words, never the server's code", () => {
  const t = (_k, fb) => fb;
  const err = (status, error) => ({ response: { status, data: { detail: error ? { error } : "x" } } });

  it("no answer at all is the network", () => {
    expect(bookFailWords(new Error("Network Error"), t, "fallback")).toMatch(/Couldn't reach BonBox/);
  });

  it("a booking that is gone, a plan, too many tries", () => {
    expect(bookFailWords(err(404, "not_found"), t, "fb")).toMatch(/isn't in the book any more/);
    expect(bookFailWords(err(404, "not_found"), t, "fb", { apptWords: true })).toMatch(/appointment/);
    expect(bookFailWords(err(402), t, "fb")).toMatch(/plan/);
    expect(bookFailWords(err(429), t, "fb")).toMatch(/Too many tries/);
  });

  it("anything else is the caller's own sentence — the code never shows", () => {
    for (const code of ["slot_unavailable", "weird_code", "not_editable", "room_full"]) {
      const words = bookFailWords(err(409, code), t, "Couldn't seat the guests.");
      expect(words).toBe("Couldn't seat the guests.");
      expect(words).not.toContain(code);
    }
    expect(bookFailWords(err(500, "boom"), t, "")).toBe("Action failed. Please try again.");
  });
});

// ── the home-screen icon ─────────────────────────────────────────────

/** Runs index.html's manifest selector against a pretend browser. */
function manifestFor(pathname, { ios }) {
  const html = read(join(FRONTEND, "index.html"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts.find((s) => s.includes("PWA manifest selection"));
  expect(code, "the manifest selector script").toBeTruthy();
  const links = [];
  const mkEl = () => {
    const attrs = {};
    return {
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      get parentNode() {
        return { removeChild: (el) => links.splice(links.indexOf(el), 1) };
      },
    };
  };
  const doc = {
    querySelector: (sel) => (sel === 'link[rel="manifest"]' ? links[0] || null : null),
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    head: { appendChild: (el) => links.push(el) },
  };
  const win = {};
  const nav = ios
    ? { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", maxTouchPoints: 5 }
    : { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120", maxTouchPoints: 5 };
  // eslint-disable-next-line no-new-func
  new Function("window", "location", "navigator", "document", code)(win, { pathname }, nav, doc);
  return { href: links[0] ? links[0].getAttribute("href") : null, win };
}

describe("the paired device's home-screen icon opens its book", () => {
  it("iOS: no manifest on /stand/<token> or /stand, so Add to Home bookmarks that address", () => {
    expect(manifestFor(`/stand/${TOKEN}`, { ios: true }).href).toBeNull();
    expect(manifestFor("/stand", { ios: true }).href).toBeNull();
  });

  it("Android/desktop: the device's own manifest — never the owner app's start_url /", () => {
    expect(manifestFor(`/stand/${TOKEN}`, { ios: false }).href).toBe("/stand-device.webmanifest");
    expect(manifestFor("/stand", { ios: false }).href).toBe("/stand-device.webmanifest");
  });

  it("the owner's pop-out and the owner app are unchanged", () => {
    expect(manifestFor("/reservations/stand", { ios: false }).href).toBe("/stand.webmanifest");
    expect(manifestFor("/reservations/stand", { ios: true }).href).toBeNull();
    expect(manifestFor("/", { ios: false }).href).toBe("/manifest.json");
    expect(manifestFor("/dashboard", { ios: true }).href).toBe("/manifest.json");
  });

  it("the device's manifest starts at /stand (which reopens the remembered book) and carries no token", () => {
    const raw = read(join(PUBLIC, "stand-device.webmanifest"));
    const m = JSON.parse(raw);
    expect(m.start_url).toBe("/stand");
    expect(m.scope).toBe("/stand");
    expect(m.id).toBe("/stand");
    expect(m.display).toBe("standalone");
    expect(m.orientation).toBe("any");
    // Same icons as the stand's manifest: real files, true sizes, one purpose each.
    const pngSize = (p) => {
      const b = readFileSync(p);
      return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
    };
    for (const icon of m.icons) {
      const path = icon.src.split("?")[0];
      expect(existsSync(join(PUBLIC, path)), path).toBe(true);
      expect(pngSize(join(PUBLIC, path))).toBe(icon.sizes);
      expect(["any", "maskable"]).toContain(icon.purpose);
    }
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("is served with the short cache the other manifests get", () => {
    const vercel = JSON.parse(read(join(FRONTEND, "vercel.json")));
    const rule = vercel.headers.find((h) => h.source.includes("stand\\.webmanifest"));
    expect(rule.source).toContain("stand-device\\.webmanifest");
  });
});

describe("every R10 word is real en + da", () => {
  const KEYS = [
    "rsvpBookOffline", "rsvpBookUnavailableTitle", "rsvpBookUnavailableTitleAppt", "rsvpBookUnavailableAuto",
    "rsvpErrNoNet", "rsvpErrGone", "rsvpErrGoneAppt", "rsvpErrPlan", "rsvpErrBusy",
    "rsvpStandGoneTitle", "rsvpStandGoneBody", "rsvpStandGoneBodyAppt", "rsvpStandGoneNewCode",
    "rsvpStandUnpair", "rsvpStandUnpairHint", "rsvpStandUnpairTitle", "rsvpStandUnpairBody",
    "rsvpStandUnpairYes", "rsvpStandUnpairOffline", "standPairReopening",
  ];
  it("each key exists in both, in Danish in da, with the same placeholders", () => {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of KEYS) {
      expect(typeof en[k], k).toBe("string");
      expect(typeof da[k], k).toBe("string");
      expect(da[k], k).not.toBe(en[k]);
      expect(vars(da[k]), k).toEqual(vars(en[k]));
      // The locked brand word stays (check-i18n-locked-terms).
      if (/BonBox/.test(en[k])) expect(da[k], k).toContain("BonBox");
    }
    // The rubric's own words (B5): "viser bogen fra hh:mm".
    expect(da.rsvpBookOffline).toBe("Offline · viser bogen fra {time}");
    // DK lock: a salon's page is Tidsbestilling in Danish, Appointments in English.
    expect(da.rsvpStandGoneBodyAppt).toContain("Tidsbestilling");
    expect(en.rsvpStandGoneBodyAppt).toContain("Appointments");
  });
});
