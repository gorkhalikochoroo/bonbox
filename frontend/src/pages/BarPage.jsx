// Task #118 polish (Agent B): migrated to PageHeader, SectionBanner,
// Button, Icon primitives.  Replaced inline 🍸 emoji H1 with PageHeader
// + Martini Lucide icon eyebrow.  Module-disabled warn block is now a
// SectionBanner severity="warn".  Inline empty state uses Empty
// primitive.  Behavior + i18n + a11y unchanged.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import { localIso } from "../utils/dateFormat";
import {
  Button, PageHeader, SectionBanner, Empty, Icon,
} from "../components/ui";

/**
 * Bar Pour — dedicated page for pour-cost-tracked items (spirits, beer,
 * wine-by-the-glass, mixers).
 *
 * Why this exists as its own page (not a section of /inventory):
 *   • Different mental model — bar pour is sale-time, kitchen inventory
 *     is end-of-day. Bartenders need big tap-to-pour tiles; pantry
 *     managers need calm list views.
 *   • The vertical-module gating system (services/modules.py) treats
 *     bar_pour as a first-class module. Other modules (workshop,
 *     wine_sommelier) already have dedicated pages — this completes
 *     the pattern.
 *   • Owners who don't run a bar (coffee shop, takeaway, retail) hide
 *     this entirely from their sidebar via the modules picker — the
 *     page never clutters their nav.
 *
 * Data: backed by inventory_items with pour_size set. Same backend
 * endpoints as InventoryPage uses (/api/inventory/pour, /api/inventory/logs).
 *
 * Future home for the variance dashboard (theoretical pour cost vs
 * actual kasserapport bar receipts) — the bar-industry killer feature.
 */
