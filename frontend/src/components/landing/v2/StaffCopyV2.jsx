import { Check } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";
import AppStoreLink from "./AppStoreLink";
import { TEXT } from "./fluid";

export default function StaffCopyV2() {
  const { t } = useLanguage();

  const rows = [
    t(
      "landingV2.staff.row1",
      "See the published week and their own rostered hours"
    ),
    t(
      "landingV2.staff.row2",
      "Mark “can’t work”, request holiday and sick leave"
    ),
    t(
      "landingV2.staff.row3",
      "Swap shifts with a colleague, with the manager notified"
    ),
    t("landingV2.staff.row4", "Danish or English, per person"),
  ];

  // 58ch on a phone. From 1041px the grid column sets the width: the copy
  // grows slower than its column on wide screens (./fluid.js), so a 58ch
  // box would leave the check rows short of the phones. The paragraph keeps
  // its own 46ch.
  return (
    <div className={`max-w-[58ch] min-[1041px]:max-w-none ${TEXT}`}>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {t("landingV2.staff.eyebrow", "BonBox Vagtplan · iPhone")}
        </span>
        <AppStoreLink
          href="https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793"
          label={t("landingV2.appStore.scheduler", "Vagtplan on the App Store")}
        />
      </div>

      <h2 className="mb-4 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] text-slate-900">
        {t(
          "landingV2.staff.title",
          "Your team gets their own app. Not a group chat."
        )}
      </h2>

      <p className="mb-[30px] max-w-[46ch] text-[17px] text-slate-600">
        {t(
          "landingV2.staff.body",
          "Staff open Vagtplan and their week is right there — no login hassle, no clutter. They mark when they can’t work, request holiday, and see in the app when one of their shifts changes."
        )}
      </p>

      <div className="grid gap-0 border-t border-slate-200">
        {rows.map((row, i) => (
          <div
            key={row}
            className={`flex gap-[14px] py-[14px] ${
              i < rows.length - 1 ? "border-b border-slate-200" : ""
            }`}
          >
            <span className="mt-0.5 flex-none text-bb-green" aria-hidden="true">
              <Check size={17} strokeWidth={1.75} />
            </span>
            <span className="text-[15.5px] text-slate-900">{row}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
