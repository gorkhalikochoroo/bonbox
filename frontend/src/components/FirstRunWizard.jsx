/**
 * FirstRunWizard — guided 60-second setup for brand-new accounts.
 *
 * Why this exists:
 *   Brand-new account → zero sales → every Smart card returns
 *   low-confidence defaults → the dashboard feels like a desert and
 *   the owner thinks "this doesn't know anything yet." First 90
 *   seconds determine whether they come back.
 *
 *   This wizard runs ONCE on first dashboard load. It's deliberately
 *   short: 3 questions, sensible defaults, dismissable. After completion
 *   the operating profile is pre-loaded with the picked preset; the
 *   Smart drift scanner refines it as real data accumulates.
 *
 * Flow (3 quick taps):
 *   1. Confirm business type (already on User.business_type from signup
 *      — we just show it as confirmation, with a re-pick fallback).
 *   2. Pick a typical opening-hours preset:
 *        Early (07:00–17:00) | Standard (10:00–22:00) |
 *        Late-night (16:00–02:00) | Weekend-heavy (Wed–Sun)
 *   3. Either:
 *      • "Snap one kasserapport" → routes to multi-terminal close which
 *        then runs SmartTerminalsCard, OR
 *      • "Skip — set up later" → just saves the operating profile and
 *        closes.
 *
 * Multi-layer:
 *   • Auth-gated PUT /business/operating-profile already validates
 *     payload shape server-side.
 *   • Dismissed flag stored in localStorage AND fired as an event so
 *     we can count completion rate.
 *   • Won't re-show if user has any saved operating profile or has
 *     ≥10 sales (they're not a first-run anymore).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useSmartTelemetry } from "../hooks/useSmartTelemetry";


const STORAGE_KEY = "bonbox_first_run_completed";

// Hour presets. Mirrors common Danish hospitality patterns. Day mask
// "12345" = Mon–Fri; "1234567" = every day; "3456" = Wed–Sat.
const HOUR_PRESETS = [
  {
    id: "early",
    label: { en: "Early — café / bakery", da: "Tidlig — café / bageri" },
    open_days_mask: "1234567",
    hours: {
      mon: "07:00-17:00", tue: "07:00-17:00", wed: "07:00-17:00",
      thu: "07:00-17:00", fri: "07:00-17:00", sat: "08:00-16:00",
      sun: "08:00-16:00",
    },
  },
  {
    id: "standard",
    label: { en: "Standard — restaurant / bistro", da: "Standard — restaurant" },
    open_days_mask: "1234567",
    hours: {
      mon: "10:00-22:00", tue: "10:00-22:00", wed: "10:00-22:00",
      thu: "10:00-22:00", fri: "10:00-23:00", sat: "10:00-23:00",
      sun: "10:00-21:00",
    },
  },
  {
    id: "late_night",
    label: { en: "Late-night — bar / cocktail", da: "Sent — bar / cocktail" },
    open_days_mask: "12345",
    hours: {
      mon: "closed", tue: "16:00-00:00", wed: "16:00-00:00",
      thu: "16:00-01:00", fri: "16:00-02:00", sat: "16:00-02:00",
      sun: "closed",
    },
  },
  {
    id: "weekend",
    label: { en: "Weekend-heavy — retail / market", da: "Weekend — butik / marked" },
    open_days_mask: "23456",
    hours: {
      mon: "closed", tue: "10:00-18:00", wed: "10:00-18:00",
      thu: "10:00-18:00", fri: "10:00-19:00", sat: "10:00-17:00",
      sun: "closed",
    },
  },
];


export default function FirstRunWizard() {
  const { user } = useAuth();
  const { t, lang } = useLanguage();
  const { track } = useSmartTelemetry();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [presetId, setPresetId] = useState("standard");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Trigger logic: only show on a genuinely-fresh account.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    // Already dismissed? → never re-show.
    if (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1") {
      return;
    }
    // Server check: does the owner already have an operating profile +
    // any sales? If yes, they're not first-run. Uses /dashboard/summary
    // which returns `sale_count` for the current month — close enough
    // to "any sales at all" for first-run detection.
    Promise.all([
      api.get("/business/operating-profile").catch(() => ({ data: null })),
      api.get("/dashboard/summary").catch(() => ({ data: null })),
    ]).then(([opRes, sumRes]) => {
      if (!alive) return;
      const hasProfile = !!(opRes.data && opRes.data.open_days_mask);
      const salesCount = Number(sumRes.data?.sale_count ?? 0);
      // First-run heuristic: no profile AND < 10 sales.
      const isFirstRun = !hasProfile && salesCount < 10;
      if (isFirstRun) setOpen(true);
    }).catch(() => { /* silent — wizard is non-critical */ });
    return () => { alive = false; };
  }, [user]);

  if (!open || !user) return null;

  const labelFor = (l) => (l && (l[lang] || l.en)) || "";
  const preset = HOUR_PRESETS.find((p) => p.id === presetId) || HOUR_PRESETS[1];

  function dismiss() {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, "1");
    }
    track("smart_proposal_cancelled", "smart_staffing", {
      vertical: user?.business_type,
    });
    setOpen(false);
  }

  async function savePresetAndContinue(routeAfter = null) {
    setSaving(true);
    setError("");
    try {
      await api.put("/business/operating-profile", {
        open_days_mask: preset.open_days_mask,
        operating_hours: preset.hours,
        peak_windows: [],
      });
      track("smart_proposal_accepted", "smart_staffing", {
        vertical: user?.business_type,
      });
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, "1");
      }
      setOpen(false);
      if (routeAfter) navigate(routeAfter);
    } catch (err) {
      setError(err?.response?.data?.detail || (t("firstRunSaveFailed") || "Couldn't save."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700/60">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {step === 1
                ? (t("firstRunWelcome") || "Welcome to BonBox")
                : (t("firstRunTitle") || "Quick setup")}
            </h2>
            <button
              type="button"
              onClick={dismiss}
              aria-label={t("close") || "Close"}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xl leading-none w-7 h-7 inline-flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              ×
            </button>
          </div>
          <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1">
            {t("firstRunSubtitle") || "60-second setup so the dashboard already knows your business when you land on it."}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-700 dark:text-gray-200">
                {(t("firstRunStep1Body") ||
                  "Looks like you signed up as a {type}. We've pre-loaded sensible defaults for that. You can change anything later.")
                  .replace("{type}", user.business_type || "business")}
              </p>
              <div className="rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
                <span className="font-semibold capitalize">{user.business_type || "business"}</span>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2">
              <p className="text-sm text-gray-700 dark:text-gray-200">
                {t("firstRunStep2Body") || "Pick the pattern closest to your typical week. We'll fine-tune as your sales come in."}
              </p>
              <div className="space-y-2">
                {HOUR_PRESETS.map((p) => (
                  <label
                    key={p.id}
                    className={`block rounded-xl border p-3 cursor-pointer ${
                      presetId === p.id
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                        : "border-gray-200 dark:border-gray-700/60 hover:bg-gray-50 dark:hover:bg-gray-700/30"
                    }`}
                  >
                    <input
                      type="radio"
                      name="hours-preset"
                      value={p.id}
                      checked={presetId === p.id}
                      onChange={() => setPresetId(p.id)}
                      className="sr-only"
                    />
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {labelFor(p.label)}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 font-mono">
                      {Object.entries(p.hours)
                        .filter(([, h]) => h !== "closed")
                        .slice(0, 2)
                        .map(([d, h]) => `${d} ${h}`)
                        .join(" · ")}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-700 dark:text-gray-200">
                {t("firstRunStep3Body") || "Two ways to start. Pick whichever fits tonight."}
              </p>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => savePresetAndContinue("/daily-close/multi")}
                  disabled={saving}
                  className="w-full text-left rounded-xl border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 p-3 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 disabled:opacity-50"
                >
                  <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                    {t("firstRunOptionScan") || "Scan one kasserapport now"}
                  </div>
                  <div className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-0.5">
                    {t("firstRunOptionScanHint") || "We'll read your terminal labels off the slip and finish setup automatically."}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => savePresetAndContinue(null)}
                  disabled={saving}
                  className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700/60 p-3 hover:bg-gray-50 dark:hover:bg-gray-700/30 disabled:opacity-50"
                >
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t("firstRunOptionLater") || "I'll set up later"}
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {t("firstRunOptionLaterHint") || "Skip for now — we'll show smart suggestions as your sales come in."}
                  </div>
                </button>
              </div>
              {error && (
                <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
              )}
            </div>
          )}
        </div>

        {step < 3 && (
          <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
            <button
              type="button"
              onClick={dismiss}
              className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
            >
              {t("firstRunSkip") || "Skip"}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-400">{step}/3</span>
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition"
              >
                {t("firstRunNext") || "Next"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
