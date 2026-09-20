/**
 * CountRitual — the weekly/monthly optælling, one calm line at a time.
 *
 * The hated 60-90 min clipboard chore → ~4 min of confirming exceptions.
 * Because the recipe auto-deduct (G2) keeps a live computed on-hand, BonBox
 * PRE-FILLS its predicted quantity for every item; the owner mostly just taps
 * "Stemmer" and only fixes the few lines that are off. One bulk write at the
 * end via POST /inventory/count/reconcile (G1).
 *
 * Honesty: the pre-filled number is the COMPUTED ("beregnet") on-hand, shown
 * with a confidence dot — never presented as a physical count. The owner's
 * confirmed number is the only thing stored as truth; the reconcile keeps the
 * delta so drift is visible. DK trade terms (optælling, lagerværdi) stay
 * Danish across all UI languages per the terminology lock.
 *
 * Design: full-screen calm sheet, gray-900 + status colours only, Lucide
 * outline icons, rounded-xl, big tap targets ("anyone, one tap"). Enter
 * confirms + advances.
 */
import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Check, X, Plus, Minus, ClipboardCheck, Sparkles, FileText, ArrowRight, RotateCcw,
} from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { useConfirm } from "../hooks/useConfirm";
import { formatKr } from "../utils/currency";
import { saveFile } from "../utils/download";
import { errText } from "../utils/errText";
import {
  saveCountDraft, loadCountDraft, clearCountDraft, reconcileDraftCounts,
} from "../utils/countDraft";

function hasRecipe(it) {
  return !!(it?.consumption_pattern && it?.serving_size && it?.usage_keywords);
}

