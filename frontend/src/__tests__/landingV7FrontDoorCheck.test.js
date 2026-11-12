// @vitest-environment node
/**
 * Landing v7 review (12 Nov 2026), the one MUST: after a deploy, check that the live "/" really is the landing's own
 * document. It is only when Vercel's build ran with VERCEL=1 (vite.config.js landingDocument); without it "/" quietly
 * gets index.html: the page works, the phone speed fix is not live. The release health check
 * (scripts/prod-healthcheck.mjs) now says so, through scripts/lib/frontDoor.mjs.
 *
 * Pins: the marker the check looks for is the one the build writes (landingDocumentV7) and that no other document has;
 * three outcomes (the landing document / not / couldn't check), never a quiet pass; the health check calls it on what
 * "/" and /login answered and reports a WARN (the page still works), not BROKEN.
 * The health check itself is only read as text here: importing it would run it against the live site.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { landingDocumentV7 } from "../../scripts/landingFirstScreenV7.mjs";
import { FRONT_DOOR_MARKER, FRONT_DOOR_OTHER, frontDoorFindings } from "../../scripts/lib/frontDoor.mjs";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERCEL = JSON.parse(fs.readFileSync(path.join(FRONTEND, "vercel.json"), "utf8"));
const INDEX = '<!doctype html><html><head><style id="lp6-css">.lp7{}</style></head><body><div id="root"></div></body></html>';
const LANDING = landingDocumentV7(INDEX, ".x{}");

describe("the live front-door check (prod-healthcheck)", () => {
  it("looks for the marker the build writes into landing.html, which index.html / app.html never carry", () => {
    expect(LANDING.split(FRONT_DOOR_MARKER)).toHaveLength(2);
    expect(INDEX).not.toContain(FRONT_DOOR_MARKER);
    // the address it compares against is one vercel.json sends to app.html, not to the landing
    expect(VERCEL.rewrites.filter((r) => r.destination === "/landing.html").map((r) => r.source)).not.toContain(FRONT_DOOR_OTHER);
    expect(fs.readFileSync(path.join(FRONTEND, "src/App.jsx"), "utf8")).toContain(`path="${FRONT_DOOR_OTHER}"`);
  });

  it("the landing document at \"/\" and the app document at /login: no warning", () => {
    const { warnings, notes } = frontDoorFindings(LANDING, INDEX);
    expect(warnings).toEqual([]);
    expect(notes.join(" ")).toMatch(/"\/" is the landing document/);
  });

  it("index.html at \"/\" (a Vercel build without VERCEL=1): a warning that names the cause", () => {
    const { warnings, notes } = frontDoorFindings(INDEX, INDEX);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/phone hero picture is not live/);
    expect(warnings[0]).toMatch(/VERCEL=1/);
    expect(notes.join(" ")).toMatch(/"\/" is NOT the landing document/);
  });

  it("the hero at another address is a warning; an address it could not read is \"not checked\", never a pass", () => {
    expect(frontDoorFindings(LANDING, LANDING).warnings.join(" ")).toMatch(/\/login carries lp7-hero/);
    for (const unread of [null, undefined]) {
      const { warnings, notes } = frontDoorFindings(LANDING, unread);
      expect(warnings.join(" ")).toMatch(/could not read \/login.*not checked/);
      expect(notes.join(" ")).not.toMatch(/gets the app document/);
    }
    // nothing read at "/" is not the landing document either
    expect(frontDoorFindings(undefined, INDEX).warnings.join(" ")).toMatch(/not live/);
  });

  it("prod-healthcheck runs it on what \"/\" and /login answered, as WARN lines (the page still works), not BROKEN", () => {
    const src = fs.readFileSync(path.join(FRONTEND, "scripts/prod-healthcheck.mjs"), "utf8");
    expect(src).toContain('import { FRONT_DOOR_OTHER, frontDoorFindings } from "./lib/frontDoor.mjs";');
    expect(src).toContain("await get(BASE + FRONT_DOOR_OTHER)");
    expect(src).toContain("const door = frontDoorFindings(idx.body, other);");
    expect(src).toContain("warnings.push(...door.warnings);");
    expect(src).not.toMatch(/errors\.push\(\.\.\.door/);
  });
});
