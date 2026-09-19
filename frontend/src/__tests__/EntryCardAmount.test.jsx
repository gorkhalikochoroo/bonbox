/**
 * The money-entry field must read what the owner typed, or refuse it.
 *
 * REPRODUCED ON PRODUCTION, 2026-09-20, by typing into the live Expenses
 * amount field with real keystrokes:
 *
 *     typed      "1.500,50"
 *     input.value "1.50050"      ← browser dropped the comma, kept the dot
 *     valueAsNumber 1.5005
 *     validity.badInput FALSE    ← no error, nothing to see
 *
 * parseFloat then returned 1.5005, which is > 0, so submit unlocked and a
 * Dane's 1.500,50 kr expense would be booked as 1,50 kr. A thousandfold
 * error, silent, on the product's two daily money-logging jobs.
 *
 * The field was type="number" deliberately — the repo's own note called it a
 * fail-closed guard. It is not one on an English-locale browser, which is
 * ordinary in Denmark (a laptop bought abroad, a Chrome profile in English).
 *
 * These tests drive the component the way a person does: fire a change with
 * the exact string a browser hands over, and assert what reaches onSubmit.
 */
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import EntryCard from "../components/ui/EntryCard";
import { LanguageProvider } from "../hooks/useLanguage";

function Harness({ onSubmit, locale = "da-DK", initial = "" }) {
  const [amount, setAmount] = useState(initial);
  return (
    <LanguageProvider>
      <EntryCard
        title="Add expense"
        amount={amount}
        onAmountChange={setAmount}
        amountLocale={locale}
        onSubmit={() => onSubmit(amount)}
        submitLabel="Log"
      />
    </LanguageProvider>
  );
}

const typeAmount = (value) => {
  const input = screen.getByLabelText(/amount|beløb/i);
  fireEvent.change(input, { target: { value } });
  return input;
};

describe("EntryCard amount field", () => {
  it("is a text field, so the browser cannot rewrite the keystrokes", () => {
    render(<Harness onSubmit={() => {}} />);
    const input = screen.getByLabelText(/amount|beløb/i);
    expect(input.getAttribute("type")).toBe("text");
    // The numeric keypad must survive the change — this is a till field.
    expect(input.getAttribute("inputmode")).toBe("decimal");
  });

  it("reads Danish notation as the owner meant it", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    typeAmount("1.500,50");
    fireEvent.click(screen.getByRole("button", { name: /log/i }));
    expect(onSubmit).toHaveBeenCalledWith("1.500,50");
  });

  it("unlocks submit for a Danish amount that parseFloat would have ruined", () => {
    render(<Harness onSubmit={() => {}} />);
    typeAmount("1.500,50");
    expect(screen.getByRole("button", { name: /log/i })).not.toBeDisabled();
  });

  it("refuses what it cannot read instead of guessing", () => {
    render(<Harness onSubmit={() => {}} />);
    typeAmount("1.50050");
    // Danish notation cannot mean this: two decimal separators' worth of
    // ambiguity. Refused, and said so, rather than silently booked as 1,50.
    expect(screen.getByRole("button", { name: /log/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("stays quiet on an empty field — that is the resting state, not an error", () => {
    render(<Harness onSubmit={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads US notation when the account is not Danish", () => {
    render(<Harness onSubmit={() => {}} locale="en-US" />);
    typeAmount("1,500.50");
    expect(screen.getByRole("button", { name: /log/i })).not.toBeDisabled();
  });

  it("still takes a plain integer, which is how most amounts are typed", () => {
    render(<Harness onSubmit={() => {}} />);
    typeAmount("250");
    expect(screen.getByRole("button", { name: /log/i })).not.toBeDisabled();
  });

  it("refuses zero and negatives — submit is for money that exists", () => {
    render(<Harness onSubmit={() => {}} />);
    typeAmount("0");
    expect(screen.getByRole("button", { name: /log/i })).toBeDisabled();
    typeAmount("-50");
    expect(screen.getByRole("button", { name: /log/i })).toBeDisabled();
  });
});
