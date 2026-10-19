/**
 * CI hardening (speed push re-gate, 19 Oct): the frontend job tolerates
 * vitest's `[vitest-worker]: Timeout calling "onTaskUpdate"` RPC flake and
 * NOTHING else. scripts/vitest-ci-verdict.mjs decides the job's exit code;
 * these cases pin that a real failure can never come out green.
 *
 * The log fixtures are the exact summary shape vitest 3.2.4 prints (and the
 * GitHub runs 116887824686 / 117942767241 showed), ANSI colours included.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLAKE, verdict } from "../../scripts/vitest-ci-verdict.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const t = (status) => ({ status, title: "x", fullName: "x", failureMessages: [] });
function report({ files = 2, perFile = 3, fail = 0, fileStatus = "passed", testStatus = "passed" } = {}) {
  const testResults = Array.from({ length: files }, (_, i) => ({
    name: `/repo/src/__tests__/f${i}.test.js`,
    status: i === 0 && fileStatus !== "passed" ? fileStatus : "passed",
    assertionResults: Array.from({ length: perFile }, (_, j) => t(i === 0 && j === 0 ? testStatus : "passed")),
  }));
  return {
    numTotalTestSuites: files, numFailedTestSuites: 0, numTotalTests: files * perFile,
    numFailedTests: fail, numPassedTests: files * perFile - fail, success: fail === 0, testResults,
  };
}

const ESC = "\x1b";
const summary = ({ files = "2 passed (2)", tests = "6 passed (6)", errors = "1 error" } = {}) =>
  [
    `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m${files}${ESC}[39m${ESC}[22m`,
    `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m${tests}${ESC}[39m${ESC}[22m`,
    errors ? `${ESC}[2m     Errors ${ESC}[22m ${ESC}[1m${ESC}[31m${errors}${ESC}[39m${ESC}[22m` : "",
    `${ESC}[2m   Duration ${ESC}[22m 703.42s`,
  ].join("\n");
const unhandled = (message) =>
  [
    `${ESC}[31m⎯⎯⎯⎯⎯⎯${ESC}[39m${ESC}[1m${ESC}[41m Unhandled Error ${ESC}[49m${ESC}[22m${ESC}[31m⎯⎯⎯⎯⎯⎯⎯${ESC}[39m`,
    `${ESC}[31m${ESC}[1mError${ESC}[22m: ${message}${ESC}[39m`,
    " ❯ Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10",
  ].join("\n");
const header = `${ESC}[31m⎯⎯⎯⎯⎯⎯${ESC}[39m${ESC}[1m${ESC}[41m Unhandled Errors ${ESC}[49m${ESC}[22m${ESC}[31m⎯⎯⎯⎯⎯⎯${ESC}[39m\nVitest caught 1 unhandled error during the test run.`;
const flakeLog = (n = 1) => [summary({ errors: n === 1 ? "1 error" : `${n} errors` }), header, ...Array(n).fill(unhandled(FLAKE))].join("\n");

describe("vitest-ci-verdict: the flake, and only the flake, is tolerated", () => {
  it("a green run stays green", () => {
    expect(verdict({ exitCode: 0, report: null, log: "" })).toMatchObject({ code: 0, tolerated: false });
  });

  it("all tests passed + only onTaskUpdate timeouts → 0, flagged as tolerated", () => {
    expect(verdict({ exitCode: 1, report: report(), log: flakeLog(1) })).toMatchObject({ code: 0, tolerated: true });
    expect(verdict({ exitCode: 1, report: report(), log: flakeLog(2) })).toMatchObject({ code: 0, tolerated: true });
  });

  it("a failing test keeps the failure, even next to the flake", () => {
    const log = [summary({ files: "1 failed | 1 passed (2)", tests: "1 failed | 5 passed (6)" }), header, unhandled(FLAKE)].join("\n");
    expect(verdict({ exitCode: 1, report: report({ fail: 1, testStatus: "failed", fileStatus: "failed" }), log }).code).toBe(1);
    // …and even if the report were somehow clean, the log's summary still says "failed"
    expect(verdict({ exitCode: 1, report: report(), log }).code).toBe(1);
  });

  it("the report's failure counters alone keep the failure", () => {
    expect(verdict({ exitCode: 1, report: { ...report(), numFailedTests: 1 }, log: flakeLog() }).code).toBe(1);
    expect(verdict({ exitCode: 1, report: { ...report(), numFailedTestSuites: 1 }, log: flakeLog() }).code).toBe(1);
  });

  it("any other unhandled error keeps the failure", () => {
    const other = [summary(), header, unhandled("TypeError: Cannot read properties of undefined (reading 'x')")].join("\n");
    expect(verdict({ exitCode: 1, report: report(), log: other }).code).toBe(1);
    const both = [summary({ errors: "2 errors" }), header, unhandled(FLAKE), unhandled("ReferenceError: y is not defined")].join("\n");
    expect(verdict({ exitCode: 1, report: report(), log: both }).code).toBe(1);
  });

  it("an uncaught exception keeps the failure, even next to the flake (real vitest 3.2.4 output shape)", () => {
    const log = [summary({ errors: "2 errors" }), header, "⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯\nError: boom", unhandled(FLAKE)].join("\n");
    expect(verdict({ exitCode: 1, report: report(), log }).code).toBe(1);
    const alone = [summary(), header, "⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯\nError: boom"].join("\n");
    expect(verdict({ exitCode: 1, report: report(), log: alone }).code).toBe(1);
  });

  it("an unhandled rejection keeps the failure", () => {
    const rej = [summary({ errors: "2 errors" }), header, unhandled(FLAKE), "⎯⎯⎯ Unhandled Rejection ⎯⎯⎯\nError: boom"].join("\n");
    expect(verdict({ exitCode: 1, report: report(), log: rej }).code).toBe(1);
  });

  it("the error count must match the flakes exactly", () => {
    const log = [summary({ errors: "2 errors" }), header, unhandled(FLAKE)].join("\n");
    expect(verdict({ exitCode: 1, report: report(), log }).code).toBe(1);
  });

  it("no report, an empty report, or a file that did not pass keeps the failure", () => {
    expect(verdict({ exitCode: 1, report: null, log: flakeLog() }).code).toBe(1);
    expect(verdict({ exitCode: 1, report: { testResults: [], numTotalTests: 0 }, log: flakeLog() }).code).toBe(1);
    expect(verdict({ exitCode: 1, report: report({ fileStatus: "failed" }), log: flakeLog() }).code).toBe(1);
  });

  it("a test without a final result (vitest never heard back) keeps the failure", () => {
    expect(verdict({ exitCode: 1, report: report({ testStatus: "pending" }), log: flakeLog() }).code).toBe(1);
    const r = report();
    r.numTotalTests += 1; // the total knows a test the list does not
    expect(verdict({ exitCode: 1, report: r, log: flakeLog() }).code).toBe(1);
  });

  it("skipped and todo tests are fine", () => {
    expect(verdict({ exitCode: 1, report: report({ testStatus: "skipped" }), log: flakeLog() }).code).toBe(0);
    expect(verdict({ exitCode: 1, report: report({ testStatus: "todo" }), log: flakeLog() }).code).toBe(0);
  });

  it("other exit codes and reasons pass through unchanged", () => {
    expect(verdict({ exitCode: 1, report: report(), log: summary({ errors: "" }) }).code).toBe(1); // no Errors line
    expect(verdict({ exitCode: 130, report: report(), log: "" }).code).toBe(130);
    expect(verdict({ exitCode: Number.NaN, report: report(), log: "" }).code).toBe(1);
  });
});

describe("tests.yml wires it up without dropping vitest's own exit code", () => {
  const yml = readFileSync(join(ROOT, "..", ".github", "workflows", "tests.yml"), "utf8");
  const step = yml.slice(yml.indexOf("- name: vitest"), yml.indexOf("- name: Build"));

  it("runs vitest with a JSON report next to the console log", () => {
    expect(step).toContain("--reporter=default --reporter=json --outputFile.json=vitest-report.json");
    expect(step).toContain("| tee vitest.log");
  });

  it("hands vitest's exit code (not tee's) to the verdict, which decides the step", () => {
    expect(step).toContain("shell: bash");
    expect(step).toContain("code=${PIPESTATUS[0]}");
    expect(step).toMatch(/node scripts\/vitest-ci-verdict\.mjs vitest-report\.json vitest\.log "\$code"\s*$/m);
  });
});
