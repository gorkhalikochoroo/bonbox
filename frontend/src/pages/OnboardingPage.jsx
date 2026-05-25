/**
 * OnboardingPage — first-time welcome wizard (Task #55).
 *
 * Why this exists:
 *   New users sign up → land on /dashboard → see an empty interface
 *   with no idea what to do. The Daily Brief returns nothing, every
 *   Smart card sits at low-confidence defaults, and the owner thinks
 *   "this doesn't know anything yet." First 90 seconds determine
 *   whether they come back.
 *
 *   The existing FirstRunWizard popped a tiny modal that asked one
 *   question (preset hours). It didn't:
 *     • Capture business identity (CVR / address / industry)
 *     • Confirm tax settings (VAT rate, filing frequency, prices-inc-moms)
 *     • Surface the "share with revisor" stickiness moat
 *
 *   This page does all three in 4 steps, full-screen, in ~90 seconds.
 *
 * Routing:
 *   • /onboarding — protected route, full-screen (no Layout chrome)
 *   • Auto-redirect: AuthProvider sends new users here when
 *     user.onboarding_completed_at is null
 *   • Skip / Finish both POST /auth/onboarding/complete — we never
 *     pester returning users
 *
 * Skip flow:
 *   The wizard is SKIPPABLE at every step. "Skip" still marks
 *   completion so the user lands on /dashboard normally and we
 *   don't re-show. They can re-trigger from Profile → Run onboarding.
 *
 * Multi-layer:
 *   • Backend POST /auth/onboarding/complete is auth-required + audited
 *   • Skip and Finish both call complete — no way to "trap" the user
 *   • CVR lookup uses the same /business/lookup endpoint as Profile
 *     (auth-required, rate-limited, source-of-truth for verification)
 *   • Revisor invite reuses /accountants/invite — already plan-gated;
 *     Free tier sees an UpgradeNudge instead of the input form.
 *
 * Design:
 *   • Stone + emerald palette via existing Card/Button/Icon primitives
 *   • Mobile-first single column, generous touch targets
 *   • Progress chip ("Step 2 of 4") at top right
 *   • Skip link always visible
 *   • Each step has its own validate() so users can't advance with
 *     a half-filled form
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { Button, Card, Icon, UpgradeNudge } from "../components/ui";
import { useEntitlements } from "../hooks/useEntitlements";

// ── Branch type catalog ─────────────────────────────────────────────
//
// Mirrors the verticals registered on User.business_type — names + a
// short hint shown under each tile. Six options keeps the chooser to
// a single 2x3 grid on mobile (no scroll) and 3x2 on desktop.
//
// DK i18n leak fix — `emoji` swapped for `iconName` (Lucide). Owners see
// outline icons that match the rest of the app instead of cross-platform
// emoji drift (Apple vs Windows vs Android render very differently).
const BRANCH_TYPES = [
  { id: "restaurant", iconName: "UtensilsCrossed", labelKey: "branchRestaurant", labelFallback: "Restaurant" },
  { id: "cafe",       iconName: "Coffee",          labelKey: "branchCafe",       labelFallback: "Café" },
  { id: "bar",        iconName: "Beer",            labelKey: "branchBar",        labelFallback: "Bar" },
  { id: "retail",     iconName: "ShoppingBag",     labelKey: "branchRetail",     labelFallback: "Retail" },
  { id: "workshop",   iconName: "Wrench",          labelKey: "branchWorkshop",   labelFallback: "Workshop" },
  { id: "general",    iconName: "Package",         labelKey: "branchGeneral",    labelFallback: "Other" },
];

// ── Tax filing frequency presets ────────────────────────────────────
const FILING_OPTIONS = [
  { id: "half_yearly", labelKey: "filingHalfYearly", labelFallback: "Half-yearly (Danish small biz default)" },
  { id: "quarterly",   labelKey: "filingQuarterly",  labelFallback: "Quarterly" },
  { id: "monthly",     labelKey: "filingMonthly",    labelFallback: "Monthly" },
];

// ── Day-rollover presets ────────────────────────────────────────────
//
// Why this exists on Step 3:
//   The Danish restaurant convention is that service ending at 02:00
//   belongs to YESTERDAY's business day (the kitchen closed at 23:00,
//   the bar coasted to 02:30 — that's one shift). If the dashboard
//   rolls over at midnight, the late-night ring lands on the wrong
//   day's books and the daily-close + kasserapport drift one row.
//
//   Before this step existed the column default was 0 (midnight) and
//   nobody asked, so every DK profile silently lived with the wrong
//   rollover. Now we ask once, default the right preset by currency,
//   and let the owner override later from Profile.
//
// "preset" maps to the integer hour stored on BusinessProfile.day_cutoff_hour.
// "custom" hides the hour behind a 0-23 stepper for owners with niche
// shifts (overnight bakery at 04:00, late-night kebab at 07:00, …).
const CUTOFF_PRESETS = [
  {
    id: "restaurant", hour: 6,
    labelKey: "onbStep3CutoffRestaurant",
    labelFallback: "Restaurant / café (06:00)",
    descKey: "onbStep3CutoffRestaurantDesc",
    descFallback: "Late-night service (02:00) still counts toward yesterday — Danish standard.",
  },
  {
    id: "office", hour: 0,
    labelKey: "onbStep3CutoffOffice",
    labelFallback: "Office hours (00:00)",
    descKey: "onbStep3CutoffOfficeDesc",
    descFallback: "Calendar-day rollover at midnight. Pick this for retail, B2B, workshops.",
  },
];


// ── Step indicator ──────────────────────────────────────────────────

function ProgressDots({ step, total }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-label={`Step ${step} of ${total}`}
      aria-valuenow={step}
      aria-valuemin={1}
      aria-valuemax={total}
    >
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={
            "h-1.5 rounded-full transition-all " +
            (i + 1 === step
              ? "w-6 bg-gray-900"
              : i + 1 < step
                ? "w-1.5 bg-emerald-500/15"
                : "w-1.5 bg-gray-300 dark:bg-gray-700")
          }
        />
      ))}
    </div>
  );
}


// ─── Page ───────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { user, refreshUser } = useAuth();
  // `lang` was previously used to inline a fallback for `onbStep1Headline`
  // ("Velkommen til BonBox" / "Welcome to BonBox"). After the DK i18n leak
  // fix that key is sourced from useLanguage.jsx, so `lang` is no longer
  // referenced here.
  const { t } = useLanguage();
  const { plan: currentPlan, isReady: entReady } = useEntitlements();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [finishing, setFinishing] = useState(false);
  const [stepError, setStepError] = useState("");

  // Step 2 — Business profile state. Pre-fill from User.business_name
  // and business_type so the user only has to tweak, not retype.
  const [biz, setBiz] = useState({
    company_name: user?.business_name || "",
    org_number: "",
    address: "",
    city: "",
    zipcode: "",
    industry: "",
    industry_code: "",
    branch_type: (user?.business_type || "restaurant").toLowerCase(),
  });
  const [cvrSearching, setCvrSearching] = useState(false);
  const [cvrError, setCvrError] = useState("");
  const [cvrSource, setCvrSource] = useState(null);  // 'cvrapi.dk' | 'manual'
  const [savingBusiness, setSavingBusiness] = useState(false);

  // Step 3 — Tax preferences.
  // day_cutoff_mode: "restaurant" | "office" | "custom" — UI choice that
  //   maps to an integer hour at save time. Default is currency-aware:
  //   DKK owners get the restaurant preset (matches the new DB default +
  //   the b2e227a tz_utils helper); everyone else gets office hours.
  // day_cutoff_custom: 0-23 — only consulted when mode === "custom".
  const isDkk = ((user?.currency || "DKK").toUpperCase() === "DKK");
  const [tax, setTax] = useState({
    tax_filing_frequency: "half_yearly",
    prices_include_moms: true,
    accountant_email: "",
    day_cutoff_mode: isDkk ? "restaurant" : "office",
    day_cutoff_custom: isDkk ? 6 : 0,
  });
  const [savingTax, setSavingTax] = useState(false);

  /** Resolve the UI choice to an integer hour for the API payload. */
  const resolveCutoffHour = () => {
    if (tax.day_cutoff_mode === "custom") {
      const v = parseInt(tax.day_cutoff_custom, 10);
      if (Number.isNaN(v)) return isDkk ? 6 : 0;
      if (v < 0) return 0;
      if (v > 23) return 23;
      return v;
    }
    const preset = CUTOFF_PRESETS.find((p) => p.id === tax.day_cutoff_mode);
    return preset ? preset.hour : (isDkk ? 6 : 0);
  };

  // Step 4 — Revisor invite.
  const [revisor, setRevisor] = useState({ email: "", name: "" });
  const [revisorSending, setRevisorSending] = useState(false);
  const [revisorMsg, setRevisorMsg] = useState("");
  const [revisorError, setRevisorError] = useState("");

  // The wizard is plan-gated only at the revisor step (Starter+). All
  // other steps work on Free. We surface an UpgradeNudge — never block.
  //
  // Three-state: null while entitlements load, true on Starter+/Trial,
  // false on confirmed Free.  Without the `entReady` guard, a trial
  // user briefly sees the "See Starter" UpgradeNudge on the revisor
  // step before the real plan lands — the trial-flicker bug.
  const canInviteRevisor = useMemo(
    () => entReady
      ? ["trial", "starter", "pro", "business"].includes(currentPlan)
      : null,
    [currentPlan, entReady],
  );

  // Reset transient state when changing step
  useEffect(() => {
    setStepError("");
  }, [step]);

  // ── CVR auto-fill helper ───────────────────────────────────────────
  // Uses the same /business/lookup endpoint as ProfilePage's
  // BusinessLookup. 8-digit number → direct lookup. Anything shorter
  // → no-op (user is still typing). Server-side rate-limited so we
  // can be eager here without burning the cvrapi quota.
  const lookupCvr = async () => {
    setCvrError("");
    const digits = String(biz.org_number || "").replace(/\D/g, "");
    if (digits.length !== 8) {
      setCvrError(t("onbCvrInvalidLength"));
      return;
    }
    setCvrSearching(true);
    try {
      const res = await api.get("/business/lookup", {
        params: { q: digits, country: "DK" },
      });
      const top = (res.data || [])[0];
      if (!top) {
        setCvrError(t("onbCvrNoMatch"));
        return;
      }
      // Auto-fill — preserve any non-empty user edits so we don't
      // wipe them if the user hit "look up" twice.
      setBiz((b) => ({
        ...b,
        company_name: top.name || b.company_name,
        org_number: top.org_number || digits,
        address: top.address || b.address,
        city: top.city || b.city,
        zipcode: top.zipcode || b.zipcode,
        industry: top.industry || b.industry,
        industry_code: top.industry_code || b.industry_code,
        // Branchekode-based vertical hint — only override if the
        // server told us a confident vertical mapping. Otherwise
        // keep whatever the user (or signup) picked.
        branch_type:
          top.branchekode_inference?.business_type || b.branch_type,
      }));
      setCvrSource(top.source || "cvrapi.dk");
    } catch (err) {
      const msg = err?.response?.data?.detail;
      setCvrError(typeof msg === "string" ? msg : t("onbCvrLookupFailed"));
    } finally {
      setCvrSearching(false);
    }
  };

  // ── Step actions ────────────────────────────────────────────────────

  const goNext = () => setStep((s) => Math.min(4, s + 1));

  /** Save business profile + advance to step 3. */
  const saveBusinessAndNext = async () => {
    const name = (biz.company_name || "").trim();
    if (!name) {
      setStepError(t("onbBusinessNameRequired"));
      return;
    }
    setSavingBusiness(true);
    setStepError("");
    try {
      // Persist business_type on the user (drives sidebar verticals + AI)
      // — only patch if it changed to avoid spurious /auth/me dirty writes.
      if (biz.branch_type && biz.branch_type !== (user?.business_type || "")) {
        await api.patch("/auth/profile", { business_type: biz.branch_type });
      }
      // PUT /business is an upsert. Only send fields the user actually
      // filled — empty strings would clobber the columns.
      const payload = {
        company_name: name,
        country: "DK",
        source: cvrSource || "manual",
      };
      if (biz.org_number) payload.org_number = biz.org_number.replace(/\D/g, "");
      if (biz.address)    payload.address = biz.address;
      if (biz.city)       payload.city = biz.city;
      if (biz.zipcode)    payload.zipcode = biz.zipcode;
      if (biz.industry)   payload.industry = biz.industry;
      if (biz.industry_code) payload.industry_code = biz.industry_code;
      await api.put("/business", payload);
      goNext();
    } catch (err) {
      setStepError(err?.response?.data?.detail || t("onbBusinessSaveFailed"));
    } finally {
      setSavingBusiness(false);
    }
  };

  /** Save tax preferences + accountant email + day-rollover + advance. */
  const saveTaxAndNext = async () => {
    setSavingTax(true);
    setStepError("");
    try {
      // 1. User-level tax prefs (frequency + prices include moms)
      await api.patch("/auth/profile", {
        tax_filing_frequency: tax.tax_filing_frequency,
        prices_include_moms: !!tax.prices_include_moms,
      });
      // 2. Business profile — accountant email (optional) AND the
      //    day_cutoff_hour from the rollover chooser. We always send
      //    the cutoff: owners explicitly picked it (or defaulted from
      //    currency), and a stored choice means future schema flips
      //    won't silently change their dashboard rollover.
      const cutoffHour = resolveCutoffHour();
      const email = (tax.accountant_email || "").trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        // Light client-side validation (server has the real validator)
        setStepError(t("onbAccountantEmailInvalid"));
        setSavingTax(false);
        return;
      }
      // Echo company_name so PUT (which uses exclude_unset semantics
      // for nothing — it sets fields directly) doesn't blank it.
      const bizPayload = {
        company_name: biz.company_name,
        day_cutoff_hour: cutoffHour,
      };
      if (email) bizPayload.accountant_email = email;
      await api.put("/business", bizPayload);
      goNext();
    } catch (err) {
      setStepError(err?.response?.data?.detail || t("onbTaxSaveFailed"));
    } finally {
      setSavingTax(false);
    }
  };

  /** Optionally send a revisor invite, then complete onboarding. */
  const sendInviteAndFinish = async () => {
    const email = (revisor.email || "").trim().toLowerCase();
    if (email) {
      if (!canInviteRevisor) {
        // UI already shows the UpgradeNudge — never silently swallow.
        setRevisorError(t("onbRevisorStarterRequired"));
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setRevisorError(t("onbRevisorEmailInvalid"));
        return;
      }
      setRevisorSending(true);
      setRevisorError("");
      try {
        await api.post("/accountants/invite", {
          email,
          name: (revisor.name || "").trim() || null,
        });
        setRevisorMsg(t("onbRevisorInviteSent", { email }));
      } catch (err) {
        const detail = err?.response?.data?.detail;
        const code = detail && typeof detail === "object" ? detail.code : null;
        if (code === "plan_required") {
          setRevisorError(t("onbRevisorStarterRequired"));
        } else if (code === "already_active_grant") {
          // Treat as success — they already share with this revisor
          setRevisorMsg(t("onbRevisorAlreadyActive"));
        } else {
          setRevisorError(
            (detail && (detail.message || detail)) || t("onbRevisorInviteFailed"),
          );
          setRevisorSending(false);
          return;
        }
      } finally {
        setRevisorSending(false);
      }
    }
    await finishOnboarding();
  };

  /** POST the completion stamp and redirect to /dashboard. */
  const finishOnboarding = async () => {
    setFinishing(true);
    try {
      await api.post("/auth/onboarding/complete");
      // Refresh the local user object so AuthProvider.user.onboarding_completed_at
      // is populated — otherwise a quick back-button click could re-trigger.
      try { await refreshUser?.(); } catch { /* best-effort */ }
    } catch {
      // Even on failure we don't trap the user — fall through to /dashboard.
      // Next /auth/me will reveal the real state.
    } finally {
      setFinishing(false);
      navigate("/dashboard", { replace: true });
    }
  };

  // "Skip and explore on my own" — also stamps completion. We never
  // want the wizard to pop again automatically; the user can re-open
  // from Profile.
  const skipWizard = async () => {
    await finishOnboarding();
  };

  // If somehow the user has already completed onboarding (e.g. tab
  // reopened post-finish) bounce them to /dashboard right away.
  useEffect(() => {
    if (user?.onboarding_completed_at) {
      navigate("/dashboard", { replace: true });
    }
  }, [user, navigate]);

  if (!user) return null;

  const totalSteps = 4;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Top bar — progress + skip */}
      <header className="sticky top-0 z-10 bg-gray-50/90 dark:bg-gray-950/90 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gray-900 grid place-items-center text-white font-semibold text-sm">
              B
            </div>
            <span className="text-sm font-semibold tracking-tight">BonBox</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
              {t("onbStepCounter", { n: step, total: totalSteps })}
            </span>
            <ProgressDots step={step} total={totalSteps} />
            <button
              type="button"
              onClick={skipWizard}
              disabled={finishing}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline-offset-2 hover:underline disabled:opacity-50"
            >
              {t("onbSkipExplore")}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* ─── Step 1 — Welcome ──────────────────────────────────── */}
        {step === 1 && (
          <Card className="text-center">
            <div className="mb-4 flex justify-center text-emerald-600" aria-hidden="true">
              <Icon name="Sparkles" size={36} />
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-2">
              {t("onbStep1Headline")}
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-6 max-w-md mx-auto leading-relaxed">
              {t("onbStep1Subhead")}
            </p>

            <div className="grid sm:grid-cols-3 gap-3 mb-8 text-left">
              <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                <Icon name="ShoppingBag" size={20} className="text-emerald-600 mb-1.5" />
                <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {t("onbStep1Card1Title")}
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                  {t("onbStep1Card1Body")}
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                <Icon name="Calculator" size={20} className="text-emerald-600 mb-1.5" />
                <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {t("onbStep1Card2Title")}
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                  {t("onbStep1Card2Body")}
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                <Icon name="Send" size={20} className="text-emerald-600 mb-1.5" />
                <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {t("onbStep1Card3Title")}
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                  {t("onbStep1Card3Body")}
                </p>
              </div>
            </div>

            <Button variant="accent" size="lg" onClick={goNext}>
              {t("onbStep1Cta")}
              <Icon name="ChevronDown" size={16} className="-rotate-90 ml-1" />
            </Button>
          </Card>
        )}

        {/* ─── Step 2 — Business profile ─────────────────────────── */}
        {step === 2 && (
          <Card>
            <div className="mb-5">
              <h2 className="text-lg font-semibold tracking-tight">
                {t("onbStep2Title")}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t("onbStep2Subtitle")}
              </p>
            </div>

            {/* CVR with one-click lookup */}
            <div className="mb-4">
              <label htmlFor="onb-cvr" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t("onbStep2CvrLabel")}
              </label>
              <div className="flex gap-2">
                <input
                  id="onb-cvr"
                  type="text"
                  inputMode="numeric"
                  value={biz.org_number}
                  onChange={(e) =>
                    setBiz({ ...biz, org_number: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      lookupCvr();
                    }
                  }}
                  placeholder="12345678"
                  maxLength={11}
                  aria-describedby={cvrError ? "onb-cvr-error" : undefined}
                  aria-invalid={!!cvrError}
                  className="flex-1 px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                />
                <Button
                  variant="secondary"
                  onClick={lookupCvr}
                  busy={cvrSearching}
                  disabled={cvrSearching}
                >
                  {t("onbStep2CvrLookup")}
                </Button>
              </div>
              {cvrSource && (
                <p className="text-[11px] text-gray-700 dark:text-emerald-400 mt-1.5 flex items-center gap-1">
                  <Icon name="CheckCircle2" size={12} />
                  {t("onbStep2CvrLoaded", { source: cvrSource })}
                </p>
              )}
              {cvrError && (
                <p id="onb-cvr-error" role="alert" aria-live="polite" className="text-[11px] text-amber-700 dark:text-amber-400 mt-1.5">
                  {cvrError}
                </p>
              )}
            </div>

            {/* Business name (required) */}
            <div className="mb-4">
              <label htmlFor="onb-biz-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t("onbStep2NameLabel")}
                <span className="text-red-600 ml-0.5" aria-hidden="true">*</span>
                <span className="sr-only"> (required)</span>
              </label>
              <input
                id="onb-biz-name"
                type="text"
                required
                aria-required="true"
                value={biz.company_name}
                onChange={(e) =>
                  setBiz({ ...biz, company_name: e.target.value })
                }
                placeholder={t("onbStep2NamePlaceholder")}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
              />
            </div>

            {/* Branch type — chooser */}
            <fieldset className="mb-2">
              <legend className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t("onbStep2BranchLabel")}
              </legend>
              <div
                className="grid grid-cols-2 sm:grid-cols-3 gap-2"
                role="radiogroup"
                aria-label={t("onbStep2BranchLabel")}
              >
                {BRANCH_TYPES.map((b) => {
                  const active = biz.branch_type === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setBiz({ ...biz, branch_type: b.id })}
                      className={
                        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 " +
                        (active
                          ? "border-gray-300 bg-gray-50 dark:bg-gray-800/50 ring-1 ring-gray-400"
                          : "border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700")
                      }
                    >
                      <span className="text-gray-600 dark:text-gray-300" aria-hidden="true">
                        <Icon name={b.iconName} size={20} />
                      </span>
                      <span className="text-sm font-medium">
                        {t(b.labelKey) || b.labelFallback}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {stepError && (
              <p className="text-xs text-red-700 dark:text-red-400 mt-3" role="alert" aria-live="assertive">{stepError}</p>
            )}

            <div className="flex items-center justify-between gap-3 mt-6 pt-5 border-t border-gray-200 dark:border-gray-800">
              <Button variant="ghost" onClick={() => setStep(1)}>
                {t("onbBack")}
              </Button>
              <Button
                variant="accent"
                onClick={saveBusinessAndNext}
                busy={savingBusiness}
              >
                {t("onbNext")}
              </Button>
            </div>
          </Card>
        )}

        {/* ─── Step 3 — Tax preferences ──────────────────────────── */}
        {step === 3 && (
          <Card>
            <div className="mb-5">
              <h2 className="text-lg font-semibold tracking-tight">
                {t("onbStep3Title")}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t("onbStep3Subtitle")}
              </p>
            </div>

            {/* Filing frequency */}
            <fieldset className="mb-5">
              <legend className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t("onbStep3FilingLabel")}
              </legend>
              <div className="space-y-2" role="radiogroup" aria-label={t("onbStep3FilingLabel")}>
                {FILING_OPTIONS.map((opt) => {
                  const active = tax.tax_filing_frequency === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() =>
                        setTax({ ...tax, tax_filing_frequency: opt.id })
                      }
                      className={
                        "w-full text-left flex items-center gap-3 rounded-lg border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 " +
                        (active
                          ? "border-gray-300 bg-gray-50 dark:bg-gray-800/50 ring-1 ring-gray-400"
                          : "border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700")
                      }
                    >
                      <span
                        aria-hidden="true"
                        className={
                          "w-4 h-4 rounded-full border-2 shrink-0 " +
                          (active
                            ? "bg-gray-900 border-gray-900 ring-2 ring-gray-200 dark:ring-gray-700/40"
                            : "border-gray-400 dark:border-gray-600")
                        }
                      />
                      <span className="text-sm">
                        {t(opt.labelKey) || opt.labelFallback}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Prices include VAT toggle */}
            <div className="mb-5 flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-800 p-3.5">
              <div className="min-w-0">
                <p id="onb-vat-toggle-label" className="text-sm font-medium">
                  {t("onbStep3VatToggle")}
                </p>
                <p id="onb-vat-toggle-hint" className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">
                  {t("onbStep3VatToggleHint")}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={tax.prices_include_moms}
                aria-labelledby="onb-vat-toggle-label"
                aria-describedby="onb-vat-toggle-hint"
                onClick={() =>
                  setTax({ ...tax, prices_include_moms: !tax.prices_include_moms })
                }
                className={
                  "shrink-0 w-11 h-6 rounded-full relative transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 " +
                  (tax.prices_include_moms
                    ? "bg-gray-900"
                    : "bg-gray-300 dark:bg-gray-700")
                }
              >
                <span
                  aria-hidden="true"
                  className={
                    "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform " +
                    (tax.prices_include_moms ? "translate-x-5" : "translate-x-0")
                  }
                />
              </button>
            </div>

            {/* Day rollover — when does the business day end?
                Drives kasserapport / daily-close / live-KPI windows. */}
            <fieldset className="mb-5">
              <legend className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t("onbStep3CutoffLabel")}
              </legend>
              <p
                id="onb-cutoff-hint"
                className="text-[11px] text-gray-600 dark:text-gray-400 mb-2 leading-relaxed"
              >
                {t("onbStep3CutoffHint")}
              </p>
              <div
                className="space-y-2"
                role="radiogroup"
                aria-label={t("onbStep3CutoffLabel")}
                aria-describedby="onb-cutoff-hint"
              >
                {CUTOFF_PRESETS.map((opt) => {
                  const active = tax.day_cutoff_mode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() =>
                        setTax({ ...tax, day_cutoff_mode: opt.id })
                      }
                      className={
                        "w-full text-left flex items-start gap-3 rounded-lg border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 " +
                        (active
                          ? "border-gray-300 bg-gray-50 dark:bg-gray-800/50 ring-1 ring-gray-400"
                          : "border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700")
                      }
                    >
                      <span
                        aria-hidden="true"
                        className={
                          "mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 " +
                          (active
                            ? "bg-gray-900 border-gray-900 ring-2 ring-gray-200 dark:ring-gray-700/40"
                            : "border-gray-400 dark:border-gray-600")
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {t(opt.labelKey) || opt.labelFallback}
                        </span>
                        <span className="block text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">
                          {t(opt.descKey) || opt.descFallback}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {/* Custom row — radio + hour input as siblings so the
                    interactive number input is NOT nested in the radio
                    button (which would be invalid HTML). Clicking the
                    number input also flips the mode to custom so the
                    visual state stays consistent. */}
                <div
                  className={
                    "w-full flex items-center gap-3 rounded-lg border p-3 transition " +
                    (tax.day_cutoff_mode === "custom"
                      ? "border-gray-300 bg-gray-50 dark:bg-gray-800/50 ring-1 ring-gray-400"
                      : "border-gray-200 dark:border-gray-800")
                  }
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={tax.day_cutoff_mode === "custom"}
                    onClick={() => setTax({ ...tax, day_cutoff_mode: "custom" })}
                    className="flex items-center gap-3 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded"
                  >
                    <span
                      aria-hidden="true"
                      className={
                        "w-4 h-4 rounded-full border-2 shrink-0 " +
                        (tax.day_cutoff_mode === "custom"
                          ? "bg-gray-900 border-gray-900 ring-2 ring-gray-200 dark:ring-gray-700/40"
                          : "border-gray-400 dark:border-gray-600")
                      }
                    />
                    <span className="text-sm font-medium">
                      {t("onbStep3CutoffCustom")}
                    </span>
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    step={1}
                    value={tax.day_cutoff_custom}
                    onChange={(e) =>
                      setTax({
                        ...tax,
                        day_cutoff_mode: "custom",
                        day_cutoff_custom: e.target.value,
                      })
                    }
                    onFocus={() =>
                      setTax((tx) => ({ ...tx, day_cutoff_mode: "custom" }))
                    }
                    aria-label={t("onbStep3CutoffCustomAria")}
                    className="w-16 px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gray-400"
                  />
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">
                    {t("onbStep3CutoffCustomSuffix")}
                  </span>
                </div>
              </div>
            </fieldset>

            {/* Accountant email (optional) */}
            <div className="mb-2">
              <label htmlFor="onb-acct-email" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t("onbStep3AccountantLabel")}
              </label>
              <input
                id="onb-acct-email"
                type="email"
                value={tax.accountant_email}
                onChange={(e) =>
                  setTax({ ...tax, accountant_email: e.target.value })
                }
                placeholder="revisor@example.dk"
                autoComplete="off"
                aria-describedby="onb-acct-email-hint"
                className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
              />
              <p id="onb-acct-email-hint" className="text-[11px] text-gray-600 dark:text-gray-400 mt-1.5">
                {t("onbStep3AccountantHint")}
              </p>
              {/* Task #89 P3-8 — disambiguation note: Step 3 asks for
                  the "send-to" address used by the Email kasserapport
                  button, Step 4 invites a revisor to log in directly.
                  Same accountant 95% of the time, but two different
                  channels — explicit copy here saves a support ticket
                  ("Why does it ask for the same email twice?"). */}
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5 italic">
                {t("onbStep3AccountantDisambig")}
              </p>
            </div>

            {stepError && (
              <p className="text-xs text-red-700 dark:text-red-400 mt-3" role="alert" aria-live="assertive">{stepError}</p>
            )}

            <div className="flex items-center justify-between gap-3 mt-6 pt-5 border-t border-gray-200 dark:border-gray-800">
              <Button variant="ghost" onClick={() => setStep(2)}>
                {t("onbBack")}
              </Button>
              <Button
                variant="accent"
                onClick={saveTaxAndNext}
                busy={savingTax}
              >
                {t("onbNext")}
              </Button>
            </div>
          </Card>
        )}

        {/* ─── Step 4 — Revisor invite (optional) ─────────────────── */}
        {step === 4 && (
          <Card>
            <div className="mb-5">
              <h2 className="text-lg font-semibold tracking-tight">
                {t("onbStep4Title")}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t("onbStep4Subtitle")}
              </p>
            </div>

            {canInviteRevisor === null ? (
              // Tier-flicker fix: while entitlements are loading, render
              // a low-contrast skeleton instead of the locked upsell —
              // trial users would otherwise see the "See Starter" nudge
              // flash before their real plan arrives.
              <div className="mb-5 h-32 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" aria-hidden="true" />
            ) : canInviteRevisor === false ? (
              <div className="mb-5">
                <UpgradeNudge
                  intent="card"
                  tier="starter"
                  icon={<Icon name="Users" size={20} />}
                  benefit={t("onbStep4Upsell")}
                  ctaLabel={t("onbStep4SeeStarter")}
                  cta="/subscription"
                />
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3">
                  {t("onbStep4SkipForNow")}
                </p>
              </div>
            ) : (
              <>
                <div className="mb-4">
                  <label htmlFor="onb-revisor-email" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    {t("onbStep4EmailLabel")}
                  </label>
                  <input
                    id="onb-revisor-email"
                    type="email"
                    value={revisor.email}
                    onChange={(e) =>
                      setRevisor({ ...revisor, email: e.target.value })
                    }
                    placeholder="anna@revision.dk"
                    autoComplete="off"
                    aria-invalid={!!revisorError}
                    aria-describedby={revisorError ? "onb-revisor-error" : undefined}
                    className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                  />
                </div>
                <div className="mb-2">
                  <label htmlFor="onb-revisor-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                    {t("onbStep4NameLabel")}
                  </label>
                  <input
                    id="onb-revisor-name"
                    type="text"
                    value={revisor.name}
                    onChange={(e) =>
                      setRevisor({ ...revisor, name: e.target.value })
                    }
                    placeholder={t("onbStep4NamePlaceholder")}
                    aria-describedby="onb-revisor-name-hint"
                    className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                  />
                  <p id="onb-revisor-name-hint" className="text-[11px] text-gray-600 dark:text-gray-400 mt-1.5">
                    {t("onbStep4NameHint")}
                  </p>
                </div>
              </>
            )}

            {revisorMsg && (
              <p className="text-xs text-gray-700 dark:text-emerald-400 mt-3 flex items-center gap-1" role="status" aria-live="polite">
                <Icon name="CheckCircle2" size={12} />
                {revisorMsg}
              </p>
            )}
            {revisorError && (
              <p id="onb-revisor-error" className="text-xs text-red-700 dark:text-red-400 mt-3" role="alert" aria-live="assertive">
                {revisorError}
              </p>
            )}

            <div className="flex items-center justify-between gap-3 mt-6 pt-5 border-t border-gray-200 dark:border-gray-800">
              <Button
                variant="ghost"
                onClick={() => setStep(3)}
                disabled={revisorSending || finishing}
              >
                {t("onbBack")}
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={finishOnboarding}
                  disabled={revisorSending || finishing}
                >
                  {t("onbStep4SkipBtn")}
                </Button>
                <Button
                  variant="accent"
                  onClick={sendInviteAndFinish}
                  busy={revisorSending || finishing}
                >
                  {revisor.email && canInviteRevisor
                    ? t("onbStep4Finish")
                    : t("onbStep4FinishNoInvite")}
                </Button>
              </div>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}
