/**
 * Two i18n keys that were each doing two jobs.
 *
 * A duplicate key in a translation object is legal JS — the last one wins — so
 * a key defined twice for two DIFFERENT purposes resolves to one string and
 * silently shows the wrong text at one of its call sites. Two shipped that way:
 *
 *   rsvpCancelConfirm* : the OWNER cancelling someone else's table and the GUEST
 *     cancelling their own share the dialog keys. The guest copy won, so the
 *     owner was asked to confirm with "The table is released immediately … You're
 *     welcome to book again" — second-person copy about the reader's own booking,
 *     shown to the person cancelling someone else's, naming nobody.
 *
 *   rsvpClosed : the one-word label under a disabled day chip, and the <h1> of
 *     the whole public booking page when a venue takes no reservations. The word
 *     won, so an un-named venue's booking link opened on a page titled "closed".
 *
 * The placeholder assertions are the sharp ones. t() only substitutes when a vars
 * object is passed AND the string contains "{" (useLanguage.jsx). So:
 *   • the GUEST body must carry NO placeholder — its call site passes no vars, and
 *     a "{name}" there would render literally to a member of the public;
 *   • the OWNER body MUST carry {name} — its call site passes it, and a string
 *     without the brace silently discards the guest's name from the dialog.
 * Those two pull in opposite directions, which is exactly why one key cannot
 * serve both.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

/** Renders one t() call so assertions read the resolved string. */
function Probe({ tkey, vars }) {
  const { t } = useLanguage();
  return <span data-testid="out">{vars ? t(tkey, undefined, vars) : t(tkey)}</span>;
}

const resolve = (tkey, { lang = "en", vars } = {}) => {
  localStorage.setItem("lang", lang);
  const { unmount } = render(
    <LanguageProvider>
      <Probe tkey={tkey} vars={vars} />
    </LanguageProvider>,
  );
  const text = screen.getByTestId("out").textContent;
  unmount();
  return text;
};

describe("rsvpClosed — chip word vs page headline", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ["en", "Not taking reservations"],
    ["da", "Tager ikke imod reservationer"],
  ])("%s: rsvpClosed is the ClosedScreen headline, not a word", (lang, expected) => {
    expect(resolve("rsvpClosed", { lang })).toBe(expected);
  });

  it.each([
    ["en", "closed"],
    ["da", "lukket"],
  ])("%s: rsvpDayClosed is the short day-chip label", (lang, expected) => {
    expect(resolve("rsvpDayClosed", { lang })).toBe(expected);
  });

  it.each(["en", "da"])("%s: the two are not the same string", (lang) => {
    expect(resolve("rsvpClosed", { lang })).not.toBe(resolve("rsvpDayClosed", { lang }));
  });

  it.each(["en", "da"])("%s: the headline stays parallel to its named twin", (lang) => {
    // rsvpClosedNamed is "{name} isn't taking reservations" — the un-named
    // branch has to read like a headline, which is what regressed.
    const named = resolve("rsvpClosedNamed", { lang });
    const plain = resolve("rsvpClosed", { lang });
    expect(named.length).toBeGreaterThan(plain.length);
    expect(plain.split(" ").length).toBeGreaterThan(1);
  });
});

