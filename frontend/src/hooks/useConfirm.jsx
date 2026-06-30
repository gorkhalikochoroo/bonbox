/**
 * useConfirm — the one premium replacement for native window.confirm().
 *
 * Native confirm() renders the browser's "www.bonbox.dk says…" chrome — the
 * single most vibe-coded surface in the app. This gives every destructive
 * action ONE calm, design-system dialog instead: gray-900 / red-600 status
 * colours only, rounded-2xl, Inter, the shared animate-fadeIn beat, full
 * keyboard + backdrop affordances, mobile/notch-aware.
 *
 * Drop-in: it returns a Promise<boolean>, so a native call
 *     if (!confirm("Delete this?")) return;
 * becomes
 *     const confirm = useConfirm();           // once, at component top level
 *     if (!(await confirm("Delete this?"))) return;
 *
 * API — confirm(opts) where opts is a string (message) or:
 *   { title?, message, confirmLabel?, cancelLabel?, destructive? = false }
 * Resolves true on confirm, false on cancel / Esc / backdrop.
 *
 * One <ConfirmProvider> is mounted at the app root (App.jsx), so there is a
 * single dialog instance for the whole app — no per-page modal state.
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
import { AlertTriangle, HelpCircle } from "lucide-react";

import { useLanguage } from "./useLanguage";
import Button from "../components/ui/Button";

const ConfirmContext = createContext(null);

/**
 * useConfirm() → async confirm(opts) : Promise<boolean>.
 * Safe outside the provider (falls back to native confirm) so a stray import
 * can never crash a screen — but the provider is mounted app-wide.
 */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    return (opts) =>
      Promise.resolve(
        window.confirm(typeof opts === "string" ? opts : opts?.message || ""),
      );
  }
  return ctx;
}

export function ConfirmProvider({ children }) {
  const { t } = useLanguage();
  // { opts, resolve } while open, else null.
  const [state, setState] = useState(null);
  const confirmBtnRef = useRef(null);

  const confirm = useCallback((opts) => {
    const o = typeof opts === "string" ? { message: opts } : { ...(opts || {}) };
    return new Promise((resolve) => setState({ opts: o, resolve }));
  }, []);

  const settle = useCallback(
    (result) => {
      setState((cur) => {
        cur?.resolve(result);
        return null;
      });
    },
    [],
  );

  // Keyboard: Esc cancels, Enter confirms. Focus the confirm button on open.
  useEffect(() => {
    if (!state) return undefined;
    confirmBtnRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        settle(true);
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [state, settle]);

  const o = state?.opts || {};
  const destructive = !!o.destructive;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bb-confirm-title"
          >
            <div
              className="absolute inset-0 bg-gray-900/50 backdrop-blur-[2px] animate-fadeIn"
              onClick={() => settle(false)}
            />
            <div
              className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm p-5 sm:p-6 animate-fadeIn"
              style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
            >
              <div className="flex items-start gap-3.5">
                <span
                  className={
                    "shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full " +
                    (destructive
                      ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400"
                      : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300")
                  }
                >
                  {destructive ? (
                    <AlertTriangle className="w-5 h-5" />
                  ) : (
                    <HelpCircle className="w-5 h-5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <h2
                    id="bb-confirm-title"
                    className="text-base font-semibold text-gray-900 dark:text-gray-100"
                  >
                    {o.title || t("dlgConfirmTitle", "Are you sure?")}
                  </h2>
                  {o.message && (
                    <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 leading-relaxed whitespace-pre-line break-words">
                      {o.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  className="w-full sm:w-auto"
                  onClick={() => settle(false)}
                >
                  {o.cancelLabel || t("dlgCancel", "Cancel")}
                </Button>
                <Button
                  ref={confirmBtnRef}
                  variant={destructive ? "danger" : "primary"}
                  size="md"
                  className="w-full sm:w-auto"
                  onClick={() => settle(true)}
                >
                  {o.confirmLabel ||
                    (destructive ? t("dlgDelete", "Delete") : t("dlgConfirm", "Confirm"))}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmContext.Provider>
  );
}
