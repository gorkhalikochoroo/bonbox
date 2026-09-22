// Task #118 polish (Agent B): migrated to PageHeader, StatCard,
// SectionBanner, TabPills primitives.  Replaced rainbow CTAs (emerald +
// blue + purple) with single accent button + secondaries; export PDF/CSV
// dropped into ghost variants.  Dead-stock alert moved from full-page red
// gradient to SectionBanner severity="critical".  Expiry/expired alerts
// replaced with SectionBanner.  Category tab row uses TabPills (gray-900
// active state, no more bg-gray-900).  Behavior + i18n + a11y unchanged.
//
// Task #119 Phase 3 polish: replaced dark-gradient rainbow KPI panels
// with neutral clickable StatCards.  Click-to-expand affordance
// preserved via onClick + ChevronDown indicator.  Selected state
// uses gray-900 ring (no tech-glow per sidebar rule).
import { useState, useEffect, useMemo, Fragment } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useAsyncData } from "../hooks/useAsyncData";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { useConfirm } from "../hooks/useConfirm";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency, formatOwnerMoney, isMoneyRejected, moneyLocale, parseMoneyInput } from "../utils/currency";
import MoneyField from "../components/ui/MoneyField";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";
import DismissibleTip from "../components/DismissibleTip";
import SmartImportModal from "../components/SmartImportModal";
import InventoryConsumptionModal from "../components/InventoryConsumptionModal";
import InventoryAutopilotPanel from "../components/InventoryAutopilotPanel";
import CountRitual from "../components/CountRitual";
import { ClipboardCheck as ClipboardCheckIcon, ArrowRight as ArrowRightIcon } from "lucide-react";
import SmartPricingModal from "../components/SmartPricingModal";
import { formatDateClear, localIso } from "../utils/dateFormat";
import { errText } from "../utils/errText";
import { INVENTORY_TEMPLATES, categoryLabel } from "../config/inventoryTemplates";
import {
  Button, PageHeader, StatCard, SectionBanner, TabPills, Icon, Amount, LoadFailed,
} from "../components/ui";
import { SkeletonCard } from "../components/BonBoxPolishKit";
import { saveFile } from "../utils/download";

/**
 * The close control on the three expandable stat panels.
 *
 * One component rather than three copies because all three were copies of the
 * same bare `&times;` glyph in an unlabelled <button> — a screen reader
 * announced "multiplication sign", or nothing at all. 24px hit target, Lucide
 * mark, and a real accessible name.
 */
function StatPanelClose({ onClick, t }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("close", "Close")}
      className="w-6 h-6 shrink-0 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
    >
      <Icon name="X" size={12} />
    </button>
  );
}

