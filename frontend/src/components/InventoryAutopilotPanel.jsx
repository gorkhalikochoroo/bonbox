/**
 * InventoryAutopilotPanel — Pro-tier inventory reorder autopilot UI.
 *
 * Reads /inventory/autopilot/suggest, renders per-leverandør cards with
 * editable per-row qty, urgency badges (today/this_week/monitor), and a
 * "Send bestilling" button per leverandør. The "Send all" footer ships
 * every pending leverandør in one click.
 *
 * Calm state machine (a never-configured account is NOT a five-alarm fire):
 *   loading      → one quiet "Læser dit lager…" beat.
 *   locked       → Free/Starter UpgradeNudge (unchanged).
 *   not-set-up   → an activation hero, not a warning wall. Fires when the
 *                  autopilot can't do anything useful yet — no leverandør
 *                  email AND no cost on any vare. One calm Truck tile + one
 *                  primary tap (add your varer + priser) + a collapsed,
 *                  de-amber'd "what's running low" peek. No confidence chip,
 *                  no disabled Send, no 23-card grid, no amber wall.
 *   ready        → leverandør-grouped cards + Send / Send-all (unchanged).
 *   all-healthy  → calm "intet at bestille".
 *
 * The old uncapped amber compliance_warnings <ul> is gone: real risk is
 * summarised from the structured items[].notes[] tags into one quiet,
 * collapsible row BELOW the cards (status colour is a 6px dot, never a
 * canvas). Confidence is shown ONLY when there is real history.
 *
 * Honesty: suggest is read-only (auto-runs in hero); apply is the only
 * write/send and always needs an explicit tap. The not-set-up CTA only
 * routes the owner to where leverandør/pris is set — it never emails anyone.
 *
 * Tier-gated client-side (UpgradeNudge for non-Pro), but the backend is
 * the source of truth — every /autopilot/* endpoint also enforces the
 * Pro tier gate via _enforce_inventory_autopilot_tier().
 *
 * Lucide outline icons only (no emoji chrome). UI strings translatable via
 * t() with English/Danish fallbacks; DK trade terms (leverandør, bestilling,
 * lager, vareforbrug, letfordærvelig) stay Danish in every language.
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


// ─── Warning summary (replaces the old uncapped amber <ul>) ───────────
//
// Tallies the structured items[].notes[] tags into at most three quiet
// rows. Status colour is a 6px DOT only — never a card/banner fill.
// Collapsed by default; expanding reveals the affected vare names (capped,
// with "+n flere"). 'no_supplier_email' is deliberately excluded — in
// not-set-up it IS the headline, and on a real card it's the per-card note.
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
function NotSetUpHero({ suggestion, onAddSupplier, t }) {
  const [showRisk, setShowRisk] = useState(false);
  const items = suggestion?.items || [];
  const total = suggestion?.basis?.items_total ?? items.length;
  const withSupplier = items.filter((i) => i.supplier_email).length;
  const atRisk = [...items].sort(
    (a, b) =>
      (URGENCY[a.urgency]?.sortRank ?? 9) - (URGENCY[b.urgency]?.sortRank ?? 9) ||
      String(a.name || "").localeCompare(String(b.name || "")),
  );

  return (
    <div className="px-2 sm:px-4 py-8 text-center">
      <span className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 mb-4">
        <Icon name="Truck" size={26} />
      </span>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 max-w-sm mx-auto leading-snug">
        {t("inventoryAutopilotNotSetupHeadline", "Add a leverandør and autopilot drafts the order")}
      </h3>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
        {t(
          "inventoryAutopilotNotSetupBody",
          "BonBox can already see what's running low. To draft a bestilling you approve in one tap, it just needs who you buy from and roughly what it costs — add a leverandør and price to your varer and the order writes itself. Nothing is sent until you tap.",
        )}
      </p>
      <div className="mt-5">
        <Button variant="primary" onClick={onAddSupplier}>
          {t("inventoryAutopilotNotSetupCta", "Add leverandør to your varer")}
        </Button>
      </div>
      <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
        {t("inventoryAutopilotNotSetupMeta", "{total} varer in lager · {with} with a leverandør")
          .replace("{total}", String(total))
          .replace("{with}", String(withSupplier))}
      </p>

      {atRisk.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowRisk((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
          >
            <Icon name={showRisk ? "ChevronDown" : "ChevronRight"} size={13} className="text-gray-400" />
            {t("inventoryAutopilotSeeAtRisk", "See what's running low ({n} varer)").replace(
              "{n}",
              String(atRisk.length),
            )}
          </button>
          {showRisk && (
            <ul className="mt-2 max-w-sm mx-auto text-left divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-100 dark:border-gray-800">
              {atRisk.map((it) => (
                <li key={it.item_id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={"w-1.5 h-1.5 rounded-full shrink-0 " + (URGENCY[it.urgency]?.dot || "bg-gray-400")} />
                    <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{it.name}</span>
                  </span>
                  {it.days_until_stockout != null && (
                    <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                      {t("inventoryAutopilotStockoutIn", "Out in")} {it.days_until_stockout}{" "}
                      {t("inventoryAutopilotDays", "days")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
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
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
              {group.supplier_name ||
                group.supplier_email ||
                t("inventoryAutopilotNoSupplier", "No leverandør set")}
            </h3>
            <UrgencyBadge urgency={group.urgency} t={t} />
          </div>
          {hasEmail ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 break-all">
              {group.supplier_email}
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {t(
                "inventoryAutopilotAddSupplier",
                "Add a leverandør email on these varer to send a bestilling",
              )}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("inventoryAutopilotEstTotal", "Est. total")}
          </p>
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {Number(group.total_cost || 0).toFixed(2)} {currency}
          </p>
        </div>
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
                    className="w-full sm:w-24 h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 text-right focus:outline-none focus:ring-2 focus:ring-gray-900"
                    aria-label={t("inventoryAutopilotQtyLabel", "Quantity to order")}
                  />
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0 min-w-[2rem]">
                    {it.unit}
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 text-right">
                {lineCost} {currency}
              </p>
            </li>
          );
        })}
      </ul>

      {/* Send bestilling — disabled when no leverandør email or when sending */}
      <div className="mt-4 flex items-center justify-end gap-2 flex-wrap">
        <Button
          variant="primary"
          onClick={() => onSendOne(group)}
          disabled={!hasEmail || sending}
        >
          {sending
            ? t("inventoryAutopilotSending", "Sending…")
            : t("inventoryAutopilotSendOrder", "Send bestilling")}
        </Button>
      </div>
    </Card>
  );
}


