/**
 * The temperature keypad — wet hands at a kitchen counter, so no system
 * keyboard and big keys: every key is at least 64 × 64 px (h-16 min-w-16),
 * the backspace too. 3 × 4 grid [1 2 3 / 4 5 6 / 7 8 9 / − 0 ,].
 *
 * The value is held canonically with a comma ("-3,5"); the decimal key reads
 * "," in Danish and "." in English and the display follows. The rules for the
 * next entry live in ekLogic.nextEntry (unit-tested).
 */
import { Delete } from "lucide-react";
import { haptic } from "../../utils/haptics";
import { displayEntry } from "./ekLogic";

const KEY =
  "h-16 min-w-16 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 " +
  "font-display tabular-nums text-[26px] font-semibold text-gray-900 dark:text-gray-50 select-none " +
  "inline-flex items-center justify-center " +
  "active:bg-gray-100 dark:active:bg-gray-800 motion-safe:transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 " +
  "disabled:opacity-50";

export default function Keypad({ entry, onKey, lang = "da", t, disabled = false, hint = null, idPrefix = "ek" }) {
  const decimal = lang === "da" ? "," : ".";
  const press = (k) => {
    if (disabled) return;
    try { haptic.light(); } catch { /* web: no haptics */ }
    onKey(k);
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "-", "0", ","];
  const shown = displayEntry(entry, lang);
  return (
    <div className="w-full">
      <div className="flex items-stretch gap-2 mb-2">
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
        <button
          type="button"
          className={KEY + " w-16 shrink-0"}
          onClick={() => press("back")}
          aria-label={t("ekKeyBackspace")}
          disabled={disabled}
        >
          <Delete className="w-7 h-7" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {hint ? <div className="min-h-6 mb-2 text-[15px] leading-snug">{hint}</div> : null}
      <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("ekRecord")}>
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            className={KEY}
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
