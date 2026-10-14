/**
 * PostCSS plugin for src/styles/staffPortal.css — keeps that file to the
 * staff portal's OWN rules, so the owner app never downloads them.
 *
 * Why it exists: the iPad layout of the staff portal (BonBox Vagtplan and
 * /s/<token>) is ~175 Tailwind rules behind the `tablet:`, `pad:` and
 * `pad-wide:` variants. Declared in index.css, they shipped in the ONE global
 * stylesheet every owner page loads (+9.5 KB, +1.9 KB gzip). The variants now
 * live only in staffPortal.css, which the two pages that use them
 * (StaffPortalPage, JoinPage — both lazy chunks) import. index.css no longer
 * knows the variants, so it emits nothing for a `pad:` class.
 *
 * Tailwind cannot be told "only emit utilities with these variants": given
 * the two page files as sources it emits EVERY class in them, and the
 * un-prefixed ones (px-4, flex, …) are already in index.css. A second copy,
 * loaded after index.css, would re-win cascade fights index.css settles (an
 * owner page reached after the portal, a `sm:` class beaten by a re-declared
 * base one). So after Tailwind has run, for that one file:
 *   1. the utilities layer keeps only rules whose selector is a tablet: /
 *      pad: / pad-wide: class (compounds like tablet:pointer-coarse: too);
 *   2. the theme variables, @property rules, `properties` fallbacks and
 *      @keyframes Tailwind emitted for ALL the file's classes are cut to the
 *      ones those rules actually reference (transitively);
 *   3. anything left empty is removed.
 * Unlayered rules in the file (the keyboard focus ring) are untouched.
 *
 * Proven by src/__tests__/staffPortalCss.test.js, which runs Tailwind plus
 * this plugin on the real file.
 */
import { fileURLToPath } from "node:url";

export const STAFF_PORTAL_CSS = fileURLToPath(new URL("../src/styles/staffPortal.css", import.meta.url));

// `.pad\:px-8`, `.pad-wide\:grid`, `.tablet\:pointer-coarse\:min-h-…` —
// the variant may follow other variants (`.group-hover\:pad\:…`).
const VARIANT_CLASS = /\.(?:[\w-]+\\:)*(?:tablet|pad|pad-wide)\\:/;

const inLayer = (node, name) => {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === "atrule" && n.name === "layer" && n.params.trim() === name) return true;
  }
  return false;
};
// Unoptimised output (vite dev, tests) NESTS: `.pad\:hover\:x { @media … {
// &:hover { … } } }`. Only the outermost rule names the class; what is
// nested in it (even inside an at-rule) stands or falls with it.
const insideRule = (node) => {
  for (let n = node.parent; n; n = n.parent) if (n.type === "rule") return true;
  return false;
};

export default function staffPortalCss(opts = {}) {
  const file = opts.file || STAFF_PORTAL_CSS;
  return {
    postcssPlugin: "bonbox-staff-portal-css",
    OnceExit(root) {
      if (root.source?.input?.file !== file) return;

      // 1. Utilities: only the iPad-variant rules.
      root.walkRules((rule) => {
        if (!inLayer(rule, "utilities")) return;
        if (insideRule(rule)) return; // nested in a rule judged already
        if (!VARIANT_CLASS.test(rule.selector)) rule.remove();
      });

      // 2. What the kept rules use: custom properties (and what those use),
      //    animation names.
      const used = new Set();
      const anims = new Set();
      const take = (value) => {
        for (const m of String(value).matchAll(/var\(\s*(--[\w-]+)/g)) used.add(m[1]);
      };
      root.walkDecls((d) => {
        if (!inLayer(d, "utilities")) return;
        take(d.value);
        if (/^animation(-name)?$/.test(d.prop)) for (const w of d.value.split(/[\s,]+/)) anims.add(w);
      });
      const defs = new Map();
      root.walkDecls((d) => {
        if (d.prop.startsWith("--") && !inLayer(d, "utilities")) defs.set(d.prop, `${defs.get(d.prop) || ""} ${d.value}`);
      });
      for (let grew = true; grew;) {
        grew = false;
        for (const name of [...used]) {
          const before = used.size;
          take(defs.get(name) || "");
          if (used.size > before) grew = true;
        }
      }
      root.walkDecls((d) => {
        if (d.prop.startsWith("--") && !inLayer(d, "utilities") && !used.has(d.prop)) d.remove();
      });
      root.walkAtRules((at) => {
        if (at.name === "property" && !used.has(at.params.trim())) at.remove();
        else if (at.name === "keyframes" && !anims.has(at.params.trim())) at.remove();
      });

      // 3. Whatever is empty now (a statement like `@layer a, b;` has no
      //    body and is kept).
      for (let again = true; again;) {
        again = false;
        root.walk((n) => {
          if ((n.type === "rule" || n.type === "atrule") && n.nodes && n.nodes.length === 0) {
            n.remove();
            again = true;
          }
        });
      }
    },
  };
}
staffPortalCss.postcss = true;
