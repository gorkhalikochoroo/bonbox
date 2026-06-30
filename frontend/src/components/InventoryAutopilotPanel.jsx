/**
 * InventoryAutopilotPanel — "Genbestilling": a NO-SEND reorder heads-up.
 *
 * BonBox reads /inventory/autopilot/suggest (read-only) and TELLS the owner what
 * is running low, how much to genbestil, and roughly by when — grouped by
 * leverandør. The owner places the order themselves: the only assist is
 * "Kopiér bestilling", a 100% client-side clipboard copy of the per-leverandør
 * line list that the owner pastes into their OWN channel (supplier app / SMS /
 * call). BonBox emails NO ONE. The old supplier-emailing path (/autopilot/apply,
 * "Send bestilling", "Send all orders", "Sent N supplier orders") is GONE — per
 * the locked product decision: "we're not ordering anything, we're helping them
 * track inventory."
 *
 * Calm state machine:
 *   loading      → one quiet "Læser dit lager…" beat.
 *   locked       → Free/Starter UpgradeNudge (heads-up value, never "emails").
 *   not-set-up   → an activation hero, fires ONLY when there are zero lager varer
 *                  to read (PackageSearch — watching, not delivering).
 *   ready        → leverandør-grouped heads-up cards + per-card Kopiér bestilling.
 *   all-healthy  → calm "intet er ved at løbe tør".
 *
 * Honesty (computed != measured): suggested_qty is a "Foreslået antal" the owner
 * edits before copying; days_until_stockout reads as an estimate ("Tom om ca." /
 * "Est. out in"); confidence shows ONLY with real history; Anslået total/værdi
 * only when cost > 0. A persistent contract line ("BonBox foreslår — du bestiller
 * selv") + footer ("BonBox sender ikke noget…") keep the no-send promise visible.
 * The only post-action confirmation is "Kopieret" — a true claim about the
 * clipboard, never "sent/ordered".
 *
 * Tier-gated client-side (UpgradeNudge for non-Pro); the backend is the source of
 * truth — /autopilot/suggest enforces the Pro gate via _enforce_inventory_autopilot_tier().
 *
 * Lucide outline icons only (no emoji). DK trade terms (leverandør, bestilling,
 * genbestil, lager, vareforbrug, letfordærvelig) stay Danish in every language.
 */
import { useState, useMemo, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency } from "../utils/currency";
import { Button, Card, UpgradeNudge, Icon } from "./ui";


// ─── Urgency styling — three tiers ────────────────────────────────────
//
// Today  = "you should reorder today" (red).
// Week   = "before the weekend" (amber).
// Monitor = "still healthy, keep an eye on it" (stone-grey).
const URGENCY = {
  today: {
    color: "bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 border-red-200 dark:border-red-800",
    dot: "bg-red-500",
    labelKey: "inventoryAutopilotToday",
    labelFallback: "Order today",
    sortRank: 0,
  },
  this_week: {
    color: "bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-800",
    dot: "bg-amber-500",
    labelKey: "inventoryAutopilotThisWeek",
    labelFallback: "Order this week",
    sortRank: 1,
  },
  monitor: {
    color: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700",
    dot: "bg-gray-400",
    labelKey: "inventoryAutopilotMonitor",
    labelFallback: "Monitor",
    sortRank: 2,
  },
};


function UrgencyBadge({ urgency, t }) {
  const tier = URGENCY[urgency] || URGENCY.monitor;
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] " +
        "font-semibold uppercase tracking-wider rounded-md border " +
        tier.color
      }
    >
      <span className={"w-1.5 h-1.5 rounded-full " + tier.dot} />
      {t(tier.labelKey, tier.labelFallback)}
    </span>
  );
}


function ConfidenceBadge({ confidence, t }) {
  if (!confidence) return null;
  const labels = {
    high: { key: "inventoryAutopilotHighConfidence", fallback: "High confidence" },
    medium: { key: "inventoryAutopilotMediumConfidence", fallback: "Medium confidence" },
    low: { key: "inventoryAutopilotLowConfidence", fallback: "Low confidence" },
  };
  const meta = labels[confidence] || labels.low;
  return (
    <span className="text-[10px] text-gray-500 dark:text-gray-400">
      {t(meta.key, meta.fallback)}
    </span>
  );
}


