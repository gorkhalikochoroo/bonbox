/**
 * CSP guard — the booking page embeds on owners' sites, and the owner app
 * previews it, while every other page stays unframeable.
 *
 * Vite's dev server ships no CSP, so none of this is visible locally: a
 * wrong directive only shows up in production, as a blank box on the owner's
 * website or a blank preview in Reservationer. So the guard reads the
 * deployed config (vercel.json), like csp.mediaSrc.test.js.
 *
 *   • /r/<slug> (the route every iframe snippet loads) may be framed by any
 *     https site — and that rule must come AFTER the site-wide one, because
 *     for the same header key the later matching rule wins.
 *   • Everything else keeps frame-ancestors 'none' (clickjacking).
 *   • The app may frame its own origin, so "Sådan ser den ud på en telefon"
 *     can show the real /r/ page — and only that page agrees to be framed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(resolve(here, "../../vercel.json"), "utf8"));

const rules = vercel.headers || [];
const cspOf = (source) => {
  const rule = rules.find((r) => r.source === source);
  return rule?.headers?.find((h) => h.key === "Content-Security-Policy")?.value ?? null;
};
const directive = (csp, name) =>
  (csp || "")
    .split(";")
    .map((s) => s.trim())
    .find((d) => d === name || d.startsWith(name + " ")) ?? null;

describe("CSP for the booking embed", () => {
  const app = cspOf("/(.*)");
  const booking = cspOf("/r/(.*)");

  it("ships both policies", () => {
    expect(app).toBeTruthy();
    expect(booking).toBeTruthy();
  });

  it("lets any https site frame the /r/ booking page", () => {
    expect(directive(booking, "frame-ancestors")).toBe("frame-ancestors https:");
  });

  it("keeps every other page unframeable", () => {
    expect(directive(app, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("lists the /r/ rule after the site-wide rule, so it wins", () => {
    const appIdx = rules.findIndex((r) => r.source === "/(.*)");
    const bookingIdx = rules.findIndex((r) => r.source === "/r/(.*)");
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(bookingIdx).toBeGreaterThan(appIdx);
  });

  it("lets the owner app frame its own origin for the live preview", () => {
    const fs = directive(app, "frame-src");
    expect(fs).not.toBeNull();
    expect(fs.split(/\s+/)).toContain("'self'");
    // The checkout and sign-in frames it already needed are still allowed.
    expect(fs).toContain("https://js.stripe.com");
    expect(fs).toContain("https://accounts.google.com");
  });
});