describe("reservation cancel — owner dialog vs guest dialog", () => {
  beforeEach(() => localStorage.clear());

  it.each(["en", "da"])("%s: the GUEST body carries no placeholder", (lang) => {
    // Its call site passes no vars, so any "{…}" would reach a member of the
    // public verbatim.
    expect(resolve("rsvpCancelConfirmBody", { lang })).not.toMatch(/\{/);
  });

  it.each(["en", "da"])("%s: the OWNER body names the guest", (lang) => {
    const raw = resolve("rsvpOwnerCancelConfirmBody", { lang });
    expect(raw).toMatch(/\{name\}/);
  });

  it.each(["en", "da"])("%s: the owner body actually interpolates", (lang) => {
    const out = resolve("rsvpOwnerCancelConfirmBody", { lang, vars: { name: "Mette" } });
    expect(out).toContain("Mette");
    expect(out).not.toMatch(/\{name\}/);
  });

  it.each(["en", "da"])("%s: owner and guest bodies are different messages", (lang) => {
    expect(resolve("rsvpOwnerCancelConfirmBody", { lang })).not.toBe(
      resolve("rsvpCancelConfirmBody", { lang }),
    );
  });

  it.each(["en", "da"])("%s: the owner dialog has its own title and confirm label", (lang) => {
    expect(resolve("rsvpOwnerCancelConfirmTitle", { lang })).toBeTruthy();
    expect(resolve("rsvpOwnerCancelConfirmYes", { lang })).toBeTruthy();
    expect(resolve("rsvpOwnerCancelConfirmTitle", { lang })).not.toBe("rsvpOwnerCancelConfirmTitle");
  });
});

describe("from/to are a matched pair again", () => {
  beforeEach(() => localStorage.clear());

  it.each(["en", "da"])("%s: `to` is a capitalised field label like `from`", (lang) => {
    // `to` had been redefined as the lowercase preposition for ReportsPage's
    // "payable to SKAT", which is also the label paired with `from` on the
    // mileage address fields and the Sales / Payment-imports date filters — so
    // those rendered a lowercase "to" under a capitalised "From".
    const from = resolve("from", { lang });
    const to = resolve("to", { lang });
    expect(to[0]).toBe(to[0].toUpperCase());
    expect(from[0]).toBe(from[0].toUpperCase());
  });

  it.each(["en", "da"])("%s: the sentence fragment stays lowercase", (lang) => {
    // ReportsPage builds `${t("toAuthority")} ${vat.taxAuthority}` → "to SKAT".
    const frag = resolve("toAuthority", { lang });
    expect(frag).toBe(frag.toLowerCase());
    expect(frag).not.toBe("toAuthority");
  });

  it("the fragment is not confused with currency.js's vat.payableTo", () => {
    // That one holds a whole sentence ("Beløb der skal indbetales til SKAT").
    // Two different things under one name is how this file got into trouble.
    expect(resolve("toAuthority", { lang: "da" }).split(" ").length).toBe(1);
  });
});

describe("ledger and invoicing no longer share copy", () => {
  beforeEach(() => localStorage.clear());

  it.each(["en", "da"])("%s: the Khata ledger has its own search placeholder", (lang) => {
    const khata = resolve("khataSearchCustomers", { lang });
    const invoicing = resolve("searchCustomers", { lang });
    expect(khata).not.toBe(invoicing);
    expect(khata).not.toBe("khataSearchCustomers");
    // The ledger filters on neither CVR nor email; the invoicing list does.
    expect(khata).not.toMatch(/CVR/i);
  });

  it.each(["en", "da"])("%s: the ledger empty state does not mention invoicing", (lang) => {
    const khata = resolve("khataNoCustomersYet", { lang });
    expect(khata).not.toBe(resolve("noCustomersYet", { lang }));
    expect(khata).not.toMatch(/invoic|faktur/i);
  });
});

describe("count units and button verbs", () => {
  beforeEach(() => localStorage.clear());

  it.each(["en", "da"])("%s: the staffing count unit is a lowercase plural", (lang) => {
    // StaffingPage renders `{n} {t("stStaffCountSuffix")}` — "3 staff" /
    // "3 medarbejdere". It had been borrowing `staff`, a standalone noun the
    // notification cards use as a name substitute ("Staff" / "Personale").
    const unit = resolve("stStaffCountSuffix", { lang });
    const noun = resolve("staff", { lang });
    expect(unit).toBe(unit.toLowerCase());
    expect(unit).not.toBe(noun);
  });

  it.each(["en", "da"])("%s: the multi-terminal reset button reads as an action", (lang) => {
    const btn = resolve("mtcStartAnotherClose", { lang });
    const tab = resolve("newClose", { lang });
    expect(btn).not.toBe(tab);
    expect(btn).not.toBe("mtcStartAnotherClose");
    // A tab label is short; an action button says what it does.
    expect(btn.split(" ").length).toBeGreaterThan(tab.split(" ").length);
  });
});

describe("the component owns the arrow, not the string", () => {
  beforeEach(() => localStorage.clear());

  it.each(["en", "da"])("%s: seePlans carries no trailing arrow", (lang) => {
    // UpgradeNudge's card branch draws its own SVG arrow after {ctaLabel}, and
    // 8 of the 13 call sites pass seePlans as ctaLabel — so an arrow in the
    // string rendered TWO. ReceiptCapture appended a literal "→" on top of
    // that. The component's own default prop is already "See plans".
    expect(resolve("seePlans", { lang })).not.toMatch(/[→>]\s*$/);
  });

  it("no locale pack reintroduces the arrow", async () => {
    for (const code of ["tr", "th", "vi", "np"]) {
      const mod = await import(`../i18n/${code}.js`);
      const dict = mod[code] ?? mod[`${code}_`];
      if (!dict?.seePlans) continue;
      expect(dict.seePlans, `${code}.js seePlans`).not.toMatch(/[→>]\s*$/);
    }
  });
});

describe("strings that claimed more than the screen knows", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ["en", /today/i],
    ["da", /i dag/i],
  ])("%s: the empty sales table does not claim 'today'", (lang, todayWord) => {
    // SalesPage's <Empty> sits under a table filtered by status, free-text
    // search AND a user-chosen date range — none of them today-scoped. The
    // string asserted a fact the screen could not support: search "pizza" with
    // no match and it said no sales had been recorded TODAY.
    expect(resolve("noSalesYet", { lang })).not.toMatch(todayWord);
  });
});

