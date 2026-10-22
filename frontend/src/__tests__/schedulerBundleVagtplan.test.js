/**
 * The staff iPhone app (BonBox Vagtplan, dk.bonbox.scheduler) is archived
 * locally from the COMMITTED web bundle in ios-scheduler/App/App/public — a
 * source change that is not rebuilt into that folder never reaches the app
 * (memory: gotcha_scheduler_local_archive_stale_bundle). This pins that the
 * brand release's rename, the iPhone Terms notice and /privacy are in it.
 * Rebuild with `npm run build:scheduler-app` and commit the folder; do NOT
 * commit the CapApp-SPM/Package.swift that cap sync rewrites through the
 * node_modules symlink in a worktree.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = path.join(FRONTEND, "ios-scheduler/App/App/public");
const js = () => {
  const dir = path.join(PUBLIC, "assets");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
};

describe("committed staff web bundle (ios-scheduler/App/App/public)", () => {
  const bundle = js();

  it("says BonBox Vagtplan and never BonBox Scheduler", () => {
    expect(bundle).toContain("BonBox Vagtplan");
    expect(bundle).toContain("Indstillinger → Vagtplan → Lokalitet");
    expect(bundle).not.toContain("BonBox Scheduler");
  });

  it("carries this release's other copy too (iPhone Terms line, /privacy clock-in sentence, /contact address)", () => {
    expect(bundle).toContain("§ 8 om abonnementer er også ændret.");
    expect(bundle).toContain("Placering ved indstempling");
    expect(bundle).toContain("contact@bonbox.dk");
    expect(bundle).not.toContain("bonbox.dk@gmail.com");
  });

  it("is the scheduler build (VITE_APP_MODE folded to scheduler) and its index.html loads an asset that exists", () => {
    const index = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
    const entry = index.match(/assets\/(index-[\w-]+\.js)/);
    expect(entry).not.toBeNull();
    const main = fs.readFileSync(path.join(PUBLIC, "assets", entry[1]), "utf8");
    expect(main).not.toContain('!=="scheduler"');
  });

  // Landing v6 + Frankfurt release: the database moved to Frankfurt on
  // 20 Oct 2026 and the app says so (frankfurtEverywhere.test.js holds the
  // source). The bundle must be rebuilt from that source: Ireland only in the
  // /privacy fallback-copy row, and only while IRELAND_COPY_ROW is on. If
  // this fails after a text change or after switching the constant, run
  // `npm run build:scheduler-app` and commit the folder.
  it("names Frankfurt as the database location; Ireland only in /privacy's fallback-copy row while it is on", async () => {
    const { IRELAND_COPY_ROW } = await import("../legal/terms");
    const dir = path.join(PUBLIC, "assets");
    const IRELAND = /Irland|Ireland|İrlanda|आयरल्यान्ड|ไอร์แลนด์|eu-west-1/g;
    const hits = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).flatMap((f) => {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      return [...src.matchAll(IRELAND)].map((m) => ({ file: f.replace(/-[\w-]+\.js$/, ""), at: src.slice(m.index - 4, m.index + m[0].length + 1) }));
    });
    expect(hits).toEqual(IRELAND_COPY_ROW
      ? [{ file: "PrivacyPolicyPage", at: "EU (Ireland)" }, { file: "PrivacyPolicyPage", at: "EU (Irland)" }]
      : []);
    for (const text of [
      "Lavet i København · database i EU (Frankfurt, Tyskland)",
      "Made in Copenhagen · database in the EU (Frankfurt, Germany)",
      "Databasen står i EU (Frankfurt, Tyskland). Opsig når som helst",
      "EU (Frankfurt, Germany)",
      "AB'de (Frankfurt, Almanya)",
    ]) expect(bundle).toContain(text);
  });

  it("the committed capacitor.config.json is the staff app's", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(FRONTEND, "ios-scheduler/App/App/capacitor.config.json"), "utf8"));
    expect(cfg.appId).toBe("dk.bonbox.scheduler");
    expect(cfg.appName).toBe("Vagtplan");
    expect(cfg.webDir).toBe("dist-scheduler");
  });
});
