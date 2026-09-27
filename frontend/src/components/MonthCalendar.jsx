import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Local yyyy-mm-dd — built from parts, never through toISOString, which is UTC
// and moves a Danish evening onto the next day.
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const monthOf = (iso) => {
  const [y, m] = iso.split("-").map(Number);
  return { y, m: m - 1 };
};
const monthIndex = ({ y, m }) => y * 12 + m;

/**
 * A month grid for a date further out than the booking page's day rail
 * shows. Monday first (Danish weeks), small type, a relaxed 200ms ease on
 * every state change.
 *
 * `isClosed(iso)` answers true / false, or undefined when the venue's
 * open-days overview does not reach that far — unknown days stay pickable,
 * and the time list then says whether the place is open.
 */
export default function MonthCalendar({ value, min, max, isClosed, onPick, locale, labels }) {
  const [cursor, setCursor] = useState(() => monthOf(value && value >= min ? value : min));
  const first = monthOf(min);
  const last = monthOf(max || min);
  const canPrev = monthIndex(cursor) > monthIndex(first);
  const canNext = monthIndex(cursor) < monthIndex(last);
  const today = min;

  const cells = useMemo(() => {
    const lead = (new Date(cursor.y, cursor.m, 1).getDay() + 6) % 7; // Monday first
    const count = new Date(cursor.y, cursor.m + 1, 0).getDate();
    return [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: count }, (_, i) => isoOf(cursor.y, cursor.m, i + 1)),
    ];
  }, [cursor]);

  // 1 Jan 2024 was a Monday — seven days from it name the columns.
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: "short" }).replace(/\.$/, ""),
      ),
    [locale],
  );
  const title = new Date(cursor.y, cursor.m, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
  const step = (delta) =>
    setCursor(({ y, m }) => {
      const n = y * 12 + m + delta;
      return { y: Math.floor(n / 12), m: n % 12 };
    });

  const navBtn =
    "w-10 h-10 rounded-full flex items-center justify-center text-gray-700 dark:text-gray-200 " +
    "hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:pointer-events-none " +
    "transition-colors duration-200 ease-out";

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <button type="button" onClick={() => step(-1)} disabled={!canPrev} aria-label={labels.prev} className={navBtn}>
          <ChevronLeft className="w-5 h-5" aria-hidden="true" />
        </button>
        <p className="text-[15px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 first-letter:uppercase">
          {title}
        </p>
        <button type="button" onClick={() => step(1)} disabled={!canNext} aria-label={labels.next} className={navBtn}>
          <ChevronRight className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center">
        {weekdays.map((w, i) => (
          <span key={i} className="text-[11px] font-medium capitalize text-gray-400 dark:text-gray-500 pb-1.5">
            {w}
          </span>
        ))}
        {cells.map((iso, i) => {
          if (!iso) return <span key={`lead-${i}`} />;
          const out = iso < min || (max && iso > max);
          const closed = !out && isClosed?.(iso) === true;
          const disabled = out || closed;
          const selected = iso === value;
          const isToday = iso === today;
          return (
            <button
              key={iso}
              type="button"
              disabled={disabled}
              onClick={() => onPick(iso)}
              aria-pressed={selected}
              aria-label={new Date(`${iso}T00:00:00`).toLocaleDateString(locale, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
              className={[
                "mx-auto w-10 h-10 rounded-full text-sm tabular-nums",
                "transition-[background-color,color,box-shadow] duration-200 ease-out",
                selected
                  ? "bg-gray-900 text-white font-semibold dark:bg-white dark:text-gray-900"
                  : disabled
                    ? "text-gray-300 dark:text-gray-600 cursor-not-allowed" + (closed ? " line-through" : "")
                    : "text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800",
                isToday && !selected ? "ring-1 ring-inset ring-gray-300 dark:ring-gray-600 font-semibold" : "",
              ].join(" ")}
            >
              {Number(iso.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
