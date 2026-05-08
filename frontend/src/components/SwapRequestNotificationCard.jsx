/**
 * SwapRequestNotificationCard — owner dashboard surface for staff
 * shift-swap requests awaiting approval.
 *
 * Renders ONLY when there's at least one accepted (peer-confirmed)
 * swap waiting on the owner. Same interrupt-only philosophy as
 * SickCallNotificationCard — never filler.
 *
 * Per row:
 *   • Sara → Lars  (proposer arrow target)
 *   • Sara's shift  ⇄  Lars's shift  (date + time both)
 *   • Reason (if any)
 *   • Approve / Deny buttons inline
 *   • Optional note field on Deny
 *
 * Multi-layer security inherited from the backend:
 *   • /staff/swap-requests is auth-gated (Depends(get_current_user))
 *   • Tenant-scoped server-side
 *   • Decide endpoint validates the swap is in 'accepted' state +
 *     atomically flips Schedule.staff_id values on approve
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";


export default function SwapRequestNotificationCard() {
  const { t } = useLanguage();
  const [swaps, setSwaps] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const refetch = async () => {
    try {
      const res = await api.get("/staff/swap-requests");
      setSwaps(res.data || []);
    } catch {
      setSwaps([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => { refetch(); }, []);

  if (!loaded || swaps.length === 0) return null;

  return (
    <div className="bg-blue-50/70 dark:bg-blue-900/15 border border-blue-200 dark:border-blue-800/50 rounded-2xl p-4 sm:p-5">
      <div className="flex items-start gap-2 mb-3">
        <span className="text-xl shrink-0" aria-hidden="true">🔄</span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-200">
            {t("swapCardTitle") || "Shift swaps need your approval"}
          </h3>
          <p className="text-[12px] text-blue-700 dark:text-blue-300/80 mt-0.5">
            {(t("swapCardSubtitle") || "{n} pending. Both staff agreed; you have final say.")
              .replace("{n}", swaps.length)}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {swaps.map((s) => (
          <SwapRow key={s.id} swap={s} onChanged={refetch} t={t} />
        ))}
      </div>
    </div>
  );
}


function SwapRow({ swap, onChanged, t }) {
  const [note, setNote] = useState("");
  const [denying, setDenying] = useState(false);
  const [busy, setBusy] = useState(false);

  const decide = async (approve) => {
    setBusy(true);
    try {
      await api.post(`/staff/swap-requests/${swap.id}/decide`, {
        approve,
        note: note.trim() || null,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800/40 rounded-xl px-3 py-2.5 border border-blue-100 dark:border-blue-900/20 space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          {swap.from_staff_name || t("staff") || "Staff"}
        </span>
        <span className="text-gray-500 dark:text-gray-400">→</span>
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          {swap.to_staff_name || t("staff") || "Staff"}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
        <ShiftBlock
          label={`${swap.from_staff_name || ""} ${t("swapShiftGives") || "gives"}`}
          date={swap.from_shift_date}
          time={swap.from_shift_time}
        />
        <ShiftBlock
          label={`${swap.to_staff_name || ""} ${t("swapShiftGives") || "gives"}`}
          date={swap.to_shift_date}
          time={swap.to_shift_time}
        />
      </div>

      {swap.reason && (
        <div className="text-xs text-gray-600 dark:text-gray-400 italic">
          "{swap.reason}"
        </div>
      )}

      {!denying && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => decide(true)}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition"
          >
            {t("swapApprove") || "Approve"}
          </button>
          <button
            onClick={() => setDenying(true)}
            disabled={busy}
            className="text-xs font-medium px-2.5 py-1 rounded-md bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 transition"
          >
            {t("swapDeny") || "Deny"}
          </button>
        </div>
      )}

      {denying && (
        <div className="space-y-2 border-t border-blue-100 dark:border-blue-900/20 pt-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={2}
            placeholder={t("swapDenyReasonPlaceholder") || "Why? (optional, staff will see this)"}
            className="w-full px-2 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs text-gray-800 dark:text-gray-100 outline-none focus:border-emerald-400 resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => decide(false)}
              disabled={busy}
              className="text-xs font-medium px-2.5 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 transition"
            >
              {t("swapConfirmDeny") || "Confirm deny"}
            </button>
            <button
              onClick={() => { setDenying(false); setNote(""); }}
              disabled={busy}
              className="text-xs px-2.5 py-1 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
            >
              {t("cancel") || "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function ShiftBlock({ label, date, time }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-700/30 rounded-md px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400 font-medium">
        {label}
      </div>
      <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
        {date}
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400">
        {time}
      </div>
    </div>
  );
}
