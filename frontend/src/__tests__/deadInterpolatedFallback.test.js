/**
 * An interpolated `||` fallback behind a key that exists is dead code.
 *
 * `t("someKey") || \`Reject match: ${s.fakturanummer_formatted}?\`` reads like
 * the dialog names the faktura. It does not: t() returns the populated string
 * and the right-hand side never runs, so the owner sees the generic sentence
 * and the author's intent is lost in the diff.
 *
 * Found on the payment-matching triage, where the page's own header defines low
 * confidence as "multiple invoices at this amount, pick one" — the one screen
 * where the number is the whole point. The same shape was hiding the month on
 * the month-end bundle banner and the address on the magic-link screen, so
 * someone who mistyped their email was told "your email" and waited.
 *
 * The fix is t(key, fallback, vars) with {placeholders} in the real strings —
 * never a template literal on the right of `||`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** t("key") || `…${…}…`, allowing one line break after the `||`. */
const DEAD = /t\("([A-Za-z0-9_]+)"\)\s*\|\|\s*\n?\s*`[^`]*\$\{[^`]*`/g;

const FILES = globSync("**/*.{jsx,js}", { cwd: SRC })
  .filter((f) => !f.startsWith("__tests__/"))
  .map((f) => join(SRC, f));

describe("no interpolated fallback sits behind a translation key", () => {
  it("every t(key) || `…${…}` is gone", () => {
    const keys = readFileSync(join(SRC, "hooks", "useLanguage.jsx"), "utf8");
    const offenders = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(DEAD)) {
        // Only a defect when the key really is populated — otherwise the
        // fallback is what renders, and it is doing its job.
        if (new RegExp(`\\b${m[1]}:`).test(keys)) {
          offenders.push(
            `${file.replace(`${SRC}/`, "")}: t("${m[1]}") shadows an interpolated fallback`,
          );
        }
      }
    }
    expect(
      offenders,
      `These read as if they name their subject and do not.\n` +
        `Use t(key, fallback, vars) and put {placeholders} in the real strings:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
