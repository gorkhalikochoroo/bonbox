import { useState, useEffect, useRef, useCallback } from "react";
import { useLanguage } from "../hooks/useLanguage";

// === ANIMATED COUNTER — Numbers count up on load ===
export function AnimatedCounter({
  value,
  prefix = "",
  suffix = "",
  duration = 800,
  decimals = 0,
  className = "",
}) {
  const [display, setDisplay] = useState(0);
  const startTime = useRef(null);
  const rafId = useRef(null);
  const prevValue = useRef(0);

  useEffect(() => {
    startTime.current = performance.now();
    const startVal = prevValue.current;

    function animate(now) {
      const elapsed = now - startTime.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(startVal + (value - startVal) * eased);

      if (progress < 1) {
        rafId.current = requestAnimationFrame(animate);
      } else {
        prevValue.current = value;
      }
    }

    rafId.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId.current);
  }, [value, duration]);

  const formatted = display.toLocaleString("da-DK", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span className={className}>
      {prefix && <span>{prefix} </span>}
      {formatted}
      {suffix && <span>{suffix}</span>}
    </span>
  );
}

// === SKELETON LOADERS ===
export function SkeletonPulse({ className = "" }) {
  return (
    <div className={`animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700 ${className}`} />
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <SkeletonPulse className="h-3 w-24 mb-3" />
      <SkeletonPulse className="h-8 w-32 mb-2" />
      <SkeletonPulse className="h-3 w-20" />
    </div>
  );
}

export function SkeletonChart({ height = "h-64" }) {
  return (
    <div className={`rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 ${height}`}>
      <SkeletonPulse className="h-4 w-40 mb-4" />
      <div className="flex items-end gap-2 h-3/4">
        {[40, 65, 50, 80, 60, 75, 45, 90, 55, 70].map((h, i) => (
          <SkeletonPulse key={i} className="flex-1 rounded-t-md" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5 }) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <div className="flex gap-4 mb-4">
        <SkeletonPulse className="h-3 w-20" />
        <SkeletonPulse className="h-3 w-32" />
        <SkeletonPulse className="h-3 w-24" />
        <SkeletonPulse className="h-3 w-16 ml-auto" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 py-3 border-t border-gray-50 dark:border-gray-700">
          <SkeletonPulse className="h-3 w-16" />
          <SkeletonPulse className="h-3 w-28" />
          <SkeletonPulse className="h-3 w-20" />
          <SkeletonPulse className="h-3 w-16 ml-auto" />
        </div>
      ))}
    </div>
  );
}

// Shows skeleton while loading, then fades in content
export function SkeletonWrapper({ loading, skeleton, children }) {
  return loading ? skeleton : <div className="animate-fadeIn">{children}</div>;
}