describe("Danish names one thing one way", () => {
  beforeEach(() => localStorage.clear());

  it("the monthly-report button does not rename itself when toggled", () => {
    // PersonalPage renders `showMonthlyReport ? hideMonthlyReport : monthlyReport`
    // — one control. It read "Månedlig rapport" ⇄ "Skjul månedsrapport".
    const shown = resolve("monthlyReport", { lang: "da" });
    const hidden = resolve("hideMonthlyReport", { lang: "da" });
    expect(hidden.toLowerCase()).toContain(shown.toLowerCase());
  });

  it("the tips tab and the tips page heading agree", () => {
    // StaffBackOfficePage labels the tab t("staffTips") = "Drikkepenge" and
    // mounts StaffTipsPage, whose heading was t("tips") = "Tips", above a
    // subtitle that says drikkepenge. Three treatments in one viewport.
    expect(resolve("tips", { lang: "da" })).toBe(resolve("staffTips", { lang: "da" }));
  });

  it("the VAT screen is named for the artefact it produces", () => {
    // momsangivelse is the FILING, momsregnskab the continuous bookkeeping,
    // and momsopgørelse the period statement computing salgsmoms − købsmoms.
    // VatReportPage produces the last of those and files nothing, so that is
    // its name — the revisor's word, which the app already used for this exact
    // artefact in fullTaxBreakdown.
    expect(resolve("vatReport", { lang: "da" })).toBe("Momsopgørelse");
  });

  it("every string naming that screen agrees with it", () => {
    // The reason this had to be a sweep rather than one key: the label, the
    // link that navigates there, and the page's own loading and error lines
    // all name the same document.
    for (const key of ["taxViewVatReport", "loadingVat", "vatError"]) {
      expect(resolve(key, { lang: "da" }).toLowerCase()).toContain("momsopgørelse");
    }
  });

  it("keeps Danish compound casing — lowercase inside a sentence", () => {
    // MOMS is uppercase as a standalone token ("MOMS-frist"), but a compound
    // common noun is one lowercase word mid-sentence. Both forms are correct
    // Danish; using the wrong one for the position is what looks machine-made.
    expect(resolve("vatReport", { lang: "da" })).toBe("Momsopgørelse");
    expect(resolve("taxViewVatReport", { lang: "da" })).toContain("momsopgørelse");
  });

  it("English is NOT given the Danish tax word", () => {
    // en is the fallback pack for every locale, and currency.js already
    // parameterises the tax name per COUNTRY (MOMS/MVA/MwSt/BTW/TVA). Putting
    // MOMS here would mislabel every non-DK account.
    expect(resolve("vatReport", { lang: "en" })).not.toMatch(/MOMS/);
  });
});

describe("useConfirm default labels exist in Danish", () => {
  beforeEach(() => localStorage.clear());

  it.each(["dlgConfirmTitle", "dlgCancel", "dlgConfirm", "dlgDelete"])(
    "%s is translated, not falling back to English",
    (key) => {
      // These four lived only in `en`, and t() falls back to en — so every
      // confirm dialog that passed no explicit labels asked a Danish owner
      // "Are you sure?" with "Cancel" / "Delete" buttons.
      const en = resolve(key, { lang: "en" });
      const da = resolve(key, { lang: "da" });
      expect(da).toBeTruthy();
      expect(da).not.toBe(key);
      expect(da).not.toBe(en);
    },
  );
});
