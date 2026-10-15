import { useLanguage } from "../../../hooks/useLanguage";
import { TEXT, WIDE, WIDE_PY } from "./fluid";

/**
 * Landing v2 — "Access" section.
 * Left: eyebrow + h2 + body. Right: five role rows (150px / 1fr).
 * Fix-list #2 applied to the BonBox row: no "EU provider" / "EU-hosted" claim.
 *
 * Push 9 (A5): the BonBox row says what the privacy policy says about where
 * receipt images are read — by Anthropic (receipt_ocr / claude_vision_ocr) or
 * another listed provider, location NOT confirmed — instead of "read in the
 * US", which the privacy policy does not claim. The staff row no longer
 * promises a "payslip estimate": staff see their shifts and hours; BonBox
 * does not do payroll.
 * Phone (below 621px): the role sits over its detail and the detail takes
 * the full width (push 9 review: beside a 92px role column the five rows ran
 * 786-873 px, the densest block on the phone page). All five rows stay.
 */
export default function AccessV2() {
  const { t } = useLanguage();

  const rows = [
    {
      key: "staff",
      role: t("landingV2.access.staff.role", "Staff"),
      detail: t(
        "landingV2.access.staff.detail",
        "Their own shifts and hours. Submits the kasserapport — doesn't see the takings."
      ),
    },
    {
      key: "manager",
      role: t("landingV2.access.manager.role", "Manager"),
      detail: t(
        "landingV2.access.manager.detail",
        "Builds and publishes the rota, approves hours, handles the floor and the booking book."
      ),
    },
    {
      key: "owner",
      role: t("landingV2.access.owner.role", "Owner"),
      detail: t(
        "landingV2.access.owner.detail",
        "Everything. Approves the evening, corrects a difference, exports the quarter."
      ),
    },
    {
      key: "revisor",
      role: t("landingV2.access.revisor.role", "Revisor"),
      detail: t("landingV2.access.revisor.detail",
        "Exactly the months you send, as PDF and CSV — plus a free read-only login from Starter. Never a subscription of their own."
      ),
    },
    {
      key: "bonbox",
      role: t("landingV2.access.bonbox.role", "BonBox"),
      detail: t(
        "landingV2.access.bonbox.detail",
        "Database in Ireland. Receipt images are read by our AI provider, Anthropic, or another provider listed in the privacy policy — where they process them is not yet confirmed. We don't sell your data and we don't train models on your books."
      ),
    },
  ];

  return (
    <section
      id="access"
      aria-labelledby="access-heading"
      className="border-t border-slate-200 bg-slate-50"
    >
      <div className={`mx-auto w-full max-w-[1180px] px-[clamp(24px,4vw,64px)] py-[clamp(52px,6vw,88px)] max-sm:py-10 ${WIDE} ${WIDE_PY}`}>
        {/* Column gap 48px (x --lx above 1440), not the 64 the other bands
            use: this column is one short paragraph, and as the screen
            widens faster than its type grows (./fluid.js) its longest line
            ends up to a word short of the column. At 64 that pushed the
            empty space before the rows past 7% of the screen near 2000px. */}
        <div className="grid grid-cols-1 gap-6 sm:gap-10 min-[1041px]:grid-cols-[minmax(0,0.66fr)_minmax(0,1.34fr)] min-[1041px]:gap-[clamp(32px,3.34vw,48px)] min-[1441px]:gap-[calc(48px*var(--lx))]">
          <div className={TEXT}>
            <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {t("landingV2.access.eyebrow", "Access")}
            </div>
            <h2
              id="access-heading"
              className="mb-4 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] text-slate-900"
            >
              {t("landingV2.access.title", "Who sees what.")}
            </h2>
            {/* 34ch on a phone. From 1041px it runs to the rows beside it
                (0.66fr / 1.34fr, was 0.74 / 1.26): capped at 34ch it left
                ~250px empty before the rows at 1920px. */}
            <p className="max-w-[34ch] text-[16.5px] text-slate-600 max-sm:hidden min-[1041px]:max-w-none">
              {t(
                "landingV2.access.body",
                "Revenue belongs to the owner. The person locking up doesn't need to see it to do their job."
              )}
            </p>
          </div>

          <div className={`grid gap-0 ${TEXT}`}>
            {rows.map((row, i) => (
              <div
                key={row.key}
                className={`grid grid-cols-[150px_1fr] gap-6 border-t border-slate-200 py-5 max-[620px]:grid-cols-1 max-[620px]:gap-0.5 max-[620px]:py-3 ${
                  i === rows.length - 1 ? "border-b border-slate-200" : ""
                }`}
              >
                <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-slate-900 min-[621px]:text-[17px]">
                  {row.role}
                </span>
                <span className="text-[14.5px] text-slate-600 min-[621px]:text-[15.5px]">
                  {row.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
