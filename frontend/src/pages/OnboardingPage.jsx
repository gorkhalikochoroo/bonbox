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
 * Design (premium pass — Linear/Stripe/Vercel onboarding bar):
 *   • Gray-900 primary; emerald reserved for the "money moment" + success.
 *     No rainbow, no brand gradients. Accents subtle.
 *   • Lucide outline icons; Inter; rounded-xl; generous whitespace.
 *   • Vertically-centred single column, comfortable max-width.
 *   • Step 2's free-text detection is the signature "magic" moment:
 *     a calm working state, then a crisp confirmation card with the
 *     archetype's icon. Manual cards demoted to a tasteful "or pick one".
 *   • Step 4's "what we set up" reads like a concierge prepared the
 *     workspace — elegant feature rows, first-win the clear primary.
 *   • Smooth per-step enter transition keyed on the step index.
 *   • Mobile/tablet/desktop + notch/safe-area aware, ≥44px tap targets.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { isNativeApp } from "../utils/platform";
import { errText } from "../utils/errText";
import { Button, Icon, UpgradeNudge } from "../components/ui";
import { useEntitlements } from "../hooks/useEntitlements";
import { archetypeFor } from "../config/archetypes";
import { PILLAR_DISPLAY } from "../config/navManifest";

// ── Archetype semantic-key → owner-facing label + real route ─────────
//
// The archetype layer (config/archetypes.js) speaks in semantic keys
// (daily_close | tax | reservations | schedule | inventory | faktura |
// expenses) for both leadFeatures[] and firstWin. The wizard maps each
// to (a) an i18n label and (b) a REAL route verified against App.jsx.
// Anything unmapped degrades to /dashboard so a future archetype key can
// never produce a dead link.
//
// Route verification (App.jsx):
//   daily_close  → /daily-close   (DailyClosePage; "Today"/close surface)
//   tax          → /tax           (TaxAutopilotPage)
//   reservations → /reservations  (ReservationsPage — there is NO /bookings)
//   schedule     → /staff/schedule (StaffSchedulePage)
//   inventory    → /inventory     (InventoryPage)
//   faktura      → /faktura       (FakturaPage)
//   expenses     → /expenses      (ExpensesPage)
// icon names below are keys in components/ui/Icon.jsx's ICONS map (Lucide).
// `descKey` is a one-line "what this does for you" line for the concierge
// setup panel (Step 4) so each row reads bespoke, not like a raw checklist.
const LEAD_FEATURE_META = {
  daily_close:  { labelKey: "onbFeatDailyClose",   icon: "ClipboardList", route: "/daily-close",    descKey: "onbFeatDailyCloseDesc" },
  tax:          { labelKey: "onbFeatTax",          icon: "Calculator",    route: "/tax",            descKey: "onbFeatTaxDesc" },
  reservations: { labelKey: "onbFeatReservations", icon: "CalendarClock", route: "/reservations",   descKey: "onbFeatReservationsDesc" },
  schedule:     { labelKey: "onbFeatSchedule",     icon: "Calendar",      route: "/staff/schedule", descKey: "onbFeatScheduleDesc" },
  inventory:    { labelKey: "onbFeatInventory",    icon: "Package",       route: "/inventory",      descKey: "onbFeatInventoryDesc" },
  faktura:      { labelKey: "onbFeatFaktura",      icon: "FileText",      route: "/faktura",        descKey: "onbFeatFakturaDesc" },
  expenses:     { labelKey: "onbFeatExpenses",     icon: "Receipt",       route: "/expenses",       descKey: "onbFeatExpensesDesc" },
};

/** Resolve an archetype firstWin / leadFeature semantic key → a real route.
 *  Unknown keys fall back to /dashboard so we never route nowhere. */
function routeForFeature(key) {
  return LEAD_FEATURE_META[key]?.route || "/dashboard";
}

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
  // C12: takeaway / fast food — counter trade, no table reservations. A real
  // signup business_type with its own DK preset (hides reservations/events/
  // inventory/insights; Staff stays on). Bike reads as takeaway/delivery.
  { id: "takeaway",   iconName: "Bike",            labelKey: "branchTakeaway",   labelFallback: "Takeaway" },
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
//
// A refined segmented progress rail (Linear/Stripe flavour) rather than
// dots: each step is a thin pill that fills to gray-900 once reached, with
// a subtle emerald tick on completed steps. The active pill is widest.
function ProgressRail({ step, total }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-label={`Step ${step} of ${total}`}
      aria-valuenow={step}
      aria-valuemin={1}
      aria-valuemax={total}
    >
      {Array.from({ length: total }).map((_, i) => {
        const idx = i + 1;
        const done = idx < step;
        const current = idx === step;
        return (
          <span
            key={i}
            aria-hidden="true"
            className={
              "h-1 rounded-full transition-all duration-500 ease-out " +
              (current
                ? "w-7 bg-gray-900 dark:bg-gray-100"
                : done
                  ? "w-4 bg-gray-900/35 dark:bg-gray-100/35"
                  : "w-4 bg-gray-200 dark:bg-gray-800")
            }
          />
        );
      })}
    </div>
  );
}


// ── Step header — one consistent rhythm for every step ───────────────
//
// Eyebrow (uppercase tracked, the canonical label treatment) + H2 +
// optional lede. Keeping this in one component is what gives the wizard
// its calm, repeatable vertical rhythm across all four steps.
function StepHeader({ eyebrow, title, lede, center = false }) {
  return (
    <div className={center ? "text-center" : ""}>
      {eyebrow && (
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400 dark:text-gray-500 mb-2">
          {eyebrow}
        </p>
      )}
      <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-50">
        {title}
      </h2>
      {lede && (
        <p className={"text-sm text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed " + (center ? "max-w-md mx-auto" : "max-w-lg")}>
          {lede}
        </p>
      )}
    </div>
  );
}


