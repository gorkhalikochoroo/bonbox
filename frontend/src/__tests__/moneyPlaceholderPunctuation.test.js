/**
 * A money placeholder must not be followed by a full stop.
 *
 * The Danish money token this product prints ends in a period already —
 * formatOwnerMoney(1070, "DKK") is "1.070 kr." — so a sentence written as
 * "…shows {amount}." renders as "…shows 1.070 kr..".
 *
 * Found live, in the one dialog where a misread number costs the most: the
 * confirm that deletes a kladde read "This kladde shows 1.070 kr..". The same
 * shape was sitting in the Z-report scan banner ("total is 17.030 kr..") in
 * English, Danish and Turkish, and its test did not catch it because the test
 * i18n stub renders the key and the vars, never the real sentence.
 *
 * Fix in the copy, not the formatter: an em dash, a comma, or move the amount
 * off the end of the sentence. The formatter must keep the period — "kr" on
 * its own is not how a Danish owner or their revisor writes kroner.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** Placeholders that carry a formatted money value in this codebase. */
const MONEY_VARS = ["amount", "sum", "price", "cost", "balance", "beloeb"];

const FILES = [
  join(SRC, "hooks", "useLanguage.jsx"),
  ...readdirSync(join(SRC, "i18n"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(SRC, "i18n", f)),
];

describe("no translated string puts a full stop straight after a money amount", () => {
  it.each(FILES.map((f) => [f.replace(`${SRC}/`, ""), f]))("%s", (_label, file) => {
    const text = readFileSync(file, "utf8");
    const offenders = [];
    text.split("\n").forEach((line, i) => {
      MONEY_VARS.forEach((v) => {
        // "{amount}." but not "{amount}..." (an ellipsis is deliberate)
        if (new RegExp(`\\{${v}\\}\\.(?!\\.)`).test(line)) {
          offenders.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    });
    expect(
      offenders,
      `A money placeholder is followed by a full stop, which renders as "kr..".\n` +
        `Use an em dash, a comma, or move the amount off the end of the sentence:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

describe("the formatter that makes this a trap is still the one in use", () => {
  it("Danish kroner keep their period, so the copy is what has to give", async () => {
    const { formatOwnerMoney } = await import("../utils/currency");
    expect(formatOwnerMoney(1070, "DKK", { decimals: 0 })).toMatch(/kr\.$/);
  });
});
