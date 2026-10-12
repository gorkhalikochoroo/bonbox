/**
 * The six code boxes (mobile walk, 12 Oct 2026): a whole code arriving in one
 * box — iOS code AutoFill, Android's clipboard chip, a password manager —
 * fills the row instead of leaving one digit behind.
 */
import { describe, expect, it } from "vitest";
import { applyBoxInput, codeDigits, emptyCode, isComplete, CODE_LENGTH } from "./codeBoxes";

const row = (s) => s.padEnd(CODE_LENGTH, " ").split("").map((c) => (c === " " ? "" : c));

describe("codeDigits — the code in what was pasted", () => {
  it.each([
    ["482913", "482913"],
    ["Din kode: 482913", "482913"],
    ["Your code is 482913.", "482913"],
    ["482 913", "482913"],
    ["48-29-13", "482913"],
    ["Koden udløber om 30 minutter: 482913", "482913"],
    ["12", "12"],
    ["", ""],
    [null, ""],
  ])("%j → %j", (text, want) => {
    expect(codeDigits(text)).toBe(want);
  });

  it("a longer number is not a code: the first six of its digits, never a run cut from the middle", () => {
    expect(codeDigits("1234567")).toBe("123456");
  });
});

describe("applyBoxInput", () => {
  it("one digit: the box holds it and the next box is next", () => {
    expect(applyBoxInput(emptyCode(), 0, "4")).toEqual({ code: row("4"), focus: 1 });
    expect(applyBoxInput(row("48291"), 5, "3")).toEqual({ code: row("482913"), focus: 5 });
  });

  it("a letter or nothing clears the box and keeps the focus there", () => {
    expect(applyBoxInput(row("4"), 0, "")).toEqual({ code: emptyCode(), focus: 0 });
    expect(applyBoxInput(row("4"), 0, "a")).toEqual({ code: emptyCode(), focus: 0 });
  });

  it("the whole code inserted into the first box (AutoFill) fills all six", () => {
    const r = applyBoxInput(emptyCode(), 0, "482913");
    expect(r.code).toEqual(row("482913"));
    expect(isComplete(r.code)).toBe(true);
  });

  it("the whole code inserted into ANY box fills the row from the first box", () => {
    expect(applyBoxInput(row("12"), 3, "482913").code).toEqual(row("482913"));
  });

  it("the whole code beside a digit the box already held: the old digit is dropped", () => {
    expect(applyBoxInput(row("7"), 0, "7482913").code).toEqual(row("482913"));
    expect(applyBoxInput(row("7"), 0, "4829137").code).toEqual(row("482913"));
  });

  it("typing over a digit replaces it (caret before or after the old one)", () => {
    expect(applyBoxInput(row("12"), 0, "17")).toEqual({ code: row("72"), focus: 1 });
    expect(applyBoxInput(row("12"), 0, "71")).toEqual({ code: row("72"), focus: 1 });
    expect(applyBoxInput(row("55"), 0, "55")).toEqual({ code: row("55"), focus: 1 });
  });

  it("part of a code fills from this box on, and the focus goes to the next empty box", () => {
    expect(applyBoxInput(row("48"), 2, "291")).toEqual({ code: row("48291"), focus: 5 });
    expect(applyBoxInput(emptyCode(), 4, "913")).toEqual({ code: ["", "", "", "", "9", "1"], focus: 0 });
  });
});

describe("isComplete", () => {
  it("six digits, nothing else", () => {
    expect(isComplete(row("482913"))).toBe(true);
    expect(isComplete(row("48291"))).toBe(false);
    expect(isComplete(emptyCode())).toBe(false);
  });
});


describe("applyBoxInput — text with another number before the code", () => {
  it("takes the six-digit run, not every digit (review, 12 Oct)", () => {
    const { code } = applyBoxInput(emptyCode(), 0, "Kode 2: 482913");
    expect(code.join("")).toBe("482913");
  });
  it("a plain six-digit insert still fills the row", () => {
    expect(applyBoxInput(emptyCode(), 0, "482913").code.join("")).toBe("482913");
  });
});
