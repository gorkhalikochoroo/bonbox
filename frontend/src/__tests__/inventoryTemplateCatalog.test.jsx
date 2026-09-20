/**
 * The starter-list picker is the first screen an owner with an empty lager
 * opens, and every label on it is now resolved from a key held in a config
 * object — `t(tmpl.nameKey)`, `t(CATEGORY_LABEL_KEYS[cat])` — not written as a
 * literal `t("someKey")` at the call site.
 *
 * WHY THAT NEEDS A TEST. scripts/check-i18n-keys.cjs only classifies STATIC
 * `t("literal")` calls; a key read out of an object is skipped by design. So
 * the repo's raw-key-leak guard cannot see a single one of these ~120 keys,
 * and a typo in inventoryTemplates.js would ship the key name itself as the
 * visible label ("invTmplBakeryDesc") with every lint and build still green.
 *
 * It also pins the DANISH half. t() falls back to EN and only EN, so a key
 * present in `en` and missing from `da` fails nothing — it quietly shows a
 * Danish restaurateur an English sentence, which is the exact defect this
 * catalogue was extracted to fix.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import Icon from "../components/ui/Icon";
import { LanguageProvider, useLanguage } from "../hooks/useLanguage";
import {
  CATEGORY_LABEL_KEYS,
  INVENTORY_TEMPLATES,
  categoryLabel,
} from "../config/inventoryTemplates";

function Probe({ tkey }) {
  const { t } = useLanguage();
  return <span data-testid="out">{t(tkey)}</span>;
}

const resolve = (tkey, lang) => {
  localStorage.setItem("lang", lang);
  const { unmount } = render(
    <LanguageProvider>
      <Probe tkey={tkey} />
    </LanguageProvider>,
  );
  const text = screen.getByTestId("out").textContent;
  unmount();
  return text;
};

const ALL_KEYS = [
  ...INVENTORY_TEMPLATES.flatMap((tmpl) => [tmpl.nameKey, tmpl.descKey]),
  ...Object.values(CATEGORY_LABEL_KEYS),
];

describe("every starter-list label resolves in both languages", () => {
  beforeEach(() => localStorage.clear());

  it("never serves a key name as the label", () => {
    // t() returns the KEY when nothing answers and no fallback was passed —
    // that string is what the owner would read on screen. Collected rather
    // than asserted per key so one run names every offender.
    const leaks = ALL_KEYS.flatMap((key) =>
      ["en", "da"].filter((lang) => resolve(key, lang) === key).map((lang) => `${lang}:${key}`),
    );
    expect(leaks).toEqual([]);
  });

  it("answers a Danish session in Danish", () => {
    // Descriptions, not names: "Kiosk" is correct in both languages, so an
    // identical NAME proves nothing. A full description sentence that comes
    // back byte-identical to the English one means `da` never got the key.
    const untranslated = INVENTORY_TEMPLATES.filter(
      (tmpl) => resolve(tmpl.descKey, "da") === resolve(tmpl.descKey, "en"),
    ).map((tmpl) => tmpl.type);
    expect(untranslated).toEqual([]);
  });
});

describe("the catalogue keeps its shape", () => {
  it("gives every template one Lucide icon and a unique wire type", () => {
    const types = INVENTORY_TEMPLATES.map((tmpl) => tmpl.type);
    expect(new Set(types).size).toBe(types.length);
    for (const tmpl of INVENTORY_TEMPLATES) {
      // An emoji here is the defect this catalogue replaced; a Lucide registry
      // name is ASCII. `type` is posted to /inventory/templates/load.
      expect(tmpl.icon).toMatch(/^[A-Za-z0-9]+$/);
      expect(tmpl.count).toBeGreaterThan(0);
    }
  });

  it("carries no colour field — colour on that screen would carry no status", () => {
    for (const tmpl of INVENTORY_TEMPLATES) {
      expect(tmpl).not.toHaveProperty("color");
    }
  });

  it("every icon name actually resolves in the registry", () => {
    // Same failure mode as the i18n keys above, in the icon column: Icon
    // renders a generic Circle for a name it does not know, so a typo — or a
    // Lucide name that simply was never imported into ui/Icon.jsx — ships 23
    // identical grey circles with every lint and build green. ASCII-ness (the
    // test above) says the string is not an emoji; it does not say it exists.
    const fallbacks = [];
    for (const tmpl of INVENTORY_TEMPLATES) {
      const { container, unmount } = render(<Icon name={tmpl.icon} size={18} />);
      const cls = container.querySelector("svg")?.getAttribute("class") || "";
      if (!cls || /\blucide-circle\b/.test(cls)) fallbacks.push(`${tmpl.type} → ${tmpl.icon}`);
      unmount();
    }
    expect(fallbacks).toEqual([]);
  });

  it("gives no two templates the same silhouette", () => {
    // Laundry and thrift shipped as RotateCw and RotateCcw — one circular
    // arrow mirrored, 18px, two rows apart in a list an owner scans once.
    // Repeating an icon is allowed where the meaning repeats (cafe and tea
    // shop are both Coffee); a MIRRORED pair is not, because it reads as one
    // shape that means neither trade.
    const mirrored = [["RotateCw", "RotateCcw"], ["ArrowLeft", "ArrowRight"], ["ChevronLeft", "ChevronRight"]];
    const used = new Set(INVENTORY_TEMPLATES.map((tmpl) => tmpl.icon));
    for (const [a, b] of mirrored) {
      expect(used.has(a) && used.has(b), `${a}/${b} are the same mark mirrored`).toBe(false);
    }
  });
});

describe("categoryLabel", () => {
  // A plain stub, not the provider: these three cases are about the FALLBACK
  // branch, which is invisible when a real catalogue answers every key.
  const t = (key, fallback) => (key === "general" ? "Generelt" : fallback ?? key);

  it("hands back a category the owner typed themselves, untouched", () => {
    // Guessing a translation for "Fredagsvarer" would be worse than silence.
    expect(categoryLabel(t, "Fredagsvarer")).toBe("Fredagsvarer");
  });

  it("falls back to the server string if a mapped key ever goes missing", () => {
    expect(categoryLabel(t, "Vegetables")).toBe("Vegetables");
  });

  it("treats a blank category as General", () => {
    expect(categoryLabel(t, null)).toBe("Generelt");
    expect(categoryLabel(t, "")).toBe("Generelt");
  });
});
