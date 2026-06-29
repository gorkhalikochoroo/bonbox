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
import { useState, useEffect, useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency } from "../utils/currency";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";
import DismissibleTip from "../components/DismissibleTip";
import SmartImportModal from "../components/SmartImportModal";
import InventoryConsumptionModal from "../components/InventoryConsumptionModal";
import InventoryAutopilotPanel from "../components/InventoryAutopilotPanel";
import SmartPricingModal from "../components/SmartPricingModal";
import { localIso } from "../utils/dateFormat";
import { errText } from "../utils/errText";
import {
  Button, PageHeader, StatCard, SectionBanner, TabPills, Icon,
} from "../components/ui";

const TEMPLATES = [
  // Food & Drink
  { type: "restaurant", name: "Restaurant / Pizza / Grill", icon: "🍽️", count: 13, desc: "Chicken, rice, oil, produce, drinks, supplies.", color: "orange" },
  { type: "cafe", name: "Cafe / Coffee Shop", icon: "☕", count: 13, desc: "Same as restaurant. Coffee, pastry, snacks focus.", color: "orange" },
  { type: "bakery", name: "Bakery / Sweet Shop", icon: "🥐", count: 13, desc: "Flour, butter, sugar, pastries, bread, drinks.", color: "orange" },
  { type: "bar", name: "Bar / Cocktail", icon: "🍸", count: 30, desc: "Spirits, wine, beer, mixers, garnish. Pour tracking.", color: "amber" },
  { type: "food_truck", name: "Food Truck / Street Food", icon: "🚚", count: 13, desc: "Same as restaurant. Quick bites, drinks, sauces.", color: "orange" },
  { type: "tea_shop", name: "Tea Shop / Chiya Pasal", icon: "🍵", count: 10, desc: "Tea, milk, sugar, spices, snacks, cups.", color: "orange" },
  // Retail
  { type: "clothing", name: "Clothing Store", icon: "👕", count: 12, desc: "Tops, bottoms, dresses, footwear, accessories.", color: "purple" },
  { type: "online_clothing", name: "Online Clothing", icon: "🛍️", count: 12, desc: "Clothing + packaging, poly mailers, shipping boxes.", color: "purple" },
  { type: "veggie_shop", name: "Veggie / Fruit Shop", icon: "🥬", count: 13, desc: "Vegetables, fruits, herbs, dry goods. Kg-based.", color: "green" },
  { type: "grocery", name: "Grocery / Kirana", icon: "🛒", count: 12, desc: "Dairy, packaged food, drinks, household.", color: "yellow" },
  { type: "kiosk", name: "Danish Kiosk", icon: "🏪", count: 12, desc: "Drinks, snacks, tobacco, bakery, scratch cards.", color: "blue" },
  { type: "electronics", name: "Electronics & Mobile", icon: "📱", count: 11, desc: "Chargers, cables, earbuds, phone cases.", color: "cyan" },
  { type: "pharmacy", name: "Pharmacy / Medical", icon: "💊", count: 12, desc: "Medicines, vitamins, first aid, hygiene.", color: "red" },
  { type: "cosmetics", name: "Cosmetics / Beauty", icon: "💄", count: 10, desc: "Skincare, makeup, hair care, fragrance.", color: "pink" },
  { type: "stationery", name: "Stationery / Books", icon: "📝", count: 10, desc: "Notebooks, pens, paper, school supplies.", color: "indigo" },
  { type: "hardware", name: "Hardware / Construction", icon: "🔧", count: 10, desc: "Cement, rods, paint, plumbing, electrical.", color: "gray" },
  { type: "flower_shop", name: "Flower Shop", icon: "💐", count: 9, desc: "Roses, tulips, bouquets, wrapping, vases.", color: "pink" },
  { type: "jewelry", name: "Jewelry / Accessories", icon: "💍", count: 8, desc: "Gold, silver, earrings, bangles, watches.", color: "yellow" },
  { type: "mobile_repair", name: "Mobile Repair", icon: "🔩", count: 8, desc: "Screens, batteries, parts, tools, cases.", color: "cyan" },
  // Services
  { type: "salon", name: "Salon / Barber / Nail", icon: "💇", count: 12, desc: "Shampoo, dye, razors, nail polish, skincare.", color: "pink" },
  { type: "laundry", name: "Laundry / Dry Cleaning", icon: "🧺", count: 10, desc: "Detergent, softener, hangers, covers, tags.", color: "blue" },
  { type: "thrift", name: "Thrift / Second-hand", icon: "♻️", count: 10, desc: "Used clothing, shoes, bags, books, electronics.", color: "green" },
  // General
  { type: "other", name: "Other / Custom", icon: "📦", count: 20, desc: "General supplies, tools, materials.", color: "gray" },
];