export default function CountRitual({ open, items = [], onClose, onDone }) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const confirm = useConfirm();

  // Queue = every item, walked in a stable order (category → name). Built once
  // per open so edits to the live list don't reshuffle mid-count.
  const queue = useMemo(
    () =>
      (items || [])
        .slice()
        .sort(
          (a, b) =>
            String(a.category || "").localeCompare(String(b.category || "")) ||
            String(a.name || "").localeCompare(String(b.name || "")),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const [idx, setIdx] = useState(0);
  const [counts, setCounts] = useState({}); // item_id -> counted number
  const [phase, setPhase] = useState("counting"); // counting | saving | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  // How many lines came back from a saved draft. Shown once, then cleared on
  // the first tap — a resume the owner is not told about is indistinguishable
  // from the app inventing numbers on their shelf.
  const [resumed, setResumed] = useState(0);
  // "Hent lagerrapport til revisor" used to be a bare onClick with an empty
  // catch: no spinner, no error, so the one button that hands the count to the
  // accountant looked identical whether it worked or died. Both states now
  // exist.
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState("");
  const inputRef = useRef(null);
  const userId = user?.id;

  useEffect(() => {
    if (open) {
      // Resume before reset, not after: a draft is only worth restoring for
      // items that still exist, so it is filtered against the live list rather
      // than POSTed later as counted lines for rows that were deleted.
      const draft = loadCountDraft(userId);
      const restored = draft ? reconcileDraftCounts(draft.counts, items) : null;
      const n = restored ? Object.keys(restored).length : 0;
      setIdx(n > 0 ? Math.min(draft.idx, Math.max(items.length - 1, 0)) : 0);
      setCounts(n > 0 ? restored : {});
      setResumed(n);
      setPhase("counting");
      setResult(null);
      setError("");
      setReportError("");
    }
    // items is deliberately not a dep: the queue below is also built once per
    // open, and re-running this on every parent refetch would reset a count
    // in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId]);

  // Mirror every keystroke to the device. This is the whole fix for "90 items
  // in, the phone rings, the tab reloads, everything is gone": the counts used
  // to exist only in React state until the single POST at the very end.
  useEffect(() => {
    if (!open || phase !== "counting") return;
    saveCountDraft(userId, { counts, idx });
  }, [open, phase, counts, idx, userId]);

  const cur = queue[idx];
  // Field value: the owner's edit if present, else the AI's computed on-hand.
  const fieldValue =
    cur && counts[cur.id] != null
      ? counts[cur.id]
      : cur
        ? Number(cur.quantity) || 0
        : 0;

  useEffect(() => {
    // Focus the number when the line changes so a keyboard owner can just type.
    if (phase === "counting" && inputRef.current) inputRef.current.select?.();
  }, [idx, phase]);

  if (!open) return null;

  const total = queue.length;
  const remaining = total - idx - 1;

  const setCount = (id, v) => {
    setResumed(0);
    setCounts((c) => ({ ...c, [id]: Math.max(0, Math.round(v * 100) / 100) }));
  };

  /**
   * The X, guarded.
   *
   * The draft is already on the device by the time this runs, so "save" is
   * simply "close without clearing it". The dialog exists because the other
   * branch is unrecoverable, and because an owner who brushes a 36px X while
   * scrolling a list deserves to be asked.
   *
   * Discard is the DESTRUCTIVE (red) answer and save is the cancel, which
   * means Esc, the backdrop and the plain dismiss all land on the safe side.
   * A guard whose accidental path is the lossy one is not a guard.
   */
  const requestClose = async () => {
    const counted = Object.keys(counts).length;
    if (counted === 0) {
      clearCountDraft(userId);
      onClose?.();
      return;
    }
    const discard = await confirm({
      title: t("countLeaveTitle", "You're in the middle of a count"),
      message: t("countLeaveBody", "{n} items counted so far. Save it and pick up where you left off, or throw the count away?")
        .replace("{n}", String(counted)),
      confirmLabel: t("countLeaveDiscard", "Discard the count"),
      cancelLabel: t("countLeaveKeep", "Save for later"),
      destructive: true,
    });
    if (discard) clearCountDraft(userId);
    onClose?.();
  };

  const adjust = (delta) => {
    if (!cur) return;
    setCount(cur.id, fieldValue + delta);
  };

  const advance = (record) => {
    setResumed(0);
    if (cur && record) {
      // Lock in the confirmed count (default = the AI's predicted value).
      setCounts((c) => ({
        ...c,
        [cur.id]: c[cur.id] != null ? c[cur.id] : Number(cur.quantity) || 0,
      }));
    }
    if (idx + 1 < total) setIdx(idx + 1);
    else finish(record ? { [cur.id]: counts[cur.id] != null ? counts[cur.id] : Number(cur.quantity) || 0 } : {});
  };

  async function finish(lastExtra = {}) {
    const merged = { ...counts, ...lastExtra };
    const lines = Object.entries(merged).map(([item_id, counted_qty]) => ({
      item_id,
      counted_qty: Number(counted_qty) || 0,
    }));
    if (!lines.length) {
      clearCountDraft(userId);
      onClose?.();
      return;
    }
    setPhase("saving");
    setError("");
    try {
      const res = await api.post("/inventory/count/reconcile", { lines });
      // Cleared only once the server has the numbers. A failed reconcile below
      // keeps the draft, so a retry after the network comes back still has
      // every line the owner walked the cold room for.
      clearCountDraft(userId);
      setResult(res.data);
      setPhase("done");
      onDone?.(res.data);
    } catch (e) {
      setError(
        e?.response?.data?.detail?.message ||
          e?.response?.data?.detail ||
          t("somethingWentWrong", "Something went wrong"),
      );
      setPhase("counting");
    }
  }

  const progressPct = total ? Math.round(((idx + (phase === "done" ? 1 : 0)) / total) * 100) : 0;

  return createPortal(
    // z above the global AI-assistant launcher (z-9999) so the full-screen
    // count is the top layer — nothing floats over a focused optælling.
    <div className="fixed inset-0 z-[10000] bg-white dark:bg-gray-950 flex flex-col"
         style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-gray-100 dark:border-gray-800">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 shrink-0">
          <ClipboardCheck size={18} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t("countTitle", "Optælling")}
          </div>
          {phase === "counting" && (
            <div className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              {t("countProgress", "Vare {n} af {total}")
                .replace("{n}", String(Math.min(idx + 1, total)))
                .replace("{total}", String(total))}
              {remaining > 0
                ? " · " + t("countRemaining", "{n} tilbage").replace("{n}", String(remaining))
                : ""}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => (phase === "counting" ? requestClose() : onClose?.())}
          aria-label={t("close", "Luk")}
          className="w-9 h-9 rounded-full inline-flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {/* Progress hairline */}
      <div className="h-0.5 bg-gray-100 dark:bg-gray-800">
        <div
          className="h-full bg-gray-900 dark:bg-gray-100 transition-all duration-300"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto flex items-center justify-center px-4 sm:px-6 py-8">
        {phase === "done" ? (
          <div className="w-full max-w-sm text-center">
            <span className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 mb-4">
              <Check size={28} strokeWidth={2} aria-hidden="true" />
            </span>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t("countDoneTitle", "Lager opdateret")}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {(result?.adjusted || 0) === 0
                ? t("countDoneNoChange", "Alt stemte — intet justeret")
                : t("countDoneAdjusted", "{n} varer justeret")
                    .replace("{n}", String(result?.adjusted || 0))}
            </p>
            <div className="mt-5 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t("countStockValue", "Lagerværdi")}
              </span>
              <span className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                {/* `|| 0` turned a payload that never carried stock_value into
                    a confident "0,00 kr." lagerværdi on the screen that exists
                    to state it. Unknown renders "—". */}
                {formatKr(result?.stock_value ?? null)}
              </span>
            </div>
            <button
              type="button"
              disabled={reportBusy}
              aria-busy={reportBusy ? "true" : undefined}
              onClick={async () => {
                setReportBusy(true);
                setReportError("");
                try {
                  const res = await api.get("/inventory/export.pdf", { responseType: "blob" });
                  // saveFile, not a hand-rolled anchor: this file is for the
                  // revisor, and on iOS the old anchor produced nothing at all.
                  const out = await saveFile(res.data, "lagerrapport.pdf", {
                    type: "application/pdf",
                    title: t("countSendRevisor", "Hent lagerrapport til revisor"),
                  });
                  if (!out.ok) {
                    setReportError(t("countReportFailed", "Kunne ikke hente rapporten — prøv igen."));
                  }
                } catch (e) {
                  setReportError(errText(e, t("countReportFailed", "Kunne ikke hente rapporten — prøv igen.")));
                } finally {
                  setReportBusy(false);
                }
              }}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition disabled:opacity-60"
            >
              {reportBusy ? (
                <span
                  className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
              {reportBusy
                ? t("countReportBusy", "Henter rapporten…")
                : t("countSendRevisor", "Hent lagerrapport til revisor")}
            </button>
            {reportError && (
              <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                {reportError}
              </p>
            )}
            <button
              type="button"
              onClick={() => onClose?.()}
              className="mt-2 w-full rounded-xl bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 px-4 py-2.5 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-white transition"
            >
              {t("countCloseDone", "Færdig")}
            </button>
          </div>
        ) : !cur ? (
          <div className="text-center text-sm text-gray-500 dark:text-gray-400">
            {t("countEmpty", "Ingen varer at tælle endnu.")}
          </div>
        ) : (
          <div className="w-full max-w-sm text-center">
            {/* Say that a resume happened. Numbers the owner did not type on
                this run are on screen; pretending they were always there is
                how a restored draft gets mistaken for the app's own guess. */}
            {resumed > 0 && (
              <div className="mb-5 inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-800 px-3 py-2 text-[13px] text-gray-600 dark:text-gray-300">
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" className="text-gray-400 dark:text-gray-500" />
                {t("countResumed", "Fortsætter din optælling — {n} varer var talt")
                  .replace("{n}", String(resumed))}
              </div>
            )}
            {cur.category ? (
              <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                {cur.category}
              </div>
            ) : null}
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 leading-tight">
              {cur.name}
            </h2>
            {/* Confidence — honest about whether the number is a live estimate
                or just the last saved figure. */}
            <div className="mt-2 inline-flex items-center gap-1.5 text-xs">
              <span className={"w-2 h-2 rounded-full " + (hasRecipe(cur) ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600")} />
              <span className="text-gray-500 dark:text-gray-400">
                {hasRecipe(cur)
                  ? t("countAiCounted", "AI har beregnet — bekræft eller ret")
                  : t("countBlind", "Tæl på hylden")}
              </span>
            </div>

            {/* The big number + steppers */}
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => adjust(-1)}
                aria-label={t("countMinus", "Færre")}
                className="w-12 h-12 rounded-full border border-gray-200 dark:border-gray-700 inline-flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
              >
                <Minus size={20} strokeWidth={2} aria-hidden="true" />
              </button>
              <div className="flex items-baseline gap-2">
                <input
                  ref={inputRef}
                  type="number"
                  inputMode="decimal"
                  value={fieldValue}
                  onChange={(e) => setCount(cur.id, parseFloat(e.target.value) || 0)}
                  onKeyDown={(e) => { if (e.key === "Enter") advance(true); }}
                  className="w-28 text-center text-3xl font-semibold tabular-nums bg-transparent text-gray-900 dark:text-gray-100 border-b-2 border-gray-200 dark:border-gray-700 focus:border-gray-900 dark:focus:border-gray-100 outline-none py-1"
                  aria-label={t("countQty", "Antal")}
                />
                <span className="text-base text-gray-500 dark:text-gray-400">{cur.unit}</span>
              </div>
              <button
                type="button"
                onClick={() => adjust(1)}
                aria-label={t("countPlus", "Flere")}
                className="w-12 h-12 rounded-full border border-gray-200 dark:border-gray-700 inline-flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
              >
                <Plus size={20} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            {hasRecipe(cur) ? (
              <div className="mt-2 text-xs text-gray-400 dark:text-gray-500 inline-flex items-center gap-1">
                <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
                {t("countPrefilled", "BonBox foreslog {n} {u}")
                  .replace("{n}", String(Math.round((Number(cur.quantity) || 0) * 100) / 100))
                  .replace("{u}", cur.unit)}
              </div>
            ) : null}

            {error ? (
              <div className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</div>
            ) : null}

            <button
              type="button"
              onClick={() => advance(true)}
              className="mt-7 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 px-4 py-3 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-white transition"
            >
              <Check size={16} strokeWidth={2.5} aria-hidden="true" />
              {remaining > 0 ? t("countConfirmNext", "Stemmer · næste") : t("countConfirmFinish", "Stemmer · afslut")}
            </button>
            <button
              type="button"
              onClick={() => advance(false)}
              className="mt-2 w-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
            >
              {t("countSkip", "Spring over")}
            </button>
          </div>
        )}
      </div>

      {/* Footer — finish early */}
      {phase === "counting" && Object.keys(counts).length > 0 ? (
        <div className="px-4 sm:px-6 py-3 border-t border-gray-100 dark:border-gray-800">
          <button
            type="button"
            onClick={() => finish()}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
          >
            {t("countFinishEarly", "Afslut optælling")}
            <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
