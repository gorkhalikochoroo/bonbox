import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "./BranchSelector";
import { useEntitlements } from "../hooks/useEntitlements";
import { usePillars } from "../hooks/usePillars";
import { useAuth } from "../hooks/useAuth";
import { Icon } from "./ui";
import { NAV_MANIFEST, filterDestinations, isStaffMemberRole } from "../config/navManifest";
import { isNativeApp } from "../utils/platform";
import { errText } from "../utils/errText";

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
// Search-only pages the nav manifest deliberately does NOT own — they're
// reachable sub-pages / personal-mode routes / footer destinations, not owner
// PRIMARY nav entries, so they have no place in the sidebar / More grid. We
// still want ⌘K to find them (it's the highest-intent discovery surface), so
// they're listed here with Lucide icon names + label keys, appended after the
// manifest pages. Mirrors MorePage's MORE_EXTRAS pattern.
const SEARCH_EXTRAS = [
  // Owner-only: /vat-report is the SKAT/MOMS export (VatReportPage → the
  // now-member-denied /api/reports/vat-export). Dropped from ⌘K for staff.
  { to: "/vat-report",    icon: "ClipboardList", labelKey: "vatReport",    aliases: ["vat", "moms report"], ownerOnly: true },
  { to: "/weekly-report", icon: "Calendar",      labelKey: "weeklyReport", aliases: ["weekly", "week"] },
  { to: "/loans",         icon: "Banknote",      labelKey: "loans",        aliases: ["loan", "lån"] },
  { to: "/profile",       icon: "Settings",      labelKey: "profile",      aliases: ["profile", "settings", "account"] },
  { to: "/personal",      icon: "User",          labelKey: "personal",     aliases: ["personal"] },
  { to: "/feedback",      icon: "MessageCircle", labelKey: "feedback",     aliases: ["feedback", "support"] },
];

