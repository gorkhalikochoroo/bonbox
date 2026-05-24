import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Claude-style ⌘K command palette.
 *
 * Triggered by ⌘K / Ctrl+K or by clicking the search button in the
 * sidebar / mobile top bar. Modal centered on the screen with a
 * search input + grouped results across:
 *   • Pages — instant client-side filter against the route list
 *   • Sales / Expenses / Inventory / Daily Closes / Khata —
 *     /api/search endpoint, debounced 200ms
 *
 * Keyboard:
 *   ⌘K / Ctrl+K   — open
 *   ESC           — close
 *   ↑ / ↓         — navigate selection
 *   Enter         — open the selected item
 *
 * Touch-friendly:
 *   • Tap a row to navigate
 *   • Tap outside the card to close
 *
 * Recent searches:
 *   • Persisted in localStorage (last 5)
 *   • Shown as quick-access chips when the input is empty
 */
export default function GlobalSearchModal({ open, onClose }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  const [query, setQuery] = useState("");
  const [serverGroups, setServerGroups] = useState([]);  // from /api/search
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [recents, setRecents] = useState(() => {
    try {
      const raw = localStorage.getItem("bonbox_search_recents");
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  // Compact by default; user can expand via the chevron button in the
  // search bar. Persists across opens — once expanded, stays expanded
  // until the user collapses it again.
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("bonbox_search_expanded") === "1";
    } catch { return false; }
  });
  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem("bonbox_search_expanded", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  // ─── Static page list — filtered client-side ───────────────────
  // Source of truth: the routes registered in App.jsx. Each entry has
  // a label key (translated), an icon, and a route. Filtering is just
  // a substring match on the LABEL — fast and good enough for nav.
  const PAGES = useMemo(() => [
    // Search palette labels track the sidebar Option-A rename — owners
    // typing "close" or "floor" find the same page they see in the nav.
    // Keep the legacy keys (dashboard / dailyClose / dailyReport) as
    // secondary aliases so existing muscle memory still works.
    { key: "dashboard", label: t("navHome") || "Home",                icon: "📊", to: "/dashboard", aliases: ["dashboard", "home", "overview"] },
    { key: "sales",     label: t("sales") || "Sales",                 icon: "💰", to: "/sales" },
    { key: "expenses",  label: t("expenses") || "Expenses",           icon: "💸", to: "/expenses" },
    { key: "inventory", label: t("inventory") || "Inventory",         icon: "📦", to: "/inventory" },
    // Today (#150) — the merged daily page. Aliases include the
    // old "Today's Floor" / "Daily Close" terms so typing either
    // muscle-memory phrase still surfaces the right page.
    { key: "today", label: t("navToday") || "Today", icon: "🌙", to: "/daily-close",
      aliases: ["today", "daily close", "close", "end of day", "today's floor", "daily report", "floor", "ops"] },
    { key: "reports",   label: t("navReportsTax") || "Reports & Tax", icon: "📋", to: "/reports", aliases: ["reports", "tax", "books"] },
    { key: "cashbook",  label: t("cashBook") || "Cash Book",         icon: "📒", to: "/cashbook" },
    { key: "cashflow",  label: t("cashFlow") || "Cash Flow",         icon: "📈", to: "/cashflow" },
    { key: "vat",       label: t("vatReport") || "VAT Report",       icon: "🧾", to: "/vat-report" },
    { key: "tax",       label: t("taxAutopilot") || "Tax",           icon: "📑", to: "/tax" },
    { key: "weekly",    label: t("weeklyReport") || "Weekly Report", icon: "📅", to: "/weekly-report" },
    { key: "khata",     label: t("khata") || "Khata",                icon: "📓", to: "/khata" },
    { key: "loans",     label: t("loans") || "Loans",                icon: "💳", to: "/loans" },
    { key: "budget",    label: t("budget") || "Budget",              icon: "🎯", to: "/budgets" },
    { key: "expiry",    label: t("expiry") || "Expiry",              icon: "⏳", to: "/expiry" },
    { key: "waste",     label: t("waste") || "Waste",                icon: "🗑️", to: "/waste" },
    { key: "weather",   label: t("weather") || "Weather",            icon: "🌤️", to: "/weather" },
    { key: "competitors",label: t("competitors") || "Competitors",   icon: "🏪", to: "/competitors" },
    { key: "branches",  label: t("branches") || "Branches",          icon: "🏢", to: "/branches" },
    { key: "team",      label: t("team") || "Team",                  icon: "👥", to: "/team" },
    { key: "subscription",label: t("subscription") || "Subscription",icon: "💎", to: "/subscription" },
    { key: "profile",   label: t("profile") || "Profile",            icon: "⚙️", to: "/profile" },
    { key: "bankImport",label: t("bankImport") || "Bank Import",     icon: "🏦", to: "/bank-import" },
    { key: "personal",  label: t("personal") || "Personal",          icon: "🧑", to: "/personal" },
    { key: "feedback",  label: t("feedback") || "Feedback",          icon: "💬", to: "/feedback" },
  ], [t]);

  const matchedPages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return PAGES
      .filter(p => p.label.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))
      .slice(0, 5);
  }, [PAGES, query]);

  // ─── Server-side groups (sales / expenses / etc) ───────────────
  const fetchServer = useCallback(async (q) => {
    if (!q || q.trim().length < 2) {
      setServerGroups([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/search", { params: { q } });
      setServerGroups(res.data?.groups || []);
    } catch (e) {
      setServerGroups([]);
      // 422 / 429 / 5xx — show a soft toast inside the modal
      const detail = e?.response?.data?.detail
        || (e?.response?.status === 429 ? "Slow down — try again in a moment." : null)
        || (t("searchFailed") || "Search hit a snag. Try again.");
      setError(detail);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Debounce — fire 200ms after the user stops typing
  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchServer(query), 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, fetchServer]);

  // ─── Combined flat result list (for keyboard navigation) ──────
  // Pages first (most-likely intent for ⌘K), then server groups in order.
  const flatResults = useMemo(() => {
    const out = [];
    if (matchedPages.length) {
      for (const p of matchedPages) {
        out.push({
          kind: "page", group: "Pages", icon: p.icon,
          label: p.label, sublabel: p.to, to: p.to,
        });
      }
    }
    for (const g of serverGroups) {
      for (const item of g.items) {
        out.push({
          kind: "entity", group: g.label, icon: item.icon,
          label: item.label, sublabel: item.sublabel,
          amount: item.amount, to: item.link,
        });
      }
    }
    return out;
  }, [matchedPages, serverGroups]);

  // Reset selection whenever results change so we don't point past the end
  useEffect(() => {
    setSelectedIdx(0);
  }, [flatResults.length]);

  // ─── Open / close lifecycle ────────────────────────────────────
  useEffect(() => {
    if (open) {
      // Focus the input on the next tick so the modal is fully rendered
      setTimeout(() => inputRef.current?.focus(), 50);
      // Lock body scroll while open (prevents iOS rubber-band behind modal)
      document.body.style.overflow = "hidden";
    } else {
      // Reset state on close so the next open is clean
      setQuery("");
      setServerGroups([]);
      setError("");
      setSelectedIdx(0);
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const persistRecent = (q) => {
    if (!q || !q.trim()) return;
    const next = [q.trim(), ...recents.filter(r => r !== q.trim())].slice(0, 5);
    setRecents(next);
    try { localStorage.setItem("bonbox_search_recents", JSON.stringify(next)); } catch { /* ignore */ }
  };

  const goTo = (item) => {
    if (!item) return;
    persistRecent(query);
    onClose();
    navigate(item.to);
  };

  // ─── Keyboard handlers ────────────────────────────────────────
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, Math.max(0, flatResults.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = flatResults[selectedIdx];
      if (item) goTo(item);
    }
  };

  if (!open) return null;

  // ─── Render ───────────────────────────────────────────────────
  // Group flatResults back by group for display
  const grouped = flatResults.reduce((acc, item, idx) => {
    const g = acc.find(x => x.label === item.group);
    if (g) g.items.push({ ...item, _idx: idx });
    else acc.push({ label: item.group, items: [{ ...item, _idx: idx }] });
    return acc;
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-start justify-center bg-black/40 backdrop-blur-[2px] px-4 ${
        expanded ? "pt-10 sm:pt-16" : "pt-20 sm:pt-32"
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("globalSearchAria") || "Search BonBox"}
    >
      {/* Modal card.
          Compact by default (max-w-md / 448px wide, capped height
          ~55vh) — feels lightweight when the user just wants to
          jump to a page. Expanded mode (max-w-3xl / 768px, ~85vh)
          is for browsing many results at once. State persists in
          localStorage. The width + height transitions are smooth so
          the toggle feels like a deliberate UI affordance, not a
          jarring jump. */}
      <div
        className={`w-full bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col transition-all duration-200 ease-out ${
          expanded
            ? "max-w-3xl max-h-[85vh]"
            : "max-w-md max-h-[55vh]"
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {/* Search bar */}
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
          <span className="text-gray-400 text-base shrink-0">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder") || "Search sales, expenses, items, pages…"}
            className="flex-1 bg-transparent outline-none text-sm sm:text-base text-gray-800 dark:text-gray-100 placeholder-gray-400"
            autoComplete="off"
            spellCheck="false"
          />
          {loading && (
            <span className="text-[10px] text-gray-400 animate-pulse shrink-0">⏳</span>
          )}
          {/* Expand / collapse toggle — only visible on sm+ where
              the bigger modal actually adds value. On phones the
              modal already fills the available width. */}
          <button
            type="button"
            onClick={toggleExpanded}
            title={expanded
              ? (t("searchCollapse") || "Smaller view")
              : (t("searchExpand") || "Bigger view")}
            aria-label={expanded
              ? (t("searchCollapse") || "Smaller view")
              : (t("searchExpand") || "Bigger view")}
            className="hidden sm:inline-flex items-center justify-center w-6 h-6 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition shrink-0"
          >
            {expanded ? (
              // Collapse (inward arrows)
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 15v4.5M15 15h4.5M15 15l5.25 5.25" />
              </svg>
            ) : (
              // Expand (outward arrows)
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15m11.25 5.25v-4.5m0 4.5h-4.5m4.5 0L15 15m5.25-11.25v4.5m0-4.5h-4.5m4.5 0L15 9" />
              </svg>
            )}
          </button>
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 shrink-0">
            ESC
          </kbd>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto py-2">
          {error && (
            <div className="px-4 py-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 mx-2 rounded">
              ⚠️ {error}
            </div>
          )}

          {/* Empty state — true command-palette style.
              Quick actions on top (one-tap "do something") +
              recent searches OR sample search terms below it.
              Click any quick action → navigate + close modal. */}
          {!query && (
            <div className="px-4 py-3">
              {/* Quick actions — the most-common "I want to do X now"
                  intents. Tap = navigate to the page (which auto-opens
                  the relevant create flow). Matches Notion/Linear UX. */}
              <p className="text-[11px] text-gray-400 uppercase tracking-wider mb-2 font-semibold">
                {t("searchQuickActions", "Quick actions")}
              </p>
              <div className="grid grid-cols-2 gap-1.5 mb-4">
                {[
                  { icon: "💰", label: t("newSaleAction", "New sale"),         to: "/sales?new=1" },
                  { icon: "💸", label: t("newExpenseAction", "New expense"),   to: "/expenses?new=1" },
                  { icon: "🧾", label: t("newInvoiceAction", "New faktura"),   to: "/faktura?new=1" },
                  { icon: "📋", label: t("dailyCloseAction", "Close the day"), to: "/daily-close" },
                  { icon: "📦", label: t("scanReceiptAction", "Scan receipt"), to: "/expenses?scan=1" },
                  { icon: "📤", label: t("sendToAccountantAction", "Send to revisor"), to: "/daily-close" },
                ].map((qa) => (
                  <button
                    key={qa.to + qa.label}
                    onClick={() => { onClose(); navigate(qa.to); }}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/40 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 hover:text-emerald-700 dark:hover:text-emerald-300 text-xs sm:text-sm text-gray-700 dark:text-gray-200 transition text-left"
                  >
                    <span className="text-base shrink-0">{qa.icon}</span>
                    <span className="truncate">{qa.label}</span>
                  </button>
                ))}
              </div>

              {/* Recent searches OR sample queries */}
              <p className="text-[11px] text-gray-400 uppercase tracking-wider mb-2 font-semibold">
                {recents.length
                  ? (t("searchRecent") || "Recent")
                  : (t("searchTryThese") || "Try searching for")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(recents.length ? recents : ["Tuborg", "Hørkram", "Lurpak", "Daily close", "Profile"]).map((r, i) => (
                  <button
                    key={i}
                    onClick={() => setQuery(r)}
                    className="px-2.5 py-1 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs hover:bg-gray-200 dark:hover:bg-gray-600 transition"
                  >
                    {r}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-3">
                {t("searchHint") ||
                  "Tip: search by item name, supplier, customer, or jump to any page."}
              </p>
            </div>
          )}

          {/* Results */}
          {query && !loading && flatResults.length === 0 && !error && (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              <p className="text-2xl mb-2">🔎</p>
              {t("searchNoResults") || "No matches — try a different word."}
            </div>
          )}

          {grouped.map((group) => (
            <div key={group.label} className="mb-2">
              <p className="px-4 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-semibold">
                {group.label}
              </p>
              {group.items.map((item) => (
                <button
                  key={item._idx}
                  onClick={() => goTo(item)}
                  onMouseEnter={() => setSelectedIdx(item._idx)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition ${
                    item._idx === selectedIdx
                      ? "bg-green-50 dark:bg-green-900/20"
                      : "hover:bg-gray-50 dark:hover:bg-gray-700/40"
                  }`}
                >
                  <span className="text-base shrink-0">{item.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                      {item.label}
                    </p>
                    {item.sublabel && (
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                        {item.sublabel}
                      </p>
                    )}
                  </div>
                  {item.amount != null && (
                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-300 shrink-0">
                      {item.amount.toLocaleString("da-DK")}
                    </span>
                  )}
                  {item._idx === selectedIdx && (
                    <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-gray-400 dark:text-gray-500 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 shrink-0">
                      ↵
                    </kbd>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Footer hint — visible on desktop only */}
        <div className="hidden sm:flex items-center gap-3 px-4 py-2 text-[10px] text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/40">
          <span><kbd className="font-mono px-1 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">↑↓</kbd> {t("searchHintNavigate") || "navigate"}</span>
          <span><kbd className="font-mono px-1 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">↵</kbd> {t("searchHintOpen") || "open"}</span>
          <span><kbd className="font-mono px-1 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">esc</kbd> {t("searchHintClose") || "close"}</span>
          <span className="ml-auto">
            <kbd className="font-mono px-1 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">/</kbd>
            {" "}{t("searchHintReopen", "to re-open")}
          </span>
        </div>
      </div>
    </div>
  );
}
