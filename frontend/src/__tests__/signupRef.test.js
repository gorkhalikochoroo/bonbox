import { describe, it, expect, beforeEach } from "vitest";
import {
  cleanSignupRef, captureSignupRef, getSignupRef, clearSignupRef, withSignupRef,
} from "../utils/signupRef";

// The leave-behind QR's code must survive from the first page load until an
// account exists, and a bad one must simply be ignored.

beforeEach(() => {
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
