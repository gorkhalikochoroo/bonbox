/**
 * SickCallNotificationCard — owner-side dashboard surface for staff
 * sick-call notifications.
 *
 * Renders ONLY when there's at least one pending or acknowledged
 * (uncovered) absence. Empty state is intentional — owners shouldn't
 * see a "no sick calls today" card cluttering their dashboard. The
 * card disappears when all absences are covered.
 *
 * Shape per row:
 *   • Staff name + date + reason (if any)
 *   • Status pill (pending = amber, acknowledged = blue, covered = green)
 *   • Action: "Acknowledge" if pending, "Find cover" if not yet covered
 *   • "Find cover" expands inline with up to 5 ranked candidates,
 *     one-tap to assign
 *
 * Multi-layer security pulled in from the backend:
 *   • Every endpoint is auth-gated (Depends(get_current_user))
 *   • Tenant scoping happens server-side (StaffAbsence.user_id ==
 *     owner.id) — UI never sends an owner_id
 *   • Replacement candidates are pre-filtered to active staff under
 *     this owner who aren't already scheduled that day
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";


export default function SickCallNotificationCard() {
  const { t } = useLanguage();
  const [absences, setAbsences] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const fetchAbsences = async () => {
    try {
      const res = await api.get("/staff/absences", {
        params: { days_back: 7, include_resolved: false },
      });
      setAbsences(res.data || []);
    } catch {
      // Silent fail — dashboard shouldn't crash if the staff feature
      // isn't enabled / isn't reachable. Card just stays hidden.
      setAbsences([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => { fetchAbsences(); }, []);

  // Hide when nothing's pending — the card is "interrupt-only" UX,
  // never a filler.
  if (!loaded || absences.length === 0) return null;

  return (
    <div className="bg-amber-50/70 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/50 rounded-2xl p-4 sm:p-5">
      <div className="flex items-start gap-2 mb-3">
        <span className="text-xl shrink-0" aria-hidden="true">🤒</span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {t("sickCallCardTitle") || "Sick calls need your attention"}
          </h3>
          <p className="text-[12px] text-amber-700 dark:text-amber-300/80 mt-0.5">
            {(t("sickCallCardSubtitle") || "{n} pending. Tap to acknowledge or find cover.")
              .replace("{n}", absences.length)}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {absences.map((a) => (
          <AbsenceRow key={a.id} absence={a} onChanged={fetchAbsences} t={t} />
        ))}
      </div>
    </div>
  );
}


function AbsenceRow({ absence, onChanged, t }) {
  const [showCover, setShowCover] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [busy, setBusy] = useState(false);

  const statusBadge =
    absence.status === "pending"
      ? "bg-amber-200 dark:bg-amber-800/40 text-amber-900 dark:text-amber-200"
      : absence.status === "acknowledged"
        ? "bg-blue-200 dark:bg-blue-800/40 text-blue-900 dark:text-blue-200"
        : "bg-emerald-200 dark:bg-emerald-800/40 text-emerald-900 dark:text-emerald-200";

  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.post(`/staff/absences/${absence.id}/acknowledge`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const openCover = async () => {
    setShowCover(true);
    try {
      const res = await api.get(`/staff/absences/${absence.id}/replacement-suggestions`);
      setCandidates(res.data || []);
    } catch {
      setCandidates([]);
    }
  };

  const assignCover = async (replacementId) => {
    setBusy(true);
    try {
      await api.post(`/staff/absences/${absence.id}/cover`, {
        replacement_staff_id: replacementId,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800/40 rounded-xl px-3 py-2.5 border border-amber-100 dark:border-amber-900/20">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-sm text-gray-900 dark:text-gray-100">
          {absence.staff_name || t("staff") || "Staff"}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {absence.date}
        </span>
        <span className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${statusBadge}`}>
          {absence.status}
        </span>
      </div>
      {absence.reason && (
        <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 leading-snug">
          {absence.reason}
        </div>
      )}
      {absence.replacement_staff_name && (
        <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">
          ✓ {(t("sickCallCovered") || "Covered by {name}").replace("{name}", absence.replacement_staff_name)}
        </div>
      )}

      {!absence.replacement_staff_name && (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {absence.status === "pending" && (
            <button
              onClick={acknowledge}
              disabled={busy}
              className="text-xs font-medium px-2.5 py-1 rounded-md bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800/40 disabled:opacity-50 transition"
            >
              {t("sickCallAcknowledge") || "Acknowledge"}
            </button>
          )}
          {!showCover && (
            <button
              onClick={openCover}
              disabled={busy}
              className="text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800/40 disabled:opacity-50 transition"
            >
              {t("sickCallFindCover") || "Find cover"}
            </button>
          )}
        </div>
      )}

      {showCover && (
        <div className="mt-2 border-t border-amber-100 dark:border-amber-900/20 pt-2">
          {candidates === null && (
            <div className="text-[11px] text-gray-500">{t("loading") || "Loading…"}</div>
          )}
          {candidates !== null && candidates.length === 0 && (
            <div className="text-[11px] text-gray-500">
              {t("sickCallNoCandidates") || "No available staff today."}
            </div>
          )}
          {candidates !== null && candidates.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 font-medium">
                {t("sickCallSuggested") || "Suggested cover"}
              </div>
              {candidates.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
                      {c.name}
                    </div>
                    <div className="text-[10px] text-gray-500 dark:text-gray-400">
                      {c.role}{c.phone ? ` · ${c.phone}` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => assignCover(c.id)}
                    disabled={busy}
                    className="text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition"
                  >
                    {t("sickCallAssign") || "Assign"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
