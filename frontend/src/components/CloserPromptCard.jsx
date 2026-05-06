import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

/**
 * CloserPromptCard — first-class onboarding prompt that stakes the
 * two-actor segment in the product flow.
 *
 * The hidden problem we're solving: in multi-terminal hospitality, the
 * CLOSER (front-of-house) is not the OWNER. By prompting the owner to
 * name their closer right after sign-up, we model the actor split as a
 * structural product step — not just marketing copy.
 *
 * Render rules:
 *   • Auto-hides if the user already has a recipient tagged role="closer"
 *   • Auto-hides if the user explicitly dismisses (localStorage flag,
 *     so it doesn't pester them after they decide "just me")
 *   • Auto-hides while loading recipients (prevents flash of card on
 *     return visits)
 *
 * Three options offered:
 *   1. "I'll add my closer" → lightweight inline form (label + email)
 *      that POSTs to /output-channels with role="closer"
 *   2. "I close myself" → POSTs a recipient with role="closer" using
 *      the owner's own email + label so the data model is consistent
 *      ("owner is also the closer" is a valid segment configuration)
 *   3. "Skip for now" → sets the dismiss flag, hides the card
 *
 * No backend role-promotion needed: we use the existing OutputChannel
 * CRUD with the new `role` field (migration 009).
 */
const DISMISS_KEY = "bonbox.closerPrompt.dismissed";

export default function CloserPromptCard({ user }) {
  const { t } = useLanguage();
  const [recipients, setRecipients] = useState(null); // null = loading
  const [stage, setStage] = useState("intro"); // intro | form | done
  const [closerName, setCloserName] = useState("");
  const [closerEmail, setCloserEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  );

  useEffect(() => {
    let cancelled = false;
    api.get("/output-channels")
      .then((res) => {
        if (cancelled) return;
        setRecipients(Array.isArray(res.data) ? res.data : []);
      })
      .catch(() => {
        if (cancelled) return;
        setRecipients([]); // fail open — show the card so onboarding still happens
      });
    return () => { cancelled = true; };
  }, []);

  const hasCloser = useMemo(
    () => Array.isArray(recipients) && recipients.some((r) => r.role === "closer"),
    [recipients],
  );

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  async function saveCloser({ label, target }) {
    setSaving(true);
    setError("");
    try {
      const payload = {
        channel_type: "email",
        target,
        label: label || target,
        role: "closer",
        display_order: 0,
      };
      await api.post("/output-channels", payload);
      // Refetch once so subsequent renders see the closer and auto-hide
      try {
        const res = await api.get("/output-channels");
        setRecipients(Array.isArray(res.data) ? res.data : []);
      } catch {
        // best-effort — the create succeeded, so still mark done
      }
      setStage("done");
    } catch (e) {
      setError(
        e?.response?.data?.detail ||
          t("closerPromptSaveFailed") ||
          "Could not save — try again",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveSelfAsCloser() {
    if (!user?.email) {
      setError(t("closerPromptNoOwnerEmail") || "Your account email is missing");
      return;
    }
    await saveCloser({
      label: t("closerPromptSelfLabel") || "Me (I close myself)",
      target: user.email,
    });
  }

  async function saveSubmittedCloser(e) {
    e?.preventDefault?.();
    if (!closerEmail.trim()) {
      setError(t("closerPromptEmailRequired") || "Closer's email is required");
      return;
    }
    await saveCloser({
      label: closerName.trim() || closerEmail.trim(),
      target: closerEmail.trim(),
    });
  }

  // Hide while loading, if already configured, or if dismissed
  if (recipients === null) return null;
  if (hasCloser) return null;
  if (dismissed) return null;
  if (stage === "done") return null;

  return (
    <div className="mb-5 rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-gradient-to-br from-amber-50 to-orange-50/60 dark:from-amber-900/20 dark:to-orange-900/10 p-5 sm:p-6">
      <div className="flex items-start gap-3 mb-3">
        <div className="text-2xl shrink-0">👋</div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[15px] font-bold text-gray-900 dark:text-white">
            {t("closerPromptTitle") || "Who closes for you?"}
          </h3>
          <p className="text-[12.5px] text-gray-600 dark:text-gray-400 mt-1 leading-relaxed">
            {t("closerPromptBody") ||
              "In most hospitality businesses, front-of-house staff close out at end of shift — not the owner. Tell us who's closing so they get the daily-close confirmation. (Owner still gets the consolidated PDF.)"}
          </p>
        </div>
        <button
          onClick={dismiss}
          aria-label={t("dismiss") || "Dismiss"}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none px-1"
        >
          ×
        </button>
      </div>

      {stage === "intro" && (
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={() => setStage("form")}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition"
          >
            {t("closerPromptAddCloser") || "Add my closer"}
          </button>
          <button
            onClick={saveSelfAsCloser}
            disabled={saving}
            className="px-4 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition"
          >
            {saving
              ? (t("saving") || "Saving…")
              : (t("closerPromptIClose") || "I close myself")}
          </button>
          <button
            onClick={dismiss}
            className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
          >
            {t("closerPromptSkip") || "Skip for now"}
          </button>
        </div>
      )}

      {stage === "form" && (
        <form onSubmit={saveSubmittedCloser} className="mt-4 space-y-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300 mb-1.5">
              {t("closerPromptNameLabel") || "Closer's name"}
            </label>
            <input
              type="text"
              value={closerName}
              onChange={(e) => setCloserName(e.target.value)}
              placeholder={t("closerPromptNamePlaceholder") || "e.g. Caro, Lars, the bar manager"}
              maxLength={80}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 outline-none focus:ring-2 focus:ring-amber-300"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300 mb-1.5">
              {t("closerPromptEmailLabel") || "Email"}
            </label>
            <input
              type="email"
              value={closerEmail}
              onChange={(e) => setCloserEmail(e.target.value)}
              placeholder="caro@mirabelle.dk"
              maxLength={200}
              required
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 outline-none focus:ring-2 focus:ring-amber-300"
            />
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
              {t("closerPromptEmailHint") ||
                "They'll get a confirmation when each daily close is sent."}
            </p>
          </div>
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={saving || !closerEmail.trim()}
              className="flex-1 sm:flex-none px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition"
            >
              {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
            </button>
            <button
              type="button"
              onClick={() => { setStage("intro"); setError(""); }}
              className="px-5 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
            >
              {t("back") || "Back"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
