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
  paymentMethods = [],
  paymentMethod = null,
  onPaymentChange,
  voiceInput = false,
  onVoiceClick = null,
  voiceIcon = null,
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
  // We accept "1.234,56" (DK), "1234.56" (US), and bare ints. The parent
  // is responsible for sending the value to the API in its canonical
  // form; here we only care "does this round-trip to a positive number".
  const parsed = (() => {
    if (amount === "" || amount === null || amount === undefined) return NaN;
    if (typeof amount === "number") return amount;
    const s = String(amount).trim().replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  })();
  const canSubmit = !disabled && !busy && parsed > 0;

  const handleSubmit = (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (canSubmit && typeof onSubmit === "function") onSubmit();
  };

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
              type="number"
              inputMode="decimal"
              size="lg"
              value={amount ?? ""}
              onChange={(e) =>
                onAmountChange && onAmountChange(e.target.value)
              }
              placeholder={amountPlaceholder}
              prefix={
                voiceInput && onVoiceClick ? (
                  // Voice affordance — caller passes the icon to keep this
                  // file dependency-free. The button is a real <button>
                  // (not just a span) so it's tap-targetable on its own.
                  <button
                    type="button"
                    onClick={onVoiceClick}
                    aria-label={t("voiceInput", "Voice input")}
                    className={
                      "inline-flex items-center justify-center w-6 h-6 " +
                      "rounded-md text-gray-500 hover:text-gray-900 " +
                      "dark:text-gray-400 dark:hover:text-gray-100 " +
                      "hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                    }
                  >
                    {voiceIcon}
                  </button>
                ) : null
              }
              suffix={amountSuffix}
              aria-label={t("amount", "Amount")}
              required
            />
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
