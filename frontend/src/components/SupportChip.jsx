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
import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { errText } from "../utils/errText";

// Global open-event name. Any in-app surface (the retired /feedback page, a
// "Contact / help" link) funnels into this ONE channel by dispatching
// `window.dispatchEvent(new Event(OPEN_SUPPORT_EVENT))` — no prop drilling,
// no second composer to keep in sync.
export const OPEN_SUPPORT_EVENT = "bonbox:open-support";


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

  // Open from anywhere via the global event. Optional `detail.kind`
  // pre-selects the category (e.g. a "report a bug" entry point).
  useEffect(() => {
    function onOpen(e) {
      const k = e?.detail?.kind;
      if (k && KIND_OPTIONS.some((o) => o.id === k)) setKind(k);
      setOpen(true);
    }
    window.addEventListener(OPEN_SUPPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SUPPORT_EVENT, onOpen);
  }, []);

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
      setError(errText(err, t("supportSendFailed") || "Couldn't send. Try again."));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* Floating chip — MOBILE ONLY (`md:hidden`). On desktop the sidebar owns
          the left column, and any floating "?" there either hides behind it or
          floats awkwardly over content — so desktop uses the labelled
          "Help & feedback" row in the sidebar footer instead (Layout.jsx), which
          dispatches OPEN_SUPPORT_EVENT to open this same composer. On mobile the
          sidebar is off-canvas, so bottom-left is clear. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("supportChipAria") || "Get help / send feedback"}
        className="md:hidden fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] left-5 z-40 w-11 h-11 rounded-full bg-gray-900/80 dark:bg-gray-700 hover:bg-gray-900 dark:hover:bg-gray-600 text-white text-lg font-bold shadow-sm flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        ?
      </button>

      {/* Sent toast */}
      {sentToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-[calc(9rem+env(safe-area-inset-bottom,0px))] md:bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-gray-900 text-white text-sm shadow-sm"
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
            className="bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-xl shadow-sm max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden"
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
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 focus:border-gray-900 outline-none"
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
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 focus:border-gray-900 outline-none"
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
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 focus:border-gray-900 outline-none resize-none"
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
                className="px-4 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold disabled:opacity-50 transition"
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
