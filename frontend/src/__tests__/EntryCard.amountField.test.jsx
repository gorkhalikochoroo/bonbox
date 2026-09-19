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
  it("carries no step, because a text field has no stepMismatch to dodge", () => {
    // `step="any"` existed to stop a number input rejecting 347.50 outright.
    // The field is text now (see the block at the bottom of this file), so
    // the whole class of problem is gone rather than worked around.
    renderCard();
    expect(field().hasAttribute("step")).toBe(false);
  });

  it("accepts øre in the owner's own notation", () => {
    renderCard({ amount: "347,50" });
    expect(addButton()).toBeEnabled();
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
// It used to live in the input TYPE. type="number" sanitised anything that was
// not a canonical number to "", and the note here said so, and warned that
// switching to text would remove the only thing standing between a typo and
// the ledger "unless something stricter replaces it" — naming parseLocaleAmount
// as explicitly NOT that parser, since it salvages.
//
// That exit condition fired on 2026-09-20. The type was never the guard it was
// credited as: typing "1.500,50" into the live Expenses field on an
// English-locale browser produced value === "1.50050", validity.badInput
// FALSE, parseFloat 1.5005 — positive, so the gate went green and a Dane's
// 1.500,50 kr would have been booked as 1,50 kr. Fail-closed it was not; it
// was fail-silent, in the direction of a thousandfold error.
//
// So the guarantee moved to where it can actually be enforced: the field is
// text, and parseMoneyInput — the STRICT parser, not the salvager — reads it
// in the account's notation. The tests below are the ones that matter now.
describe("the parser is the validator", () => {
  it("is a text field, so the browser cannot rewrite the keystrokes", () => {
    renderCard();
    expect(field()).toHaveAttribute("type", "text");
  });

  it("refuses the exact string the old number field produced", () => {
    // "1.50050" — what the browser handed over when a Dane typed 1.500,50.
    renderCard({ amount: "1.50050" });
    expect(addButton()).toBeDisabled();
  });

  it("still refuses the salvageable junk the old note was written about", () => {
    // Each of these lit the button green under parseFloat, and would light it
    // green under parseLocaleAmount too. The strict parser returns NaN.
    for (const junk of ["347-50", "1.234.56", "12,34,56", "1,234"]) {
      const { unmount } = renderCard({ amount: junk });
      expect(addButton(), `${junk} must not unlock submit`).toBeDisabled();
      unmount();
    }
  });

  it("says why, instead of sitting inert", () => {
    // The old field's refusal was invisible: the browser emptied the box and
    // nothing explained it. A refusal the owner cannot see is indistinguishable
    // from a field that is ignoring them.
    renderCard({ amount: "347-50" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
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
