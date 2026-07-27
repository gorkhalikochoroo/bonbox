import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../../hooks/useLanguage";

/**
 * Landing v2 — hero section (#top).
 *
 * Two-column grid (0.9fr / 1.1fr) collapsing to a single column at 1040px.
 * Left: badge, headline, lead, two pill CTAs, trust row.
 * Right: a static demo of the owner dashboard. Every figure is a fixed
 * demo value — no data fetching — and the figures tie out:
 *   223.022 − 40.718 = 182.304   and   182.304 / 223.022 ≈ 82 % margin.
 */
export default function HeroV2() {
  const { t } = useLanguage();

  const eyebrow =
    "text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-400";
  const metricLabel =
    "mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-400";
  const metricValue =
    "font-display text-[26px] font-bold tracking-[-0.02em] tabular-nums";
  const metricUnit = "text-[14px] font-medium text-slate-500";
  const cardCell = "px-4 py-[18px]";

  return (
    <section id="top" className="bg-slate-50">
      <div className="mx-auto w-full max-w-[1800px] px-[clamp(24px,4vw,80px)] pt-[clamp(24px,3vw,52px)] pb-[clamp(40px,5vw,64px)]">
      <div className="grid grid-cols-1 items-center gap-10 min-[1041px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] min-[1041px]:gap-[clamp(40px,5vw,68px)]">
        {/* ── Left column ───────────────────────────────────────────── */}
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-bb-green-tint py-[6px] pl-[10px] pr-[13px] text-[12.5px] font-semibold text-bb-green-dark">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-bb-green-bright"
            />
            {t("landingV2HeroBadge", "Made in Copenhagen for Danish small business")}
          </div>

          <h1 className="m-0 mb-5 font-display text-[clamp(36px,4.7vw,56px)] font-extrabold leading-[1.03] tracking-[-0.033em] text-balance text-slate-900">
            {t("landingV2HeroTitle", "The back office your business actually runs on.")}
          </h1>

          <p className="m-0 mb-7 max-w-[47ch] text-[18.5px] leading-[1.5] text-slate-600 text-pretty">
            {t(
              "landingV2HeroLead",
              "Daily close, reservations, schedule, timer & løn, stock and MOMS. For restaurants, bars, bistros, shops and anyone else closing a till in Denmark. One login for the owner, one app for the staff, one bill.",
            )}
          </p>

          <div className="mb-[26px] flex flex-wrap items-center gap-[14px]">
            {/* Goes to /register, not #pricing. The primary CTA used to
                scroll to the pricing table, so the one button most likely to
                be clicked never reached a signup form. */}
            <Link
              to="/register"
              className="rounded-full bg-slate-900 px-[26px] py-[14px] text-[15.5px] font-medium text-white transition-colors duration-150 ease-out hover:bg-bb-green"
            >
              {t("landingV2HeroCtaPrimary", "Free trial")}
            </Link>
            <a
              href="#reservations"
              className="rounded-full border border-slate-200 bg-white px-6 py-[13px] text-[15.5px] font-medium text-slate-900 transition-colors duration-150 ease-out hover:border-slate-400"
            >
              {t("landingV2HeroCtaSecondary", "See the floor plan")}
            </a>
          </div>

          <div className="flex flex-wrap gap-x-[22px] gap-y-2 text-[13.5px] text-slate-500">
            <span>
              {t("landingV2HeroTrustArchive", "Archive built for Bogføringsloven")}
            </span>
            <span>
              {t(
                "landingV2HeroTrustHosting",
                "Database in Ireland, receipts read in the US",
              )}
            </span>
            <span>{t("landingV2HeroTrustNoCut", "No cut of your revenue")}</span>
          </div>
        </div>

        {/* ── Right column: dashboard demo card ─────────────────────── */}
        <figure className="m-0 overflow-hidden rounded-[18px] bg-white shadow-[0_18px_44px_-24px_rgba(15,23,42,0.30)]">
          <figcaption className="sr-only">
            {t(
              "landingV2HeroCardCaption",
              "Preview of the BonBox owner dashboard. All figures are demo data.",
            )}
          </figcaption>

          {/* Greeting header */}
          <div className="flex items-start justify-between gap-[14px] border-b border-slate-200 px-[22px] pt-[18px] pb-4">
            <div>
              <div className={`${eyebrow} mb-1 tracking-[0.15em]`}>
                {t("landingV2HeroCardEyebrow", "Home")}
              </div>
              <div className="font-display text-[23px] font-bold tracking-[-0.026em] text-slate-900">
                {t("landingV2HeroCardGreeting", "Good morning")}
              </div>
              <div className="mt-0.5 text-[12.5px] text-slate-500">
                {t("landingV2HeroCardDate", "Monday, 27 July 2026")}
              </div>
            </div>
            <div className="flex flex-none gap-2">
              <span className="whitespace-nowrap rounded-full bg-slate-900 px-[13px] py-2 text-[12.5px] font-medium text-white">
                {t("landingV2HeroCardQuickSale", "+ Quick Sale")}
              </span>
              <span className="whitespace-nowrap rounded-full border border-slate-200 px-[13px] py-2 text-[12.5px] font-medium text-slate-900">
                {t("landingV2HeroCardSnapReceipt", "Snap receipt")}
              </span>
            </div>
          </div>

          {/* Needs you now */}
          <div className="border-b border-slate-200 px-[22px] py-[14px]">
            <div className={`${eyebrow} mb-2`}>
              {t("landingV2HeroCardNeedsYouNow", "Needs you now")}
            </div>
            <div className="flex items-center gap-[11px]">
              <span
                aria-hidden="true"
                className="h-2 w-2 flex-none rounded-full bg-red-500"
              />
              <span className="flex-1 text-[14px] leading-[1.4] text-slate-900">
                {t(
                  "landingV2HeroCardAlert",
                  "The 20/07 lukning doesn't tie out — payments 0,00 kr. ≠ omsætning 24.022,00 kr.",
                )}
              </span>
              <span className="flex flex-none items-center whitespace-nowrap text-[13px] font-semibold text-slate-900">
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

          {/* Metric strip */}
          <div className="grid grid-cols-1 min-[861px]:grid-cols-3">
            <div
              className={`${cardCell} min-[861px]:border-r min-[861px]:border-slate-200`}
            >
              <div className={metricLabel}>
                {t("landingV2HeroCardRevenueLabel", "Revenue so far")}
              </div>
              <div className={metricValue}>
                6.240<span className={metricUnit}> {t("landingV2HeroKr", "kr.")}</span>
              </div>
              <div className="mt-[3px] text-[12.5px] text-slate-500">
                {t("landingV2HeroCardSalesToday", "18 sales today")}
              </div>
            </div>
            <div
              className={`${cardCell} border-t border-slate-200 min-[861px]:border-t-0 min-[861px]:border-r`}
            >
              <div className={metricLabel}>
                {t("landingV2HeroCardWeekLabel", "This week")}
              </div>
              <div className={metricValue}>
                41.180<span className={metricUnit}> {t("landingV2HeroKr", "kr.")}</span>
              </div>
              <div className="mt-[3px] text-[12.5px] font-medium text-bb-green">
                {t("landingV2HeroCardWeekDelta", "+12% vs last week")}
              </div>
            </div>
            <div className={`${cardCell} border-t border-slate-200 min-[861px]:border-t-0`}>
              <div className={metricLabel}>
                {t("landingV2HeroCardMonthLabel", "This month")}
              </div>
              <div className={metricValue}>
                223.022
                <span className={metricUnit}> {t("landingV2HeroKr", "kr.")}</span>
              </div>
              <div className="mt-[3px] text-[12.5px] text-slate-500">
                {t("landingV2HeroCardMargin", "82% margin")}
              </div>
            </div>
          </div>

          {/* MOMS card */}
          <div className="mx-[18px] my-4 flex items-center justify-between gap-[14px] rounded-xl border border-slate-200 px-4 py-[14px]">
            <div>
              <div className={`${eyebrow} mb-[5px]`}>
                {t("landingV2HeroCardMomsEyebrow", "MOMS · H1 2026 · in 36 days")}
              </div>
              <div className="text-[15px] font-semibold text-slate-900">
                {t(
                  "landingV2HeroCardMomsSetAside",
                  "Set aside ~17.800 kr./week to cover MOMS",
                )}
              </div>
              <div className="mt-[3px] text-[12.5px] text-slate-500">
                {t("landingV2HeroCardMomsDue", "~88.777 kr. due 1 Sept 2026")}
              </div>
            </div>
            <ChevronRight
              aria-hidden="true"
              size={18}
              strokeWidth={1.75}
              className="flex-none text-slate-400"
            />
          </div>

          {/* On shift */}
          <div className="mx-[18px] mb-4 flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-[14px]">
            <span className={`${eyebrow} flex-none`}>
              {t("landingV2HeroCardOnShift", "On shift")}
            </span>
            <span className="text-[14.5px] text-slate-900">
              {t("landingV2HeroCardOnShiftName", "Agnes Kristensen")} ·{" "}
              <span className="text-slate-500">
                {t("landingV2HeroCardOnShiftRole", "server, 16:00–23:00")}
              </span>
            </span>
            <span className="ml-auto flex items-center whitespace-nowrap text-[13px] font-semibold text-slate-900">
              {t("landingV2HeroCardScheduleAction", "Vagtplan")}
              <ChevronRight
                aria-hidden="true"
                size={14}
                strokeWidth={1.75}
                className="ml-0.5"
              />
            </span>
          </div>

          {/* Profit footer */}
          <div className="border-t border-slate-200 bg-slate-50 px-[22px] pt-4 pb-[18px]">
            <div className="mb-[11px] flex flex-wrap items-baseline gap-2.5">
              <span className="text-[13px] text-slate-500">
                {t("landingV2HeroCardProfitLabel", "Profit this month")}
              </span>
              <span className="font-display text-[20px] font-bold tracking-[-0.02em] tabular-nums text-slate-900">
                {t("landingV2HeroCardProfitValue", "182.304 kr.")}
              </span>
              <span className="text-[12.5px] font-semibold text-bb-green">
                {t("landingV2HeroCardProfitDelta", "+94% vs. Jun")}
              </span>
            </div>
            <div
              aria-hidden="true"
              className="flex h-2.5 overflow-hidden rounded-full"
            >
              <span className="bg-red-500" style={{ width: "18%" }} />
              <span className="bg-bb-green" style={{ width: "82%" }} />
            </div>
            <div className="mt-[9px] flex justify-between gap-3 text-[12px]">
              <span className="text-red-700">
                {t("landingV2HeroCardExpensesLegend", "40.718 kr. to expenses")}
              </span>
              <span className="text-bb-green-dark">
                {t("landingV2HeroCardYoursLegend", "182.304 kr. is yours")}
              </span>
            </div>
          </div>
        </figure>
      </div>
      </div>
    </section>
  );
}
