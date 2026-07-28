import { Check } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";

/**
 * Landing v2 — "Gavekort" section.
 *
 * Full-width charcoal band. Left: eyebrow + h2 + body + a four-row spec
 * table (MOMS / Balance / Redeem / Outstanding). Right: two cards sharing a
 * 1600px perspective — a white "gavekort sold" receipt behind, and the
 * printed charcoal gavekort in front.
 *
 * Fix-list #3 applied: the legal identity on the printed card is the
 * registered business (DukaanAI v/Manoz Chaudhary), not the product name,
 * and the address carries the floor/door "4. 3.". BonBox stays as the brand
 * line only.
 *
 * Palette note: the charcoal/cream landing colours that have no token
 * (#A8A196, #2A2620, #7C766B, #5F5A52, #F5F1E8 as a *text* colour) are
 * written as Tailwind arbitrary values; the stock-Tailwind greens/slates on
 * the white card use their named classes.
 */
export default function GavekortV2() {
  const { t } = useLanguage();

  const specs = [
    {
      key: "moms",
      label: t("landingV2.gavekort.spec.moms.label", "MOMS"),
      value: t(
        "landingV2.gavekort.spec.moms.value",
        "Settled at redemption (MPV)"
      ),
    },
    {
      key: "balance",
      label: t("landingV2.gavekort.spec.balance.label", "Balance"),
      value: t(
        "landingV2.gavekort.spec.balance.value",
        "Tracked to the øre, part-redemption fine"
      ),
    },
    {
      key: "redeem",
      label: t("landingV2.gavekort.spec.redeem.label", "Redeem"),
      value: t(
        "landingV2.gavekort.spec.redeem.value",
        "Scan the QR, or type the code"
      ),
    },
    {
      key: "outstanding",
      label: t("landingV2.gavekort.spec.outstanding.label", "Outstanding"),
      value: t(
        "landingV2.gavekort.spec.outstanding.value",
        "On the report, where your revisor wants it"
      ),
    },
  ];

  return (
    <section
      id="gavekort"
      aria-labelledby="gavekort-heading"
      className="border-t border-slate-200 bg-charcoal text-[#F5F1E8]"
    >
      <div className="mx-auto w-full max-w-[1800px] px-[clamp(24px,4vw,80px)] py-[clamp(52px,6vw,88px)]">
        <div className="grid grid-cols-1 items-center gap-10 min-[1041px]:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] min-[1041px]:gap-[clamp(36px,5vw,64px)]">
          {/* ── Left: copy + spec table ─────────────────────────── */}
          <div>
            <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold">
              {t("landingV2.gavekort.eyebrow", "Gavekort")}
            </div>
            <h2
              id="gavekort-heading"
              className="mb-4 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] text-[#F5F1E8]"
            >
              {t("landingV2.gavekort.title", "Print it, or just send the code.")}
            </h2>
            <p className="mb-7 max-w-[42ch] text-[17px] leading-[1.55] text-[#A8A196]">
              {t(
                "landingV2.gavekort.body",
                "Sell a gavekort in three taps — 100 to 1.000 kr., paid by card, MobilePay or cash. The guest gets a QR on their phone; you can print the physical card across the counter. Same balance behind both."
              )}
            </p>

            <dl className="grid gap-0 border-t border-[#2A2620]">
              {specs.map((spec, i) => (
                <div
                  key={spec.key}
                  className={`flex justify-between gap-4 py-[14px] text-[15px] ${
                    i === specs.length - 1 ? "" : "border-b border-[#2A2620]"
                  }`}
                >
                  <dt className="text-[#A8A196]">{spec.label}</dt>
                  <dd className="m-0 text-right">{spec.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* ── Right: the two 3D cards ──────────────────────────── */}
          <div className="flex items-center justify-center py-4">
            <div className="relative h-[300px] w-[430px] origin-center [perspective:1600px] max-[620px]:origin-top max-[620px]:scale-[0.72] max-[620px]:-mb-[84px]">
              {/* Behind: the sale that produced the gavekort */}
              <div
                aria-hidden="true"
                className="absolute left-0 top-0 h-[206px] w-[352px] rounded-[14px] border border-slate-200 bg-white px-5 py-[18px] shadow-[0_28px_50px_-26px_rgba(0,0,0,0.85)] [transform:rotateY(-15deg)_rotateX(7deg)_rotateZ(-2deg)]"
              >
                <div className="mb-[14px] flex items-center gap-[9px]">
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-bb-green-tint">
                    <Check
                      className="h-3 w-3 text-bb-green"
                      strokeWidth={1.75}
                    />
                  </span>
                  <span className="text-[9.5px] font-semibold uppercase tracking-[0.15em] text-slate-400">
                    {t("landingV2.gavekort.sold.label", "Gavekort sold")}
                  </span>
                </div>
                <div className="font-display text-[30px] font-extrabold tracking-[-0.03em] text-slate-900">
                  {t("landingV2.gavekort.sold.amount", "300,00 kr.")}
                </div>
                <div className="mt-1 text-[12.5px] text-slate-500">
                  {t(
                    "landingV2.gavekort.sold.method",
                    "Paid with MobilePay · recorded"
                  )}
                </div>
              </div>

              {/* In front: the printed gavekort */}
              <div className="absolute bottom-0 right-0 flex min-h-[216px] w-[372px] flex-col rounded-[14px] border border-[rgba(201,169,97,0.34)] bg-charcoal-card px-5 py-[18px] shadow-[0_34px_60px_-24px_rgba(0,0,0,0.95)] [transform:rotateY(-15deg)_rotateX(7deg)]">
                <div className="flex items-start justify-between gap-[14px]">
                  <div className="flex items-center gap-[9px]">
                    <span
                      aria-hidden="true"
                      className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] border border-[rgba(201,169,97,0.55)] font-display text-[10px] font-bold text-gold"
                    >
                      BO
                    </span>
                    <div>
                      <div className="font-display text-[13.5px] font-bold tracking-[-0.01em] text-[#F5F1E8]">
                        {t("landingV2.gavekort.card.brand", "BonBox")}
                      </div>
                      {/* Fix #3 — registered business, verified against CVR */}
                      <div className="text-[9px] text-[#7C766B]">
                        {t(
                          "landingV2.gavekort.card.issuer",
                          "DukaanAI v/Manoz Chaudhary"
                        )}
                      </div>
                    </div>
                  </div>
                  <span className="whitespace-nowrap text-[8.5px] font-semibold uppercase tracking-[0.2em] text-gold">
                    {t("landingV2.gavekort.card.kind", "Gavekort")}
                  </span>
                </div>

                <div
                  aria-hidden="true"
                  className="mb-[10px] mt-5 h-[2px] w-[30px] bg-[#C9A961]"
                />

                <div className="flex items-baseline gap-[5px]">
                  <span className="font-display text-[44px] font-extrabold leading-none tracking-[-0.035em] text-[#F5F1E8]">
                    {t("landingV2.gavekort.card.value", "300")}
                  </span>
                  <span className="text-[15px] text-[#A8A196]">
                    {t("landingV2.gavekort.card.currency", "kr.")}
                  </span>
                </div>

                <div className="mt-auto flex items-end justify-between gap-4">
                  <div>
                    <div className="mb-[5px] text-[8px] font-semibold uppercase tracking-[0.2em] text-[#7C766B]">
                      {t("landingV2.gavekort.card.redeemLabel", "Indløs i butik")}
                    </div>
                    <div className="font-display text-[14px] font-semibold tracking-[0.12em] text-[#F5F1E8]">
                      {t("landingV2.gavekort.card.code", "GK-EGU8-DAL2-0")}
                    </div>
                    {/* Fix #3 — full registered address incl. floor/door */}
                    <div className="mt-[5px] text-[8px] leading-[1.5] tracking-[0.06em] text-[#5F5A52]">
                      {t(
                        "landingV2.gavekort.card.address",
                        "København"
                      )}
                    </div>
                    <div className="text-[8px] leading-[1.5] tracking-[0.06em] text-[#5F5A52]">
                      {t(
                        "landingV2.gavekort.card.cvr",
                        "CVR 46417321 · Ingen udløbsdato"
                      )}
                    </div>
                  </div>

                  {/*
                    Decorative QR placeholder only — this pattern is drawn, it
                    encodes nothing and does not scan. The real printed
                    gavekort PDF carries a signed BB1.G QR generated
                    server-side (build_gavekort_pdf).
                  */}
                  <svg
                    width="64"
                    height="64"
                    viewBox="0 0 64 64"
                    aria-hidden="true"
                    focusable="false"
                    className="flex-none"
                  >
                    <rect width="64" height="64" rx="5" fill="#FFFFFF" />
                    <g fill="#14120E">
                      {Array.from({ length: 11 }, (_, i) => (
                        <rect
                          key={`v${i}`}
                          x={i * 6}
                          y="0"
                          width="3"
                          height="64"
                        />
                      ))}
                      {Array.from({ length: 11 }, (_, i) => (
                        <rect
                          key={`h${i}`}
                          x="0"
                          y={i * 6}
                          width="64"
                          height="3"
                        />
                      ))}
                      <rect x="5" y="5" width="21" height="21" />
                      <rect x="38" y="5" width="21" height="21" />
                      <rect x="5" y="38" width="21" height="21" />
                    </g>
                    <g fill="#FFFFFF">
                      <rect x="8" y="8" width="15" height="15" />
                      <rect x="41" y="8" width="15" height="15" />
                      <rect x="8" y="41" width="15" height="15" />
                    </g>
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
