/**
 * SmartPricingCard — one card per comparable inventory item.
 *
 * Renders the "Market comparison" UI for a single canonical bucket:
 *   • Your price (big number)
 *   • Neighborhood median (slightly smaller)
 *   • Percentile bar showing min · p25 · median · p75 · max with the
 *     user's marker overlaid.
 *   • A one-line interpretation ("8% below median across 12 cafés in
 *     2200 København N").
 *
 * Privacy footnote: the only individual datum on screen is the user's
 * own price — every other number is a cohort aggregate of at least 5
 * businesses. The component cannot show partial data; if the parent
 * passes available=false, we render the empty state with the gating
 * reason, never any aggregates.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency } from "../utils/currency";
import api from "../services/api";

// Snooze key — stored on localStorage keyed by canonical name so the
// owner can dismiss a "you're 8% below median" prompt for 30 days
// without us needing a backend column.  A DB migration adds risk to
// this PR; localStorage is honest about the scope (this device only).
const SNOOZE_PREFIX = "bonbox.smartPricing.snooze.";
const SNOOZE_DAYS = 30;

function isSnoozed(canonical) {
  if (!canonical || typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(SNOOZE_PREFIX + canonical);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function setSnooze(canonical) {
  if (!canonical || typeof window === "undefined") return;
  try {
    const until = Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    window.localStorage.setItem(SNOOZE_PREFIX + canonical, String(until));
  } catch {
    /* localStorage unavailable (private mode) — just no-op */
  }
}

// Translation keys for each canonical bucket — kept in the component so
// we don't have to register 26 separate translations in useLanguage for
// what's essentially a display string. Falls back to the canonical key
// (e.g. "cappuccino") if no friendly name is set.
const CANONICAL_LABELS = {
  cappuccino: "Cappuccino",
  latte: "Latte",
  espresso: "Espresso",
  americano: "Americano",
  flat_white: "Flat white",
  mocha: "Mocha",
  hot_chocolate: "Hot chocolate",
  tea: "Tea",
  juice: "Juice",
  water: "Water",
  soft_drink: "Soft drink",
  beer: "Beer",
  wine_glass: "Wine (glass)",
  croissant: "Croissant",
  pastry: "Pastry",
  sandwich: "Sandwich",
  salad: "Salad",
  soup: "Soup",
  burger: "Burger",
  pizza: "Pizza",
  pasta: "Pasta",
  brunch_plate: "Brunch plate",
  muffin: "Muffin",
  cookie: "Cookie",
  brownie: "Brownie",
  cake_slice: "Cake slice",
};

const CANONICAL_EMOJI = {
  cappuccino: "☕", latte: "☕", espresso: "☕", americano: "☕",
  flat_white: "☕", mocha: "☕", hot_chocolate: "🍫", tea: "🍵",
  juice: "🧃", water: "💧", soft_drink: "🥤", beer: "🍺",
  wine_glass: "🍷",
  croissant: "🥐", pastry: "🥐", sandwich: "🥪", salad: "🥗",
  soup: "🍲", burger: "🍔", pizza: "🍕", pasta: "🍝",
  brunch_plate: "🍳",
  muffin: "🧁", cookie: "🍪", brownie: "🍫", cake_slice: "🍰",
};

function labelFor(canonical) {
  return CANONICAL_LABELS[canonical] || canonical || "Item";
}

function emojiFor(canonical) {
  return CANONICAL_EMOJI[canonical] || "💰";
}

function fmt(n) {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}

/**
 * Compute the marker position on the 0..100% percentile bar given a
 * value and the cohort min..max. We clamp at the edges so a very-low
 * or very-high outlier doesn't overflow the bar visually.
 */
function markerPercent(value, min, max) {
  if (value == null || min == null || max == null) return null;
  if (max === min) return 50;
  const pct = ((value - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, pct));
}

