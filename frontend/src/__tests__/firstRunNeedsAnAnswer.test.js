/**
 * A first-run card may not be drawn from a fetch that failed.
 *
 * These cards make a specific, actionable claim about the owner's OWN setup —
 * "you have no tables yet, here is where to add them". That claim is only
 * honest if we actually asked and got an answer.
 *
 * fetchResources did `catch { setResources([]) }` and then set
 * `resourcesLoaded` in a `finally`, so a dropped connection was indistinguish-
 * able from a venue with nothing set up. A restaurant with twenty tables that
 * lost wifi got the red "couldn't load the reservation book" banner AND,
 * directly beneath it, "No tables set up yet — guests can't book online until
 * there's a table to seat them at", with a CTA.
 *
 * It is the same defect the three-state fetch work removed from nine list
 * screens, reappearing one empty state over, inside a change whose whole
 * purpose was to stop an empty book making a promise it could not keep. That
 * is why it gets a guard rather than just a fix.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "pages", "ReservationsPage.jsx"), "utf8");

const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

describe("a first-run card requires a real answer, not a silent failure", () => {
  it("the resources fetch records that it failed", () => {
    expect(CODE).toMatch(/setResourcesFailed\(true\)/);
    // …and clears it when a later attempt succeeds, or the card never returns.
    expect(CODE).toMatch(/setResourcesFailed\(false\)/);
  });

  it("the no-tables card is gated on it", () => {
    const start = CODE.indexOf("const noTablesYet");
    expect(start).toBeGreaterThan(-1);
    const guard = CODE.slice(start, CODE.indexOf(";", start));
    expect(guard).toMatch(/!resourcesFailed/);
    expect(guard).toMatch(/resourcesLoaded/);
  });

  it("the salon first-run card is gated on it too", () => {
    const start = CODE.indexOf("const salonFirstRun");
    expect(start).toBeGreaterThan(-1);
    const guard = CODE.slice(start, CODE.indexOf(";", start));
    expect(guard).toMatch(/!resourcesFailed/);
  });

  it("`resourcesLoaded` alone never gates a setup claim", () => {
    // The trap: `resourcesLoaded` is set in a finally, so it is true after a
    // failure too. Anything asserting "you have none" must ask the other flag.
    for (const name of ["noTablesYet", "salonFirstRun"]) {
      const start = CODE.indexOf(`const ${name}`);
      const guard = CODE.slice(start, CODE.indexOf(";", start));
      expect(
        guard.includes("!resourcesFailed"),
        `${name} is derived from resourcesLoaded, which a failed fetch also sets.`,
      ).toBe(true);
    }
  });
});
