/**
 * Input — the only way to render a form field in BonBox.
 *
 * Before this, 94 raw <input className="..."> instances drifted across the
 * app, each inventing its own border/radius/focus/dark-mode story. Sales
 * had a green focus ring, Expenses had emerald, Faktura had blue, Settings
 * had a thicker border, BankImport had no dark mode. The result was that
 * every form felt like a different product.
 *
 * This component bakes the one true field chrome:
 *   • rounded-lg (8px — same as small chips, matches the "input radius"
 *     token in the doctrine)
 *   • 1px gray-200 border (light) / gray-700 (dark) — never colored
 *   • Focus is GRAY, not green: gray-400 ring + border-gray-400. The
 *     focus ring carries no semantic — green is reserved for success.
 *   • Invalid state shifts the border to red-300 (not red-500 — the field
 *     itself is the carrier of the error, the error TEXT below is where
 *     the user reads the actual problem).
 *
 * Prefix / suffix:
 *   For currency symbols, units (DKK), icons (mic/search), or any inline
 *   decoration. Both render inside a flex row that visually "wraps" the
 *   input so the affordance reads as part of a single control. The
 *   <input> itself becomes borderless — the wrapper carries the chrome.
 *
 * Hint vs error:
 *   • hint is the calm helper text under the field (e.g. "We never share
 *     this with revisor"). Gray-500.
 *   • error replaces the hint when present, and also flips `invalid` on
 *     so the border matches. Red-600.
 *
 * ref forwarding:
 *   Required for any form library integration (React Hook Form etc.) and
 *   for parent components that need to focus() the field programmatically
 *   (e.g. EntryCard's "tap a chip → focus the custom-amount input"
 *   interaction).
 *
 * Touch target:
 *   The global rule in index.css already bumps font-size to 16px under
 *   `pointer: coarse` to prevent iOS Safari from zooming on focus. We
 *   don't fight that here — `lg` size is for visual emphasis, not for
 *   touch compliance.
 *
 * Usage:
 *   <Input placeholder="Notes..." value={notes} onChange={...} />
 *   <Input type="number" suffix="DKK" value={amount} onChange={...} />
 *   <Input invalid error="Invalid CVR number" value={cvr} ... />
 *   <Input prefix={<Icon name="Search" size={14} />} placeholder="Search" />
 */
import React from "react";

const BASE_WRAPPER =
  "flex items-center gap-2 rounded-lg border bg-white dark:bg-gray-900 " +
  "text-gray-900 dark:text-gray-100 transition " +
  "focus-within:outline-none";

const NEUTRAL_BORDER =
  "border-gray-200 dark:border-gray-700 " +
  "focus-within:border-gray-400 dark:focus-within:border-gray-500 " +
  "focus-within:ring-1 focus-within:ring-gray-400 dark:focus-within:ring-gray-500";

const INVALID_BORDER =
  "border-red-300 dark:border-red-400/60 " +
  "focus-within:border-red-300 focus-within:ring-1 focus-within:ring-red-300 " +
  "dark:focus-within:ring-red-400/60";

const DISABLED_WRAPPER =
  "opacity-50 cursor-not-allowed bg-gray-50 dark:bg-gray-900/40";

const SIZES = {
  sm: "h-8 px-2.5 text-sm",
  md: "h-10 px-3 text-sm",
  lg: "h-12 px-4 text-base",
};

const Input = React.forwardRef(function Input(
  {
    type = "text",
    size = "md",
    prefix = null,
    suffix = null,
    invalid = false,
    hint = null,
    error = null,
    className = "",
    disabled = false,
    id = undefined,
    ...rest
  },
  ref,
) {
  const isInvalid = invalid || !!error;
  const hasDecoration = !!prefix || !!suffix;

  const wrapperClasses =
    BASE_WRAPPER + " " +
    (SIZES[size] || SIZES.md) + " " +
    (isInvalid ? INVALID_BORDER : NEUTRAL_BORDER) +
    (disabled ? " " + DISABLED_WRAPPER : "") +
    (className ? " " + className : "");

  // The bare <input> — chrome-less when wrapped, otherwise inherits the
  // wrapper's classes by virtue of being the whole element. Either way
  // it stays focusable; the wrapper renders the visual border via
  // `focus-within` so click-anywhere-in-the-row still focuses the input.
  const inputClasses =
    "flex-1 min-w-0 bg-transparent outline-none border-0 p-0 " +
    "text-gray-900 dark:text-gray-100 " +
    "placeholder-gray-400 dark:placeholder-gray-500 " +
    "disabled:cursor-not-allowed";

  // Hint/error live as a separate <p> below the field. Both get the same
  // mt-1.5 so the rhythm doesn't shift when error replaces hint.
  const messageId = id ? `${id}-msg` : undefined;
  const message = error || hint;
  const messageClass = error
    ? "text-xs text-red-600 dark:text-red-400 mt-1.5"
    : "text-xs text-gray-500 dark:text-gray-400 mt-1.5";

  return (
    <div className="w-full">
      <div className={wrapperClasses}>
        {prefix && (
          <span
            className="shrink-0 inline-flex items-center text-gray-500 dark:text-gray-400"
            aria-hidden="true"
          >
            {prefix}
          </span>
        )}
        <input
          ref={ref}
          type={type}
          id={id}
          disabled={disabled}
          aria-invalid={isInvalid || undefined}
          aria-describedby={message && messageId ? messageId : undefined}
          className={inputClasses}
          {...rest}
        />
        {suffix && (
          <span
            className="shrink-0 inline-flex items-center text-xs font-medium text-gray-500 dark:text-gray-400"
            aria-hidden="true"
          >
            {suffix}
          </span>
        )}
      </div>
      {message && (
        <p id={messageId} className={messageClass}>
          {message}
        </p>
      )}
    </div>
  );
});

export default Input;
