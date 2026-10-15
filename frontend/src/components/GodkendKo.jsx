import { useState, useEffect, useCallback } from "react";
import { Receipt, CircleCheck, AlertTriangle, Scale } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import { localIso } from "../utils/dateFormat";
import { safeImageUrl } from "../utils/safeUrl";
import { displayCurrency, formatOwnerMoney } from "../utils/currency";
import { errText } from "../utils/errText";
import BilagMatchPanel from "./BilagMatchPanel";

// §42 fradrag % from the canonical DK category name — mirrors dk_fradrag.py so
// the owner sees WHY a meal/gift deducts less, in the open. Display only; the
// real deduction is computed server-side in _calc_vat.
function fradragPct(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("repræsentation") || n.includes("gaver")) return 0;
  if (n.includes("restaurantbesøg") || n.includes("hotel") || n.includes("overnatning")) return 25;
  return 100;
}

/**
 * Godkend-kø — the approve queue. AI-drafted expenses (snap-a-pile, later
 * forwarded email) land here; the owner approves. Drafts are excluded from
 * every money total until approved (the S0 gate), so this is pure upside:
 * nothing it shows has touched the MOMS bill yet. Self-hides when empty.
 */
export default function GodkendKo({ getCatName, currency = "DKK", onApproved, onEdit, refreshToken }) {
  const { t } = useLanguage();
  const [drafts, setDrafts] = useState([]);
  const [busy, setBusy] = useState(false);
  // Photo-later matching: {draftId: [typed expenses without a bilag this
  // receipt may belong to]}. A matched draft is never "klar" — "Godkend
  // alle" would book the purchase a second time (the server skips it too).
  const [matches, setMatches] = useState({});
  // Drafts the owner answered "no, it's a new expense" for (this session).
  const [notAMatch, setNotAMatch] = useState(() => new Set());
  const [linkingId, setLinkingId] = useState(null);
  const [linkError, setLinkError] = useState("");
  // Currency lives on the ACCOUNT, never the browser: amounts route through
  // formatOwnerMoney (DKK → "1.113,50 kr.", da-DK grouping). The missing-
  // amount branch still renders "— <unit>", now in the same notation as the
  // rows beside it instead of a bare ISO code.
  const unit = displayCurrency(currency) === "DKK" ? "kr." : displayCurrency(currency);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/expenses/pending");
      setDrafts(Array.isArray(res.data) ? res.data : []);
    } catch {
      setDrafts([]);
    }
    try {
      const m = await api.get("/expenses/pending/bilag-matches");
      setMatches((m.data && m.data.matches) || {});
    } catch {
      // No answer is not "no match": keep what we last knew.
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshToken]);

  const hasAmount = (d) => parseFloat(d.amount) > 0;
  // A draft with no payment method can't be approved: the server would
  // fall back to the column default and skip the cash-out sync, so a
  // cash purchase would leave the drawer without the books noticing.
  const hasMethod = (d) => Boolean(d.payment_method);
  // Mirrors the server's _draft_blocker, in the same order — the queue
  // must never call something "klar" that a single Godkend would refuse.
  const needsRate = (d) => Boolean(d.currency) && (d.fx_rate == null || d.original_amount == null);
  const dateGuessed = (d) => d.date_source === "guessed";
  const matchesFor = (d) => (notAMatch.has(d.id) ? [] : (matches[d.id] || []));
  const hasMatch = (d) => (matches[d.id] || []).length > 0;
  // "Inbox" (forwarded mail) is a placeholder like "Ukategoriseret": it
  // would book at 100 % fradrag, so the owner picks before "Godkend alle"
  // (the server's approve-batch skips both too).
  const placeholderCat = (d) => ["Ukategoriseret", "Inbox"].includes(getCatName(d.category_id));
  const fieldsReady = (d) =>
    !needsRate(d) && hasAmount(d) && hasMethod(d) && !dateGuessed(d)
    && !!d.receipt_photo
    && !placeholderCat(d);
  const isKlar = (d) => fieldsReady(d) && !hasMatch(d);
  const klarIds = drafts.filter(isKlar).map((d) => d.id);
  const missingAmountCount = drafts.filter((d) => !hasAmount(d)).length;
  const missingMethodCount = drafts.filter((d) => hasAmount(d) && !hasMethod(d)).length;
  const matchedCount = drafts.filter(hasMatch).length;

  // "Knyt til eksisterende udgift": the draft's bilag goes onto the typed
  // expense and the draft disappears — never a second booking.
  const linkTo = async (draft, candidate) => {
    setLinkingId(candidate.id);
    setLinkError("");
    try {
      await api.post(`/expenses/${candidate.id}/link-bilag`, { draft_id: draft.id });
      await load();
      onApproved?.();
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (e) {
      const d = e?.response?.data?.detail;
      setLinkError((d && typeof d === "object" && (d.message_da || d.message)) || errText(e, t("bilagMatchFailed", "Couldn't attach the receipt — try again.")));
      await load();
    } finally {
      setLinkingId(null);
    }
  };

  // One tap on the row sets the method — the owner is looking straight at
  // the receipt thumbnail, so sending them into an edit modal to answer
  // one question would be the wrong trade.
  // A guessed date blocks approval, so it needs an answer in place —
  // a gate the owner can't clear from the queue is just a dead end.
  const setToday = async (id) => {
    setBusy(true);
    try {
      await api.put(`/expenses/${id}`, { date: localIso() });
      await load();
    } finally { setBusy(false); }
  };

  const setMethod = async (id, method) => {
    setBusy(true);
    try {
      await api.put(`/expenses/${id}`, { payment_method: method });
      await load();
    } finally { setBusy(false); }
  };

  const approveOne = async (id) => {
    setBusy(true);
    try {
      await api.post(`/expenses/${id}/approve`);
      await load();
      onApproved?.();
    } finally { setBusy(false); }
  };

  const approveAllKlar = async () => {
    if (!klarIds.length) return;
    setBusy(true);
    try {
      await api.post("/expenses/approve-batch", { ids: klarIds });
      await load();
      onApproved?.();
    } finally { setBusy(false); }
  };

  if (!drafts.length) return null;

  return (
    <section id="bonbox-godkend-ko" className="space-y-3 scroll-mt-4" aria-label={t("koTitle", "To approve")}>
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("koTitle", "To approve")} · {drafts.length}
          </h2>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
            {t("koSub", "Not in your MOMS yet — nothing is booked until you approve")}
          </p>
          {/* Say what the pile actually contains. "Approve all ready"
              silently doing less than the count implies is how an owner
              ends up believing a receipt was booked when it wasn't. */}
          {(missingMethodCount > 0 || missingAmountCount > 0 || matchedCount > 0) && (
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 tabular-nums">
              {klarIds.length} {t("koStatReady", "ready")}
              {missingMethodCount > 0 && ` · ${missingMethodCount} ${t("koStatNoMethod", "missing payment")}`}
              {missingAmountCount > 0 && ` · ${missingAmountCount} ${t("koStatNoAmount", "missing amount")}`}
              {matchedCount > 0 && ` · ${matchedCount} ${t("koStatMatches", "may be the receipt of a typed expense")}`}
            </p>
          )}
          {linkError && (
            <p className="text-xs text-red-700 dark:text-red-300 mt-1" role="alert">{linkError}</p>
          )}
        </div>
        {klarIds.length > 0 && (
          <button
            type="button"
            onClick={approveAllKlar}
            disabled={busy}
            className="inline-flex items-center gap-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-gray-700 dark:hover:bg-white transition disabled:opacity-40 shrink-0"
          >
            <CircleCheck size={16} strokeWidth={2} aria-hidden="true" />
            {t("koApproveAll", "Approve all ready")} · {klarIds.length}
          </button>
        )}
      </div>

      <div className="space-y-2.5">
        {drafts.map((d) => {
          const noAmount = !hasAmount(d);
          const noRate = needsRate(d);
          const noMethod = !noAmount && !noRate && !hasMethod(d);
          const noDate = !noAmount && !noRate && hasMethod(d) && dateGuessed(d);
          const klar = isKlar(d);
          const catName = getCatName(d.category_id);
          const pct = fradragPct(catName);
          const thumb = d.receipt_photo ? safeImageUrl(d.receipt_photo) : null;
          return (
            <div key={d.id} className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-3">
              <div className="flex gap-3">
                <div className="w-11 h-14 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center overflow-hidden shrink-0 text-gray-400">
                  {thumb ? (
                    <img src={thumb} alt="" loading="lazy" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                  ) : (
                    <Receipt size={18} strokeWidth={1.5} aria-hidden="true" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{d.description || catName}</span>
                    <span className={`text-sm font-medium tabular-nums shrink-0 ${noAmount ? "text-gray-400" : "text-gray-900 dark:text-gray-100"}`}>
                      {noAmount ? `— ${unit}` : formatOwnerMoney(d.amount, currency, { decimals: 2 })}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-2 truncate">{catName} · {d.date}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {hasMatch(d) && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                        {t("koMatchChip", "Matches an expense you typed")}
                      </span>
                    )}
                    {pct < 100 && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <Scale size={12} strokeWidth={1.75} aria-hidden="true" />{t("opsFradragPct", "Deductible {pct}% · §42", { pct })}
                      </span>
                    )}
                    {noAmount ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />{t("koMissingAmount", "Missing amount")}
                      </span>
                    ) : noRate ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />
                        {t("koMissingRate", "Needs an exchange rate")} · {formatOwnerMoney(d.original_amount, d.currency, { decimals: 2 })}
                      </span>
                    ) : noMethod ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />{t("koMissingMethod", "Missing payment method")}
                      </span>
                    ) : noDate ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />{t("koDateGuessed", "Couldn't read the date")}
                      </span>
                    ) : klar ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300">
                        <CircleCheck size={12} strokeWidth={1.75} aria-hidden="true" />{t("koReady", "Ready")}
                      </span>
                    ) : hasMatch(d) && fieldsReady(d) ? null : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">{t("opsUncategorized", "Uncategorized")}</span>
                    )}
                    {noAmount || noRate ? (
                      <button type="button" onClick={() => onEdit?.(d)} className="ml-auto text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition">
                        {t("koFix", "Fix")}
                      </button>
                    ) : noDate ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setToday(d.id)}
                        className="ml-auto text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition disabled:opacity-40"
                      >
                        {t("dateUseToday", "Today")}
                      </button>
                    ) : noMethod ? (
                      <span className="ml-auto inline-flex items-center gap-1.5" role="group" aria-label={t("paymentMethod", "Payment method")}>
                        {["cash", "card", "mobilepay"].map((m) => (
                          <button
                            key={m}
                            type="button"
                            disabled={busy}
                            onClick={() => setMethod(d.id, m)}
                            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition disabled:opacity-40"
                          >
                            {t(m)}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <button type="button" onClick={() => approveOne(d.id)} disabled={busy} className="ml-auto text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition disabled:opacity-40">
                        {hasMatch(d) ? t("koApproveAsNew", "Approve as new") : t("koApprove", "Approve")}
                      </button>
                    )}
                  </div>
                  {matchesFor(d).length > 0 && (
                    <BilagMatchPanel
                      compact
                      candidates={matchesFor(d)}
                      receiptAmount={hasAmount(d) ? parseFloat(d.amount) : null}
                      currency={currency}
                      busyId={linkingId}
                      onLink={(c) => linkTo(d, c)}
                      onNew={() => setNotAMatch((prev) => new Set(prev).add(d.id))}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
