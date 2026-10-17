/**
 * Brand release (Manoj, 11 Oct 2026): the two iPhone apps' names.
 *
 *   • App Store names: "BonBox" (owner, id 6762066960) and "BonBox Vagtplan"
 *     (staff, id 6787010793). Home-screen names: "BonBox" / "Vagtplan".
 *   • The staff app is Vagtplan everywhere: home screen, the four permission
 *     prompts, in-app strings, the landing page. The old names "BonBox
 *     Scheduler" and "Daily Close" (as an app name) are gone from everything a
 *     person reads. The App Store URLs keep their ids (and their old slugs —
 *     Apple redirects by id).
 *   • Versions: owner 2.4 (2.3 in review; was 2.2 at the rename), staff 1.5. Build numbers
 *     stay with the CI scripts.
 *   • Danish permission prompts (da.lproj) next to the English ones (en.lproj)
 *     for both apps, registered in each Xcode project.
 *   • The staff app ships a COMMITTED web bundle: the rename is only real once
 *     that bundle is rebuilt and committed, so the last block reads it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";

let langCode = "da";
const dict = () => (langCode === "da" ? da : en);
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: langCode,
    setLang: () => {},
    LANGUAGES: [],
    t: (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      let s = dict()[k] ?? en[k] ?? (typeof fb === "string" ? fb : k);
      if (v && typeof s === "string") s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
      return s;
    },
  }),
  LanguageProvider: ({ children }) => children,
}));

const HeroV2 = (await import("../components/landing/v2/HeroV2")).default;
const StaffCopyV2 = (await import("../components/landing/v2/StaffCopyV2")).default;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.resolve(SRC, "..");
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8");

const OWNER_STORE = "https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960";
const STAFF_STORE = "https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793";

// The old app names, as anyone could read them.
const OLD_NAMES = /BonBox Scheduler|Scheduler-app|Scheduler'ı|Scheduler (i|on the) App Store|App Store'da (Scheduler|Daily Close)|Daily Close (i|on the) App Store|BonBox Daily Close/;

afterEach(() => {
  cleanup();
  langCode = "da";
});

describe("landing: the owner badge follows the store name", () => {
  it("da: »BonBox i App Store«, same App Store id", () => {
    langCode = "da";
    render(<MemoryRouter><HeroV2 /></MemoryRouter>);
    const link = screen.getByRole("link", { name: "BonBox i App Store" });
    expect(link.getAttribute("href")).toBe(OWNER_STORE);
    expect(document.body.textContent).not.toContain("Daily Close i App Store");
  });

  it("en: »BonBox on the App Store«", () => {
    langCode = "en";
    render(<MemoryRouter><HeroV2 /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "BonBox on the App Store" }).getAttribute("href")).toBe(OWNER_STORE);
    expect(document.body.textContent).not.toContain("Daily Close on the App Store");
  });
});

describe("landing: the staff block says Vagtplan", () => {
  it("da: eyebrow, badge and body — and no promise of a message the moment a shift moves", () => {
    langCode = "da";
    render(<MemoryRouter><StaffCopyV2 /></MemoryRouter>);
    const text = document.body.textContent;
    expect(text).toContain("BonBox Vagtplan · iPhone");
    expect(screen.getByRole("link", { name: "Vagtplan i App Store" }).getAttribute("href")).toBe(STAFF_STORE);
    expect(text).toContain("Personalet åbner Vagtplan");
    // Push 9 (A5): "i appen" dropped — on Android Vagtplan is the browser.
    expect(text).toContain("kan se, når en af deres vagter bliver ændret");
    expect(text).not.toMatch(/Scheduler|i samme øjeblik/);
  });

  it("en", () => {
    langCode = "en";
    render(<MemoryRouter><StaffCopyV2 /></MemoryRouter>);
    const text = document.body.textContent;
    expect(text).toContain("BonBox Vagtplan · iPhone");
    expect(screen.getByRole("link", { name: "Vagtplan on the App Store" }).getAttribute("href")).toBe(STAFF_STORE);
    expect(text).toContain("Staff open Vagtplan");
    expect(text).not.toMatch(/Scheduler|the moment a shift moves/);
  });
});

describe("no old app name is left in anything a person reads", () => {
  it("dictionaries (en / da / tr): no value names the old apps", () => {
    for (const [name, d] of [["en", en], ["da", da], ["tr", tr]]) {
      const offenders = Object.entries(d).filter(([, v]) => typeof v === "string" && (OLD_NAMES.test(v) || /\bScheduler\b/.test(v)));
      expect(offenders, name).toEqual([]);
    }
  });

  it("the renamed keys say Vagtplan / BonBox in en, da and tr", () => {
    expect(en.staffGetSchedulerApp).toBe("Get the BonBox Vagtplan app");
    expect(da.staffGetSchedulerApp).toBe("Hent appen BonBox Vagtplan");
    expect(en.shareCopyAppLine).toBe("Or get the free BonBox Vagtplan app");
    expect(da.shareCopyAppLine).toBe("Eller hent den gratis app BonBox Vagtplan");
    expect(tr.shareCopyAppLine).toContain("BonBox Vagtplan");
    expect(en.joinDocTitle).toBe("BonBox Vagtplan — Connect");
    expect(da.joinDocTitle).toBe("BonBox Vagtplan — Tilslut");
    expect(en.portalAppDocTitle).toBe("BonBox Vagtplan");
    expect(da.portalAppDocTitle).toBe("BonBox Vagtplan");
    // iOS Settings lists an app by its home-screen name.
    expect(en.portalClockNoLocationFixNative).toBe("To fix it: Settings → Vagtplan → Location → While Using the App.");
    expect(da.portalClockNoLocationFixNative).toBe("Sådan retter du det: Indstillinger → Vagtplan → Lokalitet → Når appen er i brug.");
    expect(en["landingV2.appStore.dailyClose"]).toBe("BonBox on the App Store");
    expect(da["landingV2.appStore.dailyClose"]).toBe("BonBox i App Store");
    expect(tr["landingV2.appStore.dailyClose"]).toBe("App Store'da BonBox");
  });

  it("the team-invite tip names the app and promises no alert (Free has no push)", () => {
    expect(en.teamInvitationAppTip).toBe("Tip: tell them to get the free BonBox Vagtplan app — they'll have their shifts on their phone.");
    expect(da.teamInvitationAppTip).toBe("Tip: bed dem hente den gratis app BonBox Vagtplan — så har de deres vagter på telefonen.");
    for (const v of [en.teamInvitationAppTip, da.teamInvitationAppTip, tr.teamInvitationAppTip]) {
      expect(v).not.toMatch(/alert|besked|bildirim/i);
    }
  });

  it("every inline fallback of a renamed key matches the English dictionary", () => {
    const keys = [
      "teamInvitationAppTip", "staffGetSchedulerApp", "shareCopyAppLine", "portalClockNoLocationFixNative",
      "joinDocTitle", "portalAppDocTitle", "landingV2.staff.eyebrow", "landingV2.staff.body",
      "landingV2.appStore.dailyClose", "landingV2.appStore.scheduler", "landingV2.modules.schedule.body",
    ];
    const files = [
      "src/pages/TeamPage.jsx", "src/pages/StaffPortalPage.jsx", "src/pages/StaffSchedulePage.jsx",
      "src/pages/JoinPage.jsx", "src/components/landing/v2/HeroV2.jsx",
      "src/components/landing/v2/StaffCopyV2.jsx", "src/components/landing/v2/ModulesV2.jsx",
    ];
    let seen = 0;
    for (const f of files) {
      const src = read(f);
      for (const k of keys) {
        const re = new RegExp(`t\\(\\s*"${k.replace(/\./g, "\\.")}",\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
        for (const m of src.matchAll(re)) {
          seen += 1;
          expect(m[1], `${f} ${k}`).toBe(en[k]);
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(13);
  });

  it("source: no string literal outside the tests names the old apps (comments are history, not copy)", () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
      return /\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
    });
    const offenders = [];
    for (const file of walk(SRC)) {
      const code = fs.readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"));
      code.forEach((line, i) => {
        if (/(["'`])[^"'`]*(BonBox Scheduler|Scheduler (on the|i) App Store|Daily Close (on the|i) App Store)[^"'`]*\1/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the App Store links keep their ids", () => {
    expect(read("src/components/landing/v2/HeroV2.jsx")).toContain(OWNER_STORE);
    expect(read("src/pages/LandingPage.jsx")).toContain(OWNER_STORE);
    for (const f of ["src/components/landing/v2/StaffCopyV2.jsx", "src/pages/StaffPortalPage.jsx", "src/pages/StaffSchedulePage.jsx", "src/pages/LandingPage.jsx"]) {
      expect(read(f), f).toContain(STAFF_STORE);
    }
  });
});

// ─────────────────────────── the two iOS projects ───────────────────────────

const plistString = (xml, key) => {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
};
const parseStrings = (text) => Object.fromEntries(
  [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)";/g)].map((m) => [m[1], m[2]]),
);
const USAGE = /^NS\w+UsageDescription$/;

describe("staff app (ios-scheduler): Vagtplan on the home screen and in all four prompts", () => {
  const plist = read("ios-scheduler/App/App/Info.plist");

  it("home-screen name is Vagtplan and no prompt says Scheduler", () => {
    expect(plistString(plist, "CFBundleDisplayName")).toBe("Vagtplan");
    expect(plist).not.toMatch(/Scheduler/);
    for (const k of ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription", "NSLocationWhenInUseUsageDescription"]) {
      expect(plistString(plist, k), k).toMatch(/^Vagtplan /);
    }
  });

  it("Capacitor's appName and the committed capacitor.config.json say Vagtplan; the bundle id is unchanged", () => {
    expect(read("capacitor.config.ts")).toContain('appName: isScheduler ? "Vagtplan" : "BonBox",');
    const json = JSON.parse(read("ios-scheduler/App/App/capacitor.config.json"));
    expect(json.appName).toBe("Vagtplan");
    expect(json.appId).toBe("dk.bonbox.scheduler");
  });
});

describe("versions: owner 2.4, staff 1.5 (build numbers untouched, CI-driven)", () => {
  it("MARKETING_VERSION in both configurations of each project", () => {
    const owner = read("ios/App/App.xcodeproj/project.pbxproj");
    const staff = read("ios-scheduler/App/App.xcodeproj/project.pbxproj");
    expect(owner.match(/MARKETING_VERSION = [\d.]+;/g)).toEqual(["MARKETING_VERSION = 2.4;", "MARKETING_VERSION = 2.4;"]);
    expect(staff.match(/MARKETING_VERSION = [\d.]+;/g)).toEqual(["MARKETING_VERSION = 1.5;", "MARKETING_VERSION = 1.5;"]);
  });
});

describe("Danish permission prompts (da.lproj) next to English (en.lproj), both apps", () => {
  for (const app of ["ios/App", "ios-scheduler/App"]) {
    it(app, () => {
      const plist = read(`${app}/App/Info.plist`);
      const usageKeys = [...plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)].map((m) => m[1]).sort();
      expect(usageKeys.length).toBe(4);
      const enStrings = parseStrings(read(`${app}/App/en.lproj/InfoPlist.strings`));
      const daStrings = parseStrings(read(`${app}/App/da.lproj/InfoPlist.strings`));
      expect(Object.keys(enStrings).sort()).toEqual(usageKeys);
      expect(Object.keys(daStrings).sort()).toEqual(usageKeys);
      for (const k of usageKeys) {
        expect(USAGE.test(k)).toBe(true);
        // English = the Info.plist text (the fallback for every other language).
        expect(enStrings[k], k).toBe(plistString(plist, k));
        // Danish is real Danish, not a copy of the English.
        expect(daStrings[k], k).not.toBe(enStrings[k]);
        expect(daStrings[k].length, k).toBeGreaterThan(20);
      }
      // Xcode: one InfoPlist.strings variant group with en + da, built as a
      // resource, and da a known region.
      const pbx = read(`${app}/App.xcodeproj/project.pbxproj`);
      expect(pbx).toContain("path = en.lproj/InfoPlist.strings;");
      expect(pbx).toContain("path = da.lproj/InfoPlist.strings;");
      expect(pbx).toMatch(/\/\* InfoPlist\.strings in Resources \*\/,/);
      expect(pbx).toMatch(/knownRegions = \(\s*en,\s*da,\s*Base,\s*\);/);
    });
  }

  it("staff Danish prompts name Vagtplan; the location prompt says only at clock-in, never stored", () => {
    const d = parseStrings(read("ios-scheduler/App/App/da.lproj/InfoPlist.strings"));
    for (const v of Object.values(d)) expect(v).toMatch(/^Vagtplan /);
    expect(d.NSLocationWhenInUseUsageDescription).toContain("kun din placering, når du stempler ind");
    expect(d.NSLocationWhenInUseUsageDescription).toContain("aldrig gemt");
  });
});
