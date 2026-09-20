/**
 * Khata has no way in.
 *
 * The customer credit ledger is a South-Asian retail convention — a Danish
 * café does not run a khata — and it left the sidebar, More and ⌘K in June
 * 2026 via `surfaces: []` on its manifest entry.
 *
 * That was only ever half a door. The route stayed registered, so a bookmark,
 * a typed URL or an agent navigating by path rendered the whole page, header
 * CTA and all. That is exactly how it reappeared in September, on the founder's
 * own screen, months after it was "hidden".
 *
 * Both halves are pinned here, because either one alone lets it back:
 * the manifest must keep it off every surface, and the route must not mount
 * the page.
 *
 * Reversing this is deliberate and two-sided: put the surfaces back on the
 * manifest entry AND the route back in App.jsx. Nothing about the page, its
 * API or any existing row is touched by either half.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NAV_MANIFEST } from "../config/navManifest";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, "..", "App.jsx"), "utf8");

describe("the khata ledger is off every surface", () => {
  it("its manifest entry still exists, so the feature is paused and not deleted", () => {
    const khata = NAV_MANIFEST.find((d) => d.to === "/khata");
    expect(khata).toBeTruthy();
  });

  it("it is on no surface at all", () => {
    const khata = NAV_MANIFEST.find((d) => d.to === "/khata");
    expect(khata.surfaces).toEqual([]);
  });
});

describe("the khata route does not render the page", () => {
  it("/khata redirects instead of mounting KhataPage", () => {
    const route = APP.match(/<Route path="\/khata"[^>]*\/>/);
    expect(route, "the /khata route disappeared entirely — a bookmark now 404s").toBeTruthy();
    expect(route[0]).toMatch(/<Navigate\s+to="\/dashboard"\s+replace\s*\/>/);
    expect(route[0]).not.toMatch(/KhataPage/);
  });

  it("KhataPage is not imported, so it leaves the bundle too", () => {
    expect(APP).not.toMatch(/lazyRetry\(\(\) => import\("\.\/pages\/KhataPage"\)\)/);
  });
});
