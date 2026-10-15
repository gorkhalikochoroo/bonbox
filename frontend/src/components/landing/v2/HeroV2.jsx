import { ChevronRight } from "lucide-react";
import AppStoreLink from "./AppStoreLink";
import DemoTag from "./DemoTag";
import { ART_HERO_CARD, CELL, TEXT, WIDE } from "./fluid";
import { Link } from "react-router-dom";
import { useLanguage } from "../../../hooks/useLanguage";
import { dateLocale } from "../../../utils/dateFormat";
import {
  formatFrist,
  formatPeriod,
  nextMomsDeadline,
} from "../../../utils/nextMomsDeadline";
import {
  DEMO_MARGIN_PCT,
  DEMO_MOMS,
  DEMO_MONTH,
  DEMO_WEEK,
  DEMO_WEEK_DELTA_PCT,
  DEMO_YESTERDAY,
  demoMomsWeekly,
  demoMonthSlices,
  formatKr,
  onShiftToday,
  yesterday,
} from "./demoData";
import { FROM_PRICE, momsNoteKey } from "./pricing";

/**
 * Landing v2 — hero section (#top).
 *
 * Two equal columns from 1041px, a single column below. Above that the
 * card is drawn at its column's width and the page grows with the screen
 * (see ./fluid.js).
 * Left: headline, audience, lead, two pill CTAs, the price line, trust row.
 * Right: a static demo of the owner dashboard, labelled as a demo.
 *
 * PUSH 9 (landing review, 15 Oct 2026):
 *  - The figures come from ./demoData — one bistro, one month, one week —
 *    so the card agrees with the AI panel, the rota and the phones. The old
 *    card showed an 82 % margin (revenue minus "expenses", no wages, no
 *    MOMS); the footer now takes MOMS, goods, wages and running costs off
 *    the till and shows what is left.
 *  - Every date is today's: the alert is about yesterday's kasserapport, the
 *    MOMS countdown is computed (utils/nextMomsDeadline), "on shift" is
 *    whoever the demo rota has on today.
 *  - The second CTA goes to #pricing ("Se priser"). It said "Se bordplanen"
 *    and landed on an unlabelled booking widget.
 *  - A plain price line sits under the CTAs, from ./pricing (the backend's
 *    price table), and says nothing about MOMS until the owner confirms it.
 *  - Phones: the "Lavet i København" badge (also in the footer) and the
 *    card's quick-action buttons and third metric are hidden below sm / 861px
 *    to shorten the page; desktop is unchanged.
 */
