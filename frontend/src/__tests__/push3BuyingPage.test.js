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

// ───────────── Round 2 (Manoj, 11 Oct): B4, B5 and the should-fixes ─────────────

describe("round 2, da + en: the exact new sentences", () => {
  it("B4: the reassurance tile says 'no lock-in', as faqA7 does", () => {
    expect(da.pricingReassureCancelSub).toBe("Ingen binding. Eksporter dine data, hvis du går.");
    expect(en.pricingReassureCancelSub).toBe("No lock-in. Export your data on the way out.");
    expect(da.faqA7).toContain("Ingen binding");
    expect(en.faqA7).toContain("No lock-in");
  });

  it("B5: the autopilot suggests breaks and warns about 11-hour rest and the 48-hour limit; the owner decides", () => {
    expect(da.faqA11).toContain("Den tager hensyn til hvert personalemedlems tilgængelighed. BonBox foreslår pauser og advarer om 11 timers hvile og 48-timersgrænsen — men det er dig, der bestemmer.");
    expect(en.faqA11).toContain("It takes each staff member's availability into account. BonBox suggests breaks and warns about the 11-hour rest rule and the 48-hour limit — but you decide.");
    expect(tr.faqA11).toContain("BonBox mola önerir ve 11 saatlik dinlenme kuralı ile 48 saatlik sınır konusunda uyarır — ama karar senin.");
    expect(da.featProScheduleAutopilot).toBe("Vagtplan-autopilot med ét tryk — vejr + omsætningsprognose, forslag til pauser og advarsler om 11 timers hvile og 48-timersgrænsen");
    expect(en.featProScheduleAutopilot).toBe("Staff schedule autopilot in one tap — weather + revenue forecast, suggested breaks and warnings on the 11-hour rest rule and the 48-hour limit");
  });

  it("faqA10 / featStarterAccountantLogin: says what is logged; no 'GDPR-safe'; no 'free' next to 'Starter+'", () => {
    expect(da.faqA10).toContain("Vi logger, når du inviterer eller fjerner din revisor, når revisoren opretter sit login, og når revisoren skifter til din virksomhed.");
    expect(en.faqA10).toContain("We log when you invite or remove your revisor, when the revisor creates their login, and when the revisor switches to your business.");
    expect(da.faqA10).toContain("Revisor-login koster ikke ekstra på Starter og Pro — på Free kan du stadig sende PDF'er via mail.");
    expect(en.faqA10).toContain("Revisor login costs nothing extra on Starter and Pro — on Free you can still send PDFs by email.");
    expect(da.featStarterAccountantLogin).toBe("Din revisor får sit eget skrivebeskyttede login — uden ekstra betaling");
    expect(en.featStarterAccountantLogin).toBe("Your revisor gets their own read-only login — at no extra cost");
  });

  it("faqA12: no PSD2 roadmap or partnership; says there is no direct bank connection", () => {
    expect(da.faqA12).toContain("BonBox har ingen direkte forbindelse til din bank.");
    expect(en.faqA12).toContain("BonBox has no direct connection to your bank.");
    expect(da.faqA12).toContain("Et sikkert match markerer BonBox selv som betalt, og du kan fortryde det i 7 dage");
    expect(en.faqA12).toContain("BonBox marks a high-confidence match as paid itself, and you can undo it for 7 days");
  });

  it("pricingTrialStep3BodyDropped: features lock too", () => {
    expect(da.pricingTrialStep3BodyDropped).toBe("Hvis ikke: du falder ned til Free (nogle funktioner låses, lofterne vender tilbage, data bliver, intet træk)");
    expect(en.pricingTrialStep3BodyDropped).toBe("If not: dropped to Free (some features lock, caps return, data stays, no charge ever)");
  });
});

describe("round 2, every pack that has the keys: none of the old claims", () => {
  const OLD = {
    pricingReassureCancelSub: /kontrakt|contract|Sözleşme|सम्झौता|สัญญา|hợp đồng/i,
    faqA11: /arbejdslov|labou?r law|iş hukuk|45/i,
    featProScheduleAutopilot: /arbejdsret|labou?r law/i,
    faqA12: /PSD2|Aiia|Salt Edge|køreplan|roadmap|yol harita|partnerskab|partnership|ortaklı|Spar Nord|2 klik|2 clicks|2 tık/i,
    faqA10: /audit-logget|audit-logged|denetim kaydına|GDPR|det er gratis|it's free|ücretsiz|Starter\+/i,
    featStarterAccountantLogin: /GDPR|audit|gratis|for free/i,
  };
  const LOCKS = {
    da: "nogle funktioner låses", en: "some features lock", tr: "bazı özellikler kilitlenir",
    np: "केही सुविधा लक हुन्छन्", th: "ฟีเจอร์บางอย่างถูกล็อก", vi: "một số tính năng bị khoá",
  };
  for (const [lang, d] of Object.entries(ALL)) {
    it(lang, () => {
      for (const [k, re] of Object.entries(OLD)) {
        if (typeof d[k] !== "string") continue; // the pack falls back to English
        expect(d[k], `${lang}.${k}`).not.toMatch(re);
      }
      expect(d.pricingTrialStep3BodyDropped, lang).toContain(LOCKS[lang]);
      expect(typeof d.pricingReassureCancelSub, lang).toBe("string");
    });
  }

  it("the page's inline English fallbacks match en (no stale 'No contracts', 'labor law', 'GDPR-safe')", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pages", "SubscriptionPage.jsx"), "utf8");
    for (const k of ["pricingReassureCancelSub", "featProScheduleAutopilot", "featStarterAccountantLogin", "pricingTrialStep3BodyDropped"]) {
      expect(src, k).toContain(JSON.stringify(en[k]));
    }
    for (const gone of ["No contracts", "DK labor law", "GDPR-safe", "audit-logged"]) expect(src).not.toContain(gone);
  });
});
