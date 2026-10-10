import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

/**
 * SignupTermsLine — "Ved at oprette en konto accepterer du vores
 * Handelsbetingelser og Privatlivspolitik." with both documents linked.
 *
 * Release R-e (LEG-11 / PQ-03). The register page renders it ONCE, where
 * every sign-up path passes it: beside the Google/Apple row (those buttons
 * create the account without the form), or under "Opret konto" when there is
 * no such row. The requests sent from that page carry accept_terms=true, and
 * the server records the Terms version on the new account
 * (backend/app/services/terms.py). A path that does not show this line must
 * not send accept_terms — we never record an acceptance nobody saw.
 *
 * On the web the links open in a new tab, so the form stays as typed.
 */
export default function SignupTermsLine({ isNative = false, className = "" }) {
  const { t } = useLanguage();
  const template = t(
    "signupAcceptTerms",
    "By creating an account you accept our {terms} and {privacy}.",
  );
  const linkProps = isNative ? {} : { target: "_blank", rel: "noopener noreferrer" };
  return (
    <p
      data-testid="signup-terms-line"
      className={`text-center text-[12px] leading-relaxed text-gray-500 dark:text-gray-400 text-pretty ${className}`}
    >
      {template.split(/(\{terms\}|\{privacy\})/).map((part, i) => {
        if (part !== "{terms}" && part !== "{privacy}") return part;
        const isTerms = part === "{terms}";
        return (
          <Link
            key={i}
            to={isTerms ? "/terms" : "/privacy"}
            {...linkProps}
            className="underline underline-offset-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
          >
            {isTerms
              ? t("signupAcceptTermsLink", "Terms of Service")
              : t("signupAcceptPrivacyLink", "Privacy Policy")}
          </Link>
        );
      })}
    </p>
  );
}
