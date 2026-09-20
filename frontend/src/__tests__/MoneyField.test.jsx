/**
 * MoneyField is the field the app's keyed money boxes became, so this is the
 * WIRING test for all of them at once.
 *
 * The production defect, 2026-09-20, typing into the live Expenses amount box
 * on a browser whose locale is English — a laptop bought abroad, a Chrome
 * profile in English, ordinary in Copenhagen:
 *
 *     typed              "1.500,50"
 *     input.value        "1.50050"     ← the comma dropped, the dot kept
 *     valueAsNumber      1.5005
 *     validity.badInput  FALSE         ← no error, nothing to see
 *
 * A `parsed > 0` gate went green on that, and 1.500,50 kr was about to be
 * booked as 1,50 kr. So the field is text and parseMoneyInput reads it.
 *
 * The parser itself is already pinned by parseMoneyInput.test.js. What these
 * tests pin is the part that regresses: the FIELD being text rather than a
 * number input, and the refusal being VISIBLE rather than a dead button with
 * no explanation. They drive the component the way a person does.
 */
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import MoneyField from "../components/ui/MoneyField";
import { LanguageProvider } from "../hooks/useLanguage";

function Harness({ locale = "da-DK", initial = "" }) {
  const [v, setV] = useState(initial);
  return (
    <LanguageProvider>
      <MoneyField
        locale={locale}
        value={v}
        onChange={(e) => setV(e.target.value)}
        aria-label="amount"
      />
      <output data-testid="raw">{String(v)}</output>
    </LanguageProvider>
  );
}

const field = () => screen.getByLabelText("amount");
const type = (value) => fireEvent.change(field(), { target: { value } });
const errorShown = () => screen.queryByRole("alert") !== null;

describe("MoneyField — the field itself", () => {
  it("is text, not a number input, so the browser cannot rewrite the keystrokes", () => {
    render(<Harness />);
    expect(field().getAttribute("type")).toBe("text");
  });

  it("keeps the numeric keypad — these are till fields on a phone", () => {
    render(<Harness />);
    expect(field().getAttribute("inputmode")).toBe("decimal");
  });

  it("carries no `step` — it is meaningless on text and was only ever half a guard", () => {
    render(<Harness />);
    expect(field().hasAttribute("step")).toBe(false);
  });

  it("holds the owner's keystrokes verbatim", () => {
    render(<Harness />);
    type("1.500,50");
    expect(field().value).toBe("1.500,50");
    expect(screen.getByTestId("raw").textContent).toBe("1.500,50");
  });
});

describe("MoneyField — what it refuses, out loud", () => {
  // The exact string production handed over. It is the whole reason this
  // field exists, so it is pinned by value, not by shape.
  it("refuses the production string 1.50050 and says so", () => {
    render(<Harness />);
    type("1.50050");
    expect(errorShown()).toBe(true);
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });

  it("points aria-describedby at the message it just showed", () => {
    render(<Harness />);
    type("1.50050");
    expect(field().getAttribute("aria-describedby"))
      .toBe(screen.getByRole("alert").getAttribute("id"));
  });

  it.each([
    ["347-50", "a dash used as a separator"],
    ["1.234.56", "a one-character typo for 1.234,56"],
    ["12,34,56", "two decimal commas"],
    ["1,234", "a 3-digit tail a Dane does not mean as 1.234 kr"],
    ["abc", "not a number at all"],
  ])("refuses %s (%s)", (input) => {
    render(<Harness />);
    type(input);
    expect(errorShown()).toBe(true);
  });

  it("does not shout at an untouched box — empty is the resting state", () => {
    render(<Harness />);
    expect(errorShown()).toBe(false);
    expect(field().hasAttribute("aria-invalid")).toBe(false);
  });

  it("stops complaining once the owner clears the box", () => {
    render(<Harness />);
    type("1.50050");
    expect(errorShown()).toBe(true);
    type("");
    expect(errorShown()).toBe(false);
  });
});

describe("MoneyField — what it accepts", () => {
  it.each(["1.500,50", "347,50", "347", ",50", "1 234,56", "1.234"])(
    "accepts the real Danish amount %s",
    (input) => {
      render(<Harness />);
      type(input);
      expect(errorShown()).toBe(false);
    },
  );

  it("reads en-US notation when the ACCOUNT's currency says so", () => {
    render(<Harness locale="en-US" />);
    type("1,500.50");
    expect(errorShown()).toBe(false);
  });

  it("refuses a 3-digit tail its own locale would read as a DECIMAL", () => {
    // Under en-US the dot is the decimal point, so "1.500" would mean one and
    // a half kroner — three fraction digits, which money does not have. The
    // parser refuses it rather than picking one of the two readings. (The
    // mirror case, "1,234" under da-DK, is pinned in the refusal block above.)
    render(<Harness locale="en-US" />);
    type("1.500");
    expect(errorShown()).toBe(true);
    // And the same digits written the en-US way ARE grouping, so they pass.
    type("1,500");
    expect(errorShown()).toBe(false);
  });

  it("does not treat a typed 0 as a refusal — whether 0 is ALLOWED is the caller's rule", () => {
    // A counted cash drawer of 0 is a real answer; a sale of 0 is not. The
    // field only reports shape, so pages can differ on the rest.
    render(<Harness />);
    type("0");
    expect(errorShown()).toBe(false);
  });
});
