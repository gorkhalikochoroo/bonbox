// EventCashupModal — "Cash up event" ticket-sheet flow (migration 015).
//
// Sudip's 30-second flow: owner taps "💰 Cash up event" on the event
// detail panel, fills quantity per tier, optionally splits by payment
// method, sees the gross + MOMS preview, taps "Log cash-up". One Sale
// row lands tagged to the event with full ticket_breakdown JSONB.
//
// UX patterns mirrored from BonBoxPolishKit.QuickSaleModal:
//   • Fixed overlay, click-outside closes, Escape closes
//   • White card with gray border, scaleIn animation
//   • Big "log" CTA at the bottom, disabled until something to log
// Plus event-specific bits:
//   • Tier rows: [label] · [price] kr · [qty input] · [live subtotal]
//   • Running gross + MOMS preview footer
//   • Optional collapsible payment split (Cash / Card / MobilePay / Online)
//
// DK terms locked: "MOMS" uppercase, "revisor" not "accountant".
// Tier labels (Voksen / Studerende / etc) are user-defined on the
// event itself and stay in whatever language the owner picked — we
// don't translate tier labels.
//
// Mobile-first: tier rows stack vertically on narrow viewports; qty
// inputs are `inputMode="numeric"` so the iOS keyboard opens to digits.

import { useEffect, useMemo, useState } from "react";
import { Wallet, Plus, Minus, X } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { formatMoney } from "../utils/currency";

