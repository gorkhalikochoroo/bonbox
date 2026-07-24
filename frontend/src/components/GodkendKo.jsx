import { useState, useEffect, useCallback } from "react";
import { Receipt, CircleCheck, AlertTriangle, Scale } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import { localIso } from "../utils/dateFormat";
import { safeImageUrl } from "../utils/safeUrl";

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
export default function GodkendKo({ getCatName, currency = "kr.", onApproved, onEdit, refreshToken }) {
  const { t } = useLanguage();
  const [drafts, setDrafts] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/expenses/pending");
      setDrafts(Array.isArray(res.data) ? res.data : []);
    } catch {
      setDrafts([]);
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
  const isKlar = (d) =>
    !needsRate(d) && hasAmount(d) && hasMethod(d) && !dateGuessed(d)
    && !!d.receipt_photo
    && getCatName(d.category_id) !== "Ukategoriseret";
  const klarIds = drafts.filter(isKlar).map((d) => d.id);
  const missingAmountCount = drafts.filter((d) => !hasAmount(d)).length;
  const missingMethodCount = drafts.filter((d) => hasAmount(d) && !hasMethod(d)).length;

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
    <section className="space-y-3" aria-label={t("koTitle", "To approve")}>
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("koTitle", "To approve")} · {drafts.length}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("koSub", "Not in your MOMS yet — nothing is booked until you approve")}
          </p>
          {/* Say what the pile actually contains. "Approve all ready"
              silently doing less than the count implies is how an owner
              ends up believing a receipt was booked when it wasn't. */}
          {(missingMethodCount > 0 || missingAmountCount > 0) && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 tabular-nums">
              {klarIds.length} {t("koStatReady", "ready")}
              {missingMethodCount > 0 && ` · ${missingMethodCount} ${t("koStatNoMethod", "missing payment")}`}
              {missingAmountCount > 0 && ` · ${missingAmountCount} ${t("koStatNoAmount", "missing amount")}`}
            </p>
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
                      {noAmount ? `— ${currency}` : `${parseFloat(d.amount).toLocaleString()} ${currency}`}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-2 truncate">{catName} · {d.date}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {pct < 100 && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <Scale size={12} strokeWidth={1.75} aria-hidden="true" />Fradrag {pct}% · §42
                      </span>
                    )}
                    {noAmount ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />{t("koMissingAmount", "Missing amount")}
                      </span>
                    ) : noRate ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                        <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />
                        {t("koMissingRate", "Needs an exchange rate")} · {d.original_amount} {d.currency}
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
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">Ukategoriseret</span>
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
                        {t("koApprove", "Approve")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
