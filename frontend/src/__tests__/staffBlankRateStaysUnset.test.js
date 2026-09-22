/**
 * A blank wage-rate box must reach the server as NULL, never as zero kroner.
 *
 * THE DEFECT. The roster's add form on Vagtplan sent
 *
 *     base_rate: (() => { const n = parseMoneyInput(baseRate, mLocale);
 *                         return Number.isFinite(n) ? n : 0; })()
 *
 * and parseMoneyInput("") is NaN by design, so an untouched rate box stored a
 * literal 0. This is the ordinary path, not an edge: isMoneyRejected treats an
 * empty money field as the resting state (deliberately — a form that shouts at
 * an untouched box teaches owners to ignore it), so "Tilføj" is live with the
 * rate blank, and an owner who builds the roster first and sets wages later
 * got a 0 on every person.
 *
 * A stored 0 is a FACT everywhere downstream. `_pick_rate` returns it, every
 * logged shift is costed at it, GET /staff/hours/summary reports hourly_rate 0
 * rather than null, the roster card printed "Grundløn: 0 kr./t", and the Timer
 * & løn table told the owner they pay this person nothing for a real week of
 * work. null is the only honest value for a figure nobody entered — and every
 * consumer already understood it: the rate card renders "—", the summary
 * endpoint sends null, and the client cost estimators read `base_rate || 0`,
 * so no sum changes shape. 0 keeps meaning what it should: an owner typed 0.
 *
 * WHY THIS FILE READS SOURCE INSTEAD OF MOUNTING. StaffPanel and
 * StaffDetailModal are not exported from StaffSchedulePage (only MobileSchedule,
 * ScheduleGrid and ShiftModal are), and exporting a bare helper to make the
 * expression callable would add a react-refresh/only-export-components error to
 * a file that currently has none. So this pins the SHAPE of the three write and
 * read sites, in the same style as hoursNotation.test.js — and the behaviour it
 * protects is covered as real DOM one surface downstream, in
 * staffHoursEmptyRosterAndUnknownRate.test.jsx, where a null rate has to render
 * "—" instead of 0 kr.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(SRC, "pages", "StaffSchedulePage.jsx");
const src = fs.readFileSync(PAGE, "utf8");

/** The body of one function, from its declaration to the next top-level one. */
function block(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  expect(a, `${startMarker} not found — did the function get renamed?`).toBeGreaterThan(-1);
  const b = src.indexOf(endMarker, a);
  expect(b, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("POST /staff/members — the add form", () => {
  const handleAdd = block("const handleAdd = async", "const handleUpdate = async");

  it("never falls back to a number when the rate box is unreadable or blank", () => {
    // The exact expression that shipped the defect, and any respelling of it:
    // a base_rate branch whose else-arm is a numeric literal.
    const coercesToANumber = /base_rate:[\s\S]{0,600}?:\s*-?\d+(?:\.\d+)?\s*[;,)}\n]/;
    expect(
      handleAdd,
      "a rate nobody typed must not be sent as a number — use null",
    ).not.toMatch(coercesToANumber);
  });

  it("sends null for a rate nobody typed", () => {
    expect(handleAdd).toMatch(/base_rate:/);
    const payload = handleAdd.slice(handleAdd.indexOf("base_rate:"));
    expect(payload.slice(0, 600)).toMatch(/return null/);
  });
});

describe("PUT /staff/members/:id — the detail modal", () => {
  const handleUpdate = block("const handleUpdate = async", "const handleDeactivate");

  it("routes the base rate through the same null-preserving helper as the premiums", () => {
    // It used to call parseMoneyInput directly and arrive as JSON null only
    // because JSON.stringify happens to serialize NaN that way — an accident
    // that would become a 0 the day this payload was built by anything else.
    expect(handleUpdate).toMatch(/base_rate:\s*rateOrNull\(/);
    expect(handleUpdate).toMatch(/evening_rate:\s*rateOrNull\(/);
    expect(handleUpdate).toMatch(/weekend_rate:\s*rateOrNull\(/);
  });
});

describe("the edit draft that seeds that PUT", () => {
  it("does not read a deliberate 0 as an empty box", () => {
    // `member.base_rate || ""` turned a real 0 — an unpaid trial week, the
    // owner's own row — into "not set", and saving any unrelated field on that
    // form then wrote null back over it. `??` only blanks a genuine null.
    expect(src).toMatch(/base_rate:\s*member\.base_rate\s*\?\?\s*""/);
    expect(src).not.toMatch(/base_rate:\s*member\.base_rate\s*\|\|\s*""/);
  });
});

describe("the roster's rate card", () => {
  it("renders an unset rate as an em-dash, not as a figure", () => {
    expect(src).toMatch(/rates\.base\s*==\s*null[\s\S]{0,40}"—"/);
  });

  it("prints the rate through the house money formatter and the house hour unit", () => {
    // It read "185DKK/hr": the raw Numeric, no grouping, the currency CODE
    // glued to it and an English unit, on the one line of the roster that
    // states a wage.
    expect(src).not.toMatch(/\$\{rates\.base\}\$\{currency\}/);
    expect(src).toMatch(/formatOwnerMoney\(rates\.base, currency/);
    expect(src).toMatch(/hoursUnit\(lang\)/);
  });

  it("does not leave the premium chips as bare unlabelled numbers", () => {
    expect(src).not.toMatch(/Eve"\)\}:\s*\{rates\.evening\}/);
    expect(src).not.toMatch(/Wknd"\)\}:\s*\{rates\.weekend\}/);
  });
});

describe("the three rate labels", () => {
  it("carry the hour unit from utils/hours.js, not a typed English '/hr'", () => {
    expect(src).not.toMatch(/\{currency\}\/hr\)/);
    expect(src).not.toMatch(/\$\{currency\}\/hr\)/);
  });
});
