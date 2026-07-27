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

/**
 * Landing v2 — "Six jobs. One system." module grid.
 * 3 columns, 2 at <=1040px, 1 at <=620px (matches the design's media queries).
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
        "Every terminal's kasserapport photographed, read and merged into one signed PDF. Differences flagged, not guessed."
      ),
    },
    {
      key: "reservations",
      Icon: Calendar,
      title: t("landingV2.modules.reservations.title", "Reservations"),
      body: t(
        "landingV2.modules.reservations.body",
        "Booking book, floor plan, waitlist, and a public page guests book through. No account needed to reserve."
      ),
    },
    {
      key: "schedule",
      Icon: Users,
      title: t("landingV2.modules.schedule.title", "Schedule"),
      body: t(
        "landingV2.modules.schedule.body",
        "Build the week as drafts, check it against forecast and demand, publish once. Staff see it in the Scheduler app."
      ),
    },
    {
      key: "hours",
      Icon: Timer,
      title: t("landingV2.modules.hours.title", "Timer & løn"),
      body: t(
        "landingV2.modules.hours.body",
        "Clock in and out, labor as a share of sales, feriepenge included in the estimate. Overtime flagged before it happens."
      ),
    },
    {
      key: "stock",
      Icon: Package,
      title: t("landingV2.modules.stock.title", "Stock"),
      body: t(
        "landingV2.modules.stock.body",
        "Inventory, expiry forecast and a waste tracker — so the milk that goes out on Thursday shows up in Thursday's numbers."
      ),
    },
    {
      key: "money",
      Icon: CreditCard,
      title: t("landingV2.modules.money.title", "Money"),
      body: t(
        "landingV2.modules.money.body",
        "MOMS countdown, faktura, receipt OCR, gavekort and expenses — filed the way your revisor wants to receive them."
      ),
    },
  ];

  return (
    <section
      id="modules"
      className="border-t border-slate-200 bg-white text-slate-900"
    >
      <div className="mx-auto w-full max-w-[1800px] px-[clamp(24px,4vw,80px)] py-[clamp(52px,6vw,88px)]">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {t("landingV2.modules.eyebrow", "What's inside")}
        </div>

        <h2 className="mb-3 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em]">
          {t("landingV2.modules.heading", "Six jobs. One system.")}
        </h2>

        <p className="mb-11 max-w-[58ch] text-[17px] text-slate-600">
          {t(
            "landingV2.modules.intro",
            "Most places run a POS, a booking site, a spreadsheet for the rota and a shoebox for receipts. BonBox is the layer that ties the evening together."
          )}
        </p>

        <div className="grid grid-cols-1 gap-5 min-[621px]:grid-cols-2 min-[1041px]:grid-cols-3">
          {modules.map((mod) => (
            <div
              key={mod.key}
              className="rounded-2xl border border-slate-200 bg-white p-6"
            >
              <div className="mb-4 flex h-[38px] w-[38px] items-center justify-center rounded-[11px] bg-bb-green-icon">
                <mod.Icon
                  size={19}
                  strokeWidth={1.75}
                  className="text-bb-green"
                  aria-hidden="true"
                />
              </div>
              <div className="mb-[7px] font-display text-[18px] font-bold tracking-[-0.015em]">
                {mod.title}
              </div>
              <p className="text-[15px] text-slate-600">{mod.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
