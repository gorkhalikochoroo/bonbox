// One save per card, and it saves THAT card (R9, 27 Oct 2026; rubric R12).
//
// Indstillinger has three cards with fields (Åbningstider, Booking-regler,
// SMS) and each has its own Gem. Two things made that unclear on a phone:
//   • every save re-applied the whole settings answer, so changing the hours
//     and then pressing the rules' Gem quietly put the hours back — the
//     owner thought one Gem saved the page (the page now re-syncs only the
//     card that was saved);
//   • the rules' Gem sat about two screens below its first fields.
// So a card with changes says "Ikke gemt endnu" beside its Gem, and on a
// phone that row sticks to the bottom of the screen while the card is on
// screen — above the tab bar, the same clearance as the toasts. It rests at
// the card's end otherwise. No transform on the sticky row (iOS wobble).
import { Check } from "lucide-react";
import Button from "../ui/Button";

const STUCK =
  " max-sm:sticky max-sm:z-10 max-sm:bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))]" +
  " max-sm:-mx-4 max-sm:px-4 max-sm:py-2 max-sm:bg-white max-sm:dark:bg-[rgb(var(--surface-card))]" +
  " max-sm:border-t max-sm:border-gray-100 max-sm:dark:border-gray-800";

export default function CardSaveBar({
  t,
  dirty = false,
  saved = false,
  busy = false,
  onSave,
  // true inside a <form>: the button submits it (Enter in a field saves too).
  submit = false,
  testId,
}) {
  return (
    <div
      data-testid={testId}
      data-dirty={dirty ? "true" : "false"}
      className={"flex items-center justify-end gap-3 pt-1" + (dirty ? STUCK : "")}
    >
      {dirty && !busy && (
        <span role="status" className="mr-auto sm:mr-0 text-xs text-gray-600 dark:text-gray-300">
          {t("rsvpCardUnsaved", "Not saved yet")}
        </span>
      )}
      {saved && !dirty && (
        <span className="text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
          <Check className="w-3.5 h-3.5" aria-hidden /> {t("rsvpSaved", "Saved")}
        </span>
      )}
      <Button
        type={submit ? "submit" : "button"}
        variant="primary"
        size="lg"
        busy={busy}
        onClick={submit ? undefined : onSave}
      >
        {t("save", "Save")}
      </Button>
    </div>
  );
}
