/**
 * Egenkontrol R1a — the keypad (plan "Keypad"): comma decimal, one decimal at
 * most, the minus key, a 4-digit cap (3 integer + 1 decimal), backspace, the
 * lone leading zero, and the plausibility prompt ("51" vs "5,1"). Keys are at
 * least 64 px (h-16 min-w-16) with real aria labels.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.keypad
 */
import { createElement as h } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import {
  displayEntry,
  formatTemp,
  inRange,
  isPlausible,
  nextEntry,
  parseEntry,
} from "../components/egenkontrol/ekLogic";
import Keypad from "../components/egenkontrol/Keypad";

const type = (keys, start = "") => keys.reduce((e, k) => nextEntry(e, k), start);
const tDa = (k) => da[k] ?? k;

describe("nextEntry — the keypad's rules", () => {
  it("types a comma decimal and keeps it canonical", () => {
    expect(type(["3", ",", "1"])).toBe("3,1");
    expect(type([","])).toBe("0,");
    expect(type(["-", ","])).toBe("-0,");
  });

  it("allows ONE decimal comma and ONE decimal digit", () => {
    expect(type(["3", ",", ","])).toBe("3,");
    expect(type(["3", ",", "1", "2"])).toBe("3,1");
    expect(type(["1", "2", ",", "5", "5", "5"])).toBe("12,5");
  });

  it("minus toggles a leading minus on any entry (freezers)", () => {
    expect(type(["-"])).toBe("-");
    expect(type(["1", "8", "-"])).toBe("-18");
    expect(type(["1", "8", "-", "-"])).toBe("18");
    expect(type(["-", "1", "8", ",", "5"])).toBe("-18,5");
  });

  it("caps at 4 digits: 3 integer + 1 decimal", () => {
    expect(type(["1", "2", "3", "4"])).toBe("123");
    expect(type(["1", "2", "3", ",", "4", "5"])).toBe("123,4");
    expect(type(["-", "1", "2", "3", "9"])).toBe("-123");
  });

  it("backspace removes the last character; a lone minus becomes empty", () => {
    expect(type(["3", ",", "1", "back"])).toBe("3,");
    expect(type(["3", "back"])).toBe("");
    expect(type(["-", "5", "back"])).toBe("");
    expect(type(["back"])).toBe("");
  });

  it("replaces a lone leading zero with the next digit", () => {
    expect(type(["0", "5"])).toBe("5");
    expect(type(["-", "0", "7"])).toBe("-7");
    expect(type(["0", ",", "5"])).toBe("0,5");
  });
});

describe("parseEntry", () => {
  it("is null while the entry is incomplete", () => {
    expect(parseEntry("")).toBeNull();
    expect(parseEntry("-")).toBeNull();
    expect(parseEntry("-0,")).toBeNull();
  });
  it("reads numbers rounded to 0.1", () => {
    expect(parseEntry("5,")).toBe(5);
    expect(parseEntry("3,1")).toBe(3.1);
    expect(parseEntry("-18,0")).toBe(-18);
    expect(parseEntry("0,")).toBe(0);
    expect(Object.is(parseEntry("-0"), 0)).toBe(true);
  });
  it("range is −40..120", () => {
    expect(inRange(-40)).toBe(true);
    expect(inRange(120)).toBe(true);
    expect(inRange(-40.1)).toBe(false);
    expect(inRange(999)).toBe(false);
  });
});

describe("plausibility — '51' typed for '5,1'", () => {
  it("a fridge asks above 15 °C, not at 5,1", () => {
    expect(isPlausible(51, "fridge")).toBe(false);
    expect(isPlausible(5.1, "fridge")).toBe(true);
  });
  it("a freezer asks above 0 °C", () => {
    expect(isPlausible(1, "freezer")).toBe(false);
    expect(isPlausible(-18, "freezer")).toBe(true);
  });
  it("hot holding / reheating ask below 20 °C", () => {
    expect(isPlausible(7.5, "hot_holding")).toBe(false);
    expect(isPlausible(62, "hot_holding")).toBe(true);
    expect(isPlausible(19.9, "reheating")).toBe(false);
  });
  it("receiving follows the product type", () => {
    expect(isPlausible(16, "receiving", "chilled")).toBe(false);
    expect(isPlausible(16, "receiving", "fish")).toBe(false);
    expect(isPlausible(1, "receiving", "frozen")).toBe(false);
    expect(isPlausible(4, "receiving", "chilled")).toBe(true);
  });
});

describe("formatting", () => {
  it("prints a real minus (U+2212) and the language's decimal", () => {
    expect(formatTemp(-18, "da")).toBe("−18,0 °C");
    expect(formatTemp(3.1, "da")).toBe("3,1 °C");
    expect(formatTemp(3.1, "en")).toBe("3.1 °C");
    expect(displayEntry("-3,5", "da")).toBe("−3,5");
    expect(displayEntry("-3,5", "en")).toBe("−3.5");
  });
});

describe("<Keypad>", () => {
  it("renders 13 keys of at least 64 px with aria labels, and sends each key", () => {
    const onKey = vi.fn();
    render(h(Keypad, { entry: "", onKey, lang: "da", t: tDa }));
    const keys = screen.getAllByRole("button");
    expect(keys).toHaveLength(13); // 12 grid keys + backspace
    for (const k of keys) {
      expect(k.className).toMatch(/\bh-16\b/);
      expect(k.className).toMatch(/\bmin-w-16\b/);
      expect(k.getAttribute("aria-label")).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: da.ekKeyMinus }));
    fireEvent.click(screen.getByRole("button", { name: da.ekKeyDecimal }));
    fireEvent.click(screen.getByRole("button", { name: da.ekKeyBackspace }));
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(["-", ",", "back", "7"]);
  });

  it("shows ',' in Danish and '.' in English on the decimal key", () => {
    const { unmount } = render(h(Keypad, { entry: "3,1", onKey: () => {}, lang: "da", t: tDa }));
    expect(screen.getByRole("button", { name: da.ekKeyDecimal }).textContent).toBe(",");
    expect(screen.getByTestId("ek-keypad-display").textContent).toContain("3,1");
    unmount();
    render(h(Keypad, { entry: "3,1", onKey: () => {}, lang: "en", t: tDa }));
    expect(screen.getByRole("button", { name: da.ekKeyDecimal }).textContent).toBe(".");
    expect(screen.getByTestId("ek-keypad-display").textContent).toContain("3.1");
  });
});
