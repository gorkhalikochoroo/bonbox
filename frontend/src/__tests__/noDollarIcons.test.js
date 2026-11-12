// BonBox is kroner-first: no icon may draw a dollar sign (Manoj, 12 Nov 2026 —
// "no dollar sign" on Udgifter, then again on the Today dashboard's MOMS card).
//
// Lucide's `Receipt` draws a "$" inside the receipt; the DollarSign family
// draws it outright. Use `ReceiptText` (lines, no currency) — a direct import
// may alias it (`ReceiptText as Receipt`) so JSX stays unchanged — and
// Banknote / Coins / Wallet for money.
//
// This scans every source file's lucide-react import blocks and checks the
// IMPORTED name (left of "as"), plus the shared Icon map, so the "$" cannot
// come back through a new page or a refactor.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOLLAR_ICONS = new Set([
  "Receipt",
  "DollarSign",
  "CircleDollarSign",
  "BadgeDollarSign",
  "SquareDollarSign",
  "FileDollarSign",
  "LucideReceipt",
  "ReceiptIcon",
]);

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

function importedLucideNames(code) {
  const names = [];
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    for (const raw of m[1].split(",")) {
      const spec = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
      if (!spec) continue;
      names.push(spec.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

describe("no dollar-sign icons (kroner-first)", () => {
  it("no source file imports a lucide icon that draws a $", () => {
    const offenders = [];
    for (const f of sourceFiles(SRC)) {
      const code = fs.readFileSync(f, "utf8");
      for (const n of importedLucideNames(code)) {
        if (DOLLAR_ICONS.has(n)) offenders.push(`${path.relative(SRC, f)}: ${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the shared Icon map renders name="Receipt" as ReceiptText', () => {
    const code = fs.readFileSync(path.join(SRC, "components/ui/Icon.jsx"), "utf8");
    expect(code).toMatch(/Receipt:\s*ReceiptText/);
    expect(importedLucideNames(code)).not.toContain("Receipt");
  });

  it("the scan itself catches a plain Receipt import (guard against a silent pass)", () => {
    expect(importedLucideNames('import { Moon, Receipt, Send } from "lucide-react";')).toContain("Receipt");
    expect(importedLucideNames('import { ReceiptText as Receipt } from "lucide-react";')).toEqual(["ReceiptText"]);
  });
});
