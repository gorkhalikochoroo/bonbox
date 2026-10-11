import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

/**
 * SignupTermsLine — the Terms acceptance line, with both documents linked.
 *
 *   variant="signup" (default, /register):
 *     "Ved at oprette en konto accepterer du vores Handelsbetingelser. Læs om,
 *      hvordan vi behandler dine data, i vores Privatlivspolitik."
 *   variant="continue" (/login — Google, Apple and the e-mail link can
 *   create an account there too):
 *     "Ved at fortsætte accepterer du vores Handelsbetingelser. Læs om, …"
 *
 * The Terms are ACCEPTED; the privacy policy is INFORMATION (GDPR Art. 13),
 * never something to accept — consent is not the legal basis.
 *
 * Release R-e (LEG-11 / PQ-03). A page renders it ONCE, where every sign-up
 * path passes it: beside the Google/Apple row (those buttons create the
 * account without the form), or under the submit button when there is no
 * such row. The requests sent from that page carry accept_terms=true, and
 * the server records the Terms version on a NEW account
 * (backend/app/services/terms.py). A path that does not show this line must
 * not send accept_terms — we never record an acceptance nobody saw.
 *
 * On the web the links open in a new tab, so the form stays as typed.
 */
const KEYS = {
  signup: ["signupAcceptTerms", "By creating an account you accept our {terms}. Read how we handle your data in our {privacy}."],
  continue: ["continueAcceptTerms", "By continuing you accept our {terms}. Read how we handle your data in our {privacy}."],
};

export default function SignupTermsLine({ isNative = false, variant = "signup", className = "" }) {
  const { t } = useLanguage();
  const [key, fallback] = KEYS[variant] || KEYS.signup;
  const template = t(key, fallback);
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

/**
 * CheckoutTermsLine — beside the Starter/Pro buttons on the subscription
 * page (R-e fix-up, P0-1):
 *   "Når du går videre til betaling, accepterer du vores Handelsbetingelser
 *    og bekræfter, at du køber abonnementet til din virksomhed."
 * The page renders it only where the button opens a real Stripe checkout,
 * and that request carries accept_terms=true; the server stamps the Terms
 * version on an account with none or an older one. It works whatever the
 * Stripe dashboard is set to (STRIPE_TOS_CONSENT is a second, optional
 * layer on Stripe's own page).
 */
export function CheckoutTermsLine({ className = "", testId = "checkout-terms-line" }) {
  const { t } = useLanguage();
  const template = t(
    "checkoutAcceptTerms",
    "By continuing to payment you accept our {terms} and confirm that you are buying the subscription for your business.",
  );
  return (
    <p
      data-testid={testId}
      className={`text-[11px] leading-snug text-gray-500 dark:text-gray-400 text-pretty ${className}`}
    >
      {template.split(/(\{terms\})/).map((part, i) =>
        part === "{terms}" ? (
          <Link
            key={i}
            to="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
          >
            {t("signupAcceptTermsLink", "Terms of Service")}
          </Link>
        ) : (
          part
        ),
      )}
    </p>
  );
}
