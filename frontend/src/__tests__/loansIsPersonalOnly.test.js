/**
 * The loan tracker is a personal-mode surface, and only that.
 *
 * It tracks money lent to and borrowed from individuals — a personal-finance
 * job, not one of the six a Danish café runs its back office on. It has never
 * had a navManifest entry, which is why it was invisible to the sidebar, /more
 * and the More grid. What it DID have was a live route, so a business owner
 * who typed /loans got the whole page — which is how it surfaced on the
 * founder's screen in September.
 *
 * What must stay true, and why each half matters:
 *   • PERSONAL mode keeps it entirely. It is a bottom-nav tab there
 *     (config/personalNav.js) and PersonalPage links to it; redirecting a
 *     personal account away would break a tab that is still on screen.
 *   • A BUSINESS account is redirected, so the URL is not a side door.
 *   • ⌘K does not offer it to a business account either. A search result that
 *     bounces you back to the dashboard is worse than no result.
 *   • It still has no navManifest entry — putting one there would drag it
 *     through the business-shaped pillar/tier/activation axes it opted out of.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NAV_MANIFEST } from "../config/navManifest";
import { PERSONAL_NAV, personalNavFor } from "../config/personalNav";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, "..", "App.jsx"), "utf8");
const SEARCH = readFileSync(join(HERE, "..", "components", "GlobalSearchModal.jsx"), "utf8");

describe("the loan tracker is off the business app", () => {
  it("has no business nav entry", () => {
    expect(NAV_MANIFEST.find((d) => d.to === "/loans")).toBeUndefined();
  });

  it("its route is wrapped in the personal-mode gate", () => {
    // Matched to end of line, not to the first ">" — the element nests, so
    // `[^>]*` would stop inside <PersonalOnly> and never see the page.
    const route = APP.match(/<Route path="\/loans".*$/m);
    expect(route, "the /loans route disappeared — personal mode would 404").toBeTruthy();
    expect(route[0]).toMatch(/<PersonalOnly>/);
    expect(route[0]).toMatch(/LoanTrackerPage/);
  });

  it("the gate sends a business account to the dashboard", () => {
    const gate = APP.slice(APP.indexOf("function PersonalOnly"));
    expect(gate).toMatch(/canUsePersonalMode\(user\)\s*\?\s*children\s*:\s*<Navigate to="\/dashboard" replace \/>/);
  });

  it("⌘K only offers it to an account that can use personal mode", () => {
    const entry = SEARCH.match(/\{[^}]*to: "\/loans"[^}]*\}/);
    expect(entry).toBeTruthy();
    expect(entry[0]).toMatch(/personalOnly:\s*true/);
    expect(SEARCH).toMatch(/!d\.personalOnly \|\| canUsePersonalMode\(user\)/);
  });
});

describe("personal mode keeps it", () => {
  it("it is still a personal sidebar and bottom-nav destination", () => {
    const entry = PERSONAL_NAV.find((d) => d.to === "/loans");
    expect(entry).toBeTruthy();
    expect(entry.surfaces).toContain("sidebar");
    expect(entry.surfaces).toContain("bottomNav");
    expect(personalNavFor("bottomNav").map((d) => d.to)).toContain("/loans");
  });
});