export default function InventoryAutopilotPanel({ branchId = null, onClose, hero = false, onAddSupplier = null }) {
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

  // Hero mode (always-on at the top of /inventory): auto-load the draft so
  // the owner lands on "this week's order, ready to approve" — no extra tap.
  // Only fires for unlocked (Pro) accounts; Free/Starter render the locked
  // upsell card and never hit the Pro-gated suggest endpoint.
  useEffect(() => {
    if (hero && !entLoading && isUnlocked && !suggestion && !loading) {
      fetchSuggestion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hero, entLoading, isUnlocked]);

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

  // ─── Derived state for the calm state machine ───────────────────────
  const sendableSupplierCount = useMemo(
    () => visibleSuppliers.filter((g) => g.supplier_email).length,
    [visibleSuppliers],
  );
  // Honest confidence: only when there is real history behind the number.
  const hasHistory = (suggestion?.basis?.items_with_history || 0) > 0;
  // Any cost data at all → the autopilot can at least estimate/group, so we
  // leave the not-set-up hero and show the (de-walled) grouped suggestions.
  const hasAnyCost = useMemo(
    () => (suggestion?.items || []).some((i) => (i.cost_per_unit || 0) > 0),
    [suggestion],
  );
  // Truly nothing actionable yet: can't send (no leverandør email) AND can't
  // even estimate (no cost). This is the calm activation hero, not an alarm.
  const isNotSetUp = !!suggestion && sendableSupplierCount === 0 && !hasAnyCost;

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
            {t("inventoryAutopilotHeading", "Order autopilot")}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t(
              "inventoryAutopilotIntro",
              "BonBox reads 8 weeks of vareforbrug + the weather forecast and proposes one bestilling per leverandør.",
            )}
          </p>
        </div>
        <UpgradeNudge
          intent="card"
          tier="pro"
          benefit={t(
            "inventoryAutopilotUpgradeBenefit",
            "One tap: BonBox emails every leverandør the right bestilling at the right time",
          )}
          ctaLabel={t("seePlans", "See plans")}
          icon={<Icon name="Package" size={28} />}
        />
      </Card>
    );
  }

  // Header controls (horizon + refresh) only make sense for an active /
  // ready suggestion — hidden during loading and in the not-set-up hero.
  const showControls = !loading && !isNotSetUp;

  // ─── Pro render ────────────────────────────────────────────────────
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("inventoryAutopilotHeading", "Order autopilot")}
          </h2>
          {!isNotSetUp && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t(
                "inventoryAutopilotSubtitle",
                "Suggestions grouped by leverandør. Edit qty before sending — nothing is sent until you tap.",
              )}
            </p>
          )}
        </div>
        {showControls && (
          <div className="flex items-center gap-2 shrink-0">
            <label className="text-xs text-gray-500 dark:text-gray-400">
              {t("inventoryAutopilotHorizon", "Horizon")}
            </label>
            <select
              value={daysAhead}
              onChange={(e) => setDaysAhead(parseInt(e.target.value, 10) || 7)}
              className="h-9 px-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm"
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
        )}
      </div>

      {error && (
        <div className="mb-3 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-3 px-4 py-3 rounded-lg bg-gray-50 dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300">
          {success}
        </div>
      )}

      {loading ? (
        <div className="px-4 py-12 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400 animate-pulse">
            {t("inventoryAutopilotLoadingLager", "Reading your lager…")}
          </p>
        </div>
      ) : isNotSetUp ? (
        <NotSetUpHero suggestion={suggestion} onAddSupplier={handleAddSupplier} t={t} />
      ) : suggestion ? (
        <>
          {/* Basis chip — confidence (only with real history) + weather + counts */}
          <div className="mb-4 flex items-center gap-3 flex-wrap text-xs text-gray-500 dark:text-gray-400">
            {hasHistory && <ConfidenceBadge confidence={suggestion.confidence} t={t} />}
            {hasHistory && <span>•</span>}
            <span>
              {t("inventoryAutopilotItemsFlagged", "Items flagged")}:{" "}
              {suggestion.items?.length || 0}
            </span>
            <span>•</span>
            <span>
              {t("inventoryAutopilotSuppliers", "Leverandører")}: {sendableSupplierCount}
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
                "Your lager looks healthy — autopilot is watching and will flag varer before they run out.",
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

          {/* Send all footer — only visible when at least one leverandør has email */}
          {totalPending > 0 && (
            <div className="mt-5 flex items-center justify-between gap-3 flex-wrap pt-4 border-t border-gray-200 dark:border-gray-800">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t(
                  "inventoryAutopilotSendAllHint",
                  "Sends one consolidated email per leverandør.",
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

          {/* Quiet, collapsible risk summary — never an amber wall */}
          <WarningSummaryRow warn={warn} t={t} />
        </>
      ) : (
        <div className="px-4 py-8 text-center">
          <Icon name="Package" size={36} className="mx-auto text-gray-400 mb-3" />
          <p className="text-sm text-gray-600 dark:text-gray-300">
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
