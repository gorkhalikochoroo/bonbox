/**
 * Button — single source of truth for clickable actions in BonBox.
 *
 * One component. Four variants. No more inventing
 * `bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-lg` by hand.
 *
 * Variants (paired to intent, not color):
 *   • primary   — the action you want the user to take. Gray-900 on
 *                  light bg, gray-50 on dark. Quiet but confident.
 *   • accent    — the "money moment" — confirm a purchase, send to
 *                  accountant, complete a close. Emerald.
 *   • secondary — neutral acknowledgement. Cancel, dismiss, alt path.
 *   • ghost     — minimal weight, used in toolbars / row actions.
 *   • danger    — destructive: delete, void, lock account.
 *
 * Sizes: `sm` (28px), `md` (36px, default), `lg` (44px touch target).
 *
 * Loading state: `busy` boolean. Replaces children with a spinner +
 * keeps the width stable so the layout doesn't jump.
 *
 * Touch target: at `pointer: coarse` the `md` size already passes the
 * 44px floor via the global rule in index.css; the explicit `lg` is
 * for big CTAs where the visual weight needs to match.
 */
import React from "react";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium " +
  "transition-colors focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-white " +
  "dark:focus-visible:ring-offset-gray-900 disabled:opacity-50 " +
  "disabled:cursor-not-allowed disabled:pointer-events-none whitespace-nowrap";

const VARIANTS = {
  // The colour inverts for dark mode; the DISABLED treatment has to invert
  // too. Base gives every variant `disabled:opacity-50`, which works in light
  // (a dimmed gray-900 recedes against white) and fails in dark: a gray-100
  // block at 50% over a dark ground is still light, so the disabled primary
  // became the brightest element on the screen — measured on /sales, where the
  // greyed-out "Registrer" outshone every live control around it.
  // In dark it becomes a muted dark surface instead, which is what "inactive"
  // should look like on a dark ground.
  primary:
    "bg-gray-900 text-white hover:bg-gray-800 " +
    "dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white " +
    "dark:disabled:opacity-100 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 " +
    "focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100",
  accent:
    "bg-emerald-600 text-white hover:bg-emerald-700 " +
    "focus-visible:ring-emerald-600",
  secondary:
    "bg-gray-100 text-gray-800 hover:bg-gray-200 " +
    "dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 " +
    "focus-visible:ring-gray-400",
  ghost:
    "bg-transparent text-gray-700 hover:bg-gray-100 " +
    "dark:text-gray-300 dark:hover:bg-gray-800 " +
    "focus-visible:ring-gray-400",
  danger:
    "bg-red-600 text-white hover:bg-red-700 " +
    "focus-visible:ring-red-600",
};

const SIZES = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-sm",
};

const Spinner = ({ className = "" }) => (
  <svg
    className={"animate-spin h-4 w-4 " + className}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="3"
      className="opacity-25"
    />
    <path
      fill="currentColor"
      className="opacity-90"
      d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"
    />
  </svg>
);

const Button = React.forwardRef(function Button(
  {
    variant = "primary",
    size = "md",
    busy = false,
    iconLeft = null,
    iconRight = null,
    children,
    className = "",
    type = "button",
    ...rest
  },
  ref,
) {
  const classes =
    BASE + " " + (VARIANTS[variant] || VARIANTS.primary) +
    " " + (SIZES[size] || SIZES.md) +
    (className ? " " + className : "");

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-busy={busy ? "true" : undefined}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy && <Spinner />}
      {!busy && iconLeft}
      <span>{children}</span>
      {!busy && iconRight}
    </button>
  );
});

export default Button;
