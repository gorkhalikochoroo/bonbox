/**
 * TonightStrip — "I dag" at a glance (reservations v2, canvas 11 Nov 2026).
 *
 * The owner page's six numbers for the day being served, one card with
 * hairline dividers (canvas Reservations.dc.html): covers, in the room, next
 * arrival, needs you, booked peak, waitlist. On a phone (canvas
 * Reservations-mobile.dc.html) it is the summary card: "In the room" large,
 * then Next · Needs you · Covers; the peak and the waitlist have their own
 * places below (the waitlist section, the covers cell's "top 19.30").
 *
 * Every number is handed in from the book on screen (utils/tonight.js and
 * the page's own memos); `known` false draws "—" everywhere — no zeros before
 * the book has answered. Each cell that leads somewhere is a button.
 */
import { overByText } from "../../utils/serviceClock";

function Cell({ label, shortLabel, value, unit, helper, tone = "ink", onClick, selected, className = "", children, testid, badge = null }) {
  const Tag = onClick ? "button" : "div";
  const toneCls =
    tone === "coral" ? "text-[var(--rv-coral)]" : tone === "sage" ? "text-[var(--rv-sage)]" : tone === "brass" ? "text-[var(--rv-brass-ink)]" : "text-[var(--rv-ink)]";
  return (
    <Tag
      {...(onClick ? { type: "button", onClick, "aria-pressed": selected ? true : undefined } : {})}
      data-tonight={testid}
      className={
        "rv2-kpi min-w-0 text-left flex flex-col gap-1 px-3.5 py-3 lg:px-[18px] lg:py-4 " +
        (onClick ? "rv2-tint cursor-pointer " : "") +
        (selected ? "bg-[var(--rv-brass-soft)] " : "") +
        className
      }
    >
      <span className="flex items-center justify-between gap-2 text-[12px] lg:text-[12.5px] leading-tight text-[var(--rv-muted)] min-w-0">
        <span className="truncate">
        {shortLabel ? (
          <>
            <span className="lg:hidden">{shortLabel}</span>
            <span className="hidden lg:inline">{label}</span>
          </>
        ) : (
          label
        )}
        </span>
        {badge}
      </span>
      <span className={"rv2-num font-semibold leading-[1.1] text-[22px] lg:text-[28px] whitespace-nowrap " + toneCls}>
        {value}
        {unit ? <span className="ml-1 text-[13px] lg:text-[14px] font-medium tracking-normal text-[var(--rv-muted)] [font-family:var(--rv-text)]">{unit}</span> : null}
      </span>
      {children}
      {helper ? (
        <span className="text-[12px] lg:text-[12.5px] leading-snug text-[var(--rv-muted)] max-lg:line-clamp-2 lg:truncate" title={typeof helper === "string" ? helper : undefined}>
          {helper}
        </span>
      ) : null}
    </Tag>
  );
}

