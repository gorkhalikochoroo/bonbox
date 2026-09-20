/**
 * EntryCard — the money-entry pattern, packaged.
 *
 * The shape that recurs across Sales, Expenses, CashBook, Tip-entry,
 * Waste-entry, and (soon) Faktura quick-add:
 *
 *   Title + hint
 *   ───────────────────────────────────────────
 *   [500] [1000] [2500] [5000] [7500] [10000] ...      ← amount presets
 *   [icon] [custom amount input            DKK] [Log]  ← input + submit
 *   [Cash] [MobilePay] [Card] [Bank]                    ← payment methods
 *   ── optional extras slot ──
 *   [notes input ............] [date]
 *
 * Before this, Sales.jsx and Expenses.jsx each carried their own
 * ~150-line copies of this layout, with subtly different chip widths,
 * different submit-disable logic, different mobile collapse rules. This
 * component is the one shared assembly — pages pass props for amounts,
 * presets, payment methods, extras, and submit.
 *
 * Composition (every visual element comes from a primitive):
 *   <Card> wraps everything → consistent surface
 *   <Card.Header> renders title + hint
 *   <Chip> renders every preset + payment-method tile
 *   <Input> renders the custom amount, notes, date
 *   <Button intent="primary"> renders the submit (gray-900 — doctrine)
 *
 * Extras slot:
 *   Pages that need an inline tax-breakdown, a category tree, or a
 *   custom-field row drop them into `extras`. The slot sits between
 *   payment methods and notes so it doesn't break the muscle-memory of
 *   "amount → method → notes → submit".
 *
 * Submit gating:
 *   The submit button stays disabled until `amount` parses as > 0. This
 *   is deliberately strict — if a page needs to allow zero-amount
 *   submissions (e.g. an "I forgot to track" placeholder), it should
 *   pre-flight the data and call onSubmit itself rather than relying on
 *   EntryCard to permit it.
 *
 * Mobile:
 *   • Amount + submit row stacks under <sm so the submit button is full
 *     width (easier thumb tap).
 *   • Preset and payment chips wrap (flex-wrap).
 *   • Notes + date stack vertically.
 *
 * Usage:
 *   <EntryCard
 *     title={t("sales.log_a_sale", "Log a sale")}
 *     hint={t("sales.tap_or_type", "Tap an amount or type one")}
 *     amountPresets={[500, 1000, 2500, 5000]}
 *     amount={amount} onAmountChange={setAmount}
 *     amountSuffix="DKK"
 *     paymentMethods={[
 *       { id: "cash", label: "Cash" },
 *       { id: "mobilepay", label: "MobilePay" },
 *     ]}
 *     paymentMethod={method} onPaymentChange={setMethod}
 *     notes={notes} onNotesChange={setNotes}
 *     date={saleDate} onDateChange={setSaleDate}
 *     submitLabel={t("sales.log", "Log")}
 *     onSubmit={submit}
 *     busy={submitting}
 *   />
 */
import React from "react";
import Card from "./Card";
import Button from "./Button";
import Chip from "./Chip";
import Input from "./Input";
import { useLanguage } from "../../hooks/useLanguage";
import { parseMoneyInput, moneyExample } from "../../utils/currency";

function formatPreset(v) {
  // Presets come in as numbers (500, 1000, 2500). We format with
  // thousand separators so 10000 reads as "10,000" — the user's eyes
  // shouldn't have to parse a raw digit string while picking an amount.
  if (typeof v === "number" && Number.isFinite(v)) {
    try {
      return v.toLocaleString("da-DK");
    } catch (_e) {
      return String(v);
    }
  }
  return String(v);
}