// === TOAST NOTIFICATION SYSTEM ===
export function useToast() {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type = "success", duration = 3000) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type, exiting: false }]);

    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 300);
    }, duration);
  }, []);

  const ToastContainer = () => (
    // Safe-area aware: toasts dodge the notch on iPhone X+/Android punch-holes.
    // max(1rem, env(...)) keeps the existing 16px offset on no-notch devices.
    <div className="fixed right-4 z-50 flex flex-col gap-2 pointer-events-none top-[max(1rem,env(safe-area-inset-top))]">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            pointer-events-auto px-4 py-3 rounded-lg shadow-lg
            flex items-center gap-3 min-w-[280px] max-w-[400px]
            transition-all duration-300 ease-out
            ${toast.exiting ? "opacity-0 translate-x-8" : "opacity-100 translate-x-0 animate-slideIn"}
            ${toast.type === "success"
              ? "bg-emerald-50 dark:bg-emerald-900/90 border border-emerald-200 dark:border-emerald-700 text-emerald-800 dark:text-emerald-100"
              : toast.type === "warning"
              ? "bg-amber-50 dark:bg-amber-900/90 border border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-100"
              : toast.type === "error"
              ? "bg-red-50 dark:bg-red-900/90 border border-red-200 dark:border-red-700 text-red-800 dark:text-red-100"
              : "bg-blue-50 dark:bg-blue-900/90 border border-blue-200 dark:border-blue-700 text-blue-800 dark:text-blue-100"
            }
          `}
        >
          <span className="text-lg">
            {toast.type === "success" && "\u2713"}
            {toast.type === "warning" && "\u26A0"}
            {toast.type === "error" && "\u2715"}
            {toast.type === "info" && "\u2139"}
          </span>
          <span className="text-sm font-medium">{toast.message}</span>
        </div>
      ))}
    </div>
  );

  return { showToast, ToastContainer };
}

// === KEYBOARD SHORTCUTS ===
export function useKeyboardShortcuts(shortcuts) {
  useEffect(() => {
    function handler(e) {
      if (
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.tagName === "SELECT" ||
        e.target.isContentEditable
      ) return;

      const key = e.key.toLowerCase();
      if (shortcuts[key]) {
        e.preventDefault();
        shortcuts[key]();
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts]);
}

export function ShortcutsHelp({ open, onClose }) {
  if (!open) return null;

  const shortcuts = [
    { key: "S", action: "Quick log sale" },
    { key: "E", action: "Go to expenses" },
    { key: "D", action: "Go to dashboard" },
    { key: "I", action: "Go to inventory" },
    { key: "R", action: "Go to reports" },
    { key: "?", action: "Show this help" },
    { key: "Esc", action: "Close modals" },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-[360px] shadow-2xl border border-gray-200 dark:border-gray-700 animate-scaleIn" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl">&times;</button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((s) => (
            <div key={s.key} className="flex items-center justify-between py-1.5">
              <span className="text-sm text-gray-600 dark:text-gray-400">{s.action}</span>
              <kbd className="px-2.5 py-1 text-xs font-mono font-semibold bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-300 shadow-sm">{s.key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// === QUICK SALE MODAL ===
/**
 * Quick Sale modal — log a number fast.
 *
 * MOMS toggle (added 2026-05-24): owner picks whether the typed amount
 * INCLUDES MOMS (gross — typical DK B2C / POS exports) or EXCLUDES
 * MOMS (net — B2B / wholesale). Default = `pricesIncludeMoms` prop
 * from the user's BusinessProfile. Caller's `onSubmit(amount, inclMoms)`
 * receives BOTH values and decides whether to convert before POST.
 *
 * Why pass the choice through instead of converting here: keeps the
 * conversion logic in one place (the parent that knows the user's
 * profile setting), and matches the DailyClosePage pattern of
 * `prices_include_moms_override`.
 */
export function QuickSaleModal({
  open, onClose, onSubmit, currency = "DKK",
  pricesIncludeMoms = true,
}) {
  const { t } = useLanguage();
  const [amount, setAmount] = useState("");
  const [inclMoms, setInclMoms] = useState(pricesIncludeMoms);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
      setAmount("");
      // Reset toggle to the user's profile default each time the modal
      // opens — so a one-off "Excl. MOMS" entry doesn't quietly stick
      // for the next quick sale.
      setInclMoms(pricesIncludeMoms);
    }
  }, [open, pricesIncludeMoms]);

  // Escape closes the modal — standard expectation for any dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function handleSubmit(e) {
    e.preventDefault();
    // Strip all non-numeric chars except decimal comma/period, then parse
    const cleaned = String(amount || "").replace(/\./g, "").replace(/,/g, ".");
    const num = parseFloat(cleaned);
    if (num > 0) {
      onSubmit(num, inclMoms);
      onClose();
    }
  }

  // Toggle button — styled as a segmented control. The two halves are
  // mutually exclusive radio buttons in spirit (clicking one un-selects
  // the other). DK terms locked: "MOMS" uppercase per jurisdiction rule.
  const Pill = ({ active, label, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "flex-1 py-2 px-3 text-sm font-medium rounded-lg transition-colors " +
        (active
          ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 shadow-sm"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800")
      }
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-8 w-[400px] shadow-2xl border border-gray-200 dark:border-gray-700 animate-scaleIn" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
          {t("quickSale") || "Quick Sale"}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          {t("quickSaleSubtitle") || "Log today's revenue in seconds"}
        </p>

        {/* MOMS toggle — two-pill segmented control */}
        <div
          role="group"
          aria-label={t("quickSaleMomsToggleAria") || "MOMS handling"}
          className="flex gap-1 p-1 mb-5 rounded-xl bg-gray-100 dark:bg-gray-800"
        >
          <Pill
            active={inclMoms}
            onClick={() => setInclMoms(true)}
            label={t("quickSaleInclMoms") || "Incl. MOMS"}
          />
          <Pill
            active={!inclMoms}
            onClick={() => setInclMoms(false)}
            label={t("quickSaleExclMoms") || "Excl. MOMS"}
          />
        </div>

        <form onSubmit={handleSubmit}>
          <div className="relative mb-6">
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              // Coerce null/undefined to empty string — prevents the literal
              // "null" or "undefined" string from rendering inside the input
              // when state somehow becomes nullish (focus race, React strict
              // mode double-render, etc.)
              value={amount ?? ""}
              onChange={(e) => setAmount(String(e.target.value || "").replace(/[^0-9.,]/g, ""))}
              placeholder="0"
              className="w-full text-center text-5xl font-bold bg-transparent border-none outline-none text-gray-900 dark:text-white placeholder-gray-300 dark:placeholder-gray-700"
            />
            <div className="text-center text-sm text-gray-400 mt-1">
              {currency === "DKK" ? "kr." : currency}
              <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">
                {inclMoms
                  ? (t("quickSaleHintIncl") || "incl. MOMS")
                  : (t("quickSaleHintExcl") || "excl. MOMS")}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-6">
            {[5000, 8000, 10000, 12000, 15000, 20000].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setAmount(v.toLocaleString("da-DK"))}
                className="py-2 px-3 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-blue-400 transition-colors"
              >
                {v.toLocaleString("da-DK")}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={!amount}
            className="w-full py-3 rounded-xl font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t("quickSaleLogBtn") || "Log Sale"}
          </button>
        </form>
      </div>
    </div>
  );
}

// === PULL TO REFRESH (Mobile) ===
export function PullToRefresh({ onRefresh, children }) {
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const startY = useRef(0);
  const containerRef = useRef(null);
  const threshold = 80;

  function handleTouchStart(e) {
    if (containerRef.current?.scrollTop === 0) {
      startY.current = e.touches[0].clientY;
      setPulling(true);
    }
  }

  function handleTouchMove(e) {
    if (!pulling) return;
    const diff = e.touches[0].clientY - startY.current;
    if (diff > 0) {
      setPullDistance(Math.min(diff * 0.5, 120));
    }
  }

  async function handleTouchEnd() {
    if (pullDistance >= threshold && !refreshing) {
      setRefreshing(true);
      setPullDistance(50);
      await onRefresh();
      setRefreshing(false);
    }
    setPulling(false);
    setPullDistance(0);
  }

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="relative"
    >
      <div
        className="flex items-center justify-center transition-all duration-200 overflow-hidden"
        style={{ height: `${pullDistance}px` }}
      >
        <div
          className={`w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full ${refreshing ? "animate-spin" : ""}`}
          style={{ transform: `rotate(${pullDistance * 3}deg)`, opacity: pullDistance / threshold }}
        />
      </div>
      {children}
    </div>
  );
}
