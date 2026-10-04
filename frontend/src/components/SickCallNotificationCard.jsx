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
import { useEffect, useRef, useState } from "react";
import { CalendarOff, Check } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { dateLocale } from "../utils/dateFormat";
import { roleName } from "../utils/roleNames";


/** Absence type → owner-facing label (ferie/sick/barns_syg/andet). */
function kindLabel(kind, t) {
  return {
    ferie: t("absenceKindFerie", "Holiday"),
    sick: t("absenceKindSick", "Sick"),
    barns_syg: t("absenceKindBarns", "Child's sick day"),
    andet: t("absenceKindAndet", "Other"),
  }[kind] || kind;
}


export default function SickCallNotificationCard({ refreshKey } = {}) {
  const { t, lang } = useLanguage();
  const [absences, setAbsences] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const fetchAbsences = async () => {
    try {
      const res = await api.get("/staff/absences", {
        params: { days_back: 7, include_resolved: false },
      });
      // Oldest day first — a Thu–Fri sick call listed Friday above Thursday.
      setAbsences([...(res.data || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))));
    } catch {
      // Silent fail — dashboard shouldn't crash if the staff feature
      // isn't enabled / isn't reachable. Card just stays hidden.
      setAbsences([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    fetchAbsences();
    // The owner's own Fravær sheet writes absences on this same page; without
    // this the card kept showing what was there before the sheet closed.
    const onChanged = () => fetchAbsences();
    window.addEventListener("bonbox-data-changed", onChanged);
    return () => window.removeEventListener("bonbox-data-changed", onChanged);
  }, []);

  // The Vagtplan hands its shifts in as refreshKey: moving a sick person's
  // shift on the grid covers it, and the card kept asking for cover until a
  // reload. Skip the first run — the mount effect above already fetched.
  const firstKeyRef = useRef(true);
  useEffect(() => {
    if (firstKeyRef.current) { firstKeyRef.current = false; return; }
    fetchAbsences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Hide when nothing's pending — the card is "interrupt-only" UX,
  // never a filler.
  if (!loaded || absences.length === 0) return null;
  const pendingCount = absences.filter((a) => a.status === "pending").length;
  // Cover is only owed where the person HAS a shift that day.
  const uncoveredCount = absences.filter(
    (a) => a.status !== "pending" && !a.replacement_staff_name && a.shift_start,
  ).length;

  return (
    <div className="bg-amber-50/70 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/50 rounded-xl p-4 sm:p-5">
      <div className="flex items-start gap-2 mb-3">
        <CalendarOff className="w-5 h-5 shrink-0 text-amber-600 dark:text-amber-300 mt-0.5" strokeWidth={2} aria-hidden />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {t("absenceCardTitle", "Absence needs your attention")}
          </h3>
          {/* Say what is actually asked. Only a PENDING absence waits for an
              approve/decline — one the owner entered (acknowledged) only
              needs cover, and counting it as "afventer" offered buttons the
              rows don't have. */}
          <p className="text-[12px] text-amber-700 dark:text-amber-300/80 mt-0.5">
            {[
              pendingCount > 0 &&
                t("absenceCardSubtitle", "{n} pending — approve or decline.").replace("{n}", pendingCount),
              uncoveredCount > 0 &&
                t("absenceCardNeedsCover", "{n} without cover — find a replacement.").replace("{n}", uncoveredCount),
            ].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {absences.map((a) => (
          <AbsenceRow key={a.id} absence={a} onChanged={fetchAbsences} t={t} lang={lang} />
        ))}
      </div>
    </div>
  );
}


function AbsenceRow({ absence, onChanged, t, lang }) {
  const [showCover, setShowCover] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // "17.00–22.30" in Danish, "17:00–22:30" in English.
  const clock = (hhmm) => (lang === "da" ? String(hhmm || "").replace(":", ".") : hhmm);
  const shiftText = absence.shift_start && absence.shift_end
    ? `${clock(absence.shift_start)}–${clock(absence.shift_end)}`
    : null;

  // Colour with meaning: amber = waits for the owner, emerald = approved.
  const statusBadge =
    absence.status === "pending"
      ? "bg-amber-200 dark:bg-amber-800/40 text-amber-900 dark:text-amber-200"
      : absence.status === "acknowledged"
        ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200"
        : "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-200";
  const statusText = {
    pending: t("absenceStatusPending", "Pending"),
    acknowledged: t("absenceStatusApproved", "Approved"),
    declined: t("absenceStatusDeclined", "Declined"),
  }[absence.status] || t("absenceStatusOther", "Registered");
  // "lør. 28. nov." in the app's date language — never the raw ISO date.
  const dateText = (() => {
    const [y, m, d] = String(absence.date || "").slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return absence.date || "";
    return new Date(y, m - 1, d, 12).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
  })();

  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.post(`/staff/absences/${absence.id}/acknowledge`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    try {
      await api.post(`/staff/absences/${absence.id}/decline`);
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
    setErr("");
    try {
      // Moves the shift to the replacement (and tells them if published).
      await api.post(`/staff/absences/${absence.id}/cover`, {
        replacement_staff_id: replacementId,
      });
      window.dispatchEvent(new Event("bonbox-data-changed"));
      onChanged();
    } catch (e) {
      setErr(e?.response?.data?.detail?.message || t("sickCallCoverFailed", "Couldn't assign cover. Try again."));
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
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
          {kindLabel(absence.kind, t)}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {dateText}{shiftText ? ` · ${shiftText}` : ""}
        </span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusBadge}`}>
          {statusText}
        </span>
      </div>
      {absence.reason && (
        <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 leading-snug">
          {absence.reason}
        </div>
      )}
      {absence.replacement_staff_name && (
        <div className="text-[11px] text-gray-700 dark:text-emerald-400 mt-1 flex items-center gap-1">
          <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} aria-hidden />
          {(t("sickCallCovered") || "Covered by {name}").replace("{name}", absence.replacement_staff_name)}
        </div>
      )}

      {!absence.replacement_staff_name && !absence.shift_start && absence.status !== "pending" && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
          {t("absenceNoShiftThatDay", "No shift that day — no cover needed.")}
        </div>
      )}
      {err && <div className="text-[11px] text-red-600 dark:text-red-400 mt-1">{err}</div>}
      {!absence.replacement_staff_name && (absence.status === "pending" || absence.shift_start) && (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {absence.status === "pending" && (
            <>
              <button
                onClick={acknowledge}
                disabled={busy}
                className="text-xs font-semibold px-2.5 py-1 rounded-md bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800/40 disabled:opacity-50 transition"
              >
                {t("absenceApprove", "Approve")}
              </button>
              <button
                onClick={decline}
                disabled={busy}
                className="text-xs font-medium px-2.5 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition"
              >
                {t("absenceDecline", "Decline")}
              </button>
            </>
          )}
          {!showCover && absence.shift_start && (
            <button
              onClick={openCover}
              disabled={busy}
              className="text-xs font-medium px-2.5 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700/50 disabled:opacity-50 transition"
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
                      {roleName(c.role, t)}{c.phone ? ` · ${c.phone}` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => assignCover(c.id)}
                    disabled={busy}
                    className="text-xs font-medium px-2.5 py-1 rounded-md bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:opacity-50 transition"
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