// ─── Warning summary (structured notes → at most three quiet rows) ────
// Status colour is a 6px DOT only — never a card/banner fill. Collapsed
// by default; expanding reveals the affected vare names (capped).
const WARN_TAGS = [
  { key: "late_for_lead_time", labelKey: "inventoryAutopilotWarnLate", labelFallback: "Ordered late for lead time", dot: "bg-red-500" },
  { key: "perishable_waste_risk", labelKey: "inventoryAutopilotWarnPerishable", labelFallback: "Letfordærvelig — verify before bestilling", dot: "bg-amber-500" },
  { key: "low_history", labelKey: "inventoryAutopilotWarnLowHistory", labelFallback: "Thin data", dot: "bg-gray-400" },
];

function WarningSummaryRow({ warn, t }) {
  const [open, setOpen] = useState(false);
  const active = WARN_TAGS.filter((tag) => (warn[tag.key]?.length || 0) > 0);
  if (!active.length) return null;

  const label = (tag) =>
    t(tag.labelKey, tag.labelFallback).replace("{n}", String(warn[tag.key].length));

  return (
    <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left text-[13px] text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition"
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={15}
          className="shrink-0 text-gray-400"
        />
        <span className="font-medium text-gray-700 dark:text-gray-300">
          {t("inventoryAutopilotWarnNote", "Bemærk")}
        </span>
        <span className="min-w-0 truncate text-gray-500 dark:text-gray-400">
          {active
            .map((tag) => (
              <span key={tag.key} className="whitespace-nowrap">
                <span className={"inline-block w-1.5 h-1.5 rounded-full align-middle mr-1 " + tag.dot} />
                {label(tag)}
              </span>
            ))
            .reduce((acc, el, i) => (i === 0 ? [el] : [...acc, " · ", el]), [])}
        </span>
      </button>

      {open && (
        <div className="mt-2.5 space-y-2.5 pl-6">
          {active.map((tag) => {
            const names = warn[tag.key];
            const shown = names.slice(0, 8);
            const extra = names.length - shown.length;
            return (
              <div key={tag.key}>
                <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                  <span className={"w-1.5 h-1.5 rounded-full " + tag.dot} />
                  {label(tag)}
                </div>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  {shown.join(", ")}
                  {extra > 0 && (
                    <span className="text-gray-400 dark:text-gray-500">
                      {" "}
                      {t("inventoryAutopilotMoreNames", "+{n} more").replace("{n}", String(extra))}
                    </span>
                  )}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ─── Not-set-up hero — the calm activation state ──────────────────────
// Fires ONLY when there are zero lager varer to read. Supplier email is
// irrelevant now (BonBox emails no one) — all the owner needs to start is
// one vare with its current stock.
function NotSetUpHero({ onAddSupplier, t }) {
  return (
    <div className="px-2 sm:px-4 py-8 text-center">
      <span className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 mb-4">
        <Icon name="PackageSearch" size={26} />
      </span>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 max-w-sm mx-auto leading-snug">
        {t("inventoryAutopilotNotSetupHeadline", "Add your varer and BonBox flags what's running low")}
      </h3>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
        {t(
          "inventoryAutopilotNotSetupBody",
          "BonBox watches stock against usage and tells you what to reorder before you run out — you place the order, BonBox sends nothing. Add a vare with its current lager to start. A leverandør and price are optional; they just let BonBox group the list and estimate its value.",
        )}
      </p>
      <div className="mt-5">
        <Button variant="primary" onClick={onAddSupplier}>
          {t("inventoryAutopilotNotSetupCta", "Add a vare to your lager")}
        </Button>
      </div>
    </div>
  );
}


function SupplierCard({ group, edits, setEdits, buildText, t, currency }) {
  const groupItems = group.items || [];
  const hasSupplier = !!group.supplier_name;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildText(group));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (rare) — the list stays on screen; the owner can
      // still read and type it. We never claim a copy that didn't happen.
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
              {group.supplier_name || t("inventoryAutopilotNoSupplier", "No leverandør set")}
            </h3>
            <UrgencyBadge urgency={group.urgency} t={t} />
          </div>
          {!hasSupplier && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t("inventoryAutopilotGroupHint", "Add a leverandør to group these varer (optional)")}
            </p>
          )}
        </div>
        {Number(group.total_cost || 0) > 0 && (
          <div className="text-right shrink-0">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t("inventoryAutopilotEstTotal", "Est. total")}
            </p>
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {Number(group.total_cost || 0).toFixed(2)} {currency}
            </p>
          </div>
        )}
      </div>

      <ul className="divide-y divide-gray-100 dark:divide-gray-800 -mx-1">
        {groupItems.map((it) => {
          const editKey = it.item_id;
          const qty = edits[editKey] ?? it.suggested_qty;
          const safeQty = Number.isFinite(parseFloat(qty)) ? parseFloat(qty) : 0;
          const lineCost = (safeQty * (it.cost_per_unit || 0)).toFixed(2);

          return (
            <li key={editKey} className="py-3 px-1">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {it.name}
                    </p>
                    <UrgencyBadge urgency={it.urgency} t={t} />
                    {it.is_perishable && (
                      <span className="text-[10px] text-orange-700 dark:text-orange-400 font-medium uppercase tracking-wider">
                        {t("inventoryAutopilotPerishable", "Perishable")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t("inventoryAutopilotStock", "Stock")}:&nbsp;
                    {Number(it.current_stock || 0).toFixed(2)} {it.unit} ·&nbsp;
                    {t("inventoryAutopilotDailyDemand", "Daily demand")}:&nbsp;
                    {Number(it.daily_demand || 0).toFixed(2)} {it.unit}
                    {it.days_until_stockout != null && (
                      <>
                        {" "}·{" "}
                        {t("inventoryAutopilotStockoutIn", "Est. out in")}{" "}
                        {it.days_until_stockout}
                        {" "}
                        {t("inventoryAutopilotDays", "days")}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    type="number"
                    min={0}
                    step={it.pack_size > 0 ? it.pack_size : 1}
                    value={qty}
                    onChange={(e) =>
                      setEdits((prev) => ({ ...prev, [editKey]: e.target.value }))
                    }
                    className="w-full sm:w-24 h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 text-right focus:outline-none focus:ring-2 focus:ring-gray-900"
                    aria-label={t("inventoryAutopilotQtyLabel", "Suggested antal")}
                  />
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0 min-w-[2rem]">
                    {it.unit}
                  </span>
                </div>
              </div>
              {Number(it.cost_per_unit || 0) > 0 && (
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 text-right">
                  {lineCost} {currency}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {/* Kopiér bestilling — 100% client-side clipboard copy. BonBox sends nothing. */}
      <div className="mt-4 flex items-center justify-end gap-2 flex-wrap">
        <Button variant="secondary" onClick={copy}>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="Copy" size={15} aria-hidden="true" />
            {copied
              ? t("inventoryAutopilotCopied", "Kopieret")
              : t("inventoryAutopilotCopyOrder", "Kopiér bestilling")}
          </span>
        </Button>
      </div>
    </Card>
  );
}


export default function InventoryAutopilotPanel({ branchId = null, onClose, hero = false, onAddSupplier = null }) {
  const { t, lang } = useLanguage();
  const { user } = useAuth();
  const { hasFeature, loading: entLoading } = useEntitlements();
  const isUnlocked = hasFeature("inventory_autopilot");
  const currency = displayCurrency(user?.currency);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [suggestion, setSuggestion] = useState(null);
  const [edits, setEdits] = useState({}); // {item_id: qty_string}

  const fetchSuggestion = async () => {
    setLoading(true);
    setError("");
    try {
      // Fixed horizon: nothing is sent, so an order-tuning control is dead
      // cognitive cost. The engine's default look-ahead is one week.
      const body = { days_ahead: 7 };
      if (branchId) body.branch_id = branchId;
      const res = await api.post("/inventory/autopilot/suggest", body);
      setSuggestion(res.data);
      // Seed the edits map with the suggested_qty so the owner can tweak it
      // before copying the list.
      const seeded = {};
      for (const it of res.data?.items || []) {
        seeded[it.item_id] = String(it.suggested_qty || 0);
      }
      setEdits(seeded);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 402) {
        setError(
          err?.response?.data?.detail?.message ||
            t("inventoryAutopilotProRequired", "Genbestilling is on Pro."),
        );
      } else {
        setError(
          err?.response?.data?.detail?.message ||
            err?.response?.data?.detail ||
            t("somethingWentWrong", "Something went wrong"),
        );
      }
    } finally {
      setLoading(false);
    }
  };

  // Hero mode (always-on at the top of /inventory): auto-load the heads-up so
  // the owner lands on "what to reorder this week" — no extra tap. Only fires
  // for unlocked (Pro) accounts; Free/Starter render the locked upsell and
  // never hit the Pro-gated suggest endpoint.
  useEffect(() => {
    if (hero && !entLoading && isUnlocked && !suggestion && !loading) {
      fetchSuggestion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hero, entLoading, isUnlocked]);

  // Plain-text reorder list for the clipboard. A DRAFT the owner pastes into
  // their own channel — never phrased as a sent order. Value line only when
  // every line has a real cost (no "0,00 kr" from missing prices).
  const buildOrderText = (group) => {
    const header = t("inventoryAutopilotCopyHeader", "Reorder list from BonBox");
    const sup = group.supplier_name ? ` — ${group.supplier_name}` : "";
    let dateStr = "";
    try {
      dateStr = new Date().toLocaleDateString(lang === "da" ? "da-DK" : "en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch {
      dateStr = "";
    }
    const items = group.items || [];
    const lines = [`${header}${sup}${dateStr ? " — " + dateStr : ""}`];
    for (const it of items) {
      const qty = parseFloat(edits[it.item_id] ?? it.suggested_qty) || 0;
      lines.push(`• ${it.name} — ${qty} ${it.unit || ""}`.trim());
    }
    const allHaveCost = items.length > 0 && items.every((it) => (it.cost_per_unit || 0) > 0);
    if (allHaveCost) {
      const total = items.reduce(
        (s, it) =>
          s + (parseFloat(edits[it.item_id] ?? it.suggested_qty) || 0) * (it.cost_per_unit || 0),
        0,
      );
      lines.push(`${t("inventoryAutopilotEstValue", "Est. value")}: ${total.toFixed(2)} ${currency}`);
    }
    return lines.join("\n");
  };

  // Suppliers from the suggestion, urgency-first; un-named groups last.
  const visibleSuppliers = useMemo(() => {
    if (!suggestion?.suppliers) return [];
    return [...suggestion.suppliers].sort((a, b) => {
      const ar = URGENCY[a.urgency]?.sortRank ?? 99;
      const br = URGENCY[b.urgency]?.sortRank ?? 99;
      if (ar !== br) return ar - br;
      if (!!a.supplier_name !== !!b.supplier_name) {
        return a.supplier_name ? -1 : 1;
      }
      return (b.total_cost || 0) - (a.total_cost || 0);
    });
  }, [suggestion]);

  // ─── Derived state ──────────────────────────────────────────────────
  // Honest confidence: only when there is real history behind the number.
  const hasHistory = (suggestion?.basis?.items_with_history || 0) > 0;
  const basisTotal = suggestion?.basis?.items_total ?? (suggestion?.items?.length || 0);
  const basisHistory = suggestion?.basis?.items_with_history || 0;
  // Truly nothing to read yet: zero lager varer. The instant there is ≥1 vare,
  // the heads-up list IS the value — even with no leverandør and no cost.
  const isNotSetUp = !!suggestion && basisTotal === 0;

  // Tally structured note tags → at most three quiet summary rows.
  const warn = useMemo(() => {
    const tags = { late_for_lead_time: [], perishable_waste_risk: [], low_history: [] };
    for (const it of suggestion?.items || []) {
      for (const n of it.notes || []) {
        if (n in tags) tags[n].push(it.name);
      }
    }
    return tags;
  }, [suggestion]);

  const handleAddSupplier =
    onAddSupplier ||
    (() => {
      document.getElementById("inventory-items-table")?.scrollIntoView({ behavior: "smooth" });
    });

  // ─── Locked render (Free / Starter) ─────────────────────────────────
  if (!entLoading && !isUnlocked) {
    return (
      <Card>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("inventoryAutopilotHeading", "Genbestilling")}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t(
              "inventoryAutopilotIntro",
              "BonBox reads your vareforbrug and flags what's running low — how much to genbestil and roughly by when. You place the order.",
            )}
          </p>
        </div>
        <UpgradeNudge
          intent="card"
          tier="pro"
          benefit={t(
            "inventoryAutopilotUpgradeBenefit",
            "BonBox flags what's running low and how much to genbestil, grouped by leverandør — you place the order.",
          )}
          ctaLabel={t("seePlans", "See plans")}
          icon={<Icon name="Package" size={28} />}
        />
      </Card>
    );
  }

  // Refresh / Close controls only make sense for a ready heads-up.
  const showControls = !loading && !isNotSetUp;

  // ─── Pro render ────────────────────────────────────────────────────
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("inventoryAutopilotHeading", "Genbestilling")}
          </h2>
          {!isNotSetUp && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t("inventoryAutopilotNoSendNote", "BonBox suggests — you place the order")}
            </p>
          )}
        </div>
        {showControls && (
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" onClick={fetchSuggestion} disabled={loading}>
              {loading
                ? t("inventoryAutopilotLoading", "Calculating…")
                : t("inventoryAutopilotRefresh", "Refresh")}
            </Button>
            {onClose && (
              <Button variant="ghost" onClick={onClose}>
                {t("close", "Close")}
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-3 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="px-4 py-12 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400 animate-pulse">
            {t("inventoryAutopilotLoadingLager", "Reading your lager…")}
          </p>
        </div>
      ) : isNotSetUp ? (
        <NotSetUpHero onAddSupplier={handleAddSupplier} t={t} />
      ) : suggestion ? (
        <>
          {/* Basis chip — confidence (only with real history) + counts + weather */}
          <div className="mb-4 flex items-center gap-3 flex-wrap text-xs text-gray-500 dark:text-gray-400">
            {hasHistory && <ConfidenceBadge confidence={suggestion.confidence} t={t} />}
            {hasHistory && <span>•</span>}
            <span>
              {t("inventoryAutopilotItemsFlagged", "Items flagged")}:{" "}
              {suggestion.items?.length || 0}
            </span>
            <span>•</span>
            <span>
              {t("inventoryAutopilotBasisCounts", "{n} varer fulgt · {m} med forbrugshistorik")
                .replace("{n}", String(basisTotal))
                .replace("{m}", String(basisHistory))}
            </span>
            {suggestion.basis?.weather_used ? (
              <>
                <span>•</span>
                <span>{t("inventoryAutopilotWeatherUsed", "Weather adjusted")}</span>
              </>
            ) : null}
          </div>

          {visibleSuppliers.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
              {t(
                "inventoryAutopilotEmpty",
                "Your lager looks healthy — BonBox flags varer before they run out.",
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
              {visibleSuppliers.map((g, idx) => (
                <SupplierCard
                  key={g.supplier_email || g.supplier_name || `no-supplier-${idx}`}
                  group={g}
                  edits={edits}
                  setEdits={setEdits}
                  buildText={buildOrderText}
                  t={t}
                  currency={currency}
                />
              ))}
            </div>
          )}

          {/* Quiet, collapsible risk summary — never an amber wall */}
          <WarningSummaryRow warn={warn} t={t} />

          {/* Standing no-send contract — the promise stays visible. */}
          <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <Icon name="Package" size={15} className="text-gray-400 shrink-0" aria-hidden="true" />
            <span>
              {t(
                "inventoryAutopilotNoSendFooter",
                "BonBox sends nothing — you place the orders yourself.",
              )}
            </span>
          </div>
        </>
      ) : (
        <div className="px-4 py-8 text-center">
          <Icon name="Package" size={36} className="mx-auto text-gray-400 mb-3" />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("inventoryAutopilotEmptyState", "Refresh to see what to reorder.")}
          </p>
        </div>
      )}
    </Card>
  );
}