export default function InventoryPage() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  // Cost, sell price and price-per-pour are MONEY the owner types and are
  // text boxes read by the strict parser in the ACCOUNT's notation — a number
  // input on an English-locale browser rewrites "1.500,50" to "1.50050" with
  // no error (see components/ui/MoneyField.jsx). Quantity, pieces-per-unit
  // and min-stock stay type="number": they are COUNTS, and a money parser
  // would be wrong about them — it caps fractions at 2 digits and reads a
  // 3-digit group as thousands, neither of which is true of "1.125 kg".
  const mLocale = moneyLocale(user?.currency);
  const { t } = useLanguage();
  // Order Autopilot — Pro-tier reorder + supplier email flow (Task #63).
  // Free / Starter see an UpgradeNudge inside the panel; the button is
  // always visible so the upsell remains discoverable. Tier is also
  // re-checked server-side by every /autopilot/* endpoint.
  const { hasFeature: _hasFeatureAutopilot } = useEntitlements();
  // showAutopilot removed — the autopilot panel is now the always-on hero
  // at the top of the page (rendered with the `hero` prop), not a toggle.
  const [countOpen, setCountOpen] = useState(false);
  // Every row /api/inventory returned, unfiltered. `items` below is the
  // filtered view; the raw list is kept so a late answer about which surfaces
  // this owner has can re-filter without a refetch.
  //
  // THREE OUTCOMES, NOT TWO. All seven fetches on this page used to be
  // `api.get(...).then(setRows).catch(() => {})`. A refused, dropped or 500'd
  // request left the array at `[]`, and `[]` is the same value an owner with an
  // empty stockroom has — so the page fell through to its empty state and told
  // an owner with 300 varer on the shelf "Ingen lagervarer endnu · 0 varer ·
  // 0 lavt lager · 0/0 prissat". useAsyncData keeps "I could not check" apart
  // from "there is nothing here", and keeps the last rows that WERE true
  // through a failed reload, so this page can say which of the two it means.
  const itemsQ = useAsyncData(
    () => api.get("/inventory").then((r) => (Array.isArray(r.data) ? r.data : [])),
    [],
    { initial: [] },
  );
  const allItems = itemsQ.data;
  const setAllItems = itemsQ.setData;
  // Is /bar in this owner's sidebar? It is gated on the `bar_pour` vertical
  // module, and pour-tracked bottles may only be hidden from THIS page while
  // that page exists to hold them. With the module off, hiding them here hides
  // them everywhere — the bottle is then in no table, no count and no list,
  // which is how a genuinely empty gin bottle went unreported on every screen.
  // Default false, so the failure direction is "show a bottle twice", never
  // "show it nowhere".
  const [barReachable, setBarReachable] = useState(false);
  // The low-stock feed. Its expanded panel says "Alle varer er godt på lager!"
  // when this array is empty — the loudest all-clear on the page, and the one
  // a swallowed error used to put on screen without having asked.
  const alertsQ = useAsyncData(
    () => api.get("/inventory/alerts").then((r) => (Array.isArray(r.data) ? r.data : [])),
    [],
    { initial: [] },
  );
  const alerts = alertsQ.data;
  const categoriesQ = useAsyncData(
    () => api.get("/inventory/categories").then((r) => (Array.isArray(r.data) ? r.data : [])),
    [],
    { initial: [] },
  );
  const categories = categoriesQ.data;
  const [activeCategory, setActiveCategory] = useState("All");
  const [form, setForm] = useState({
    name: "", quantity: "", unit: "pieces", cost_per_unit: "",
    min_threshold: "", category: "General", sell_price: "", is_perishable: false,
    sell_unit: "", pieces_per_unit: "", supplier_name: "", supplier_email: "",
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  // Smart-usage modal state — null = closed, otherwise the item being
  // configured. One shared modal across all rows; opening it for a
  // different item rebuilds its internal state via the `itemId` key.
  const [consumptionModalItem, setConsumptionModalItem] = useState(null);
  // Smart Pricing per-item modal — set to the item the owner clicked
  // "Compare price" on. The modal fetches /api/smart-pricing/item?name=...
  // and renders a single SmartPricingCard.
  const [smartPricingItem, setSmartPricingItem] = useState(null);
  const [adjustId, setAdjustId] = useState(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showSmartImport, setShowSmartImport] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateLoaded, setTemplateLoaded] = useState(null);
  const [templateFilter, setTemplateFilter] = useState(null);
  const [pourModal, setPourModal] = useState(null); // item to pour from
  const [pourCount, setPourCount] = useState(1);
  const [showBarSection, setShowBarSection] = useState(() => localStorage.getItem("bonbox_bar_mode") === "true");
  const [restockItem, setRestockItem] = useState(null);
  const [restockBottles, setRestockBottles] = useState(1);
  // The four panels below the alert zone. Each renders only when its array has
  // rows, so a swallowed error did not print a wrong number here — it printed
  // nothing, and on three of them (dead stock, expiring, expired) an absent
  // warning reads exactly like an all-clear. They report their failure through
  // one banner in the alert zone rather than four.
  // Two shapes on purpose. The endpoint used to return a bare array and now
  // returns {items, measurable}, and this frontend deploys separately from the
  // backend — so an array here means "older server", not "no dead stock", and
  // must still render. Never assume the pair moved together.
  const deadStockQ = useAsyncData(
    () =>
      api.get("/inventory/dead-stock").then((r) => {
        const d = r.data;
        if (Array.isArray(d)) return { items: d, measurable: true };
        return {
          items: Array.isArray(d?.items) ? d.items : [],
          // Absent `measurable` means the old server, which only ever spoke
          // when it had an answer — so treat it as measured, not as unknown.
          measurable: d?.measurable !== false,
        };
      }),
    [],
    { initial: { items: [], measurable: true } },
  );
  const deadStock = deadStockQ.data?.items || [];
  // "We cannot see what sells" — NOT "nothing sells". The difference is the
  // whole point: this venue runs its own till, so BonBox has no demand signal
  // and must not name their ten most valuable items as dead stock.
  const deadStockUnmeasurable = deadStockQ.data?.measurable === false;
  const profitRankingQ = useAsyncData(
    () => api.get("/inventory/profit-ranking").then((r) => (Array.isArray(r.data) ? r.data : [])),
    [],
    { initial: [] },
  );
  const profitRanking = profitRankingQ.data;
  const expiringQ = useAsyncData(   // Items in next 7 days
    () => api.get("/inventory/expiring", { params: { days: 7 } })
      .then((r) => (Array.isArray(r.data) ? r.data : [])),
    [],
    { initial: [] },
  );
  const expiring = expiringQ.data;
  const expiredQ = useAsyncData(    // Items already past expiry
    () => api.get("/inventory/expired").then((r) => (Array.isArray(r.data) ? r.data : [])),
    [],
    { initial: [] },
  );
  const expired = expiredQ.data;
  const [expandedStat, setExpandedStat] = useState(null); // "total" | "low" | "fresh" | "categories" | "priced"
  // TRUE until /inventory has answered once. Without it the five stat tiles
  // rendered off an empty array for the ~1s the request takes, so opening
  // Lager told the owner "0 varer · 0 lavt lager · 0/0 prissat" — a confident
  // report of an empty stockroom, on the page whose whole job is telling them
  // what is on the shelf. Doctrine: a value that is not yet known is a
  // skeleton or an em-dash, never a zero.
  //
  // It is the FIRST answer specifically. useAsyncData raises `loading` again on
  // every reload, and this page reloads after each add, edit, adjust and
  // delete; skeletoning the strip each time would blink numbers the owner had
  // just watched land. Once an answer is in, a refresh keeps the old numbers up
  // until the new ones replace them — or until `failed` says they are stale.
  const [firstAnswerIn, setFirstAnswerIn] = useState(false);
  useEffect(() => { if (!itemsQ.loading) setFirstAnswerIn(true); }, [itemsQ.loading]);
  const loading = itemsQ.loading && !firstAnswerIn;
  // The third state, named. `failed` alone is not enough to decide what to
  // draw: a failed RELOAD still has the last true rows behind it, and stale-
  // but-true beats blank. `stockUnknown` is the case where every count would
  // be a confident zero about a shelf we could not see.
  const stockUnknown = itemsQ.failed && allItems.length === 0;
  // Both header exports. Separate flags so the PDF spinner never appears on
  // the CSV button.
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);

  // One refresh for the whole page, as before — every caller (add, edit,
  // adjust, delete, pour, restock, template load, Smart Import, CountRitual)
  // still gets all seven feeds re-asked. The difference is that a request that
  // comes back angry now leaves `failed` behind instead of nothing at all.
  const fetchData = () => {
    itemsQ.reload();
    alertsQ.reload();
    categoriesQ.reload();
    deadStockQ.reload();
    profitRankingQ.reload();
    expiringQ.reload();
    expiredQ.reload();
  };
  // No mount effect: useAsyncData fetches on mount for each feed.

  // Same source the sidebar and MorePage gate /bar on, so this page and the
  // navigation cannot disagree about whether that page exists.
  useEffect(() => {
    let cancelled = false;
    api.get("/modules")
      .then((res) => {
        if (cancelled) return;
        const enabled = (res.data?.modules || []).filter((m) => m.enabled).map((m) => m.id);
        setBarReachable(enabled.includes("bar_pour"));
      })
      .catch(() => { /* silent — default keeps every row on screen */ });
    return () => { cancelled = true; };
  }, []);

  // Pour-tracked bottles belong to /bar — but only when the owner has it.
  // Mirrors inventory_reorder.stock_page_visible_clause() on the server, which
  // decides the same thing for Home's card and for "Low stock (N)"; if these
  // two drift, the count and the list start disagreeing again.
  const items = useMemo(
    () => (barReachable ? allItems.filter((i) => !i.pour_size || i.pour_size <= 0) : allItems),
    [allItems, barReachable],
  );

  // ─── Smart Scan prefill consumer (invoice → Inventory) ───────────
  //
  // Two entry shapes possible from SmartScanModal:
  //
  //   1. NEW (Q2, May 2026) — direct handoff: SmartScanModal called
  //      `POST /inventory/smart-import/from-smart-scan` and got back a
  //      live draft_id. We open SmartImportModal directly into the
  //      review step (no re-pick of the same image). state shape:
  //        { draft_id: <uuid>, source: 'smart_scan' }
  //
  //   2. LEGACY fallback — when the new endpoint failed (network /
  //      schema / 5xx) the modal still navigates with `prefill` so the
  //      owner can re-pick the file. state shape:
  //        { prefill: <extracted_data | null>, source: 'smart_scan' }
  //
  // Manual-picker source ('smart_scan_manual') also falls into the
  // legacy branch — no prefill, owner enters fresh data.
  const location = useLocation();
  const navigate = useNavigate();
  const [smartScanInvoicePrefill, setSmartScanInvoicePrefill] = useState(null);
  const [smartScanDraftId, setSmartScanDraftId] = useState(null);
  useEffect(() => {
    const st = location.state;
    if (!st || (st.source !== "smart_scan" && st.source !== "smart_scan_manual")) return;
    if (st.draft_id) {
      // Direct handoff — skip the file-pick step entirely.
      setSmartScanDraftId(st.draft_id);
      setSmartScanInvoicePrefill(null);
    } else {
      // Legacy fallback — owner re-picks the file with prefill context.
      setSmartScanDraftId(null);
      setSmartScanInvoicePrefill(st.prefill || { _empty: true });
    }
    setShowSmartImport(true);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // The two money boxes on the add form. Blank cost is still refused by the
  // field's own `required`; this catches text that a number input would have
  // silently rewritten instead.
  const addFormMoneyRejected =
    isMoneyRejected(form.cost_per_unit, mLocale) || isMoneyRejected(form.sell_price, mLocale);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (addFormMoneyRejected) return;
    setError("");
    try {
      await api.post("/inventory", {
        ...form,
        quantity: parseFloat(form.quantity),
        cost_per_unit: parseMoneyInput(form.cost_per_unit, mLocale),
        min_threshold: parseFloat(form.min_threshold),
        sell_price: form.sell_price ? parseMoneyInput(form.sell_price, mLocale) : null,
        sell_unit: form.sell_unit || null,
        pieces_per_unit: form.pieces_per_unit ? parseFloat(form.pieces_per_unit) : null,
        category: form.category || "General",
        // Optional leverandør — empty email must be null (backend EmailStr
        // rejects ""). BonBox TELLS the owner who to reorder from; the owner
        // places the order. Nothing here ever sends a bestilling.
        supplier_name: form.supplier_name?.trim() || null,
        supplier_email: form.supplier_email?.trim() || null,
      });
      setForm({ name: "", quantity: "", unit: "pieces", cost_per_unit: "", min_threshold: "", category: "General", sell_price: "", is_perishable: false, sell_unit: "", pieces_per_unit: "", supplier_name: "", supplier_email: "" });
      fetchData();
      setSuccess(t("itemAdded"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToAddItem")));
    }
  };

  const startEdit = (item) => {
    setEditId(item.id);
    setEditData({
      name: item.name,
      quantity: parseFloat(item.quantity),
      unit: item.unit,
      cost_per_unit: parseFloat(item.cost_per_unit),
      min_threshold: parseFloat(item.min_threshold),
      category: item.category || "General",
      sell_price: item.sell_price != null ? parseFloat(item.sell_price) : "",
      is_perishable: item.is_perishable || false,
      sell_price_per_pour: item.sell_price_per_pour != null ? parseFloat(item.sell_price_per_pour) : "",
      supplier_name: item.supplier_name || "",
      supplier_email: item.supplier_email || "",
    });
  };

  const editMoneyRejected =
    isMoneyRejected(editData.cost_per_unit, mLocale)
    || isMoneyRejected(editData.sell_price, mLocale)
    || isMoneyRejected(editData.sell_price_per_pour, mLocale);

  const saveEdit = async () => {
    try {
      const payload = { ...editData };
      if (payload.quantity === "") payload.quantity = 0;
      // The three price boxes are text now, so these are the owner's own
      // notation and have to be READ. An unreadable one never reaches here —
      // the row's save button is dead while editMoneyRejected is true.
      if (editMoneyRejected) return;
      payload.cost_per_unit = payload.cost_per_unit === ""
        ? 0
        : parseMoneyInput(payload.cost_per_unit, mLocale);
      payload.sell_price = (payload.sell_price === "" || payload.sell_price === null)
        ? null
        : parseMoneyInput(payload.sell_price, mLocale);
      payload.sell_price_per_pour = (payload.sell_price_per_pour === "" || payload.sell_price_per_pour === null)
        ? null
        : parseMoneyInput(payload.sell_price_per_pour, mLocale);
      // Optional leverandør — empty email must be null (backend EmailStr
      // rejects ""). A blank email clears it; a real one is what BonBox names
      // when it tells the owner who to reorder from. The owner orders.
      payload.supplier_name = payload.supplier_name?.trim() || null;
      payload.supplier_email = payload.supplier_email?.trim() || null;
      await api.patch(`/inventory/${editId}`, payload);
      setEditId(null);
      fetchData();
      setSuccess(t("itemUpdated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToUpdate")));
    }
  };

  const adjustStock = async (itemId, change) => {
    const qty = parseFloat(change);
    if (!qty) return;
    try {
      await api.post("/inventory/logs", { item_id: itemId, change_qty: qty, date: localIso() });
      trackEvent("inventory_adjusted", "inventory");  // product analytics
      setAdjustId(null);
      setAdjustQty("");
      fetchData();
      setSuccess(qty > 0 ? t("stockAdded") : t("stockRemoved"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToAdjustStock")));
    }
  };

  const deleteItem = async (id) => {
    try {
      await api.delete(`/inventory/${id}`);
      setDeleteConfirm(null);
      fetchData();
      setSuccess(t("itemDeleted"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToDelete")));
    }
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((i) => i.id)));
    }
  };

  const bulkDelete = async () => {
    try {
      await Promise.all([...selected].map((id) => api.delete(`/inventory/${id}`)));
      setSuccess(`${selected.size} ${t("itemsDeleted")}`);
      setSelected(new Set());
      setBulkDeleteConfirm(false);
      fetchData();
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(t("failedToDeleteSome"));
    }
  };

  const restockBottle = async () => {
    if (!restockItem) return;
    const addMl = (restockItem.bottle_size || 750) * restockBottles;
    try {
      await api.post("/inventory/logs", {
        item_id: restockItem.id,
        change_qty: addMl,
        reason: `restock:${restockBottles} bottle(s)`,
        date: localIso(),
      });
      setSuccess(`${t("restocked")} ${restockItem.name} — ${restockBottles} ${t("bottles")} (${addMl} ${restockItem.pour_unit || "ml"})`);
      setRestockItem(null);
      setRestockBottles(1);
      fetchData();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(errText(err, t("restockFailed")));
      setTimeout(() => setError(""), 3000);
    }
  };

  const recordPour = async () => {
    if (!pourModal) return;
    try {
      const res = await api.post("/inventory/pour", {
        item_id: pourModal.id,
        pours: pourCount,
        date: localIso(),
      });
      const saleMsg = res.data.sale_recorded ? ` · ${t("sale")}: ${formatOwnerMoney(res.data.revenue, user?.currency)}` : "";
      setSuccess(`${t("poured")} ${pourCount}x ${pourModal.name} — ${res.data.remaining_pours} ${t("poursLeft")}${saleMsg}`);
      setPourModal(null);
      setPourCount(1);
      fetchData();
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(errText(err, t("pourFailed")));
      setTimeout(() => setError(""), 3000);
    }
  };

  const loadTemplate = async (templateType) => {
    setTemplateLoading(true);
    try {
      // First fetch template definition to get categories (works even if items already exist)
      const tmplRes = await api.get("/inventory/templates", { params: { template_type: templateType } });
      const tmplCats = [...new Set(tmplRes.data.map((tp) => tp.default_category || "General"))].sort();

      const res = await api.post("/inventory/templates/load", { template_type: templateType });
      setTemplateLoaded(templateType);

      // Enable bar mode when bar template loaded
      if (templateType === "bar") {
        setShowBarSection(true);
        localStorage.setItem("bonbox_bar_mode", "true");
      }

      // Filter categories to this template's categories
      if (tmplCats.length > 0) {
        setTemplateFilter(tmplCats);
        setActiveCategory("All");
      }
      fetchData(); // refresh items + categories behind the panel
      const count = res.data.length;
      setSuccess(count > 0 ? `${t("loaded")} ${count} ${t("itemsFromTemplate")}` : t("allItemsInInventory"));
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(errText(err, t("failedToLoadTemplate")));
    } finally {
      setTemplateLoading(false);
    }
  };

  const alertIds = new Set(alerts.map((a) => a.id));

  const filtered = useMemo(() => {
    let list = items;
    // Filter by template categories if active
    if (templateFilter && activeCategory === "All") {
      list = list.filter((i) => templateFilter.includes(i.category || "General"));
    }
    if (activeCategory !== "All") {
      list = list.filter((i) => (i.category || "General") === activeCategory);
    }
    if (search) {
      list = list.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));
    }
    return list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }, [items, activeCategory, search, templateFilter]);

  // Auto-calculated financials.
  //
  // TWO POPULATIONS, NEVER SUBTRACTED ACROSS. `totalCost` used to add
  // `qty * buy` for EVERY item while `totalRevenue` only added `qty * sell`
  // for the priced ones — so a café with 60 varer and 12 priced read
  // "Potentiel fortjeneste −14.800 kr." in red under the helper word
  // "margin". The owner was looking at the cost of 48 unpriced varer
  // subtracted from the sale value of 12, with nothing on screen saying so.
  //
  //   • stockValueAll — cost of EVERY item. Only ever shown on its own,
  //     under a heading that already counts all items.
  //   • pricedCost / pricedRevenue / pricedProfit / weightedMargin — the
  //     PRICED subset only (a sell price and a real buy price), which is
  //     exactly the `itemsWithMargin` items the strip already counts. These
  //     four tie out against each other: profit = revenue − cost, and
  //     margin = profit ÷ cost.
  //
  // WEIGHTED, NOT AVERAGED. The old margin was the unweighted mean of each
  // item's own percentage, so one cheap garnish at +900% outvoted a whole
  // pallet of flour, and — sitting in the same row as cost, revenue and
  // profit — it disagreed with the profit ÷ cost the owner could do in their
  // head from the three tiles beside it. It is now total profit over total
  // cost across the priced subset, which closes that row, and the tile says
  // it is weighted by the stock on hand so the owner knows why it moves as
  // the shelf empties. The per-item, price-only margin has NOT gone
  // anywhere: every priced row still shows its own % in the table's margin
  // column. `null` (rendered "—") when there is no stock to weight — it used
  // to return a confident, healthy-looking 0%.
  //
  // THREE OUTCOMES, NOT TWO. A row whose quantity or price will not parse is
  // neither priced nor worth 0 kr. — it is unreadable. It is counted and
  // said out loud next to the tiles instead of quietly dragging stock value
  // down by its own cost. (Both columns are non-nullable with default 0, so
  // this is a guard against a malformed payload, not everyday data — but a
  // guard that keeps its own count.)
  const stats = useMemo(() => {
    let stockValueAll = 0, pricedCost = 0, pricedRevenue = 0, itemsWithMargin = 0, unreadable = 0;
    items.forEach((i) => {
      const qty = parseFloat(i.quantity);
      const buy = parseFloat(i.cost_per_unit);
      const sell = i.sell_price != null ? parseFloat(i.sell_price) : null;
      if (!Number.isFinite(qty) || !Number.isFinite(buy) || (sell != null && !Number.isFinite(sell))) {
        unreadable++;
        return;
      }
      const lineCost = qty * buy;
      stockValueAll += lineCost;
      if (sell != null && buy > 0) {
        pricedCost += lineCost;
        pricedRevenue += qty * sell;
        itemsWithMargin++;
      }
    });
    const pricedProfit = pricedRevenue - pricedCost;
    const weightedMargin = pricedCost > 0 ? Math.round((pricedProfit / pricedCost) * 100) : null;
    return { stockValueAll, pricedCost, pricedRevenue, pricedProfit, weightedMargin, itemsWithMargin, unreadable };
  }, [items]);

  // Bar items with pour tracking
  const barItems = useMemo(() => items.filter((i) => i.pour_size && i.pour_size > 0), [items]);

  const perishableCount = items.filter((i) => i.is_perishable).length;
  // "All" is the FILTER ID, not a label — it is compared against elsewhere in
  // this file, so it stays an English constant and only its pill is translated.
  const displayCategories = templateFilter
    ? ["All", ...categories.filter((c) => templateFilter.includes(c))]
    : ["All", ...categories];
  const loadedTemplate = INVENTORY_TEMPLATES.find((tp) => tp.type === templateLoaded);

  // Per-vertical page title (S1 of the inventory redesign). DK trade terms
  // stay Danish across all UI languages — same lock as kasserapport / MOMS.
  // A salon owner should never read kitchen-framed "Inventory Monitor".
  // (S2 will move this into a proper verticalVoice map.)
  // "genbestilling", not "bestilling": the page tells the owner what to
  // reorder, it does not place the order. A title that says otherwise is the
  // same promise the supplier hint was just corrected for.
  const heroTitle = ({
    restaurant: "Lager & genbestilling",
    cafe: "Lager & genbestilling",
    bar: "Lager & bar",
    salon: "Lager & ordre",
    bakery: "Lager",
    retail: "Lager",
  })[(user?.business_type || "").toLowerCase()] || "Lager";

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="LAGER"
          title={heroTitle}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => setShowSmartImport(true)}
                iconLeft={<Icon name="Sparkles" size={16} />}
                title={t("invSmartImportTitle", "Paste, upload or photograph your stock list — AI fills in the rest")}
              >
                {t("invSmartImport", "Smart Import")}
              </Button>
              {/* Stays on the phone: the starter list is what an owner with an
                  empty lager needs FIRST, so it carries no breakpoint class at
                  all. PDF and CSV below are desk work and DO hide under sm —
                  via max-sm:hidden, because the `hidden sm:inline-flex` they
                  used to carry was a no-op over <Button>: Button's base class
                  already contains `inline-flex`, and at equal specificity the
                  built sheet emits `.hidden` BEFORE `.inline-flex`, so
                  inline-flex won at every width and both buttons shipped to
                  every phone. `max-sm:hidden` lives inside a media query that
                  Tailwind emits after the base utilities, so it actually wins. */}
              <Button
                variant="secondary"
                onClick={() => setShowTemplateModal(true)}
              >
                {t("loadTemplate")}
              </Button>
              {/* Export buttons — PDF for accountant handoff (Bogføringsloven
                  §10), CSV for spreadsheet review. Both call the api client
                  with responseType:'blob' so auth carries automatically and
                  the file downloads via a temporary blob URL. Demoted to
                  ghost so the row reads as "one primary + a few utilities"
                  instead of the old rainbow. */}
              <Button
                variant="ghost"
                busy={exportingPdf}
                onClick={async () => {
                  setExportingPdf(true);
                  try {
                    const res = await api.get("/inventory/export.pdf", { responseType: "blob" });
                    // saveFile, not a local anchor: this used to revoke the
                    // blob URL 60s later but had no native path at all, so in
                    // the iOS app the tap did nothing and said nothing.
                    const out = await saveFile(res.data, `stock-list-${localIso()}.pdf`, {
                      type: "application/pdf",
                      title: t("invExportPdfTitle", "Download a PDF stock-list report"),
                    });
                    if (!out.ok) setError(t("invPdfGenFailed", "Couldn't generate PDF — please retry."));
                  } catch (e) {
                    console.error("Export PDF failed", e);
                    setError(errText(e, t("invPdfGenFailed", "Couldn't generate PDF — please retry.")));
                  } finally {
                    setExportingPdf(false);
                  }
                }}
                iconLeft={<Icon name="FileText" size={16} />}
                title={t("invExportPdfTitle", "Download a PDF stock-list report")}
                className="max-sm:hidden"
              >
                PDF
              </Button>
              <Button
                variant="ghost"
                busy={exportingCsv}
                onClick={async () => {
                  setExportingCsv(true);
                  try {
                    const res = await api.get("/inventory/export.csv", { responseType: "blob" });
                    const out = await saveFile(res.data, `stock-list-${localIso()}.csv`, {
                      type: "text/csv;charset=utf-8;",
                      title: t("invExportCsvTitle", "Download stock list as CSV (Excel-friendly, semicolon delimited)"),
                    });
                    if (!out.ok) setError(t("invCsvGenFailed", "Couldn't generate CSV — please retry."));
                  } catch (e) {
                    console.error("Export CSV failed", e);
                    setError(errText(e, t("invCsvGenFailed", "Couldn't generate CSV — please retry.")));
                  } finally {
                    setExportingCsv(false);
                  }
                }}
                iconLeft={<Icon name="FileSpreadsheet" size={16} />}
                title={t("invExportCsvTitle", "Download stock list as CSV (Excel-friendly, semicolon delimited)")}
                className="max-sm:hidden"
              >
                CSV
              </Button>
            </>
          }
        />
      </FadeIn>

      {/* Genbestilling heads-up (S3 of the inventory redesign) — the no-send
          reorder heads-up is the FIRST thing the owner sees, always-on. It
          auto-loads "what's running low this week" for Pro; Free/Starter see
          the upsell card. BonBox TELLS what to genbestil + how much + by when;
          the owner places the order themselves (Kopiér bestilling). BonBox
          sends nothing — no supplier emails. */}
      <InventoryAutopilotPanel hero onAddSupplier={() => setShowSmartImport(true)} />

      {/* Weekly count entry (S4) — now that the recipe auto-deduct keeps stock
          live, the optælling is "confirm only what's off". One tap opens the
          guided ritual; it writes back in one call via /count/reconcile.
          Only shown when there's countable stock: pour-tracked bottles live on
          the dedicated Bar page (filtered out of `items` above), so a pure-bar
          account would otherwise see a card that opens to nothing. */}
      {items.length > 0 && (
        <button
          type="button"
          onClick={() => setCountOpen(true)}
          className="w-full text-left flex items-center gap-3 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-3.5 hover:bg-gray-50 dark:hover:bg-[rgb(var(--surface-raised))] transition"
        >
          <span className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
            <ClipboardCheckIcon size={20} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold text-gray-900 dark:text-gray-100">
              {t("countCardTitle", "Ugentlig optælling")}
            </span>
            <span className="block text-sm text-gray-500 dark:text-gray-400">
              {t("countCardSub", "BonBox holder dit lager opdateret fra salget — bekræft det på hylden.")}
            </span>
          </span>
          <span className="shrink-0 hidden sm:inline-flex items-center gap-1.5 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 px-3 py-2 text-sm font-semibold">
            {t("countStart", "Start optælling")}
            <ArrowRightIcon size={15} strokeWidth={2} aria-hidden="true" />
          </span>
        </button>
      )}

      <CountRitual
        open={countOpen}
        items={items}
        onClose={() => setCountOpen(false)}
        onDone={() => fetchData()}
      />

      <SmartImportModal
        open={showSmartImport}
        onClose={() => {
          setShowSmartImport(false);
          setSmartScanInvoicePrefill(null);
          setSmartScanDraftId(null);
        }}
        smartScanPrefill={smartScanInvoicePrefill}
        draftId={smartScanDraftId}
        onCommitted={() => {
          // Refresh the items list so the new rows appear immediately.
          fetchData();
          setSmartScanInvoicePrefill(null);
          setSmartScanDraftId(null);
        }}
      />

      {success &&<div className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

      <DismissibleTip
        id="inventory-intro-v1"
        iconName="Package"
        title={t("invHowItWorksTitle", "How inventory works")}
      >
        <p>
          {t("invHowItWorksIntro", "Add what you stock with a unit cost and minimum reorder level. BonBox watches your sales and")}{" "}
          <strong>{t("invHowItWorksAutoDeduct", "auto-deducts quantity")}</strong> {t("invHowItWorksMid", "as items sell, then alerts you when you drop below minimum or when an expiry date is approaching. Use")} <strong>{t("invHowItWorksLoadTemplate", "Load template")}</strong> {t("invHowItWorksEnd", "to import a starter list for cafés, bars and shops.")}
        </p>
      </DismissibleTip>

      {alerts.length > 0 && (
        <SectionBanner
          severity="critical"
          icon="AlertTriangle"
          title={`${t("lowStockAlerts")}: ${alerts.length} ${t("itemsBelowMinStock")}`}
        />
      )}

      {/* The warning feeds, when they could not be asked.
          Dead stock, expiring and expired each render ONLY when they have rows,
          so a swallowed error here did not show a wrong number — it showed no
          banner, which on a page of warnings reads as "nothing to worry about".
          That is the same lie in its quietest form, so the silence gets a
          sentence. One banner for all four rather than four, because the owner
          needs to know the alarms did not run, not which endpoint sulked. */}
      {(deadStockQ.failed || expiringQ.failed || expiredQ.failed || profitRankingQ.failed) && (
        <LoadFailed
          onRetry={() => {
            deadStockQ.reload();
            expiringQ.reload();
            expiredQ.reload();
            profitRankingQ.reload();
          }}
          body={t(
            "invAlertsUnchecked",
            "We couldn't check expiry and dead stock just now — no warning here doesn't mean there is none.",
          )}
        />
      )}

      {/* ─── Expiry alerts (already past = waste candidate; soon = use first) ─── */}
      {(expired.length > 0 || expiring.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {expired.length > 0 && (
            <SectionBanner
              severity="critical"
              icon="AlertTriangle"
              title={`${expired.length} ${expired.length === 1 ? t("invExpiredItemSingular", "item") : t("invExpiredItemPlural", "items")} ${t("invPastExpiry", "past expiry")}`}
            >
              <p className="mb-2">{t("invExpiredBody", "Move to Waste or remove from stock — usable inventory shouldn't include these.")}</p>
              <ul className="space-y-0.5 text-[12px]">
                {expired.slice(0, 3).map((it) => (
                  <li key={it.id} className="truncate">
                    • {it.name} <span className="opacity-70">({formatDateClear(it.expiry_date)}, {Number(it.quantity).toFixed(1)} {it.unit})</span>
                  </li>
                ))}
                {expired.length > 3 && (
                  <li>
                    <Link
                      to="/expiry"
                      className="underline hover:no-underline font-medium"
                    >
                      + {expired.length - 3} {t("invMoreViewAll", "more — view all →")}
                    </Link>
                  </li>
                )}
              </ul>
            </SectionBanner>
          )}
          {expiring.length > 0 && (
            <SectionBanner
              severity="warn"
              icon="AlarmClock"
              title={`${expiring.length} ${expiring.length === 1 ? t("invExpiredItemSingular", "item") : t("invExpiredItemPlural", "items")} ${t("invExpiringWithin7", "expiring within 7 days")}`}
            >
              <p className="mb-2">{t("invExpiringBody", "Use these first or plan a discount — first-expired-first-out keeps waste low.")}</p>
              <ul className="space-y-0.5 text-[12px]">
                {expiring.slice(0, 3).map((it) => (
                  <li key={it.id} className="truncate">
                    • {it.name} <span className="opacity-70">({formatDateClear(it.expiry_date)}, {Number(it.quantity).toFixed(1)} {it.unit})</span>
                  </li>
                ))}
                {expiring.length > 3 && (
                  <li>
                    <Link
                      to="/expiry"
                      className="underline hover:no-underline font-medium"
                    >
                      + {expiring.length - 3} {t("invMoreViewAll", "more — view all →")}
                    </Link>
                  </li>
                )}
              </ul>
            </SectionBanner>
          )}
        </div>
      )}

      {/* Bar pour items now live on /bar — extracted to a dedicated page
          gated by the bar_pour vertical module. Owners who run a bar see
          a Bar entry in their sidebar; everyone else gets a calmer
          inventory page focused on general kitchen / shop / pantry stock. */}

      {/* Financial overview — auto-calculated from buy/sell prices. Once
          we have 10+ priced items, surface a four-tile KPI strip via the
          unified StatCard. The single "accent" goes on potential profit
          (the money moment); margin uses red when negative — that's a
          data-true color, not decoration. */}
      {stats.itemsWithMargin >= 10 ? (
        <div className="space-y-2">
          {/* SAY THE SCOPE OUT LOUD. All four tiles read the priced subset, so
              the strip's arithmetic closes: profit = revenue − cost, and the
              margin is that profit over that cost. Before, tile 1 counted all
              60 varer and tiles 2–3 counted the 12 priced ones, and the owner
              had no way to reconcile the red number in the middle. */}
          <p className="text-[12px] text-gray-500 dark:text-gray-400">
            {t("invPricedScopeStrip")} · {stats.itemsWithMargin}/{items.length} {t("itemsPriced")}
            {stats.unreadable > 0 ? ` · ${stats.unreadable} ${t("invRowsUnreadable", "items could not be read")}` : ""}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label={t("stockCost")}
              value={<Amount value={stats.pricedCost} currency={currency} />}
              helper={t("invested")}
            />
            <StatCard
              label={t("potentialRevenue")}
              value={<Amount value={stats.pricedRevenue} currency={currency} />}
              helper={t("ifAllSold")}
            />
            <StatCard
              label={t("potentialProfit")}
              value={<Amount value={stats.pricedProfit} currency={currency} sign />}
              accent={stats.pricedProfit >= 0 ? "success" : "critical"}
              // The helper used to read "margin" under a kroner figure. It now
              // states the subtraction the tile actually performed.
              helper={t("invPotentialProfitHelper")}
            />
            <StatCard
              label={t("weightedMargin")}
              value={stats.weightedMargin == null ? "—" : `${stats.weightedMargin}%`}
              accent={stats.weightedMargin != null && stats.weightedMargin < 0 ? "critical" : "neutral"}
              // Says WHY this number moves when no price changed: it is the
              // margin of what is on the shelf today, not an average of the
              // price list. The priced count sits in the caption above.
              helper={t("invWeightedMarginHelper", "margin weighted by stock on hand")}
            />
          </div>
        </div>
      ) : items.length > 0 && (
        <SectionBanner
          severity="info"
          icon="Sparkles"
          title={t("addSellPricesHint")}
          body={`${stats.itemsWithMargin}/${items.length} ${t("itemsPriced")} — ${t("needAtLeast10")}`}
        />
      )}

      {/* Summary cards — Task #119 Phase 3: rainbow buttons replaced
          with neutral StatCard primitives.  Click-to-expand affordance
          preserved via onClick + ChevronDown.  Only data-true accents
          remain: red on lowStock only when alerts.length > 0 (otherwise
          neutral — there's no alert to signal), amber on "priced" only
          when a meaningful share of items are still un-priced. */}
      <div className="space-y-3">
        {loading ? (
          // The zone's own shape — five tiles in the same grid — so the page
          // does not reflow when the real numbers land. The line above the bars
          // is there because bars alone say "wait" without saying for what, and
          // an owner on a bad connection deserves the difference between a slow
          // page and a stuck one.
          <>
            <p className="text-[13px] text-gray-500 dark:text-gray-400">
              {t("invLoadingStock", "Checking what's on the shelf…")}
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {[0, 1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
            </div>
          </>
        ) : stockUnknown ? (
          // INSTEAD OF the five tiles, never above them. All five are counts
          // off `items`, and with no answer every one of them reads 0 — the
          // page would state an empty stockroom as fact on the strength of a
          // request that never came back.
          <LoadFailed
            onRetry={fetchData}
            body={t(
              "invStockUnchecked",
              "We couldn't read your stock list, so these totals are missing rather than zero.",
            )}
          />
        ) : (
        <>
          {/* Failed RELOAD with rows still behind it. The numbers below were
              true at the last successful check, which beats blanking them —
              but only if the page says so out loud. */}
          {itemsQ.failed && (
            <LoadFailed
              onRetry={fetchData}
              body={t("invStockStale", "These numbers are from the last check that worked.")}
            />
          )}
        <div className="grid grid-cols-3 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard
            label={t("totalItems")}
            value={items.length}
            onClick={() => setExpandedStat(expandedStat === "total" ? null : "total")}
            selected={expandedStat === "total"}
            expandable
            ariaControls="inventory-stat-panel"
          />
          <StatCard
            label={t("lowStock")}
            // Its own feed, its own third state: "—" when we could not ask.
            // A 0 here is the tile version of "all well stocked", and this
            // page is not allowed to say that on a request that failed.
            value={alertsQ.failed && alerts.length === 0 ? "—" : alerts.length}
            // Critical accent only when there's an alert to signal —
            // with 0 low-stock items the tile stays neutral, no false alarm.
            accent={alerts.length > 0 ? "critical" : "neutral"}
            onClick={() => setExpandedStat(expandedStat === "low" ? null : "low")}
            selected={expandedStat === "low"}
            expandable
            ariaControls="inventory-stat-panel"
          />
          <StatCard
            label={t("freshItems")}
            value={perishableCount}
            onClick={() => setExpandedStat(expandedStat === "fresh" ? null : "fresh")}
            selected={expandedStat === "fresh"}
            expandable
            ariaControls="inventory-stat-panel"
          />
          <StatCard
            label={t("categories")}
            value={categoriesQ.failed && categories.length === 0 ? "—" : categories.length}
            onClick={() => setExpandedStat(expandedStat === "categories" ? null : "categories")}
            selected={expandedStat === "categories"}
            expandable
            ariaControls="inventory-stat-panel"
          />
          <StatCard
            label={t("priced")}
            value={`${stats.itemsWithMargin}/${items.length}`}
            // Warn accent when 5+ items are still un-priced — owner
            // can't calculate margin on those, so it's a real coverage
            // gap.  Below that, stay neutral.
            accent={items.length > 0 && (items.length - stats.itemsWithMargin) >= 5 ? "warn" : "neutral"}
            onClick={() => setExpandedStat(expandedStat === "priced" ? null : "priced")}
            selected={expandedStat === "priced"}
            expandable
            ariaControls="inventory-stat-panel"
          />
        </div>
        </>
        )}

        {/* Expanded detail panels — each variant shares the same DOM id
            so the StatCard's aria-controls reference resolves regardless
            of which one is open.  Sub-panel chrome (the per-variant
            colored border + dot pills inside) is unchanged for this
            iteration per the Phase 3 scope: outer tile chrome only. */}
        {expandedStat === "total" && (
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-800 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("allItems")} ({items.length})</p>
              <StatPanelClose onClick={() => setExpandedStat(null)} t={t} />
            </div>
            {(() => {
              const byCat = {};
              items.forEach(i => { byCat[i.category || "General"] = (byCat[i.category || "General"] || []).concat(i); });
              return (
                <>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {Object.entries(byCat).sort((a, b) => b[1].length - a[1].length).map(([cat, list]) => (
                      <span key={cat} className="px-2.5 py-1 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-lg text-xs font-bold text-gray-700 dark:text-gray-300">{categoryLabel(t, cat)} · {list.length}</span>
                    ))}
                  </div>
                  {/* This panel is headed "Alle varer (60)", so stock value is
                      the whole shelf — but sale value and margin can only come
                      from the varer that HAVE a sell price. The two scopes now
                      say which is which instead of sitting side by side as if
                      they covered the same rows. And margin renders "—" where
                      nothing is priced: it used to print a confident green 0%,
                      which reads as "you break even" rather than "we don't
                      know yet". */}
                  <div className="grid grid-cols-3 gap-2 mb-1.5">
                    <div className="text-center p-2 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 font-semibold">{t("stockValue")}</p>
                      <p className="text-sm font-semibold text-gray-800 dark:text-white"><Amount value={stats.stockValueAll} currency={currency} /></p>
                    </div>
                    <div className="text-center p-2 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 font-semibold">{t("saleValue")}</p>
                      {/* Nothing priced means we do not know what the shelf
                          sells for — not that it sells for 0 kr. The tile
                          beside it already says "—" for exactly this. */}
                      {stats.itemsWithMargin === 0 ? (
                        <p className="text-sm font-semibold text-gray-400 dark:text-gray-500">—</p>
                      ) : (
                        <p className="text-sm font-semibold text-gray-800 dark:text-white"><Amount value={stats.pricedRevenue} currency={currency} /></p>
                      )}
                    </div>
                    <div className="text-center p-2 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 font-semibold">{t("weightedMargin")}</p>
                      <p className={`text-sm font-semibold ${stats.weightedMargin == null ? "text-gray-400 dark:text-gray-500" : stats.weightedMargin >= 0 ? "text-[rgb(var(--brand-green-accent))]" : "text-red-500 dark:text-red-400"}`}>
                        {stats.weightedMargin == null ? "—" : `${stats.weightedMargin}%`}
                      </p>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3">
                    {t("invStockValueScopeNote")} · {t("invWeightedMarginHelper", "margin weighted by stock on hand")} · {stats.itemsWithMargin}/{items.length} {t("itemsPriced")}
                    {stats.unreadable > 0 ? ` · ${stats.unreadable} ${t("invRowsUnreadable", "items could not be read")}` : ""}
                  </p>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {items.slice(0, 15).map((i) => (
                      <div key={i.id} className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-700/30 rounded-lg text-xs">
                        <span className="font-medium text-gray-800 dark:text-white truncate max-w-[40%]">{i.name}</span>
                        <span className="text-gray-500 dark:text-gray-400">{categoryLabel(t, i.category)}</span>
                        <span className="font-bold text-gray-700 dark:text-gray-300">{i.quantity} {i.unit}</span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {expandedStat === "low" && (
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-red-200 dark:border-red-800 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                {t("lowStockItems")} ({alertsQ.failed && alerts.length === 0 ? "—" : alerts.length})
              </p>
              <StatPanelClose onClick={() => setExpandedStat(null)} t={t} />
            </div>
            {/* The all-clear is the sentence this whole change exists for.
                "Alle varer er godt på lager!" is a claim about every vare in
                the stockroom, and it used to be printed off an array that was
                empty because the request failed. It now needs a successful
                answer behind it; without one the owner gets the honest version
                and a way to ask again. */}
            {alertsQ.failed && alerts.length === 0 ? (
              <LoadFailed
                onRetry={alertsQ.reload}
                body={t("invLowStockUnchecked", "We couldn't check low stock — this is not an all-clear.")}
              />
            ) : alerts.length > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {alerts.map((a) => (
                  <div key={a.id} className="flex items-center justify-between px-3 py-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs">
                    <div>
                      <span className="font-bold text-red-700 dark:text-red-400">{a.name}</span>
                      <span className="text-red-500/60 ml-2">{categoryLabel(t, a.category)}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-semibold text-red-600 dark:text-red-400">{a.quantity} {a.unit}</span>
                      {/* `min_stock` is not a field InventoryItemResponse has
                          ever served, so every row printed "Min stock:" and
                          then nothing — on the one list that is supposed to
                          tell the owner how far below the line they are. */}
                      <span className="text-red-400/50 ml-2">
                        {t("minStock")}: {Number.isFinite(Number(a.min_threshold)) ? Number(a.min_threshold) : "—"} {a.unit}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-[rgb(var(--brand-green-accent))] text-center py-3 font-medium">{t("allWellStocked")}</p>}
          </div>
        )}

        {expandedStat === "fresh" && (
          /* The stat panels used to be colour-coded by WHICH panel you opened —
             orange for fresh, purple for categories, blue for priced — so the
             same neutral list of goods changed hue depending on the tile you
             tapped. That is decoration, and decoration is what makes a screen
             look vibe-coded. The surface is neutral now; the one mark left in
             colour is the expiry date, which is the only thing here that is a
             status (amber, the app's "watch this"). */
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("perishableItems")} ({perishableCount})</p>
              <StatPanelClose onClick={() => setExpandedStat(null)} t={t} />
            </div>
            {perishableCount > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {items.filter(i => i.is_perishable).map((i) => (
                  <div key={i.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-700/40 rounded-lg text-xs">
                    <div>
                      <span className="font-medium text-gray-900 dark:text-gray-100">{i.name}</span>
                      <span className="text-gray-400 dark:text-gray-500 ml-2">{categoryLabel(t, i.category)}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">{i.quantity} {i.unit}</span>
                      {i.expiry_date && <span className="text-amber-600 dark:text-amber-400 ml-2">{t("expExpiresLabel", "Expires:")} {formatDateClear(i.expiry_date)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-gray-400 text-center py-3">{t("noPerishableItems")}</p>}
          </div>
        )}

        {expandedStat === "categories" && (
          /* No hue of its own. A category total is a plain number — it is not
             late, not low, not overdue — so it carries no status and therefore
             no colour. This panel used to paint its border, every row
             background, every name and every amount purple, which is the
             "different colour per row" look the whole page was cleaned of,
             one tap above the picker that was cleaned. */
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                {t("categories")} ({categoriesQ.failed && categories.length === 0 ? "—" : categories.length})
              </p>
              <StatPanelClose onClick={() => setExpandedStat(null)} t={t} />
            </div>
            {/* Instead of "Ingen kategorier endnu", which an owner who has
                sorted their lager into nine of them would read as data loss. */}
            {categoriesQ.failed && categories.length === 0 ? (
              <LoadFailed onRetry={categoriesQ.reload} />
            ) : categories.length > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {categories.map((cat) => {
                  const catItems = items.filter(i => (i.category || "General") === cat);
                  const catValue = catItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.cost_per_unit), 0);
                  return (
                    <button key={cat} onClick={() => { setActiveCategory(cat); setExpandedStat(null); }} className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-700/40 rounded-lg text-xs hover:bg-gray-100 dark:hover:bg-gray-700 transition">
                      <span className="font-medium text-gray-900 dark:text-gray-100">{categoryLabel(t, cat)}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-gray-400 dark:text-gray-500">{catItems.length} {t("items")}</span>
                        <span className="font-medium text-gray-900 dark:text-gray-100"><Amount value={catValue} currency={currency} /></span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : <p className="text-sm text-gray-400 text-center py-3">{t("noCategoriesYet")}</p>}
          </div>
        )}

        {expandedStat === "priced" && (
          /* Neutral surface, same as the other two. The status here is the
             margin (emerald / red) and the "mangler salgspris" rows — a buy
             and a sell price are just numbers, so they read as numbers. */
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("pricingStatus")} ({stats.itemsWithMargin}/{items.length})</p>
              <StatPanelClose onClick={() => setExpandedStat(null)} t={t} />
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {items.filter(i => i.sell_price != null && parseFloat(i.sell_price) > 0).length > 0 && (
                <p className="text-[11px] uppercase tracking-wide text-[rgb(var(--brand-green-accent))] font-semibold px-1 mb-1">{t("priced")}</p>
              )}
              {items.filter(i => i.sell_price != null && parseFloat(i.sell_price) > 0).slice(0, 10).map((i) => {
                const margin = parseFloat(i.cost_per_unit) > 0 ? Math.round(((parseFloat(i.sell_price) - parseFloat(i.cost_per_unit)) / parseFloat(i.cost_per_unit)) * 100) : 0;
                return (
                  <div key={i.id} className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-xs">
                    <span className="font-medium text-gray-800 dark:text-white truncate max-w-[35%]">{i.name}</span>
                    <span className="text-gray-500">{t("buyLabel")}: <Amount value={parseFloat(i.cost_per_unit)} currency={currency} decimals={2} /></span>
                    <span className="text-gray-700 dark:text-gray-200">{t("sellLabel")}: <Amount value={parseFloat(i.sell_price)} currency={currency} decimals={2} /></span>
                    <span className={`font-semibold tabular-nums ${margin >= 0 ? "text-[rgb(var(--brand-green-accent))]" : "text-red-500 dark:text-red-400"}`}>{margin}%</span>
                  </div>
                );
              })}
              {items.filter(i => !i.sell_price || parseFloat(i.sell_price) === 0).length > 0 && (
                <>
                  <p className="text-[11px] uppercase tracking-wide text-red-500 dark:text-red-400 font-semibold px-1 mt-2 mb-1">{t("notPriced")}</p>
                  {items.filter(i => !i.sell_price || parseFloat(i.sell_price) === 0).slice(0, 8).map((i) => (
                    <div key={i.id} className="flex items-center justify-between px-3 py-1.5 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs">
                      <span className="font-medium text-gray-800 dark:text-white truncate max-w-[50%]">{i.name}</span>
                      <span className="text-gray-500">{t("cost")}: <Amount value={parseFloat(i.cost_per_unit)} currency={currency} decimals={2} /></span>
                      <span className="text-red-400 font-medium">{t("noSellPrice")}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Category tabs — TabPills (gray-900 active, not green) so they
          match the sidebar's neutral-dark active treatment. Reserves the
          one emerald accent for the Order autopilot button at the top.
          The first pill is the owner's OWN language ("Vis alle"), not the
          literal filter id "All" this page keys the filter on. */}
      {categories.length > 0 && (
        <div>
          {templateFilter && (
            <div className="flex items-center gap-2 mb-2">
              <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">
                {t("filteredBy")}: {loadedTemplate ? t(loadedTemplate.nameKey) : t("loadTemplate")}
              </p>
              <button
                onClick={() => { setTemplateFilter(null); setActiveCategory("All"); }}
                className="text-xs text-gray-400 hover:text-red-500 transition inline-flex items-center gap-1"
                aria-label={t("showAll")}
              >
                <Icon name="X" size={12} /> {t("showAll")}
              </button>
            </div>
          )}
          <TabPills
            ariaLabel={t("invCategoryFilter", "Category filter")}
            activeId={activeCategory}
            onChange={setActiveCategory}
            tabs={displayCategories.map((cat) => ({
              id: cat,
              label: cat === "All" ? t("showAll") : categoryLabel(t, cat),
            }))}
          />
        </div>
      )}

      {/* Dead Stock — was a full-bleed red gradient, now a SectionBanner
          severity="critical" containing the list. The red stays on the
          per-item value because that's a data-true color (loss).  Page
          chrome around it is calm gray + a single red border. */}
      {/* BonBox is not this venue's till and nobody has logged a count, so
          there is no demand signal to read. Say that plainly — calm, no
          delete buttons. The alternative, and what shipped for months, was
          listing the venue's ten most valuable items under a red "Dødt lager"
          heading because a column no cafe ever writes came back empty. */}
      {deadStockUnmeasurable && (
        <SectionBanner
          severity="info"
          icon="Info"
          title={t("deadStockUnmeasurableTitle", "We can't tell what's moving yet")}
        >
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            {t(
              "deadStockUnmeasurableBody",
              "BonBox isn't your till, so it can't see which items sell. Do a stock count and it will start tracking what moves.",
            )}
          </p>
        </SectionBanner>
      )}

      {deadStock.length > 0 && (
        <SectionBanner
          severity="critical"
          icon="AlertTriangle"
          title={t("deadStockTitle")}
        >
          <div className="space-y-2 mt-2">
            {deadStock.map((ds) => (
              <div key={ds.id} className="flex items-center justify-between bg-white/70 dark:bg-[rgb(var(--surface-card))] px-3 py-2 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{ds.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {/* Say what the clock actually measured. The server now
                        reports days_since_last_movement plus which signal it
                        came from, because an InventoryLog is a pour, a restock
                        or a count correction — handling, not selling. Printing
                        that as "siden sidste salg" would repeat the original
                        bug one layer down. Falls back to the old field so an
                        older server still renders. */}
                    {ds.quantity} {t("inStock")} · {
                      ds.days_since_last_movement != null
                        ? `${ds.days_since_last_movement} ${
                            ds.last_movement_kind === "sale"
                              ? t("daysSinceLastSale")
                              : t("daysSinceLastMovement", "days since last movement")
                          }`
                        : ds.days_since_last_sale == null || ds.days_since_last_sale >= 999
                          ? t("neverSold")
                          : `${ds.days_since_last_sale} ${t("daysSinceLastSale")}`
                    }
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-red-600 dark:text-red-400"><Amount value={ds.stock_value} currency={currency} /></p>
                  <button
                    onClick={async () => {
                      if (!(await confirm({ message: `${t("removeFromInventory")} "${ds.name}"?`, destructive: true, confirmLabel: t("removeItem") }))) return;
                      try {
                        await api.delete(`/inventory/${ds.id}`);
                        deadStockQ.setData((prev) => ({
                          ...prev,
                          items: (prev?.items || []).filter((d) => d.id !== ds.id),
                        }));
                        setAllItems((prev) => prev.filter((it) => it.id !== ds.id));
                      } catch (err) {
                        // Same rule one layer over: a delete that the server
                        // refused used to remove nothing and say nothing, so
                        // the owner tapped X, watched the row stay, and had no
                        // idea whether BonBox had heard them.
                        setError(errText(err, t("failedToDelete")));
                      }
                    }}
                    className="text-red-400 hover:text-red-600 dark:hover:text-red-300 transition p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded"
                    title={t("removeItem")}
                    aria-label={t("removeItem")}
                  >
                    <Icon name="X" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-red-200/60 dark:border-red-800/40 flex justify-between items-center">
            <p className="text-xs text-red-700 dark:text-red-300 font-medium">{t("totalDeadStockValue")}</p>
            <p className="text-base font-bold text-red-700 dark:text-red-400 tabular-nums">
              <Amount value={deadStock.reduce((sum, ds) => sum + ds.stock_value, 0)} currency={currency} />
            </p>
          </div>
        </SectionBanner>
      )}

      {/* Top Profit Items — was a full green-emerald gradient. The
          margin percentage stays green (data-true: profit > 0), but the
          card chrome itself is now a neutral gray-50 surface so this no
          longer competes visually with the dead-stock alert above. */}
      {profitRanking.length > 0 && (
        <div className="bg-gray-50 dark:bg-[rgb(var(--surface-subtle))] border border-gray-200 dark:border-gray-800 p-5 rounded-xl">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-2">
            <Icon name="TrendingUp" size={16} className="text-[rgb(var(--brand-green-accent))]" />
            {t("bestMarginItems")}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {profitRanking.slice(0, 5).map((pr, idx) => (
              <div key={pr.name} className="flex items-center gap-3 bg-white dark:bg-[rgb(var(--surface-card))] border border-gray-200 dark:border-[rgb(var(--surface-line))] px-3 py-2 rounded-lg">
                <span className="text-lg font-bold text-gray-400 dark:text-gray-500 w-6 text-center tabular-nums">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{pr.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    <Amount value={pr.cost} currency={currency} decimals={2} /> → <Amount value={pr.sell} currency={currency} decimals={2} />
                  </p>
                </div>
                <span className="text-sm font-bold text-[rgb(var(--brand-green-accent))] whitespace-nowrap tabular-nums">+{pr.margin_pct}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add item form */}
      <div className="bg-white dark:bg-[rgb(var(--surface-card))] p-6 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))]">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">{t("addItem")}</h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <input type="text" placeholder={t("itemName")} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg col-span-2 md:col-span-1" required />
          <input type="number" step="0.01" placeholder={t("quantity")} value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg">
            <option value="pieces">{t("pieces")}</option>
            <option value="kg">{t("kg")}</option>
            <option value="liters">{t("liters")}</option>
            <option value="boxes">{t("boxes")}</option>
            <option value="bundle">{t("bundle")}</option>
            <option value="dozen">{t("dozen")}</option>
          </select>
          <input type="text" placeholder={t("categoryPlaceholder")} value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />

          {/* Sell unit conversion — show when stocked in bulk units */}
          {["dozen", "boxes", "bundle"].includes(form.unit) && (
            <>
              <select value={form.sell_unit} onChange={(e) => {
                const su = e.target.value;
                const auto = su === "pieces" && form.unit === "dozen" ? "12" : form.pieces_per_unit;
                setForm({ ...form, sell_unit: su, pieces_per_unit: auto });
              }} className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg">
                <option value="">{t("invSellAsUnit", "Sell as")} ({form.unit})</option>
                <option value="pieces">{t("invSellAsPieces", "Sell as pieces")}</option>
              </select>
              {form.sell_unit === "pieces" && (
                <input type="number" step="1" placeholder={`${t("invPiecesPer", "Pieces per")} ${form.unit}`} value={form.pieces_per_unit}
                  onChange={(e) => setForm({ ...form, pieces_per_unit: e.target.value })}
                  className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
              )}
            </>
          )}

          <MoneyField locale={mLocale} placeholder={`${t("cost")} (${currency})`} value={form.cost_per_unit}
            onChange={(e) => setForm({ ...form, cost_per_unit: e.target.value })}
            className="w-full px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <MoneyField locale={mLocale} placeholder={`${t("sellPrice")} (${currency})`} value={form.sell_price}
            onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
            className="w-full px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <input type="number" step="0.01" placeholder={t("minStock")} value={form.min_threshold}
            onChange={(e) => setForm({ ...form, min_threshold: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <label className="flex items-center gap-2 px-3 py-3 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={form.is_perishable}
              onChange={(e) => setForm({ ...form, is_perishable: e.target.checked })}
              className="rounded" />
            {t("freshItem")}
          </label>
          {/* Optional leverandør — so the reorder heads-up can name WHO to
              order this vare from. BonBox sends nothing: the owner places the
              order, same promise the panel at the top of this page makes.
              Email is validated server-side. */}
          <input type="text" placeholder={t("invSupplierName", "Leverandør (valgfri)")} value={form.supplier_name}
            onChange={(e) => setForm({ ...form, supplier_name: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <input type="email" placeholder={t("invSupplierEmail", "Leverandør-email")} value={form.supplier_email}
            onChange={(e) => setForm({ ...form, supplier_email: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <div className="col-span-2 md:col-span-4">
            <Button type="submit" variant="primary" size="lg" className="w-full">
              {t("addItem")}
            </Button>
          </div>
        </form>
      </div>

      {/* Inventory table */}
      <div className="bg-white dark:bg-[rgb(var(--surface-card))] rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("stockItems")} {activeCategory !== "All" && <span className="text-sm font-normal text-gray-500">({categoryLabel(t, activeCategory)})</span>}
          </h2>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchItems")}
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
        </div>
        {selected.size > 0 && (
          <div className="px-6 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 flex items-center justify-between">
            <span className="text-sm font-medium text-red-700 dark:text-red-400">{selected.size} {t("selected")}</span>
            {bulkDeleteConfirm ? (
              <span className="flex items-center gap-2">
                <span className="text-sm text-red-600 dark:text-red-400">{t("delete")} {selected.size} {t("items")}?</span>
                <button onClick={bulkDelete} className="bg-red-600 text-white text-xs font-bold px-3 py-1 rounded hover:bg-red-700">{t("yesDelete")}</button>
                <button onClick={() => setBulkDeleteConfirm(false)} className="bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 text-xs font-bold px-3 py-1 rounded">{t("cancel")}</button>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <button onClick={() => setBulkDeleteConfirm(true)} className="bg-red-600 text-white text-xs font-bold px-3 py-1 rounded hover:bg-red-700">{t("deleteSelected")}</button>
                <button onClick={() => setSelected(new Set())} className="text-gray-500 dark:text-gray-400 text-xs hover:underline">{t("clear")}</button>
              </span>
            )}
          </div>
        )}
        {/* Desktop / tablet table — unchanged from md+ up */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-3 py-2.5 w-10">
                  <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-gray-900" />
                </th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("item")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("category")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">{t("quantity")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("unit")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">{t("cost")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">{t("sell")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">{t("margin")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">{t("profit")}</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">{t("actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filtered.map((item) => {
                const qty = parseFloat(item.quantity);
                const buy = parseFloat(item.cost_per_unit);
                const sell = item.sell_price != null ? parseFloat(item.sell_price) : null;
                const margin = sell && buy > 0 ? Math.round(((sell - buy) / buy) * 100) : null;
                const profit = sell != null ? (sell - buy) * qty : null;

                return (
                  <Fragment key={item.id}>
                  <tr className={alertIds.has(item.id) ? "bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors" : "hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-gray-900" />
                    </td>
                    {editId === item.id ? (
                      <>
                        <td className="px-3 py-2">
                          <input type="text" value={editData.name} onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] dark:bg-gray-700 dark:text-white w-28" />
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" value={editData.category} onChange={(e) => setEditData({ ...editData, category: e.target.value })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] dark:bg-gray-700 dark:text-white w-24" />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input type="number" value={editData.quantity} onChange={(e) => setEditData({ ...editData, quantity: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] tabular-nums text-right dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-3 py-2">
                          <select value={editData.unit} onChange={(e) => setEditData({ ...editData, unit: e.target.value })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] dark:bg-gray-700 dark:text-white">
                            <option value="pieces">{t("pieces")}</option>
                            <option value="kg">{t("kg")}</option>
                            <option value="liters">{t("liters")}</option>
                            <option value="boxes">{t("boxes")}</option>
                            <option value="bundle">{t("bundle")}</option>
                            <option value="dozen">{t("dozen")}</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <MoneyField locale={mLocale} value={editData.cost_per_unit} onChange={(e) => setEditData({ ...editData, cost_per_unit: e.target.value })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] tabular-nums text-right dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <MoneyField locale={mLocale} value={editData.sell_price} onChange={(e) => setEditData({ ...editData, sell_price: e.target.value })}
                            placeholder="—"
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] tabular-nums text-right dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <MoneyField locale={mLocale} value={editData.sell_price_per_pour} onChange={(e) => setEditData({ ...editData, sell_price_per_pour: e.target.value })}
                            placeholder={t("perPour")}
                            className="px-2 py-1.5 border border-amber-300 dark:border-amber-600 rounded-lg text-[13px] tabular-nums text-right dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-3 py-2 text-[13px] text-gray-500 text-right tabular-nums">—</td>
                        <td className="px-3 py-2 text-right">
                          <span className="inline-flex items-center gap-1">
                            <button onClick={saveEdit} title={t("save")} aria-label={t("save")} disabled={editMoneyRejected}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-md text-emerald-600 hover:text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition disabled:opacity-40 disabled:cursor-not-allowed">
                              <Icon name="Check" size={14} />
                            </button>
                            <button onClick={() => setEditId(null)} title={t("cancel")} aria-label={t("cancel")}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700 transition">
                              <Icon name="X" size={14} />
                            </button>
                          </span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2.5 text-[13px] text-gray-700 dark:text-gray-300 font-medium">
                          {item.name}
                          {alertIds.has(item.id) && <span className="ml-1.5 px-1.5 py-0.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[11px] font-semibold uppercase tracking-wider rounded">{t("lowLabel")}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-[12px] text-gray-500 dark:text-gray-400">{categoryLabel(t, item.category)}</td>
                        <td className="px-3 py-2.5 text-[13px] font-semibold text-gray-800 dark:text-white tabular-nums text-right">
                          <span className="inline-flex items-center justify-end">
                            {qty}
                            {adjustId === item.id ? (
                              <span className="ml-1.5 inline-flex items-center gap-1">
                                <input type="number" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} placeholder="+/-"
                                  className="w-16 px-1.5 py-1 border border-gray-200 dark:border-gray-600 rounded text-[12px] tabular-nums dark:bg-gray-700 dark:text-white"
                                  onKeyDown={(e) => e.key === "Enter" && adjustStock(item.id, adjustQty)} autoFocus />
                                <button onClick={() => adjustStock(item.id, adjustQty)} title={t("go")} aria-label={t("go")}
                                  className="w-6 h-6 inline-flex items-center justify-center rounded text-emerald-600 hover:text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                  <Icon name="Check" size={12} />
                                </button>
                                <button onClick={() => { setAdjustId(null); setAdjustQty(""); }} title={t("cancel")} aria-label={t("cancel")}
                                  className="w-6 h-6 inline-flex items-center justify-center rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700">
                                  <Icon name="X" size={12} />
                                </button>
                              </span>
                            ) : (
                              <button onClick={() => setAdjustId(item.id)} title={t("adjustStock") || "+/-"} aria-label={t("adjustStock") || "Adjust stock"}
                                className="inline-flex items-center justify-center w-5 h-5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700 ml-1.5">
                                <Icon name="PlusCircle" size={14} />
                              </button>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-[13px] text-gray-600 dark:text-gray-400">{item.unit}</td>
                        <td className="px-3 py-2.5 text-[13px] text-gray-600 dark:text-gray-400 tabular-nums text-right"><Amount value={buy} currency={currency} decimals={2} /></td>
                        <td className="px-3 py-2.5 text-[13px] text-gray-600 dark:text-gray-400 tabular-nums text-right">
                          {sell != null ? <Amount value={sell} currency={currency} decimals={2} /> : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] tabular-nums text-right">
                          {/* This column doubles as the per-pour price cell —
                              the edit row puts its per-pour MoneyField in the
                              same slot. The figure used to print raw: "35/ml",
                              no grouping, no "kr.", and pour_unit is a VOLUME
                              unit, so it read as 35 kroner per millilitre next
                              to rows saying "+42%". It is money per glas now. */}
                          {item.sell_price_per_pour > 0 ? (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">
                              <Amount value={parseFloat(item.sell_price_per_pour)} currency={currency} decimals={2} />
                              <span className="text-gray-500 dark:text-gray-400 font-normal">/{t("perGlass")}</span>
                            </span>
                          ) : margin != null ? (
                            <span className={margin >= 0 ? "text-[rgb(var(--brand-green-accent))] font-medium" : "text-red-500 dark:text-red-400 font-medium"}>
                              {margin >= 0 ? "+" : ""}{margin}%
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] tabular-nums text-right">
                          {profit != null ? (
                            <span className={profit >= 0 ? "text-[rgb(var(--brand-green-accent))] font-medium" : "text-red-500 dark:text-red-400 font-medium"}>
                              <Amount value={profit} currency={currency} sign />
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="inline-flex items-center gap-1">
                            {item.pour_size > 0 && (
                              <button onClick={() => { setPourModal(item); setPourCount(1); }} title={t("pour")} aria-label={t("pour")}
                                className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700 transition">
                                <Icon name="Wine" size={14} />
                              </button>
                            )}
                            {/* Smart usage — opens the consumption-config modal so
                                owner can configure auto-decrement per sale */}
                            <button
                              onClick={() => setConsumptionModalItem(item)}
                              title={t("inventoryConsumptionTitle") || "Smart usage"}
                              aria-label={t("inventoryConsumptionTitle") || "Smart usage"}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                            >
                              <Icon name="Beaker" size={14} />
                            </button>
                            {/* Compare price — opens SmartPricingModal which
                                fetches /api/smart-pricing/item for this item.
                                Only useful when the item has a sell_price
                                set, so we only render the button then. */}
                            {item.sell_price > 0 && (
                              <button
                                onClick={() => setSmartPricingItem(item)}
                                title={t("smartPricingCompareBtn") || "Compare price"}
                                aria-label={t("smartPricingCompareBtn") || "Compare price"}
                                className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                              >
                                <Icon name="Globe" size={14} />
                              </button>
                            )}
                            <button onClick={() => startEdit(item)} title={t("edit")} aria-label={t("edit")}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700 transition">
                              <Icon name="Pencil" size={14} />
                            </button>
                            {deleteConfirm === item.id ? (
                              <span className="inline-flex items-center gap-1">
                                <button onClick={() => deleteItem(item.id)}
                                  className="px-2 h-7 inline-flex items-center justify-center rounded-md bg-red-600 text-white text-[11px] font-semibold hover:bg-red-700">
                                  {t("confirm") || "Confirm"}
                                </button>
                                <button onClick={() => setDeleteConfirm(null)} title={t("cancel")} aria-label={t("cancel")}
                                  className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
                                  <Icon name="X" size={14} />
                                </button>
                              </span>
                            ) : (
                              <button onClick={() => setDeleteConfirm(item.id)} title={t("delete")} aria-label={t("delete")}
                                className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition">
                                <Icon name="Trash2" size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                  {editId === item.id && (
                    <tr className="bg-gray-50 dark:bg-gray-800/40 border-b border-gray-100 dark:border-gray-700">
                      <td className="px-3"></td>
                      <td colSpan={9} className="px-3 pb-3 pt-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{t("invSupplierSection", "Leverandør")}</span>
                          <input type="text" value={editData.supplier_name || ""}
                            onChange={(e) => setEditData({ ...editData, supplier_name: e.target.value })}
                            placeholder={t("invSupplierName", "Leverandør (valgfri)")}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] dark:bg-gray-700 dark:text-white w-40" />
                          <input type="email" value={editData.supplier_email || ""}
                            onChange={(e) => setEditData({ ...editData, supplier_email: e.target.value })}
                            placeholder={t("invSupplierEmail", "Leverandør-email")}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] dark:bg-gray-700 dark:text-white w-56" />
                          <span className="text-[11px] text-gray-400 dark:text-gray-500">{t("invSupplierHint", "So BonBox can tell you who to reorder from — you place the order yourself")}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {/* Three outcomes in the one slot that used to have two. The
                  table sits ~700 lines below the stat strip, so its failure
                  carries its own Try again rather than pointing up the page at
                  a banner the owner has scrolled past. */}
              {filtered.length === 0 && (
                loading ? (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-[13px] text-gray-400 dark:text-gray-500">{t("invLoadingStock", "Checking what's on the shelf…")}</td></tr>
                ) : stockUnknown ? (
                  <tr><td colSpan={10} className="px-3 py-4"><LoadFailed onRetry={fetchData} /></td></tr>
                ) : (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-[13px] text-gray-400 dark:text-gray-500">{t("noInventoryYet")}</td></tr>
                )
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile card list — full-width cards, no horizontal scroll, all
            actions reachable as 44px tap targets. Same data as the desktop
            table; edit/adjust still uses the inline edit row (kept simple
            here to avoid a parallel form). For inline editing on mobile,
            users tap Edit which drops to the table on tablet+, or the
            row can be edited on a later pass. */}
        <div className="md:hidden p-3 space-y-2">
          {/* Same three outcomes as the table above — the phone is where a
              dropped request is likeliest, so it is the last place that may
              guess. */}
          {filtered.length === 0 && (
            loading ? (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-center text-[13px] text-gray-400 dark:text-gray-500">
                {t("invLoadingStock", "Checking what's on the shelf…")}
              </div>
            ) : stockUnknown ? (
              <LoadFailed onRetry={fetchData} />
            ) : (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-center text-[13px] text-gray-400 dark:text-gray-500">
                {t("noInventoryYet")}
              </div>
            )
          )}
          {filtered.map((item) => {
            const qty = parseFloat(item.quantity);
            const buy = parseFloat(item.cost_per_unit);
            const sell = item.sell_price != null ? parseFloat(item.sell_price) : null;
            const margin = sell && buy > 0 ? Math.round(((sell - buy) / buy) * 100) : null;
            const profit = sell != null ? (sell - buy) * qty : null;
            const isLow = alertIds.has(item.id);
            const isEditing = editId === item.id;
            const confirming = deleteConfirm === item.id;

            return (
              <div
                key={item.id}
                className={`rounded-xl border bg-white dark:bg-gray-800 p-3 ${
                  isLow
                    ? "border-red-200 dark:border-red-800"
                    : "border-gray-200 dark:border-gray-700"
                }`}
              >
                {isEditing ? (
                  /* Inline edit form on mobile — stacked fields */
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editData.name}
                      onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                      placeholder={t("item")}
                      className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={editData.category}
                        onChange={(e) => setEditData({ ...editData, category: e.target.value })}
                        placeholder={t("category")}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                      />
                      <select
                        value={editData.unit}
                        onChange={(e) => setEditData({ ...editData, unit: e.target.value })}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                      >
                        <option value="pieces">{t("pieces")}</option>
                        <option value="kg">{t("kg")}</option>
                        <option value="liters">{t("liters")}</option>
                        <option value="boxes">{t("boxes")}</option>
                        <option value="bundle">{t("bundle")}</option>
                        <option value="dozen">{t("dozen")}</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="number"
                        value={editData.quantity}
                        onChange={(e) => setEditData({ ...editData, quantity: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                        placeholder={t("quantity")}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] tabular-nums dark:bg-gray-700 dark:text-white"
                      />
                      <MoneyField
                        locale={mLocale}
                        value={editData.cost_per_unit}
                        onChange={(e) => setEditData({ ...editData, cost_per_unit: e.target.value })}
                        placeholder={t("cost")}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] tabular-nums dark:bg-gray-700 dark:text-white"
                      />
                      <MoneyField
                        locale={mLocale}
                        value={editData.sell_price}
                        onChange={(e) => setEditData({ ...editData, sell_price: e.target.value })}
                        placeholder={t("sell")}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] tabular-nums dark:bg-gray-700 dark:text-white"
                      />
                    </div>
                    {/* Optional leverandør — so BonBox can name who to reorder
                        from. BonBox tells, the owner orders. */}
                    <div className="grid grid-cols-1 gap-2">
                      <input
                        type="text"
                        value={editData.supplier_name || ""}
                        onChange={(e) => setEditData({ ...editData, supplier_name: e.target.value })}
                        placeholder={t("invSupplierName", "Leverandør (valgfri)")}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                      />
                      <input
                        type="email"
                        value={editData.supplier_email || ""}
                        onChange={(e) => setEditData({ ...editData, supplier_email: e.target.value })}
                        placeholder={t("invSupplierEmail", "Leverandør-email")}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                      />
                      {/* The same sentence the add form and the desktop edit
                          row carry. Without it this card asks a phone owner
                          for a supplier email and never says what it is for —
                          and a field that looks like it triggers an order the
                          product never sends is a dead-end CTA in field form. */}
                      <p className="text-[11px] text-gray-400 dark:text-gray-500">
                        {t("invSupplierHint", "So BonBox can tell you who to reorder from — you place the order yourself")}
                      </p>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => setEditId(null)}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-[13px] font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {t("cancel")}
                      </button>
                      <button
                        onClick={saveEdit}
                        disabled={editMoneyRejected}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-900 bg-gray-900 text-white text-[13px] font-semibold hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("save")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Header: name + category | qty + unit */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                          {item.name}
                          {isLow && (
                            <span className="px-1.5 py-0.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[11px] font-semibold uppercase tracking-wider rounded">
                              {t("lowLabel")}
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {categoryLabel(t, item.category)}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold tabular-nums text-gray-900 dark:text-white">
                          {qty} <span className="text-[12px] text-gray-500 dark:text-gray-400 font-normal">{item.unit}</span>
                        </div>
                      </div>
                    </div>

                    {/* 2-col stat grid: cost/sell, margin/profit */}
                    <div className="grid grid-cols-2 gap-2 text-[12px] pt-2 border-t border-gray-100 dark:border-gray-700">
                      <div>
                        <div className="text-gray-500 dark:text-gray-400">{t("cost")} / {t("sell")}</div>
                        <div className="font-semibold tabular-nums text-gray-900 dark:text-white mt-0.5">
                          <Amount value={buy} currency={currency} decimals={2} />
                          {" / "}
                          {sell != null ? <Amount value={sell} currency={currency} decimals={2} /> : "—"}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-gray-500 dark:text-gray-400">{t("margin")} / {t("profit")}</div>
                        <div className="font-semibold tabular-nums mt-0.5">
                          {/* Same cell on a phone — it repeated the raw
                              "35/ml" under the heading "margin / profit". */}
                          {item.sell_price_per_pour > 0 ? (
                            <span className="text-amber-600 dark:text-amber-400">
                              <Amount value={parseFloat(item.sell_price_per_pour)} currency={currency} decimals={2} />
                              <span className="text-gray-500 dark:text-gray-400 font-normal">/{t("perGlass")}</span>
                            </span>
                          ) : margin != null ? (
                            <span className={margin >= 0 ? "text-[rgb(var(--brand-green-accent))]" : "text-red-500 dark:text-red-400"}>
                              {margin >= 0 ? "+" : ""}{margin}%
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                          {profit != null && (
                            <span className={`ml-1.5 ${profit >= 0 ? "text-[rgb(var(--brand-green-accent))]" : "text-red-500 dark:text-red-400"}`}>
                              <Amount value={profit} currency={currency} sign />
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Action row — 5 buttons, equal width, 44px tap targets.
                        Icons only (with title for hover/tooltip). The Wine + Globe
                        buttons only render when their feature applies, just like
                        on desktop. We always keep 5 cells so the layout doesn't
                        shift between rows: filler cells render an invisible
                        spacer to keep edit/delete in the same horizontal spot. */}
                    <div className="flex items-center gap-2 pt-3 mt-3 border-t border-gray-100 dark:border-gray-700">
                      {item.pour_size > 0 ? (
                        <button
                          onClick={() => { setPourModal(item); setPourCount(1); }}
                          title={t("pour")}
                          aria-label={t("pour")}
                          className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 active:bg-gray-100 transition"
                        >
                          <Icon name="Wine" size={18} />
                        </button>
                      ) : (
                        <span className="flex-1" aria-hidden="true" />
                      )}
                      <button
                        onClick={() => setConsumptionModalItem(item)}
                        title={t("inventoryConsumptionTitle") || "Smart usage"}
                        aria-label={t("inventoryConsumptionTitle") || "Smart usage"}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 active:bg-gray-100 transition"
                      >
                        <Icon name="Beaker" size={18} />
                      </button>
                      {item.sell_price > 0 ? (
                        <button
                          onClick={() => setSmartPricingItem(item)}
                          title={t("smartPricingCompareBtn") || "Compare price"}
                          aria-label={t("smartPricingCompareBtn") || "Compare price"}
                          className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 active:bg-gray-100 transition"
                        >
                          <Icon name="Globe" size={18} />
                        </button>
                      ) : (
                        <span className="flex-1" aria-hidden="true" />
                      )}
                      <button
                        onClick={() => startEdit(item)}
                        title={t("edit")}
                        aria-label={t("edit")}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 active:bg-gray-100 transition"
                      >
                        <Icon name="Pencil" size={18} />
                      </button>
                      {confirming ? (
                        <button
                          onClick={() => deleteItem(item.id)}
                          aria-label={t("confirm") || "Confirm"}
                          className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg bg-red-600 text-white text-[12px] font-semibold hover:bg-red-700 transition"
                        >
                          {t("confirm") || "?"}
                        </button>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(item.id)}
                          title={t("delete")}
                          aria-label={t("delete")}
                          className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-400 active:bg-red-100 transition"
                        >
                          <Icon name="Trash2" size={18} />
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Restock Modal */}
      {restockItem && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setRestockItem(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="restock-title"
          // Keyboard handling: Esc closes, Enter confirms. Mounted on the
          // backdrop so it works regardless of which child has focus.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setRestockItem(null);
            } else if (e.key === "Enter") {
              e.stopPropagation();
              restockBottle();
            }
          }}
          tabIndex={-1}
        >
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 id="restock-title" className="text-lg font-bold text-gray-800 dark:text-white mb-1">{t("restock")} — {restockItem.name}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {restockItem.bottle_size || 750}{restockItem.pour_unit || "ml"} {t("perBottle")} · {t("currently")} {Math.round(restockItem.quantity)} {restockItem.pour_unit || "ml"} {t("inStock")}
            </p>
            <div className="flex items-center justify-center gap-4 mb-4">
              <button
                onClick={() => setRestockBottles(Math.max(1, restockBottles - 1))}
                aria-label={t("decreaseBottles") || "Decrease"}
                className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 text-lg font-bold text-gray-700 dark:text-gray-200"
              >-</button>
              <span className="text-3xl font-bold text-gray-800 dark:text-white w-16 text-center" aria-live="polite">{restockBottles}</span>
              <button
                onClick={() => setRestockBottles(restockBottles + 1)}
                aria-label={t("increaseBottles") || "Increase"}
                className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 text-lg font-bold text-gray-700 dark:text-gray-200"
              >+</button>
            </div>
            <p className="text-center text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("adding")} {restockBottles} {t("bottles")} = {(restockItem.bottle_size || 750) * restockBottles} {restockItem.pour_unit || "ml"}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setRestockItem(null)} className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm text-gray-600 dark:text-gray-300">{t("cancel")}</button>
              <button
                onClick={restockBottle}
                autoFocus
                className="flex-1 py-2.5 bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white rounded-xl font-semibold text-sm"
              >{t("add")} {restockBottles} {t("bottles")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Pour Modal */}
      {pourModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setPourModal(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">{t("pour")} — {pourModal.name}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {pourModal.pour_size}{pourModal.pour_unit || "ml"} {t("perGlass")} · {Math.round(pourModal.quantity)} {pourModal.pour_unit || "ml"} {t("inStock")}
              {pourModal.pour_size > 0 && ` · ${Math.floor(pourModal.quantity / pourModal.pour_size)} ${t("poursLeft")}`}
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
              {t("total")}: {pourCount * (pourModal.pour_size || 0)} {pourModal.pour_unit || "ml"}
              {pourModal.sell_price_per_pour > 0 && ` · ${t("revenue")}: ${formatOwnerMoney(pourCount * pourModal.sell_price_per_pour, user?.currency)}`}
            </p>

            <div className="flex gap-2">
              <button onClick={() => setPourModal(null)} className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm text-gray-600 dark:text-gray-300">{t("cancel")}</button>
              <button onClick={recordPour} className="flex-1 py-2.5 bg-amber-500 text-white rounded-xl font-semibold text-sm hover:bg-amber-600">{t("pour")} {pourCount}x</button>
            </div>
          </div>
        </div>
      )}

      {/* Starter-list side panel. Rows carry NO colour of their own: the
          catalogue used to hand each one a decorative hue out of a COLOR_MAP,
          which made 23 identical choices look like 23 different states. The
          only colour left is the emerald check on the row you already loaded —
          that one is status. Names, descriptions and icons come from
          config/inventoryTemplates.js. */}
      {showTemplateModal && (
        <div className="fixed inset-0 bg-black/30 z-50 flex justify-end" onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }}>
          <div
            className="bg-white dark:bg-gray-800 shadow-sm w-full max-w-sm h-full overflow-y-auto p-6 animate-slideIn"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "slideIn 0.25s ease-out" }}
          >
            <div className="flex items-center justify-between mb-1">
              {/* 16px/600, not 18px/700: 18 is off the locked ramp and 700 is
                  reserved for a hero KPI figure, which a panel title is not. */}
              <h3 className="text-[16px] font-semibold text-gray-900 dark:text-white">{t("loadTemplate")}</h3>
              {/* Was a bare hand-rolled <svg> in an unlabelled <button>: a
                  screen reader announced "button" with no name (WCAG 4.1.2). */}
              <button
                type="button"
                onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }}
                aria-label={t("close", "Close")}
                className="h-9 w-9 shrink-0 -mr-2 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                <Icon name="X" size={20} />
              </button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">{t("pickTemplateDesc")}</p>

            <div className="space-y-2.5">
              {INVENTORY_TEMPLATES.map((tmpl) => {
                const isLoaded = templateLoaded === tmpl.type;
                return (
                  <button
                    key={tmpl.type}
                    onClick={() => loadTemplate(tmpl.type)}
                    disabled={templateLoading}
                    className={`w-full p-4 text-left border rounded-xl transition ${isLoaded ? "border-gray-300 bg-gray-50 dark:bg-gray-800/50" : "border-gray-200 dark:border-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:hover:border-gray-500 dark:hover:bg-gray-700/30"}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-gray-50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300">
                        <Icon name={tmpl.icon} size={18} />
                      </span>
                      <div className="flex-1 min-w-0">
                        {/* The count sits on the description line, not beside
                            the name: at phone width a long name wraps and a
                            count pinned to it lands in a different place on
                            every row. */}
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-gray-800 dark:text-white">{t(tmpl.nameKey)}</p>
                          {isLoaded && (
                            <span className="inline-flex items-center gap-1 text-xs text-[rgb(var(--brand-green-accent))] font-medium shrink-0">
                              <Icon name="Check" size={12} /> {t("loaded")}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          <span className="tabular-nums">{tmpl.count} {t("items")}</span> · {t(tmpl.descKey)}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {templateLoading && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <svg className="animate-spin h-4 w-4 text-gray-500 dark:text-gray-400" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t("loadingTemplate")}</p>
              </div>
            )}

            <button
              onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }}
              className="w-full mt-5 py-2.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 border border-gray-200 dark:border-gray-600 rounded-lg"
            >
              {t("done")}
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

      {/* Smart-usage consumption modal — single instance shared across
          rows. Re-mounts on item change via the `key` prop so its
          internal state always reflects the right item. */}
      <InventoryConsumptionModal
        key={consumptionModalItem?.id || "none"}
        open={!!consumptionModalItem}
        onClose={() => setConsumptionModalItem(null)}
        itemId={consumptionModalItem?.id}
        itemName={consumptionModalItem?.name}
      />
      {/* Smart Pricing per-item market comparison modal (Task #64) */}
      <SmartPricingModal
        key={smartPricingItem?.id || "sp-none"}
        open={!!smartPricingItem}
        onClose={() => setSmartPricingItem(null)}
        itemName={smartPricingItem?.name}
        currencyCode={user?.currency}
      />
    </div>
  );
}
