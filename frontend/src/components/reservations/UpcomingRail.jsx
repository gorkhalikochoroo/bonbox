import React from "react";
import { AlertTriangle } from "lucide-react";
import { fmtTime } from "../../utils/floorState";
import { hasAllergy, UPCOMING_MAX_ROWS } from "../../utils/upcomingArrivals";

/**
 * "Kommende" — who is still to arrive, under the month calendar on desktop.
 *
 * The side column held only the calendar, over an empty strip as tall as the
 * book beside it. A host working from the floor plan sees the room but not the
 * queue; this puts the queue where the eye already goes (easyTable's left
 * column does the same). One tap opens the booking.
 *
 * Signals are words, not only colour: "forsinket" for a party whose time has
 * passed, "skal bekræftes" for a request, and the allergy triangle (red when
 * severe) with an accessible label.
 */
export default function UpcomingRail({
  t,
  rows,
  isToday,
  nowMs,
  tableLabel,
  onOpen,
  onShowAll,
  waitlistCount = 0,
  onOpenWaitlist,
}) {
  const shown = rows.slice(0, UPCOMING_MAX_ROWS);
  const more = rows.length - shown.length;

  return (
    <section
      aria-label={t("rsvpUpcomingTitle", "Coming up")}
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-3"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-[0.06em] text-gray-400 dark:text-gray-500">
          {t("rsvpUpcomingTitle", "Coming up")}
        </span>
        {rows.length > 0 && (
          <span className="text-[11px] tabular-nums text-gray-400 dark:text-gray-500">{rows.length}</span>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="text-[13px] text-gray-500 dark:text-gray-400 py-1">
          {isToday
            ? t("rsvpUpcomingEmpty", "No more arrivals today")
            : t("rsvpUpcomingEmptyDay", "No bookings this day")}
        </p>
      ) : (
        <ul className="-mx-1.5">
          {shown.map((r) => {
            const late = isToday && nowMs != null && new Date(r.starts_at).getTime() < nowMs;
            const table = tableLabel(r);
            const allergy = hasAllergy(r);
            const severe = r.allergy_severity === "severe";
            const note = late
              ? t("rsvpUpcomingLate", "late")
              : r.status === "requested"
                ? t("rsvpAwaitingHelper", "to confirm")
                : null;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  className="w-full grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-baseline gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
                >
                  <span
                    className={
                      "text-[13px] font-semibold tabular-nums " +
                      (late ? "text-amber-700 dark:text-amber-400" : "text-gray-900 dark:text-gray-100")
                    }
                  >
                    {fmtTime(r.starts_at)}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 min-w-0">
                      <span className="truncate text-[13px] text-gray-900 dark:text-gray-100">
                        {r.guest_name || t("rsvpPartyOf", "Party of {n}", { n: r.party_size })}
                      </span>
                      {allergy && (
                        <AlertTriangle
                          className={"w-3 h-3 shrink-0 " + (severe ? "text-red-600 dark:text-red-400" : "text-amber-500 dark:text-amber-400")}
                          aria-label={severe ? t("rsvpSevSevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
                        />
                      )}
                    </span>
                    {note && (
                      <span className="block text-[11px] leading-4 text-amber-700 dark:text-amber-400">{note}</span>
                    )}
                  </span>
                  <span className="text-[11px] tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {r.party_size}
                    {table ? ` · ${table}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {more > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="mt-1 text-[12px] text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none focus-visible:underline"
        >
          {t("rsvpUpcomingMore", "+{n} more", { n: more })}
        </button>
      )}

      {waitlistCount > 0 && (
        <button
          type="button"
          onClick={onOpenWaitlist}
          className="mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800 w-full text-left group focus:outline-none focus-visible:underline"
        >
          <span className="text-[11px] uppercase tracking-[0.06em] text-gray-400 dark:text-gray-500">
            {t("rsvpWaitlistTitle", "Waitlist")} · {waitlistCount}
          </span>
          <span className="block text-[12px] text-gray-500 dark:text-gray-400 mt-0.5 group-hover:text-gray-900 dark:group-hover:text-gray-100">
            {t("rsvpRailWaitlistJump", "Show the waiting parties")}
          </span>
        </button>
      )}
    </section>
  );
}