export default function EventCashupModal({
  open,
  onClose,
  event,           // { id, name, ticket_tiers: [{label, price_dkk}], is_tax_exempt }
  onCashedUp,      // callback fired with the API response { sale, summary }
  currency = "DKK",
}) {
  const { t } = useLanguage();
  const tiers = useMemo(() => event?.ticket_tiers || [], [event]);

  // Per-tier qty, keyed by label (matches what we send to the backend).
  // Stored as strings so the input stays controllable while the user
  // types (parseInt on submit). Reset on open.
  const [qtyByLabel, setQtyByLabel] = useState({});
  const [showSplit, setShowSplit] = useState(false);
  const [split, setSplit] = useState({ cash: "", card: "", mobilepay: "", online: "" });
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Reset on each open so a previous attempt's state doesn't bleed in.
  // This was the source of a quiet bug in the QuickSale modal once — we
  // mirror its pattern to avoid the same trap.
  useEffect(() => {
    if (!open) return;
    const fresh = {};
    for (const tier of tiers) {
      fresh[tier.label] = "";
    }
    setQtyByLabel(fresh);
    setSplit({ cash: "", card: "", mobilepay: "", online: "" });
    setNotes("");
    setShowSplit(false);
    setError("");
    setSubmitting(false);
  }, [open, tiers]);

  // Escape closes — accessibility convention every dialog ships.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  // ── Computed totals (live preview) ────────────────────────────────
  // Recompute on every keystroke — the input set is tiny (max 6
  // tiers + 4 split fields), so no memo gymnastics needed.
  const tierRows = useMemo(() => {
    return tiers.map((tier) => {
      const qtyStr = qtyByLabel[tier.label] ?? "";
      const qty = parseInt(qtyStr, 10);
      const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
      const unit = Number(tier.price_dkk || 0);
      return {
        label: tier.label,
        unitPrice: unit,
        qty: safeQty,
        qtyStr,
        subtotal: unit * safeQty,
      };
    });
  }, [tiers, qtyByLabel]);

  const gross = useMemo(
    () => tierRows.reduce((sum, r) => sum + r.subtotal, 0),
    [tierRows],
  );

  // MOMS preview — owner-view convention (gross-incl-MOMS at 25% rate).
  // Mirrors the backend's `total_moms` calculation in event_summary so
  // the preview matches what the user sees afterward in the detail
  // panel. If the event is MOMS-fri, the entire gross is exempt and
  // MOMS = 0 — we render the "MOMS-fri" badge instead of a value.
  const isExempt = !!event?.is_tax_exempt;
  const momsPreview = useMemo(() => {
    if (isExempt) return 0;
    const rate = 0.25;
    return (gross * rate) / (1 + rate);
  }, [gross, isExempt]);

  // Payment-split sum check (frontend-side preview — the backend
  // re-validates with ±1 DKK tolerance). Match the backend rule so
  // the preview message lines up with the eventual rejection.
  const splitTotal = useMemo(() => {
    const c = parseFloat(split.cash || 0) || 0;
    const k = parseFloat(split.card || 0) || 0;
    const m = parseFloat(split.mobilepay || 0) || 0;
    const o = parseFloat(split.online || 0) || 0;
    return c + k + m + o;
  }, [split]);

  const splitProvided = splitTotal > 0;
  const splitMismatch = splitProvided && Math.abs(splitTotal - gross) > 1;

  const totalQty = useMemo(
    () => tierRows.reduce((sum, r) => sum + r.qty, 0),
    [tierRows],
  );

  const canSubmit = !submitting && totalQty > 0 && gross > 0 && !splitMismatch;

  const moneyFmt = (n) => formatMoney(n || 0, currency, { decimals: 0 });

  function setTierQty(label, value) {
    // Allow only digits, max 4 chars (bounds: 0..9999 mirrors backend).
    const sanitized = String(value).replace(/[^\d]/g, "").slice(0, 4);
    setQtyByLabel((prev) => ({ ...prev, [label]: sanitized }));
  }

  function adjustTier(label, delta) {
    const cur = parseInt(qtyByLabel[label] || 0, 10) || 0;
    const next = Math.max(0, Math.min(9999, cur + delta));
    setQtyByLabel((prev) => ({ ...prev, [label]: next === 0 ? "" : String(next) }));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");

    // Build tier_counts payload — only include rows with qty > 0 so
    // the backend's "at least one positive qty" validator passes and
    // the audit row stays tidy.
    const tier_counts = tierRows
      .filter((r) => r.qty > 0)
      .map((r) => ({ label: r.label, qty: r.qty }));

    const payload = { tier_counts };

    if (splitProvided) {
      const ps = {};
      if (parseFloat(split.cash)) ps.cash = parseFloat(split.cash);
      if (parseFloat(split.card)) ps.card = parseFloat(split.card);
      if (parseFloat(split.mobilepay)) ps.mobilepay = parseFloat(split.mobilepay);
      if (parseFloat(split.online)) ps.online = parseFloat(split.online);
      payload.payment_split = ps;
    }

    if (notes.trim()) {
      payload.notes = notes.trim().slice(0, 500);
    }

    try {
      // The parent passes a `onCashedUp` callback that does the API
      // call — this keeps the modal stateless about routing/api wiring,
      // matching how QuickSaleModal delegates submit to the consumer.
      await onCashedUp(payload);
      // Parent closes the modal on success (and refetches data).
    } catch (e) {
      setError(
        e?.response?.data?.detail ||
          t("eventCashupErrGeneric", "Couldn't log the cash-up. Try again."),
      );
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4"
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="event-cashup-title"
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl border border-gray-200 dark:border-gray-700 animate-scaleIn"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="px-5 sm:px-7 pt-6 pb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3
              id="event-cashup-title"
              className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2"
            >
              <Wallet className="w-5 h-5 text-green-600 shrink-0" aria-hidden />
              {t("eventCashupTitle", "Cash up event")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 truncate">
              {event?.name}
              {isExempt && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                  MOMS-fri
                </span>
              )}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              {t(
                "eventCashupSubtitle",
                "Enter how many of each ticket type you sold. We'll compute the gross + MOMS and log one Sale row tagged to this event.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            aria-label={t("close", "Close")}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Tier rows ──────────────────────────────────────────── */}
        <div className="px-5 sm:px-7 pb-4 space-y-2">
          {tiers.length === 0 ? (
            <div className="text-sm text-gray-500 py-6 text-center">
              {t(
                "eventCashupNoTiers",
                "This event has no ticket tiers. Edit the event to add tiers first.",
              )}
            </div>
          ) : (
            tierRows.map((row) => (
              <div
                key={row.label}
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-800 dark:text-gray-100 truncate">
                    {row.label}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {moneyFmt(row.unitPrice)} {t("eventCashupPerTicket", "per ticket")}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => adjustTier(row.label, -1)}
                    disabled={row.qty <= 0}
                    aria-label={t("eventCashupDecrement", "Decrease quantity")}
                    className="w-8 h-8 rounded-lg border border-gray-300 dark:border-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={row.qtyStr}
                    onChange={(e) => setTierQty(row.label, e.target.value)}
                    placeholder="0"
                    aria-label={t("eventCashupQtyLabel", "Quantity sold")}
                    className="w-14 h-8 px-2 text-center rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-semibold text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    type="button"
                    onClick={() => adjustTier(row.label, 1)}
                    aria-label={t("eventCashupIncrement", "Increase quantity")}
                    className="w-8 h-8 rounded-lg border border-gray-300 dark:border-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 w-20 text-right tabular-nums">
                  {row.qty > 0 ? moneyFmt(row.subtotal) : "—"}
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Optional payment split ─────────────────────────────── */}
        {tiers.length > 0 && (
          <div className="px-5 sm:px-7 pb-3">
            <button
              type="button"
              onClick={() => setShowSplit((s) => !s)}
              className="text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 underline underline-offset-2"
            >
              {showSplit
                ? t("eventCashupHideSplit", "Hide payment split")
                : t("eventCashupShowSplit", "+ Split by payment method (optional)")}
            </button>
            {showSplit && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <SplitInput
                  label={t("paymentCash", "Cash")}
                  value={split.cash}
                  onChange={(v) => setSplit({ ...split, cash: v })}
                />
                <SplitInput
                  label={t("paymentCard", "Card")}
                  value={split.card}
                  onChange={(v) => setSplit({ ...split, card: v })}
                />
                <SplitInput
                  label="MobilePay"
                  value={split.mobilepay}
                  onChange={(v) => setSplit({ ...split, mobilepay: v })}
                />
                <SplitInput
                  label={t("paymentOnline", "Online")}
                  value={split.online}
                  onChange={(v) => setSplit({ ...split, online: v })}
                />
                {splitMismatch && (
                  <div className="col-span-2 text-xs text-red-600 dark:text-red-400 mt-1">
                    {t("eventCashupErrSplit", "Payment split must sum to {gross} kr.", {
                      gross: moneyFmt(gross),
                    })}{" "}
                    <span className="text-gray-500">
                      ({t("eventCashupSplitCurrent", "currently")} {moneyFmt(splitTotal)})
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Notes (optional, tucked under payment split) ───────── */}
        {tiers.length > 0 && (
          <div className="px-5 sm:px-7 pb-3">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 500))}
              placeholder={t(
                "eventCashupNotesPlaceholder",
                "Notes (optional) — e.g. door takings + advance Billetto",
              )}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        )}

        {/* ── Footer: gross + MOMS preview + CTA ─────────────────── */}
        <div className="border-t border-gray-200 dark:border-gray-800 px-5 sm:px-7 py-4 bg-gray-50 dark:bg-gray-800/40 rounded-b-2xl">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t("eventCashupGrossLabel", "Gross")}
            </span>
            <span className="text-xl font-bold text-gray-900 dark:text-white tabular-nums">
              {moneyFmt(gross)}
            </span>
          </div>
          {!isExempt && (
            <div className="flex items-baseline justify-between text-xs text-gray-500 dark:text-gray-400 mb-3">
              <span>
                {t("eventCashupMomsPreview", "MOMS (25%, owner view)")}
              </span>
              <span className="tabular-nums">{moneyFmt(momsPreview)}</span>
            </div>
          )}
          {isExempt && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              {t("eventCashupExemptHint", "Tax-exempt event — no MOMS will be applied to this sale.")}
            </div>
          )}

          {error && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-xs">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting
              ? t("eventCashupSubmitting", "Logging…")
              : t("eventCashupLogButton", "Log cash-up")}
          </button>
          <p className="mt-2 text-[11px] text-center text-gray-400 dark:text-gray-500">
            {t(
              "eventCashupFooterHint",
              "One Sale row will be created with a sequential bilagsnummer and full revisor-grade audit trail.",
            )}
          </p>
        </div>
      </div>
    </div>
  );
}


// ── Sub-components ───────────────────────────────────────────────────


function SplitInput({ label, value, onChange }) {
  return (
    <label className="text-xs">
      <span className="block text-gray-500 dark:text-gray-400 mb-1">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
        placeholder="0"
        className="w-full px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </label>
  );
}
