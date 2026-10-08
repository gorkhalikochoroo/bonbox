import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cleanSignupRef, captureSignupRef, getSignupRef, clearSignupRef, withSignupRef,
  onCookieConsentChanged,
} from "../utils/signupRef";

// The leave-behind QR's code must survive from the first page load until an
// account exists, and a bad one must simply be ignored. It touches the
// device (local storage) only with the cookie banner's Analytics consent.

const KEY = "bonbox_signup_ref";
const consent = (analytics) =>
  localStorage.setItem(
    "bonbox_cookie_consent",
    JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      choices: { necessary: true, functional: false, analytics, marketing: false },
    }),
  );

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
    consent(true); // even with Analytics consent nothing reaches the device
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

  it("with Analytics consent it is kept on the device for the next page load", async () => {
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
    onCookieConsentChanged({ necessary: true, analytics: true });
    expect(JSON.parse(localStorage.getItem(KEY)).ref).toBe("r1-a-03");

    consent(false);
    onCookieConsentChanged({ necessary: true, analytics: false });
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
    window.dispatchEvent(new CustomEvent("bonbox-cookie-consent-changed", { detail: { analytics: true } }));
    expect(JSON.parse(localStorage.getItem(KEY)).ref).toBe("r2-b-04");
    consent(false);
    window.dispatchEvent(new CustomEvent("bonbox-cookie-consent-changed", { detail: { analytics: false } }));
    expect(localStorage.getItem(KEY)).toBeNull();
    fresh.clearSignupRef();
  });
});