const COLOR_MAP = {
  orange: { border: "hover:border-orange-400", bg: "hover:bg-orange-50 dark:hover:bg-orange-900/20" },
  green: { border: "hover:border-gray-300", bg: "hover:bg-gray-50 dark:hover:bg-gray-800/50" },
  blue: { border: "hover:border-blue-400", bg: "hover:bg-blue-50 dark:hover:bg-blue-900/20" },
  yellow: { border: "hover:border-yellow-400", bg: "hover:bg-yellow-50 dark:hover:bg-yellow-900/20" },
  purple: { border: "hover:border-purple-400", bg: "hover:bg-purple-50 dark:hover:bg-purple-900/20" },
  red: { border: "hover:border-red-400", bg: "hover:bg-red-50 dark:hover:bg-red-900/20" },
  cyan: { border: "hover:border-cyan-400", bg: "hover:bg-cyan-50 dark:hover:bg-cyan-900/20" },
  amber: { border: "hover:border-amber-400", bg: "hover:bg-amber-50 dark:hover:bg-amber-900/20" },
  pink: { border: "hover:border-pink-400", bg: "hover:bg-pink-50 dark:hover:bg-pink-900/20" },
  indigo: { border: "hover:border-indigo-400", bg: "hover:bg-indigo-50 dark:hover:bg-indigo-900/20" },
  gray: { border: "hover:border-gray-400", bg: "hover:bg-gray-50 dark:hover:bg-gray-700/30" },
};

