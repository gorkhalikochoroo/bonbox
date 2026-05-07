/**
 * Direct unit tests for utils/safeUrl.js.
 *
 * Why these matter: safeImageUrl + safeExternalUrl are the LAST line
 * of defense between an untrusted URL and the browser dereferencing
 * it. A typo that lets javascript:/data: through here means an
 * attacker-controlled receipt_photo or external link can run code
 * in our origin. Every dangerous scheme + every safe scheme is
 * pinned explicitly so a "tighten" or "loosen" is a deliberate edit.
 */
import { describe, it, expect } from "vitest";
import { safeImageUrl, safeExternalUrl } from "../utils/safeUrl";


describe("safeImageUrl — dangerous schemes blocked", () => {
  // Each of these has been a real-world XSS vector at some point.
  // If any test here regresses to PASS-as-safe, the receipt-viewer
  // and dashboard receipts row become script-execution surfaces.
  it.each([
    ["javascript: protocol",        "javascript:alert(1)"],
    ["data:text/html",              "data:text/html,<script>alert(1)</script>"],
    ["data:image/svg+xml",          'data:image/svg+xml,<svg onload="alert(1)"/>'],
    ["data:image/png base64",       "data:image/png;base64,iVBORw0KGgo="],
    ["vbscript:",                   "vbscript:msgbox"],
    ["file://",                     "file:///etc/passwd"],
    ["chrome://",                   "chrome://settings"],
    ["about:",                      "about:blank"],
    ["http: (insecure)",            "http://example.com/img.png"],
  ])("rejects %s", (_label, url) => {
    expect(safeImageUrl(url)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(safeImageUrl("")).toBeNull();
  });

  it("rejects null and undefined", () => {
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
  });

  it("rejects non-string types", () => {
    expect(safeImageUrl(42)).toBeNull();
    expect(safeImageUrl({})).toBeNull();
    expect(safeImageUrl([])).toBeNull();
  });

  it("rejects URLs longer than the 4096-char cap", () => {
    // A 5000-char "https://" URL is well-formed by URL.parse but
    // refused by our cap — protects against pathological inputs that
    // could DOS later parsing layers. Even tho parses, MAX_URL_LEN
    // gate fires first.
    const long = "https://example.com/" + "a".repeat(5000);
    expect(safeImageUrl(long)).toBeNull();
  });

  it("rejects malformed URLs that throw in URL constructor", () => {
    expect(safeImageUrl("not a url")).toBeNull();
    expect(safeImageUrl("https://")).toBeNull();
  });
});


describe("safeImageUrl — safe schemes accepted", () => {
  it("accepts https URLs", () => {
    const url = "https://supabase.example/receipts/u1/abc.jpg";
    expect(safeImageUrl(url)).toBe(url);
  });

  it("accepts https with query strings + ports", () => {
    const url = "https://cdn.example:8443/r.jpg?token=xyz&v=2";
    expect(safeImageUrl(url)).toBe(url);
  });

  it("accepts blob: URLs originating from the test window origin", () => {
    // jsdom's default origin is http://localhost. blob:URLs constructed
    // with window.location.origin in the prefix are deemed same-origin.
    const blobUrl = `blob:${window.location.origin}/abc-uuid`;
    expect(safeImageUrl(blobUrl)).toBe(blobUrl);
  });

  it("rejects blob: URLs from a different origin", () => {
    // An attacker controlling a tab on another origin can't smuggle
    // a blob:URL into our DOM that points at their tab's data.
    const crossOriginBlob = "blob:https://attacker.example/abc-uuid";
    expect(safeImageUrl(crossOriginBlob)).toBeNull();
  });
});


describe("safeExternalUrl — outbound link sanitisation", () => {
  it("accepts https only", () => {
    const url = "https://bonbox.dk/subscription";
    expect(safeExternalUrl(url)).toBe(url);
  });

  it("rejects http (no plaintext downgrade)", () => {
    expect(safeExternalUrl("http://example.com")).toBeNull();
  });

  it("rejects javascript: even when it looks like a URL", () => {
    expect(safeExternalUrl("javascript:void(0)")).toBeNull();
  });

  it("rejects empty + null + non-string inputs", () => {
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(123)).toBeNull();
  });
});
