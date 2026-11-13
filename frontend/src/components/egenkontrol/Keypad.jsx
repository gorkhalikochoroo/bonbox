/**
 * The temperature keypad — wet hands at a kitchen counter, so no system
 * keyboard and big keys: every key is at least 64 × 64 px (h-16 min-w-16),
 * the backspace too (in the kitchen's landscape pane: fit, below). 3 × 4 grid
 * [1 2 3 / 4 5 6 / 7 8 9 / − 0 ,].
 *
 * The value is held canonically with a comma ("-3,5"); the decimal key reads
 * "," in Danish and "." in English and the display follows. The rules for the
 * next entry live in ekLogic.nextEntry (unit-tested).
 *
 * NOTHING ABOVE THE KEYS MOVES WHILE TYPING: the display is one fixed row and
 * the "For varmt" / "Inden for grænsen" line is reserved before the first
 * digit (egenkontrol.devicePass.test.jsx).
 *
 * fit="panes" — the kitchen iPad in landscape, where the panel is a pane of
 * fixed height and "Hvem målte?" must fit above the button without scrolling
 * (egenkontrol.kitchenFit.test.jsx): the "For varmt" line sits INSIDE the
 * display box (left of the number, a fixed box, so still nothing moves), the
 * display row is 56 px, and the keys take the height the panel gives them —
 * the --ek-key-h clamp RecordPanel sets: 64 px when there is room, never
 * under 48 px. A browser without container units keeps 64 px keys.
 */
import { Delete } from "lucide-react";
import { haptic } from "../../utils/haptics";
import { displayEntry } from "./ekLogic";

const KEY_LOOK =
  "rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 " +
  "font-display tabular-nums text-[26px] font-semibold text-gray-900 dark:text-gray-50 select-none " +
  "inline-flex items-center justify-center " +
  "active:bg-gray-100 dark:active:bg-gray-800 motion-safe:transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 " +
  "disabled:opacity-50";
const KEY = "h-16 min-w-16 " + KEY_LOOK;
// fit="panes": the panel's clamp where container units work, 64 px elsewhere.
const KEY_FIT = "h-16 supports-[height:1cqh]:h-(--ek-key-h) min-w-16 " + KEY_LOOK;
const BACK_FIT = "h-14 min-w-16 w-16 shrink-0 " + KEY_LOOK;

export default function Keypad({ entry, onKey, lang = "da", t, disabled = false, hint = null, idPrefix = "ek", fit = null }) {
  const panes = fit === "panes";
  const decimal = lang === "da" ? "," : ".";
  const press = (k) => {
    if (disabled) return;
    try { haptic.light(); } catch { /* web: no haptics */ }
    onKey(k);
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "-", "0", ","];
  const shown = displayEntry(entry, lang);
  return (
    <div className="w-full" data-testid="ek-keypad" data-ek-fit={panes ? "panes" : undefined}>
      <div className="flex items-stretch gap-2 mb-2">
        {panes ? (
          <div className="flex-1 min-w-0 h-14 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-4 flex items-center gap-3">
            {/* The "For varmt" line, inside the display: a fixed box left of
                the number; a long line wraps to two lines and is clipped
                there — it can never push anything. */}
            <div className="flex-1 min-w-0 h-full flex items-center text-[15px] leading-5 overflow-hidden" data-testid="ek-keypad-hint" aria-live="polite">
              {hint ? <span className="line-clamp-2">{hint}</span> : null}
            </div>
            <div
              id={`${idPrefix}-keypad-display`}
              className="shrink-0 flex items-center gap-1"
              aria-live="polite"
              data-testid="ek-keypad-display"
            >
              <span className="font-display tabular-nums text-[34px] font-semibold text-gray-900 dark:text-gray-50">
                {shown || "–"}
              </span>
              <span className="font-display text-[20px] text-gray-500 dark:text-gray-400 shrink-0">°C</span>
            </div>
          </div>
        ) : (
        <div
          id={`${idPrefix}-keypad-display`}
          className="flex-1 min-w-0 h-16 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-4 flex items-center justify-end gap-1"
          aria-live="polite"
          data-testid="ek-keypad-display"
        >
          <span className="font-display tabular-nums text-[34px] font-semibold text-gray-900 dark:text-gray-50 truncate">
            {shown || "–"}
          </span>
          <span className="font-display text-[20px] text-gray-500 dark:text-gray-400 shrink-0">°C</span>
        </div>
        )}
        <button
          type="button"
          className={panes ? BACK_FIT : KEY + " w-16 shrink-0"}
          onClick={() => press("back")}
          aria-label={t("ekKeyBackspace")}
          disabled={disabled}
        >
          <Delete className="w-7 h-7" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {/* The hint line is ALWAYS there, one fixed line high, empty until the
          first digit: "7" on a 5 °C fridge must not push the keys down under
          the finger (the second tap then hits the key below — "7,1" became
          "77"). Never let it wrap: a second line would be the same jump. */}
      {panes ? null : (
        <div className="h-6 mb-2 text-[15px] leading-6 truncate" data-testid="ek-keypad-hint" aria-live="polite">
          {hint}
        </div>
      )}
      <div className={"grid grid-cols-3 " + (panes ? "gap-x-2 gap-y-1.5" : "gap-2")} role="group" aria-label={t("ekRecord")} data-testid="ek-keypad-keys">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            className={panes ? KEY_FIT : KEY}
            onClick={() => press(k)}
            disabled={disabled}
            aria-label={k === "-" ? t("ekKeyMinus") : k === "," ? t("ekKeyDecimal") : k}
            data-key={k}
          >
            {k === "-" ? "−" : k === "," ? decimal : k}
          </button>
        ))}
      </div>
    </div>
  );
}
