// The venue's weekly opening hours on the guest booking page (booking push
// p3): a one-tap item in the phone header's address/phone row, and the
// always-open list in the desktop venue column.
//
// Opening hours, what the owner typed — never a bookability claim (the date
// strip owns that per day). No status colour: hours mean nothing good or bad.
import { ChevronDown, Clock } from "lucide-react";
import { WEEK_KEYS, dayRangeLabel, emptyWord, groupWeek, todayKey, windowsLabel } from "../utils/venueHours";

function dayWords(day, apptWords, t) {
  return windowsLabel(day.windows) || emptyWord(day.by, apptWords, t);
}

// The row item: today's hours (or the day's empty word) and a chevron. It
// sits beside the phone link at the same 32px height (owner Q6b), so the
// row keeps its aligned two-line shape. When today has no claim, it reads
// the plain heading and says nothing about today.
export function VenueHoursToggle({ hours, todayIso, t, apptWords = false, open, onToggle, focusClass = "", controls = "rsvp-venue-hours" }) {
  const today = hours?.days?.[todayKey(todayIso)] || null;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={
        "inline-flex items-center gap-1.5 min-h-8! rounded-md text-[13px] whitespace-nowrap tabular-nums " +
        "hover:text-gray-900 dark:hover:text-gray-100 transition-colors duration-200 " + focusClass
      }
    >
      <Clock size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
      {today ? (
        <>
          <span className="sr-only">{t("rsvpVenueHoursTodayLabel", "Opening hours today")} </span>
          <span>{dayWords(today, apptWords, t)}</span>
        </>
      ) : (
        <span>{t("rsvpVenueHoursOpening", "Opening hours")}</span>
      )}
      <span className="sr-only"> {t("rsvpVenueHoursShowAll", "See all days")}</span>
      <ChevronDown
        size={14}
        strokeWidth={1.75}
        className={"shrink-0 transition-transform duration-200 motion-reduce:transition-none " + (open ? "rotate-180" : "")}
        aria-hidden="true"
      />
    </button>
  );
}

// The week, Monday first, consecutive equal days on one row ("Mandag–
// torsdag 17:00–22:00"). Today's row is marked for sight (weight) and for a
// screen reader (aria-current + "I dag"). `variant`: "inline" under the
// phone row (a small caption), "panel" in the desktop column (a heading).
export function VenueHoursList({ hours, todayIso, lang, t, apptWords = false, variant = "inline", id }) {
  const groups = groupWeek(hours?.days);
  if (!groups.length) return null;
  const today = WEEK_KEYS.indexOf(todayKey(todayIso));
  const captionId = `${id}-caption`;
  const caption = t("rsvpVenueHoursOpening", "Opening hours");
  return (
    <div id={id} className={variant === "panel" ? "space-y-2" : "space-y-1.5"}>
      {variant === "panel" ? (
        <h2 id={captionId} className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
          {caption}
        </h2>
      ) : (
        <p id={captionId} className="text-[12px] text-gray-500 dark:text-gray-400">
          {caption}
        </p>
      )}
      <dl aria-labelledby={captionId} className="max-w-[18rem] space-y-0.5 text-[13px]">
        {groups.map((g) => {
          const isToday = today >= WEEK_KEYS.indexOf(g.from) && today <= WEEK_KEYS.indexOf(g.to);
          return (
            <div
              key={g.from}
              aria-current={isToday ? "date" : undefined}
              className={
                "flex items-baseline justify-between gap-4 " +
                (isToday ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-600 dark:text-gray-300")
              }
            >
              <dt>
                {dayRangeLabel(g, lang)}
                {isToday && <span className="sr-only"> {t("rsvpVenueHoursTodayTag", "Today")}</span>}
              </dt>
              <dd className="tabular-nums text-right">{dayWords(g.day, apptWords, t)}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
