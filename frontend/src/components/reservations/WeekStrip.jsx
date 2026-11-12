/**
 * WeekStrip — the canvas's day strip (Reservations.dc.html): seven days, each
 * with the covers booked as a thin bar, ‹ › a week at a time.
 *
 * The bar is relative to the busiest day SHOWN (utils/tonight.js weekStrip) —
 * "heavier than the others", never "% full", which the covers of several
 * turns cannot honestly say. A day whose month did not answer has no bar and
 * says nothing about its covers. "Closed" only on the saved hours' word.
 * Laptop and iPad (the page mounts it from 1024 px); the phone keeps its
 * stepper, the door screen never changes day.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";

const DATE_LOCALE = { da: "da-DK", en: "en-GB", pt: "pt-PT" };

export default function WeekStrip({ t, lang = "da", days, onPick, onPrev, onNext }) {
  const loc = DATE_LOCALE[lang] || "da-DK";
  const dow = (iso, style) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(loc, { weekday: style }).replace(/\.$/, "");
  const long = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" });
  return (
    <div role="group" aria-label={t("rsvpWeekAria", "Choose a day")} className="flex items-center gap-1" data-week-strip="">
      <button
        type="button"
        onClick={onPrev}
        aria-label={t("rsvpPrevWeek", "Previous week")}
        className="rv2-press w-10 h-10 shrink-0 grid place-items-center rounded-xl text-[var(--rv-ink)] hover:bg-[var(--rv-track)]"
      >
        <ChevronLeft className="w-4 h-4" aria-hidden />
      </button>
      {days.map((d) => {
        const on = d.selected;
        const aria = [
          long(d.iso),
          d.closed
            ? t("rsvpWeekClosed", "closed")
            : d.covers == null
              ? null
              : d.covers === 1
                ? t("rsvpWeekCoverOne", "1 cover booked")
                : t("rsvpWeekCovers", "{n} covers booked", { n: d.covers }),
        ].filter(Boolean).join(", ");
        return (
          <button
            key={d.iso}
            type="button"
            onClick={() => onPick(d.iso)}
            aria-pressed={on}
            aria-label={aria}
            title={aria}
            data-week-day={d.iso}
            className={
              "rv2-press w-[54px] h-14 shrink-0 rounded-xl border flex flex-col items-center justify-center gap-[3px] " +
              (on
                ? "bg-[var(--rv-ink)] border-[var(--rv-ink)] text-[var(--rv-card)]"
                : "bg-[var(--rv-card)] border-[var(--rv-line)] hover:border-[var(--rv-muted)] " +
                  (d.closed ? "text-[var(--rv-muted)]" : "text-[var(--rv-ink)]"))
            }
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.04em] opacity-75 leading-none">
              {d.isToday ? t("rsvpToday", "Today") : dow(d.iso, "short")}
            </span>
            <span className="rv2-num text-[16px] font-bold leading-none">{d.day}</span>
            <span
              className={"block w-[26px] h-[3px] rounded-sm overflow-hidden " + (on ? "bg-white/20 dark:bg-black/20" : "bg-[var(--rv-track)]")}
              aria-hidden="true"
            >
              <span
                className={"block h-full " + (on ? "bg-[var(--rv-brass)]" : "bg-[var(--rv-sage-dot)]")}
                style={{ width: `${Math.round((d.fill || 0) * 100)}%` }}
              />
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNext}
        aria-label={t("rsvpNextWeek", "Next week")}
        className="rv2-press w-10 h-10 shrink-0 grid place-items-center rounded-xl text-[var(--rv-ink)] hover:bg-[var(--rv-track)]"
      >
        <ChevronRight className="w-4 h-4" aria-hidden />
      </button>
    </div>
  );
}