// ── Field label — shared, calm form-label treatment ──────────────────
function FieldLabel({ htmlFor, children, required = false }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
    >
      {children}
      {required && (
        <>
          <span className="text-red-600 ml-0.5" aria-hidden="true">*</span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </label>
  );
}

// One field-chrome string so every input in the wizard is pixel-identical
// (matches the Input primitive's neutral border + gray focus ring without
// re-deriving it per field). 44px min height satisfies the touch floor.
const FIELD =
  "w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border bg-white dark:bg-gray-900 " +
  "text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 " +
  "border-gray-200 dark:border-gray-700 transition " +
  "focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400 " +
  "dark:focus:ring-gray-500 dark:focus:border-gray-500";


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

  // Step 2 — smart free-text archetype detection (Milestone 1).
  //   detectText:   what the owner typed ("a small bakery", "bike repair")
  //   detecting:    spinner flag while the endpoint is in flight
  //   detected:     the resolved archetype `summary` ({id,labelKey,…}) used
  //                 for the confirmation line. Null until a successful hit.
  // Everything here is best-effort: if /api/onboarding/detect-archetype is
  // missing, slow, or errors, we swallow it and leave the manual cards as
  // the source of truth (never block, never show a scary error).
  const [detectText, setDetectText] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(null);
  const detectTimer = useRef(null);
  const detectSeq = useRef(0);  // guards against out-of-order responses

  // Resolved archetype for the CURRENTLY selected branch_type. Drives the
  // Step 3 cutoff default + the "what we set up" panel + the finish route.
  // archetypeFor never throws (unknown → generic).
  const resolvedArchetype = useMemo(
    () => archetypeFor(biz.branch_type),
    [biz.branch_type],
  );

  // ── C12 — onboarding pillar preset as VISIBLE pre-checked chips ──────
  //
  // The ONE settings moment ~95% of owners ever see. Instead of silently
  // applying the DK preset, we show it: "Based on [type] we turned on…"
  // with the ON pillars as checked chips (the owner can uncheck) and the
  // OFF-by-preset pillars as unchecked chips they can add (e.g. a café
  // gets Reservations as an easy add — DK brunch booking).
  //
  //   pillarOff   Set<string>  the LIVE owner selection of HIDDEN pillars
  //                            (the OFF-list). A pillar IN this set = chip
  //                            unchecked (hidden); NOT in it = checked (on).
  //   presetOff   Set<string>  the resolved suggestion (for the "reset to
  //                            suggested" telemetry framing + headline copy).
  //   pillarReady bool         false until the preset resolves the first time
  //                            for the current type (chips render skeleton).
  // Source of truth is the committed preset endpoint GET /api/pillars/preset
  // (?business_type=…) — pure read, never writes. On continue we commit the
  // possibly-overridden OFF-list via PUT /api/pillars (saveBusinessAndNext).
  // Fail-soft: an erroring endpoint just leaves an empty suggestion (nothing
  // pre-hidden) and the backend onboarding-complete auto-apply still covers
  // the owner who skips. Skippable — continuing with defaults is fine.
  const [pillarOff, setPillarOff] = useState(new Set());
  const [presetOff, setPresetOff] = useState(new Set());
  const [pillarReady, setPillarReady] = useState(false);
  // Once the owner edits a chip for the CURRENT type, stop letting a late
  // preset fetch re-seed and clobber their choice. Reset when type changes.
  const pillarTouched = useRef(false);
  const presetSeq = useRef(0);

  // Re-resolve the preset whenever the selected/detected branch_type changes.
  // A new type is a fresh suggestion, so we reset the owner's touched flag and
  // re-seed both sets — UNLESS they've already shaped chips for THIS type.
  useEffect(() => {
    const bt = (biz.branch_type || "").trim();
    pillarTouched.current = false;
    setPillarReady(false);
    const seq = ++presetSeq.current;
    api
      .get("/pillars/preset", { params: { business_type: bt }, _noRetry: true })
      .then((res) => {
        if (seq !== presetSeq.current) return; // a newer type won
        const suggested = Array.isArray(res.data?.suggested)
          ? res.data.suggested
          : [];
        const off = new Set(suggested);
        setPresetOff(off);
        // Only seed the live selection if the owner hasn't touched chips for
        // this type yet (guards an out-of-order resolve after a quick edit).
        if (!pillarTouched.current) setPillarOff(new Set(off));
        setPillarReady(true);
      })
      .catch(() => {
        // Fail-soft — empty suggestion (nothing pre-hidden). The backend
        // auto-apply at onboarding-complete still seeds the preset for an
        // owner who never sees / touches these chips.
        if (seq !== presetSeq.current) return;
        setPresetOff(new Set());
        if (!pillarTouched.current) setPillarOff(new Set());
        setPillarReady(true);
      });
  }, [biz.branch_type]);

  /** Toggle a pillar chip. `on` = the desired ON state (checked). ON means
   *  REMOVE from the OFF-list; OFF means ADD to it. */
  const togglePillar = (pillarId, on) => {
    pillarTouched.current = true;
    setPillarOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(pillarId);
      else next.add(pillarId);
      return next;
    });
  };

  // The preset's OFF set, ordered by the canonical PILLAR_DISPLAY order, split
  // into the chips that are ON by preset (shown first, pre-checked) and the
  // ones the preset turned OFF (shown after, as easy adds). Both are derived
  // from the SUGGESTION so the layout is stable while the owner toggles.
  const presetOnPillars = useMemo(
    () => PILLAR_DISPLAY.filter((p) => !presetOff.has(p.id)),
    [presetOff],
  );
  const presetOffPillars = useMemo(
    () => PILLAR_DISPLAY.filter((p) => presetOff.has(p.id)),
    [presetOff],
  );

  // Step 3 — Tax preferences.
  // day_cutoff_mode: "restaurant" | "office" | "custom" — UI choice that
  //   maps to an integer hour at save time. Default is ARCHETYPE-aware
  //   (Milestone 1): food_service / bar roll over at 06:00 (restaurant
  //   preset — late service belongs to yesterday), everyone else uses
  //   office hours (00:00). isDkk is only a last-resort fallback hour in
  //   resolveCutoffHour() (NaN custom input / unrecognized mode).
  // day_cutoff_custom: 0-23 — only consulted when mode === "custom".
  const isDkk = ((user?.currency || "DKK").toUpperCase() === "DKK");
  // Which preset does an archetype want? Restaurant 06:00 vs office 00:00.
  const cutoffModeForArchetype = (arch) =>
    arch?.id === "food_service" || arch?.id === "bar" ? "restaurant" : "office";
  const [tax, setTax] = useState({
    tax_filing_frequency: "half_yearly",
    prices_include_moms: true,
    accountant_email: "",
    day_cutoff_mode: cutoffModeForArchetype(resolvedArchetype),
    day_cutoff_custom: 6,
  });
  const [savingTax, setSavingTax] = useState(false);
  // True once the owner explicitly picks a cutoff option. Until then we let
  // the archetype re-default the cutoff as their detected/selected branch
  // changes — but we NEVER clobber a deliberate choice.
  const cutoffTouched = useRef(false);

  // Keep the cutoff default aligned to the resolved archetype as long as the
  // owner hasn't manually chosen one. food_service/bar → restaurant (06:00),
  // everything else → office (00:00). Once they tap a preset, this no-ops.
  useEffect(() => {
    if (cutoffTouched.current) return;
    const nextMode = cutoffModeForArchetype(resolvedArchetype);
    setTax((tx) =>
      tx.day_cutoff_mode === nextMode ? tx : { ...tx, day_cutoff_mode: nextMode },
    );
  }, [resolvedArchetype]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Smart archetype detection (Milestone 1) ────────────────────────
  // POST the owner's free-text description to /api/onboarding/detect-
  // archetype and, on a confident hit, preselect the matching branch_type
  // + show a one-line confirmation. The api client's baseURL already ends
  // in /api, so we hit the bare path here.
  //
  // GRACEFUL BY DESIGN — this is a nice-to-have accelerator, never a gate:
  //   • <2 chars → no-op (still typing)
  //   • endpoint missing / 4xx / 5xx / timeout → swallow, keep manual cards
  //   • out-of-order responses dropped via a sequence guard
  // The owner can always override by tapping a card; detection never locks
  // anything in.
  const detectArchetype = async (raw) => {
    const text = String(raw || "").trim();
    if (text.length < 2) return;
    const seq = ++detectSeq.current;
    setDetecting(true);
    try {
      // _noRetry: a missing/erroring detect endpoint shouldn't spin the
      // axios retry ladder for ~26s — fail fast and fall back to cards.
      const res = await api.post(
        "/onboarding/detect-archetype",
        { text },
        { _noRetry: true },
      );
      // Ignore a stale response if the owner kept typing (newer call wins).
      if (seq !== detectSeq.current) return;
      const data = res?.data || {};
      const bt = data.business_type;
      // Only act on a usable response. If the contract isn't met we leave
      // the manual cards untouched — no error surfaced to the owner.
      if (bt && typeof bt === "string") {
        // Preselect the precise detected business_type. archetypeFor()
        // resolves it for the cutoff / panel / route even when it's not
        // one of the 6 cards; the card grid highlights by archetype.
        const localArch = archetypeFor(bt);
        setBiz((b) => ({ ...b, branch_type: bt.toLowerCase() }));
        // Confirmation line: resolve the labelKey from the LOCAL archetype
        // config (guaranteed to be in i18n) rather than trusting the
        // backend's summary.labelKey — so the line can never leak a raw key.
        setDetected({ id: localArch.id, labelKey: localArch.labelKey });
      }
    } catch {
      // Endpoint may not exist yet in this build, or upstream is down.
      // Stay silent — the manual cards remain the source of truth.
      if (seq === detectSeq.current) setDetected(null);
    } finally {
      if (seq === detectSeq.current) setDetecting(false);
    }
  };

  // Debounced trigger — fires ~600ms after the owner stops typing. Blur /
  // Enter call detectArchetype directly (see the input handlers in Step 2).
  const onDescribeChange = (value) => {
    setDetectText(value);
    if (detectTimer.current) clearTimeout(detectTimer.current);
    if (String(value || "").trim().length < 2) {
      setDetected(null);
      return;
    }
    detectTimer.current = setTimeout(() => detectArchetype(value), 600);
  };

  // Clear any pending debounce timer on unmount.
  useEffect(() => () => {
    if (detectTimer.current) clearTimeout(detectTimer.current);
  }, []);

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

      // C12 — commit the (possibly-overridden) pillar preset. Full-set
      // semantics: the list IS the new OFF-list. This sets hidden_pillars
      // non-NULL, which short-circuits the backend's onboarding-complete
      // auto-apply guard so the owner's CONFIRMED selection wins over the
      // blind preset. Fail-soft — a PUT error must never block onboarding;
      // the backend auto-apply then seeds the plain preset at /complete.
      try {
        await api.put("/pillars", { hidden: [...pillarOff] });
      } catch { /* non-blocking — backend auto-apply covers this owner */ }

      goNext();
    } catch (err) {
      setStepError(errText(err, t("onbBusinessSaveFailed")));
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
      setStepError(errText(err, t("onbTaxSaveFailed")));
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
        // App Store compliance (Apple 3.1.1): neutral copy on native (no tier
        // name / "Upgrade"). Web keeps the conversion wording.
        setRevisorError(isNativeApp() ? t("revisorPlanRequiredNative") : t("onbRevisorStarterRequired"));
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
          // App Store compliance (Apple 3.1.1): neutral copy on native (no tier
        // name / "Upgrade"). Web keeps the conversion wording.
        setRevisorError(isNativeApp() ? t("revisorPlanRequiredNative") : t("onbRevisorStarterRequired"));
        } else if (code === "already_active_grant") {
          // Treat as success — they already share with this revisor
          setRevisorMsg(t("onbRevisorAlreadyActive"));
        } else {
          setRevisorError(errText(err, t("onbRevisorInviteFailed")));
          setRevisorSending(false);
          return;
        }
      } finally {
        setRevisorSending(false);
      }
    }
    // Land on the archetype's firstWin (quickest win) instead of an empty
    // dashboard. routeForFeature() degrades to /dashboard for unknown keys.
    await finishOnboarding(routeForFeature(resolvedArchetype.firstWin));
  };

  /** POST the completion stamp and redirect. Defaults to /dashboard, but
   *  the "Finish" action passes the resolved archetype's firstWin route so
   *  the owner lands on their quickest win instead of an empty dashboard.
   *  `dest` is validated against our known routes by the caller. */
  const finishOnboarding = async (dest = "/dashboard") => {
    setFinishing(true);
    try {
      await api.post("/auth/onboarding/complete");
      // Refresh the local user object so AuthProvider.user.onboarding_completed_at
      // is populated — otherwise a quick back-button click could re-trigger.
      try { await refreshUser?.(); } catch { /* best-effort */ }
    } catch {
      // Even on failure we don't trap the user — fall through to the
      // destination. Next /auth/me will reveal the real state.
    } finally {
      setFinishing(false);
      navigate(typeof dest === "string" && dest.startsWith("/") ? dest : "/dashboard", { replace: true });
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

  // Leadfeatures the panel can actually route to (drops unmapped keys so a
  // future archetype key can never render a blank row). Computed up here so
  // both the panel and the finish-CTA copy can reason about the firstWin.
  const panelFeatures = resolvedArchetype.leadFeatures.filter(
    (k) => LEAD_FEATURE_META[k],
  );

  return (
    <div className="min-h-[100dvh] flex flex-col bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Top bar — brand · progress · skip. Sticky + blurred so it stays a
          quiet anchor while the card area scrolls on small screens. */}
      <header className="sticky top-0 z-10 bg-gray-50/80 dark:bg-gray-950/80 backdrop-blur-md border-b border-gray-200/70 dark:border-gray-800/70">
        <div className="max-w-xl mx-auto px-5 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gray-900 dark:bg-gray-100 grid place-items-center text-white dark:text-gray-900 font-semibold text-[13px]">
              B
            </div>
            <span className="text-sm font-semibold tracking-tight">BonBox</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            <span className="text-[11px] font-medium tabular-nums text-gray-400 dark:text-gray-500 hidden sm:inline">
              {t("onbStepCounter", { n: step, total: totalSteps })}
            </span>
            <ProgressRail step={step} total={totalSteps} />
            <button
              type="button"
              onClick={skipWizard}
              disabled={finishing}
              className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 underline-offset-2 hover:underline disabled:opacity-50 transition-colors"
            >
              {t("onbSkipExplore")}
            </button>
          </div>
        </div>
      </header>

      {/* Vertically-centred single column. `key={step}` re-mounts the inner
          panel on each step so the enter animation re-fires — a calm, fast
          fade-up rather than a hard cut. The whole column is capped to a
          comfortable reading width. */}
      <main className="flex-1 w-full flex items-start sm:items-center justify-center px-5 sm:px-6 py-8 sm:py-12">
        <div key={step} className="w-full max-w-xl animate-fadeIn">

          {/* ─── Step 1 — Welcome ──────────────────────────────────── */}
          {step === 1 && (
            <div className="text-center">
              {/* Brand glyph — a single calm emerald mark (the one sanctioned
                  brand-color moment), ringed for a touch of depth. */}
              <div className="mb-6 flex justify-center" aria-hidden="true">
                <div className="w-14 h-14 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 ring-1 ring-emerald-500/20 grid place-items-center text-emerald-600 dark:text-emerald-400">
                  <Icon name="Sparkles" size={26} />
                </div>
              </div>

              <StepHeader
                eyebrow={t("onbStep1Eyebrow")}
                title={t("onbStep1Headline")}
                lede={t("onbStep1Subhead")}
                center
              />

              {/* Three value props as quiet rows — icon in a soft tile, label
                  + body. Reads like a considered list, not a card carousel. */}
              <div className="mt-8 space-y-2.5 text-left">
                {[
                  { icon: "ShoppingBag", title: t("onbStep1Card1Title"), body: t("onbStep1Card1Body") },
                  { icon: "Calculator",  title: t("onbStep1Card2Title"), body: t("onbStep1Card2Body") },
                  { icon: "Send",        title: t("onbStep1Card3Title"), body: t("onbStep1Card3Body") },
                ].map((row) => (
                  <div
                    key={row.icon}
                    className="flex items-start gap-3.5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3.5"
                  >
                    <span className="shrink-0 mt-0.5 w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 grid place-items-center text-gray-700 dark:text-gray-300" aria-hidden="true">
                      <Icon name={row.icon} size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {row.title}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
                        {row.body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <Button
                variant="accent"
                size="lg"
                onClick={goNext}
                className="mt-8 w-full sm:w-auto sm:min-w-[13rem]"
                iconRight={<Icon name="ChevronDown" size={16} className="-rotate-90" />}
              >
                {t("onbStep1Cta")}
              </Button>
              <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500">
                {t("onbStep1Reassure")}
              </p>
            </div>
          )}

          {/* ─── Step 2 — Business profile + the detection "magic" ──── */}
          {step === 2 && (
            <div>
              <StepHeader
                eyebrow={t("onbStep2Eyebrow")}
                title={t("onbStep2Title")}
                lede={t("onbStep2Subtitle")}
              />

              {/* HERO — free-text detection. This is the signature moment, so
                  it gets its own elevated panel above everything else. The
                  owner types in plain words; we quietly understand and adapt.
                  Graceful: any error just leaves the manual cards as truth. */}
              <div className="mt-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 sm:p-5">
                <label htmlFor="onb-describe" className="flex items-center gap-2 mb-2.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                  <span className="text-gray-400 dark:text-gray-500" aria-hidden="true">
                    <Icon name="Sparkles" size={15} />
                  </span>
                  {t("onbDescribeLabel")}
                </label>

                <div className="relative">
                  <input
                    id="onb-describe"
                    type="text"
                    value={detectText}
                    onChange={(e) => onDescribeChange(e.target.value)}
                    onBlur={() => detectArchetype(detectText)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (detectTimer.current) clearTimeout(detectTimer.current);
                        detectArchetype(detectText);
                      }
                    }}
                    placeholder={t("onbDescribePlaceholder")}
                    autoComplete="off"
                    aria-describedby="onb-describe-hint"
                    className={
                      FIELD +
                      " text-base pr-11 " +
                      (detected ? " border-emerald-300 dark:border-emerald-500/40 ring-1 ring-emerald-500/20 " : "")
                    }
                  />
                  {/* Calm working state — three pulsing dots rather than a
                      jarring spinner. Sits inside the field, right-aligned. */}
                  {detecting && (
                    <span
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center gap-1"
                      aria-hidden="true"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse [animation-delay:300ms]" />
                    </span>
                  )}
                  {/* Settled confirmation — a small emerald tick once we've
                      understood, paired with the inline confirmation card. */}
                  {!detecting && detected && (
                    <span
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    >
                      <Icon name="CheckCircle2" size={18} />
                    </span>
                  )}
                </div>

                {/* The confirmation MOMENT. When we've understood, a crisp
                    card slides in: the archetype's own icon + a confident,
                    human line ("Looks like a café — we'll set things up for
                    that."). This is what should feel intelligent + delightful. */}
                {detected ? (
                  <div
                    className="mt-3 flex items-center gap-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 ring-1 ring-emerald-500/20 px-3.5 py-3 animate-fadeIn"
                    role="status"
                    aria-live="polite"
                  >
                    <span className="shrink-0 w-9 h-9 rounded-lg bg-white/70 dark:bg-emerald-500/15 grid place-items-center text-emerald-700 dark:text-emerald-300" aria-hidden="true">
                      <Icon name={ARCHETYPE_ICON[detected.id] || "Store"} size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 leading-snug">
                        {t("onbDetected", { name: t(detected.labelKey) })}
                      </p>
                      <p className="text-[11px] text-emerald-700/80 dark:text-emerald-300/80 mt-0.5">
                        {t("onbDetectedTuned")}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p
                    id="onb-describe-hint"
                    className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 leading-relaxed"
                    aria-live="polite"
                  >
                    {detecting ? t("onbDetecting") : t("onbDescribeHint")}
                  </p>
                )}
              </div>

              {/* "or pick one" — demoted manual fallback. A hairline divider
                  with centred label, then clean selectable tiles (icon +
                  label). After a detection these are the "not quite?" override
                  surface; a tap wins over the guess. */}
              <fieldset className="mt-6">
                <div className="flex items-center gap-3 mb-3" aria-hidden="true">
                  <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
                  <legend className="text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400 dark:text-gray-500">
                    {detected ? t("onbDetectedOverride") : t("onbDescribeOrPick")}
                  </legend>
                  <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
                </div>
                <div
                  className="grid grid-cols-3 gap-2"
                  role="radiogroup"
                  aria-label={t("onbStep2BranchLabel")}
                >
                  {BRANCH_TYPES.map((b) => {
                    // Highlight by exact id, OR by archetype when a precise
                    // detected business_type (e.g. "bakery") maps to this
                    // card's archetype (Restaurant). Exact-id match always
                    // wins so a manual tap is unambiguous.
                    const active =
                      biz.branch_type === b.id ||
                      (!BRANCH_TYPES.some((x) => x.id === biz.branch_type) &&
                        archetypeFor(biz.branch_type).id === archetypeFor(b.id).id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => {
                          // Manual override: card wins, drop the detection
                          // confirmation so the UI reflects the owner's pick.
                          setBiz({ ...biz, branch_type: b.id });
                          setDetected(null);
                        }}
                        className={
                          "group flex flex-col items-center justify-center gap-1.5 rounded-xl border p-3 min-h-[76px] text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50 dark:focus-visible:ring-offset-gray-950 " +
                          (active
                            ? "border-gray-900 dark:border-gray-100 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 shadow-sm"
                            : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50")
                        }
                      >
                        <span aria-hidden="true">
                          <Icon name={b.iconName} size={20} />
                        </span>
                        <span className={"text-xs font-medium " + (active ? "" : "text-gray-700 dark:text-gray-200")}>
                          {t(b.labelKey) || b.labelFallback}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {/* C12 — preset pillars as VISIBLE pre-checked chips. The one
                  settings moment ~95% of owners ever see: "Based on [type]
                  we turned on…" with the ON pillars pre-checked (uncheck to
                  hide) and the preset-OFF pillars as easy adds (e.g. a café
                  sees Reservations with a "do you take bookings?" nudge).
                  One glance, one tap, skippable. */}
              <PresetPillarChips
                typeLabel={t(resolvedArchetype.labelKey)}
                ready={pillarReady}
                onPillars={presetOnPillars}
                offPillars={presetOffPillars}
                pillarOff={pillarOff}
                onToggle={togglePillar}
                t={t}
              />

              {/* Identity fields — name (required) is primary; CVR is the
                  optional accelerator below it. Putting name first keeps the
                  one required field unmissable. */}
              <div className="mt-6 space-y-4">
                <div>
                  <FieldLabel htmlFor="onb-biz-name" required>
                    {t("onbStep2NameLabel")}
                  </FieldLabel>
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
                    className={FIELD}
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="onb-cvr">
                    {t("onbStep2CvrLabel")}
                  </FieldLabel>
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
                      aria-describedby={cvrError ? "onb-cvr-error" : "onb-cvr-hint"}
                      aria-invalid={!!cvrError}
                      className={FIELD + " flex-1"}
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
                  {cvrSource ? (
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1.5 flex items-center gap-1.5">
                      <Icon name="CheckCircle2" size={13} />
                      {t("onbStep2CvrLoaded", { source: cvrSource })}
                    </p>
                  ) : cvrError ? (
                    <p id="onb-cvr-error" role="alert" aria-live="polite" className="text-[11px] text-amber-700 dark:text-amber-400 mt-1.5">
                      {cvrError}
                    </p>
                  ) : (
                    <p id="onb-cvr-hint" className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
                      {t("onbStep2CvrHint")}
                    </p>
                  )}
                </div>
              </div>

              {stepError && (
                <p className="text-xs text-red-700 dark:text-red-400 mt-4" role="alert" aria-live="assertive">{stepError}</p>
              )}

              <StepFooter
                onBack={() => setStep(1)}
                backLabel={t("onbBack")}
                primaryLabel={t("onbNext")}
                onPrimary={saveBusinessAndNext}
                primaryBusy={savingBusiness}
              />
            </div>
          )}

          {/* ─── Step 3 — Tax preferences ──────────────────────────── */}
          {step === 3 && (
            <div>
              <StepHeader
                eyebrow={t("onbStep3Eyebrow")}
                title={t("onbStep3Title")}
                lede={t("onbStep3Subtitle")}
              />

              {/* Filing frequency — segmented selectable rows */}
              <fieldset className="mt-6">
                <legend className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t("onbStep3FilingLabel")}
                </legend>
                <div className="space-y-2" role="radiogroup" aria-label={t("onbStep3FilingLabel")}>
                  {FILING_OPTIONS.map((opt) => (
                    <SelectRow
                      key={opt.id}
                      active={tax.tax_filing_frequency === opt.id}
                      onClick={() => setTax({ ...tax, tax_filing_frequency: opt.id })}
                      label={t(opt.labelKey) || opt.labelFallback}
                    />
                  ))}
                </div>
              </fieldset>

              {/* Prices include VAT toggle */}
              <div className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3.5">
                <div className="min-w-0">
                  <p id="onb-vat-toggle-label" className="text-sm font-medium">
                    {t("onbStep3VatToggle")}
                  </p>
                  <p id="onb-vat-toggle-hint" className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
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
                    "shrink-0 w-11 h-6 rounded-full relative transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50 dark:focus-visible:ring-offset-gray-950 " +
                    (tax.prices_include_moms
                      ? "bg-gray-900 dark:bg-gray-100"
                      : "bg-gray-300 dark:bg-gray-700")
                  }
                >
                  <span
                    aria-hidden="true"
                    className={
                      "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white dark:bg-gray-900 shadow-sm transition-transform " +
                      (tax.prices_include_moms ? "translate-x-5" : "translate-x-0")
                    }
                  />
                </button>
              </div>

              {/* Day rollover — when does the business day end?
                  Drives kasserapport / daily-close / live-KPI windows. */}
              <fieldset className="mt-5">
                <legend className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t("onbStep3CutoffLabel")}
                </legend>
                <p
                  id="onb-cutoff-hint"
                  className="text-[11px] text-gray-500 dark:text-gray-400 mb-2 leading-relaxed"
                >
                  {t("onbStep3CutoffHint")}
                </p>
                <div
                  className="space-y-2"
                  role="radiogroup"
                  aria-label={t("onbStep3CutoffLabel")}
                  aria-describedby="onb-cutoff-hint"
                >
                  {CUTOFF_PRESETS.map((opt) => (
                    <SelectRow
                      key={opt.id}
                      active={tax.day_cutoff_mode === opt.id}
                      onClick={() => {
                        cutoffTouched.current = true;
                        setTax({ ...tax, day_cutoff_mode: opt.id });
                      }}
                      label={t(opt.labelKey) || opt.labelFallback}
                      desc={t(opt.descKey) || opt.descFallback}
                      alignTop
                    />
                  ))}
                  {/* Custom row — radio + hour input as siblings so the
                      interactive number input is NOT nested in the radio
                      button (which would be invalid HTML). Clicking the
                      number input also flips the mode to custom so the
                      visual state stays consistent. */}
                  <div
                    className={
                      "w-full flex items-center gap-3 rounded-xl border p-3 transition " +
                      (tax.day_cutoff_mode === "custom"
                        ? "border-gray-900 dark:border-gray-100 bg-gray-50 dark:bg-gray-800/50 ring-1 ring-gray-900/10 dark:ring-gray-100/10"
                        : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900")
                    }
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={tax.day_cutoff_mode === "custom"}
                      onClick={() => {
                        cutoffTouched.current = true;
                        setTax({ ...tax, day_cutoff_mode: "custom" });
                      }}
                      className="flex items-center gap-3 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded-lg"
                    >
                      <RadioDot active={tax.day_cutoff_mode === "custom"} />
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
                      onChange={(e) => {
                        cutoffTouched.current = true;
                        setTax({
                          ...tax,
                          day_cutoff_mode: "custom",
                          day_cutoff_custom: e.target.value,
                        });
                      }}
                      onFocus={() => {
                        cutoffTouched.current = true;
                        setTax((tx) => ({ ...tx, day_cutoff_mode: "custom" }));
                      }}
                      aria-label={t("onbStep3CutoffCustomAria")}
                      className="w-16 px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-center focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
                    />
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">
                      {t("onbStep3CutoffCustomSuffix")}
                    </span>
                  </div>
                </div>
              </fieldset>

              {/* Accountant email (optional) */}
              <div className="mt-5">
                <FieldLabel htmlFor="onb-acct-email">
                  {t("onbStep3AccountantLabel")}
                </FieldLabel>
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
                  className={FIELD}
                />
                <p id="onb-acct-email-hint" className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
                  {t("onbStep3AccountantHint")}
                </p>
                {/* Task #89 P3-8 — disambiguation note: Step 3 asks for
                    the "send-to" address used by the Email kasserapport
                    button, Step 4 invites a revisor to log in directly.
                    Same accountant 95% of the time, but two different
                    channels — explicit copy here saves a support ticket
                    ("Why does it ask for the same email twice?"). */}
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">
                  {t("onbStep3AccountantDisambig")}
                </p>
              </div>

              {stepError && (
                <p className="text-xs text-red-700 dark:text-red-400 mt-4" role="alert" aria-live="assertive">{stepError}</p>
              )}

              <StepFooter
                onBack={() => setStep(2)}
                backLabel={t("onbBack")}
                primaryLabel={t("onbNext")}
                onPrimary={saveTaxAndNext}
                primaryBusy={savingTax}
              />
            </div>
          )}

          {/* ─── Step 4 — Revisor invite + concierge setup panel ────── */}
          {step === 4 && (
            <div>
              <StepHeader
                eyebrow={t("onbStep4Eyebrow")}
                title={t("onbStep4Title")}
                lede={t("onbStep4Subtitle")}
              />

              <div className="mt-6">
                {canInviteRevisor === null ? (
                  // Tier-flicker fix: while entitlements are loading, render
                  // a low-contrast skeleton instead of the locked upsell —
                  // trial users would otherwise see the "See Starter" nudge
                  // flash before their real plan arrives.
                  <div className="h-28 rounded-xl bg-gray-100 dark:bg-gray-800/60 animate-pulse" aria-hidden="true" />
                ) : canInviteRevisor === false ? (
                  <div>
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
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <FieldLabel htmlFor="onb-revisor-email">
                        {t("onbStep4EmailLabel")}
                      </FieldLabel>
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
                        className={FIELD}
                      />
                    </div>
                    <div>
                      <FieldLabel htmlFor="onb-revisor-name">
                        {t("onbStep4NameLabel")}
                      </FieldLabel>
                      <input
                        id="onb-revisor-name"
                        type="text"
                        value={revisor.name}
                        onChange={(e) =>
                          setRevisor({ ...revisor, name: e.target.value })
                        }
                        placeholder={t("onbStep4NamePlaceholder")}
                        aria-describedby="onb-revisor-name-hint"
                        className={FIELD}
                      />
                    </div>
                    <p id="onb-revisor-name-hint" className="sm:col-span-2 text-[11px] text-gray-500 dark:text-gray-400 -mt-1">
                      {t("onbStep4NameHint")}
                    </p>
                  </div>
                )}
              </div>

              {revisorMsg && (
                <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-3 flex items-center gap-1.5" role="status" aria-live="polite">
                  <Icon name="CheckCircle2" size={13} />
                  {revisorMsg}
                </p>
              )}
              {revisorError && (
                <p id="onb-revisor-error" className="text-xs text-red-700 dark:text-red-400 mt-3" role="alert" aria-live="assertive">
                  {revisorError}
                </p>
              )}

              {/* ── "Here's what we set up for you" (Milestone 1) ──
                  The concierge moment. Reflects the resolved archetype: a
                  titled panel, then each leadFeature as an elegant row
                  (soft icon tile + label + what-it-does line). The firstWin
                  row is lifted: emerald icon tile, a "Start here" pill, and
                  it's what the accent Finish button below routes to. Degrades
                  cleanly — unmapped keys are skipped (panelFeatures), so a
                  future archetype key can't render a blank row. */}
              <div className="mt-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
                <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-gray-100 dark:border-gray-800/70">
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-600 dark:text-emerald-400" aria-hidden="true">
                      <Icon name="Sparkles" size={15} />
                    </span>
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {t("onbSetupTitle")}
                    </p>
                  </div>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                    {t("onbSetupSubtitle", { name: t(resolvedArchetype.labelKey) })}
                  </p>
                </div>

                <ul className="divide-y divide-gray-100 dark:divide-gray-800/70">
                  {panelFeatures.map((k) => {
                    const meta = LEAD_FEATURE_META[k];
                    const isFirstWin = k === resolvedArchetype.firstWin;
                    return (
                      <li
                        key={k}
                        className={
                          "flex items-center gap-3 px-4 sm:px-5 py-3 " +
                          (isFirstWin ? "bg-emerald-50/50 dark:bg-emerald-500/[0.06]" : "")
                        }
                      >
                        <span
                          className={
                            "shrink-0 w-9 h-9 rounded-lg grid place-items-center " +
                            (isFirstWin
                              ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400")
                          }
                          aria-hidden="true"
                        >
                          <Icon name={meta.icon} size={17} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={"text-sm " + (isFirstWin ? "font-semibold text-gray-900 dark:text-gray-100" : "font-medium text-gray-800 dark:text-gray-200")}>
                              {t(meta.labelKey)}
                            </span>
                            {isFirstWin && (
                              <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-500/15 rounded-full px-2 py-0.5">
                                {t("onbSetupFirstWinBadge")}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
                            {t(meta.descKey)}
                          </p>
                        </div>
                        {/* Quiet ready-check on the right — signals "already
                            prepared", reinforcing the concierge framing. */}
                        <span className={isFirstWin ? "text-emerald-600 dark:text-emerald-400 shrink-0" : "text-gray-300 dark:text-gray-600 shrink-0"} aria-hidden="true">
                          <Icon name="Check" size={15} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Footer — two clear paths. "Skip to dashboard" is the quiet
                  secondary; the accent button is the one confident primary and
                  routes to the firstWin (or sends the invite first). */}
              <StepFooter
                onBack={() => setStep(3)}
                backLabel={t("onbBack")}
                backDisabled={revisorSending || finishing}
                secondaryLabel={t("onbStep4SkipBtn")}
                onSecondary={() => finishOnboarding("/dashboard")}
                secondaryDisabled={revisorSending || finishing}
                primaryLabel={
                  revisor.email && canInviteRevisor
                    ? t("onbStep4Finish")
                    : t("onbFinishToFirstWin")
                }
                onPrimary={sendInviteAndFinish}
                primaryBusy={revisorSending || finishing}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}


// ── Archetype id → tile icon (for the detection confirmation card) ───
// Maps each resolved archetype to a representative Lucide icon (all keys
// verified present in Icon.jsx's ICONS map). Falls back to Store.
const ARCHETYPE_ICON = {
  food_service: "UtensilsCrossed",
  bar: "Beer",
  retail: "ShoppingBag",
  salon: "Sparkles",
  services: "Wrench",
  personal: "User",
  generic: "Store",
};


// ── SelectRow — one selectable radio-style row (filing freq + cutoff) ─
// Gray-900 selected state (per doctrine: no colored active states), a
// filled radio dot, optional description line. 44px+ tall.
function SelectRow({ active, onClick, label, desc, alignTop = false }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={
        "w-full text-left flex gap-3 rounded-xl border p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50 dark:focus-visible:ring-offset-gray-950 " +
        (alignTop ? "items-start " : "items-center ") +
        (active
          ? "border-gray-900 dark:border-gray-100 bg-gray-50 dark:bg-gray-800/50 ring-1 ring-gray-900/10 dark:ring-gray-100/10"
          : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-700")
      }
    >
      <RadioDot active={active} className={alignTop ? "mt-0.5" : ""} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
          {label}
        </span>
        {desc && (
          <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
            {desc}
          </span>
        )}
      </span>
    </button>
  );
}

// ── RadioDot — shared filled-dot indicator ───────────────────────────
function RadioDot({ active, className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={
        "w-4 h-4 rounded-full border-2 shrink-0 grid place-items-center transition-colors " +
        (active
          ? "bg-gray-900 border-gray-900 dark:bg-gray-100 dark:border-gray-100"
          : "border-gray-300 dark:border-gray-600") +
        (className ? " " + className : "")
      }
    >
      {active && <span className="w-1.5 h-1.5 rounded-full bg-white dark:bg-gray-900" />}
    </span>
  );
}


// ── PresetPillarChips (C12) — the visible onboarding preset moment ────
//
// Shows the DK relevance preset for the chosen business type as chips the
// owner can tweak in one glance, instead of applying it silently:
//   • ON-by-preset pillars   → pre-checked chips (gray-900 fill = on, per
//     design doctrine). Tap to uncheck = "my venue doesn't do this".
//   • OFF-by-preset pillars  → unchecked outline chips offered as easy adds.
//     A café's Reservations add carries an extra "do you take bookings?"
//     nudge line (DK brunch booking culture — the panel correction).
// Renders null when the preset would hide/show nothing meaningful (e.g. the
// restaurant preset = everything on, no OFF adds) so we never show an empty
// section. While the preset resolves it shows a calm skeleton.
//
// Each chip is a role="switch" — `checked` reflects ON state (NOT in the OFF
// set). FREE + uncapped: this is the RELEVANCE axis, never an entitlement.
function PillarChip({ icon, label, on, sublabel, onToggle, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onToggle(!on)}
      className={
        "inline-flex items-center gap-2 rounded-xl border px-3 py-2 min-h-[44px] text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50 dark:focus-visible:ring-offset-gray-950 " +
        (on
          ? "border-gray-900 dark:border-gray-100 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 shadow-sm"
          : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 hover:border-gray-300 dark:hover:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50")
      }
    >
      <span aria-hidden="true" className={on ? "" : "text-gray-500 dark:text-gray-400"}>
        <Icon name={on ? "Check" : (icon || "Plus")} size={15} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-tight">{label}</span>
        {sublabel && (
          <span className={"block text-[11px] leading-tight mt-0.5 " + (on ? "opacity-80" : "text-gray-500 dark:text-gray-400")}>
            {sublabel}
          </span>
        )}
      </span>
    </button>
  );
}

function PresetPillarChips({ typeLabel, ready, onPillars, offPillars, pillarOff, onToggle, t }) {
  // Nothing to show if the preset neither hides nor offers anything (e.g. the
  // restaurant preset = all on with no OFF adds). Showing all-5-on-no-adds is
  // noise; the discovery floor + /modules already cover later changes.
  const nothingToShow = ready && onPillars.length === 5 && offPillars.length === 0;
  if (nothingToShow) return null;

  return (
    <div className="mt-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-gray-400 dark:text-gray-500" aria-hidden="true">
          <Icon name="Sparkles" size={15} />
        </span>
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t("onbPresetTitle", { type: typeLabel })}
        </p>
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3 leading-relaxed">
        {t("onbPresetSubtitle")}
      </p>

      {!ready ? (
        // Calm skeleton while the preset resolves — no chip flash.
        <div className="flex flex-wrap gap-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-[44px] w-28 rounded-xl bg-gray-100 dark:bg-gray-800/60 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("onbPresetOnGroup")}>
            {onPillars.map((p) => {
              const on = !pillarOff.has(p.id);
              return (
                <PillarChip
                  key={p.id}
                  icon={p.icon}
                  label={t(p.labelKey)}
                  on={on}
                  onToggle={(next) => onToggle(p.id, next)}
                  ariaLabel={t(p.labelKey)}
                />
              );
            })}
          </div>

          {offPillars.length > 0 && (
            <>
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400 dark:text-gray-500 mt-4 mb-2">
                {t("onbPresetAddTitle")}
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t("onbPresetAddTitle")}>
                {offPillars.map((p) => {
                  const on = !pillarOff.has(p.id);
                  // Café/takeaway brunch-booking nudge: Reservations gets an
                  // extra "do you take bookings?" line when offered as an add.
                  const sublabel =
                    p.id === "reservations" ? t("onbPresetReservationsNudge") : undefined;
                  return (
                    <PillarChip
                      key={p.id}
                      icon={p.icon}
                      label={t(p.labelKey)}
                      on={on}
                      sublabel={sublabel}
                      onToggle={(next) => onToggle(p.id, next)}
                      ariaLabel={t(p.labelKey)}
                    />
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}


// ── StepFooter — consistent action bar for steps 2-4 ──────────────────
// One Back (ghost) on the left; an optional secondary + the single accent
// primary on the right. Centralising this guarantees identical button
// hierarchy + spacing on every step. On mobile the primary is full-width
// for an unmissable tap target.
function StepFooter({
  onBack,
  backLabel,
  backDisabled = false,
  secondaryLabel,
  onSecondary,
  secondaryDisabled = false,
  primaryLabel,
  onPrimary,
  primaryBusy = false,
}) {
  return (
    <div className="mt-8 pt-5 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between gap-3">
      <Button variant="ghost" onClick={onBack} disabled={backDisabled}>
        {backLabel}
      </Button>
      <div className="flex items-center gap-2">
        {secondaryLabel && (
          <Button
            variant="secondary"
            onClick={onSecondary}
            disabled={secondaryDisabled}
          >
            {secondaryLabel}
          </Button>
        )}
        <Button
          variant="accent"
          onClick={onPrimary}
          busy={primaryBusy}
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}
