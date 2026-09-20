/**
 * Deleting a kladde — the lifecycle gap the History tab left open.
 *
 * The row actions were Edit / Send / PDF / Unlock only, so an owner could not
 * remove a mistaken or self-contradictory DRAFT kasserapport. It stayed forever
 * in the exact list an owner hands to their revisor — verified live on the
 * founder's own account, which held two such drafts.
 *
 * The rules this pins:
 *   • Delete is offered for a DRAFT and never for a locked close. A locked
 *     close is regnskabsmateriale under Bogføringsloven §10; the server refuses
 *     it with 409 close_locked, and the button must not invite the attempt.
 *   • It goes through useConfirm — the ONE confirm dialog. window.confirm
 *     renders the browser's "www.bonbox.dk says…" chrome on the most
 *     compliance-sensitive screen in the product.
 *   • A refused delete SAYS so, in the row, rather than failing silently.
 *   • A draft's downloaded filename must not imply finality either.
 *
 * SOURCE guard, for the reason DailyClosePage.surfaceGuard and
 * .failurePaths are: HistoryView is not exported and sits behind a tab inside a
 * 5,500-line page, so a render test would pin the page's navigation far more
 * than it pins the rule. The catalogue half below then proves the keys the
 * guard routes through are real copy in both languages.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "pages", "DailyClosePage.jsx"), "utf8");

/** The file with comments stripped, so a rule QUOTED in a WHY-comment is never
 *  mistaken for the code that implements it. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

describe("a draft kasserapport can be deleted", () => {
  it("the History row has a delete handler that calls the server", () => {
    expect(CODE).toMatch(/const deleteDraft = async/);
    expect(CODE).toMatch(/api\.delete\(`\/daily-close\/\$\{dc\.id\}`\)/);
  });

  it("the delete button is rendered, and only for a draft", () => {
    // The button lives inside a `status === "draft"` guard. Take the slice from
    // the last draft guard before `deleteDraft(` to the call itself and require
    // nothing but JSX between them.
    const call = CODE.indexOf("deleteDraft(dc)");
    expect(call).toBeGreaterThan(-1);
    const before = CODE.slice(0, call);
    const guard = before.lastIndexOf('(dc.status || "confirmed") === "draft"');
    expect(guard).toBeGreaterThan(-1);
    expect(call - guard).toBeLessThan(400); // the guard wraps the button
  });

  it("no delete path is offered for a locked close", () => {
    // Nothing may call deleteDraft from inside a `=== "confirmed"` branch.
    const confirmedBranches = CODE.split('(dc.status || "confirmed") === "confirmed"');
    // The first chunk is everything BEFORE the first confirmed guard.
    confirmedBranches.slice(1).forEach((chunk) => {
      // Within the JSX block a confirmed guard opens, up to its next sibling
      // guard, there must be no delete.
      const block = chunk.split('(dc.status || "confirmed") === "draft"')[0];
      expect(block).not.toMatch(/deleteDraft\(/);
    });
  });

  it("it asks through useConfirm, never window.confirm", () => {
    expect(CODE).toMatch(/import \{ useConfirm \} from "\.\.\/hooks\/useConfirm"/);
    expect(CODE).toMatch(/const confirm = useConfirm\(\)/);
    expect(CODE).toMatch(/await confirm\(\{/);
    expect(CODE).not.toMatch(/window\.confirm\(/);
  });

  it("the dialog is marked destructive and carries translated copy", () => {
    const start = CODE.indexOf("const deleteDraft = async");
    const body = CODE.slice(start, start + 1400);
    expect(body).toMatch(/destructive:\s*true/);
    expect(body).toMatch(/t\(\s*"dcDeleteDraftTitle"/);
    expect(body).toMatch(/t\(\s*"dcDeleteDraftBody"/);
  });

  it("a refused delete says so in the row instead of failing silently", () => {
    const start = CODE.indexOf("const deleteDraft = async");
    const body = CODE.slice(start, start + 1400);
    // The server's own reason first (errText), the Danish fallback second.
    expect(body).toMatch(/errText\(e, t\("dcDeleteFailed"/);
    expect(body).toMatch(/setRowError\(\{/);
    // And nothing is swallowed.
    expect(body).not.toMatch(/catch\s*\{\s*\}/);
  });

  it("the list is refreshed after a successful delete", () => {
    const start = CODE.indexOf("const deleteDraft = async");
    const body = CODE.slice(start, start + 1400);
    expect(body).toMatch(/onRefresh\(\)/);
  });
});

describe("a draft's filename does not imply finality", () => {
  it("the downloaded kladde is named kasserapport_kladde_<date>.pdf", () => {
    expect(CODE).toMatch(/kasserapport_kladde_\$\{dateStr\}\.pdf/);
    expect(CODE).toMatch(/downloadPdf = async \(id, dateStr, isDraft = false\)/);
  });

  it("the row passes its own draft state to the download", () => {
    expect(CODE).toMatch(
      /downloadPdf\(dc\.id, dc\.date, \(dc\.status \|\| "confirmed"\) !== "confirmed"\)/,
    );
  });
});

/* ── The keys the guard routes through must be real copy in both languages ──
 *    A source guard pointing at a missing key is a guard that shows the owner a
 *    raw key name in a destructive dialog. */
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

describe("the delete copy is real in en and da", () => {
  beforeEach(() => localStorage.clear());

  it.each(["dcDeleteDraftTitle", "dcDeleteDraftBody", "dcDeleting", "dcDeleteFailed"])(
    "%s resolves in both languages",
    (key) => {
      for (const lang of ["en", "da"]) {
        const s = resolve(key, lang);
        expect(s).not.toBe(key); // a raw key leak
        expect(s.length).toBeGreaterThan(3);
      }
      expect(resolve(key, "da")).not.toBe(resolve(key, "en"));
    },
  );

  it("the Danish copy uses the words the owner knows", () => {
    expect(resolve("dcDeleteDraftTitle", "da").toLowerCase()).toContain("kladde");
    // The body must state the one rule that protects the record.
    expect(resolve("dcDeleteDraftBody", "da").toLowerCase()).toContain("låste");
    expect(resolve("dcDeleteDraftBody", "da").toLowerCase()).toContain("revisor");
  });
});