export default function TonightStrip({
  t,
  known = true,
  covers = 0,
  bookings = 0,
  seatedGuests = 0,
  seatedTables = 0,
  totalTables = 0,
  next = null, // { time, helper, late }
  needs = null, // { total, late: [{ name, min }], requested }
  peak = null, // { peak, at, seats }
  waitlist = null, // { count, first: { name, party } | null }
  live = false,
  onCovers,
  onSeated,
  onNext,
  onNeeds,
  onWaitlist,
  selected = null,
}) {
  const dash = "—";
  const needN = needs?.total || 0;
  const firstLate = needs?.late?.[0] || null;
  const needsHelper = !known
    ? null
    : firstLate
      ? [
          firstLate.min < 60
            ? t("rsvpTnLateOne", "{name} is {n} min late", { name: firstLate.name || t("rsvpGuest", "Guest"), n: firstLate.min })
            : t("rsvpTnLateLong", "{name} is late · {txt}", { name: firstLate.name || t("rsvpGuest", "Guest"), txt: overByText(t, firstLate.min) }),
          needs.late.length > 1 ? t("rsvpTnLateMore", "+{n} more", { n: needs.late.length - 1 }) : null,
          needs.requested ? t("rsvpTnToConfirm", "{n} to confirm", { n: needs.requested }) : null,
        ].filter(Boolean).join(" · ")
      : needs?.requested
        ? t("rsvpTnToConfirm", "{n} to confirm", { n: needs.requested })
        : t("rsvpTnAllClear", "No one is late");
  const pct = totalTables > 0 ? Math.min(1, seatedTables / totalTables) : 0;
  const wlFirst = waitlist?.first;
  const peakSeats = peak?.seats || 0;
  // The phone keeps the two cells it hides when they matter (the cockpit
  // strip's rule before v2): the booked peak from 85 % of the seats (coral
  // past them), and the Venteliste whenever someone is on it.
  const phonePeak = known && peakSeats > 0 && (peak?.peak || 0) >= 0.85 * peakSeats;
  const phoneWl = known && (waitlist?.count || 0) > 0 && typeof onWaitlist === "function";

  return (
    <section
      aria-label={t("rsvpTnAria", "Today")}
      data-tonight-strip=""
      className="rv2-kpis grid grid-cols-3 lg:grid-cols-6"
    >
      <Cell
        testid="covers"
        label={t("rsvpTnCovers", "Covers today")}
        shortLabel={t("rsvpCovers", "Covers")}
        value={known ? covers : dash}
        helper={
          known
            ? [
                bookings === 1 ? t("rsvpCoversBookingsOne", "{n} booking", { n: 1 }) : t("rsvpCoversBookings", "{n} bookings", { n: bookings }),
                peak?.at ? <span key="top" className="lg:hidden"> · {t("rsvpTnTopAt", "top {time}", { time: peak.at })}</span> : null,
              ]
            : null
        }
        onClick={onCovers}
        className="order-4 lg:order-none"
      />
      <Cell
        testid="seated"
        label={t("rsvpTnInRoom", "In the room")}
        value={known ? seatedGuests : dash}
        unit={known ? (seatedGuests === 1 ? t("rsvpTnGuestOne", "guest") : t("rsvpTnGuests", "guests")) : null}
        helper={known && totalTables > 0 ? t("rsvpTnTablesOf", "{n} of {total} tables", { n: seatedTables, total: totalTables }) : null}
        onClick={onSeated}
        selected={selected === "seated"}
        badge={
          live ? (
            <span className="lg:hidden inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--rv-sage)]" data-tonight-live="">
              <span className="rv2-live-dot w-1.5 h-1.5 rounded-full bg-[var(--rv-sage)]" aria-hidden="true" />
              {t("rsvpTnLive", "Live")}
            </span>
          ) : null
        }
        className="order-first col-span-3 max-lg:border-b max-lg:border-[var(--rv-hair)] lg:order-none lg:col-span-1 max-lg:[&_.rv2-num]:text-[30px]"
      >
        {known && totalTables > 0 && (
          <span className="rv2-bar mt-0.5" aria-hidden="true">
            <span style={{ transform: `scaleX(${pct})` }} />
          </span>
        )}
      </Cell>
      <Cell
        testid="next"
        label={t("rsvpNextArrival", "Next arrival")}
        shortLabel={t("rsvpNextShort", "Next")}
        value={known && next ? next.time : dash}
        tone={next?.late ? "coral" : "ink"}
        helper={known ? (next ? next.helper : t("rsvpNothingUpcoming", "Nothing upcoming")) : null}
        onClick={next && onNext ? onNext : undefined}
        className="order-2 lg:order-none"
      />
      <Cell
        testid="needs"
        label={t("rsvpTnNeeds", "Needs you")}
        shortLabel={t("rsvpTnNeedsShort", "Needs you")}
        value={known ? needN : dash}
        tone={!known ? "ink" : firstLate ? "coral" : needN > 0 ? "brass" : "sage"}
        helper={needsHelper}
        onClick={needN > 0 ? onNeeds : undefined}
        selected={selected === "needs"}
        className="order-3 lg:order-none"
      />
      <Cell
        testid="peak"
        label={t("rsvpTnPeak", "Booked peak")}
        value={
          known && peakSeats > 0 ? (
            <>
              {peak.peak}
              <span className="text-[15px] lg:text-[17px] font-semibold text-[var(--rv-muted)]">/{peakSeats}</span>
            </>
          ) : (
            dash
          )
        }
        tone={known && peakSeats > 0 && peak.peak > peakSeats ? "coral" : "ink"}
        helper={
          !known
            ? null
            : peakSeats <= 0
              ? t("rsvpUtilNoSeats", "set table seats")
              : peak?.at
                ? t("rsvpTnPeakAt", "seats at {time}", { time: peak.at })
                // Never "no bookings" over a night that has covers.
                : covers > 0
                  ? null
                  : t("rsvpTnPeakNone", "No bookings yet")
        }
        className="max-lg:hidden"
      />
      <Cell
        testid="waitlist"
        label={t("rsvpTnWaitlist", "Waitlist")}
        value={known && waitlist ? waitlist.count : dash}
        helper={
          known && waitlist
            ? wlFirst
              ? `${wlFirst.name || t("rsvpGuest", "Guest")} · ${wlFirst.party}`
              // Only held entries waiting (check them first): not "no one".
              : waitlist.count > 0
                ? null
                : t("rsvpTnWlNone", "No one waiting")
            : null
        }
        onClick={onWaitlist}
        className="max-lg:hidden"
      />
      {(phonePeak || phoneWl) && (
        <div
          className="lg:hidden order-last col-span-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-2.5 border-t border-[var(--rv-hair)] text-[13px]"
          data-tonight-phone-extra=""
        >
          {phonePeak && (
            <span className="inline-flex items-baseline gap-1.5 min-w-0" data-tonight="peak-phone">
              <span className="text-[var(--rv-muted)]">{t("rsvpTnPeak", "Booked peak")}</span>
              <span className={"rv2-num font-semibold " + (peak.peak > peakSeats ? "text-[var(--rv-coral)]" : "text-[var(--rv-ink)]")}>
                {peak.peak}/{peakSeats}
              </span>
              {peak.at ? <span className="text-[var(--rv-muted)]">{t("rsvpTnPeakAt", "seats at {time}", { time: peak.at })}</span> : null}
            </span>
          )}
          {phoneWl && (
            <button
              type="button"
              onClick={onWaitlist}
              className="rv2-tint ml-auto inline-flex items-center gap-1.5 h-8 px-2.5 -mr-1 rounded-lg font-medium text-[var(--rv-ink)]"
              data-tonight="waitlist-phone"
            >
              {t("rsvpTnWaitlist", "Waitlist")}
              <span className="rv2-num font-semibold">{waitlist.count}</span>
              <span aria-hidden="true" className="text-[var(--rv-muted)]">›</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
