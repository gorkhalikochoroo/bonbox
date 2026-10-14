// @vitest-environment node
/**
 * The staff portal's stylesheet (src/styles/staffPortal.css) — the iPad
 * layout's ~175 tablet: / pad: / pad-wide: rules, moved OUT of index.css so no
 * owner page downloads them. Built here exactly as Vite builds it: Tailwind,
 * then scripts/postcss-staff-portal-css.js, on the real files.
 *
 * What must hold:
 *   • it carries ONLY variant rules — no second copy of px-4 / flex / … that
 *     would re-win cascade fights index.css settles;
 *   • every iPad class the two pages use is in it;
 *   • its theme variables are the ones those rules use, nothing more;
 *   • the keyboard focus ring (unlayered) survives the trim;
 *   • any other stylesheet passes through the plugin untouched;
 *   • index.css emits no iPad rule at all;
 *   • both pages import it, and both are lazy chunks — so it always loads
 *     AFTER index.css (its rules must come later in the utilities layer).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { describe, expect, it } from "vitest";
import staffPortalCss, { STAFF_PORTAL_CSS } from "../../scripts/postcss-staff-portal-css.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..");
const read = (...p) => readFileSync(join(SRC_DIR, ...p), "utf8");

async function build(file) {
  const out = await postcss([tailwindcss({ base: SRC_DIR }), staffPortalCss()]).process(readFileSync(file, "utf8"), { from: file });
  return out.root;
}
const inLayer = (node, name) => {
  for (let n = node.parent; n; n = n.parent) if (n.type === "atrule" && n.name === "layer" && n.params.trim() === name) return true;
  return false;
};
// The classes the pages carry, as Tailwind's selector escapes them.
const padClassesIn = (src) => new Set([...src.matchAll(/(?<![\w-])((?:pad-wide|pad|tablet)(?::[\w-]+)*:[^\s"'`{}]+)/g)].map((m) => m[1]));

describe("src/styles/staffPortal.css — the staff portal's own stylesheet", async () => {
  const root = await build(STAFF_PORTAL_CSS);
  const rules = [];
  const insideRule = (node) => { for (let n = node.parent; n; n = n.parent) if (n.type === "rule") return true; return false; };
  root.walkRules((r) => { if (inLayer(r, "utilities") && !insideRule(r)) rules.push(r); });
  const selectors = rules.map((r) => r.selector);

  it("carries only tablet: / pad: / pad-wide: rules — no second copy of a base utility", () => {
    expect(rules.length).toBeGreaterThan(150);
    for (const sel of selectors) expect(sel).toMatch(/\.(?:[\w-]+\\:)*(?:tablet|pad|pad-wide)\\:/);
    const text = root.toString();
    for (const base of [".px-4 ", ".px-4{", ".flex{", ".flex {", ".hidden{", ".hidden {", ".rounded-xl{", ".rounded-xl {"]) expect(text).not.toContain(base);
  });

  it("has a rule for the iPad classes the pages lean on (sidebar, columns, sheets, Split View, touch targets)", () => {
    const want = [
      ".pad\\:w-\\[calc\\(14rem\\+env\\(safe-area-inset-left\\)\\)\\]",
      ".pad\\:max-w-\\[720px\\]",
      ".pad-wide\\:grid",
      ".pad-wide\\:col-start-2",
      ".tablet\\:max-w-lg",
      ".tablet\\:items-end",
      ".tablet\\:pointer-coarse\\:min-h-\\[44px\\]\\!",
      ".pad\\:min-h-11",
      ".pad\\:items-center",
    ];
    for (const sel of want) expect(selectors).toContain(sel);
  });

  it("covers every tablet: / pad: / pad-wide: class written in the two pages", () => {
    const used = new Set([...padClassesIn(read("pages", "StaffPortalPage.jsx")), ...padClassesIn(read("pages", "JoinPage.jsx"))]);
    const css = root.toString();
    const missing = [...used].filter((c) => {
      const esc = "." + c.replace(/[^\w-]/g, (ch) => `\\${ch}`);
      return !css.includes(esc);
    });
    // A few tokens are prose in comments ("(pad-wide:)", "pad:flex-1).") —
    // not classes. Anything else missing would be an unstyled iPad element.
    const prose = (c) => /[),.;]$/.test(c) || /:[^a-z[-]/.test(c);
    expect(missing.filter((c) => !prose(c))).toEqual([]);
    // …and the nested hover rule (unoptimised output nests it) is kept.
    expect(css).toContain("pad\\:hover\\:bg-\\[rgb\\(15_23_42\\/0\\.04\\)\\]");
    expect(css).toMatch(/&:hover|:hover/);
  });

  it("keeps only the theme variables its rules use", () => {
    const used = new Set();
    root.walkDecls((d) => { if (inLayer(d, "utilities")) for (const m of d.value.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]); });
    const theme = new Map();
    root.walkDecls((d) => { if (inLayer(d, "theme") && d.prop.startsWith("--")) theme.set(d.prop, d.value); });
    expect(theme.size).toBeGreaterThan(0);
    expect(theme.size).toBeLessThan(30); // the full default theme is ~400
    // Everything kept is reached from the rules (directly, or through a
    // kept variable's own value).
    for (let grew = true; grew;) {
      grew = false;
      for (const v of [...used]) for (const m of String(theme.get(v) || "").matchAll(/var\((--[\w-]+)/g)) if (!used.has(m[1])) { used.add(m[1]); grew = true; }
    }
    for (const v of theme.keys()) expect(used.has(v)).toBe(true);
    let keyframes = 0;
    root.walkAtRules("keyframes", () => { keyframes += 1; });
    expect(keyframes).toBe(0); // no rule here animates
  });

  it("keeps the keyboard focus ring, unlayered", () => {
    let ring = null;
    root.walkRules((r) => { if (r.selector.includes("data-portal-scroller")) ring = r; });
    expect(ring).not.toBeNull();
    expect(inLayer(ring, "utilities") || inLayer(ring, "base")).toBe(false);
    expect(ring.toString()).toContain("outline: 2px solid #16a34a");
  });

  it("leaves every other stylesheet alone — and index.css emits no iPad rule", async () => {
    const index = await build(join(SRC_DIR, "index.css"));
    const text = index.toString();
    expect(text).toMatch(/\.px-4\s*\{/);
    expect(text).not.toMatch(/\.(?:pad|pad-wide|tablet)\\:/);
    expect(text).not.toContain("data-portal-scroller");
  }, 30000);

  it("both pages import it, and both are lazy chunks (so it loads after index.css)", () => {
    for (const page of ["StaffPortalPage.jsx", "JoinPage.jsx"]) expect(read("pages", page)).toContain('import "../styles/staffPortal.css";');
    const app = read("App.jsx");
    expect(app).toContain('const StaffPortalPage = lazyRetry(() => import("./pages/StaffPortalPage"));');
    expect(app).toContain('const JoinPage = lazyRetry(() => import("./pages/JoinPage"));');
    expect(app).not.toMatch(/^import\s+StaffPortalPage|^import\s+JoinPage/m);
  });
});
