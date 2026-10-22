/**
 * lib/planLimits.js is the display mirror of backend/app/services/billing.py PLAN_CAPS (landing v6 port, step 5/6).
 * The landing's Gratis card says "op til 3 medarbejdere", "Reservationer, 20 om måneden" and "Z-bon-aflæsning
 * fra foto: 3 om dagen"; Starter "Dig + 2 … op til 50"; Pro "3 afdelinger, dig + 4 … op til 200". Those numbers
 * come from the mirror, so the mirror must equal the gate that answers 402. Read from the file, both ways: every
 * mirrored number is found in billing.py (a parser that finds nothing fails here, never passes vacuously).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { PLAN_LIMITS, teamBesidesOwner } from "../lib/planLimits";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const billing = fs.readFileSync(path.join(SRC, "../../backend/app/services/billing.py"), "utf8");

/** The `"<tier>": { … }` block of PLAN_CAPS (4-space indent, as billing.py writes it), as { key: number }. */
function capsOf(tier) {
  const start = billing.indexOf("PLAN_CAPS: dict[str, dict[str, int]] = {");
  expect(start, "PLAN_CAPS in billing.py").toBeGreaterThan(-1);
  const m = billing.slice(start).match(new RegExp(`^    "${tier}": \\{([\\s\\S]*?)^    \\},`, "m"));
  expect(m, `PLAN_CAPS["${tier}"]`).toBeTruthy();
  const body = m[1].replace(/#.*$/gm, "");
  return Object.fromEntries([...body.matchAll(/"([a-z_]+)":\s*(-?\d+)/g)].map(([, k, v]) => [k, Number(v)]));
}

describe("lib/planLimits.js mirrors billing.py PLAN_CAPS", () => {
  for (const tier of ["free", "starter", "pro"]) {
    it(`${tier}: every mirrored limit equals the backend gate`, () => {
      const caps = capsOf(tier);
      expect(Object.keys(caps).length).toBeGreaterThan(10); // the real block, not a stray match
      for (const [key, value] of Object.entries(PLAN_LIMITS[tier])) {
        expect([tier, key, caps[key]]).toEqual([tier, key, value]);
      }
    });
  }

  it("the Gratis numbers the landing states (Manoj, 21 Oct): 3 staff, 20 reservations a month, 3 Z-bon photo reads a day", () => {
    expect(PLAN_LIMITS.free.staff_members).toBe(3);
    expect(PLAN_LIMITS.free.reservations_per_month).toBe(20);
    expect(PLAN_LIMITS.free.z_report_scans_per_day).toBe(3);
    // "3 om dagen" holds on the Kasserapport photo path too
    expect(PLAN_LIMITS.free.kasse_extracts_per_day).toBe(PLAN_LIMITS.free.z_report_scans_per_day);
    // "hver dags kasserapport som PDF uden grænse" is the per-day PDF; a period export stops at 7 days on Free
    expect(PLAN_LIMITS.free.daily_close_export_days).toBe(7);
  });

  it("paid cards: Dig + 2 / dig + 4, Pro 3 locations, unlimited reservations", () => {
    expect(teamBesidesOwner("starter")).toBe(2);
    expect(teamBesidesOwner("pro")).toBe(4);
    expect(PLAN_LIMITS.pro.branches).toBe(3);
    expect(PLAN_LIMITS.starter.reservations_per_month).toBe(-1);
    expect(PLAN_LIMITS.pro.reservations_per_month).toBe(-1);
  });

  it("is frozen (a page cannot change a limit it prints)", () => {
    expect(Object.isFrozen(PLAN_LIMITS)).toBe(true);
    expect(Object.isFrozen(PLAN_LIMITS.free)).toBe(true);
  });
});
