/**
 * SmartStaffingCard — the "we watched your data, here's what we see"
 * surface for Smart Staffing.
 *
 * Why this replaced the configuration-heavy form (May 2026):
 *   The first version asked the owner to fill out 7 day toggles +
 *   7 hour fields + 4-8 role rows with counts. That's homework, not
 *   help. Per the founder: "our goal should be simple. how can we
 *   help them. no complicated stuff."
 *
 *   This version is the inverse: zero-config by default. The card
 *   shows what we INFERRED from their existing sales + staff data,
 *   one tap to confirm (or edit if they want to fine-tune). Most
 *   owners will tap once and be done.
 *
 * Pre-launch refinements:
 *   • Undo toast — 8s window after save to revert (we re-PUT the prior
 *     payload). Slipped tap can't ruin a working setup.
 *   • Telemetry — log accept/edit/cancelled outcomes so we can tune.
 *   • Contextual button copy — "Save these hours" instead of generic
 *     "Looks right ✓" so the owner sees what's about to happen.
 *   • Emoji restraint — kept one (🌙 not here, just plain title) so the
 *     surface reads calm.
 *
 * UX:
 *   1. On mount: GET /business/staffing-suggestion → render proposal
 *   2. Confidence pill (high/medium/low) + "based on N sales"
 *   3. Two buttons: "Save these hours" or "Edit details"
 *
 * Multi-layer security inherited from the backend:
 *   • All endpoints auth-gated, tenant-scoped server-side
 *   • Inference is read-only — confirm action writes via existing
 *     auth-gated PUT endpoints
 *   • Validation re-runs at the service layer; UI is convenience
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useLanguage } from "../hooks/useLanguage";
import { useSmartTelemetry } from "../hooks/useSmartTelemetry";
import { useUndoToast } from "../hooks/useUndoToast";
import { useBranch } from "./BranchSelector";


const DAY_LABELS = {
  mon: { en: "Mon", da: "Man" },
  tue: { en: "Tue", da: "Tir" },
  wed: { en: "Wed", da: "Ons" },
  thu: { en: "Thu", da: "Tor" },
  fri: { en: "Fri", da: "Fre" },
  sat: { en: "Sat", da: "Lør" },
  sun: { en: "Sun", da: "Søn" },
};


export default function SmartStaffingCard({ onEditClick }) {
  const { t, lang } = useLanguage();
  const { track } = useSmartTelemetry();
  const { show: showUndo, ToastUI } = useUndoToast();
  const { branchId, branchName } = useBranch();

  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Branch-aware: when the BranchSelector has an active branch, the
  // proposal queries only that branch's data. Refetches on branch
  // switch so a Pro owner clicking through Nørrebro/Østerbro/
  // Frederiksberg sees per-location proposals, not a blended average.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const params = branchId ? { branch_id: branchId } : {};
    api.get("/business/staffing-suggestion", { params })
      .then((res) => {
        if (!alive) return;
        setProposal(res.data);
        track("smart_proposal_viewed", "smart_staffing", {
          confidence: res.data?.confidence,
        });
      })
      .catch((err) => {
        if (!alive) return;
        // 401 is handled by the global axios interceptor (redirects to
        // /login). Suppress the error UI so users don't see a flash of
        // "Couldn't load" before the redirect lands. Other errors get
        // the calm error card so they know something is up.
        if (err?.response?.status === 401) return;
        setError(t("smartStaffingLoadError") || "Couldn't load suggestion.");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const labelFor = (dict) => (dict && (dict[lang] || dict.en)) || "";

  // Snapshot prior state so undo can revert. Fetched lazily — only on
  // first save attempt — so we don't spend a request on page load.
  async function snapshotPriorState() {
    try {
      const [opRes, rolesRes] = await Promise.all([
        api.get("/business/operating-profile").catch(() => ({ data: null })),
        api.get("/business/staff-role-targets").catch(() => ({ data: { targets: [] } })),
      ]);
      return {
        operating: opRes.data,
        roleTargets: rolesRes.data?.targets || [],
      };
    } catch {
      return null;
    }
  }

  const acceptProposal = async () => {
    if (!proposal) return;
    setSaving(true);
    setError("");
    const prior = await snapshotPriorState();
    try {
      await Promise.all([
        api.put("/business/operating-profile", {
          open_days_mask: proposal.open_days_mask,
          operating_hours: proposal.operating_hours,
          peak_windows: proposal.peak_windows,
        }),
        api.put("/business/staff-role-targets", {
          targets: (proposal.role_targets || []).map((r) => ({
            role: r.role,
            default_count: r.default_count,
          })),
        }),
      ]);
      // NOTE: this card has no edit mode — the outcome is always "accepted".
      // A prior `editing ? …` ternary referenced an undeclared variable, which
      // threw ReferenceError AFTER the two PUTs above had already committed —
      // so the owner saw "Couldn't save." on a save that actually succeeded.
      track("smart_proposal_accepted", "smart_staffing", {
        confidence: proposal?.confidence,
        proposal_count: (proposal?.role_targets?.length || 0),
      });
      // Undo: re-PUT the prior payload. If we couldn't snapshot, undo
      // is unavailable (we don't lie with a button that won't work).
      const onUndo = prior
        ? async () => {
            await Promise.all([
              api.put("/business/operating-profile", {
                open_days_mask: prior.operating?.open_days_mask ?? null,
                operating_hours: prior.operating?.operating_hours ?? {},
                peak_windows: prior.operating?.peak_windows ?? [],
              }),
              api.put("/business/staff-role-targets", {
                targets: (prior.roleTargets || []).map((r) => ({
                  role: r.role,
                  default_count: r.default_count,
                })),
              }),
            ]);
          }
        : null;
      showUndo({
        message: t("smartStaffingSavedToast") || "Saved your hours and roles",
        onUndo,
      });
    } catch (err) {
      setError(errText(err, t("smartStaffingSaveError") || "Couldn't save."));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700/60 p-5 text-sm text-gray-500">
        {t("loading") || "Loading…"}
      </div>
    );
  }
  if (!proposal) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700/60 p-5 text-sm text-red-500">
        {error || (t("smartStaffingLoadError") || "Couldn't load suggestion.")}
      </div>
    );
  }

  const openDaysSet = new Set((proposal.open_days_mask || "").split(""));
  const dayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const dayMaskDigit = { mon: "1", tue: "2", wed: "3", thu: "4", fri: "5", sat: "6", sun: "7" };

  const confidenceBadge = {
    high: { color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", label: t("confidenceHigh") || "High confidence" },
    medium: { color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", label: t("confidenceMedium") || "Medium confidence" },
    low: { color: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300", label: t("confidenceLow") || "Low confidence" },
  }[proposal.confidence] || { color: "bg-gray-100 text-gray-600", label: proposal.confidence };

  return (
    <>
      <div className="rounded-xl border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 p-5 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("smartStaffingTitle") || "How your business runs"}
              {branchId && branchName && branchName !== "All" && (
                <span className="ml-2 text-[11px] font-normal text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-0.5 rounded-full align-middle">
                  {branchName}
                </span>
              )}
            </h2>
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">
              {(t("smartStaffingSubtitle") ||
                "We watched your last {n} days of sales. Looks right?")
                .replace("{n}", String(proposal.data_quality?.lookback_days || 60))}
            </p>
          </div>
          <span className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded ${confidenceBadge.color}`}>
            {confidenceBadge.label}
          </span>
        </div>

        <div className="space-y-3">
          {/* Open days */}
          <div>
            <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
              {t("smartStaffingOpenDays") || "Open days"}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dayKeys.map((k) => {
                const active = openDaysSet.has(dayMaskDigit[k]);
                return (
                  <span
                    key={k}
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      active
                        ? "bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                        : "bg-gray-100 dark:bg-gray-700 text-gray-400 line-through"
                    }`}
                  >
                    {labelFor(DAY_LABELS[k])}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Hours */}
          <div>
            <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
              {t("smartStaffingHours") || "Hours per day"}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
              {dayKeys.map((k) => {
                const value = proposal.operating_hours?.[k] || "closed";
                const isClosed = value === "closed";
                return (
                  <div
                    key={k}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${
                      isClosed ? "bg-gray-50 dark:bg-gray-700/30 text-gray-400" : "bg-gray-50 dark:bg-gray-700/30 text-gray-700 dark:text-gray-200"
                    }`}
                  >
                    <span className="font-medium w-10 shrink-0">{labelFor(DAY_LABELS[k])}</span>
                    <span className="tabular-nums">{isClosed ? (t("operatingProfileClosed") || "Closed") : value}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Peak windows */}
          {proposal.peak_windows?.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                {t("smartStaffingPeak") || "Peak windows"}
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                {proposal.peak_windows.map((p, i) => (
                  <span
                    key={i}
                    className="px-2 py-1 rounded-md bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200"
                  >
                    {labelFor(DAY_LABELS[p.day])} {p.start}–{p.end}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Role targets */}
          {proposal.role_targets?.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                {t("smartStaffingRoleTargets") || "Typical staff per shift"}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs">
                {proposal.role_targets.map((r) => (
                  <div
                    key={r.role}
                    className="flex items-center justify-between px-2 py-1 rounded-md bg-gray-50 dark:bg-gray-700/30"
                  >
                    <span className="text-gray-700 dark:text-gray-200 capitalize">
                      {(r.label || r.role).replace("_", " ")}
                    </span>
                    <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                      {Number(r.default_count).toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Data quality footer */}
          {proposal.data_quality && (
            <div className="text-[11px] text-gray-400 dark:text-gray-500">
              {(t("smartStaffingBasedOn") ||
                "Based on {sales} sales across {days} days.")
                .replace("{sales}", String(proposal.data_quality.sales_observed ?? 0))
                .replace("{days}", String(proposal.data_quality.days_observed ?? 0))}
            </div>
          )}
        </div>

        {error && (
          <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={() => onEditClick && onEditClick()}
            className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
          >
            {t("smartStaffingEdit") || "Edit details"}
          </button>
          <button
            onClick={acceptProposal}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold disabled:opacity-50 transition"
          >
            {saving ? (t("saving") || "Saving…") : (t("smartStaffingSaveAction") || "Save these hours")}
          </button>
        </div>
      </div>
      {ToastUI}
    </>
  );
}
