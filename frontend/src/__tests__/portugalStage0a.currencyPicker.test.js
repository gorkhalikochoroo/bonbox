/**
 * Portugal plan, Stage 0a — the Profile currency picker offers only what saves.
 *
 *   1. The EUR_PT/DE/FR/ES/IT/NL options are gone: the server only takes plain
 *      codes (schemas/auth.py SUPPORTED_CURRENCIES), so picking one answered
 *      422 and nothing was saved. Every option left must be one the server
 *      accepts.
 *   2. Plain EUR said "VAT 20%" while every calculation uses 21 %
 *      (TAX_RATES.EUR here, VAT_RATES["EUR"] in tax_service.py and reports.py).
 *      The label now shows the rate the numbers are computed with.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TAX_RATES } from "../utils/currency";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = readFileSync(join(HERE, "..", "pages", "ProfilePage.jsx"), "utf8");
const SCHEMA = readFileSync(
  join(HERE, "..", "..", "..", "backend", "app", "schemas", "auth.py"), "utf8");

const pickerOptions = () => {
  const start = PROFILE.indexOf('t("currencyLabel")');
  const block = PROFILE.slice(start, PROFILE.indexOf("</select>", start));
  return [...block.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)]
    .map(([, value, label]) => ({ value, label }));
};

const serverCurrencies = () => {
  const m = SCHEMA.match(/SUPPORTED_CURRENCIES = frozenset\(\{([\s\S]*?)\}\)/);
  return new Set([...m[1].matchAll(/"([A-Z]{3})"/g)].map((x) => x[1]));
};

describe("Profile currency picker (Portugal Stage 0a)", () => {
  it("offers no EUR_* country variant", () => {
    const values = pickerOptions().map((o) => o.value);
    expect(values.length).toBeGreaterThan(10);
    expect(values.filter((v) => v.startsWith("EUR_"))).toEqual([]);
    expect(values.filter((v) => v === "EUR")).toEqual(["EUR"]);
  });

  it("offers only codes the server saves", () => {
    const allowed = serverCurrencies();
    expect(allowed.has("DKK")).toBe(true);
    for (const { value } of pickerOptions()) expect(allowed.has(value), value).toBe(true);
  });

  it("labels plain EUR with the rate it is computed with", () => {
    const eur = pickerOptions().find((o) => o.value === "EUR");
    const pct = Math.round(TAX_RATES.EUR.rate * 100);
    expect(pct).toBe(21);
    expect(eur.label).toBe(`EUR - Euro (General, VAT ${pct}%)`);
  });
});
