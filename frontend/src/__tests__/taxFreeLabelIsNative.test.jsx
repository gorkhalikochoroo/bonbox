/**
 * The tax-exempt label must be a real phrase in the jurisdiction's language.
 *
 * TaxBreakdown renders under the amount box on Sales and Expenses. Every
 * label in it comes from the per-currency jurisdiction vocabulary in
 * currency.js — "Salg inkl. moms", "Udgifter ekskl. moms", "MOMS (25%)" —
 * except one, which was assembled in the component:
 *
 *     `${taxName}-free`
 *
 * taxName for DKK is the locked token MOMS. So a Danish owner who marked a
 * sale tax-exempt got "MOMS-free": the locked Danish token welded to an
 * English suffix, on the two most-used screens in the product. A German
 * owner got "MwSt-free", a Spanish one "IVA-free".
 *
 * It survived because it is not a translation-pack string — no i18n guard
 * looks inside a template literal in a component, and the pack keys that
 * would have covered this panel (taxSummary, forSkat, momsCollected,
 * netSales) are dead: translated into six languages, rendered by nothing.
 *
 * WHAT THIS PINS: every jurisdiction that names a tax also names what an
 * exempt line is called, in its own language — not in English.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getVatTerms, TAX_RATES } from "../utils/currency";
import TaxBreakdown from "../components/TaxBreakdown";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "components", "TaxBreakdown.jsx"), "utf8");

// Currencies that actually charge tax — a 0%-rate currency returns null from
// the panel before any label renders, so it has nothing to name.
const TAXED = Object.entries(TAX_RATES)
  .filter(([, cfg]) => cfg.rate > 0)
  .map(([code]) => code);

describe("the tax-exempt label speaks the jurisdiction's language", () => {
  it("every taxed currency names its own exempt case", () => {
    const missing = TAXED.filter((code) => !getVatTerms(code).vatFree);
    expect(missing, `no vatFree for: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not weld an English suffix onto a non-English tax token", () => {
    // "VAT-free" and "GST-free" are correct English for jurisdictions whose
    // tax token IS English. The defect is the hybrid: a Danish, German,
    // Spanish, French, Dutch or Norwegian token carrying "-free".
    const hybrids = TAXED
      .map((code) => [code, getVatTerms(code)])
      .filter(([, vat]) => /-free$/.test(vat.vatFree || "") && !/^(VAT|GST|Sales Tax)$/.test(vat.vatName))
      .map(([code, vat]) => `${code}: "${vat.vatFree}"`);
    expect(hybrids, `English suffix on a non-English token — ${hybrids.join("; ")}`).toEqual([]);
  });

  it("Denmark reads Danish", () => {
    const dk = getVatTerms("DKK");
    expect(dk.vatName).toBe("MOMS");
    expect(dk.vatFree).toBe("Momsfri");
    expect(dk.vatFree).not.toMatch(/free/i);
  });

  it("the component reads the label from the vocabulary, not from concatenation", () => {
    // The fallback `${taxName}-free` may remain as a safety net, but it must
    // not be what renders: the two render sites must go through vatFreeLabel.
    const rendered = SOURCE.match(/\$\{taxName\}-free/g) || [];
    expect(
      rendered.length,
      "`${taxName}-free` should appear once, as the fallback in vatFreeLabel — not at a render site",
    ).toBe(1);
    expect(SOURCE).toMatch(/const vatFreeLabel = vat\.vatFree \|\|/);
  });
});

describe("what a Danish owner actually reads on the screen", () => {
  // Rendered, not inferred: the panel really does mount with these props on
  // SalesPage and ExpensesPage, so this measures the label rather than
  // reasoning about it.
  it("a tax-exempt sale says Momsfri, never MOMS-free", () => {
    render(
      <TaxBreakdown amount="1250" currencyCode="DKK" type="sales" isTaxExempt onTaxExemptChange={() => {}} />,
    );
    expect(screen.queryByText(/MOMS-free/i)).toBeNull();
    expect(screen.getAllByText(/Momsfri/).length).toBeGreaterThan(0);
  });

  it("a tax-exempt expense says it in Danish too", () => {
    render(
      <TaxBreakdown amount="400" currencyCode="DKK" type="expenses" isTaxExempt onTaxExemptChange={() => {}} />,
    );
    expect(screen.queryByText(/-free/i)).toBeNull();
    expect(screen.getByText(/Udgifter \(Momsfri\)/)).toBeTruthy();
  });

  it("an ordinary taxed sale is untouched by this change", () => {
    render(<TaxBreakdown amount="1250" currencyCode="DKK" type="sales" />);
    // DKK is tax-inclusive, so the panel names the two sides of the amount
    // and the MOMS line between them — none of which go through vatFree.
    // "Salg inkl. moms" renders twice — the chip beside the toggle and the
    // first row — so count rather than expecting a single node.
    expect(screen.getAllByText(/Salg inkl\. moms/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Salg ekskl\. moms/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Momsfri/)).toBeNull();
  });

  it("a German owner reads German, not MwSt-free", () => {
    render(
      <TaxBreakdown amount="1250" currencyCode="EUR_DE" type="sales" isTaxExempt onTaxExemptChange={() => {}} />,
    );
    expect(screen.queryByText(/MwSt-free/i)).toBeNull();
    expect(screen.getAllByText(/Ohne MwSt/).length).toBeGreaterThan(0);
  });
});
