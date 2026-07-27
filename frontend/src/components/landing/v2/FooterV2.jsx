/**
 * FooterV2 — closing band of the v2 landing page.
 *
 * Ported from the design reference: 1px slate-200 hairline on top, slate-50
 * pane, logo tile + wordmark over the legal block on the left, two link
 * columns on the right, then a second hairline and the copyright strip.
 *
 * THREE DELIBERATE DEPARTURES FROM THE DESIGN
 *
 *  1. LEGAL IDENTITY. The design prints "BonBox v/Manoz Chaudhary" and drops
 *     the floor from the address. Both are wrong against the CVR registry.
 *     BonBox is the product; the registered business is DukaanAI, at
 *     Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby, CVR 46417321. A footer
 *     identity line is the one place on a marketing site that is legally
 *     load-bearing, so it matches the registry verbatim and is NOT
 *     translated — a registered name and address are not copy.
 *
 *  2. DATABEHANDLERAFTALE has no page behind it. The design points it at a
 *     dead href="#dpa". Rather than ship a link that goes nowhere, it points
 *     at /privacy, which does exist and does name the processors. It should
 *     be repointed the moment a real DPA page lands.
 *
 *  3. The legal links are real <Link>s, not anchors, so /terms and /privacy
 *     route in-app instead of reloading the bundle.
 *
 * The three Danish document names (Handelsbetingelser, Privatlivspolitik,
 * Databehandleraftale) stay Danish in every language: they are the names of
 * specific Danish-law documents, not UI chrome.
 */

import { Link } from "react-router-dom";
import { Receipt } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";

// Registry values, not copy. Deliberately outside t().
const LEGAL_LINES = [
  "DukaanAI v/Manoz Chaudhary",
  "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby",
  "CVR 46417321",
];

const LINK_CLASS =
  "text-slate-600 transition-colors duration-150 hover:text-slate-900";

export default function FooterV2() {
  const { t } = useLanguage();

  const sectionLinks = [
    { href: "#modules", label: t("landingV2.footer.product", "Product") },
    {
      href: "#reservations",
      label: t("landingV2.footer.reservations", "Reservations"),
    },
    { href: "#staff", label: t("landingV2.footer.staffApp", "Staff app") },
    { href: "#pricing", label: t("landingV2.footer.pricing", "Pricing") },
  ];

  const legalLinks = [
    {
      to: "/terms",
      label: t("landingV2.footer.terms", "Handelsbetingelser"),
    },
    {
      to: "/privacy",
      label: t("landingV2.footer.privacy", "Privatlivspolitik"),
    },
    {
      to: "/privacy",
      label: t("landingV2.footer.dpa", "Databehandleraftale"),
    },
  ];

  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto flex max-w-[1180px] flex-wrap justify-between gap-9 px-[clamp(24px,4vw,64px)] pt-11 pb-9">
        <div>
          <div className="mb-3 flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-bb-green"
            >
              <Receipt size={14} strokeWidth={1.75} className="text-white" />
            </span>
            <span className="font-display text-[18px] font-bold tracking-[-0.025em] text-slate-900">
              BonBox
            </span>
          </div>
          <address className="text-[13.5px] leading-[1.7] text-slate-600 not-italic">
            {LEGAL_LINES.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </address>
        </div>

        <div className="flex gap-14 text-[14.5px] max-[520px]:gap-9">
          <nav
            aria-label={t("landingV2.footer.sections", "Sections")}
            className="grid content-start gap-[9px]"
          >
            {sectionLinks.map((l) => (
              <a key={l.label} href={l.href} className={LINK_CLASS}>
                {l.label}
              </a>
            ))}
          </nav>

          <nav
            aria-label={t("landingV2.footer.legal", "Legal")}
            className="grid content-start gap-[9px]"
          >
            {legalLinks.map((l) => (
              <Link key={l.label} to={l.to} className={LINK_CLASS}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <div className="border-t border-slate-200">
        <div className="mx-auto max-w-[1180px] px-[clamp(24px,4vw,64px)] py-4 text-[12.5px] text-slate-400">
          {t("landingV2.footer.copyright", "© 2026 BonBox · Made in Copenhagen")}
        </div>
      </div>
    </footer>
  );
}
