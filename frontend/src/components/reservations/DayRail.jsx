// The month day rail — moved out of pages/ReservationsPage.jsx unchanged
// (reservations v2, 12 Nov 2026). The owner page draws it from 1680 px and
// in the door screen's date popover; the door screen's own build loads it
// on first use (stand/standDayRail.jsx) — a host rarely changes the day
// mid-service, and it kept the door screen's JS under its budget.
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";
import { monthName } from "../../utils/monthlyRecord";
import { relativeDayLabel, serviceDayIso } from "../../utils/serviceDay";

/* ─── DayRail — the desktop day rail (≥1280px only) ────────────────────
   The single-day book can't answer "how's Saturday looking", and on a wide
   screen the page was leaving ~400px of dead pixels (it was capped at
   max-w-5xl). This fills that space with the two questions an owner actually
   has: WHICH DAY, and AM I COVERED.

   The second half is the part a booking tool can't do. BonBox holds the
   roster as well as the book, so the rail can say "48 covers · 3 on shift"
   and flag the mismatch. DinnerBooking knows the covers; Planday knows the
   roster; only this knows both.

   Density comes from the page's EXISTING type scale (10/11/12/13px — no new
   sizes), tabular numerals so the counts line up in a column, and tight
   leading so a whole month plus a per-day count fits in 300px. Days with
   nothing booked render blank, not "0" — 31 zeros is noise.

   Colour stays meaningful: gray-900 for the selected day, a heavier grey ONLY where
   covers outrun the roster. No heatmap — a rainbow month would look like a
   dashboard and say less than one marked Saturday does. (Amber is the
   request colour now — Manoj, 1 Oct 2026.) */
