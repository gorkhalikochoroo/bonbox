// SuggestionCard / LearnedDefaultChip — the ONE quiet "auto-learn" primitive.
//
// This is the standardized home for every "we watched your data, here's what
// we see" moment across BonBox. It enforces the auto-learn doctrine so no
// surface can drift:
//
//   1. SUGGEST, NEVER ACT — the card only PROPOSES. The owner's tap on
//      "Use this" commits it. Money/MOMS/payroll values are NEVER mutated by
//      the card itself; the caller's onAccept does the commit and is expected
//      to write an L7 audit row attributed to the real human.
//   2. ALWAYS REVERSIBLE — if the caller passes onUndo, accepting shows an
//      8-second Undo toast; sticky state offers a Reset.
//   3. HONEST PROVENANCE — a plain-language "why" line ("Baseret på dine
//      sidste 8 uger") and a WORDED confidence band (Sikker / Sandsynlig /
//      Et bud). We never render a raw "87%". No "AI" word, no sparkle-as-
//      drama — an outline Lightbulb, gray/amber only.
//   4. NO SIGNAL → NO SUGGESTION — if there's no honest `provenance` to show,
//      the card renders nothing. A cold account sees the plain default, never
//      a fabricated one.
//
// Plus: negative-feedback suppression. Pass `suppressKey` and three dismissals
// stop the suggestion offering itself (logged to localStorage) — "no" is heard.
//
// Design: gray-900 text, rounded-xl, 1px border, Lucide outline icon. Mirrors
// the Card primitive + useUndoToast + haptic stack already in the app.
import { useMemo, useState } from "react";
import { Lightbulb } from "lucide-react";
import { useLanguage } from "../../hooks/useLanguage";
import { useUndoToast } from "../../hooks/useUndoToast";
import { haptic } from "../../utils/haptics";
import Button from "./Button";

// Worded confidence bands — NEVER a raw percentage.
const CONFIDENCE = {
  sure: { key: "scConfidenceSure", fallback: "Sikker", tone: "text-gray-600 dark:text-gray-300" },
  likely: { key: "scConfidenceLikely", fallback: "Sandsynlig", tone: "text-gray-600 dark:text-gray-300" },
  guess: { key: "scConfidenceGuess", fallback: "Et bud", tone: "text-amber-600 dark:text-amber-400" },
};

const _SUPPRESS_LIMIT = 3;

function _suppressCount(key) {
  if (!key) return 0;
  try {
    return parseInt(localStorage.getItem(`bonbox.suggest.dismissed.${key}`) || "0", 10) || 0;
  } catch {
    return 0;
  }
}
function _bumpSuppress(key) {
  if (!key) return;
  try {
    const n = _suppressCount(key) + 1;
    localStorage.setItem(`bonbox.suggest.dismissed.${key}`, String(n));
  } catch {
    /* private mode — non-fatal */
  }
}

/**
 * <SuggestionCard>
 *   title       — the proposal headline (what we noticed / suggest).
 *   provenance  — REQUIRED plain-language "why" (rule 4: no provenance → null).
 *   confidence  — "sure" | "likely" | "guess" (worded band, never a %).
 *   onAccept    — async; the human tap that commits. Caller owns the write +
 *                 its audit row. Receives nothing; returns when done.
 *   onUndo      — optional async undo → enables the 8s Undo toast.
 *   acceptLabel — defaults to "Brug forslag".
 *   onDismiss   — optional; called when the owner dismisses.
 *   suppressKey — optional; 3 dismissals self-suppress this suggestion.
 *   acceptedMessage — toast text after accept (default "Forslag brugt").
 *   children    — optional extra preview/detail under the provenance line.
 */
export default function SuggestionCard({
  title,
  provenance,
  confidence = "likely",
  onAccept,
  onUndo = null,
  acceptLabel,
  onDismiss = null,
  suppressKey = null,
  acceptedMessage,
  icon = null,
  children = null,
}) {
  const { t } = useLanguage();
  const { show: showUndo, ToastUI } = useUndoToast();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  // Rule 4 — no honest signal, no card. Also respects negative-feedback
  // suppression (computed once on mount).
  const suppressed = useMemo(() => _suppressCount(suppressKey) >= _SUPPRESS_LIMIT, [suppressKey]);
  if (hidden || suppressed || !provenance) return null;

  const band = CONFIDENCE[confidence] || CONFIDENCE.likely;
  const Glyph = icon || Lightbulb;

  const accept = async () => {
    setBusy(true);
    try {
      await onAccept?.();
      haptic.success(); // one calm ceremonial beat
      if (onUndo) {
        showUndo({
          message: acceptedMessage || t("scAccepted", "Forslag brugt"),
          onUndo,
        });
      }
      setHidden(true);
    } catch {
      // Let the caller surface its own error; just release the button.
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    _bumpSuppress(suppressKey);
    onDismiss?.();
    setHidden(true);
  };

  return (
    <>
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden>
            <Glyph className="w-4 h-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            {title && (
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
            )}
            {/* Honest provenance + worded confidence — never a raw %. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-gray-500 dark:text-gray-400">
              <span>{provenance}</span>
              <span aria-hidden>·</span>
              <span className={band.tone}>{t(band.key, band.fallback)}</span>
            </div>
            {children && <div className="mt-2">{children}</div>}
            <div className="mt-2.5 flex items-center gap-2">
              <Button size="sm" variant="primary" busy={busy} onClick={accept}>
                {acceptLabel || t("scUse", "Brug forslag")}
              </Button>
              <button
                type="button"
                onClick={dismiss}
                disabled={busy}
                className="text-[12.5px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-1.5 py-1 rounded-md disabled:opacity-50"
              >
                {t("scDismiss", "Ikke nu")}
              </button>
            </div>
          </div>
        </div>
      </div>
      {ToastUI}
    </>
  );
}

/**
 * <LearnedDefaultChip> — the lightweight inline cousin for reversible,
 * instantly-visible UI state (a sort order, a default tab/range). Because the
 * state is one-tap visible and resettable, it MAY apply on tap without a money
 * red-line. Renders the same honest provenance + a quiet "Nulstil" reset.
 *
 *   label      — what's being suggested ("Sortér efter: Næste op").
 *   provenance — REQUIRED "why" (rule 4).
 *   onAccept   — apply the learned default (sync UI state is fine here).
 *   onReset    — restore the plain default.
 *   active     — whether the learned default is currently applied.
 */
export function LearnedDefaultChip({ label, provenance, onAccept, onReset, active = false }) {
  const { t } = useLanguage();
  if (!provenance) return null; // rule 4
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 pl-2.5 pr-1.5 py-1">
      <Lightbulb className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="text-[12px] text-gray-600 dark:text-gray-300 truncate" title={provenance}>
        {label}
      </span>
      {active ? (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-1.5 py-0.5 rounded-full"
        >
          {t("scReset", "Nulstil")}
        </button>
      ) : (
        <button
          type="button"
          onClick={onAccept}
          className="text-[11px] font-medium text-gray-900 dark:text-gray-100 hover:bg-white dark:hover:bg-gray-800 px-1.5 py-0.5 rounded-full"
        >
          {t("scApply", "Brug")}
        </button>
      )}
    </div>
  );
}
