/**
 * InventoryAutopilotPanel — Pro-tier inventory reorder autopilot UI.
 *
 * Reads /inventory/autopilot/suggest, renders per-supplier cards with
 * editable per-row qty, urgency badges (today/this_week/monitor), and a
 * "Send order" button per supplier. The "Send all" footer ships every
 * pending supplier in one click.
 *
 * Mobile-first layout: cards stack on phones, a 2-column grid only kicks
 * in at lg+. The per-row qty input is full-width on phones (44px tap
 * target) and only goes inline on sm+.
 *
 * Tier-gated client-side (UpgradeNudge for non-Pro), but the backend is
 * the source of truth — every /autopilot/* endpoint also enforces the
 * Pro tier gate via _enforce_inventory_autopilot_tier().
 *
 * No emojis except the small "📦" panel icon (matches the brand style).
 * UI strings translatable via t() with English/Danish fallbacks.
 */
import { useState, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency } from "../utils/currency";
import { Button, Card, UpgradeNudge, Icon } from "./ui";


// ─── Urgency styling — three tiers ────────────────────────────────────
//
// Today  = "you should have ordered yesterday" (red).
// Week   = "before the weekend" (amber).
// Monitor = "still healthy, keep an eye on it" (stone-grey).
//
// Single mapping → any new urgency tier added later only needs one edit.
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
    color: "bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 border-stone-200 dark:border-stone-700",
    dot: "bg-stone-400",
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
    <span className="text-[10px] text-stone-500 dark:text-stone-400">
      {t(meta.key, meta.fallback)}
    </span>
  );
}


