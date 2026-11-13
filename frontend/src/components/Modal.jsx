/**
 * Modal — the legacy dialog, now a THIN WRAPPER over ui/Sheet.
 *
 * What it already had, and keeps: a height cap (max-h-[90vh]) and a scrolling
 * body. That is worth stating plainly, because it is exactly what the
 * ShiftModal finding was about and exactly what Modal did NOT share — those
 * five dialogs were never the broken shape.
 *
 * What it gained, and what the five call sites inherit for free: the portal
 * (a transformed ancestor could clip the old card), Escape, role="dialog" +
 * aria-modal, a focus trap, the bottom-sheet geometry on a phone, the
 * save/restore body scroll lock, the software-keyboard inset, and a labelled
 * Lucide X in place of a bare `×` text glyph.
 *
 * The public props are unchanged (open / onClose / title / children) so none
 * of the five call sites — the phone "+" quick-add, Snap-a-receipt, smart
 * sale, market comparison, the Team confirm — needed editing.
 *
 * Pinned footer (13 Nov 2026): optional `footer`. When given, it sits under
 * the scrolling body, always in view, and takes over the safe-area padding.
 * Without it nothing changes — children own their action row and it scrolls
 * with the body, as before. The phone "+" quick-add uses it so its save
 * button no longer drops below the fold.
 */
import Sheet from "./ui/Sheet";
import Icon from "./ui/Icon";
import { useLanguage } from "../hooks/useLanguage";

export default function Modal({ open, onClose, title, children, footer }) {
  const { t } = useLanguage();

  if (!open) return null;

  return (
    <Sheet
      onClose={onClose}
      // z-50 preserved from the hand-rolled card: these dialogs stack under
      // the toast layer exactly as they did before.
      zClassName="z-50"
      ariaLabel={typeof title === "string" ? title : undefined}
      panelClassName="bg-white dark:bg-gray-800 shadow-xl"
    >
      {/* pt-4 on a phone: the Sheet used to open with a grab bar whose padding
          stood in for the header's top margin, and that bar was a dead
          affordance (nothing drags). The spacing it was accidentally supplying
          belongs here, explicitly. */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-6 pt-4 pb-4 sm:pt-5">
        {/* 16px, not text-lg: 18px is not on the locked ramp
            (11/12/13/14/16/21/26–30, no half steps). */}
        <h2 className="text-[16px] font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close", "Close")}
          className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 transition-colors"
        >
          <Icon name="X" size={20} />
        </button>
      </div>
      <div
        data-sheet-body=""
        className="flex-1 overflow-y-auto px-6"
        style={{ paddingBottom: footer ? "1rem" : "calc(1.5rem + env(safe-area-inset-bottom))" }}
      >
        {children}
      </div>
      {footer && (
        <div
          data-sheet-footer=""
          className="shrink-0 px-6 pt-3 border-t border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          {footer}
        </div>
      )}
    </Sheet>
  );
}
