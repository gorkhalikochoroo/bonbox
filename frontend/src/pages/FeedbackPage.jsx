import { useLanguage } from "../hooks/useLanguage";
import { OPEN_SUPPORT_EVENT } from "../components/SupportChip";

/**
 * FeedbackPage — retired dead-end, now a launcher into the ONE real channel.
 *
 * History: this page used to POST to /feedback (rating + category + message),
 * a table nothing ever read — no admin route, no email, no reply. A textbook
 * dead-end CTA. It now funnels into the SupportChip → /support/tickets flow,
 * which emails the founder and can be replied to. The /feedback route stays
 * registered so old bookmarks / More-grid / Cmd-K entries keep working; they
 * just land here and open the real composer.
 */
export default function FeedbackPage() {
  const { t } = useLanguage();

  const openComposer = () => {
    window.dispatchEvent(new Event(OPEN_SUPPORT_EVENT));
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6 sm:p-8 text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xl font-bold mb-4">
          ?
        </div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
          {t("feedbackLaunchTitle") || "Got feedback or found a bug?"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
          {t("feedbackLaunchBody") ||
            "Tell us anything — a bug, an idea, a question. It goes straight to the founder, and we reply by email."}
        </p>
        <button
          type="button"
          onClick={openComposer}
          className="px-5 py-2.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold transition"
        >
          {t("feedbackLaunchCta") || "Write to us"}
        </button>
        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-4">
          {t("supportSubtitle") || "Goes straight to the founder. We'll reply by email."}
        </p>
      </div>
    </div>
  );
}
