import { useLanguage } from "../../../hooks/useLanguage";

/**
 * Landing v2 — "Access" section.
 * Left: eyebrow + h2 + body. Right: five role rows (150px / 1fr).
 * Fix-list #2 applied to the BonBox row: no "EU provider" / "EU-hosted" claim.
 */
export default function AccessV2() {
  const { t } = useLanguage();

  const rows = [
    {
      key: "staff",
      role: t("landingV2.access.staff.role", "Staff"),
      detail: t(
        "landingV2.access.staff.detail",
        "Their own shifts, hours and payslip estimate. Submits the close — doesn't see the takings."
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
      detail: t(
        "landingV2.access.revisor.detail",
        "Exactly the months you send, as PDF and CSV. No account, no subscription."
      ),
    },
    {
      key: "bonbox",
      role: t("landingV2.access.bonbox.role", "BonBox"),
      detail: t(
        "landingV2.access.bonbox.detail",
        "Database in Ireland. Receipt images are read in the US under EU-approved transfer rules, and every processor is named in the privacy policy. We don't sell your data and we don't train models on your books."
      ),
    },
  ];

  return (
    <section
      id="access"
      aria-labelledby="access-heading"
      className="border-t border-slate-200 bg-slate-50"
    >
      <div className="mx-auto w-full max-w-[1800px] px-[clamp(24px,4vw,80px)] py-[clamp(52px,6vw,88px)]">
        <div className="grid grid-cols-1 gap-10 min-[1041px]:grid-cols-[minmax(0,0.74fr)_minmax(0,1.26fr)] min-[1041px]:gap-[clamp(32px,5vw,64px)]">
          <div>
            <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {t("landingV2.access.eyebrow", "Access")}
            </div>
            <h2
              id="access-heading"
              className="mb-4 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] text-slate-900"
            >
              {t("landingV2.access.title", "Who sees what.")}
            </h2>
            <p className="max-w-[34ch] text-[16.5px] text-slate-600">
              {t(
                "landingV2.access.body",
                "Revenue belongs to the owner. The person locking up doesn't need to see it to do their job."
              )}
            </p>
          </div>

          <div className="grid gap-0">
            {rows.map((row, i) => (
              <div
                key={row.key}
                className={`grid grid-cols-[150px_1fr] gap-6 border-t border-slate-200 py-5 max-[620px]:grid-cols-1 max-[620px]:gap-1 ${
                  i === rows.length - 1 ? "border-b border-slate-200" : ""
                }`}
              >
                <span className="font-display text-[17px] font-semibold tracking-[-0.01em] text-slate-900">
                  {row.role}
                </span>
                <span className="text-[15.5px] text-slate-600">
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
