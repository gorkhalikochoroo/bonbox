/**
 * LANDING V6 — no class name the page uses is styled by anything else
 * (PORT_PLAN 1.6 "In", port step 3).
 *
 * The page's stylesheet is scoped (landingV6CssScope.test.js), but the app's
 * stylesheets are global: a rule in index.css for a class the landing also
 * uses would land on the landing. The port found three:
 *   - .glass  — index.css's frosted bar (background, backdrop-filter,
 *               transform: translateZ(0)); the room drawing's window line used it;
 *   - .ring   — a Tailwind utility (box-shadow ring); the late table's dashed ring;
 *   - .end    — a Tailwind utility (inset-inline-end); the story nav at 7 / 7.
 * They are .lp6-glass, .lp6-ring and .lp6-end on the page now.
 *
 * Tailwind writes a utility for ANY word it finds in ANY source file, so the
 * second check asks Tailwind itself (the app's index.css, compiled) which of
 * the page's class names it would turn into a rule — whether or not some file
 * happens to contain that word today.
 *
 * The page's class names are read from landingV6.css, every className="…" in
 * the v6 components, and every classList / className / querySelector string in
 * the v6 scripts (the engine toggles js, story, xing, on, b2 … at run time).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import postcss from "postcss";
import { compile } from "tailwindcss";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const FRONTEND = join(SRC, "..");
const V6 = join(SRC, "components", "landing", "v6");
const PAGE_CSS = join(V6, "landingV6.css");
const read = (p) => readFileSync(p, "utf8");

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const inKeyframes = (node) => {
  for (let p = node.parent; p; p = p.parent) if (p.type === "atrule" && /keyframes$/i.test(p.name)) return true;
  return false;
};
const classTokens = (selector) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

// ── the page's class names ──
const pageClasses = new Set(["lp6"]);
postcss.parse(read(PAGE_CSS)).walkRules((r) => {
  if (!inKeyframes(r)) classTokens(r.selector).forEach((c) => pageClasses.add(c));
});
const v6Code = walk(V6).filter((p) => /\.(jsx?|mjs)$/.test(p));
for (const file of v6Code) {
  const s = read(file);
  for (const m of s.matchAll(/className=\{?\s*["'`]([^"'`]+)["'`]/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => pageClasses.add(c));
  for (const m of s.matchAll(/\.className\s*=\s*["'`]([^"'`]+)["'`]/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => pageClasses.add(c));
  for (const m of s.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g))
    for (const q of m[1].matchAll(/["'`]([\w-]+)["'`]/g)) pageClasses.add(q[1]);
  for (const m of s.matchAll(/(?:querySelector(?:All)?|closest|matches)\(\s*["'`]([^"'`]+)["'`]/g)) classTokens(m[1]).forEach((c) => pageClasses.add(c));
}

describe("landing v6 — the page's class names", () => {
  it("are read from the stylesheet and the v6 components (the generated room drawing included)", () => {
    expect(pageClasses.size).toBeGreaterThan(200);
    for (const c of ["story", "xing", "frame", "room-svg", "lp6-glass", "lp6-ring", "lp6-end", "t", "L", "seat"]) expect(pageClasses.has(c), c).toBe(true);
    for (const c of ["glass", "ring", "end"]) expect(pageClasses.has(c), c).toBe(false);
  });
});

describe("landing v6 — no other stylesheet in src/ styles the page's classes", () => {
  it("no rule in any other .css under src/ names a class the page uses", () => {
    const sheets = walk(SRC).filter((p) => p.endsWith(".css") && p !== PAGE_CSS);
    expect(sheets.map((p) => relative(SRC, p))).toContain("index.css");
    const hits = [];
    for (const file of sheets) {
      postcss.parse(read(file)).walkRules((r) => {
        if (inKeyframes(r)) return;
        for (const c of classTokens(r.selector)) if (pageClasses.has(c)) hits.push(`${relative(SRC, file)}:${r.source.start.line} ${r.selector} (.${c})`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("index.css still has its own .glass (so the rename is still needed, not stale)", () => {
    expect(read(join(SRC, "index.css"))).toMatch(/^\.glass \{/m);
  });
});

describe("landing v6 — Tailwind would not write a utility for any of the page's classes", () => {
  it("the app's index.css, compiled with the page's class names as candidates, adds no rule for them", async () => {
    const compiler = await compile(read(join(SRC, "index.css")), {
      base: SRC,
      loadStylesheet: async (id, base) => {
        const path = id === "tailwindcss" ? join(FRONTEND, "node_modules", "tailwindcss", "index.css") : join(base, id);
        return { path, base: dirname(path), content: read(path) };
      },
      loadModule: async (id) => {
        throw new Error(`index.css loads no plugin or config (asked for ${id})`);
      },
    });
    const before = compiler.build([]);
    const after = compiler.build([...pageClasses]);
    const added = new Set();
    postcss.parse(after).walkRules((r) => {
      if (inKeyframes(r)) return;
      for (const c of classTokens(r.selector)) if (pageClasses.has(c)) added.add(c);
    });
    // classes the stylesheet already styled before the candidates were added are the previous test's business
    const baseline = new Set();
    postcss.parse(before).walkRules((r) => classTokens(r.selector).forEach((c) => baseline.add(c)));
    expect([...added].filter((c) => !baseline.has(c)).sort()).toEqual([]);
  });

  it("the check is live: the old names would be utilities (ring, end)", async () => {
    const compiler = await compile('@import "tailwindcss";', {
      base: SRC,
      loadStylesheet: async () => {
        const path = join(FRONTEND, "node_modules", "tailwindcss", "index.css");
        return { path, base: dirname(path), content: read(path) };
      },
    });
    const out = compiler.build(["ring", "end", "lp6-ring", "lp6-end"]);
    expect(out).toMatch(/\.ring\s*\{/);
    expect(out).toMatch(/\.end\s*\{/);
    expect(out).not.toMatch(/\.lp6-(ring|end)\s*\{/);
  });
});