function SupplierCard({ group, edits, setEdits, onSendOne, sending, t, currency }) {
  const hasEmail = !!group.supplier_email;
  const groupItems = group.items;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100 truncate">
              {group.supplier_name ||
                group.supplier_email ||
                t("inventoryAutopilotNoSupplier", "No supplier set")}
            </h3>
            <UrgencyBadge urgency={group.urgency} t={t} />
          </div>
          {hasEmail ? (
            <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5 break-all">
              {group.supplier_email}
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {t(
                "inventoryAutopilotAddSupplier",
                "Add a supplier email on these items to send an order",
              )}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {t("inventoryAutopilotEstTotal", "Est. total")}
          </p>
          <p className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {Number(group.total_cost || 0).toFixed(2)} {currency}
          </p>
        </div>
      </div>

      <ul className="divide-y divide-stone-100 dark:divide-stone-800 -mx-1">
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
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100 truncate">
                      {it.name}
                    </p>
                    <UrgencyBadge urgency={it.urgency} t={t} />
                    {it.is_perishable && (
                      <span className="text-[10px] text-orange-700 dark:text-orange-400 font-medium uppercase tracking-wider">
                        {t("inventoryAutopilotPerishable", "Perishable")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                    {t("inventoryAutopilotStock", "Stock")}:&nbsp;
                    {Number(it.current_stock || 0).toFixed(2)} {it.unit} ·&nbsp;
                    {t("inventoryAutopilotDailyDemand", "Daily demand")}:&nbsp;
                    {Number(it.daily_demand || 0).toFixed(2)} {it.unit}
                    {it.days_until_stockout != null && (
                      <>
                        {" "}·{" "}
                        {t("inventoryAutopilotStockoutIn", "Out in")}{" "}
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
                    className="w-full sm:w-24 h-10 px-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm text-stone-900 dark:text-stone-100 text-right focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    aria-label={t("inventoryAutopilotQtyLabel", "Quantity to order")}
                  />
                  <span className="text-xs text-stone-500 dark:text-stone-400 shrink-0 min-w-[2rem]">
                    {it.unit}
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-stone-400 dark:text-stone-500 mt-1 text-right">
                {lineCost} {currency}
              </p>
            </li>
          );
        })}
      </ul>

      {/* Send order — disabled when no supplier email or when sending */}
      <div className="mt-4 flex items-center justify-end gap-2 flex-wrap">
        <Button
          variant="primary"
          onClick={() => onSendOne(group)}
          disabled={!hasEmail || sending}
        >
          {sending
            ? t("inventoryAutopilotSending", "Sending…")
            : t("inventoryAutopilotSendOrder", "Send order")}
        </Button>
      </div>
    </Card>
  );
}


export default function InventoryAutopilotPanel({ branchId = null, onClose }) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { hasFeature, loading: entLoading } = useEntitlements();
  const isUnlocked = hasFeature("inventory_autopilot");
  const currency = displayCurrency(user?.currency);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [suggestion, setSuggestion] = useState(null);
  const [edits, setEdits] = useState({}); // {item_id: qty_string}
  const [daysAhead, setDaysAhead] = useState(7);
  const [sending, setSending] = useState(false);

  const showSuccess = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(""), 3500);
  };

  const fetchSuggestion = async () => {
    setLoading(true);
    setError("");
    try {
      const body = { days_ahead: daysAhead };
      if (branchId) body.branch_id = branchId;
      const res = await api.post("/inventory/autopilot/suggest", body);
      setSuggestion(res.data);
      // Seed the edits map with the autopilot's suggested_qty so the
      // user can tweak before sending.
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
            t("inventoryAutopilotProRequired", "Order Autopilot is on Pro."),
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

  const sendItems = async (lines) => {
    if (!lines.length) return;
    setSending(true);
    setError("");
    try {
      const items = lines.map((l) => ({
        item_id: l.item_id,
        qty: parseFloat(edits[l.item_id] ?? l.suggested_qty) || 0,
        supplier_name: l.supplier_name,
        supplier_email: l.supplier_email,
        unit: l.unit,
        name: l.name,
        cost_per_unit: l.cost_per_unit,
      })).filter((l) => l.qty > 0 && l.supplier_email);

      if (!items.length) {
        setError(
          t(
            "inventoryAutopilotNothingToSend",
            "Nothing to send — qty must be > 0 and supplier email set.",
          ),
        );
        setSending(false);
        return;
      }

      const res = await api.post("/inventory/autopilot/apply", { items });
      const sentCount = res.data?.sent || 0;
      const skipped = res.data?.skipped_no_supplier || 0;
      const failureCount = res.data?.failures?.length || 0;
      if (sentCount > 0) {
        showSuccess(
          t(
            "inventoryAutopilotSentMsg",
            "Sent {count} supplier orders",
          ).replace("{count}", String(sentCount)),
        );
      }
      if (failureCount > 0) {
        setError(
          t(
            "inventoryAutopilotPartialFail",
            "Some orders failed: {n}",
          ).replace("{n}", String(failureCount)),
        );
      } else if (sentCount === 0 && skipped > 0) {
        setError(
          t(
            "inventoryAutopilotAllSkipped",
            "No supplier emails configured — add one to send.",
          ),
        );
      }
      // Refetch so the items list reflects the just-sent state (the next
      // suggestion will reflect any inventory updates the owner makes).
      await fetchSuggestion();
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message ||
          err?.response?.data?.detail ||
          t("somethingWentWrong", "Something went wrong"),
      );
    } finally {
      setSending(false);
    }
  };

  const sendOneSupplier = (group) => sendItems(group.items);

  const sendAll = () => {
    if (!suggestion) return;
    // Flatten all items across suppliers with valid emails
    const lines = [];
    for (const g of suggestion.suppliers || []) {
      if (!g.supplier_email) continue;
      for (const it of g.items || []) {
        lines.push(it);
      }
    }
    sendItems(lines);
  };

  // Suppliers from the suggestion, with "no supplier" bucket pushed to end.
  const visibleSuppliers = useMemo(() => {
    if (!suggestion?.suppliers) return [];
    return [...suggestion.suppliers].sort((a, b) => {
      const ar = URGENCY[a.urgency]?.sortRank ?? 99;
      const br = URGENCY[b.urgency]?.sortRank ?? 99;
      if (ar !== br) return ar - br;
      // Suppliers without email last
      if (!!a.supplier_email !== !!b.supplier_email) {
        return a.supplier_email ? -1 : 1;
      }
      return (b.total_cost || 0) - (a.total_cost || 0);
    });
  }, [suggestion]);

  const totalPending = useMemo(() => {
    let n = 0;
    for (const g of visibleSuppliers) {
      if (g.supplier_email) n += g.items?.length || 0;
    }
    return n;
  }, [visibleSuppliers]);

  // ─── Locked render (Free / Starter) ─────────────────────────────────
  if (!entLoading && !isUnlocked) {
    return (
      <Card>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {t("inventoryAutopilotHeading", "Order autopilot")}
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
            {t(
              "inventoryAutopilotIntro",
              "BonBox reads 8 weeks of consumption + the weather forecast and proposes one order per supplier.",
            )}
          </p>
        </div>
        <UpgradeNudge
          intent="card"
          tier="pro"
          benefit={t(
            "inventoryAutopilotUpgradeBenefit",
            "One tap: BonBox emails every supplier the right order at the right time",
          )}
          ctaLabel={t("seePlans", "See plans")}
          icon={<Icon name="Package" size={28} />}
        />
      </Card>
    );
  }

  // ─── Pro render ────────────────────────────────────────────────────
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {t("inventoryAutopilotHeading", "Order autopilot")}
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
            {t(
              "inventoryAutopilotSubtitle",
              "Suggestions grouped by supplier. Edit qty before sending.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-stone-500 dark:text-stone-400">
            {t("inventoryAutopilotHorizon", "Horizon")}
          </label>
          <select
            value={daysAhead}
            onChange={(e) => setDaysAhead(parseInt(e.target.value, 10) || 7)}
            className="h-9 px-2 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-sm"
          >
            <option value={7}>7 {t("inventoryAutopilotDays", "days")}</option>
            <option value={14}>14 {t("inventoryAutopilotDays", "days")}</option>
            <option value={30}>30 {t("inventoryAutopilotDays", "days")}</option>
          </select>
          <Button
            variant={suggestion ? "secondary" : "primary"}
            onClick={fetchSuggestion}
            disabled={loading}
          >
            {loading
              ? t("inventoryAutopilotLoading", "Calculating…")
              : suggestion
                ? t("inventoryAutopilotRefresh", "Refresh")
                : t("inventoryAutopilotRun", "Run autopilot")}
          </Button>
          {onClose && (
            <Button variant="ghost" onClick={onClose}>
              {t("close", "Close")}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-3 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-sm text-emerald-700 dark:text-emerald-300">
          {success}
        </div>
      )}

      {suggestion && (
        <>
          {/* Basis chip — confidence + weather + lookback */}
          <div className="mb-4 flex items-center gap-3 flex-wrap text-xs text-stone-500 dark:text-stone-400">
            <ConfidenceBadge confidence={suggestion.confidence} t={t} />
            <span>•</span>
            <span>
              {t("inventoryAutopilotItemsFlagged", "Items flagged")}:{" "}
              {suggestion.items?.length || 0}
            </span>
            <span>•</span>
            <span>
              {t("inventoryAutopilotSuppliers", "Suppliers")}:{" "}
              {visibleSuppliers.filter((g) => g.supplier_email).length}
            </span>
            {suggestion.basis?.weather_used ? (
              <>
                <span>•</span>
                <span>{t("inventoryAutopilotWeatherUsed", "Weather adjusted")}</span>
              </>
            ) : null}
          </div>

          {/* Compliance warnings */}
          {suggestion.compliance_warnings?.length > 0 && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
              <p className="font-medium mb-1">
                {t("inventoryAutopilotWarnings", "Heads up")}
              </p>
              <ul className="list-disc pl-5 space-y-0.5">
                {suggestion.compliance_warnings.map((w, idx) => (
                  <li key={idx} className="text-xs">{w}</li>
                ))}
              </ul>
            </div>
          )}

          {visibleSuppliers.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-stone-500 dark:text-stone-400">
              {t(
                "inventoryAutopilotEmpty",
                "Nothing to reorder — your shelves look healthy.",
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
              {visibleSuppliers.map((g, idx) => (
                <SupplierCard
                  key={g.supplier_email || `no-supplier-${idx}`}
                  group={g}
                  edits={edits}
                  setEdits={setEdits}
                  onSendOne={sendOneSupplier}
                  sending={sending}
                  t={t}
                  currency={currency}
                />
              ))}
            </div>
          )}

          {/* Send all footer — only visible when at least one supplier has email */}
          {totalPending > 0 && (
            <div className="mt-5 flex items-center justify-between gap-3 flex-wrap pt-4 border-t border-stone-200 dark:border-stone-800">
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {t(
                  "inventoryAutopilotSendAllHint",
                  "Sends one consolidated email per supplier.",
                )}
              </p>
              <Button
                variant="primary"
                onClick={sendAll}
                disabled={sending}
              >
                {sending
                  ? t("inventoryAutopilotSending", "Sending…")
                  : t("inventoryAutopilotSendAll", "Send all orders")}
              </Button>
            </div>
          )}
        </>
      )}

      {!suggestion && !loading && (
        <div className="px-4 py-8 text-center">
          <Icon name="Package" size={36} className="mx-auto text-stone-400 mb-3" />
          <p className="text-sm text-stone-600 dark:text-stone-300">
            {t(
              "inventoryAutopilotEmptyState",
              "Tap Run autopilot to see what to reorder this week.",
            )}
          </p>
        </div>
      )}
    </Card>
  );
}
