/**
 * MoneyField — a raw-chrome text input for an amount the OWNER types.
 *
 * Why this exists rather than `<input type="number">`, which is what every
 * money field in this app used to be:
 *
 * A number input does not refuse Danish notation. It rewrites it. Reproduced
 * on production 2026-09-20 by typing "1.500,50" into the live Expenses field,
 * keystroke by keystroke, on a browser whose locale is English — a laptop
 * bought abroad, a Chrome profile in English, ordinary in Copenhagen:
 *
 *     input.value        "1.50050"     the comma dropped, the dot kept
 *     valueAsNumber      1.5005
 *     validity.badInput  FALSE
 *
 * parseFloat then returns 1.5005, which is positive, so a `> 0` submit gate
 * goes green and 1.500,50 kr is booked as 1,50 kr. A thousandfold error, with
 * the guard reporting success. type="number" is not fail-closed on money; it
 * is fail-SILENT, in the worst direction.
 *
 * So: text, so the keystrokes survive; inputMode="decimal", so the till and
 * the phone still get a numeric keypad; and parseMoneyInput — the STRICT
 * parser — to read it in the account's own notation. Not parseLocaleAmount:
 * that one salvages a number out of junk ("347-50" → 34750), which is exactly
 * how a typo reaches the ledger.
 *
 * The component only reports SHAPE: a value it cannot read shows the error and
 * sets aria-invalid. Whether a readable number is *allowed* (positive, within
 * a cap, non-zero) stays with the caller, because that rule differs per field
 * — a cash count of 0 is a real answer, a sale of 0 is not.
 *
 * `locale` must come from the account CURRENCY via moneyLocale(), never from
 * the UI chrome language: a DKK café can switch the interface to English
 * mid-service and "1.234" must not change meaning when they do.
 *
 * The chrome is the caller's (`className` goes straight onto the input) because
 * these fields live inside table cells, grids and toolbars that each own their
 * sizing. For a standalone labelled field, prefer <Input> with the same
 * type/inputMode/invalid/error props — it carries the design-system chrome.
 */
import React, { useId } from "react";

import { useLanguage } from "../../hooks/useLanguage";
// isMoneyRejected lives in utils/currency.js beside the parser it wraps, not
// here: a submit gate has to import the same definition of "unreadable" that
// this field paints red, and importing it from a component file would pull a
// page's gate through the component layer (and trip react-refresh besides).
import { isMoneyRejected } from "../../utils/currency";

export default function MoneyField({
  value,
  onChange,
  locale = "da-DK",
  className = "",
  wrapperClassName = "",
  // Callers inside tight table rows can suppress the message and show the
  // refusal their own way; aria-invalid stays on either way.
  showError = true,
  id: idProp,
  ...rest
}) {
  const { t } = useLanguage();
  const autoId = useId();
  const id = idProp || `money-${autoId}`;
  const rejected = isMoneyRejected(value, locale);

  return (
    <div className={wrapperClassName || undefined}>
      <input
        id={id}
        // TEXT, never number — see the note at the top of this file. `step` is
        // deliberately absent: it is meaningless on text, and on the old number
        // field it only ever validated the native submit path anyway.
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value ?? ""}
        onChange={onChange}
        className={className}
        aria-invalid={rejected || undefined}
        aria-describedby={rejected && showError ? `${id}-err` : undefined}
        {...rest}
      />
      {rejected && showError && (
        <p
          id={`${id}-err`}
          role="alert"
          className="mt-1 text-[11px] text-red-600 dark:text-red-400"
        >
          {t("invalidAmount")}
        </p>
      )}
    </div>
  );
}
