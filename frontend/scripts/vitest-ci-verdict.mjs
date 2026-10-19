#!/usr/bin/env node
/**
 * CI verdict for `vitest run` — tolerates ONE known runner flake and nothing
 * else (.github/workflows/tests.yml, frontend job).
 *
 * THE FLAKE. On GitHub's runners the frontend job kept failing with every
 * test green: "Test Files 388 passed (388) · Tests 5890 passed (5890) ·
 * Errors 1 error", the one error being
 *
 *     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * (jobs 116740100692, 116887824686, 117942767241; 16-19 Oct 2026). That is
 * vitest's own worker -> main RPC: the worker reports progress and waits up
 * to 60 s (birpc's fixed default, not configurable in vitest 3.2) for the
 * main process to acknowledge it. When either side's event loop is held up
 * long enough the call times out and vitest records an "unhandled error" -
 * even though the update itself is delivered and every result is counted.
 * It is not a test failing; it is the harness being slow to say "got it".
 *
 * The cause on those runs: closeTills.property.test.js ran 4,000 sequences
 * synchronously and its file took 60.3-61.1 s on the red runs (27.7-59.8 s
 * on the green ones); the worker's loop never turned, so the reply sat
 * unread past 60 s. That test now yields every 100 sequences. Reproduced
 * locally with 65 s of synchronous work (the error, every test green) and
 * gone with the same work in 1 s slices. This script is the net for the
 * next test that does the same.
 *
 * THE RULE. This script decides the job's exit code from vitest's exit code,
 * its JSON report and its console log. It turns a failure into a pass ONLY
 * when all of these hold, and otherwise returns vitest's own exit code:
 *
 *   1. the JSON report exists, parses, and lists at least one test file and
 *      one test;
 *   2. the report has 0 failed tests and 0 failed files, EVERY test file in
 *      it has status "passed" (a file that crashed or failed to import is
 *      "failed"), and EVERY test in it finished as passed, skipped or todo -
 *      a test still "pending" (vitest never heard its result) is not
 *      tolerated, so a lost progress update cannot pass as a green test;
 *   3. the log's summary has no "failed" count, and its "Errors  N error(s)"
 *      line exists, with N equal to the number of
 *      `[vitest-worker]: Timeout calling "onTaskUpdate"` errors, which is
 *      also the number of error blocks vitest printed ("Unhandled Error",
 *      "Unhandled Rejection", "Uncaught Exception").
 *
 * So any failing test, any other unhandled error or rejection (even next to
 * the flake), a missing or partial report, or an unexpected exit reason
 * still fails the job. When it does tolerate the flake it says so with a
 * ::warning:: annotation on the run, so it stays visible.
 *
 * Tests: src/__tests__/vitestCiVerdict.test.js (the rule, case by case).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FLAKE = '[vitest-worker]: Timeout calling "onTaskUpdate"';

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * @param {{ exitCode: number, report: object|null, log: string }} input
 * @returns {{ code: number, tolerated: boolean, reason: string }}
 */
export function verdict({ exitCode, report, log }) {
  const code = Number.isInteger(exitCode) ? exitCode : 1;
  if (code === 0) return { code: 0, tolerated: false, reason: "vitest passed" };
  const keep = (reason) => ({ code, tolerated: false, reason });

  if (!report || typeof report !== "object") return keep("no JSON report");
  const files = Array.isArray(report.testResults) ? report.testResults : [];
  if (files.length === 0 || !(report.numTotalTests > 0)) return keep("the report lists no tests");
  if (report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) return keep("tests failed");
  const notPassed = files.filter((f) => f?.status !== "passed");
  if (notPassed.length) return keep(`${notPassed.length} test file(s) not "passed"`);
  const FINISHED = new Set(["passed", "skipped", "todo"]);
  const tests = files.flatMap((f) => (Array.isArray(f.assertionResults) ? f.assertionResults : []));
  if (tests.length !== report.numTotalTests) return keep("the report's test list and its total disagree");
  const unfinished = tests.filter((t) => !FINISHED.has(t?.status));
  if (unfinished.length) return keep(`${unfinished.length} test(s) without a final result`);
  if (!tests.some((t) => t.status === "passed")) return keep("no test passed");

  const text = stripAnsi(log || "");
  if (/^\s*(Test Files|Tests)\s+.*\bfailed\b/m.test(text)) return keep("the summary counts failures");
  const m = text.match(/^\s*Errors\s+(\d+)\s+errors?\s*$/m);
  if (!m) return keep('no "Errors N error(s)" summary line');
  const errors = Number(m[1]);
  const flakes = count(text, FLAKE);
  // vitest heads each error "Unhandled Error", "Unhandled Rejection" or
  // "Uncaught Exception" (the plural "Unhandled Errors" is the section title).
  const blocks = (text.match(/(?:Unhandled (?:Error|Rejection)|Uncaught Exception)(?!s)/g) || []).length;
  if (flakes === 0) return keep("an error that is not the onTaskUpdate RPC timeout");
  if (errors !== flakes || blocks !== flakes) {
    return keep(`${errors} error(s), ${blocks} unhandled block(s), ${flakes} onTaskUpdate timeout(s)`);
  }
  return {
    code: 0,
    tolerated: true,
    reason: `all ${report.numTotalTests} tests in ${files.length} files passed; the only error(s): ${flakes} x ${FLAKE}`,
  };
}

// CLI: node scripts/vitest-ci-verdict.mjs <report.json> <vitest.log> <vitest exit code>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [reportPath, logPath, exitArg] = process.argv.slice(2);
  let report = null;
  let log = "";
  try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { /* keep null: vitest's code stands */ }
  try { log = readFileSync(logPath, "utf8"); } catch { /* empty log: cannot tolerate */ }
  const out = verdict({ exitCode: Number.parseInt(exitArg, 10), report, log });
  if (out.tolerated) {
    console.log(`::warning title=vitest RPC flake tolerated::${out.reason}`);
  } else if (out.code !== 0) {
    console.log(`vitest failed (exit ${out.code}): ${out.reason}`);
  }
  process.exit(out.code);
}