// `apptWords`: a salon, a shop, a workshop — its days hold appointments and
// customers, not reservations and guests.
export default function DayRail({ day, onPick, t, waitlistCount = 0, onOpenWaitlist, apptWords = false }) {
  const { lang } = useLanguage();
  const [month, setMonth] = useState(() => (day || serviceDayIso()).slice(0, 7));
  const [load, setLoad] = useState({});
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);

  // Follow the book when the owner jumps to a date in another month (arrows,
  // date picker, deep link) so the rail never shows a different month than
  // the day that's open.
  useEffect(() => {
    if (day && day.slice(0, 7) !== month) setMonth(day.slice(0, 7));
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch when a booking is created or changes status elsewhere on the page —
  // the rail said "I morgen 0 gæster" right after a 4-top was booked for tomorrow.
  const [railNonce, setRailNonce] = useState(0);
  useEffect(() => {
    const bump = () => setRailNonce((n) => n + 1);
    window.addEventListener("bonbox-reservations-changed", bump);
    return () => window.removeEventListener("bonbox-reservations-changed", bump);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .get("/reservations/month-load", { params: { month } })
      .then((res) => {
        if (!alive) return;
        const map = {};
        (res.data?.days || []).forEach((d) => { map[d.date] = d; });
        setLoad(map);
        setTotals(res.data?.month_totals || null);
      })
      .catch(() => { if (alive) { setLoad({}); setTotals(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month, railNonce]);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  // Monday-first, matching the Danish week (getDay() is Sunday-first).
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m, 0).getDate();
  // The APP's language, not the browser's — a Danish owner on an English-locale
  // laptop must still read "juli 2026". Same convention the date stepper uses.
  const monthLabel = first.toLocaleDateString(lang, { month: "long", year: "numeric" });

  const shiftMonth = (delta) => {
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const sel = load[day] || null;
  // "Heavy" = more covers than the roster can plausibly carry. 12 covers per
  // person on shift is a deliberately forgiving rule of thumb — it should fire
  // on the obvious Saturday, not nag on an ordinary Tuesday. Never fires when
  // no roster exists (nothing to compare against ⇒ no honest claim to make).
  const isHeavy = (d) => d && d.staff_on > 0 && d.covers > d.staff_on * 12;

  return (
    <aside
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-3 tabular-nums"
      aria-label={t("rsvpRailAria", "Day overview")}
    >
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[11px] uppercase tracking-[0.06em] text-gray-400 dark:text-gray-500">
          {monthLabel}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label={t("rsvpRailPrevMonth", "Previous month")}
            className="w-6 h-6 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label={t("rsvpRailNextMonth", "Next month")}
            className="w-6 h-6 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-[10px] text-gray-400 dark:text-gray-500 text-center mb-1">
        {t("rsvpRailWeekdays", "M,T,W,T,F,S,S")
          .split(",")
          .map((w, i) => <div key={i}>{w}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center relative">
        {Array.from({ length: lead }).map((_, i) => <div key={`p${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const dnum = i + 1;
          const iso = `${month}-${String(dnum).padStart(2, "0")}`;
          const info = load[iso];
          const selected = iso === day;
          const heavy = isHeavy(info);
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              aria-label={`${iso}${info?.covers ? ` — ${info.covers}` : ""}`}
              aria-current={selected ? "date" : undefined}
              className={
                "group relative rounded-md py-1 leading-[1.1] transition-colors " +
                (selected
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : heavy
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-semibold hover:bg-gray-200 dark:hover:bg-gray-700"
                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800")
              }
            >
              <span className="block text-[11px]">{dnum}</span>
              <span
                className={
                  "block text-[10px] " +
                  (selected
                    ? "text-white/70 dark:text-gray-900/70"
                    : heavy
                      ? "text-gray-700 dark:text-gray-200"
                      : "text-gray-400 dark:text-gray-500")
                }
              >
                {info?.covers ? info.covers : " "}
              </span>

              {/* Peek. The grid could always show covers; what it could not show
                  was the SHAPE of a day without opening it — how many separate
                  bookings those covers arrive in, and whether anyone is
                  rostered. Both numbers are already in this response, so this
                  reads nothing new; it stops the owner clicking thirty-one days
                  to find the one that needs them.
                  Silent on empty days — an empty tooltip is worse than none. */}
              {info && (info.bookings || info.staff_on) ? (
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-20
                             hidden group-hover:block group-focus-visible:block
                             whitespace-nowrap rounded-lg px-2 py-1
                             bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900
                             text-[10.5px] font-medium shadow-lg"
                >
                  {info.bookings || 0}&nbsp;{apptWords ? t("rsvpPeekBookingsAppt", "appointments") : t("rsvpPeekBookings", "bookings")}
                  {info.covers
                    ? ` \u00b7 ${info.covers} ${
                        apptWords
                          ? info.covers === 1 ? t("rsvpPeekCustomerOne", "customer") : t("rsvpPeekCustomers", "customers")
                          : info.covers === 1 ? t("rsvpPeekGuestOne", "guest") : t("rsvpPeekGuests", "guests")
                      }`
                    : ""}
                  {/* Roster only when we HAVE one. "0 on shift" would read as a
                      staffing alarm when it usually means the week is unplanned. */}
                  {info.staff_on ? ` \u00b7 ${info.staff_on} ${t("rsvpPeekOnShift", "on shift")}` : ""}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* The month as a record — "how did September go?". Same definitions as
          Indsigt → Måned for måned (cancelled bookings don't count; guests
          are confirmed/seated/completed parties), so the two always agree. */}
      {!loading && totals?.bookings > 0 && (
        <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
          {(() => {
            // One key per singular/plural shape — both counts can be 1.
            const vars = { month: monthName(month, lang, false), bookings: totals.bookings, guests: totals.guests };
            if (apptWords) {
              if (totals.bookings === 1) {
                return totals.guests === 1
                  ? t("rsvpRailMonthOneApptOneCustomer", "{month}: 1 appointment · 1 customer", vars)
                  : t("rsvpRailMonthOneAppt", "{month}: 1 appointment · {guests} customers", vars);
              }
              return totals.guests === 1
                ? t("rsvpRailMonthApptOneCustomer", "{month}: {bookings} appointments · 1 customer", vars)
                : t("rsvpRailMonthAppt", "{month}: {bookings} appointments · {guests} customers", vars);
            }
            if (totals.bookings === 1) {
              return totals.guests === 1
                ? t("opsRsvpRailMonthOneBookingOneGuest", "{month}: 1 booking · 1 guest", vars)
                : t("rsvpRailMonthTotalOne", "{month}: 1 booking · {guests} guests", vars);
            }
            return totals.guests === 1
              ? t("opsRsvpRailMonthOneGuest", "{month}: {bookings} bookings · 1 guest", vars)
              : t("rsvpRailMonthTotal", "{month}: {bookings} bookings · {guests} guests", vars);
          })()}
        </p>
      )}

      {/* Selected day — covers vs roster, the answer the book alone can't give */}
      <div className="mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium text-gray-900 dark:text-gray-100 truncate">
            {relativeDayLabel(day, t, lang)}
          </span>
          <span className="text-[13px] text-gray-900 dark:text-gray-100">
            {loading ? "" : sel?.covers || 0}
          </span>
        </div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
          {apptWords
            ? (sel?.covers || 0) === 1
              ? t("rsvpRailDayLineOneAppt", "1 customer · {staff} on shift", { staff: sel?.staff_on || 0 })
              : t("rsvpRailDayLineAppt", "{covers} customers · {staff} on shift", {
                  covers: sel?.covers || 0,
                  staff: sel?.staff_on || 0,
                })
            : (sel?.covers || 0) === 1
              ? t("rsvpRailDayLineOne", "1 guest · {staff} on shift", { staff: sel?.staff_on || 0 })
              : t("rsvpRailDayLine", "{covers} guests · {staff} on shift", {
                  covers: sel?.covers || 0,
                  staff: sel?.staff_on || 0,
                })}
        </p>
        {isHeavy(sel) && (
          <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-2.5 py-1.5 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-gray-600 dark:text-gray-300 shrink-0 mt-px" aria-hidden />
            <p className="text-[11px] text-gray-700 dark:text-gray-200 leading-snug">
              {t("rsvpRailHeavy", "Busy day for this roster — check staffing.")}
            </p>
          </div>
        )}
      </div>

      {/* Venteliste lives here on desktop: you act on it DURING service, while
          looking at the book — not from the bottom of the page. */}
      {waitlistCount > 0 && (
        <button
          type="button"
          onClick={onOpenWaitlist}
          className="mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800 w-full text-left group"
        >
          <span className="text-[11px] uppercase tracking-[0.06em] text-gray-400 dark:text-gray-500">
            {t("rsvpWaitlistTitle", "Venteliste")} · {waitlistCount}
          </span>
          <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 group-hover:text-gray-900 dark:group-hover:text-gray-100">
            {t("rsvpRailWaitlistJump", "Show the waiting parties")}
          </span>
        </button>
      )}
    </aside>
  );
}
