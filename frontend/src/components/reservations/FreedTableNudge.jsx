/**
 * FreedTableNudge — a table may have opened, and someone on the Venteliste
 * fits it (R11, rubric B10).
 *
 * The backend already surfaces the waiting parties that fit when a booking is
 * cancelled, marked no-show or loses its table (`waitlist_matches`, and
 * `/waitlist/matches` for a change seen on another screen). WaitlistSection
 * rings them and says "A spot may have opened" — but inside the Venteliste,
 * under every row of the night: on the door iPad with 38 bookings it was the
 * last thing on the page (20 Oct walk, T8). This card says it where the host
 * is already looking — above the list, the floor and the timeline — and one
 * tap takes them to the Venteliste with the parties ringed, where Giv besked
 * and Book already live.
 *
 * It FLOATS (fixed, over the foot of the page — bottom-left from a tablet
 * up, above the phone's bottom bar on a phone) rather than sitting in the
 * page: in the page it would push the whole night down the moment a table
 * frees on another screen — a layout shift in the middle of service, the
 * thing R11 removes from the door screen (rubric B11). `raised` lifts it on a
 * phone above the drop-in line that floats in the same place.
 *
 * Honest by construction: "kan være blevet ledigt" — a cancel frees a table
 * only maybe (a party may be running over); nothing is held, nobody is
 * messaged. Dismissable; a new freed table brings it back.
 */
import { BellRing, Users, X } from "lucide-react";
import Button from "../ui/Button";
import { guestText } from "../../utils/guestText";

export default function FreedTableNudge({ matches, t, apptWords = false, onShow, onDismiss, raised = false }) {
  const list = Array.isArray(matches) ? matches.filter(Boolean) : [];
  if (!list.length) return null;
  const named = list.filter((m) => m && m.guest_name);
  return (
    <section
      role="status"
      aria-live="polite"
      data-freed-nudge=""
      className={
        "fixed z-50 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-md md:left-5 md:translate-x-0 md:bottom-5 " +
        (raised ? "bottom-[calc(env(safe-area-inset-bottom)+148px)]" : "bottom-[calc(env(safe-area-inset-bottom)+72px)]") +
        " rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line-strong))] bg-white dark:bg-[rgb(var(--surface-raised))] shadow-lg px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2"
      }
    >
      <div className="flex items-start gap-2.5 min-w-0 flex-1 basis-64">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          <BellRing className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {apptWords
              ? t("rsvpFreedTitleAppt", "A time may have opened")
              : t("rsvpFreedTitle", "A table may have opened")}
          </div>
          <div className="text-[13px] text-gray-600 dark:text-gray-300">
            {list.length === 1
              ? t("rsvpFreedFitsOne", "1 on the waitlist fits")
              : t("rsvpFreedFitsN", "{n} on the waitlist fit", { n: list.length })}
          </div>
          {named.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" data-freed-names="">
              {named.slice(0, 3).map((m) => (
                <li
                  key={m.id || m.guest_name}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md bg-gray-100 dark:bg-[rgb(var(--surface-subtle))] text-[12px] font-medium text-gray-800 dark:text-gray-100 tabular-nums max-w-full"
                >
                  <Users className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
                  <span className="truncate">{guestText(m.guest_name)}</span>
                  {m.party_size ? <span>· {m.party_size}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 max-sm:w-full">
        <Button
          size="md"
          variant="secondary"
          onClick={onShow}
          className="max-sm:flex-1 max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px] justify-center"
          data-freed-show=""
        >
          {t("rsvpFreedShow", "See the waitlist")}
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("dismiss", "Dismiss")}
          className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </section>
  );
}
