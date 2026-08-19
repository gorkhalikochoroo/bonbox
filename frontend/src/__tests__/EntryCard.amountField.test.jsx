/**
 * EntryCard amount field — øre must be enterable, and junk must stay rejected.
 *
 * Found on production: the field is type="number" with no `step`, so `step`
 * defaults to 1 and EVERY decimal amount is invalid by spec, in every browser.
 * Typing 347.50 raised "Please enter a valid value. The two nearest valid
 * values are 347 and 348." and blocked the Enter path. A Danish owner could not
 * key an amount with øre.
 *
 * The second half of these tests is the more important half. The field's real
 * virtue today is that it is FAIL-CLOSED: type="number" sanitises anything that
 * is not a canonical number to "", `parsed` goes NaN, and the submit button
 * stays dead. Nothing wrong can be booked through it.
 *
 * That property is easy to destroy while "improving" this field. Routing it
 * through parseLocaleAmount — the obvious move, since it is the app's Danish
 * money parser — would do exactly that: it is a SALVAGE parser scoped to speech
 * transcripts and pasted text, and it returns 123456 for "1.234.56" (a
 * one-character typo for 1.234,56), 50 for ",50", and 1808347.5 for a pasted
 * receipt line. All are > 0, so the submit gate would go green on every one.
 *
 * So: these pin that a decimal is accepted, and that noise is still refused.
 * If a future change makes the junk cases pass, it has traded a rejected input
 * for a wrong number in the books, which is the worse of the two.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LanguageProvider } from "../hooks/useLanguage";
import EntryCard from "../components/ui/EntryCard";

function renderCard(props = {}) {
  const onAmountChange = vi.fn();
  const onSubmit = vi.fn();
  const utils = render(
    <LanguageProvider>
      <EntryCard
        title="Tilføj udgift"
        amount=""
        onAmountChange={onAmountChange}
        onSubmit={onSubmit}
        {...props}
      />
    </LanguageProvider>,
  );
  return { ...utils, onAmountChange, onSubmit };
}

const field = () => screen.getByPlaceholderText(/custom amount|beløb/i);
const addButton = () => screen.getByRole("button", { name: /save|gem|tilføj|add/i });

describe("øre are enterable", () => {
  it('carries step="any" so decimals are not a stepMismatch', () => {
    renderCard();
    expect(field()).toHaveAttribute("step", "any");
  });

  it("does not pin step to a numeric value that only guards one submit path", () => {
    // handleSubmit calls preventDefault before the form submits, so a numeric
    // step would validate the Enter path and silently skip the tap path.
    renderCard();
    expect(field().getAttribute("step")).not.toMatch(/^[\d.]+$/);
  });

  it("keeps the numeric keypad on phones", () => {
    renderCard();
    expect(field()).toHaveAttribute("inputMode", "decimal");
  });
});

describe("the submit gate", () => {
  it("unlocks on a decimal amount", () => {
    renderCard({ amount: "347.50" });
    expect(addButton()).toBeEnabled();
  });

  it("unlocks on a whole amount", () => {
    renderCard({ amount: "347" });
    expect(addButton()).toBeEnabled();
  });

  it("stays locked with no amount", () => {
    renderCard({ amount: "" });
    expect(addButton()).toBeDisabled();
  });

  it("stays locked on zero", () => {
    renderCard({ amount: "0" });
    expect(addButton()).toBeDisabled();
  });

  it("stays locked on a negative amount", () => {
    renderCard({ amount: "-50" });
    expect(addButton()).toBeDisabled();
  });

  it("refuses a value that is not a number at all", () => {
    renderCard({ amount: "abc" });
    expect(addButton()).toBeDisabled();
  });
});

// ── where the fail-closed guarantee actually lives ───────────────────────
//
// Worth being precise, because it is easy to credit the wrong mechanism and
// then remove the right one. `parsed` reads the prop with parseFloat, and
// parseFloat SALVAGES: "347-50" → 347, "18-08 347,50" → 18, "347,50,25" → 347.
// Feed any of those in as a prop and the submit button lights up.
//
// Production never can, because type="number" sanitises anything that is not a
// canonical number to "" before it reaches state — verified live: typing
// "347,50" in an en-locale browser leaves value === "". The input TYPE is the
// validator; `parsed` is only a positivity check downstream of it.
//
// So changing this field to type="text" does not merely change a keyboard —
// it removes the only thing standing between a typo and the ledger, and would
// require a strict validating parser to replace it. parseLocaleAmount is NOT
// that parser (it is a salvager, by its own docblock and by measurement).
describe("the input type is the validator", () => {
  it("is type=number, which sanitises non-numeric input to empty", () => {
    renderCard();
    expect(field()).toHaveAttribute("type", "number");
  });

  it("shows that parsed alone would NOT reject salvageable junk", () => {
    // Not aspirational — this documents why the type attribute must stay
    // unless something stricter replaces it. If this ever starts failing,
    // `parsed` became strict and the type may safely be reconsidered.
    renderCard({ amount: "347-50" });
    expect(addButton()).toBeEnabled();
  });
});

describe("typing", () => {
  it("reports each keystroke to the parent", async () => {
    const user = userEvent.setup();
    const { onAmountChange } = renderCard();
    await user.type(field(), "347");
    // The card is controlled: with a static `amount` prop the field resets
    // between keystrokes, so assert it reported, not what it accumulated.
    expect(onAmountChange).toHaveBeenCalledTimes(3);
  });
});