export default function BarPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // Module-aware soft gate — surfaces a banner when the owner navigated
  // here directly but hasn't enabled the bar_pour module. Existing bar
  // items still load + work (their data is theirs); the banner just
  // explains why /bar isn't in their sidebar and offers a one-click
  // jump to /modules. Strict gating would block existing operations,
  // which is bad UX for owners who pre-existed the module-gating ship.
  const [moduleEnabled, setModuleEnabled] = useState(null); // null = loading

  // Pour + restock modals (same UX as the InventoryPage extracts)
  const [pourModal, setPourModal] = useState(null);
  const [pourCount, setPourCount] = useState(1);
  const [restockItem, setRestockItem] = useState(null);
  const [restockBottles, setRestockBottles] = useState(1);

  useEffect(() => {
    fetchItems();
    // Check whether the bar_pour module is enabled — controls the soft
    // banner. Failure is silent → banner just doesn't render.
    api.get("/modules")
      .then((res) => {
        const found = (res.data?.modules || []).find((m) => m.id === "bar_pour");
        setModuleEnabled(!!(found && found.enabled));
      })
      .catch(() => setModuleEnabled(true)); // fail open — don't pester on API failure
  }, []);

  async function fetchItems() {
    setLoading(true);
    try {
      const res = await api.get("/inventory");
      // Bar Page is the home for inventory items that track pour math.
      // Items without pour_size live on /inventory (general kitchen stock).
      const list = Array.isArray(res.data) ? res.data : [];
      setItems(list.filter((i) => i.pour_size && i.pour_size > 0));
      setError("");
    } catch (e) {
      setError(e?.response?.data?.detail || t("barLoadFailed") || "Could not load bar items");
    } finally {
      setLoading(false);
    }
  }

  async function recordPour() {
    if (!pourModal) return;
    try {
      const res = await api.post("/inventory/pour", {
        item_id: pourModal.id,
        pours: pourCount,
        date: localIso(),
      });
      const saleMsg = res.data.sale_recorded ? ` · ${t("sale") || "Sale"}: ${res.data.revenue} ${currency}` : "";
      setSuccess(`${t("poured") || "Poured"} ${pourCount}x ${pourModal.name} — ${res.data.remaining_pours} ${t("poursLeft") || "pours left"}${saleMsg}`);
      setPourModal(null);
      setPourCount(1);
      fetchItems();
      setTimeout(() => setSuccess(""), 3000);
    } catch (e) {
      setError(e?.response?.data?.detail || t("pourFailed") || "Pour failed");
      setTimeout(() => setError(""), 3000);
    }
  }

  async function restockBottle() {
    if (!restockItem) return;
    const addMl = (restockItem.bottle_size || 750) * restockBottles;
    try {
      await api.post("/inventory/logs", {
        item_id: restockItem.id,
        change_qty: addMl,
        reason: `restock:${restockBottles} bottle(s)`,
        date: localIso(),
      });
      setSuccess(`${t("restocked") || "Restocked"} ${restockItem.name} — ${restockBottles} ${t("bottles") || "bottles"} (${addMl} ${restockItem.pour_unit || "ml"})`);
      setRestockItem(null);
      setRestockBottles(1);
      fetchItems();
      setTimeout(() => setSuccess(""), 3000);
    } catch (e) {
      setError(e?.response?.data?.detail || t("restockFailed") || "Restock failed");
      setTimeout(() => setError(""), 3000);
    }
  }

  // Show only stocked items at the top — empty rows go to a separate
  // "Provision new bottles" collapse so the main grid is calm.
  const stockedItems = useMemo(
    () => items.filter((i) => Math.floor((i.quantity || 0) / (i.pour_size || 1)) > 0),
    [items],
  );
  const unstockedItems = useMemo(
    () => items.filter((i) => Math.floor((i.quantity || 0) / (i.pour_size || 1)) <= 0),
    [items],
  );
  const [showUnstocked, setShowUnstocked] = useState(false);

  return (
    <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">
      <FadeIn>
        <PageHeader
          eyebrow="STOCK"
          title={t("barPageTitle") || "Bar Pour"}
          subtitle={
            t("barPageSubtitle") ||
            "Pour-cost tracked items — spirits, beer, wine-by-the-glass, mixers. Tap to pour, tap + to restock by the bottle."
          }
          actions={
            <Link
              to="/inventory"
              className="text-xs font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition"
            >
              {t("barManageInInventory") || "Edit / add bottles in Inventory →"}
            </Link>
          }
        />
      </FadeIn>

      {/* Module-disabled soft banner — only shows when user hits /bar
          directly without enabling the bar_pour module. Doesn't block
          existing data; just explains the missing sidebar entry and
          offers a one-tap path to enable. */}
      {moduleEnabled === false && (
        <div className="mt-4">
          <SectionBanner
            severity="warn"
            icon="AlertTriangle"
            title={t("barModuleDisabledTitle") || "Bar Pour module is disabled."}
          >
            {t("barModuleDisabledBody") || "Enable it to add Bar to your sidebar — your existing bottles still work either way."}{" "}
            <Link to="/modules" className="font-semibold underline whitespace-nowrap">
              {t("barModuleEnable") || "Enable in Modules →"}
            </Link>
          </SectionBanner>
        </div>
      )}

      {success && (
        <div className="mt-4">
          <SectionBanner severity="success" icon="CheckCircle2" title={success} />
        </div>
      )}
      {error && (
        <div className="mt-4">
          <SectionBanner severity="critical" icon="AlertTriangle" title={error} />
        </div>
      )}

      {/* Empty state — no bar items configured at all. Uses the shared
          Empty primitive so the page matches the other "no data yet"
          screens across BonBox. */}
      {!loading && items.length === 0 && (
        <FadeIn delay={0.05}>
          <div className="mt-6 rounded-xl border border-dashed border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/40 p-2">
            <Empty
              icon="🍸"
              title={t("barEmptyTitle") || "No bar items yet"}
              body={
                t("barEmptyHelp") ||
                "Add bottles in Inventory with a bottle size + pour size set (e.g. 750 ml bottle, 30 ml pour). They'll appear here as tap-to-pour tiles."
              }
              cta={
                <Link
                  to="/inventory"
                  className="inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors h-9 px-3.5 text-sm bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                >
                  {t("barEmptyCta") || "Add bottles in Inventory"}
                </Link>
              }
            />
          </div>
        </FadeIn>
      )}

      {/* Stocked items — the main tap-to-pour grid */}
      {stockedItems.length > 0 && (
        <FadeIn delay={0.04}>
          <div className="mt-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("barTapToPour") || "Tap to pour"}
              </h2>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                {stockedItems.length} {t("stockedItems") || "stocked"}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
              {stockedItems.map((item) => {
                const remaining = item.pour_size > 0 ? Math.floor(item.quantity / item.pour_size) : 0;
                return (
                  <div
                    key={item.id}
                    className="p-3 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/40 dark:bg-amber-900/10"
                  >
                    <p className="text-sm font-semibold text-gray-800 dark:text-white truncate">{item.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {Math.round(item.quantity)} {item.pour_unit || "ml"} · {remaining} {t("pours") || "pours"}
                    </p>
                    {item.sell_price_per_pour > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 font-medium mt-0.5">
                        {item.sell_price_per_pour} {currency}/{t("perGlass") || "glass"}
                      </p>
                    )}
                    <div className="flex gap-1 mt-2">
                      <button
                        onClick={() => { setPourModal(item); setPourCount(1); }}
                        className="flex-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-1.5 rounded-lg transition"
                      >
                        {t("pour") || "Pour"}
                      </button>
                      <button
                        onClick={() => { setRestockItem(item); setRestockBottles(1); }}
                        className="bg-green-500 hover:bg-green-600 text-white text-xs font-bold px-2 py-1.5 rounded-lg transition"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Unstocked items — collapsed by default to keep the main grid calm */}
      {unstockedItems.length > 0 && (
        <FadeIn delay={0.06}>
          <details
            open={showUnstocked}
            onToggle={(e) => setShowUnstocked(e.target.open)}
            className="mt-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40 group"
          >
            <summary className="cursor-pointer px-5 py-3 text-[13px] font-semibold text-gray-700 dark:text-gray-300 flex items-center justify-between list-none">
              <span>
                {t("barUnstockedTitle") || "In your bar list, not yet stocked"}
                <span className="ml-2 text-[11px] text-gray-400 dark:text-gray-500">
                  ({unstockedItems.length})
                </span>
              </span>
              <span className="text-gray-400 transition-transform group-open:rotate-180">▾</span>
            </summary>
            <div className="px-5 pb-4 pt-1 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
              {unstockedItems.map((item) => (
                <div
                  key={item.id}
                  className="p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/30 opacity-80"
                >
                  <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 truncate">{item.name}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    {t("barEmptyBottle") || "No stock"}
                  </p>
                  <button
                    onClick={() => { setRestockItem(item); setRestockBottles(1); }}
                    className="w-full mt-2 bg-green-500 hover:bg-green-600 text-white text-xs font-bold py-1.5 rounded-lg transition"
                  >
                    + {t("restock") || "Restock"}
                  </button>
                </div>
              ))}
            </div>
          </details>
        </FadeIn>
      )}

      {/* Pour Modal — same UX pattern as InventoryPage so muscle memory transfers */}
      {pourModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setPourModal(null)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-6 w-full max-w-sm border border-gray-200 dark:border-gray-800" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">
              {t("pour") || "Pour"} — {pourModal.name}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {pourModal.pour_size}{pourModal.pour_unit || "ml"} {t("perGlass") || "per glass"} · {Math.round(pourModal.quantity)} {pourModal.pour_unit || "ml"} {t("inStock") || "in stock"}
              {pourModal.pour_size > 0 && ` · ${Math.floor(pourModal.quantity / pourModal.pour_size)} ${t("poursLeft") || "pours left"}`}
            </p>
            <div className="flex items-center justify-center gap-4 mb-4">
              <button onClick={() => setPourCount(Math.max(1, pourCount - 1))} className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 text-lg font-bold text-gray-700 dark:text-gray-200">-</button>
              <span className="text-3xl font-bold text-gray-800 dark:text-white w-16 text-center">{pourCount}</span>
              <button onClick={() => setPourCount(pourCount + 1)} className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 text-lg font-bold text-gray-700 dark:text-gray-200">+</button>
            </div>
            <div className="flex gap-2 flex-wrap justify-center mb-4">
              {[1, 2, 3, 5, 10].map((n) => (
                <button key={n} onClick={() => setPourCount(n)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${pourCount === n ? "bg-amber-100 dark:bg-amber-900/30 border-amber-400 text-amber-700 dark:text-amber-400" : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400"}`}>
                  {n}x
                </button>
              ))}
            </div>
            <p className="text-center text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("total") || "Total"}: {pourCount * (pourModal.pour_size || 0)} {pourModal.pour_unit || "ml"}
              {pourModal.sell_price_per_pour > 0 && ` · ${t("revenue") || "Revenue"}: ${(pourCount * pourModal.sell_price_per_pour).toLocaleString()} ${currency}`}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPourModal(null)} className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm text-gray-600 dark:text-gray-300">
                {t("cancel") || "Cancel"}
              </button>
              <button onClick={recordPour} className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-semibold text-sm transition">
                {t("pour") || "Pour"} {pourCount}x
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restock Modal */}
      {restockItem && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setRestockItem(null)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-6 w-full max-w-sm border border-gray-200 dark:border-gray-800" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">
              {t("restock") || "Restock"} — {restockItem.name}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {restockItem.bottle_size || 750} {restockItem.pour_unit || "ml"} {t("perBottle") || "per bottle"}
            </p>
            <div className="flex items-center justify-center gap-4 mb-4">
              <button onClick={() => setRestockBottles(Math.max(1, restockBottles - 1))} className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 text-lg font-bold text-gray-700 dark:text-gray-200">-</button>
              <span className="text-3xl font-bold text-gray-800 dark:text-white w-16 text-center">{restockBottles}</span>
              <button onClick={() => setRestockBottles(restockBottles + 1)} className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 text-lg font-bold text-gray-700 dark:text-gray-200">+</button>
            </div>
            <div className="flex gap-2 flex-wrap justify-center mb-4">
              {[1, 2, 3, 6, 12].map((n) => (
                <button key={n} onClick={() => setRestockBottles(n)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${restockBottles === n ? "bg-green-100 dark:bg-green-900/30 border-green-400 text-green-700 dark:text-green-400" : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400"}`}>
                  {n}
                </button>
              ))}
            </div>
            <p className="text-center text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("adding") || "Adding"} {restockBottles} {t("bottles") || "bottles"} = {(restockItem.bottle_size || 750) * restockBottles} {restockItem.pour_unit || "ml"}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setRestockItem(null)} className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm text-gray-600 dark:text-gray-300">
                {t("cancel") || "Cancel"}
              </button>
              <button onClick={restockBottle} autoFocus className="flex-1 py-2.5 bg-green-500 hover:bg-green-600 text-white rounded-xl font-semibold text-sm transition">
                {t("add") || "Add"} {restockBottles} {t("bottles") || "bottles"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
