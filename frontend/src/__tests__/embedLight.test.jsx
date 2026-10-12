/**
 * The embedded booking widget is ALWAYS light (QA, 12 Oct 2026).
 *
 * The "Sådan ser den ud på en telefon" preview frames /r/<slug>?embed=1 on the
 * BonBox origin, so it read the owner's stored theme: an owner in dark mode
 * saw a DARK booking form, while the guests on their website got a light one.
 * The same leak hits a guest who once picked dark on bonbox.dk — their stored
 * theme darkened the form inside a light restaurant site.
 *
 * Pinned here, both halves:
 *   1. index.html's pre-paint skips the dark class for ?embed=1 on a non-paper
 *      route — and leaves the stored choice alone (the app stays dark);
 *   2. the page itself holds <html> out of dark while it is mounted embedded,
 *      and gives it back on unmount. Without ?embed=1 nothing changes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn() },
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn() }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { forceLightTheme } = await import("../utils/themeColor");

const html = () => document.documentElement;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const runPrePaint = () => {
  const page = readFileSync(join(ROOT, "index.html"), "utf8");
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((x) => x.includes('localStorage.getItem("theme")'));
  new Function(script)();
};

afterEach(() => {
  cleanup();
  html().classList.remove("dark", "bb-page-white");
  window.history.pushState({}, "", "/");
  localStorage.clear();
});

describe("1. the pre-paint (cold load of the frame)", () => {
  it.each([
    ["/r/cafe?embed=1", false],
    ["/r/cafe/?embed=1", false],
    ["/r/cafe?d=2026-10-20&embed=1", false],
    ["/cafe-nordlys?embed=1", false], // the vanity form of the booking page
    ["/r/cafe", true], // the page opened on its own still follows the theme
    ["/r/cafe?embed=0", true],
    ["/r/cafe?embed=10", true],
    ["/dashboard?embed=1", true], // the owner app is never affected
  ])("stored dark on %s → dark class: %s", (url, dark) => {
    localStorage.setItem("theme", "dark");
    window.history.pushState({}, "", url);
    runPrePaint();
    expect(html().classList.contains("dark")).toBe(dark);
    // the owner's (or guest's) choice is skipped, never rewritten
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("light stays light in the frame (and is normalised as before)", () => {
    window.history.pushState({}, "", "/r/cafe?embed=1");
    runPrePaint();
    expect(html().classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });
});

describe("2. the page holds it light while embedded", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockRejectedValue({ response: { status: 410 } }); // the closed screen: no backend needed
    localStorage.setItem("lang", "da");
    localStorage.setItem("theme", "dark");
  });

  const mount = (url) =>
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/r/:slug" element={<ReservationPublicPage />} />
          </Routes>
        </MemoryRouter>
      </LanguageProvider>,
    );

  it("?embed=1 drops the dark class on mount and gives it back on unmount", async () => {
    html().classList.add("dark"); // what the app shell / pre-paint left behind
    const { unmount } = mount("/r/test-venue?embed=1");
    await waitFor(() => expect(document.querySelector("h1")).toBeTruthy());
    expect(html().classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("dark");
    unmount();
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("without ?embed=1 the page follows the stored theme, as before", async () => {
    html().classList.add("dark");
    mount("/r/test-venue");
    await waitFor(() => expect(document.querySelector("h1")).toBeTruthy());
    expect(html().classList.contains("dark")).toBe(true);
  });
});

describe("forceLightTheme", () => {
  it("never adds dark back if it was not there", () => {
    const undo = forceLightTheme();
    expect(html().classList.contains("dark")).toBe(false);
    undo();
    expect(html().classList.contains("dark")).toBe(false);
  });
});
