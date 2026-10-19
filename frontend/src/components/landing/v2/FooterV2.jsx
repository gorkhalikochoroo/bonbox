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
 *     CVR 46417321, linked to the public register. The street address
 *     is deliberately NOT printed: it is a private home, and the CVR
 *     link resolves to the register, which carries it. A footer
 *     identity line is the one place on a marketing site that is legally
 *     load-bearing, so it matches the registry verbatim and is NOT
 *     translated — a registered name and address are not copy.
 *
 *  2. DATABEHANDLERAFTALE has no page behind it. The design points it at a
 *     dead href="#dpa", and it later pointed at /privacy — which is the
 *     privacy policy, not a data processing agreement: a link labelled
 *     "Databehandleraftale" that opens another document says something
 *     untrue (R-c round 2, P0-2 step 1). It is left out until the real DPA
 *     ships; nothing replaces it.
 *
 *  3. The legal links are real <Link>s, not anchors, so /terms and /privacy
 *     route in-app instead of reloading the bundle.
 *
 *  4. CONTACT (push 9, A4). A Kontakt link to /contact and the company
 *     address contact@bonbox.dk — the same address /contact, the Terms and
 *     the privacy policy give (ContactPage SUPPORT_EMAIL). The footer had no
 *     way to reach a person at all.
 *
 * The Danish document names (Handelsbetingelser, Privatlivspolitik) stay
 * Danish in every language: they are the names of specific Danish-law
 * documents, not UI chrome.
 */

import { Link } from "react-router-dom";
import BonBoxMark from "../../BonBoxMark";
import BonBoxWordmark from "../../BonBoxWordmark";
import { useLanguage } from "../../../hooks/useLanguage";
import { CookieSettingsButton } from "../../CookieConsent";
import { CHROME_CHILDREN, WIDE } from "./fluid";

// Registry values, not copy. Deliberately outside t().
//
// The RELATIONSHIP line above them is copy and does translate. Without it a
// reader sees "DukaanAI" in the footer of a site called BonBox and has to guess
// how the two connect — and anyone checking the CVR finds no BonBox in the
// register, because BonBox is the product, not the registered entity. Saying so
// plainly costs nothing, claims no rights in the name, and is the first thing
// anyone reviewing the site for impersonation would look for.
const LEGAL_LINES = [
  "DukaanAI v/Manoz Chaudhary",
  "CVR 46417321",
];

// Same address as pages/ContactPage.jsx SUPPORT_EMAIL (a test keeps the two
// equal). Not copy — an address.
const CONTACT_EMAIL = "contact@bonbox.dk";

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
    { href: "#staff", label: t("landingV2.footer.staffApp", "Vagtplan") },
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
    // (R-c round 2 — no "Databehandleraftale" link until a real DPA ships:
    // it opened the privacy policy, which is not a data processing
    // agreement. Nothing stands in its place.)
    {
      to: "/contact",
      label: t("landingV2.footer.contact", "Contact"),
    },
  ];

  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      {/* Same gutters as the bands above (./fluid.js); above 1440px the
          contents and spacing grow at the slower chrome scale (--lc). */}
      <div className={`mx-auto flex w-full max-w-[1180px] flex-wrap justify-between gap-9 px-[clamp(24px,4vw,64px)] pt-11 pb-9 ${WIDE} min-[1441px]:gap-[calc(36px*var(--lc))] min-[1441px]:pt-[calc(44px*var(--lc))] min-[1441px]:pb-[calc(36px*var(--lc))] ${CHROME_CHILDREN}`}>
        <div>
          <div className="mb-3 flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-bb-forest"
            >
              <BonBoxMark size={22} className="text-bb-paper" />
            </span>
            <BonBoxWordmark height={17} className="text-bb-forest" />
          </div>
          <address className="text-[13.5px] leading-[1.7] text-slate-600 not-italic">
            <span className="block">
              {t("landingV2.footer.operatedBy", "BonBox is a product of")}
            </span>
            {LEGAL_LINES.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              data-testid="footer-email"
              className="mt-1 inline-flex min-h-11 items-center text-slate-700 underline decoration-slate-300 underline-offset-4 transition-colors duration-150 hover:text-slate-900 min-[621px]:min-h-0"
            >
              {CONTACT_EMAIL}
            </a>
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
            {/* Reopens the cookie banner's drawer — the footer link its
                "change it anytime via the link in the footer" means. */}
            <CookieSettingsButton className={`${LINK_CLASS} text-left`} />
          </nav>
        </div>
      </div>

      <div className="border-t border-slate-200">
        <div className={`mx-auto w-full max-w-[1180px] px-[clamp(24px,4vw,64px)] py-4 text-[12.5px] text-slate-400 ${WIDE} min-[1441px]:py-[calc(16px*var(--lc))] min-[1441px]:text-[calc(12.5px*var(--lc))]`}>
          {t("landingV2.footer.copyright", "© 2026 BonBox · Made in Copenhagen")}
        </div>
      </div>
    </footer>
  );
}
