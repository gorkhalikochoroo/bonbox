/**
 * useToast — the one premium replacement for native window.alert().
 *
 * Native alert() renders the browser's "www.bonbox.dk says…" chrome, exactly
 * like confirm() does, and components/ui/index.js:26 already bans it. But
 * where confirm() had useConfirm() to replace it, alert() had nothing — so 20
 * call sites kept using it as the app's error channel. This is the missing
 * half of that pair.
 *
 * Deliberately NOT a drop-in for alert(): alert() BLOCKS the JS thread until
 * dismissed and a toast does not. That difference is the point — a failed
 * "mark paid" should not freeze the till at 22:30 — but it means every
 * conversion has to be read, not sed'd. Two places relied on the block:
 * FakturaPage's send-success (alert ran BEFORE onChanged()) and
 * CompetitorPage's scan-success (closeScanModal() had already run). Both are
 * safe here only because this provider is mounted ONCE at the App root, so a
 * parent refetch unmounting the caller cannot take the message with it.
 *
 * API — toast(opts) where opts is a string (message) or:
 *   { message, severity? = "info", action? }
 *     severity: info | success | warn | notice | critical
 *     action:   { label, onClick } — one button that fixes the cause (e.g.
 *               "Bekræft nu" on a refused send). Tapping it runs onClick
 *               and closes the toast; a toast with an action stays up
 *               longer, since it asks the owner to do something.
 *
 * Messages STACK rather than replace. WineListPage's handleSaveAll loops
 * handleSave, so N failing rows used to mean N stacked blocking dialogs; with
 * a single-slot toast they would silently overwrite each other and a
 * multi-row failure would surface as one message. Stacking keeps every
 * failure visible.
 *
 * One <ToastProvider> is mounted at the app root (App.jsx) next to
 * ConfirmProvider — a single instance for the whole app, no per-page state.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

const ToastContext = createContext(null);

/** How long each severity stays up. Errors carry text worth reading twice. */
const LIFETIME_MS = { info: 4000, success: 4000, warn: 6000, notice: 6000, critical: 7000 };
/** A toast that asks for a tap needs time to be read AND reached. */
const ACTION_LIFETIME_MS = 12000;

/**
 * useToast() → toast(opts).
 * Safe outside the provider, mirroring useConfirm(): a stray import can never
 * crash a screen. It falls back to console rather than alert() — falling back
 * to the very dialog this replaces would defeat the ban, and the provider is
 * mounted app-wide so this path is effectively test-only.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return (opts) => {
      const msg = typeof opts === "string" ? opts : opts?.message || "";
      // eslint-disable-next-line no-console
      console.warn("[toast, no provider]", msg);
    };
  }
  return ctx;
}

const SEVERITY = {
  info: { Icon: Info, cls: "text-gray-500 dark:text-gray-400" },
  success: { Icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400" },
  warn: { Icon: AlertTriangle, cls: "text-amber-600 dark:text-amber-400" },
  // A warning said in ink — for screens where amber already means something
  // (on the reservations book amber is a request waiting for an answer).
  notice: { Icon: AlertTriangle, cls: "text-gray-700 dark:text-gray-300" },
  critical: { Icon: AlertTriangle, cls: "text-red-600 dark:text-red-400" },
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  // Monotonic id — Date.now() collides when two failures land in the same ms,
  // which is exactly what handleSaveAll's loop produces.
  const nextId = useRef(1);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setItems((cur) => cur.filter((x) => x.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (opts) => {
      const o = typeof opts === "string" ? { message: opts } : { ...(opts || {}) };
      const message = String(o.message ?? "").trim();
      if (!message) return;
      const severity = SEVERITY[o.severity] ? o.severity : "info";
      const action =
        o.action && o.action.label && typeof o.action.onClick === "function"
          ? { label: String(o.action.label), onClick: o.action.onClick }
          : null;
      const id = nextId.current++;
      setItems((cur) => [...cur, { id, message, severity, action }]);
      timers.current.set(
        id,
        setTimeout(
          () => dismiss(id),
          action ? Math.max(LIFETIME_MS[severity], ACTION_LIFETIME_MS) : LIFETIME_MS[severity],
        ),
      );
    },
    [dismiss],
  );

  // Clear every pending timer on unmount so a provider swap (tests, HMR)
  // cannot fire setState against a torn-down tree.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((tm) => clearTimeout(tm));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {typeof document !== "undefined" &&
        items.length > 0 &&
        createPortal(
          <div
            // Sits ABOVE the mobile tab bar (h-14 + its safe-area padding);
            // 4.5rem is the same clearance the old support chip used. Desktop
            // has no tab bar, so it drops to the normal bottom margin.
            className="fixed left-0 right-0 z-[60] flex flex-col items-center gap-2 px-4 pointer-events-none"
            style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
          >
            {items.map(({ id, message, severity, action }) => {
              const { Icon, cls } = SEVERITY[severity];
              return (
                <div
                  key={id}
                  // critical uses role=alert so a screen reader interrupts;
                  // the calmer severities announce politely.
                  role={severity === "critical" ? "alert" : "status"}
                  aria-live={severity === "critical" ? "assertive" : "polite"}
                  className="pointer-events-auto w-full max-w-sm animate-fadeIn flex items-start gap-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-3 shadow-lg"
                >
                  <Icon size={16} className={`shrink-0 mt-0.5 ${cls}`} aria-hidden="true" />
                  <p className="flex-1 text-sm text-gray-900 dark:text-gray-100 leading-snug">
                    {message}
                  </p>
                  {action && (
                    <button
                      type="button"
                      onClick={() => {
                        dismiss(id);
                        action.onClick();
                      }}
                      className="shrink-0 -my-0.5 px-2.5 py-1 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-[13px] font-medium hover:bg-gray-700 dark:hover:bg-white transition"
                    >
                      {action.label}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => dismiss(id)}
                    className="shrink-0 -mr-1 -mt-1 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition"
                    aria-label="Dismiss"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}
