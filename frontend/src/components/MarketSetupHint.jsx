/**
 * Why the market comparison is locked when the postcode and the cuisine are
 * already set. The server's `setup_hint` (reason stays "needs_setup" for old
 * builds) names exactly what is missing, so the copy never blames the
 * address when only the CVR check is missing (review P1, 12 Nov 2026):
 *
 *   address_unverified              the address is not checked in
 *                                   Danmarks Adresseregister
 *   company_unverified              the company is not confirmed in CVR
 *   address_and_company_unverified  both
 *
 * Both fixes live in Profile's company section (Business Registration: the
 * company lookup and the address), so there is ONE "Open Profile →" link,
 * straight to #business. The sentence itself does not say "Open Profile"
 * too (it used to, twice in a row).
 *
 * Any other hint (none, or one a newer server adds) renders `fallback`:
 * the caller's old "Add your postal code and cuisine…" copy.
 */
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

export default function MarketSetupHint({ hint, fallback = null, linkClassName = "font-semibold underline" }) {
  const { t } = useLanguage();
  let text;
  if (hint === "address_unverified") {
    text = t(
      "pricingAddressUnverified",
      "Market comparison needs your address checked in Danmarks Adresseregister. Under Business Registration, look up your company again, or correct the street, number and postcode.",
    );
  } else if (hint === "company_unverified") {
    text = t(
      "pricingCompanyUnverified",
      "Market comparison needs your company confirmed in the CVR register. Under Business Registration, look up your company by name or CVR number.",
    );
  } else if (hint === "address_and_company_unverified") {
    text = t(
      "pricingAddressCompanyUnverified",
      "Market comparison needs your company confirmed in the CVR register and your address checked in Danmarks Adresseregister. Under Business Registration, look up your company: that checks both.",
    );
  } else {
    return fallback;
  }
  return (
    <>
      <span data-testid="pricing-setup-hint" data-hint={hint}>{text}</span>{" "}
      <Link to="/profile#business" className={linkClassName} data-testid="pricing-address-hint-link">
        {t("openProfile", "Open Profile →")}
      </Link>
    </>
  );
}
