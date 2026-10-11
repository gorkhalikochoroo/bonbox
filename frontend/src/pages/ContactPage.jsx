import { useNavigate, useLocation, Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";

// /contact is the App Store Support URL for both iPhone apps, so a reviewer
// or a stranger opens it signed out, often as the first page of the visit.
// Brand release (Manoj, 11 Oct 2026): it shows the address the Terms and
// /privacy give (contact@bonbox.dk) and the registered name from the Terms
// (DukaanAI v/Manoz Chaudhary, CVR 46417321 — keep the three pages in step).
// No thesis framing and no claim we cannot back.
//
// The Feedback page sits behind the login, so its link is shown only to a
// signed-in visitor; everyone else writes to the e-mail address.
const PROVIDER_NAME = "DukaanAI v/Manoz Chaudhary";
const CVR = "46417321";
const SUPPORT_EMAIL = "contact@bonbox.dk";

export default function ContactPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const { user } = useAuth() || {};

  // Opened straight from the App Store there is no page to go back to, so
  // the arrow goes to the start page instead of doing nothing.
  const goBack = () => (location.key && location.key !== "default" ? navigate(-1) : navigate("/"));

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label={t("back", "Back")}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("contactSupportTitle", "Contact & Support")}</h1>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">{t("contactGetInTouch", "Get in Touch")}</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {t("contactGetInTouchBody", "Have questions, feedback, or need help? We'd love to hear from you.")}
        </p>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 rounded-lg flex items-center justify-center text-blue-600 dark:text-blue-400 text-lg" aria-hidden="true">
              @
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("email", "Email")}</p>
              <a href={`mailto:${SUPPORT_EMAIL}`} data-testid="contact-email" className="text-blue-600 dark:text-blue-400 hover:underline text-sm">
                {SUPPORT_EMAIL}
              </a>
            </div>
          </div>

          {user && (
            <div className="flex items-center gap-3" data-testid="contact-feedback">
              <div className="w-10 h-10 bg-purple-50 dark:bg-purple-900/30 rounded-lg flex items-center justify-center text-purple-600 dark:text-purple-400 text-lg" aria-hidden="true">
                *
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("contactInAppFeedback", "In-App Feedback")}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("contactUseThe", "Use the")} <Link to="/feedback" className="text-blue-600 dark:text-blue-400 hover:underline">{t("feedback", "Feedback")}</Link> {t("contactFeedbackPageHint", "page to rate features and share suggestions directly.")}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">{t("contactAboutBonbox", "About BonBox")}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t("contactAboutBody", "BonBox is made for small businesses in Denmark, such as cafés, bars and restaurants, and brings the daily close (kasserapport), reservations, the staff schedule, hours, stock and money together in one place.")}
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-3" data-testid="contact-provider">
          {t("contactProvidedBy", "BonBox is provided by {name}, CVR {cvr}.").split(/(\{name\}|\{cvr\})/).map((part, i) => {
            if (part === "{name}") return <strong key={i} className="font-semibold text-gray-700 dark:text-gray-300">{PROVIDER_NAME}</strong>;
            if (part === "{cvr}") {
              return (
                <a
                  key={i}
                  href={`https://datacvr.virk.dk/enhed/virksomhed/${CVR}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {CVR}
                </a>
              );
            }
            return part;
          })}
        </p>
      </div>
    </div>
  );
}