export default function SmartPricingCard({ comparison, currencyCode, onApplied }) {
  const { t } = useLanguage();
  // Task #204 P2.7 — gate the inline Apply CTA on entitlements being
  // ready.  Without `isReady`, the button briefly renders for trial
  // users while their plan resolves — same trial-flicker bug we
  // squashed in commit ee80e93.
  const entitlements = useEntitlements();
  const entReady = entitlements?.isReady !== false;
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [appliedAt, setAppliedAt] = useState(0);
  const [snoozed, setSnoozed] = useState(
    () => !!comparison && isSnoozed(comparison.canonical_name),
  );

  if (!comparison) return null;
  if (snoozed) return null;

  const canonical = comparison.canonical_name;
  const currency = displayCurrency(currencyCode || comparison.currency);
  const label = labelFor(canonical);
  const emoji = emojiFor(canonical);

  // Available = false branch — render a clearly-labelled empty card.
  if (!comparison.available) {
    let msg;
    if (comparison.reason === "not_enough_data") {
      msg = (t("smartPricingNotEnoughData") || "Not enough data yet — we need {n} businesses.")
        .replace("{n}", comparison.min_samples || 5);
    } else if (comparison.reason === "needs_setup") {
      msg = t("smartPricingNeedsSetup") || "Set postal + cuisine on Profile.";
    } else if (comparison.reason === "unknown_item") {
      msg = t("smartPricingUnknownItem") || "No market bucket for this item.";
    } else {
      msg = t("smartPricingTempUnavailable") || "Couldn't load right now.";
    }
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-dashed border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-2xl opacity-50">{emoji}</span>
          <h3 className="font-bold text-gray-700 dark:text-gray-300">{label}</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">{msg}</p>
      </div>
    );
  }

  // ── Available branch ───────────────────────────────────────────────
  const {
    min, median, max, count, postal_code, cuisine,
    your_price, deviation_pct, inventory_item_id,
  } = comparison;

  // Apply CTA target price — round the cohort median to the nearest
  // whole unit so the owner sees "Apply 42 kr" not "Apply 41.73 kr".
  // Honest about the rounding: we PATCH the rounded number, not the
  // exact median.
  const suggested = median != null ? Math.round(Number(median)) : null;
  const canApply =
    suggested != null &&
    your_price != null &&
    suggested !== Math.round(Number(your_price));

  const handleApply = async () => {
    if (!canApply || !inventory_item_id || applying) return;
    setApplying(true);
    setApplyError("");
    try {
      await api.patch(`/inventory/${inventory_item_id}`, {
        sell_price: suggested,
      });
      // Stamp the "applied" state so the row renders the confirmation
      // copy until the parent refetches the comparison.
      setAppliedAt(Date.now());
      if (typeof onApplied === "function") onApplied();
      try {
        window.dispatchEvent(new Event("bonbox-data-changed"));
      } catch {
        /* no-op */
      }
    } catch (err) {
      setApplyError(
        err?.response?.data?.detail ||
          t("smartPricingApplyFailed") ||
          "Could not update the price.",
      );
    } finally {
      setApplying(false);
    }
  };

  const handleSnooze = () => {
    setSnooze(canonical);
    setSnoozed(true);
  };

  const marker = markerPercent(your_price, min, max);

  // Interpretation line
  let interpretation = "";
  if (your_price == null) {
    interpretation = ""; // no price to compare
  } else if (deviation_pct == null || deviation_pct === 0) {
    interpretation = t("smartPricingAtMedian") || "at the neighborhood median";
  } else if (deviation_pct < 0) {
    interpretation = (t("smartPricingBelow") || "{pct}% below median")
      .replace("{pct}", Math.abs(deviation_pct).toFixed(0));
  } else {
    interpretation = (t("smartPricingAbove") || "{pct}% above median")
      .replace("{pct}", Math.abs(deviation_pct).toFixed(0));
  }

  const footer = (t("smartPricingFooter") || "{n} businesses · {postal} · {cuisine}")
    .replace("{n}", count)
    .replace("{postal}", postal_code || "—")
    .replace("{cuisine}", cuisine || "—");

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-2xl">{emoji}</span>
        <h3 className="font-bold text-gray-800 dark:text-white">{label}</h3>
      </div>

      <div className="flex items-end justify-between mb-3">
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("smartPricingYourPrice")}</p>
          <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">
            {fmt(your_price)} <span className="text-base font-normal opacity-60">{currency}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("smartPricingMedian")}</p>
          <p className="text-2xl font-semibold text-gray-700 dark:text-gray-300">
            {fmt(median)} <span className="text-sm font-normal opacity-60">{currency}</span>
          </p>
        </div>
      </div>

      {/* Percentile bar — min · p25 · median · p75 · max. The user's
          marker is overlaid as a darker tick. */}
      <div className="relative h-3 rounded-full bg-gray-50 dark:bg-gray-800/50 mb-3">
        {/* Median tick at the visual midpoint (50%) for orientation. */}
        <div
          className="absolute top-0 bottom-0 w-px bg-gray-500 dark:bg-gray-400"
          style={{ left: "50%" }}
          aria-hidden="true"
        />
        {marker != null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-blue-600 border-2 border-white dark:border-gray-800 shadow"
            style={{ left: `calc(${marker}% - 8px)` }}
            aria-label={`Your price marker at ${marker.toFixed(0)}%`}
          />
        )}
      </div>

      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-3">
        <span>{t("smartPricingMin")} {fmt(min)}</span>
        <span>{t("smartPricingMax")} {fmt(max)}</span>
      </div>

      {/* Polarity (Task #89 P2-1): for a small café owner, pricing
          ABOVE the neighborhood median is at best neutral and at worst
          a churn risk (the regulars walked past two cheaper places to
          get here). Pricing BELOW the median is a margin opportunity
          ("you can probably raise this 4 kr and nobody'll blink").
          Hence: deviation_pct < 0 → emerald (good), > 0 → amber
          (caution). Both tones are tuned to remain legible on the
          dark-mode card background. */}
      {interpretation && (
        <p className={`text-sm font-medium mb-1 ${
          deviation_pct == null || deviation_pct === 0
            ? "text-gray-700 dark:text-gray-300"
            : deviation_pct < 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-amber-600 dark:text-amber-400"
        }`}>
          {interpretation}
        </p>
      )}
      <p className="text-xs text-gray-400 dark:text-gray-500">{footer}</p>

      {/* Task #204 P2.7 — Apply / Snooze CTAs.  Only render when the
          backend gave us an actionable suggestion (median != your price)
          AND entitlements are loaded.  Don't flash the button for trial
          users mid-resolution. */}
      {entReady && canApply && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {appliedAt ? (
            <span className="inline-flex items-center text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
              {t("smartPricingApplied") || "Price updated"}
            </span>
          ) : inventory_item_id ? (
            <>
              <button
                type="button"
                onClick={handleApply}
                disabled={applying}
                className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900"
              >
                {applying
                  ? t("smartPricingApplying") || "Applying…"
                  : (t("smartPricingApply") || "Apply {price} {currency}")
                      .replace("{price}", String(suggested))
                      .replace("{currency}", currency)}
              </button>
              <button
                type="button"
                onClick={handleSnooze}
                disabled={applying}
                className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-[12px] font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded-lg"
              >
                {t("smartPricingSnooze") || "Snooze 30d"}
              </button>
            </>
          ) : (
            <Link
              to="/inventory"
              className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-[12px] font-semibold text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 underline"
            >
              {t("smartPricingNoApplyTargetCta") || "Open in Inventory"}
            </Link>
          )}
        </div>
      )}
      {applyError && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-2">{applyError}</p>
      )}
    </div>
  );
}
