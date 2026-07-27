import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../../hooks/useLanguage";

/**
 * Landing v2 — "Pricing" section.
 * Heading block, then a 3-column plan grid (1 column under 980px), items start.
 * Starter is the only highlighted card: 1.5px green-600 border, green glow,
 * "Most popular" badge and a 44px price figure (Free/Pro are 38px).
 *
 * Fix-list applied:
 *  #4 — the three "≈ N hours saved" lines are deleted (nothing measures them).
 *  #6 — only Starter carries the "Most popular" badge; Pro's badge and its
 *       green highlight border/glow are removed so one card is the hero.
 *  #7 — tier caps left exactly as verified against backend billing.py.
 *  #8 — 0 / 129 (was 199) / 249 (was 349), per business, ex MOMS.
 *  #9 — no "bookkeeping system" / "digital bogføring" wording anywhere.
 */

function Feature({ children }) {
  return (
    <div className="flex gap-2.5">
      <Check
        size={15}
        strokeWidth={1.75}
        aria-hidden="true"
        className="mt-[3px] shrink-0 text-bb-green"
      />
      <span>{children}</span>
    </div>
  );
}

export default function PricingV2() {
  const { t } = useLanguage();

  const eyebrow =
    "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400";
  const position =
    "font-display text-[19px] font-semibold leading-[1.3] tracking-[-0.015em] text-slate-900 min-h-[2.6em] mb-[22px]";
  const featureList =
    "grid gap-[11px] text-[14.5px] leading-[1.45] text-slate-700";
  const trialNote =
    "rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-[9px] text-[13px] text-slate-600 mb-[18px]";
  const plusLabel =
    "text-[13.5px] font-semibold text-slate-900 mb-[14px]";
  const ctaBase =
    "block rounded-xl px-5 text-center text-[15px] font-medium mb-6 transition-colors duration-150";

  return (
    <section
      id="pricing"
      aria-labelledby="pricing-heading"
      className="border-t border-slate-200 bg-white"
    >
      <div className="mx-auto w-full px-[clamp(24px,4vw,80px)] py-[clamp(52px,6vw,88px)]">
        <div className="mb-10 max-w-[54ch]">
          <div className={`${eyebrow} mb-4`}>
            {t("landingV2.pricing.eyebrow", "Pricing")}
          </div>
          <h2
            id="pricing-heading"
            className="mb-[14px] font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] text-slate-900"
          >
            {t(
              "landingV2.pricing.headline",
              "129 kr/month — for the first 100 businesses."
            )}
          </h2>
          <p className="text-[17px] text-slate-600">
            {t(
              "landingV2.pricing.subhead",
              "That price stays with you for as long as you're a customer. 199 kr after that."
            )}
          </p>
        </div>

        <div className="grid grid-cols-3 items-start gap-5 max-[980px]:grid-cols-1">
          {/* ---------------------------------------------------------- Free */}
          <div className="rounded-2xl border border-slate-200 bg-white px-[26px] pb-[30px] pt-7">
            <div className={`${eyebrow} mb-[14px]`}>
              {t("landingV2.pricing.free.name", "Free")}
            </div>
            <div className={position}>
              {t(
                "landingV2.pricing.free.position",
                "For closing the day and getting a kasserapport out."
              )}
            </div>
            <div className="mb-[22px] flex items-baseline gap-2">
              <span className="font-display text-[38px] font-extrabold tracking-[-0.03em] text-slate-900">
                {t("landingV2.pricing.free.price", "Free")}
              </span>
              <span className="text-sm text-slate-500">
                {t("landingV2.pricing.free.period", "forever")}
              </span>
            </div>
            <Link
              to="/login"
              className={`${ctaBase} bg-slate-100 py-[13px] text-slate-900 hover:bg-slate-200`}
            >
              {t("landingV2.pricing.free.cta", "Start free")}
            </Link>
            <div
              className={`${featureList} border-t border-slate-100 pt-5`}
            >
              <Feature>
                {t(
                  "landingV2.pricing.free.f1",
                  "30-second daily close"
                )}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.free.f2",
                  "AI daily brief with tap-to-action insights"
                )}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.free.f3",
                  "MOMS countdown — when SKAT is due, and roughly how much"
                )}
              </Feature>
              <Feature>
                {t("landingV2.pricing.free.f4", "Receipt OCR, 10 a month")}
              </Feature>
              <Feature>
                {t("landingV2.pricing.free.f5", "Sales & expense logging")}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.free.f6",
                  "1 user, 1 branch, 7 days of export history"
                )}
              </Feature>
            </div>
          </div>

          {/* ------------------------------------------------------- Starter */}
          <div
            className="rounded-2xl border-[1.5px] border-bb-green bg-white px-[26px] pb-[30px] pt-7"
            style={{ boxShadow: "0 16px 36px -22px rgba(22,163,74,0.40)" }}
          >
            <div className="mb-[14px] flex items-center justify-between gap-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-bb-green-dark">
                {t("landingV2.pricing.starter.name", "Starter")}
              </span>
              <span className="rounded-full bg-bb-green-tint px-[9px] py-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-bb-green-dark">
                {t("landingV2.pricing.starter.badge", "Most popular")}
              </span>
            </div>
            <div className={position}>
              {t(
                "landingV2.pricing.starter.position",
                "For sending fakturaer and letting the bank reconcile itself."
              )}
            </div>
            <div className="mb-[14px] flex flex-wrap items-baseline gap-2">
              <span className="font-display text-[44px] font-extrabold tracking-[-0.03em] text-slate-900">
                129
              </span>
              <span className="text-sm text-slate-500">
                {t("landingV2.pricing.perMonth", "DKK / mo")}
              </span>
              <span className="text-[13.5px] text-slate-400 line-through">
                199
              </span>
              <span className="rounded-full bg-slate-100 px-[9px] py-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                {t("landingV2.pricing.starter.foundingTag", "First 100")}
              </span>
            </div>
            <div className={trialNote}>
              {t(
                "landingV2.pricing.starter.trial",
                "14 days free · no card required · that price stays as long as you do"
              )}
            </div>
            <Link
              to="/login"
              className={`${ctaBase} bg-bb-green py-[14px] text-white hover:bg-bb-green-dark`}
            >
              {t("landingV2.pricing.starter.cta", "Start on Starter")}
            </Link>
            <div className={plusLabel}>
              {t(
                "landingV2.pricing.starter.plus",
                "Everything in Free, plus:"
              )}
            </div>
            <div className={featureList}>
              <Feature>
                {t(
                  "landingV2.pricing.starter.f1",
                  "Your revisor logs in free — read-only, audit-logged"
                )}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.starter.f2",
                  "Bank reconciliation from a netbank CSV"
                )}
              </Feature>
              <Feature>
                {t("landingV2.pricing.starter.f3", "Receipt OCR, 300 a month")}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.starter.f4",
                  "Faktura, up to 30 a month, with kreditnota flow"
                )}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.starter.f5",
                  "Schedule autopilot — forecast, weather and DK labour law"
                )}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.starter.f6",
                  "Kasserapport auto-emailed the moment staff lock the close"
                )}
              </Feature>
              <Feature>
                {t("landingV2.pricing.starter.f7", "Inventory expiry alerts")}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.starter.f8",
                  "3 team members with role permissions"
                )}
              </Feature>
            </div>
          </div>

          {/* ----------------------------------------------------------- Pro */}
          <div className="rounded-2xl border border-slate-200 bg-white px-[26px] pb-[30px] pt-7">
            <div className={`${eyebrow} mb-[14px]`}>
              {t("landingV2.pricing.pro.name", "Pro")}
            </div>
            <div className={position}>
              {t(
                "landingV2.pricing.pro.position",
                "For running several places from one login, under your own brand."
              )}
            </div>
            <div className="mb-[14px] flex flex-wrap items-baseline gap-2">
              <span className="font-display text-[38px] font-extrabold tracking-[-0.03em] text-slate-900">
                249
              </span>
              <span className="text-sm text-slate-500">
                {t("landingV2.pricing.perMonth", "DKK / mo")}
              </span>
              <span className="text-[13.5px] text-slate-400 line-through">
                349
              </span>
            </div>
            <div className={trialNote}>
              {t(
                "landingV2.pricing.pro.trial",
                "14 days free · no card required"
              )}
            </div>
            <Link
              to="/login"
              className={`${ctaBase} bg-bb-green py-[13px] text-white hover:bg-bb-green-dark`}
            >
              {t("landingV2.pricing.pro.cta", "Start on Pro")}
            </Link>
            <div className={plusLabel}>
              {t("landingV2.pricing.pro.plus", "Everything in Starter, plus:")}
            </div>
            <div className={featureList}>
              <Feature>
                {t("landingV2.pricing.pro.f1", "3 branches, 5 team members")}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.pro.f2",
                  "Multi-terminal close — every Z-report into one PDF"
                )}
              </Feature>
              <Feature>
                {t("landingV2.pricing.pro.f3", "Faktura, unlimited")}
              </Feature>
              <Feature>
                {t("landingV2.pricing.pro.f4", "Receipt OCR, 1.000 a month")}
              </Feature>
              <Feature>
                {t(
                  "landingV2.pricing.pro.f5",
                  "White-label faktura PDFs — your logo, not ours"
                )}
              </Feature>
              <Feature>
                {t("landingV2.pricing.pro.f7", "Priority email support")}
              </Feature>
            </div>
          </div>
        </div>

        <div className="mt-6 text-sm text-slate-500">
          {t(
            "landingV2.pricing.footnote",
            "No card. Cancel the same day. Prices are per business, ex MOMS. No lock-in, no setup fee, and never a percentage of what you take."
          )}
        </div>
      </div>
    </section>
  );
}
