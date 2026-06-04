#!/usr/bin/env node
/**
 * Pre-commit guard — undefined-reference (ESLint `no-undef`) check on the
 * STAGED frontend source files.
 *
 * WHY THIS EXISTS
 * `npm run build` and the i18n guard do NOT catch a runtime ReferenceError.
 * On 2026-06-04 a useState variable was renamed (`publishToast` ->
 * `publishResult`) but a `{publishToast && ...}` reference was left behind in
 * the render path. The build passed, the i18n check passed, and it shipped —
 * taking /staff/schedule down with the generic "Something went wrong" boundary
 * (every render threw `ReferenceError: publishToast is not defined`). ESLint's
 * `no-undef` rule flags exactly this class of bug.
 *
 * DESIGN
 *   • Scope: only files in the staged change-set (fast; no full-repo lint).
 *   • Rule: fails ONLY on `no-undef` — never on style/other rules, so it does
 *     not trip on pre-existing lint debt or block unrelated commits.
 *   • Globals: uses the project's eslint.config.js (which sets
 *     `globals.browser`), so `window`, `document`, etc. are NOT false flags.
 *   • Graceful: if ESLint can't run for an infrastructure reason, the guard
 *     exits 0 (it must never block a commit because of its own tooling).
 *
 * Emergency bypass (whole hook): `git commit --no-verify`.
 */
const { execSync } = require("child_process");
const path = require("path");

function stagedFrontendSources() {
  let out = "";
  try {
    out = execSync("git diff --cached --name-only --diff-filter=ACM", {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => /^frontend\/src\/.*\.(jsx?|mjs)$/.test(f))
    .map((f) => f.replace(/^frontend\//, "")); // paths relative to frontend/
}

const files = stagedFrontendSources();
if (files.length === 0) process.exit(0);

const frontendDir = path.resolve(__dirname, "..");

let report;
try {
  const raw = execSync(
    `npx --no-install eslint --format json ${files
      .map((f) => JSON.stringify(f))
      .join(" ")}`,
    { cwd: frontendDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  report = JSON.parse(raw);
} catch (e) {
  // ESLint exits non-zero whenever it finds ANY lint error — its JSON report
  // is still written to stdout in that case, so parse e.stdout.
  try {
    report = JSON.parse(e.stdout || "[]");
  } catch {
    // Couldn't run or parse ESLint at all → do not block the commit.
    process.exit(0);
  }
}

const hits = report.flatMap((f) =>
  (f.messages || [])
    .filter((m) => m.ruleId === "no-undef")
    .map((m) => ({ file: f.filePath, line: m.line, message: m.message }))
);

if (hits.length === 0) {
  console.log(
    `✅ no-undef guard: 0 undefined references in ${files.length} staged frontend file(s).`
  );
  process.exit(0);
}

console.error(
  `\n❌ ESLint no-undef: ${hits.length} undefined reference(s) in staged frontend source.`
);
console.error(
  "   These crash the page with a runtime ReferenceError (build + i18n don't catch it):"
);
for (const h of hits) {
  console.error(`   ${h.file}:${h.line}  ${h.message}`);
}
console.error(
  "\n   Fix the reference (or delete the dead code), then re-stage.\n"
);
process.exit(1);
