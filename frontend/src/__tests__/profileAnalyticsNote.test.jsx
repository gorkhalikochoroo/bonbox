/**
 * Profile → Privacy & data: the note under the analytics pause says what
 * /privacy says (combined-release fix round, 11 Oct 2026).
 *
 * Before: a hard-coded English line, "GDPR: BonBox processes analytics under
 * legitimate-interest basis…". Since R-h, /privacy says the events a browser
 * sends are recorded only after the owner turns on Analytics in the cookie
 * banner (consent); only the records the server writes itself rest on
 * legitimate interest. The note now comes from i18n (en + da) and repeats
 * /privacy's consent sentence, in both languages.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { da } from "../i18n/da";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");

const privacySection = () => {
  const src = read("pages", "ProfilePage.jsx");
  const from = src.slice(src.indexOf('<SectionAnchor id="privacy">'));
  return from.slice(0, from.indexOf("</SectionAnchor>"));
};

describe("Profile → Privacy & data analytics note", () => {
  it("no longer claims legitimate interest for analytics, and is not hard-coded English", () => {
    const section = privacySection();
    expect(section).not.toMatch(/legitimate-interest/i);
    expect(section).not.toContain("GDPR: BonBox processes analytics");
    expect(section).toContain('t("profAnalyticsConsentNote")');
  });

  it("has a real English and Danish text that match /privacy's consent sentence", () => {
    const enText = en.profAnalyticsConsentNote;
    const daText = da.profAnalyticsConsentNote;
    expect(enText).toBeTruthy();
    expect(daText).toBeTruthy();
    expect(daText).not.toBe(enText);

    const privacy = read("pages", "PrivacyPolicyPage.jsx");
    const EN_CONSENT = "The events your browser sends (pages you visit and actions you take) are recorded only after you turn on Analytics";
    const DA_CONSENT = "De hændelser, din browser sender (hvilke sider du besøger, og hvilke handlinger du foretager), registreres først, når du har slået Analyse til";
    expect(privacy).toContain(EN_CONSENT);
    expect(privacy).toContain(DA_CONSENT);
    expect(enText.startsWith(EN_CONSENT)).toBe(true);
    expect(daText.startsWith(DA_CONSENT)).toBe(true);
    expect(enText).not.toMatch(/legitimate/i);
    expect(daText).not.toMatch(/legitim/i);
  });
});

describe("Profile → Privacy & data: the pause toggle says what pausing does", () => {
  // /privacy: "When paused, no new events are recorded for your account,
  // except the record of each AI chat turn, …" — routers/agent.py records
  // every agent.chat turn (the plan-limit counter) before it reads
  // analytics_opt_out. The toggle used to say pausing stops "AI questions".
  const EN_EXCEPT = "except the record of each AI chat turn, Smart Sale Entry and upgrade checkout that BonBox needs to enforce your plan's limits";
  const DA_EXCEPT = "bortset fra registreringen af hver AI-chatbesked, hver Smart salgsindtastning og hver påbegyndt betaling for en opgradering, som BonBox skal bruge for at håndhæve grænserne i din plan";

  it("names the same exception as /privacy, in both languages", () => {
    const privacy = read("pages", "PrivacyPolicyPage.jsx");
    expect(privacy).toContain(EN_EXCEPT);
    expect(privacy).toContain(DA_EXCEPT);
    expect(en.profPauseAnalyticsDesc).toContain(EN_EXCEPT);
    expect(da.profPauseAnalyticsDesc).toContain(DA_EXCEPT);
  });

  it("no longer says pausing stops recording AI questions", () => {
    expect(en.profPauseAnalyticsDesc).not.toMatch(/AI questions/i);
    expect(da.profPauseAnalyticsDesc).not.toMatch(/AI-spørgsmål/i);
  });

  it("comes from i18n only — no inline English fallback in the t() call", () => {
    const section = privacySection();
    expect(section).toContain('desc={t("profPauseAnalyticsDesc")}');
    expect(section).not.toContain("When ON, BonBox stops recording");
  });
});