export default function GlobalSearchModal({ open, onClose }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isStaffMember = isStaffMemberRole(user?.role);
  const { branchType, businessTypes } = useBranch();
  const { hasFeature, isReady: entReady } = useEntitlements();
  // RELEVANCE axis (C9 + C10). ⌘K is the highest-intent discovery surface, so
  // a page whose pillar is OFF must NEVER vanish from search (that would make
  // a real capability un-findable). We deliberately do NOT pass hiddenPillars
  // into filterDestinations — instead we keep the page visible and tag it
  // `pillarOff` so C10 renders the "Slået fra — tryk Enter for at slå til"
  // enable-action treatment: Enter (or tap) re-enables the pillar via
  // setPillarHidden, THEN navigates to the now-live page (no PillarGate
  // bounce). setPillarHidden is the optimistic toggle from the pillar context.
  const { hiddenPillars, setPillarHidden } = usePillars();
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Owner's enabled vertical modules — keeps any module-gated page (Bar /
  // Wine) out of search results for owners who haven't opted in, matching
  // the sidebar / More page. Fetched only while the palette is open (it's a
  // lazy modal); empty Set = strict default until /api/modules resolves.
  const [enabledModules, setEnabledModules] = useState(() => new Set());
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.get("/modules")
      .then((res) => {
        if (cancelled) return;
        const enabledIds = (res.data?.modules || [])
          .filter((m) => m.enabled)
          .map((m) => m.id);
        setEnabledModules(new Set(enabledIds));
      })
      .catch(() => { /* silent — strict default */ });
    return () => { cancelled = true; };
  }, [open]);

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

  // ─── Static page list — MANIFEST-DRIVEN ────────────────────────
  // Source of truth: config/navManifest.js (entries whose `surfaces`
  // includes 'search'). filterDestinations applies the same three
  // visibility axes the sidebar / More page use, so search never offers
  // a page the account can't reach for product-fit reasons — while
  // KEEPING tier-locked pages (e.g. Reservations) visible-but-locked, the
  // UpgradeNudge funnel. Icons are Lucide NAMES rendered via <Icon>; the
  // legacy emoji page-icons are gone (server-result rows keep their own
  // emoji from /api/search, distinguished by `kind` at render time).
  //
  // hiddenPillars (C9): NOT passed into filterDestinations — ⌘K keeps OFF
  // pillars findable (an OFF pillar's page still resolves; the deep-link
  // shows the PillarGate interstitial). We tag matching rows `pillarOff` so
  // C10 can render the enable-action treatment without re-deriving state.
  const PAGES = useMemo(() => {
    const activeTypes = branchType ? [branchType] : (businessTypes || []);
    const searchItems = NAV_MANIFEST.filter((d) => d.surfaces.includes("search"));
    let resolved = filterDestinations(searchItems, {
      businessTypes: activeTypes,
      enabledModules,
      hasFeature,
      featReady: entReady !== false,
      hiddenPillars: new Set(),
      // Staff members don't get owner-only financial pages (Reports/Tax) in ⌘K.
      isStaffMember,
    });
    // App Store compliance (Apple 3.1.1): the native shell drops locked
    // (purchase-surface) entries; web keeps them locked-but-visible.
    if (isNativeApp()) resolved = resolved.filter((d) => !d.locked);
    const manifestPages = resolved.map((d) => ({
      key: d.to,
      label: t(d.labelKey) || d.labelKey,
      icon: d.icon,            // Lucide name (string) — rendered via <Icon>
      to: d.to,
      locked: !!d.locked,
      // RELEVANCE tag — true when this page's pillar is toggled OFF. Kept
      // visible (per spec), surfaced for the C10 enable-action UX. `pillar`
      // is carried so Enter can re-enable the right pillar before navigating.
      pillar: d.pillar || null,
      pillarOff: !!d.pillar && hiddenPillars.has(d.pillar),
      aliases: d.aliases || [],
    }));
    const extraPages = SEARCH_EXTRAS
      .filter((d) => !d.ownerOnly || !isStaffMember)
      .map((d) => ({
        key: d.to,
        label: t(d.labelKey) || d.labelKey,
        icon: d.icon,
        to: d.to,
        locked: false,
        pillar: null,
        pillarOff: false,
        aliases: d.aliases || [],
      }));
    return [...manifestPages, ...extraPages];
  }, [t, branchType, businessTypes, enabledModules, hasFeature, entReady, hiddenPillars, isStaffMember]);

  const matchedPages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return PAGES
      .filter(p =>
        p.label.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        p.aliases.some((a) => a.toLowerCase().includes(q)))
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
      const detail = errText(e, (e?.response?.status === 429 ? "Slow down — try again in a moment." : null)
        || (t("searchFailed") || "Search hit a snag. Try again."));
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
          label: p.label, sublabel: p.to,
          // Tier-locked page → tapping routes to the upgrade surface
          // (the UpgradeNudge funnel), same as the sidebar / More page.
          to: p.locked ? "/subscription" : p.to,
          locked: p.locked,
          // RELEVANCE enable-action (C10): an OFF-pillar page stays findable.
          // Carry the pillar id + the OFF flag so the row renders the
          // "Slået fra" treatment and Enter re-enables before navigating.
          // (Tier-lock takes precedence — a locked page routes to upgrade;
          // pillarOff only matters for an otherwise-reachable page.)
          pillar: p.pillar || null,
          pillarOff: !p.locked && !!p.pillarOff,
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

  // Tracks an in-flight pillar re-enable (C10 enable-action) so the row can
  // show a busy state. Holds the row's `to` while the PUT is in flight.
  const [enablingTo, setEnablingTo] = useState(null);

  const goTo = async (item) => {
    if (!item) return;
    // C10 enable-action: an OFF-pillar page re-enables its pillar FIRST, then
    // navigates to the now-live page (so the owner lands on the page, never
    // the PillarGate interstitial). Optimistic; setPillarHidden rolls back on
    // error, in which case we still navigate — the deep link then resolves to
    // the PillarGate interstitial, which has its own one-tap re-enable (never
    // a dead end).
    if (item.pillarOff && item.pillar) {
      persistRecent(query);
      setEnablingTo(item.to);
      try {
        await setPillarHidden(item.pillar, false);
      } catch {
        /* fail-soft — fall through to navigation; PillarGate catches it */
      } finally {
        setEnablingTo(null);
      }
      onClose();
      navigate(item.to);
      return;
    }
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
        className={`w-full bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col transition-all duration-200 ease-out ${
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
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/40 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-700 dark:hover:text-gray-300 text-xs sm:text-sm text-gray-700 dark:text-gray-200 transition text-left"
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
                      ? "bg-gray-50 dark:bg-gray-800/50"
                      : "hover:bg-gray-50 dark:hover:bg-gray-700/40"
                  } ${item.locked || item.pillarOff ? "opacity-60" : ""}`}
                >
                  {/* Page rows render Lucide glyphs via the <Icon> registry
                      (manifest icon = a string name); a locked page shows the
                      Lock glyph. An OFF-pillar page (enable-action, C10) keeps
                      its own icon but spins a Loader while re-enabling. Server-
                      result (entity) rows keep their emoji from /api/search. */}
                  {item.kind === "page" ? (
                    <span className="shrink-0 text-gray-700 dark:text-gray-300">
                      <Icon
                        name={item.locked ? "Lock" : (enablingTo === item.to ? "Loader" : item.icon)}
                        size={18}
                        strokeWidth={1.75}
                        className={enablingTo === item.to ? "animate-spin" : ""}
                      />
                    </span>
                  ) : (
                    <span className="text-base shrink-0">{item.icon}</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                      {item.label}
                    </p>
                    {/* OFF-pillar rows replace the route sublabel with the
                        enable-action hint so the row reads as "turn this on",
                        not "go here". Per spec: NEVER let ⌘K return empty for a
                        real BonBox capability. */}
                    {item.pillarOff ? (
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">
                        {t("pillarSearchEnableHint")}
                      </p>
                    ) : item.sublabel && (
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
                  {/* OFF-pillar suffix chip — "Slået fra". Muted, quiet, so it
                      reads as a state badge, not a CTA. */}
                  {item.pillarOff && (
                    <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700/60 rounded shrink-0">
                      {t("pillarSearchOffChip")}
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
