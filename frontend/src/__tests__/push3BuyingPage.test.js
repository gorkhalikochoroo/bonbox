/**
 * Push 3 (Manoj, 11 Oct 2026, F): the buying page (Plan & Billing FAQ, plan
 * cards, trial banner) says only what is true.
 *
 *   • Free has FEWER features than Starter/Pro (PLAN_FEATURES['free']: no
 *     invoices, no revisor login, …) — not "every feature stays".
 *   • There are Terms (accepted at checkout): "no lock-in", not "no contracts".
 *   • No "Business plan", no unmeasured "within 1 business day", and one
 *     address: contact@bonbox.dk.
 *   • No "5–10 % on wages" and no "30-second" close; the schedule autopilot
 *     is Starter + Pro (PLAN_FEATURES['starter']['schedule_autopilot']).
 *   • Receipt photos: what /privacy says (Anthropic or another listed
 *     service; Anthropic does not train on them) — no "in the US, not kept".
 * The backend sibling test_buying_page_claims_match_plans.py holds the plan
 * facts these sentences rest on.
 */
import { describe, expect, it } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { np } from "../i18n/np";
import { th } from "../i18n/th";
import { vi } from "../i18n/vi";

const ALL = { da, en, tr, np, th, vi };

describe("da + en: the exact new sentences", () => {
  it("faqA1: Free locks some features; the first charge is when the trial ends", () => {
    expect(da.faqA1).toContain("Nogle funktioner låses (fx fakturaer og revisor-login), brugslofterne vender tilbage");
    expect(en.faqA1).toContain("Some features lock (for example invoices and revisor login), the usage caps come back");
    expect(da.faqA1).toContain("når prøveperioden slutter");
    expect(en.faqA1).toContain("when the trial ends");
    expect(da.faqA1).toContain(`"${da.pricingLockInRate}"`);
    expect(en.faqA1).toContain(`'${en.pricingLockInRate}'`);
  });

  it("faqA7: no binding, period-end cancellation, no part refunds — as Terms § 8", () => {
    expect(da.faqA7).toBe("Ja. Ingen binding og intet opsigelsesvarsel. Opsigelsen får virkning ved udgangen af den periode, du har betalt for — indtil da beholder du adgangen, og vi refunderer ikke for en del af en periode. Du kan eksportere dine data når som helst.");
    expect(en.faqA7).toBe("Yes. No lock-in and no notice period. The cancellation takes effect at the end of the period you have paid for — you keep access until then, and we do not refund part of a period. You can export your data at any time.");
  });

  it("faqA4: Pro covers 3 locations; more → contact@bonbox.dk, nothing promised", () => {
    expect(da.faqA4).toBe("Pro dækker op til 3 lokationer. Har du flere, så skriv til contact@bonbox.dk.");
    expect(en.faqA4).toBe("Pro covers up to 3 locations. If you have more, write to contact@bonbox.dk.");
  });

  it("faqA8: receipt photos as /privacy says them", () => {
    expect(da.faqA8).toContain("For at blive læst sendes kvitteringsbilleder til Anthropic eller en anden tjeneste på listen i privatlivspolitikken. Anthropic træner ikke sine modeller på dem.");
    expect(en.faqA8).toContain("To be read, receipt photos are sent to Anthropic or another service on the list in the privacy policy. Anthropic does not train its models on them.");
  });

  it("faqA11: Starter and Pro, no savings percentage", () => {
    expect(da.faqA11.startsWith("Starter- og Pro-funktion. ")).toBe(true);
    expect(en.faqA11.startsWith("Starter and Pro feature. ")).toBe(true);
  });

  it("featFreeClose and pricingAfterTrialCapClose: no number of seconds", () => {
    expect(da.featFreeClose).toBe("Daglig kasserapport");
    expect(en.featFreeClose).toBe("Daily close");
    expect(da.pricingAfterTrialCapClose).toBe("Daglig kasserapport");
    expect(en.pricingAfterTrialCapClose).toBe("Daily close");
  });

  it("faqQ2/faqA2 and trialClosingDetail: Free has the Copilot with a cap, and fewer features", () => {
    expect(da.faqQ2).toBe("Hvorfor har Free AI Copilot, bare med et loft?");
    expect(en.faqQ2).toBe("Why does Free have the AI Copilot, just with a cap?");
    expect(da.faqA2).toContain("Free har lofter og færre funktioner end Starter og Pro");
    expect(en.faqA2).toContain("Free has caps and fewer features than Starter and Pro");
    expect(da.trialClosingDetail).toContain("Nogle funktioner låses");
    expect(en.trialClosingDetail).toContain("Some features lock");
  });
});

describe("every pack that has the keys: none of the old claims", () => {
  const OLD = {
    faqA1: /Alle funktioner forbliver|Every feature stays|Her özellik kalır|dag 15|day 15|15\. gün/,
    faqQ2: /alle funktioner|every feature|her özelliğe|सबै सुविधा|ทุกฟีเจอร์|mọi tính năng/i,
    faqA2: /feature-gating er en skat|feature-gating is a tax|özellik kilidi|feature-gating|การล็อกฟีเจอร์เป็นภาษี|khoá theo tính năng là/,
    faqA4: /hello@|Business|hverdag|business day|iş günü|कार्य दिन|วันทำการ|ngày làm việc/,
    faqA7: /kontrakter|contracts|Sözleşme|सम्झौता|สัญญา|hợp đồng/i,
    faqA8: /i USA|in the US|gemmes ikke|not kept|EU-barındırılan|EU-होस्ट|โฮสต์ใน EU|Lưu trữ tại EU|GDPR/,
    faqA11: /%|^Pro-funktion\.|^Pro feature|^Pro özelliği/,
    featFreeClose: /\d/,
    pricingAfterTrialCapClose: /\d/,
    trialClosingDetail: /Alle funktioner|Every feature|Tüm özellikler|सबै सुविधा|ทุกฟีเจอร์|Mọi tính năng/,
  };
  for (const [lang, d] of Object.entries(ALL)) {
    it(lang, () => {
      for (const [k, re] of Object.entries(OLD)) {
        if (typeof d[k] !== "string") continue; // the pack falls back to English
        expect(d[k], `${lang}.${k}`).not.toMatch(re);
      }
    });
  }
});
