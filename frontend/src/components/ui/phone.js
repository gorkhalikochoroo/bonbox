/**
 * Phone-only class tokens (< 640px). Every token is max-sm:-scoped, so
 * tablet and desktop never see them.
 *
 * `min-h-0!` releases index.css's coarse-pointer 44px floor. That rule is
 * unlayered and beats any plain utility, so a bare `max-sm:h-10` on a
 * button still measures 44px on a phone. Same pattern ReservationsPage's
 * PHONE_TOOL / PHONE_ACTION already ship.
 */
// A 40px control that keeps its own text size (e.g. a 14px header button).
export const PHONE_H40 = "max-sm:h-10 max-sm:min-h-0!";
// A 40px control with a 13px label: the phone control size (27-Sep rule).
export const PHONE_CTRL = "max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]";
// A 40x40 icon-only button (overflow "…", period arrows). gap-0 because
// Button always renders an (empty) label <span>, which otherwise takes
// Button's gap-2 and pushes the icon off-centre.
export const PHONE_ICON40 =
  "max-sm:h-10 max-sm:w-10 max-sm:min-h-0! max-sm:px-0 max-sm:gap-0";
// Put on a GRID of StatCards: on a phone the grid itself becomes the one
// card and the tiles become its cells (StatCard `strip`).
export const PHONE_STRIP =
  "max-sm:gap-0 max-sm:overflow-hidden max-sm:rounded-xl max-sm:border " +
  "max-sm:border-[rgb(var(--surface-line))] max-sm:bg-[rgb(var(--surface-card))]";
// An empty state that is one line on a phone: icon + sentence, left-aligned.
export const PHONE_EMPTY_LINE =
  "max-sm:flex max-sm:items-center max-sm:gap-2 max-sm:px-0 max-sm:py-2 " +
  "max-sm:text-left max-sm:text-[13px]";