export default function InventoryPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  // Order Autopilot — Pro-tier reorder + supplier email flow (Task #63).
  // Free / Starter see an UpgradeNudge inside the panel; the button is
  // always visible so the upsell remains discoverable. Tier is also
  // re-checked server-side by every /autopilot/* endpoint.
  const { hasFeature: _hasFeatureAutopilot } = useEntitlements();
  // showAutopilot removed — the autopilot panel is now the always-on hero
  // at the top of the page (rendered with the `hero` prop), not a toggle.
  const [items, setItems] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState("All");
  const [form, setForm] = useState({
    name: "", quantity: "", unit: "pieces", cost_per_unit: "",
    min_threshold: "", category: "General", sell_price: "", is_perishable: false,
    sell_unit: "", pieces_per_unit: "",
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
  const [deadStock, setDeadStock] = useState([]);
  const [profitRanking, setProfitRanking] = useState([]);
  const [expiring, setExpiring] = useState([]);   // Items in next 7 days
  const [expired, setExpired] = useState([]);     // Items already past expiry
  const [expandedStat, setExpandedStat] = useState(null); // "total" | "low" | "fresh" | "categories" | "priced"

  const fetchData = () => {
    // Pour-tracked items (bottles with pour_size set) live on /bar now —
    // filter them out of /inventory so the view stays focused on general
    // kitchen / shop / pantry stock. Owners with the bar_pour vertical
    // module enabled see them on the dedicated 🍸 Bar page in their sidebar.
    api.get("/inventory")
      .then((res) => {
        const all = Array.isArray(res.data) ? res.data : [];
        setItems(all.filter((i) => !i.pour_size || i.pour_size <= 0));
      })
      .catch(() => {});
    api.get("/inventory/alerts").then((res) => setAlerts(res.data)).catch(() => {});
    api.get("/inventory/categories").then((res) => setCategories(res.data)).catch(() => {});
    api.get("/inventory/dead-stock").then((res) => setDeadStock(res.data)).catch(() => {});
    api.get("/inventory/profit-ranking").then((res) => setProfitRanking(res.data)).catch(() => {});
    api.get("/inventory/expiring", { params: { days: 7 } }).then((res) => setExpiring(res.data || [])).catch(() => {});
    api.get("/inventory/expired").then((res) => setExpired(res.data || [])).catch(() => {});
  };

  useEffect(() => { fetchData(); }, []);

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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await api.post("/inventory", {
        ...form,
        quantity: parseFloat(form.quantity),
        cost_per_unit: parseFloat(form.cost_per_unit),
        min_threshold: parseFloat(form.min_threshold),
        sell_price: form.sell_price ? parseFloat(form.sell_price) : null,
        sell_unit: form.sell_unit || null,
        pieces_per_unit: form.pieces_per_unit ? parseFloat(form.pieces_per_unit) : null,
        category: form.category || "General",
      });
      setForm({ name: "", quantity: "", unit: "pieces", cost_per_unit: "", min_threshold: "", category: "General", sell_price: "", is_perishable: false, sell_unit: "", pieces_per_unit: "" });
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
    });
  };

  const saveEdit = async () => {
    try {
      const payload = { ...editData };
      if (payload.quantity === "") payload.quantity = 0;
      if (payload.cost_per_unit === "") payload.cost_per_unit = 0;
      if (payload.sell_price === "" || payload.sell_price === null) {
        payload.sell_price = null;
      }
      if (payload.sell_price_per_pour === "" || payload.sell_price_per_pour === null) {
        payload.sell_price_per_pour = null;
      }
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
      const saleMsg = res.data.sale_recorded ? ` · ${t("sale")}: ${res.data.revenue} ${currency}` : "";
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

  // Auto-calculated financials
  const stats = useMemo(() => {
    let totalCost = 0, totalRevenue = 0, itemsWithMargin = 0, totalMarginPct = 0;
    items.forEach((i) => {
      const qty = parseFloat(i.quantity);
      const buy = parseFloat(i.cost_per_unit);
      const sell = i.sell_price != null ? parseFloat(i.sell_price) : null;
      totalCost += qty * buy;
      if (sell != null) {
        totalRevenue += qty * sell;
        if (buy > 0) {
          totalMarginPct += ((sell - buy) / buy) * 100;
          itemsWithMargin++;
        }
      }
    });
    const totalProfit = totalRevenue - totalCost;
    const avgMargin = itemsWithMargin > 0 ? Math.round(totalMarginPct / itemsWithMargin) : 0;
    return { totalCost, totalRevenue, totalProfit, avgMargin, itemsWithMargin };
  }, [items]);

  // Bar items with pour tracking
  const barItems = useMemo(() => items.filter((i) => i.pour_size && i.pour_size > 0), [items]);

  const perishableCount = items.filter((i) => i.is_perishable).length;
  const displayCategories = templateFilter
    ? ["All", ...categories.filter((c) => templateFilter.includes(c))]
    : ["All", ...categories];

  // Per-vertical page title (S1 of the inventory redesign). DK trade terms
  // stay Danish across all UI languages — same lock as kasserapport / MOMS.
  // A salon owner should never read kitchen-framed "Inventory Monitor".
  // (S2 will move this into a proper verticalVoice map.)
  const heroTitle = ({
    restaurant: "Lager & bestilling",
    cafe: "Lager & bestilling",
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
              <Button
                variant="secondary"
                onClick={() => setShowTemplateModal(true)}
                className="hidden sm:inline-flex"
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
                onClick={async () => {
                  try {
                    const res = await api.get("/inventory/export.pdf", { responseType: "blob" });
                    const url = URL.createObjectURL(res.data);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `stock-list-${localIso()}.pdf`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 60_000);
                  } catch (e) {
                    console.error("Export PDF failed", e);
                    setError(errText(e, t("invPdfGenFailed", "Couldn't generate PDF — please retry.")));
                  }
                }}
                iconLeft={<Icon name="FileText" size={16} />}
                title={t("invExportPdfTitle", "Download a PDF stock-list report")}
                className="hidden sm:inline-flex"
              >
                PDF
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    const res = await api.get("/inventory/export.csv", { responseType: "blob" });
                    const url = URL.createObjectURL(res.data);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `stock-list-${localIso()}.csv`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 60_000);
                  } catch (e) {
                    console.error("Export CSV failed", e);
                    setError(errText(e, t("invCsvGenFailed", "Couldn't generate CSV — please retry.")));
                  }
                }}
                iconLeft={<Icon name="FileSpreadsheet" size={16} />}
                title={t("invExportCsvTitle", "Download stock list as CSV (Excel-friendly, semicolon delimited)")}
                className="hidden sm:inline-flex"
              >
                CSV
              </Button>
            </>
          }
        />
      </FadeIn>

      {/* Reorder hero (S1 of the inventory redesign) — the autopilot draft is
          now the FIRST thing the owner sees, always-on, instead of a buried
          "Order autopilot" button. It auto-loads "this week's order, ready to
          approve" for Pro; Free/Starter see the upsell card. AI proposes the
          quantities; nothing is sent until the owner taps Godkend og send. */}
      <InventoryAutopilotPanel hero />

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
        icon="📦"
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
                    • {it.name} <span className="opacity-70">({it.expiry_date}, {Number(it.quantity).toFixed(1)} {it.unit})</span>
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
                    • {it.name} <span className="opacity-70">({it.expiry_date}, {Number(it.quantity).toFixed(1)} {it.unit})</span>
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
          a 🍸 Bar entry in their sidebar; everyone else gets a calmer
          inventory page focused on general kitchen / shop / pantry stock. */}

      {/* Financial overview — auto-calculated from buy/sell prices. Once
          we have 10+ priced items, surface a four-tile KPI strip via the
          unified StatCard. The single "accent" goes on potential profit
          (the money moment); margin uses red when negative — that's a
          data-true color, not decoration. */}
      {stats.itemsWithMargin >= 10 ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label={t("stockCost")}
            value={`${stats.totalCost.toLocaleString()} ${currency}`}
            helper={t("invested")}
          />
          <StatCard
            label={t("potentialRevenue")}
            value={`${stats.totalRevenue.toLocaleString()} ${currency}`}
            helper={t("ifAllSold")}
          />
          <StatCard
            label={t("potentialProfit")}
            value={`${stats.totalProfit >= 0 ? "+" : ""}${stats.totalProfit.toLocaleString()} ${currency}`}
            accent={stats.totalProfit >= 0 ? "success" : "critical"}
            helper={t("margin")}
          />
          <StatCard
            label={t("avgMargin")}
            value={`${stats.avgMargin}%`}
            accent={stats.avgMargin >= 0 ? "neutral" : "critical"}
            helper={`${stats.itemsWithMargin} ${t("itemsPriced")}`}
          />
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
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
            value={alerts.length}
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
            value={categories.length}
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

        {/* Expanded detail panels — each variant shares the same DOM id
            so the StatCard's aria-controls reference resolves regardless
            of which one is open.  Sub-panel chrome (the per-variant
            colored border + dot pills inside) is unchanged for this
            iteration per the Phase 3 scope: outer tile chrome only. */}
        {expandedStat === "total" && (
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-800 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("allItems")} ({items.length})</p>
              <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-400 text-xs hover:bg-gray-200 dark:hover:bg-gray-600">&times;</button>
            </div>
            {(() => {
              const byCat = {};
              items.forEach(i => { byCat[i.category || "General"] = (byCat[i.category || "General"] || []).concat(i); });
              return (
                <>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {Object.entries(byCat).sort((a, b) => b[1].length - a[1].length).map(([cat, list]) => (
                      <span key={cat} className="px-2.5 py-1 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-lg text-xs font-bold text-gray-700 dark:text-gray-300">{cat} · {list.length}</span>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="text-center p-2 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
                      <p className="text-[10px] text-gray-500 dark:text-gray-400 font-semibold">{t("stockValue")}</p>
                      <p className="text-sm font-extrabold text-gray-800 dark:text-white">{Math.round(stats.totalCost).toLocaleString()} {currency}</p>
                    </div>
                    <div className="text-center p-2 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
                      <p className="text-[10px] text-gray-500 dark:text-gray-400 font-semibold">{t("saleValue")}</p>
                      <p className="text-sm font-extrabold text-gray-800 dark:text-white">{Math.round(stats.totalRevenue).toLocaleString()} {currency}</p>
                    </div>
                    <div className="text-center p-2 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
                      <p className="text-[10px] text-gray-500 dark:text-gray-400 font-semibold">{t("avgMargin")}</p>
                      <p className={`text-sm font-extrabold ${stats.avgMargin >= 0 ? "text-emerald-600 dark:text-gray-300" : "text-red-500"}`}>{stats.avgMargin}%</p>
                    </div>
                  </div>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {items.slice(0, 15).map((i) => (
                      <div key={i.id} className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-700/30 rounded-lg text-xs">
                        <span className="font-medium text-gray-800 dark:text-white truncate max-w-[40%]">{i.name}</span>
                        <span className="text-gray-500 dark:text-gray-400">{i.category || t("general")}</span>
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
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("lowStockItems")} ({alerts.length})</p>
              <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-400 text-xs hover:bg-gray-200 dark:hover:bg-gray-600">&times;</button>
            </div>
            {alerts.length > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {alerts.map((a) => (
                  <div key={a.id} className="flex items-center justify-between px-3 py-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs">
                    <div>
                      <span className="font-bold text-red-700 dark:text-red-400">{a.name}</span>
                      <span className="text-red-500/60 ml-2">{a.category || t("general")}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-extrabold text-red-600 dark:text-red-400">{a.quantity} {a.unit}</span>
                      <span className="text-red-400/50 ml-2">{t("minStock")}: {a.min_stock}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-emerald-600 dark:text-gray-300 text-center py-3 font-medium">{t("allWellStocked")}</p>}
          </div>
        )}

        {expandedStat === "fresh" && (
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-orange-200 dark:border-orange-800 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("perishableItems")} ({perishableCount})</p>
              <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-400 text-xs hover:bg-gray-200 dark:hover:bg-gray-600">&times;</button>
            </div>
            {perishableCount > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {items.filter(i => i.is_perishable).map((i) => (
                  <div key={i.id} className="flex items-center justify-between px-3 py-2 bg-orange-50 dark:bg-orange-900/20 rounded-lg text-xs">
                    <div>
                      <span className="font-bold text-orange-700 dark:text-orange-400">{i.name}</span>
                      <span className="text-orange-500/60 ml-2">{i.category || t("general")}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-bold text-orange-600 dark:text-orange-400">{i.quantity} {i.unit}</span>
                      {i.expiry_date && <span className="text-orange-400/60 ml-2">exp: {i.expiry_date}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-gray-400 text-center py-3">{t("noPerishableItems")}</p>}
          </div>
        )}

        {expandedStat === "categories" && (
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-purple-200 dark:border-purple-800 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("categories")} ({categories.length})</p>
              <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-400 text-xs hover:bg-gray-200 dark:hover:bg-gray-600">&times;</button>
            </div>
            {categories.length > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {categories.map((cat) => {
                  const catItems = items.filter(i => (i.category || "General") === cat);
                  const catValue = catItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.cost_per_unit), 0);
                  return (
                    <button key={cat} onClick={() => { setActiveCategory(cat); setExpandedStat(null); }} className="w-full flex items-center justify-between px-3 py-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg text-xs hover:bg-purple-100 dark:hover:bg-purple-900/40 transition">
                      <span className="font-bold text-purple-700 dark:text-purple-400">{cat}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-purple-500/60">{catItems.length} {t("items")}</span>
                        <span className="font-bold text-purple-600 dark:text-purple-400">{Math.round(catValue).toLocaleString()} {currency}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : <p className="text-sm text-gray-400 text-center py-3">{t("noCategoriesYet")}</p>}
          </div>
        )}

        {expandedStat === "priced" && (
          <div id="inventory-stat-panel" className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-blue-200 dark:border-blue-800 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t("pricingStatus")} ({stats.itemsWithMargin}/{items.length})</p>
              <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-400 text-xs hover:bg-gray-200 dark:hover:bg-gray-600">&times;</button>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {items.filter(i => i.sell_price != null && parseFloat(i.sell_price) > 0).length > 0 && (
                <p className="text-[10px] uppercase tracking-wide text-emerald-600 dark:text-gray-300 font-semibold px-1 mb-1">{t("priced")}</p>
              )}
              {items.filter(i => i.sell_price != null && parseFloat(i.sell_price) > 0).slice(0, 10).map((i) => {
                const margin = parseFloat(i.cost_per_unit) > 0 ? Math.round(((parseFloat(i.sell_price) - parseFloat(i.cost_per_unit)) / parseFloat(i.cost_per_unit)) * 100) : 0;
                return (
                  <div key={i.id} className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-xs">
                    <span className="font-medium text-gray-800 dark:text-white truncate max-w-[35%]">{i.name}</span>
                    <span className="text-gray-500">{t("buyLabel")}: {parseFloat(i.cost_per_unit).toLocaleString()}</span>
                    <span className="text-blue-600 dark:text-blue-400">{t("sellLabel")}: {parseFloat(i.sell_price).toLocaleString()}</span>
                    <span className={`font-bold ${margin >= 0 ? "text-emerald-600 dark:text-gray-300" : "text-red-500"}`}>{margin}%</span>
                  </div>
                );
              })}
              {items.filter(i => !i.sell_price || parseFloat(i.sell_price) === 0).length > 0 && (
                <>
                  <p className="text-[10px] uppercase tracking-wide text-red-500 dark:text-red-400 font-semibold px-1 mt-2 mb-1">{t("notPriced")}</p>
                  {items.filter(i => !i.sell_price || parseFloat(i.sell_price) === 0).slice(0, 8).map((i) => (
                    <div key={i.id} className="flex items-center justify-between px-3 py-1.5 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs">
                      <span className="font-medium text-gray-800 dark:text-white truncate max-w-[50%]">{i.name}</span>
                      <span className="text-gray-500">{t("cost")}: {parseFloat(i.cost_per_unit).toLocaleString()}</span>
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
          one emerald accent for the Order autopilot button at the top. */}
      {categories.length > 0 && (
        <div>
          {templateFilter && (
            <div className="flex items-center gap-2 mb-2">
              <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">
                {t("filteredBy")}: {TEMPLATES.find((tp) => tp.type === templateLoaded)?.name || t("loadTemplate")}
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
            tabs={displayCategories.map((cat) => ({ id: cat, label: cat }))}
          />
        </div>
      )}

      {/* Dead Stock — was a full-bleed red gradient, now a SectionBanner
          severity="critical" containing the list. The red stays on the
          per-item value because that's a data-true color (loss).  Page
          chrome around it is calm gray + a single red border. */}
      {deadStock.length > 0 && (
        <SectionBanner
          severity="critical"
          icon="AlertTriangle"
          title={t("deadStockTitle")}
        >
          <div className="space-y-2 mt-2">
            {deadStock.map((ds) => (
              <div key={ds.id} className="flex items-center justify-between bg-white/70 dark:bg-gray-900/40 px-3 py-2 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{ds.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {ds.quantity} {t("inStock")} · {ds.days_since_last_sale >= 999 ? t("neverSold") : `${ds.days_since_last_sale} ${t("daysSinceLastSale")}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-red-600 dark:text-red-400">{ds.stock_value.toLocaleString()} {currency}</p>
                  <button
                    onClick={async () => {
                      if (!confirm(`${t("removeFromInventory")} "${ds.name}"?`)) return;
                      try {
                        await api.delete(`/inventory/${ds.id}`);
                        setDeadStock((prev) => prev.filter((d) => d.id !== ds.id));
                        setItems((prev) => prev.filter((it) => it.id !== ds.id));
                      } catch {}
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
              {deadStock.reduce((sum, ds) => sum + ds.stock_value, 0).toLocaleString()} {currency}
            </p>
          </div>
        </SectionBanner>
      )}

      {/* Top Profit Items — was a full green-emerald gradient. The
          margin percentage stays green (data-true: profit > 0), but the
          card chrome itself is now a neutral gray-50 surface so this no
          longer competes visually with the dead-stock alert above. */}
      {profitRanking.length > 0 && (
        <div className="bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 p-5 rounded-xl">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-2">
            <Icon name="TrendingUp" size={16} className="text-emerald-600 dark:text-emerald-400" />
            {t("bestMarginItems")}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {profitRanking.slice(0, 5).map((pr, idx) => (
              <div key={pr.name} className="flex items-center gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-3 py-2 rounded-lg">
                <span className="text-lg font-bold text-gray-400 dark:text-gray-500 w-6 text-center tabular-nums">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{pr.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {pr.cost} {currency} → {pr.sell} {currency}
                  </p>
                </div>
                <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap tabular-nums">+{pr.margin_pct}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add item form */}
      <div className="bg-white dark:bg-gray-900 p-6 rounded-xl border border-gray-200 dark:border-gray-800">
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

          <input type="number" step="0.01" placeholder={`${t("cost")} (${currency})`} value={form.cost_per_unit}
            onChange={(e) => setForm({ ...form, cost_per_unit: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <input type="number" step="0.01" placeholder={`${t("sellPrice")} (${currency})`} value={form.sell_price}
            onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <input type="number" step="0.01" placeholder={t("minStock")} value={form.min_threshold}
            onChange={(e) => setForm({ ...form, min_threshold: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <label className="flex items-center gap-2 px-3 py-3 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={form.is_perishable}
              onChange={(e) => setForm({ ...form, is_perishable: e.target.checked })}
              className="rounded" />
            {t("freshItem")}
          </label>
          <div className="col-span-2 md:col-span-4">
            <Button type="submit" variant="primary" size="lg" className="w-full">
              {t("addItem")}
            </Button>
          </div>
        </form>
      </div>

      {/* Inventory table */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("stockItems")} {activeCategory !== "All" && <span className="text-sm font-normal text-gray-500">({activeCategory})</span>}
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
                  <tr key={item.id} className={alertIds.has(item.id) ? "bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors" : "hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"}>
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
                          <input type="number" step="0.01" value={editData.cost_per_unit} onChange={(e) => setEditData({ ...editData, cost_per_unit: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] tabular-nums text-right dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input type="number" step="0.01" value={editData.sell_price} onChange={(e) => setEditData({ ...editData, sell_price: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                            placeholder="—"
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-[13px] tabular-nums text-right dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input type="number" step="0.01" value={editData.sell_price_per_pour} onChange={(e) => setEditData({ ...editData, sell_price_per_pour: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                            placeholder={t("perPour")}
                            className="px-2 py-1.5 border border-amber-300 dark:border-amber-600 rounded-lg text-[13px] tabular-nums text-right dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-3 py-2 text-[13px] text-gray-500 text-right tabular-nums">—</td>
                        <td className="px-3 py-2 text-right">
                          <span className="inline-flex items-center gap-1">
                            <button onClick={saveEdit} title={t("save")} aria-label={t("save")}
                              className="w-7 h-7 inline-flex items-center justify-center rounded-md text-emerald-600 hover:text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition">
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
                          {alertIds.has(item.id) && <span className="ml-1.5 px-1.5 py-0.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[10px] font-semibold uppercase tracking-wider rounded">{t("lowLabel")}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-[12px] text-gray-500 dark:text-gray-400">{item.category || t("general")}</td>
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
                        <td className="px-3 py-2.5 text-[13px] text-gray-600 dark:text-gray-400 tabular-nums text-right">{buy} {currency}</td>
                        <td className="px-3 py-2.5 text-[13px] text-gray-600 dark:text-gray-400 tabular-nums text-right">
                          {sell != null ? `${sell} ${currency}` : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] tabular-nums text-right">
                          {item.sell_price_per_pour > 0 ? (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">{parseFloat(item.sell_price_per_pour)}/{item.pour_unit || "glass"}</span>
                          ) : margin != null ? (
                            <span className={margin >= 0 ? "text-emerald-600 dark:text-gray-300 font-medium" : "text-red-500 font-medium"}>
                              {margin >= 0 ? "+" : ""}{margin}%
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] tabular-nums text-right">
                          {profit != null ? (
                            <span className={profit >= 0 ? "text-emerald-600 dark:text-gray-300 font-medium" : "text-red-500 font-medium"}>
                              {profit >= 0 ? "+" : ""}{profit.toLocaleString()}
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
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-[13px] text-gray-400 dark:text-gray-500">{t("noInventoryYet")}</td></tr>
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
          {filtered.length === 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-center text-[13px] text-gray-400 dark:text-gray-500">
              {t("noInventoryYet")}
            </div>
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
                      <input
                        type="number"
                        step="0.01"
                        value={editData.cost_per_unit}
                        onChange={(e) => setEditData({ ...editData, cost_per_unit: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                        placeholder={t("cost")}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] tabular-nums dark:bg-gray-700 dark:text-white"
                      />
                      <input
                        type="number"
                        step="0.01"
                        value={editData.sell_price}
                        onChange={(e) => setEditData({ ...editData, sell_price: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                        placeholder={t("sell")}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] tabular-nums dark:bg-gray-700 dark:text-white"
                      />
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
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-900 bg-gray-900 text-white text-[13px] font-semibold hover:bg-gray-700"
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
                            <span className="px-1.5 py-0.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[10px] font-semibold uppercase tracking-wider rounded">
                              {t("lowLabel")}
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {item.category || t("general")}
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
                          {buy}
                          {" / "}
                          {sell != null ? sell : "—"} {currency}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-gray-500 dark:text-gray-400">{t("margin")} / {t("profit")}</div>
                        <div className="font-semibold tabular-nums mt-0.5">
                          {item.sell_price_per_pour > 0 ? (
                            <span className="text-amber-600 dark:text-amber-400">{parseFloat(item.sell_price_per_pour)}/{item.pour_unit || "glass"}</span>
                          ) : margin != null ? (
                            <span className={margin >= 0 ? "text-emerald-600 dark:text-gray-300" : "text-red-500"}>
                              {margin >= 0 ? "+" : ""}{margin}%
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                          {profit != null && (
                            <span className={`ml-1.5 ${profit >= 0 ? "text-emerald-600 dark:text-gray-300" : "text-red-500"}`}>
                              {profit >= 0 ? "+" : ""}{profit.toLocaleString()}
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
              {pourModal.sell_price_per_pour > 0 && ` · ${t("revenue")}: ${(pourCount * pourModal.sell_price_per_pour).toLocaleString()} ${currency}`}
            </p>

            <div className="flex gap-2">
              <button onClick={() => setPourModal(null)} className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm text-gray-600 dark:text-gray-300">{t("cancel")}</button>
              <button onClick={recordPour} className="flex-1 py-2.5 bg-amber-500 text-white rounded-xl font-semibold text-sm hover:bg-amber-600">{t("pour")} {pourCount}x</button>
            </div>
          </div>
        </div>
      )}

      {/* Template Side Panel */}
      {showTemplateModal && (
        <div className="fixed inset-0 bg-black/30 z-50 flex justify-end" onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }}>
          <div
            className="bg-white dark:bg-gray-800 shadow-sm w-full max-w-sm h-full overflow-y-auto p-6 animate-slideIn"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "slideIn 0.25s ease-out" }}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-gray-800 dark:text-white">{t("loadTemplate")}</h3>
              <button onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">{t("pickTemplateDesc")}</p>

            <div className="space-y-2.5">
              {TEMPLATES.map((tmpl) => {
                const c = COLOR_MAP[tmpl.color];
                const isLoaded = templateLoaded === tmpl.type;
                return (
                  <button
                    key={tmpl.type}
                    onClick={() => loadTemplate(tmpl.type)}
                    disabled={templateLoading}
                    className={`w-full p-4 text-left border rounded-xl transition ${isLoaded ? "border-gray-300 bg-gray-50 dark:bg-gray-800/50" : `border-gray-200 dark:border-gray-600 ${c.border} ${c.bg}`}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{tmpl.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-gray-800 dark:text-white">{tmpl.name}</p>
                          <span className="text-xs text-gray-400">{tmpl.count} {t("items")}</span>
                          {isLoaded && <span className="text-xs text-emerald-600 dark:text-gray-300 font-medium">✓ {t("loaded")}</span>}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{tmpl.desc}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {templateLoading && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <svg className="animate-spin h-4 w-4 text-blue-600" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                <p className="text-sm text-blue-600 dark:text-blue-400">{t("loadingTemplate")}</p>
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
