import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cleanSignupRef, captureSignupRef, getSignupRef, clearSignupRef, withSignupRef,
  onCookieConsentChanged, FLYER_TEXT_SINCE, FLYER_MARKETING_TEXT,
} from "../utils/signupRef";

// The leave-behind QR's code must survive from the first page load until an
// account exists, and a bad one must simply be ignored. It touches the
// device (local storage) only with the cookie banner's Marketing consent —
// the category that says it measures which channels bring people — given
// to the text that names the flyer code (the banner stamps which Marketing
// text an answer was given to: MARKETING_TEXT in CookieConsent.jsx).

const KEY = "bonbox_signup_ref";
const DAY = 24 * 60 * 60 * 1000;
// What this release's banner saves. Pass marketingText null for an answer
// saved by the banner production showed before it (no stamp).
const record = (choices, timestamp = new Date().toISOString(), marketingText = FLYER_MARKETING_TEXT) =>
  localStorage.setItem(
    "bonbox_cookie_consent",
    JSON.stringify({
      version: 1,
      ...(marketingText === null ? {} : { marketingText }),
      timestamp,
      choices: { necessary: true, functional: false, analytics: false, marketing: false, ...choices },
    }),
  );
const consent = (marketing) => record({ marketing });

beforeEach(() => {
  clearSignupRef(); // this page load's memory
  localStorage.clear();
});

