// Tier 4 — Phase C: SalesPage restructured to the v2 spec
// (docs/tier-4-dashboard-restructure.md §4 + §7).
//
//   • Outer wrapper → <PageShell width="default"> (gutters + max-w + rhythm)
//   • Right rail reframed from period KPIs → session reconciliation tiles
//     (4 tiles for `session4tile` mode, inline strip for `sessionInline`).
//     Persona-aware via getArchetype(user) once Phase A's
//     `dashboardCardSets.js` lands; falls back to `session4tile` until then.
//   • Recent Sales table → <DataTable> primitive (replaces the hand-rolled
//     desktop <table> + mobile card list — ~450 LOC of chrome removed).
//   • Filter row (event + date range + search) → <FilterBar> primitive.
//   • Edit / return inline forms now render in an overlay panel above the
//     table when editId / returnMode is set, so the row renderer stays
//     declarative.
//
// All state hooks (amount, method, notes, saleDate, recentSales, eventFilter,
// editId, returnMode, …) and all API handlers (submit, handleReturn, openEdit,
// softDelete, bulkDelete) keep their existing names + shapes — only the
// rendering layer changed.
import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Undo2, Pencil, Trash, AlertCircle, Receipt } from "lucide-react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { useStickyMethod } from "../hooks/useStickyMethod";
import ReceiptCapture from "../components/ReceiptCapture";
import ReceiptViewer from "../components/ReceiptViewer";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { errText } from "../utils/errText";
import { displayCurrency, getTaxConfig, formatOwnerMoney } from "../utils/currency";
import { formatDate, formatDateClear, localIso, businessTodayIso } from "../utils/dateFormat";
import { cutoffHourFor } from "../config/archetypes";
import TaxBreakdown from "../components/TaxBreakdown";
import { FadeIn } from "../components/AnimationKit";
import DismissibleTip from "../components/DismissibleTip";
import { PageHeader, Button, SectionBanner, StatCard, TabPills, Empty, Card, Amount } from "../components/ui";
import EntryCard from "../components/ui/EntryCard";
import PageShell from "../components/ui/PageShell";
import DataTable from "../components/ui/DataTable";
import FilterBar from "../components/ui/FilterBar";

const QUICK_AMOUNTS = [500, 1000, 2500, 5000, 7500, 10000, 15000];

// Persona-aware right-rail mode.
// TODO: read from `../config/dashboardCardSets` (getArchetype) once Phase A
// lands. Parallel agent owns that file; until it merges we default every
// account to `session4tile` (matches transactionalDaily — café/restaurant/
// retail — the most common archetype). When Phase A merges, swap this to:
//
//   import { getArchetype } from "../config/dashboardCardSets";
//   const archetype = useMemo(() => getArchetype(user), [user]);
//   const rightRailMode = archetype.salesRightRail;
//
// Hardcoding the default keeps Phase C unblocked on Phase A's merge.
const DEFAULT_RIGHT_RAIL_MODE = "session4tile";