export default function HeroV2() {
  const { t, lang } = useLanguage();

  // The countdown is computed (see utils/nextMomsDeadline: a typed-in
  // countdown ages into a lie). The amount is the demo bistro's half-year,
  // and the weekly set-aside is worked out from the days left exactly the
  // way the product's own card does it (demoMomsWeekly) — a fixed weekly
  // figure stopped adding up as the date moved. Inside the last week the
  // product says the amount is due instead of a weekly rate; so does this.
  const moms = nextMomsDeadline();
  const momsWeekly = demoMomsWeekly(moms.daysUntil);
  const now = new Date();

  // Today's date frames the demo (it used to be a frozen "Monday, 27 July").
  // Not memoised: dateLocale() reads the stored language, see the booking card.
  const fmt = (opts, d = now) => {
    try {
      return new Intl.DateTimeFormat(dateLocale(), opts).format(d);
    } catch {
      return "";
    }
  };
  const heroDate = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const y = yesterday(now);
  const alertDate = `${String(y.getDate()).padStart(2, "0")}/${String(y.getMonth() + 1).padStart(2, "0")}`;

  const shift = onShiftToday(now);
  const roleLabel = shift
    ? t(`landingV2.schedule.role.${shift.person.role}`, shift.person.role)
    : "";

  const slices = demoMonthSlices();
  const costs = DEMO_MONTH.revenue - DEMO_MONTH.profit;
  const momsNote = momsNoteKey();

  const eyebrow =
    "text-[12px] min-[861px]:text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-400";
  const metricLabel =
    "mb-2 text-[12px] min-[861px]:text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-400";
  const metricValue =
    "font-display text-[24px] min-[861px]:text-[26px] font-bold tracking-[-0.02em] tabular-nums";
  const metricUnit = "text-[14px] font-medium text-slate-500";
  const cardCell = "px-4 py-[16px] min-[861px]:py-[18px]";

  return (
    <section id="top" className="bg-slate-50">
      {/* Wide screens (./fluid.js): 5% gutters; above 1440px the padding,
          the gap and the copy grow with the type scale. 3vw is 43.2px at
          1440. Equal columns: the card fills its half. */}
      <div className={`mx-auto w-full max-w-[1180px] px-[clamp(24px,4vw,64px)] pt-[clamp(20px,3vw,52px)] pb-[clamp(32px,5vw,64px)] ${WIDE} min-[1441px]:pt-[calc(43.2px*var(--lx))] min-[1441px]:pb-[calc(64px*var(--lx))]`}>
      <div className="grid grid-cols-1 items-center gap-10 min-[1041px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-[1041px]:gap-[clamp(40px,5vw,68px)] min-[1441px]:gap-[calc(68px*var(--lx))]">
        {/* ── Left column ───────────────────────────────────────────── */}
        <div className={`max-sm:flex max-sm:flex-col ${TEXT}`}>
          {/* Badge + the owner app, as peers. The badge is hidden on a phone
              (the footer carries "Lavet i København" too); the app link is
              the App Store on iPhone and desktop and the web app on Android,
              where there is no BonBox app. On a phone the row moves under
              the trust line (order-last): the headline, the button and the
              price come first, and on a 360 px Android phone with Chrome's
              bars the price line clears the cookie banner (push 9 review —
              it sat under the banner's top edge at 360 x 668). */}
          <div className="mb-5 flex flex-wrap items-center gap-2.5 max-sm:order-last max-sm:mb-0 max-sm:mt-5 sm:mb-6">
            <span className="hidden items-center gap-2 rounded-full bg-bb-green-tint py-[6px] pl-[10px] pr-[13px] text-[12.5px] font-semibold text-bb-green-dark sm:inline-flex">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full bg-bb-green-bright"
              />
              {t("landingV2HeroBadge", "Made in Copenhagen for Danish small business")}
            </span>
            <AppStoreLink
              size="md"
              href="https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960"
              label={t("landingV2.appStore.dailyClose", "BonBox on the App Store")}
              webHref="/register"
              webLabel={t("landingV2.webApp.owner", "BonBox in your browser")}
            />
          </div>

          {/* The outcome, then who it is for — one heading, two lines. */}
          <h1 className="m-0 mb-5 font-display text-[clamp(32px,4.7vw,56px)] font-extrabold leading-[1.04] tracking-[-0.033em] text-balance text-slate-900">
            {t("landingV2HeroTitle", "The till, the rota and MOMS — under control.")}
            <span className="mt-3 block text-[clamp(19px,2vw,24px)] font-semibold leading-[1.25] tracking-[-0.015em] text-slate-600">
              {t("landingV2HeroAudience", "For cafés, restaurants, bars and salons.")}
            </span>
          </h1>

          {/* 47ch on a phone. From 1041px the column sets the measure, so
              the lead runs up to the card instead of stopping short of it. */}
          <p className="m-0 mb-6 max-w-[47ch] text-[17px] leading-[1.5] text-slate-600 text-pretty sm:mb-7 sm:text-[18.5px] min-[1041px]:max-w-none">
            {t(
              "landingV2HeroLead",
              "Today's kasserapport, bookings, the rota, hours, stock and MOMS in one place. One login for the owner, the rota on every staff phone, one bill.",
            )}
          </p>

          <div className="mb-3 flex flex-wrap items-center gap-[14px]">
            {/* Goes to /register, not #pricing. The primary CTA used to
                scroll to the pricing table, so the one button most likely to
                be clicked never reached a signup form. */}
            <Link
              to="/register"
              data-testid="hero-cta-primary"
              className="rounded-full bg-slate-900 px-[26px] py-[14px] text-[15.5px] font-medium text-white transition-colors duration-150 ease-out hover:bg-bb-green"
            >
              {t("landingV2HeroCtaPrimary", "Free trial")}
            </Link>
            <a
              href="#pricing"
              className="rounded-full border border-slate-200 bg-white px-6 py-[13px] text-[15.5px] font-medium text-slate-900 transition-colors duration-150 ease-out hover:border-slate-400"
            >
              {t("landingV2HeroCtaSecondary", "See pricing")}
            </a>
          </div>

          {/* The price, in plain words, right under the button (B2). */}
          <p data-testid="hero-price-line" className="m-0 mb-[22px] text-[13.5px] leading-[1.45] text-slate-600">
            {t(
              "landingV2HeroPriceLine",
              "14 days free · no card · then the free plan, or from {price} kr./mo",
              { price: FROM_PRICE },
            )}
            {momsNote ? ` ${t(momsNote)}` : ""}
          </p>

          <div className="flex flex-wrap gap-x-[22px] gap-y-1 text-[13px] leading-[1.45] text-slate-500 sm:gap-y-1.5 sm:text-[13.5px]">
            <span>
              {t("landingV2HeroTrustArchive", "Each kasserapport as a PDF – you keep them for 5 years")}
            </span>
            <span>
              {t(
                "landingV2HeroTrustHosting",
                "Database in Ireland · providers listed in the privacy policy",
              )}
            </span>
            <span>{t("landingV2HeroTrustNoCut", "No cut of your revenue")}</span>
          </div>
        </div>

        {/* ── Right column: dashboard demo card ─────────────────────── */}
        {/* The wrapper is the size container the card measures: from
            1041px the card is drawn at the column's width / 600px, never
            below 1 (narrower columns reflow it as before), never above 1.1x
            the type scale, and never so large that its profit bar falls
            below the fold (ART_HERO_CARD in ./fluid.js). Capped, it lays out
            wider and still fills the column. */}
        <div className={CELL}>
        <figure className={`m-0 overflow-hidden rounded-[18px] bg-white shadow-[0_18px_44px_-24px_rgba(15,23,42,0.30)] ${ART_HERO_CARD}`}>
          <figcaption className="sr-only">
            {t(
              "landingV2HeroCardCaption",
              "Preview of the BonBox owner dashboard. All figures are demo data.",
            )}
          </figcaption>

          {/* Greeting header */}
          <div className="flex flex-col items-stretch gap-3 border-b border-slate-200 px-[22px] pt-[16px] pb-[14px] min-[861px]:flex-row min-[861px]:items-start min-[861px]:justify-between min-[861px]:gap-[14px] min-[861px]:pt-[18px] min-[861px]:pb-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className={`${eyebrow} mb-1 tracking-[0.15em]`}>
                  {t("landingV2HeroCardEyebrow", "Home")}
                </div>
                <div className="font-display text-[23px] font-bold tracking-[-0.026em] text-slate-900">
                  {t("landingV2HeroCardGreeting", "Good morning")}
                </div>
                <div className="mt-0.5 text-[12.5px] text-slate-500">{heroDate}</div>
              </div>
              <DemoTag className="mt-0.5 min-[861px]:hidden" />
            </div>
            <div className="hidden flex-none flex-col items-end gap-2 min-[861px]:flex">
              <DemoTag />
              <div className="flex gap-2">
                <span className="whitespace-nowrap rounded-full bg-slate-900 px-[13px] py-2 text-[12.5px] font-medium text-white">
                  {t("landingV2HeroCardQuickSale", "+ Quick Sale")}
                </span>
                <span className="whitespace-nowrap rounded-full border border-slate-200 px-[13px] py-2 text-[12.5px] font-medium text-slate-900">
                  {t("landingV2HeroCardSnapReceipt", "Snap receipt")}
                </span>
              </div>
            </div>
          </div>

          {/* Needs you now — yesterday's kasserapport, with a partial
              payment split that genuinely does not tie out (the shape the
              detector produces; a Z-report-only close is never flagged). */}
          <div className="border-b border-slate-200 px-[22px] py-[14px]">
            <div className={`${eyebrow} mb-2`}>
              {t("landingV2HeroCardNeedsYouNow", "Needs you now")}
            </div>
            <div className="flex flex-wrap items-center gap-x-[11px] gap-y-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 flex-none rounded-full bg-red-500"
              />
              <span className="min-w-0 flex-1 text-[14px] leading-[1.4] text-slate-900">
                {t(
                  "landingV2HeroCardAlert",
                  "The {date} kasserapport doesn't tie out — you took {paid} kr. in payments but booked {booked} kr. in sales",
                  {
                    date: alertDate,
                    paid: `${formatKr(DEMO_YESTERDAY.payments)},00`,
                    booked: `${formatKr(DEMO_YESTERDAY.revenue)},00`,
                  },
                )}
              </span>
              {/* Part of the picture, not a link (there is nothing to open on
                  a demo): quiet text, so it does not read as a control. */}
              <span className="flex flex-none items-center whitespace-nowrap text-[13px] font-medium text-slate-500 max-sm:basis-full max-sm:pl-[19px]">
                {t("landingV2HeroCardAlertAction", "Review")}
                <ChevronRight
                  aria-hidden="true"
                  size={14}
                  strokeWidth={1.75}
                  className="ml-0.5"
                />
              </span>
            </div>
          </div>

          {/* Metric strip — yesterday, last week, last month. The month is
              hidden below 861px: the footer under it carries the month. */}
          <div className="grid grid-cols-2 min-[861px]:grid-cols-3">
            <div className={`${cardCell} border-r border-slate-200`}>
              <div className={metricLabel}>
                {t("landingV2HeroCardYesterdayLabel", "Yesterday")}
              </div>
              <div className={metricValue}>
                {formatKr(DEMO_YESTERDAY.revenue)}
                <span className={metricUnit}> {t("landingV2HeroKr", "kr.")}</span>
              </div>
              <div className="mt-[3px] text-[12.5px] text-slate-500">
                {t("landingV2HeroCardSales", "{n} sales", { n: DEMO_YESTERDAY.sales })}
              </div>
            </div>
            <div className={`${cardCell} border-slate-200 min-[861px]:border-r`}>
              <div className={metricLabel}>
                {t("landingV2HeroCardLastWeekLabel", "Last week")}
              </div>
              <div className={metricValue}>
                {formatKr(DEMO_WEEK.last)}
                <span className={metricUnit}> {t("landingV2HeroKr", "kr.")}</span>
              </div>
              <div className="mt-[3px] text-[12.5px] font-medium text-bb-green">
                {t("landingV2HeroCardLastWeekDelta", "{pct} % up on the week before", { pct: DEMO_WEEK_DELTA_PCT })}
              </div>
            </div>
            <div className={`${cardCell} hidden min-[861px]:block`}>
              <div className={metricLabel}>
                {t("landingV2HeroCardLastMonthLabel", "Last month")}
              </div>
              <div className={metricValue}>
                {formatKr(DEMO_MONTH.revenue)}
                <span className={metricUnit}> {t("landingV2HeroKr", "kr.")}</span>
              </div>
              <div className="mt-[3px] text-[12.5px] text-slate-500">
                {t("landingV2HeroCardLastMonthSub", "through the till, incl. MOMS")}
              </div>
            </div>
          </div>

          {/* MOMS card */}
          <div className="mx-[18px] my-4 flex items-center justify-between gap-[14px] rounded-xl border border-slate-200 px-4 py-[14px]">
            <div>
              <div className={`${eyebrow} mb-[5px]`}>
                {t("landingV2HeroCardMomsEyebrow", "MOMS · {period} · in {days} days", {
                  period: formatPeriod(moms, lang),
                  days: moms.daysUntil,
                })}
              </div>
              {momsWeekly ? (
                <>
                  <div data-testid="hero-moms-weekly" className="text-[15px] font-semibold text-slate-900">
                    {t("landingV2HeroCardMomsSetAside", "Set aside ~{weekly} kr./week to cover MOMS", {
                      weekly: formatKr(momsWeekly),
                    })}
                  </div>
                  <div className="mt-[3px] text-[12.5px] text-slate-500">
                    {t("landingV2HeroCardMomsDue", "~{amount} kr. due {frist}", {
                      amount: formatKr(DEMO_MOMS.halfYear),
                      frist: formatFrist(moms.date, lang),
                    })}
                  </div>
                </>
              ) : (
                <div data-testid="hero-moms-due" className="text-[15px] font-semibold text-slate-900">
                  {t("landingV2HeroCardMomsDue", "~{amount} kr. due {frist}", {
                    amount: formatKr(DEMO_MOMS.halfYear),
                    frist: formatFrist(moms.date, lang),
                  })}
                </div>
              )}
            </div>
            <ChevronRight
              aria-hidden="true"
              size={18}
              strokeWidth={1.75}
              className="flex-none text-slate-400"
            />
          </div>

          {/* On shift (hidden below 480px to keep the phone page short — the
              staff section below covers the rota). Below sm the eyebrow takes its own line (5px over the
              name, like the MOMS card's eyebrow): beside it, Inter left the
              name ~113px at 390 and split "16:00–" / "23:00" over 4 lines.
              With the eyebrow out of the way the role fits whole (nowrap),
              so a narrow phone breaks after the name, never inside the time.
              Whoever the demo rota (./demoData) has on today. */}
          {shift && (
          <div className="mx-[18px] mb-4 hidden flex-wrap items-center gap-x-3 gap-y-[5px] rounded-xl border border-slate-200 px-4 py-[14px] min-[480px]:flex sm:flex-nowrap">
            <span className={`${eyebrow} flex-none basis-full sm:basis-auto`}>
              {t("landingV2HeroCardOnShift", "On shift")}
            </span>
            <span className="min-w-0 flex-1 text-[14.5px] text-slate-900">
              {shift.person.name} ·{" "}
              <span className="whitespace-nowrap text-slate-500">
                {t("landingV2HeroCardOnShiftRole", "{role}, {from}–{to}", {
                  role: roleLabel,
                  from: shift.shift.from,
                  to: shift.shift.to,
                })}
              </span>
            </span>
            <span className="ml-auto flex items-center whitespace-nowrap text-[13px] font-medium text-slate-500">
              {t("landingV2HeroCardScheduleAction", "Vagtplan")}
              <ChevronRight
                aria-hidden="true"
                size={14}
                strokeWidth={1.75}
                className="ml-0.5"
              />
            </span>
          </div>
          )}

          {/* Profit footer — last month's till, with MOMS, goods, wages and
              running costs taken off; what is left is coloured. */}
          <div className="border-t border-slate-200 bg-slate-50 px-[22px] pt-4 pb-[18px]">
            <div className="mb-[11px] flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="text-[13px] text-slate-500">
                {t("landingV2HeroCardProfitLastMonthLabel", "Profit last month")}
              </span>
              <span className="font-display text-[20px] font-bold tracking-[-0.02em] tabular-nums text-slate-900">
                {formatKr(DEMO_MONTH.profit)} {t("landingV2HeroKr", "kr.")}
              </span>
              <span className="text-[12.5px] font-semibold text-bb-green-dark">
                {t("landingV2HeroCardProfitShare", "{pct} % of revenue ex MOMS", { pct: DEMO_MARGIN_PCT })}
              </span>
            </div>
            <div
              aria-hidden="true"
              className="flex h-2.5 overflow-hidden rounded-full"
            >
              {slices.map((s) => (
                <span key={s.key} className={s.cls} style={{ width: `${s.pct.toFixed(1)}%` }} />
              ))}
            </div>
            <div className="mt-[9px] flex flex-wrap justify-between gap-x-3 gap-y-1 text-[12px] tabular-nums">
              <span className="text-slate-600">
                {t("landingV2HeroCardCostsLegend", "{costs} kr. to MOMS, goods, wages and running costs", {
                  costs: formatKr(costs),
                })}
              </span>
              <span className="text-bb-green-dark">
                {t("landingV2HeroCardLeftLegend", "{profit} kr. left of {revenue} kr.", {
                  profit: formatKr(DEMO_MONTH.profit),
                  revenue: formatKr(DEMO_MONTH.revenue),
                })}
              </span>
            </div>
          </div>
        </figure>
        </div>
      </div>
      </div>
    </section>
  );
}