describe("signup ref", () => {
  it("keeps a valid code from the URL and sends it with the next auth body", () => {
    expect(captureSignupRef("?ref=r1-a-03")).toBe("r1-a-03");
    expect(getSignupRef()).toBe("r1-a-03");
    expect(withSignupRef({ email: "x" })).toEqual({ email: "x", signup_ref: "r1-a-03" });
  });

  it("ignores anything outside [a-z0-9-]{1,24}", () => {
    for (const bad of ["", "R1-A-03", "r1_a_03", "a".repeat(25), "<b>", "jens@cafe.dk", "r1 a 03"]) {
      expect(cleanSignupRef(bad)).toBeNull();
      expect(captureSignupRef(`?ref=${encodeURIComponent(bad)}`)).toBeNull();
    }
    expect(cleanSignupRef(42)).toBeNull();
    expect(getSignupRef()).toBeNull();
    expect(withSignupRef({ a: 1 })).toEqual({ a: 1 });
  });

  it("keeps only fieldwork codes (the backend's _FIELDWORK_RE) and test-NN", () => {
    for (const good of ["r1-a-03", "r2-b-01", "r12-z-999", "r1-a-1", "test-01", "test-99"]) {
      clearSignupRef();
      expect(cleanSignupRef(good)).toBe(good);
      expect(captureSignupRef(`?ref=${good}`)).toBe(good);
      expect(withSignupRef({ a: 1 })).toEqual({ a: 1, signup_ref: good });
    }
  });

  it("ignores any other ?ref= — not kept, not stored, not sent", () => {
    consent(true); // even with Marketing consent nothing reaches the device
    const others = [
      "producthunt", "newsletter", "flyer-01", "abc", "r1-a", "r1-a-", "r1a03", "r123-a-01",
      "r1-ab-01", "r1-a-1000", "r-a-01", "test", "test-1", "test-001", "test-ab", "x-r1-a-03",
      "r1-a-03-x", "other",
    ];
    for (const bad of others) {
      expect(cleanSignupRef(bad)).toBeNull();
      expect(captureSignupRef(`?ref=${bad}`)).toBeNull();
      expect(getSignupRef()).toBeNull();
      expect(withSignupRef({ a: 1 })).toEqual({ a: 1 });
      expect(localStorage.getItem(KEY)).toBeNull();
    }
  });

  it("a non-fieldwork ref does not block a later flyer code", () => {
    expect(captureSignupRef("?ref=producthunt")).toBeNull();
    expect(captureSignupRef("?ref=r1-a-03")).toBe("r1-a-03");
    expect(getSignupRef()).toBe("r1-a-03");
  });

  it("a non-fieldwork value already on the device is dropped, not sent", async () => {
    consent(true);
    localStorage.setItem(KEY, JSON.stringify({ ref: "newsletter", at: Date.now() }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.getSignupRef()).toBeNull();
    expect(fresh.withSignupRef({ a: 1 })).toEqual({ a: 1 });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("first code wins while it is fresh", () => {
    captureSignupRef("?ref=r1-a-03");
    captureSignupRef("?ref=r2-b-01");
    expect(getSignupRef()).toBe("r1-a-03");
  });

  it("expires after 30 days, then a new code can be kept", () => {
    const t0 = Date.now();
    captureSignupRef("?ref=r1-a-03", t0);
    const later = t0 + 31 * 24 * 60 * 60 * 1000;
    expect(getSignupRef(later)).toBeNull();
    expect(captureSignupRef("?ref=r2-b-01", later)).toBe("r2-b-01");
  });

  it("is forgotten once the account exists", () => {
    captureSignupRef("?ref=r1-a-03");
    clearSignupRef();
    expect(getSignupRef()).toBeNull();
  });

  it("a URL without ref leaves a kept code alone", () => {
    captureSignupRef("?ref=r1-a-03");
    expect(captureSignupRef("?utm_source=x")).toBeNull();
    expect(getSignupRef()).toBe("r1-a-03");
  });
});

describe("signup ref and the cookie banner (ePrivacy Art. 5(3))", () => {
  it("before any answer, or after a decline, it is held in memory only", () => {
    expect(captureSignupRef("?ref=r1-a-03")).toBe("r1-a-03");
    expect(getSignupRef()).toBe("r1-a-03");
    expect(withSignupRef({ token: "t" })).toEqual({ token: "t", signup_ref: "r1-a-03" });
    expect(localStorage.getItem(KEY)).toBeNull();

    clearSignupRef();
    consent(false);
    expect(captureSignupRef("?ref=r2-b-01")).toBe("r2-b-01");
    expect(getSignupRef()).toBe("r2-b-01");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("with Marketing consent it is kept on the device for the next page load", async () => {
    consent(true);
    captureSignupRef("?ref=r1-a-03");
    expect(JSON.parse(localStorage.getItem(KEY)).ref).toBe("r1-a-03");

    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.getSignupRef()).toBe("r1-a-03");
    fresh.clearSignupRef();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("without consent a copy on the device is neither read nor kept", async () => {
    localStorage.setItem(KEY, JSON.stringify({ ref: "r1-a-03", at: Date.now() }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.getSignupRef()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("consent given after the QR opened writes it; withdrawing removes it", () => {
    captureSignupRef("?ref=r1-a-03");
    expect(localStorage.getItem(KEY)).toBeNull();

    consent(true);
    onCookieConsentChanged({ necessary: true, marketing: true });
    expect(JSON.parse(localStorage.getItem(KEY)).ref).toBe("r1-a-03");

    consent(false);
    onCookieConsentChanged({ necessary: true, marketing: false });
    expect(localStorage.getItem(KEY)).toBeNull();
    // This page load can still send it — nothing is on the device.
    expect(getSignupRef()).toBe("r1-a-03");
  });

  it("follows the banner's own event", async () => {
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    fresh.watchCookieConsentForSignupRef();
    fresh.captureSignupRef("?ref=r2-b-04");
    consent(true);
    window.dispatchEvent(new CustomEvent("bonbox-cookie-consent-changed", { detail: { marketing: true } }));
    expect(JSON.parse(localStorage.getItem(KEY)).ref).toBe("r2-b-04");
    consent(false);
    window.dispatchEvent(new CustomEvent("bonbox-cookie-consent-changed", { detail: { marketing: false } }));
    expect(localStorage.getItem(KEY)).toBeNull();
    fresh.clearSignupRef();
  });
});

describe("signup ref — Marketing, not Analytics, is the switch", () => {
  it("Analytics on and Marketing off: the code never reaches the device", async () => {
    record({ analytics: true, marketing: false });
    expect(captureSignupRef("?ref=r1-a-03")).toBe("r1-a-03");
    expect(localStorage.getItem(KEY)).toBeNull();
    onCookieConsentChanged({ necessary: true, analytics: true, marketing: false });
    expect(localStorage.getItem(KEY)).toBeNull();

    localStorage.setItem(KEY, JSON.stringify({ ref: "r2-b-01", at: Date.now() }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.getSignupRef()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a Marketing yes given before the banner named the flyer code does not count", async () => {
    const before = new Date(FLYER_TEXT_SINCE - 60 * 1000).toISOString();
    record({ analytics: true, marketing: true }, before);
    expect(captureSignupRef("?ref=r1-a-03")).toBe("r1-a-03"); // memory still works
    expect(localStorage.getItem(KEY)).toBeNull();

    localStorage.setItem(KEY, JSON.stringify({ ref: "r1-a-03", at: Date.now() }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.getSignupRef()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a Marketing yes given on the day the text changed counts", () => {
    record({ marketing: true }, new Date(FLYER_TEXT_SINCE).toISOString());
    captureSignupRef("?ref=r1-a-03");
    expect(JSON.parse(localStorage.getItem(KEY)).ref).toBe("r1-a-03");
  });

  // 8 Oct review: production showed the OLD Marketing text ("Lets us measure
  // which channels…", no flyer code) all of 8 Oct, until this release goes
  // live. A yes given there carries no text stamp and must not count, however
  // recent its timestamp.
  it("a Marketing yes saved by the earlier banner (no text stamp) does not count, even on 8 Oct", async () => {
    const onTheDay = new Date(FLYER_TEXT_SINCE + 6 * 60 * 60 * 1000).toISOString();
    record({ analytics: true, marketing: true }, onTheDay, null);
    expect(captureSignupRef("?ref=r1-a-03")).toBe("r1-a-03"); // memory still works
    expect(localStorage.getItem(KEY)).toBeNull();

    // A copy held under such an answer is dropped on the next load.
    localStorage.setItem(KEY, JSON.stringify({ ref: "r1-a-03", at: Date.now() }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.getSignupRef()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("an answer stamped with an older Marketing text does not count", () => {
    record({ marketing: true }, new Date().toISOString(), FLYER_MARKETING_TEXT - 1);
    captureSignupRef("?ref=r1-a-03");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("signup ref — '30 days' is a deletion, on any page load", () => {
  it("an expired copy is removed by a load without ?ref= (same page)", () => {
    const t0 = Date.now();
    consent(true);
    captureSignupRef("?ref=r1-a-03", t0);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(captureSignupRef("", t0 + 31 * DAY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("an expired copy is removed by a later page load without ?ref=", async () => {
    consent(true);
    localStorage.setItem(KEY, JSON.stringify({ ref: "r1-a-03", at: Date.now() - 31 * DAY }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.captureSignupRef("?utm_source=x")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a fresh copy with consent is left alone by a load without ?ref=", async () => {
    consent(true);
    localStorage.setItem(KEY, JSON.stringify({ ref: "r1-a-03", at: Date.now() - 2 * DAY }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.captureSignupRef("")).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY)).ref).toBe("r1-a-03");
    expect(fresh.getSignupRef()).toBe("r1-a-03");
  });

  it("a copy held without consent (withdrawn in another tab) is removed on the next load", async () => {
    consent(false);
    localStorage.setItem(KEY, JSON.stringify({ ref: "r1-a-03", at: Date.now() }));
    vi.resetModules();
    const fresh = await import("../utils/signupRef");
    expect(fresh.captureSignupRef("")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
