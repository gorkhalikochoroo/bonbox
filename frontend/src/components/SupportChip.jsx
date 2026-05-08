/**
 * SupportChip — floating "?" button + modal for in-app support requests.
 *
 * Why this matters in v1:
 *   For the first 100 customers, Manoj IS the support team. Without
 *   an in-app channel, owners hit a friction point and silently churn
 *   instead of complaining. This chip routes their question/bug
 *   straight into a triage queue so we can answer (and learn).
 *
 * Calm UX:
 *   • Small "?" chip bottom-left so it doesn't fight QuickAdd or
 *     BonBoxAgent (which sit bottom-right). Out of the way until you
 *     need it.
 *   • Modal has 3 fields: kind (dropdown), short subject, longer body.
 *   • Auto-captures page URL + browser as `context` so the founder
 *     can triage without asking "where were you when this happened?"
 *   • Sends "✓ Sent — we'll reply by email" toast on success. No
 *     theatrics, no spinner-blocking.
 *
 * Multi-layer:
 *   • Field caps mirror the server (subject 140, body 5000, kind 40).
 *   • Auto-captured context is just navigator.userAgent + location.pathname
 *     — no PII beyond what the user types.
 *   • Server enforces 5/hour cap; on 429 we surface the message.
 */
import { useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";


const KIND_OPTIONS = [
  { id: "question", label: { en: "Question", da: "Spørgsmål" } },
  { id: "bug",      label: { en: "Something's broken", da: "Noget virker ikke" } },
  { id: "feature",  label: { en: "Feature idea", da: "Forslag" } },
  { id: "scan",     label: { en: "Scan / OCR issue", da: "Scanning" } },
  { id: "export",   label: { en: "Export / accountant", da: "Eksport / revisor" } },
  { id: "billing",  label: { en: "Billing / plan", da: "Betaling" } },
  { id: "other",    label: { en: "Other", da: "Andet" } },
];


export default function SupportChip() {
  const { t, lang } = useLanguage();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("question");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sentToast, setSentToast] = useState(false);

  const labelFor = (l) => (l && (l[lang] || l.en)) || "";

  function reset() {
    setKind("question");
    setSubject("");
    setBody("");
    setError("");
  }

  async function submit() {
    if (!subject.trim() || !body.trim()) {
      setError(t("supportNeedSubjectBody") || "Subject and message are both required.");
      return;
    }
    setSending(true);
    setError("");
    try {
      // Auto-context: where they are + browser
      const ctx = JSON.stringify({
        page: typeof window !== "undefined" ? window.location.pathname : null,
        ua: typeof navigator !== "undefined" ? (navigator.userAgent || "").slice(0, 500) : null,
        ts: new Date().toISOString(),
      });
      await api.post("/support/tickets", {
        kind,
        subject: subject.trim().slice(0, 140),
        body: body.trim().slice(0, 5000),
        context: ctx,
      });
      reset();
      setOpen(false);
      setSentToast(true);
      setTimeout(() => setSentToast(false), 4000);
    } catch (err) {
      setError(err?.response?.data?.detail || (t("supportSendFailed") || "Couldn't send. Try again."));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* Floating chip — bottom-left, restrained */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("supportChipAria") || "Get help / send feedback"}
        className="fixed bottom-5 left-5 z-40 w-11 h-11 rounded-full bg-gray-900/80 dark:bg-gray-700 hover:bg-gray-900 dark:hover:bg-gray-600 text-white text-lg font-bold shadow-lg flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        ?
      </button>

      {/* Sent toast */}
      {sentToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm shadow-lg"
        >
          ✓ {t("supportSentToast") || "Sent — we'll reply by email"}
        </div>
      )}

      {/* Modal */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700/60 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {t("supportTitle") || "How can we help?"}
                </h2>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  {t("supportSubtitle") || "Goes straight to the founder. We'll reply by email."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("close") || "Close"}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 w-8 h-8 inline-flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div>
                <label htmlFor="support-kind" className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                  {t("supportKind") || "What kind?"}
                </label>
                <select
                  id="support-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 focus:border-emerald-400 outline-none"
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k.id} value={k.id}>{labelFor(k.label)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="support-subject" className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                  {t("supportSubject") || "Subject"}
                </label>
                <input
                  id="support-subject"
                  type="text"
                  maxLength={140}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={t("supportSubjectPlaceholder") || "One-line summary"}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 focus:border-emerald-400 outline-none"
                />
              </div>

              <div>
                <label htmlFor="support-body" className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                  {t("supportMessage") || "Tell us more"}
                </label>
                <textarea
                  id="support-body"
                  rows={5}
                  maxLength={5000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={t("supportMessagePlaceholder") || "What were you doing? What did you expect? Screenshots welcome via email."}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 focus:border-emerald-400 outline-none resize-none"
                />
                <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 text-right">
                  {body.length}/5000
                </div>
              </div>

              {error && (
                <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { reset(); setOpen(false); }}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              >
                {t("cancel") || "Cancel"}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={sending || !subject.trim() || !body.trim()}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50 transition"
              >
                {sending ? (t("sending") || "Sending…") : (t("supportSend") || "Send")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
