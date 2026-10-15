import React from "react";
import {
  Receipt,
  Calendar,
  Users,
  Timer,
  Package,
  CreditCard,
} from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";
import { TEXT_CHILDREN, WIDE, WIDE_PY } from "./fluid";

/**
 * Landing v2 — "Six jobs. One system." module grid.
 * 3 columns, 2 at <=1040px, 1 at <=620px (matches the design's media queries).
 *
 * Push 9 (D): below 621px the six cards are a compact list — icon beside the
 * title, hairlines between rows, no card boxes — so the six jobs take about a
 * screen on a phone instead of two. Same six jobs, same words; from 621px up
 * the cards render exactly as before.
 *
 * Copy (A1, A5): "Timer & løn" is now "Timer" — BonBox tracks hours and
 * exports them to whoever runs payroll; it does not run payroll. Money no
 * longer says "arkiveret" (BonBox is not the archive — Terms § 4). Daily
 * close says that several tills are added together, which every plan does.
 */
export default function ModulesV2() {
  const { t } = useLanguage();

  const modules = [
    {
      key: "close",
      Icon: Receipt,
      title: t("landingV2.modules.close.title", "Daily close"),
      body: t(
        "landingV2.modules.close.body",
        "Photograph the Z-report and BonBox reads it, adds several tills together and makes the day's kasserapport as a PDF. Differences are flagged, not guessed."
      ),
      short: t("landingV2.modules.close.short", "Photo of the Z-report → the day's kasserapport as a PDF."),
    },
    {
      key: "reservations",
      Icon: Calendar,
      title: t("landingV2.modules.reservations.title", "Reservations"),
      body: t(
        "landingV2.modules.reservations.body",
        "Booking book, floor plan, waitlist, and a public page guests book through. No account needed to reserve."
      ),
      short: t("landingV2.modules.reservations.short", "Your own booking page, floor plan and waitlist."),
    },
    {
      key: "schedule",
      Icon: Users,
      title: t("landingV2.modules.schedule.title", "Schedule"),
      body: t(
        "landingV2.modules.schedule.body",
        "Build the week as drafts, check it against forecast and demand, publish once. Staff see it in Vagtplan on their phone."
      ),
      short: t("landingV2.modules.schedule.short", "Build the week, publish it — staff see it on their phone."),
    },
    {
      key: "hours",
      Icon: Timer,
      title: t("landingV2.modules.hours.title", "Hours"),
      body: t(
        "landingV2.modules.hours.body",
        "Staff clock in and out; hours are approved and exported for whoever runs your payroll. Wage cost as a share of sales, and a warning before the 11-hour or 48-hour rule is broken."
      ),
      short: t("landingV2.modules.hours.short", "Clock-in, approved hours, export for whoever runs payroll."),
    },
    {
      key: "stock",
      Icon: Package,
      title: t("landingV2.modules.stock.title", "Stock"),
      body: t(
        "landingV2.modules.stock.body",
        "Inventory, expiry forecast and a waste tracker — so the milk that goes out on Thursday shows up in Thursday's numbers."
      ),
      short: t("landingV2.modules.stock.short", "Stock, expiry and waste in the day's numbers."),
    },
    {
      key: "money",
      Icon: CreditCard,
      title: t("landingV2.modules.money.title", "Money"),
      body: t(
        "landingV2.modules.money.body",
        "MOMS countdown, invoices, receipt reading, gavekort and expenses — in one place, ready to send to your revisor."
      ),
      short: t("landingV2.modules.money.short", "MOMS countdown, invoices, receipts and gavekort."),
    },
  ];

  return (
    <section
      id="modules"
      className="border-t border-slate-200 bg-white text-slate-900"
    >
      <div className={`mx-auto w-full max-w-[1180px] px-[clamp(24px,4vw,64px)] py-[clamp(52px,6vw,88px)] max-sm:py-10 ${WIDE} ${WIDE_PY} ${TEXT_CHILDREN}`}>
        {/* From 1041px the heading and the intro sit side by side on the
            card grid's three columns (heading over the first two, intro
            over the third) instead of the intro stopping at 58ch with the
            rest of the row empty. Below 1041px this is a plain block and
            renders exactly as the stacked version did. */}
        <div className="min-[1041px]:mb-11 min-[1041px]:grid min-[1041px]:grid-cols-3 min-[1041px]:items-end min-[1041px]:gap-x-5">
          <div className="min-[1041px]:col-span-2">
            <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {t("landingV2.modules.eyebrow", "What's inside")}
            </div>

            <h2 className="mb-6 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] sm:mb-3 min-[1041px]:mb-0">
              {t("landingV2.modules.heading", "Six jobs. One system.")}
            </h2>
          </div>

          <p className="mb-11 max-w-[58ch] text-[17px] text-slate-600 max-sm:hidden min-[1041px]:mb-0 min-[1041px]:max-w-none">
            {t(
              "landingV2.modules.intro",
              "Most places run a POS, a booking site, a spreadsheet for the rota and a shoebox for receipts. BonBox is the layer that ties the evening together."
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 border-t border-slate-200 min-[621px]:gap-5 min-[621px]:border-t-0 min-[621px]:grid-cols-2 min-[1041px]:grid-cols-3">
          {modules.map((mod) => (
            <div
              key={mod.key}
              className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 border-b border-slate-200 py-3 min-[621px]:block min-[621px]:rounded-2xl min-[621px]:border min-[621px]:bg-white min-[621px]:p-6"
            >
              <div className="row-span-2 flex h-8 w-8 items-center justify-center rounded-[10px] bg-bb-green-icon min-[621px]:mb-4 min-[621px]:h-[38px] min-[621px]:w-[38px] min-[621px]:rounded-[11px]">
                <mod.Icon
                  size={19}
                  strokeWidth={1.75}
                  className="text-bb-green"
                  aria-hidden="true"
                />
              </div>
              <div className="mb-0.5 font-display text-[16.5px] font-bold tracking-[-0.015em] min-[621px]:mb-[7px] min-[621px]:text-[18px]">
                {mod.title}
              </div>
              {/* Phone: one short line; from 621px: the full description. */}
              <p className="text-[14.5px] leading-[1.45] text-slate-600 min-[621px]:hidden">{mod.short}</p>
              <p className="text-[15px] text-slate-600 max-[620px]:hidden">{mod.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
