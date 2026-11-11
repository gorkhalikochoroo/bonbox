/**
 * The staff app's cold-load wait is in its own palette (canvas "Pine, ivory &
 * brass"): ivory ground, pine spinner — never the owner app's white page with
 * the blue spinner before the ivory portal appears. The owner app's loader
 * and the guest wait are unchanged (r3.embedFlatAndSpinner.test.jsx).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
const loader = app.slice(app.indexOf("function PageLoader()"), app.indexOf("function isChunkLoadError"));

describe("PageLoader on the staff app", () => {
  it("/s/<token> and the Vagtplan app build are a staff surface", () => {
    expect(app).toMatch(/function isStaffSurface\(\) \{[\s\S]{0,200}VITE_APP_MODE === "scheduler"[\s\S]{0,120}\\\/s\\\//);
  });

  it("renders ivory with a pine spinner there, after the guest check and before the owner loader", () => {
    const guest = loader.indexOf("if (isGuestSurface())");
    const staff = loader.indexOf("if (isStaffSurface())");
    const owner = loader.indexOf("text-blue-600");
    expect(guest).toBeGreaterThan(-1);
    expect(staff).toBeGreaterThan(guest);
    expect(owner).toBeGreaterThan(staff);
    const staffBlock = loader.slice(staff, owner);
    expect(staffBlock).toContain('background: "#F6F4EE"');
    expect(staffBlock).toContain('color: "#0E3B2E"');
    expect(staffBlock).not.toMatch(/blue/);
    expect(staffBlock).toContain('data-testid="page-loader"');
  });
});
