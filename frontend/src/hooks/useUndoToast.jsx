/**
 * useUndoToast — tiny toast hook for "we just saved this — undo?".
 *
 * Why this exists:
 *   Smart-card "Save" buttons silently overwrite settings (open days,
 *   role targets, terminals, inventory consumption metadata). A
 *   slipped tap would be hard to recover from — the owner would have
 *   to manually un-do across many fields. This gives them an 8-second
 *   "actually no" window after every smart save.
 *
 * Pattern:
 *   const { show: showUndo, ToastUI } = useUndoToast();
 *   ...
 *   await api.put(...savePayload);
 *   showUndo({
 *     message: t("smartStaffingSaved"),
 *     onUndo: async () => { await api.put(...previousPayload); },
 *   });
 *   ...
 *   return (<>{...content}{ToastUI}</>);
 *
 * Multi-layer:
 *   • Undo handler is awaited so a failed undo surfaces an error.
 *   • If onUndo throws, the toast stays up showing the error so the
 *     user knows the undo didn't take effect.
 *   • Auto-dismiss after 8s — short enough not to clutter, long enough
 *     for a "wait, that wasn't right" reaction.
 */
import { useCallback, useRef, useState } from "react";
import { errText } from "../utils/errText";
import { useLanguage } from "./useLanguage";

const DEFAULT_TIMEOUT_MS = 8000;

export function useUndoToast() {
  // The action label was hardcoded English while `undo` and `dismiss` had DK
  // translations sitting unused — so a Danish owner read "Undo" in an
  // otherwise Danish UI, on the one control they reach for when something has
  // just gone wrong.
  const { t } = useLanguage();
  const [toast, setToast] = useState(null);  // { message, onUndo, error?, undoing? } | null
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
  }, []);

  const show = useCallback(({ message, onUndo, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, onUndo, error: null, undoing: false });
    timerRef.current = setTimeout(() => setToast(null), timeoutMs);
  }, []);

  const handleUndo = useCallback(async () => {
    if (!toast?.onUndo) { dismiss(); return; }
    setToast((prev) => prev ? { ...prev, undoing: true } : null);
    try {
      await toast.onUndo();
      dismiss();
    } catch (err) {
      const msg = errText(err, t("undoFailed"));
      setToast((prev) => prev ? { ...prev, undoing: false, error: msg } : null);
      // Keep it up a little longer so they can read the error.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setToast(null), 6000);
    }
  }, [toast, dismiss, t]);

  const ToastUI = toast ? (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-md w-[90vw] sm:w-auto px-4 py-3 rounded-xl bg-gray-900 text-white shadow-sm flex items-center gap-3"
    >
      <span className="text-sm flex-1 min-w-0">
        {toast.error
          ? <span className="text-red-300">{toast.error}</span>
          : <>✓ {toast.message}</>}
      </span>
      {!toast.error && (
        <button
          type="button"
          onClick={handleUndo}
          disabled={toast.undoing}
          className="text-sm font-semibold text-gray-300 hover:text-gray-200 disabled:opacity-50 underline-offset-2 hover:underline"
        >
          {toast.undoing ? "…" : t("undo")}
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        className="text-gray-400 hover:text-white text-xs"
        aria-label={t("dismiss")}
      >
        ×
      </button>
    </div>
  ) : null;

  return { show, dismiss, ToastUI };
}
