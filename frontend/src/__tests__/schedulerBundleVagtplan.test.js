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
  // 28 Oct 2026: the old project is deleted and the row is off for good, so
  // the bundle must carry no Ireland at all, and the "deleted" sentence.
  it("names Frankfurt as the database location; no Ireland at all (the fallback copy was deleted on 28 Oct 2026)", async () => {
    const { IRELAND_COPY_ROW } = await import("../legal/terms");
    expect(IRELAND_COPY_ROW).toBe(false);
    expect(bundle).toContain("The fallback copy we kept in our previous database project");
    expect(bundle).toContain("Den reservekopi, vi beholdt i vores tidligere databaseprojekt");
    const dir = path.join(PUBLIC, "assets");
    const IRELAND = /Irland|Ireland|İrlanda|आयरल्यान्ड|ไอร์แลนด์|eu-west-1/g;
    const hits = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).flatMap((f) => {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      return [...src.matchAll(IRELAND)].map((m) => ({ file: f.replace(/-[\w-]+\.js$/, ""), at: src.slice(m.index - 4, m.index + m[0].length + 1) }));
    });
    expect(hits).toEqual([]);
    for (const text of [
      "Lavet i København · database i EU (Frankfurt, Tyskland)",
      "Made in Copenhagen · database in the EU (Frankfurt, Germany)",
      "Databasen står i EU (Frankfurt, Tyskland). Opsig når som helst",
      "EU (Frankfurt, Germany)",
      "AB'de (Frankfurt, Almanya)",
    ]) expect(bundle).toContain(text);
  });

  // Landing fix round (22 Oct): the bundle is built from src/legal/terms.js, so the push day's one-line date
  // change (PRIVACY_UPDATED) must be rebuilt into it as well, or the staff app's /privacy and /cookies keep
  // printing the old date at their next Xcode Cloud build. Push-day order: set PRIVACY_UPDATED →
  // `npm run build:scheduler-app` → commit ios-scheduler/App/App/public/ and capacitor.config.json.
  // The bundle stores the dates as string literals (backticks after minification).
  //
  // 12 Nov 2026 push (Manoj, option B): the iPhone Vagtplan stays at the live 1.6 (branch vagtplan-1.6, NOT in
  // this push), so this folder is deliberately not rebuilt in it and the project still says 1.5. No iPhone build
  // is submitted from it (Xcode Cloud's 1.5 from main must not go to App Store Connect). The vagtplan-1.6
  // integration (next work item, then iPhone 1.7) rebuilds the folder and moves MARKETING_VERSION off 1.5,
  // which arms this check again by itself. Never widen this to any other version.
  const staffMarketingVersion = fs
    .readFileSync(path.join(FRONTEND, "ios-scheduler/App/App.xcodeproj/project.pbxproj"), "utf8")
    .match(/MARKETING_VERSION = ([\d.]+);/)?.[1];
  it.skipIf(staffMarketingVersion === "1.5")("carries terms.js's privacy date (and, while the fallback row is on, its deletion day): rebuilt after a date change", async () => {
    const { PRIVACY_UPDATED, PRIVACY_PUSH_DAY_PLACEHOLDER, IRELAND_COPY_ROW, IRELAND_COPY_DELETE_BY } = await import("../legal/terms");
    const literal = (d) => new RegExp("[`\"']" + d.replace(/-/g, "\\-") + "[`\"']");
    expect(bundle).toMatch(literal(PRIVACY_UPDATED));
    // once the push day is set, the placeholder is gone from the bundle (while it is still set, privacyUpdatedPushDay
    // is the one red test that says so; this file does not add a second one)
    if (PRIVACY_UPDATED !== PRIVACY_PUSH_DAY_PLACEHOLDER) expect(bundle).not.toContain(PRIVACY_PUSH_DAY_PLACEHOLDER);
    if (IRELAND_COPY_ROW) expect(bundle).toMatch(literal(IRELAND_COPY_DELETE_BY));
  });

  // Orvexlo (3 Nov 2026): the staff app's /terms, /privacy, /cookies and /contact name the CVR register's new name, and
  // the old one is gone from the bundle (rebuild after the rename: npm run build:scheduler, then
  // BONBOX_TARGET=scheduler npx cap copy ios).
  it("names Orvexlo (CVR 46417321) and no longer the old company name", () => {
    expect(bundle).toContain("Orvexlo");
    expect(bundle).toContain("46417321");
    expect(bundle).not.toMatch(/DukaanAI|Manoz/);
  });

  it("the committed capacitor.config.json is the staff app's", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(FRONTEND, "ios-scheduler/App/App/capacitor.config.json"), "utf8"));
    expect(cfg.appId).toBe("dk.bonbox.scheduler");
    expect(cfg.appName).toBe("Vagtplan");
    expect(cfg.webDir).toBe("dist-scheduler");
  });
});
