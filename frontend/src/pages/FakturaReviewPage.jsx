import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { errText } from "../utils/errText";

/**
 * Payment-match review inbox.
 *
 * Shows pending MEDIUM/LOW confidence suggestions from the bank-import
 * auto-matcher. Owner taps Accept (calls mark_paid with source='manual')
 * or Reject (suggestion → rejected, invoice stays open).
 *
 * Why this exists: the previous matcher auto-flipped on amount alone,
 * which created wrong-faktura-paid bugs when a coincidental amount
 * landed. The new tiered logic only auto-flips on HIGH confidence
 * (amount + text signal). Everything else lands here for human review.
 *
 * Confidence cues in the UI:
 *   • Medium: amber chip — "amount matches, no text confirmation"
 *   • Low: gray chip — "multiple invoices at this amount, pick one"
 *
 * Audit: every accept/reject writes an audit log entry server-side.
 */
export default function FakturaReviewPage() {
  const { t } = useLanguage();
  const [suggestions, setSuggestions] = useState([]);
  const [filter, setFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState({}); // {suggestionId: true} while POST in flight

  const fmtMoney = (amt, ccy = "DKK") =>
    new Intl.NumberFormat("da-DK", {
      style: "currency",
      currency: ccy || "DKK",
    }).format(parseFloat(amt));

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/payment-suggestions", {
        params: { status: filter },
      });
      setSuggestions(res.data || []);
    } catch (e) {
      setError(errText(e, "Could not load suggestions"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const accept = async (s) => {
    if (!confirm(t("confirmAcceptSuggestion") ||
      `Confirm this match: ${s.fakturanummer_formatted} ← ${fmtMoney(s.sale_amount, s.invoice_currency)}?`)) return;
    setBusy(b => ({ ...b, [s.id]: true }));
    try {
      await api.post(`/payment-suggestions/${s.id}/accept`);
      await load();
    } catch (e) {
      alert(e?.response?.data?.detail || "Accept failed");
    } finally {
      setBusy(b => ({ ...b, [s.id]: false }));
    }
  };

  const reject = async (s) => {
    if (!confirm(t("confirmRejectSuggestion") ||
      `Reject match: ${s.fakturanummer_formatted}? The faktura stays open.`)) return;
    setBusy(b => ({ ...b, [s.id]: true }));
    try {
      await api.post(`/payment-suggestions/${s.id}/reject`);
      await load();
    } catch (e) {
      alert(e?.response?.data?.detail || "Reject failed");
    } finally {
      setBusy(b => ({ ...b, [s.id]: false }));
    }
  };

  const confidenceColor = (c) => ({
    high: "bg-gray-100 text-gray-700",
    medium: "bg-amber-100 text-amber-700",
    low: "bg-gray-100 text-gray-700",
  })[c] || "bg-gray-100 text-gray-700";

  const statusColor = (st) => ({
    pending: "bg-blue-100 text-blue-700",
    accepted: "bg-gray-100 text-gray-700",
    rejected: "bg-gray-100 text-gray-600",
  })[st] || "bg-gray-100";

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link
            to="/faktura"
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ← {t("backToFaktura") || "Back to fakturaer"}
          </Link>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white mt-1 flex items-center gap-2">
            <span>📥</span> {t("reviewInboxTitle") || "Payments to review"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            {t("reviewInboxDesc") ||
              "Bank deposits where the amount matched a faktura but the description didn't confirm it. Tap Accept or Reject — the auto-matcher won't decide for you."}
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {[
          { value: "pending", label: t("pending") || "Pending" },
          { value: "accepted", label: t("accepted") || "Accepted" },
          { value: "rejected", label: t("rejected") || "Rejected" },
          { value: "all", label: t("all") || "All" },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition
              ${filter === tab.value
                ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">
          {t("loading") || "Loading…"}
        </div>
      ) : suggestions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-12 text-center border border-gray-100 dark:border-gray-700">
          <p className="text-4xl mb-3">✨</p>
          <p className="text-gray-600 dark:text-gray-300 font-medium">
            {filter === "pending"
              ? (t("reviewInboxEmptyPending") ||
                 "Nothing to review. New bank deposits auto-match high-confidence; medium-confidence will appear here.")
              : (t("reviewInboxEmpty") || "No matches in this view.")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {suggestions.map((s) => (
            <div
              key={s.id}
              className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-0 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${confidenceColor(s.confidence)}`}>
                      {s.confidence}
                    </span>
                    <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${statusColor(s.status)}`}>
                      {s.status}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(s.created_at).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric" })}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
                        {t("reviewBankLine") || "Bank deposit"}
                      </p>
                      <p className="text-sm text-gray-800 dark:text-gray-100">
                        <span className="font-semibold">{fmtMoney(s.sale_amount, s.invoice_currency)}</span>
                        <span className="text-gray-400 ml-2 text-xs">{s.sale_date}</span>
                      </p>
                      {s.sale_description && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                          {s.sale_description}
                        </p>
                      )}
                    </div>

                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
                        {t("reviewFaktura") || "Faktura"}
                      </p>
                      <p className="text-sm font-mono text-gray-800 dark:text-gray-100">
                        {s.fakturanummer_formatted}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {s.customer_name}{s.customer_cvr ? ` · CVR ${s.customer_cvr}` : ""}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {fmtMoney(s.invoice_total_gross, s.invoice_currency)} · {t("issued") || "Issued"} {s.invoice_issue_date}
                      </p>
                    </div>
                  </div>

                  <p className="text-[11px] text-gray-500 italic">
                    {t("reviewReason") || "Reason"}: {s.reason}
                  </p>
                </div>

                {s.status === "pending" && (
                  <div className="flex flex-col gap-2 shrink-0">
                    <button
                      onClick={() => accept(s)}
                      disabled={busy[s.id]}
                      className="px-4 py-2 bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:opacity-50 text-white text-sm font-semibold rounded-lg whitespace-nowrap transition"
                    >
                      ✓ {t("accept") || "Accept"}
                    </button>
                    <button
                      onClick={() => reject(s)}
                      disabled={busy[s.id]}
                      className="px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg whitespace-nowrap transition"
                    >
                      ✕ {t("reject") || "Reject"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
