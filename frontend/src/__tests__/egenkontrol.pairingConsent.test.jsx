/**
 * Egenkontrol R1a — device-pass fixes 3 and 5 (the lead's iPad run, 12 Nov):
 *
 *  3. /stand is where BOTH paired devices type their code — the door screen
 *     and, since R1a, the kitchen iPad. It said "Enheden viser kun
 *     reservationer", which is false on a kitchen iPad. It now says what is
 *     true for both: "Enheden viser kun det, ejeren har valgt — aldrig
 *     regnskab eller løn." (da + en, and the inline fallback the door build
 *     shows before its dictionary arrives).
 *  5. No cookie banner on /kitchen: like the door screen (whose build carries
 *     no banner at all), the paired kitchen iPad keeps only strictly-necessary
 *     storage; with no answer every optional category stays off. Any other
 *     route still asks.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.pairingConsent
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";

const h = vi.hoisted(() => ({ mode: "dict" }));

vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return {
    useLanguage: () => ({
      lang: "da",
      // "fallback": the door build before its dictionary has arrived.
      t: (k, fb) => (h.mode === "fallback" && typeof fb === "string" ? fb : DA[k] ?? (typeof fb === "string" ? fb : k)),
    }),
  };
});
vi.mock("../services/api", () => ({ default: { post: vi.fn(), get: vi.fn() } }));

const CookieConsent = (await import("../components/CookieConsent")).default;
const { getCookieConsent } = await import("../components/CookieConsent");
const { isPairedDevicePath } = await import("../lib/pairedDevice");
const StandPairPage = (await import("../pages/StandPairPage")).default;

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

beforeEach(() => {
  h.mode = "dict";
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe("3 — the pairing page is honest for a door screen AND a kitchen iPad", () => {
  it("da / en / tr no longer promise 'reservations only'; they say 'only what the owner chose'", () => {
    expect(da.standPairBody).toBe("Indtast koden fra ejeren. Enheden viser kun det, ejeren har valgt — aldrig regnskab eller løn.");
    expect(en.standPairBody).toBe("Enter the code from the owner. This device only shows what the owner chose — never accounts or wages.");
    expect(da.standPairBody).not.toMatch(/reservation/i);
    expect(en.standPairBody).not.toMatch(/reservation/i);
    expect(tr.standPairBody).not.toMatch(/rezervasyon/i);
  });

  it("the page shows it — from the dictionary, and from its own fallback before the dictionary arrives", () => {
    render(<MemoryRouter initialEntries={["/stand"]}><StandPairPage /></MemoryRouter>);
    expect(screen.getByText(da.standPairBody)).toBeInTheDocument();
    cleanup();
    h.mode = "fallback";
    render(<MemoryRouter initialEntries={["/stand"]}><StandPairPage /></MemoryRouter>);
    // The inline fallback is the Danish text, word for word (never a stale copy).
    expect(screen.getByText(da.standPairBody)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("kun reservationer");
  });

  it("the pairing page still imports no kitchen code (it is in the door build)", () => {
    const src = readFileSync(join(SRC, "pages", "StandPairPage.jsx"), "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*(egenkontrol|KitchenPage|kitchenApi)/);
  });
});

async function bannerAt(pathname) {
  vi.useFakeTimers();
  render(<MemoryRouter initialEntries={[pathname]}><CookieConsent /></MemoryRouter>);
  await act(async () => { vi.advanceTimersByTime(700); });
  vi.useRealTimers();
  return document.querySelector('[data-cookie-consent="banner"]');
}

describe("5 — no cookie banner on the paired kitchen iPad", () => {
  it.each(["/kitchen/kt_ABCdef123456", "/kitchen"])("%s: no banner, and nothing optional is on", async (path) => {
    expect(await bannerAt(path)).toBeNull();
    // No answer was saved for the device: analytics and marketing stay off.
    expect(getCookieConsent()).toBeNull();
    expect(localStorage.getItem("bonbox_cookie_consent")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--bb-consent-h")).toBe("");
  });

  it("any other route still asks (the owner app, the landing)", async () => {
    expect(await bannerAt("/dashboard")).not.toBeNull();
    cleanup();
    expect(await bannerAt("/egenkontrol")).not.toBeNull();
  });

  it("only /kitchen and /kitchen/<token> count as the paired kitchen device", () => {
    for (const p of ["/kitchen", "/kitchen/", "/kitchen/kt_ABCdef123456"]) expect(isPairedDevicePath(p), p).toBe(true);
    for (const p of ["/kitchenware", "/egenkontrol", "/", "/r/cafe-sol", "", null, undefined]) expect(isPairedDevicePath(p), String(p)).toBe(false);
  });
});