export default function SalesPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [sales, setSales] = useState([]);
  const [salesLoading, setSalesLoading] = useState(true);
  const [amount, setAmount] = useState("");
  // BUSINESS-DAY CUTOFF. Seeded from the archetype default (food_service /
  // bar → 6, else 0 — the client twin of archetype.py) so the first render is
  // already correct for an uncustomised account, then replaced by the owner's
  // stored day_cutoff_hour from /business. Before this, everything on this
  // page used the wall-clock date: at 00:30 the TODAY tile reported 0 kr.
  // while the dashboard — which asks the server for the business day —
  // correctly showed the evening's takings.
  const [cutoffHour, setCutoffHour] = useState(() => cutoffHourFor(user?.business_type));
  useEffect(() => {
    let cancelled = false;
    api
      .get("/business")
      .then((r) => {
        const h = r?.data?.day_cutoff_hour;
        if (!cancelled && h != null && Number.isFinite(Number(h))) setCutoffHour(Number(h));
      })
      .catch(() => {}); // keep the archetype default — never block the page
    return () => {
      cancelled = true;
    };
  }, []);
  const businessToday = businessTodayIso(cutoffHour);

  // Defaults to the BUSINESS day, not the wall-clock day. The field stays
  // visible and editable, and the backdate warning below still fires, so an
  // owner whose stored cutoff differs from the archetype default can still
  // see and correct it in the window before /business resolves.
  const [saleDate, setSaleDate] = useState(() =>
    businessTodayIso(cutoffHourFor(user?.business_type)),
  );
  // Sticky payment method — seeds from the owner's last choice (DK default:
  // card). commitMethod persists on a deliberate tap (cash excluded — it's the
  // only method that posts to the cashbook). See useStickyMethod. The setter is
  // not destructured here: nothing on this page sets the method except the
  // picker itself, which goes through commitMethod.
  const { method, commitMethod } = useStickyMethod("sale");
  const [notes, setNotes] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [receiptViewing, setReceiptViewing] = useState(null);
  const [editData, setEditData] = useState({});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [showItemSale, setShowItemSale] = useState(false);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [returnMode, setReturnMode] = useState(null);
  const [returnData, setReturnData] = useState({ reason: "", action: "" });
  const [returnSummary, setReturnSummary] = useState(null);
  const [eventOptions, setEventOptions] = useState([]);
  const [eventFilter, setEventFilter] = useState("");

  // Session reconciliation: track the page-mount timestamp so we can
  // count "sales logged since the user opened this tab" (= the right-rail
  // THIS SESSION tile). Using a ref keeps it stable across renders.
  const sessionMountedAtRef = useRef(new Date().toISOString());

  // Right-rail mode — see DEFAULT_RIGHT_RAIL_MODE above.
  const rightRailMode = DEFAULT_RIGHT_RAIL_MODE;

  // Memoized so the filter + sort only re-runs when its inputs actually
  // change (sales / statusFilter / search) — NOT on every keystroke in the
  // edit panel, every focus-refetch, or every selection toggle. On a long
  // sales list the unmemoized version re-filtered + re-sorted the whole
  // array on each render, which is the "laggy" feel Manoj reported.
  const filtered = useMemo(() => sales.filter(s => {
    if (statusFilter === "completed" && (s.status || "completed") !== "completed") return false;
    if (statusFilter === "returns" && !["returned", "exchanged", "return-pending"].includes(s.status || "completed")) return false;
    if (search && !(s.notes?.toLowerCase().includes(search.toLowerCase()) || s.payment_method?.toLowerCase().includes(search.toLowerCase()) || String(s.amount).includes(search) || (s.item_name || "").toLowerCase().includes(search.toLowerCase()))) return false;
    return true;
  }).sort((a, b) => {
    const aPend = (a.status === "return-pending") ? 0 : 1;
    const bPend = (b.status === "return-pending") ? 0 : 1;
    if (aPend !== bPend) return aPend - bPend;
    const d = b.date.localeCompare(a.date);
    if (d !== 0) return d;
    return (b.created_at || "").localeCompare(a.created_at || "");
  }), [sales, statusFilter, search]);

  const pendingReturnCount = useMemo(() => sales.filter(s => s.status === "return-pending").length, [sales]);
  const returnCount = useMemo(() => sales.filter(s => ["returned", "exchanged", "return-pending"].includes(s.status || "completed")).length, [sales]);

  // Period summary for the currently-filtered sales — so an owner can read
  // e.g. "last month" totals + averages straight from the Sales list (not the
  // AI). Computed over the same rows shown in the table below. Memoized on
  // the same inputs as `filtered` (+ the date range) so the reduce/span work
  // doesn't repeat every render.
  const { periodTotal, periodAvgSale, periodSpanDays, periodAvgDay } = useMemo(() => {
    const total = filtered.reduce((acc, s) => acc + (parseFloat(s.amount) || 0), 0);
    const avgSale = filtered.length ? total / filtered.length : 0;
    const spanDays = (() => {
      if (filterFrom && filterTo) {
        return Math.max(1, Math.round((new Date(filterTo) - new Date(filterFrom)) / 86400000) + 1);
      }
      const ds = filtered.map((s) => s.date).filter(Boolean).sort();
      if (!ds.length) return 1;
      return Math.max(1, Math.round((new Date(ds[ds.length - 1]) - new Date(ds[0])) / 86400000) + 1);
    })();
    return { periodTotal: total, periodAvgSale: avgSale, periodSpanDays: spanDays, periodAvgDay: total / spanDays };
  }, [filtered, filterFrom, filterTo]);

  // Has any filter been touched compared to defaults?
  const hasActiveFilter = !!(eventFilter || filterFrom || filterTo || search);

  // Session / today / event reconciliation aggregates. Memoised so we don't
  // recompute on every input keystroke.
  const sessionAgg = useMemo(() => {
    const sessionAt = sessionMountedAtRef.current;
    const sessionSales = sales.filter((s) => (s.created_at || "") >= sessionAt);
    const todayStr = businessToday;
    const todaySales = sales.filter((s) => s.date === todayStr);
    const eventSales = eventFilter && eventFilter !== "__none__"
      ? sales.filter((s) => s.event_id === eventFilter)
      : (eventFilter === "__none__"
          ? sales.filter((s) => !s.event_id)
          : []);
    const sum = (rows) => rows.reduce((acc, s) => acc + parseFloat(s.amount || 0), 0);
    return {
      sessionCount: sessionSales.length,
      sessionTotal: sum(sessionSales),
      todayCount: todaySales.length,
      todayTotal: sum(todaySales),
      eventCount: eventSales.length,
      eventTotal: sum(eventSales),
    };
    // businessToday IS a dependency: it changes when /business resolves the
    // owner's real cutoff. Without it the TODAY tile would keep the value
    // computed from the archetype default and the fix would be inert.
  }, [sales, eventFilter, businessToday]);


  const fetchSales = async (from, to, eventId) => {
    try {
      setFetchError("");
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const effectiveEventFilter = eventId !== undefined ? eventId : eventFilter;
      if (effectiveEventFilter === "__none__") params.event_id = "null";
      else if (effectiveEventFilter) params.event_id = effectiveEventFilter;
      const res = await api.get("/sales", { params });
      setSales(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setFetchError(errText(err, t("failedToLoadSales")));
    } finally {
      setSalesLoading(false);
    }
  };
  const fetchEventOptions = () => {
    api
      .get("/events", { params: { sort: "date_desc", include_deleted: true } })
      .then((r) => setEventOptions(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEventOptions([]));
  };
  const fetchInventory = () => {
    api.get("/inventory").then((res) => setInventoryItems(res.data)).catch(() => {});
  };
  const fetchReturnSummary = () => {
    api.get("/sales/returns/summary").then((r) => setReturnSummary(r.data)).catch(() => {});
  };

  const processReturn = async (saleId) => {
    if (!returnData.reason || !returnData.action) return;
    try {
      await api.post(`/sales/${saleId}/return`, {
        reason: returnData.reason,
        action: returnData.action,
      });
      setReturnMode(null);
      setReturnData({ reason: "", action: "" });
      setSuccess(t("returnProcessed", "Return processed successfully"));
      setTimeout(() => setSuccess(""), 3000);
      fetchSales(filterFrom, filterTo);
      fetchInventory();
      fetchReturnSummary();
      window.dispatchEvent(new CustomEvent("bonbox-data-changed"));
    } catch (err) {
      setError(errText(err, t("salPgFailedProcessReturn", "Failed to process return")));
      setTimeout(() => setError(""), 4000);
    }
  };

  // Mount fetch is gated on `user?.id` so the GET fires only AFTER auth has
  // hydrated. ProtectedRoute already waits for `loading`, but threading the
  // user id through here gives us a clean re-fetch on hot account switches
  // (rare, but it happens during impersonation / accountant view).
  useEffect(() => {
    if (!user?.id) return;
    let initialEvent = "";
    try {
      const params = new URLSearchParams(window.location.search);
      const ev = params.get("event_id");
      if (ev) initialEvent = ev;
    } catch { /* SSR / no window */ }
    if (initialEvent) setEventFilter(initialEvent);
    fetchSales(undefined, undefined, initialEvent || "");
    fetchInventory();
    fetchReturnSummary();
    fetchEventOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Cross-page sync — when any other surface mutates sales data (Daily
  // Close, Smart Scan, ReceiptCapture, returns) we refetch. Separated
  // from the mount effect so the listener is wired exactly once and reads
  // the latest filter values via refs.
  const filterRef = useRef({ from: "", to: "" });
  filterRef.current = { from: filterFrom, to: filterTo };
  useEffect(() => {
    const onDataChanged = () => {
      fetchSales(filterRef.current.from, filterRef.current.to);
      fetchInventory();
      fetchReturnSummary();
    };
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snap-refresh on tab/window focus. The "stale after login" case happens
  // when the user logs in on another tab / completes magic-link / comes
  // back from a Stripe checkout — the SalesPage instance is still mounted
  // but its data is from before the trip. visibilitychange covers iOS
  // Safari (where focus/blur don't fire reliably during Home Indicator
  // drags) and matches the existing pattern in LiveKpisToday.jsx.
  useEffect(() => {
    if (!user?.id) return;
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        fetchSales(filterRef.current.from, filterRef.current.to);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    fetchSales(filterFrom, filterTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventFilter, user?.id]);

  // The edit / return panels render above the FilterBar + table (so the row
  // renderer stays declarative). On a long sales list, clicking Edit / Return
  // on a row the owner had scrolled down to would open the form off-screen
  // above the fold — it looked like "the edit button does nothing". Scroll
  // the active panel into view whenever it opens.
  const panelRef = useRef(null);
  useEffect(() => {
    if ((editId || returnMode) && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [editId, returnMode]);

  const submit = async (amt) => {
    const value = amt || parseFloat(amount);
    if (!value) return;
    const duplicate = sales.find(s => s.date === saleDate && parseFloat(s.amount) === value);
    if (duplicate && !(await confirm({ message: `${t("aSaleOf")} ${formatOwnerMoney(value, user?.currency)} ${t("on")} ${formatDate(saleDate)} ${t("duplicateSaleConfirm")}`, destructive: false }))) {
      return;
    }
    setError("");
    // Optimistic insert — the new row shows up at the top of the list
    // immediately so the page feels instant even on Render cold-start
    // (where the POST round-trip can be 2-15s). The temp row carries
    // _pending=true so we can dim it / replace it deterministically.
    // On success the server row replaces it; on failure we roll back.
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticRow = {
      id: tempId,
      date: saleDate,
      amount: value,
      payment_method: method,
      notes: notes || null,
      is_tax_exempt: isTaxExempt,
      status: "completed",
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setSales(prev => [optimisticRow, ...prev]);
    // Reset form straight away so the owner can log the next sale while
    // the POST is in flight. Booking values into locals first so the
    // catch block can roll back to them if needed.
    const submittedSnapshot = { amount, notes, isTaxExempt, saleDate };
    setAmount("");
    setNotes("");
    setIsTaxExempt(false);
    setSaleDate(businessToday);
    try {
      const res = await api.post("/sales", {
        date: submittedSnapshot.saleDate,
        amount: value,
        payment_method: method,
        notes: submittedSnapshot.notes || null,
        is_tax_exempt: submittedSnapshot.isTaxExempt,
      });
      // Replace the temp row with the canonical server row (carries the
      // real id, bilagsnummer, created_at, MOMS calc, etc).
      if (res?.data && res.data.id) {
        setSales(prev => prev.map(s => s.id === tempId ? res.data : s));
      } else {
        // Defensive fallback — server didn't return a row, refetch.
        fetchSales(filterFrom, filterTo);
      }
      const isBackdated = submittedSnapshot.saleDate !== businessToday;
      trackEvent("sale_logged", "sales", `${value} ${currency} via ${method}`);
      setSuccess(`${formatOwnerMoney(value, user?.currency)}${isBackdated ? ` (${formatDate(submittedSnapshot.saleDate)})` : ""}!`);
      // Refresh inventory / aggregates / cross-page subscribers — but
      // don't block the UI on it.
      window.dispatchEvent(new Event("bonbox-data-changed"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      // Roll back the optimistic insert + restore the form so the owner
      // can retry without retyping.
      setSales(prev => prev.filter(s => s.id !== tempId));
      setAmount(submittedSnapshot.amount);
      setNotes(submittedSnapshot.notes);
      setIsTaxExempt(submittedSnapshot.isTaxExempt);
      setSaleDate(submittedSnapshot.saleDate);
      setError(errText(err, t("failedToAddSale")));
    }
  };

  const startEdit = (sale) => {
    setEditId(sale.id);
    setEditData({
      date: sale.date,
      amount: parseFloat(sale.amount),
      payment_method: sale.payment_method,
      notes: sale.notes || "",
      is_tax_exempt: sale.is_tax_exempt || false,
    });
  };

  const saveEdit = async () => {
    try {
      const payload = { ...editData };
      if (payload.amount === "") payload.amount = 0;
      await api.put(`/sales/${editId}`, payload);
      setEditId(null);
      setEditData({});
      fetchSales(filterFrom, filterTo);
      window.dispatchEvent(new Event("bonbox-data-changed"));
      setSuccess(t("saleUpdated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToUpdateSale")));
    }
  };

  const bulkDelete = async () => {
    if (!(await confirm({ message: `${t("moveToTrash")} ${selected.size}?`, destructive: true }))) return;
    try {
      await Promise.all([...selected].map(id => api.delete(`/sales/${id}`)));
      setSelected(new Set());
      fetchSales(filterFrom, filterTo);
      window.dispatchEvent(new Event("bonbox-data-changed"));
      setSuccess(`${selected.size} ${t("movedToDeleted")}`);
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError(t("failedToDeleteSome"));
    }
  };

  const deleteSale = async (id) => {
    try {
      await api.delete(`/sales/${id}`);
      fetchSales(filterFrom, filterTo);
      window.dispatchEvent(new Event("bonbox-data-changed"));
      setSuccess(t("movedToDeleted"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToDeleteSale")));
    }
  };

  // ─── Selection helpers (wired into <DataTable selectable> props) ──────
  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.slice(0, 50).map((s) => s.id)));
  };

  // ─── Filter clear (used by <FilterBar.Reset>) ─────────────────────────
  const clearAllFilters = () => {
    setEventFilter("");
    setFilterFrom("");
    setFilterTo("");
    setSearch("");
    fetchSales();
  };

  // ─── Right-rail panel (rendered inline in the JSX below) ──────────────
  const rightRailFourTile = (
    <div className="lg:col-span-1 grid grid-cols-2 lg:grid-cols-1 gap-3 content-start">
      {/* Currency token now lives IN the value via <Amount> (whispered at
          0.62em), so the helper no longer repeats "· DKK" after the count. */}
      <StatCard
        label={t("thisSession", "THIS SESSION")}
        value={salesLoading ? "—" : <Amount value={sessionAgg.sessionTotal} currency={user?.currency} />}
        helper={salesLoading ? " " : `${sessionAgg.sessionCount} ${sessionAgg.sessionCount === 1 ? t("saleCount") : t("salesCount")}`}
      />
      <StatCard
        label={t("today", "TODAY")}
        value={salesLoading ? "—" : <Amount value={sessionAgg.todayTotal} currency={user?.currency} />}
        helper={salesLoading ? " " : `${sessionAgg.todayCount} ${sessionAgg.todayCount === 1 ? t("saleCount") : t("salesCount")}`}
      />
      {eventFilter && eventFilter !== "" && (
        <StatCard
          label={t("event", "EVENT")}
          value={salesLoading ? "—" : <Amount value={sessionAgg.eventTotal} currency={user?.currency} />}
          helper={salesLoading ? " " : `${sessionAgg.eventCount} ${sessionAgg.eventCount === 1 ? t("saleCount") : t("salesCount")}`}
        />
      )}
      <Card
        variant="subtle"
        className={
          // Keep the tile chrome aligned to the StatCard neighbours so the
          // 2x2 grid reads as one block. The reconcile card is the
          // action-oriented one — it links to the daily close.
          "flex flex-col justify-between gap-2 px-4 py-3.5"
        }
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("reconcile", "RECONCILE")}
          </p>
          <p className="text-[12px] text-gray-600 dark:text-gray-300 mt-1 leading-snug">
            {t("matchesCashDrawer", "Matches cash drawer?")}
          </p>
        </div>
        <Link
          to="/daily-close"
          className={
            "inline-flex items-center justify-center gap-1 rounded-lg " +
            "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-100 " +
            "hover:bg-gray-200 dark:hover:bg-gray-700 transition " +
            "h-7 px-2.5 text-xs font-medium"
          }
        >
          {t("openDailyClose", "Open Daily Close")} →
        </Link>
      </Card>
    </div>
  );

  const sessionInlineLine = (
    <p className="text-sm text-gray-500 dark:text-gray-400">
      {sessionAgg.sessionCount} {sessionAgg.sessionCount === 1 ? t("saleCount") : t("salesCount")}
      {" "}{t("thisSessionInline", "this session")} · <Amount value={sessionAgg.sessionTotal} currency={user?.currency} />
      <Link
        to="/daily-close"
        className="ml-2 text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white underline"
      >
        {t("openDailyClose", "Open Daily Close")} →
      </Link>
    </p>
  );

  // ─── DataTable column + row-action config ─────────────────────────────
  const paymentLabel = (m) => (m ? t(m) : "—");
  const statusBadge = (s) => {
    const st = s.status || "completed";
    if (st === "completed") return null;
    const cfg = {
      returned:         { dot: "bg-red-600",    label: t("returned", "Returned") },
      exchanged:        { dot: "bg-gray-500",   label: t("exchanged", "Exchanged") },
      "return-pending": { dot: "bg-amber-500",  label: t("returnPending", "Return pending") },
    };
    const c = cfg[st] || cfg.returned;
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200">
        <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} aria-hidden="true" />
        {c.label}
      </span>
    );
  };

  const columns = [
    {
      id: "amount",
      label: t("amount"),
      align: "right",
      render: (r) => {
        const st = r.status || "completed";
        return (
          <div className="inline-flex items-center justify-end gap-2 flex-wrap">
            <span className={st === "returned" ? "line-through text-gray-500" : "font-semibold tabular-nums"}>
              <Amount value={parseFloat(r.amount)} currency={user?.currency} />
            </span>
            {statusBadge(r)}
            {r.receipt_photo && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setReceiptViewing(r)}
                aria-label={t("receiptViewerOpen", "View receipt")}
              >
                {t("viewReceipt", "Receipt")}
              </Button>
            )}
          </div>
        );
      },
    },
    {
      id: "method",
      label: t("payment"),
      render: (r) => <span className="capitalize">{paymentLabel(r.payment_method)}</span>,
    },
    {
      id: "notes",
      label: t("notes"),
      render: (r) => {
        if (r.item_name) {
          return (
            <span className="text-gray-700 dark:text-gray-300">
              {r.item_name}
              {r.quantity_sold ? ` × ${r.quantity_sold}` : ""}
            </span>
          );
        }
        return r.notes || "—";
      },
    },
    {
      id: "date",
      label: t("date"),
      width: "w-32",
      // Keep the date on one line — capped-table column widths can otherwise
      // squeeze "8 Jul 26" into a 3-line stack.
      render: (r) => <span className="whitespace-nowrap">{formatDateClear(r.date)}</span>,
    },
  ];

  const rowActions = (row) => {
    const st = row.status || "completed";
    const actions = [];
    if (st === "completed" || st === "return-pending") {
      actions.push({
        label: t("return", "Return"),
        icon: <Undo2 size={14} />,
        onClick: () => {
          setReturnMode(row.id);
          setReturnData({ reason: row.return_reason || "", action: "" });
        },
      });
    }
    if (st === "completed") {
      actions.push({
        label: t("edit"),
        icon: <Pencil size={14} />,
        onClick: () => startEdit(row),
      });
    }
    actions.push({
      label: t("moveToTrash"),
      icon: <Trash size={14} />,
      onClick: async () => {
        const ok = await confirm({
          message: `${t("moveToTrash")} — ${formatOwnerMoney(Number(row.amount || 0), user?.currency)}`,
          destructive: true,
          confirmLabel: t("moveToTrash"),
        });
        if (ok) deleteSale(row.id);
      },
      variant: "danger",
    });
    return actions;
  };

  // ─── Inline edit panel (replaces in-row form) ─────────────────────────
  const editPanel = editId && (() => {
    const sale = sales.find((s) => s.id === editId);
    if (!sale) return null;
    return (
      <Card variant="emphasis">
        <Card.Header
          title={t("editSale", "Edit sale")}
          subtitle={`${formatOwnerMoney(parseFloat(sale.amount), user?.currency)} · ${formatDateClear(sale.date)}`}
          action={
            <Button variant="ghost" size="sm" onClick={() => { setEditId(null); setEditData({}); }}>
              {t("cancel")}
            </Button>
          }
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-1">
            {t("amount")}
            <input
              type="number"
              value={editData.amount}
              onChange={(e) => setEditData({ ...editData, amount: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
              className="h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </label>
          <label className="text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-1">
            {t("date")}
            <input
              type="date"
              value={editData.date}
              onChange={(e) => setEditData({ ...editData, date: e.target.value })}
              className="h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </label>
          <label className="text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-1">
            {t("payment")}
            <select
              value={editData.payment_method}
              onChange={(e) => setEditData({ ...editData, payment_method: e.target.value })}
              className="h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            >
              {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                <option key={m} value={m}>{t(m)}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-1">
            {t("notes")}
            <input
              type="text"
              value={editData.notes || ""}
              onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
              placeholder={t("notes")}
              className="h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { setEditId(null); setEditData({}); }}>
            {t("cancel")}
          </Button>
          <Button variant="primary" onClick={saveEdit}>
            {t("save")}
          </Button>
        </div>
      </Card>
    );
  })();

  // ─── Inline return panel (replaces in-row form) ───────────────────────
  const returnPanel = returnMode && (() => {
    const sale = sales.find((s) => s.id === returnMode);
    if (!sale) return null;
    const reasons = ["Wrong order", "Cold/bad quality", "Changed mind", "Defective", "Size issue", "Other"];
    const actions = [
      { id: "refund",   label: t("refund", "Refund"),     sub: formatOwnerMoney(parseFloat(sale.amount), user?.currency) },
      { id: "replace",  label: t("replace", "Replace"),   sub: t("sendNewItem", "Send new item") },
      { id: "exchange", label: t("exchange", "Exchange"), sub: t("swapForAnother", "Swap for another") },
      { id: "restock",  label: t("restock", "Restock"),   sub: t("backToInventory", "Back to inventory") },
    ];
    return (
      <Card variant="emphasis">
        <Card.Header
          title={t("processReturn", "Process return")}
          subtitle={`${formatOwnerMoney(parseFloat(sale.amount), user?.currency)} · ${formatDateClear(sale.date)}`}
          action={
            <Button variant="ghost" size="sm" onClick={() => { setReturnMode(null); setReturnData({ reason: "", action: "" }); }}>
              {t("cancel")}
            </Button>
          }
        />
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
            {t("reason", "Reason")}
          </p>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {reasons.map((r) => {
              const selectedR = returnData.reason === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReturnData({ ...returnData, reason: r })}
                  className={
                    "text-[12px] font-medium px-2.5 py-1 rounded-full border transition " +
                    (selectedR
                      ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                      : "bg-white text-gray-700 border-gray-200 hover:border-gray-300 dark:bg-gray-900 dark:text-gray-300 dark:border-gray-700")
                  }
                >
                  {r}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
            {t("action", "Action")}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {actions.map((a) => {
              const sel = returnData.action === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setReturnData({ ...returnData, action: a.id })}
                  className={
                    "p-3 rounded-xl border text-left transition " +
                    (sel
                      ? "bg-gray-50 border-gray-900 dark:bg-gray-800 dark:border-gray-100 ring-1 ring-gray-900 dark:ring-gray-100"
                      : "bg-white border-gray-200 hover:border-gray-300 dark:bg-gray-900 dark:border-gray-700")
                  }
                >
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{a.label}</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{a.sub}</p>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { setReturnMode(null); setReturnData({ reason: "", action: "" }); }}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => processReturn(sale.id)}
              disabled={!returnData.reason || !returnData.action}
            >
              {t("confirmReturn", "Confirm return")}
            </Button>
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3">
            {t("invAndPlAutoUpdate", "Inventory & P&L update automatically")}
          </p>
        </div>
      </Card>
    );
  })();

  // ─── Bulk-action toolbar (sticky bottom) ───────────────────────────────
  const bulkBar = selected.size > 0 && (() => {
    const selSales = filtered.filter((s) => selected.has(s.id));
    const total = selSales.reduce((acc, s) => acc + parseFloat(s.amount), 0);
    const avg = selSales.length ? total / selSales.length : 0;
    return (
      <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-lg w-[calc(100%-2rem)]">
        <Card variant="emphasis" className="!p-4">
          <div className="flex items-center gap-3 mb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              aria-label={t("clearSelection", "Clear selection")}
            >
              ×
            </Button>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1">
              {selected.size} {t("selected")} · <Amount value={total} currency={user?.currency} />
            </p>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t("avg")}: <Amount value={avg} currency={user?.currency} />
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const text = `${selected.size} sales | Total: ${formatOwnerMoney(total, user?.currency)} | Avg: ${formatOwnerMoney(avg, user?.currency)}`;
                navigator.clipboard?.writeText(text);
                setSuccess(t("copiedToClipboard"));
                setTimeout(() => setSuccess(""), 2000);
              }}
            >
              {t("copySummary")}
            </Button>
            <Button variant="danger" size="sm" onClick={bulkDelete}>
              {t("moveToTrash")}
            </Button>
          </div>
        </Card>
      </div>
    );
  })();

  return (
    <PageShell width="default">
      <FadeIn>
        <PageHeader
          eyebrow="MONEY"
          title={t("salesTracker")}
          actions={
            <>
              <Button variant="accent" onClick={() => setShowItemSale(true)}>
                + {t("itemSale")}
              </Button>
              <ReceiptCapture onSaleCreated={fetchSales} />
            </>
          }
        />
      </FadeIn>

      {/* Inline status messages.  Kept neutral — no green/red full-tint
          backgrounds (those were doctrine violations).  Critical = red dot
          + neutral pill; success uses the Button-accent style via SectionBanner. */}
      {success && (
        <SectionBanner severity="info" icon="Check" title={success}>
          <span className="sr-only">{success}</span>
        </SectionBanner>
      )}
      {error && (
        <SectionBanner severity="critical" icon="AlertCircle" title={error}>
          <span className="sr-only">{error}</span>
        </SectionBanner>
      )}
      {fetchError && (
        <SectionBanner severity="critical" icon="AlertCircle" title={fetchError}>
          <span className="sr-only">{fetchError}</span>
        </SectionBanner>
      )}

      <DismissibleTip
        id="sales-intro-v1"
        title={t("salPgTipTitle", "Three ways to log a sale")}
      >
        <p>
          <strong>{t("salPgTipTapAmount", "Tap an amount")}</strong> {t("salPgTipBody1", "below for a quick gross-total sale, hit")}{" "}
          <strong>{t("salPgTipItemSale", "+ Item sale")}</strong> {t("salPgTipBody2", "when you need line items + inventory deduction, or")}{" "}
          <strong>{t("salPgTipScanReceipt", "scan a receipt")}</strong> {t("salPgTipBody3", "with the camera and BonBox auto-fills the total. Every sale you log here gets a sequential bilagsnummer for SKAT.")}
        </p>
      </DismissibleTip>

      {/* EntryCard (left) + session reconciliation right-rail.
          When rightRailMode === "session4tile" the rail is a 2-column
          grid of small StatCards.  When "sessionInline" the rail is
          removed and a single muted line sits above the table instead
          (rendered further down). */}
      <div className={rightRailMode === "session4tile" ? "grid grid-cols-1 lg:grid-cols-4 gap-4" : ""}>
        <div className={rightRailMode === "session4tile" ? "lg:col-span-3" : ""}>
          <EntryCard
            title={t("logSale")}
            hint={t("tapAmount")}
            amountPresets={QUICK_AMOUNTS}
            amount={amount}
            onAmountChange={setAmount}
            amountPlaceholder={`${t("customAmount")} ${getTaxConfig(user?.currency).rate > 0 ? `(${getTaxConfig(user?.currency).label})` : ""}`}
            amountSuffix={currency === "DKK" ? "kr." : currency}
            paymentMethods={["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => ({ id: m, label: t(m) }))}
            paymentMethod={method}
            onPaymentChange={commitMethod}
            extras={
              <>
                <TaxBreakdown amount={amount} currencyCode={user?.currency} isTaxExempt={isTaxExempt} onTaxExemptChange={setIsTaxExempt} />
                {saleDate !== businessToday && (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400 font-medium">{t("backdatedEntry")}</p>
                )}
              </>
            }
            notes={notes}
            onNotesChange={setNotes}
            notesPlaceholder={t("addNoteOptional")}
            date={saleDate}
            onDateChange={setSaleDate}
            submitLabel={t("log")}
            onSubmit={() => submit()}
          />
        </div>
        {rightRailMode === "session4tile" && rightRailFourTile}
      </div>

      {rightRailMode === "sessionInline" && sessionInlineLine}

      {/* Item Sale Modal */}
      {showItemSale && (
        <ItemSaleModal
          items={inventoryItems}
          currency={currency}
          onClose={() => setShowItemSale(false)}
          onSale={async (saleData) => {
            try {
              await api.post("/sales", saleData);
              setShowItemSale(false);
              fetchSales(filterFrom, filterTo);
              fetchInventory();
              setSuccess(`${t("itemSale")}: ${saleData.item_name || t("item")} × ${saleData.quantity_sold} = ${formatOwnerMoney(saleData.quantity_sold * saleData.unit_price, user?.currency)}`);
              setTimeout(() => setSuccess(""), 3000);
            } catch (err) {
              setError(errText(err, t("failedToCreateItemSale")));
              setTimeout(() => setError(""), 4000);
            }
          }}
        />
      )}

      {/* CSV Import */}
      <CsvUpload onDone={fetchSales} />

      {/* Pending returns banner */}
      {pendingReturnCount > 0 && (
        <SectionBanner
          severity="warn"
          icon="AlertTriangle"
          title={`${pendingReturnCount} ${pendingReturnCount === 1 ? t("salPgReturnPendingOne", "return pending") : t("salPgReturnPendingMany", "returns pending")}`}
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{t("needsRefundReplaceRestock", "Needs your action — refund, replace, or restock")}</span>
            <Button variant="secondary" size="sm" onClick={() => setStatusFilter("returns")}>
              {t("viewReturns", "View returns")}
            </Button>
          </div>
        </SectionBanner>
      )}

      {/* Return summary stats */}
      {returnSummary && returnSummary.total_returns > 0 && statusFilter === "returns" && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label={t("returns", "Returns")}
            value={returnSummary.total_returns}
            accent="critical"
          />
          <StatCard
            label={t("refunded", "Refunded")}
            value={<Amount value={returnSummary.total_refunded} currency={user?.currency} />}
            accent="critical"
          />
          <StatCard
            label={t("pending", "Pending")}
            value={returnSummary.pending_count}
            accent="warn"
          />
          <StatCard
            label={t("exchanged", "Exchanged")}
            value={returnSummary.by_action?.exchange || 0}
          />
        </div>
      )}

      {/* Inline edit / return panels (replace the in-row forms). Wrapped so
          panelRef can scroll the active panel into view when it opens — see
          the panelRef effect above. The wrapper only mounts while a panel is
          open, so there's no phantom gap in the page rhythm when it's closed. */}
      {(editPanel || returnPanel) && (
        <div ref={panelRef} className="scroll-mt-24">
          {editPanel}
          {returnPanel}
        </div>
      )}

      {/* Recent sales section — title + FilterBar + DataTable */}
      <section className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3 sm:justify-between">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("recentSales")}
            </h2>
            <TabPills
              tabs={[
                { id: "all",       label: t("all", "All") },
                { id: "completed", label: t("completed", "Completed") },
                { id: "returns",   label: `${t("returns", "Returns")}${returnCount > 0 ? ` (${returnCount})` : ""}` },
              ]}
              activeId={statusFilter}
              onChange={setStatusFilter}
              ariaLabel={t("salPgStatusFilterAria", "Sales status filter")}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => exportToCsv("sales.csv", sales, [
              { key: "date",           label: t("date") },
              { key: "amount",         label: t("amount") },
              { key: "payment_method", label: t("payment") },
              { key: "notes",          label: t("notes") },
            ])}
          >
            {t("exportCsv")}
          </Button>
        </div>

        <FilterBar>
          {eventOptions.length > 0 && (
            <FilterBar.Select
              label={t("event", "Event")}
              value={eventFilter}
              onChange={setEventFilter}
              options={[
                { value: "",         label: t("filterAllEvents", "All events") },
                { value: "__none__", label: t("filterNoEvent", "No event") },
                ...eventOptions.map((ev) => ({
                  value: ev.id,
                  label: `${ev.name} · ${ev.event_date}${ev.is_deleted ? " (deleted)" : ""}`,
                })),
              ]}
            />
          )}
          <FilterBar.Date
            label={t("from", "From")}
            value={filterFrom}
            onChange={(v) => { setFilterFrom(v); fetchSales(v, filterTo); }}
          />
          <FilterBar.Date
            label={t("to", "To")}
            value={filterTo}
            onChange={(v) => { setFilterTo(v); fetchSales(filterFrom, v); }}
          />
          <FilterBar.Search
            value={search}
            onChange={setSearch}
            placeholder={t("searchSalesPh", t("searchSalesPlaceholder"))}
          />
          {hasActiveFilter && (
            <FilterBar.Reset onClick={clearAllFilters} />
          )}
        </FilterBar>

        {/* Period summary — total + averages for the filtered set (e.g. last month) */}
        {filtered.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 px-4 py-2.5 text-sm">
            <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
              {t("total")}: <Amount value={periodTotal} currency={user?.currency} />
            </span>
            <span className="text-gray-300 dark:text-gray-700" aria-hidden="true">·</span>
            <span className="text-gray-600 dark:text-gray-300 tabular-nums">
              {filtered.length} {filtered.length === 1 ? t("saleCount") : t("salesCount")}
            </span>
            <span className="text-gray-300 dark:text-gray-700" aria-hidden="true">·</span>
            <span className="text-gray-600 dark:text-gray-300 tabular-nums">
              {t("avgDailySales")}: <Amount value={periodAvgDay} currency={user?.currency} />
            </span>
            <span className="text-gray-300 dark:text-gray-700" aria-hidden="true">·</span>
            <span className="text-gray-600 dark:text-gray-300 tabular-nums">
              {t("avgPerSale")}: <Amount value={periodAvgSale} currency={user?.currency} />
            </span>
          </div>
        )}

        <DataTable
          // Cap the desktop ledger width so the 4 short columns sit close
          // together instead of stretching edge-to-edge with a big void in the
          // middle. No-op on phones (viewport < 3xl → mobile cards stay full).
          className="max-w-3xl"
          columns={columns}
          rows={filtered.slice(0, 50)}
          rowKey="id"
          empty={
            <Empty
              icon={Receipt}
              title={t("noSalesYet", "No sales yet")}
              body={t("noSalesBody", "Tap a quick amount above to log your first.")}
            />
          }
          loading={salesLoading}
          rowActions={rowActions}
          selectable={true}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAll}
        />
      </section>

      {/* Sticky bulk-action toolbar */}
      {bulkBar}

      {/* Post-save receipt review */}
      <ReceiptViewer
        open={!!receiptViewing}
        onClose={() => setReceiptViewing(null)}
        imageUrl={receiptViewing?.receipt_photo}
        amount={receiptViewing ? parseFloat(receiptViewing.amount) : null}
        currency={currency}
        date={receiptViewing?.date}
        paymentMethod={receiptViewing?.payment_method}
        description={receiptViewing?.notes}
        kind="sale"
      />
    </PageShell>
  );
}

function ItemSaleModal({ items, currency, onClose, onSale }) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState(null);
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [method, setMethod] = useState("cash");

  const filtered = useMemo(() => {
    const all = items || [];
    const inStock = all.filter((i) => parseFloat(i.quantity) > 0);
    const outOfStock = all.filter((i) => !(parseFloat(i.quantity) > 0));
    if (!search) {
      const top = inStock.slice(0, 20);
      const remainder = Math.max(0, 20 - top.length);
      return [...top, ...outOfStock.slice(0, remainder)];
    }
    const q = search.toLowerCase();
    const matchesQ = (i) => i.name && i.name.toLowerCase().includes(q);
    return [...inStock.filter(matchesQ), ...outOfStock.filter(matchesQ)].slice(0, 20);
  }, [items, search]);

  const ppu = selectedItem ? parseFloat(selectedItem.pieces_per_unit || 0) : 0;
  const hasConversion = selectedItem && selectedItem.sell_unit && ppu > 0 && selectedItem.sell_unit !== selectedItem.unit;
  const sellUnit = hasConversion ? selectedItem.sell_unit : (selectedItem?.unit || "");
  const costPerSellUnit = hasConversion ? parseFloat(selectedItem.cost_per_unit) / ppu : (selectedItem ? parseFloat(selectedItem.cost_per_unit) : 0);
  const availableSellUnits = selectedItem ? (hasConversion ? parseFloat(selectedItem.quantity) * ppu : parseFloat(selectedItem.quantity)) : 0;

  const cost = costPerSellUnit;
  const qtyNum = parseFloat(qty) || 0;
  const priceNum = parseFloat(price) || 0;
  const total = qtyNum * priceNum;
  const profit = qtyNum * (priceNum - cost);
  const available = availableSellUnits;

  const handleSubmit = () => {
    if (!selectedItem || !qtyNum || !priceNum) return;
    onSale({
      // Deliberately NO `date` — the backend resolves it via
      // business_today_local(user), so an item sale rung up at 02:00 CEST
      // (after midnight wall-clock but BEFORE the 06:00 business-day cutoff)
      // lands on the correct business day instead of tomorrow.
      // This form has no date field, so the owner has no way to notice or
      // correct a mis-stamped row. DashboardPage's Quick Sale carries the
      // same comment: sending localIso() here "silently mis-routed
      // post-midnight sales to the next business day — they didn't show up
      // in today's KPIs and the user reported 'Quick sale doesn't add'."
      // That fix landed on Quick Sale only; this path kept the bug.
      inventory_item_id: selectedItem.id,
      quantity_sold: qtyNum,
      unit_price: priceNum,
      payment_method: method,
      item_name: selectedItem.name,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{t("itemSale")}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t("pickItemDesc")}</p>

        {!selectedItem ? (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchInventory")}
              className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-gray-100 mb-3 focus:outline-none focus:ring-2 focus:ring-gray-400"
              autoFocus
            />
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filtered.map((item) => {
                const itemQty = parseFloat(item.quantity) || 0;
                const isEmpty = itemQty <= 0;
                return (
                  <button
                    key={item.id}
                    disabled={isEmpty}
                    onClick={() => {
                      if (isEmpty) return;
                      setSelectedItem(item);
                      const ippu = parseFloat(item.pieces_per_unit || 0);
                      const iHasConv = item.sell_unit && ippu > 0 && item.sell_unit !== item.unit;
                      if (item.sell_price) {
                        setPrice(iHasConv ? String(Math.round((parseFloat(item.sell_price) / ippu) * 100) / 100) : String(parseFloat(item.sell_price)));
                      }
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg transition flex items-center justify-between ${
                      isEmpty
                        ? "opacity-50 cursor-not-allowed bg-gray-50 dark:bg-gray-800/40"
                        : "hover:bg-gray-50 dark:hover:bg-gray-800/60"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{item.category} · {t("cost")}: <Amount value={parseFloat(item.cost_per_unit)} currency={currency} decimals={2} />/{item.unit}</p>
                    </div>
                    <div className="text-right">
                      {isEmpty ? (
                        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t("restockFirst", "Restock first")}</p>
                      ) : (
                        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                          {item.sell_unit && parseFloat(item.pieces_per_unit || 0) > 0 && item.sell_unit !== item.unit
                            ? `${Math.floor(itemQty * parseFloat(item.pieces_per_unit))} ${item.sell_unit}`
                            : `${itemQty} ${item.unit}`}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p className="text-center text-gray-400 py-4 text-sm">{t("noItemsWithStock")}</p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="bg-gray-50 dark:bg-gray-800/60 p-3 rounded-lg mb-4 border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">{selectedItem.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t("cost")}: <Amount value={cost} currency={currency} decimals={2} />/{sellUnit} · {t("stock")}: {Math.floor(available)} {sellUnit}
                    {hasConversion && <span className="ml-1 text-gray-400">({parseFloat(selectedItem.quantity)} {selectedItem.unit})</span>}
                  </p>
                </div>
                <button onClick={() => { setSelectedItem(null); setQty(""); setPrice(""); }} className="text-xs text-gray-700 dark:text-gray-300 hover:underline">{t("change")}</button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{t("quantity")} ({sellUnit})</label>
                <input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="0"
                  max={available}
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  autoFocus
                />
                {qtyNum > available && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">{Math.floor(available)} {sellUnit}</p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{t("sellPrice")} ({currency}/{sellUnit})</label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-4">
              {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`px-3 py-2 rounded-full text-xs font-medium border transition ${
                    method === m
                      ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                      : "bg-white border-gray-200 dark:bg-gray-900 dark:border-gray-700 text-gray-700 dark:text-gray-300"
                  }`}
                >
                  {t(m)}
                </button>
              ))}
            </div>

            {qtyNum > 0 && priceNum > 0 && (
              <div className="bg-gray-50 dark:bg-gray-800/60 p-3 rounded-lg mb-4 space-y-1 border border-gray-200 dark:border-gray-700">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">{t("total")}</span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100"><Amount value={total} currency={currency} /></span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">{t("cost")}</span>
                  <span className="text-gray-700 dark:text-gray-300"><Amount value={qtyNum * cost} currency={currency} /></span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400">{t("profit")}</span>
                  <span className={`font-semibold ${profit >= 0 ? "text-gray-900 dark:text-gray-100" : "text-red-600 dark:text-red-400"}`}>
                    <Amount value={profit} currency={currency} sign />
                  </span>
                </div>
                {cost > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500 dark:text-gray-400">{t("margin")}</span>
                    <span className="text-gray-700 dark:text-gray-300">{Math.round(((priceNum - cost) / cost) * 100)}%</span>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="secondary" onClick={onClose} className="flex-1">
                {t("cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={!qtyNum || !priceNum || qtyNum > available}
                className="flex-1"
              >
                {t("sell")} {total > 0 ? `(${formatOwnerMoney(total, currency)})` : ""}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * CsvUpload — three-step flow with preview + undo to prevent corrupted imports.
 *
 *   1. Pick file → POST with dry_run=true → backend returns parsed preview
 *   2. User reviews rows + warnings, clicks "Confirm import"
 *   3. POST with dry_run=false → backend commits and returns imported_ids
 *   4. Undo banner stays visible for 5 min — clicking calls /import-csv/rollback
 *      which soft-deletes the sales (server enforces 5-min cutoff + tenant filter)
 */
function CsvUpload({ onDone }) {
  const { t } = useLanguage();
  const [pendingFile, setPendingFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rolledBack, setRolledBack] = useState(false);

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPendingFile(file);
    setResult(null);
    setRolledBack(false);
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await api.post("/sales/import-csv?dry_run=true", formData);
      setPreview(res.data);
    } catch (err) {
      setPreview({ would_import: 0, errors: [errText(err, t("uploadFailed"))] });
    }
    setUploading(false);
    e.target.value = "";
  };

  const confirmImport = async () => {
    if (!pendingFile) return;
    setConfirming(true);
    const formData = new FormData();
    formData.append("file", pendingFile);
    try {
      const res = await api.post("/sales/import-csv", formData);
      setResult(res.data);
      setPreview(null);
      setPendingFile(null);
      onDone();
    } catch (err) {
      setResult({ imported: 0, errors: [errText(err, t("uploadFailed"))], imported_ids: [] });
    }
    setConfirming(false);
  };

  const cancelPreview = () => {
    setPreview(null);
    setPendingFile(null);
  };

  const undoImport = async () => {
    const ids = result?.imported_ids || [];
    if (!ids.length) return;
    try {
      await api.post("/sales/import-csv/rollback", { sale_ids: ids });
      setRolledBack(true);
      setResult(null);
      onDone();
    } catch (err) {
      console.warn("Rollback failed:", err);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t("importCsv")}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("csvColumns")}</p>
        </div>
        <label className={`px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition ${
          uploading
            ? "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
            : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
        }`}>
          {uploading ? t("uploading") : t("chooseFile")}
          <input type="file" accept=".csv" onChange={handleFile} className="hidden" disabled={uploading || confirming || preview} />
        </label>
      </div>

      {/* Preview step — user must explicitly confirm before any DB write */}
      {preview && !result && (
        <div className="mt-4 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 rounded-xl p-3">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t("preview", "Preview")} — {preview.would_import || 0} {t("salesWillBeImported", "sales will be imported")}
          </p>
          {preview.preview && preview.preview.length > 0 && (
            <div className="overflow-x-auto max-h-56 overflow-y-auto rounded border border-gray-200 dark:border-gray-700 mb-2 bg-white dark:bg-gray-900">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-900/80 sticky top-0">
                  <tr>
                    <th className="text-left p-2 font-semibold text-gray-500 dark:text-gray-400">{t("date")}</th>
                    <th className="text-right p-2 font-semibold text-gray-500 dark:text-gray-400">{t("amount")}</th>
                    <th className="text-left p-2 font-semibold text-gray-500 dark:text-gray-400">{t("payment")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.map((row, i) => (
                    <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="p-2 text-gray-700 dark:text-gray-300">{row.date}</td>
                      <td className="p-2 text-right font-medium text-gray-900 dark:text-gray-100 tabular-nums">{Number(row.amount).toLocaleString()}</td>
                      <td className="p-2 text-gray-500 dark:text-gray-400">{row.payment_method}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.preview_truncated && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
              {t("showingFirst50", "Showing first 50 rows.")} {preview.would_import - 50} {t("moreWillBeImported", "more will be imported.")}
            </p>
          )}
          {preview.errors?.length > 0 && (
            <details className="mb-2">
              <summary className="text-xs text-amber-600 dark:text-amber-400 cursor-pointer font-medium">
                {preview.errors.length} {t("rowsWillBeSkipped", "rows will be skipped")}
              </summary>
              <ul className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 space-y-0.5 max-h-24 overflow-y-auto">
                {preview.errors.slice(0, 20).map((err, i) => <li key={i}>{err}</li>)}
                {preview.errors.length > 20 && <li>… {t("andNMore", "and {n} more", { n: preview.errors.length - 20 })}</li>}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={cancelPreview} disabled={confirming}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={confirmImport}
              disabled={confirming || !preview.would_import}
              busy={confirming}
            >
              {confirming ? t("importing", "Importing…") : `${t("confirmImport", "Confirm import")} (${preview.would_import})`}
            </Button>
          </div>
        </div>
      )}

      {/* Post-commit result with Undo */}
      {result && (
        <div className="mt-3 text-sm">
          {result.imported > 0 && !rolledBack && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700">
              <div>
                <p className="text-gray-900 dark:text-gray-100 font-medium">
                  {result.imported} {t("salesImported")}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t("undoAvailable5min", "Undo available for 5 minutes")}</p>
              </div>
              {result.imported_ids?.length > 0 && (
                <Button variant="secondary" size="sm" onClick={undoImport}>
                  {t("undo", "Undo")}
                </Button>
              )}
            </div>
          )}
          {rolledBack && (
            <p className="text-amber-600 dark:text-amber-400 font-medium px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700">
              {t("importUndone", "Import undone — sales removed.")}
            </p>
          )}
          {result.errors?.length > 0 && (
            <details className="mt-2">
              <summary className="text-amber-600 dark:text-amber-400 cursor-pointer">{result.errors.length} {t("rowsSkipped")}</summary>
              <ul className="mt-1 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                {result.errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}
