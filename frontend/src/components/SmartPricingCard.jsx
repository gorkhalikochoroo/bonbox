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
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";

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

export default function SmartPricingCard({ comparison, currencyCode }) {
  const { t } = useLanguage();
  if (!comparison) return null;

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
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-dashed border-gray-200 dark:border-gray-700">
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
    your_price, deviation_pct,
  } = comparison;

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
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
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
      <div className="relative h-3 rounded-full bg-gradient-to-r from-emerald-200 via-yellow-200 to-rose-200 dark:from-emerald-900/40 dark:via-yellow-900/40 dark:to-rose-900/40 mb-3">
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

      {interpretation && (
        <p className={`text-sm font-medium mb-1 ${
          deviation_pct == null || deviation_pct === 0
            ? "text-gray-700 dark:text-gray-300"
            : deviation_pct < 0
              ? "text-amber-600 dark:text-amber-400"
              : "text-emerald-600 dark:text-emerald-400"
        }`}>
          {interpretation}
        </p>
      )}
      <p className="text-xs text-gray-400 dark:text-gray-500">{footer}</p>
    </div>
  );
}
