/**
 * Android parity (11 Nov 2026): the pure helpers behind "Tilføj til
 * kalender" and the branch map link.
 *
 *   • scheduleFeedUrl / webcalUrl — the same feed the iPhone subscribes to.
 *   • googleSubscribeUrl — Google Calendar's add-by-URL page; the feed sits in
 *     ONE cid parameter, fully encoded, so a PIN link's ?k= survives.
 *   • copyText — the clipboard, with a read-only textarea fallback.
 *   • placeSearchUrl / isAndroidDevice — Google Maps on Android, Apple Maps
 *     elsewhere, exactly as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleFeedUrl, webcalUrl, googleSubscribeUrl } from "../utils/calendarFeed";
import { copyText } from "../utils/clipboard";
import { placeSearchUrl, isAndroidDevice } from "../utils/routeUrl";

const PIXEL = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

describe("the feed URL", () => {
  it("is the API's schedule.ics for the token, with ?k= only on a PIN link", () => {
    expect(scheduleFeedUrl("https://api.bonbox.dk/api/", "TOK")).toBe("https://api.bonbox.dk/api/portal/TOK/schedule.ics");
    expect(scheduleFeedUrl("https://api.bonbox.dk/api", "TOK", "a b")).toBe("https://api.bonbox.dk/api/portal/TOK/schedule.ics?k=a%20b");
    expect(scheduleFeedUrl("", "TOK")).toBe("https://api.bonbox.dk/api/portal/TOK/schedule.ics");
    expect(scheduleFeedUrl(undefined, "TOK")).toBe("https://api.bonbox.dk/api/portal/TOK/schedule.ics");
  });

  it("webcal: replaces http: and https:", () => {
    expect(webcalUrl("https://api.bonbox.dk/api/portal/T/schedule.ics")).toBe("webcal://api.bonbox.dk/api/portal/T/schedule.ics");
    expect(webcalUrl("http://127.0.0.1:8101/api/portal/T/schedule.ics")).toBe("webcal://127.0.0.1:8101/api/portal/T/schedule.ics");
  });

  it("Google's add-by-URL page carries the webcal feed in ONE cid parameter, ?k= intact", () => {
    const g = googleSubscribeUrl("https://api.bonbox.dk/api/portal/TOK/schedule.ics?k=abc");
    expect(g.startsWith("https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2F")).toBe(true);
    const params = new URL(g).searchParams;
    expect([...params.keys()]).toEqual(["cid"]);
    expect(params.get("cid")).toBe("webcal://api.bonbox.dk/api/portal/TOK/schedule.ics?k=abc");
  });
});

describe("copyText", () => {
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const realExec = document.execCommand;
  afterEach(() => {
    if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
    else delete navigator.clipboard;
    document.execCommand = realExec;
  });
  const setClipboard = (value) => Object.defineProperty(navigator, "clipboard", { configurable: true, value });

  it("uses the Clipboard API when it works, and nothing else", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    document.execCommand = vi.fn(() => true);
    expect(await copyText("x")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("x");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("a refused Clipboard API falls back to a read-only textarea that is removed again", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new Error("NotAllowedError"))) });
    let seen = null;
    document.execCommand = vi.fn((cmd) => {
      const ta = document.querySelector("textarea");
      seen = { cmd, value: ta?.value, readonly: ta?.hasAttribute("readonly") };
      return true;
    });
    expect(await copyText("https://feed")).toBe(true);
    expect(seen).toEqual({ cmd: "copy", value: "https://feed", readonly: true });
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("no Clipboard API at all: the textarea path", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    expect(await copyText("y")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("both fail: false, never a throw", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new Error("no"))) });
    document.execCommand = vi.fn(() => false);
    expect(await copyText("z")).toBe(false);
    document.execCommand = vi.fn(() => { throw new Error("boom"); });
    expect(await copyText("z")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("the branch map link", () => {
  const place = { name: "Hovedafdeling", address: "Vesterbrogade 1" };

  it("Apple Maps on iPhone and the desktop, Google Maps on Android", () => {
    expect(placeSearchUrl(place, "apple")).toBe("https://maps.apple.com/?q=Hovedafdeling%2C%20Vesterbrogade%201");
    expect(placeSearchUrl(place, "geo")).toBe("https://www.google.com/maps/search/?api=1&query=Hovedafdeling%2C%20Vesterbrogade%201");
    // The desktop keeps the Apple link it always had (only Android changed).
    expect(placeSearchUrl(place, "google")).toBe("https://maps.apple.com/?q=Hovedafdeling%2C%20Vesterbrogade%201");
  });

  it("a name alone works; nothing to search for is null", () => {
    expect(placeSearchUrl({ name: "Café Øst" }, "geo")).toBe("https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20%C3%98st");
    expect(placeSearchUrl({}, "geo")).toBeNull();
    expect(placeSearchUrl(undefined, "apple")).toBeNull();
  });

  it("isAndroidDevice reads an Android browser, not an iPhone or a PC", () => {
    expect(isAndroidDevice(PIXEL)).toBe(true);
    expect(isAndroidDevice(IPHONE)).toBe(false);
    expect(isAndroidDevice(WINDOWS)).toBe(false);
  });
});