export default function EntryCard({
  title,
  hint = null,
  amountPresets = [],
  amount = "",
  onAmountChange,
  amountPlaceholder = "Custom amount...",
  amountSuffix = null,
  // The owner's own money notation. "da-DK" reads 1.500,50; "en-US" reads
  // 1,500.50. Defaulted to Danish because this is a Denmark-first product and
  // a silent wrong default here is the exact bug this prop exists to close;
  // callers pass moneyLocale(currency) so a USD account is read its way.
  amountLocale = "da-DK",
  paymentMethods = [],
  paymentMethod = null,
  onPaymentChange,
  // Opt-in, and DESKTOP-ONLY by design — see the ref effect below.
  autoFocusAmount = false,
  extras = null,
  notes = "",
  onNotesChange,
  notesPlaceholder = "Notes (optional)",
  date = null,
  onDateChange,
  submitLabel = "Save",
  onSubmit,
  busy = false,
  disabled = false,
  density = "comfortable",
  className = "",
}) {
  const { t } = useLanguage();
  // Density — opt-in `compact` tightens the card chrome (Card padding,
  // header margin, inter-row gap) for height-constrained surfaces like the
  // /expenses capture keypad. Default "comfortable" leaves every token
  // byte-identical, so the other EntryCard consumers (Sales, …) are
  // untouched. The amount Input + submit Button stay size="lg" in BOTH
  // densities — input[type=number] is NOT covered by the global coarse-
  // pointer 44px floor, so shrinking it would break the daily-typed field's
  // touch target. We only trim chrome, never the tap surfaces.
  const compact = density === "compact";
  // Amount validity — submit unlocks only when a positive number parses.
  //
  // This used to read the field with parseFloat, on the stated grounds that
  // the Input was type="number" and therefore already canonical dot-decimal.
  // The premise was false, and it cost money. Reproduced on production
  // 2026-09-20 by typing into the live Expenses field: a browser on an
  // English locale accepts "1.500,50" keystroke by keystroke, drops the
  // comma, keeps the dot, and hands over "1.50050" with validity.badInput
  // FALSE. parseFloat then returns 1.5005 — a positive number, so submit
  // unlocked and a Dane's 1.500,50 kr expense was booked as 1,50 kr. A
  // thousandfold error, silent, with the guard reporting success.
  //
  // So the field is now text and parseMoneyInput — the strict parser — reads
  // it. It is NOT parseLocaleAmount: that one salvages (it would read a bare
  // "1.234" as 1234), and a keyed money field must refuse what it cannot read
  // rather than guess at it. `amountLocale` decides whether "1.234,56" or
  // "1,234.56" is the owner's notation; callers pass moneyLocale(currency).
  const parsed = (() => {
    if (amount === "" || amount === null || amount === undefined) return NaN;
    if (typeof amount === "number") return amount;
    return parseMoneyInput(amount, amountLocale);
  })();
  // Typed something the submit gate will not take: say so rather than sit
  // inert. An empty field is not an error — it is the resting state.
  //
  // TWO failures, and they used to share one sentence. `invalidAmount` —
  // "Beløbet skal være > 0" — fired both when the parser could not READ the
  // value and when it read a real zero, so the owner who typed 1.234,50 (a
  // positive number, refused only for its shape on this account's notation)
  // was told their positive number had to be positive, in a notation nobody
  // writes on a receipt. They are now told apart at the only place that knows
  // which one happened: unreadable → say what to type, in their own money
  // notation; readable but ≤ 0 → say the amount has to be above zero.
  const amountTouched =
    amount !== "" && amount !== null && amount !== undefined;
  const amountUnreadable = amountTouched && !Number.isFinite(parsed);
  const amountNotPositive = amountTouched && Number.isFinite(parsed) && parsed <= 0;
  const amountRejected = amountUnreadable || amountNotPositive;
  const canSubmit = !disabled && !busy && parsed > 0;

  const handleSubmit = (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (canSubmit && typeof onSubmit === "function") onSubmit();
  };

  // Focus the amount field on load, but ONLY where there is no on-screen
  // keyboard to force up.
  //
  // On a phone this would be actively harmful: the keyboard would cover most
  // of the screen on arrival and push "Snap a receipt" — the genuinely faster
  // way to log an expense — out of view, making the slower path the default.
  // An owner who came to snap would have to dismiss a keyboard first.
  //
  // The check is coarse-pointer + narrow-viewport rather than a UA sniff, and
  // it respects a user who is tabbing: if something is already focused we
  // leave it alone.
  const amountRef = React.useRef(null);
  React.useEffect(() => {
    if (!autoFocusAmount) return;
    if (typeof window === "undefined") return;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    if (coarse || window.innerWidth < 640) return;
    const el = amountRef.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== el) return;
    el.focus({ preventScroll: true });
  }, [autoFocusAmount]);

  // Preset taps push the value as a string so the controlled <Input>
  // receives the exact same shape it would from user typing. This keeps
  // the parent's state machine simple — it's always a string.
  const handlePresetClick = (v) => {
    if (typeof onAmountChange === "function") {
      onAmountChange(typeof v === "number" ? String(v) : v);
    }
  };

  return (
    <Card className={className} padding={compact ? "compact" : "default"}>
      <Card.Header title={title} subtitle={hint} dense={compact} />
      <form onSubmit={handleSubmit} className={compact ? "space-y-3" : "space-y-4"}>
        {/* Amount presets — wrap on overflow, gap-2 between chips */}
        {amountPresets.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("entryCardAmountPresets", "Amount presets")}>
            {amountPresets.map((preset) => {
              const presetStr = typeof preset === "number" ? String(preset) : preset;
              const isSelected = String(amount).trim() === presetStr;
              return (
                <Chip
                  key={presetStr}
                  selected={isSelected}
                  onClick={() => handlePresetClick(preset)}
                  size="md"
                >
                  {formatPreset(preset)}
                  {amountSuffix ? " " + amountSuffix : ""}
                </Chip>
              );
            })}
          </div>
        )}

        {/* Custom amount input + submit — stacked on mobile, row on sm+ */}
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
          <div className="flex-1 min-w-0">
            <Input
              ref={amountRef}
              // TEXT, not number. A number input silently rewrites what the
              // owner typed: on an English-locale browser "1.500,50" arrives
              // as "1.50050" with no validation error, which is how a
              // 1.500,50 kr expense became 1,50 kr on production. Text keeps
              // the keystrokes intact and parseMoneyInput above decides, in
              // the owner's own notation, whether they mean anything.
              //
              // inputMode="decimal" keeps the numeric keypad on a phone, so
              // the daily-typed field loses nothing at the till. (The old
              // `step="any"` is gone with the number type: it existed only to
              // stop the browser rejecting øre, a problem text does not have.)
              type="text"
              inputMode="decimal"
              autoComplete="off"
              size="lg"
              value={amount ?? ""}
              onChange={(e) =>
                onAmountChange && onAmountChange(e.target.value)
              }
              placeholder={amountPlaceholder}
              suffix={amountSuffix}
              aria-label={t("amount", "Amount")}
              aria-invalid={amountRejected || undefined}
              aria-describedby={amountRejected ? "entrycard-amount-error" : undefined}
              required
            />
            {amountRejected && (
              <p
                id="entrycard-amount-error"
                role="alert"
                className="mt-1 text-[11px] text-red-600 dark:text-red-400"
              >
                {amountUnreadable
                  ? t("amountUnreadable", { example: moneyExample(amountLocale) })
                  : t("amountNotPositive")}
              </p>
            )}
          </div>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            busy={busy}
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="sm:w-auto w-full"
          >
            {submitLabel}
          </Button>
        </div>

        {/* Payment methods — chips wrap. Only render if methods provided */}
        {paymentMethods.length > 0 && (
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label={t("paymentMethod", "Payment method")}
          >
            {paymentMethods.map((m) => (
              <Chip
                key={m.id}
                selected={paymentMethod === m.id}
                onClick={() => onPaymentChange && onPaymentChange(m.id)}
                size="md"
                iconLeft={m.icon || null}
                aria-checked={paymentMethod === m.id}
                role="radio"
              >
                {m.label}
              </Chip>
            ))}
          </div>
        )}

        {/* Extras slot — tax breakdown, category tree, custom fields */}
        {extras && <div>{extras}</div>}

        {/* Notes + date — date is optional. Stacks on mobile, row on sm+ */}
        {(typeof onNotesChange === "function" ||
          typeof onDateChange === "function") && (
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            {typeof onNotesChange === "function" && (
              <div className="flex-1 min-w-0">
                <Input
                  type="text"
                  size="md"
                  value={notes ?? ""}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder={notesPlaceholder}
                  aria-label={t("notes", "Notes")}
                />
              </div>
            )}
            {typeof onDateChange === "function" && (
              <div className="sm:w-44">
                <Input
                  type="date"
                  size="md"
                  value={date ?? ""}
                  onChange={(e) => onDateChange(e.target.value)}
                  aria-label={t("date", "Date")}
                />
              </div>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}
