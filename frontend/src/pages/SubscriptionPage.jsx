import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import api from "../services/api";
import { safeExternalUrl } from "../utils/safeUrl";

/**
 * isNative — running inside Capacitor (iOS or Android).
 * Used to comply with App Store Review Guideline 3.1.1 + Google Play Billing
 * rules: in-app purchase of digital subscriptions must use Apple/Google
 * billing. Until we wire those up, native users see a "manage on web"
 * pathway instead of an in-app upgrade button.
 */
const isNative =
  typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();

/**
 * BonBox subscription tiers — public pricing page.
 *
 * Strategy: every new signup gets 14 days of Pro free, no card. After the
 * trial they choose Free or Pro. This kills the "I haven't validated this
 * yet, why would I pay" hesitation that kills new-product conversion.
 *
 * Three tiers only — no "Coming soon" placeholders. Cleaner choice.
 *   Free: forever, real but limited
 *   Starter: 14-day trial → 129 kr/mo founding (first 100, regular 199)
 *   Pro:     14-day trial → 249 kr/mo founding (first 100, regular 349)
 */

// Founding-member counter. Hard-coded for now — wire to a backend
// `/api/billing/founding-stats` endpoint when you have it. Manoj's
// principle: be honest. "62/100 pladser tilbage" beats "First 1,000".
const FOUNDING_LIMIT = 100;
const FOUNDING_USED = 38;          // bumped manually as customers lock in;
                                   // negative space ("62 pladser tilbage")
                                   // is what prospects actually want to see

/**
 * Build the pricing tiers from the i18n dictionary so every visible string
 * routes through `t()` and renders in the user's selected language. Pricing
 * SKU + numeric values stay constant across languages — only the label
 * text translates. This eliminates the mixed Danish-in-English bug where
 * hardcoded "Lukning på 90 sekunder" / "kasserapport" / "revisor" leaked
 * into English / Vietnamese / Thai / etc. UIs.
 *
 * Some terms intentionally stay Danish even in English UI per the
 * jurisdiction-language rule (kasserapport, revisor, Moms, lønseddel,
 * Dinero, Billy, e-conomic, Dankort, MobilePay) — these are bookkeeping
 * + tax terms that lose meaning when translated.
 */
const buildTiers = (t) => [
  {
    id: "free",
    name: t("pricingTierFree") || "Free",
    tagline: t("pricingTaglineFree") || "Daily close in 90 seconds. Every day, free.",
    price_monthly: 0,
    price_annual: 0,
    cta: t("pricingStartFree") || "Start free",
    cta_unauth: t("pricingSignUpFree") || "Sign up free",
    highlight: false,
    features: [
      { text: t("featFreeHeader") || "Daily close in 90 seconds", included: true, header: true },
      { text: t("featFreeKasse") || "Snap kasserapport — AI reads it in 6 seconds", included: true },
      { text: t("featFreeSend") || "Send to owner / accountant (PDF + Danish SMS)", included: true },
      { text: t("featFreeCopilot") || "30 AI Copilot questions / day + voice input", included: true },
      { divider: true },
      { text: t("featFree200Sales") || "200 sales logged / month", included: true },
      { text: t("featFree100Expenses") || "100 expenses logged / month", included: true },
      { text: t("featFree30OCR") || "30 receipt OCR scans / month", included: true },
      { text: t("featFree90Days") || "90 days of full history (older stays read-only)", included: true },
      { text: t("featFree1Biz") || "1 business, 1 user", included: true },
    ],
  },
  {
    id: "starter",
    name: t("pricingTierStarter") || "Starter",
    tagline: t("pricingTaglineStarter") || "For the café or shop that closes every night.",
    price_monthly: 199,
    price_annual: 159,
    founding_price: 129,
    founding_limit: FOUNDING_LIMIT,
    cta: t("pricingUpgradeStarter") || "Upgrade to Starter",
    cta_unauth: t("pricingStartTrial") || "Start 14-day free trial",
    highlight: false,
    badge: t("pricingBadgeFreeTrial") || "🎁 14 days free · No card required",
    features: [
      { text: t("featStarterHeader") || "Everything in Free — without the caps:", included: true, header: true },
      { text: t("featStarterUnlimitedClose") || "Unlimited daily closes + receipt OCR", included: true },
      { text: t("featStarterUnlimitedSales") || "Unlimited sales + expenses + AI Copilot", included: true },
      { text: t("featStarterCsvExport") || "Direct Dinero / Billy / e-conomic CSV export", included: true },
      { divider: true },
      { text: t("featStarter1Biz3Users") || "Up to 1 business, 3 users with role permissions", included: true },
      { text: t("featStarterSendRevisor") || "Send-to-accountant automation (monthly digest)", included: true },
      { text: t("featStarterAnomaly") || "AI anomaly detection on sales & wages", included: true },
      { text: t("featStarterEmailSupport") || "Email support", included: true },
    ],
  },
  {
    id: "pro",
    name: t("pricingTierPro") || "Pro",
    tagline: t("pricingTaglinePro") || "For 2-3 locations. AI that thinks across them.",
    price_monthly: 349,
    price_annual: 279,
    founding_price: 249,
    founding_limit: FOUNDING_LIMIT,
    cta: t("pricingUpgradePro") || "Upgrade to Pro",
    cta_unauth: t("pricingStartTrial") || "Start 14-day free trial",
    highlight: true,
    badge: t("pricingBadgeFreeTrialPopular") || "🎁 14 days free · No card required · Most popular",
    features: [
      { text: t("featProHeader") || "Everything in Starter, plus:", included: true, header: true },
      { text: t("featPro3Biz5Users") || "Up to 3 businesses, 5 users", included: true },
      { text: t("featProCrossOutlet") || "Cross-outlet daily close consolidation", included: true },
      { text: t("featProPredictive") || "Predictive AI: revenue forecast, churn risk, stockout alerts", included: true },
      { text: t("featProPlaybooks") || "Custom AI playbooks tuned to YOUR business pattern", included: true },
      { divider: true },
      { text: t("featProAllVerticals") || "ALL vertical modules at once (Bar Pour + Workshop + etc.)", included: true },
      { text: t("featProBankImport") || "Bank import (multi-bank, multi-currency)", included: true },
      { text: t("featProPrioritySupport") || "Priority email support", included: true },
    ],
  },
];

function daysRemaining(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86400000);
}

export default function SubscriptionPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [annual, setAnnual] = useState(false);
  const [billing, setBilling] = useState(null);
  const [joined, setJoined] = useState(new Set());
  const [pending, setPending] = useState(null);
  const [msg, setMsg] = useState("");

  // Tiers re-build on every render so language changes pick up immediately.
  // Cheap — three plain objects, no DB / network involved.
  const TIERS = buildTiers(t);

  // Load current plan + waitlist status in parallel
  useEffect(() => {
    if (!user) return;
    Promise.all([
      api.get("/billing/me").catch(() => ({ data: null })),
      api.get("/waitlist/status").catch(() => ({ data: [] })),
    ]).then(([b, w]) => {
      setBilling(b.data);
      setJoined(new Set((w.data || []).map((r) => r.tier)));
    });
  }, [user]);

  const trialDaysLeft = billing?.trial_active ? billing.trial_days_remaining : null;
  const currentPlan = billing?.plan || "free";

  const handleCta = async (tierId) => {
    trackEvent("pricing_cta_clicked", "subscription", tierId);
    if (tierId === "free") {
      // No-op for logged-in users on Free / trial — they're already here
      return;
    }
    if (!user?.email) {
      // Anonymous — push them to register, which auto-starts the trial
      window.location.href = "/register";
      return;
    }
    if (tierId === "business") {
      // Always route Business to sales conversation (custom plan, multi-branch chains)
      const subject = encodeURIComponent("BonBox Business — multi-branch enquiry");
      const body = encodeURIComponent(
        `Hi BonBox team,\n\nI run a multi-branch business and would like to learn more about BonBox Business.\n\n` +
        `A few details that will help us scope a custom plan:\n` +
        `• Number of branches / locations:\n` +
        `• Type of business (restaurant chain, retail group, café group, etc.):\n` +
        `• Approximate users / managers across locations:\n` +
        `• Existing tools we integrate with (POS, accounting):\n\n` +
        `My account email: ${user.email}\n\nThanks!`
      );
      window.location.href = `mailto:hello@bonbox.dk?subject=${subject}&body=${body}`;
      return;
    }
    // ── Pro tier upgrade ──
    // App Store compliance: native iOS cannot use Stripe for digital goods (Apple's
    // 30% IAP rule). On native, we open the web subscription page in the system
    // browser so the user completes payment via web. Backend ALSO blocks (defense
    // in depth) — both layers must agree before a Stripe session is created.
    if (isNative && tierId === "pro") {
      try {
        const url = "https://bonbox.dk/subscription";
        if (window.Capacitor?.Plugins?.Browser?.open) {
          await window.Capacitor.Plugins.Browser.open({ url });
        } else {
          window.open(url, "_blank");
        }
        return;
      } catch {
        /* fall through */
      }
    }

    // Web flow — try real Stripe Checkout. If Stripe isn't configured server-side
    // yet (early launch), fall back to the waitlist-join flow gracefully.
    if (tierId === "pro" && billing?.stripe_configured) {
      setPending(tierId);
      setMsg("");
      try {
        const res = await api.post("/billing/stripe/checkout-session", {});
        const safeStripeUrl = safeExternalUrl(res.data?.url);
        if (safeStripeUrl) {
          // Already paid → portal URL was returned; otherwise checkout URL
          if (res.data.already_subscribed) {
            trackEvent("stripe_portal_opened", "subscription", "pro");
          } else {
            trackEvent("stripe_checkout_started", "subscription", "pro");
          }
          window.location.href = safeStripeUrl;
          return;
        }
        setMsg(t("checkoutOpenFailed") || "Couldn't open checkout. Please try again.");
      } catch (e) {
        if (e?.response?.status === 403 && e.response.data?.redirect_to_web) {
          // Backend says native iOS — open web (we may have missed isNative check)
          window.open("https://bonbox.dk/subscription", "_blank");
        } else if (e?.response?.status === 429) {
          setMsg(t("tooManyRequests") || "Too many requests — please try again in a minute.");
        } else {
          setMsg(e?.response?.data?.detail || t("checkoutStartFailed") || "Could not start checkout. Please try again.");
        }
      } finally {
        setPending(null);
      }
      return;
    }

    // Fallback — Stripe not configured yet. Use the waitlist flow so we still
    // capture intent. This is the temporary path until Stripe keys are live.
    if (joined.has(tierId)) {
      setMsg(t("alreadyOnWaitlist") || "You're already on the list — we'll be in touch when payment is ready.");
      setTimeout(() => setMsg(""), 4000);
      return;
    }
    setPending(tierId);
    setMsg("");
    try {
      await api.post("/waitlist/join", {
        email: user.email,
        tier: tierId,
        source: isNative ? "subscription_page_native" : "subscription_page",
      });
      setJoined((p) => new Set([...p, tierId]));
      trackEvent("waitlist_joined", "subscription", tierId);
      setMsg(
        tierId === "pro"
          ? (t("waitlistJoinedPro") || "🎉 You're on the founding-member list — when payment opens, you'll lock in 99 kr/mo for as long as you stay subscribed.")
          : ((t("waitlistJoinedTier") || "🎉 You're on the {tier} list — we'll email you when it opens.").replace("{tier}", tierId))
      );
      setTimeout(() => setMsg(""), 8000);
    } catch (e) {
      setMsg(
        e?.response?.status === 429
          ? (t("tooManyRequests") || "Too many requests — please try again in a minute.")
          : (t("waitlistJoinFailed") || "Couldn't add you to the list. Email hello@bonbox.dk if this keeps happening.")
      );
      setTimeout(() => setMsg(""), 5000);
    } finally {
      setPending(null);
    }
  };

  // Open the Stripe Customer Portal so the user can cancel, update their
  // card, or download invoices. Only meaningful for users with a real
  // Stripe subscription (active or trialing — i.e. they've locked in).
  const handleManage = async () => {
    setPending("manage");
    setMsg("");
    try {
      const res = await api.post("/billing/stripe/portal-session", {});
      const safePortalUrl = safeExternalUrl(res.data?.url);
      if (safePortalUrl) {
        window.location.href = safePortalUrl;
        return;
      }
      setMsg(t("billingPortalFailed") || "Could not open the billing portal. Please try again.");
    } catch (e) {
      setMsg(e?.response?.data?.detail || t("billingPortalFailed") || "Could not open the billing portal. Please try again.");
    } finally {
      setPending(null);
    }
  };

  // True iff the user has a real Stripe subscription (post lock-in). They
  // need the portal to cancel, update card, see invoices. Auto-trial users
  // (subscription_status=null, trial_active=true) just let the trial expire.
  const hasStripeSub = ["active", "trialing", "past_due"].includes(billing?.subscription_status);

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-10 pb-32 sm:pb-16 max-w-6xl mx-auto">
      {/* Locked-in banner — when user has a real Stripe sub (active/trialing/past_due) */}
      {hasStripeSub ? (
        <div className="mb-6 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 border border-green-200 dark:border-green-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
          <div className="text-3xl">{billing?.subscription_status === "past_due" ? "⚠️" : "✓"}</div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-green-800 dark:text-green-300">
              {billing?.subscription_status === "trialing"
                ? (t("pricingLockedTrialing") || "Locked in at founding rate — first charge {when}").replace(
                    "{when}",
                    trialDaysLeft != null && trialDaysLeft > 0
                      ? trialDaysLeft === 1
                        ? (t("pricingLockedTrialingInOne") || "in 1 day")
                        : (t("pricingLockedTrialingIn") || "in {n} days").replace("{n}", trialDaysLeft)
                      : (t("pricingLockedTrialingSoon") || "soon")
                  )
                : billing?.subscription_status === "active"
                  ? (t("pricingLockedActive") || "Subscription active — billed monthly at your founding rate")
                  : billing?.subscription_status === "past_due"
                    ? (t("pricingLockedPastDue") || "Payment failed — please update your card to keep your plan")
                    : (t("pricingLockedGeneric") || "Subscription active")}
            </div>
            <div className="text-xs text-green-700 dark:text-green-400 mt-0.5">
              {t("pricingLockedSubtitle") || "All Pro features unlocked. Founding-member rate is locked for life as long as you stay subscribed."}
            </div>
          </div>
          <button
            onClick={handleManage}
            disabled={pending === "manage"}
            className="px-4 py-2 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-white text-sm font-semibold rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 whitespace-nowrap disabled:opacity-60"
          >
            {pending === "manage" ? (t("pricingOpening") || "Opening…") : (t("pricingManageSubscription") || "Manage subscription")}
          </button>
        </div>
      ) : trialDaysLeft != null && trialDaysLeft > 0 ? (
        <div className="mb-6 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
          <div className="text-3xl">⏳</div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              {(t("pricingTrialEndsIn") || "Your free Pro trial ends in {n} day{s}.")
                .replace("{n}", trialDaysLeft)
                .replace("{s}", trialDaysLeft === 1 ? "" : "s")}
            </div>
            <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {t("pricingTrialUsing") || "You're using all Pro features right now — AI insights, unlimited Copilot, full history, vertical modules. After the trial you can stay on Free (limited) or upgrade."}
            </div>
          </div>
          <button
            onClick={() => handleCta("pro")}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg shadow-sm whitespace-nowrap"
          >
            {t("pricingLockInRate") || "Lock in founding rate"}
          </button>
        </div>
      ) : null}

      {/* How it works — only relevant while on trial */}
      {trialDaysLeft != null && trialDaysLeft > 0 && (
        <div className="mb-10 max-w-4xl mx-auto bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-2xl p-5 sm:p-6">
          <h3 className="text-[15px] font-semibold text-gray-900 dark:text-white mb-4">
            {t("pricingHowTrialWorks") || "How your trial works"}
          </h3>
          <div className="grid sm:grid-cols-3 gap-4 sm:gap-5">
            <div className="relative">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">{t("pricingTrialStep1Tag") || "Today"}</div>
              <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1">{t("pricingTrialStep1Title") || "Trial started at sign-in"}</div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                {t("pricingTrialStep1Body") || "14 days of full Pro — every feature, no caps. No card, no charge."}
              </div>
            </div>
            <div className="relative sm:border-l sm:border-gray-200 sm:dark:border-gray-700 sm:pl-5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                {(t("pricingTrialStep2Tag") || "Anytime in the next {n} day{s}")
                  .replace("{n}", trialDaysLeft)
                  .replace("{s}", trialDaysLeft === 1 ? "" : "s")}
              </div>
              <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1">{t("pricingTrialStep2Title") || "Pick your path"}</div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                <span className="block">→ {t("pricingTrialStep2BodyLock") || "Lock in founding rate: add card now, your founding price (Starter 129 / Pro 249) is locked for life"}</span>
                <span className="block mt-1">→ {t("pricingTrialStep2BodyDoNothing") || "Do nothing: trial runs out, you drop to Free"}</span>
              </div>
            </div>
            <div className="relative sm:border-l sm:border-gray-200 sm:dark:border-gray-700 sm:pl-5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-green-600 dark:text-green-400">{t("pricingTrialStep3Tag") || "Day 14"}</div>
              <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1">{t("pricingTrialStep3Title") || "What actually happens"}</div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                <span className="block">{t("pricingTrialStep3BodyLocked") || "If locked in: founding rate charged to your card"}</span>
                <span className="block mt-1">{t("pricingTrialStep3BodyDropped") || "If not: dropped to Free (caps return, data stays, no charge ever)"}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white">
          {t("pricingHeroTitle1") || "Daily close in 90 seconds."}
          <br className="sm:hidden" />
          <span className="text-green-600 dark:text-green-400"> {t("pricingHeroTitle2") || "Staff go home on time."}</span>
        </h1>
        <p className="text-sm sm:text-base text-gray-500 dark:text-gray-400 mt-3 max-w-2xl mx-auto">
          {t("pricingHeroSubtitle") || "Snap a kasserapport. AI reads it in 6 seconds. Send a clean PDF to the owner or accountant in one tap. 14 days of Pro free. No card. No surprises."}
        </p>
        <div className="mt-4 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
          🔥 {(t("pricingFoundingBanner") || "{remaining}/{limit} spots left — lock founding price (Starter 129 kr / Pro 249 kr) for life")
            .replace("{remaining}", Math.max(FOUNDING_LIMIT - FOUNDING_USED, 0))
            .replace("{limit}", FOUNDING_LIMIT)}
        </div>

        {/* Annual / monthly toggle */}
        <div className="inline-flex items-center bg-gray-100 dark:bg-gray-800 rounded-full p-1 mt-6">
          <button
            onClick={() => setAnnual(false)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${!annual ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
          >
            {t("pricingMonthly") || "Monthly"}
          </button>
          <button
            onClick={() => setAnnual(true)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition relative ${annual ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
          >
            {t("pricingAnnual") || "Annual"}
            <span className="ml-2 inline-block bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">
              -20%
            </span>
          </button>
        </div>
      </div>

      {/* Status confirmation banner */}
      {msg && (
        <div className="mb-6 text-center text-sm bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 rounded-xl px-4 py-3">
          {msg}
        </div>
      )}

      {/* Tiers — 3 cards now */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {TIERS.map((tier) => {
          const isCurrent =
            (tier.id === "pro" && (currentPlan === "pro" || currentPlan === "trial")) ||
            (tier.id === "free" && currentPlan === "free") ||
            (tier.id === "business" && currentPlan === "business");
          const price = annual ? tier.price_annual : tier.price_monthly;
          const isFoundingPro = tier.id === "pro" && tier.founding_price;
          const cta = user ? tier.cta : tier.cta_unauth;
          return (
            <div
              key={tier.id}
              className={`relative flex flex-col rounded-2xl border p-5 sm:p-6 transition
                ${tier.highlight
                  ? "border-green-400 dark:border-green-600 bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 shadow-lg ring-1 ring-green-200/60 dark:ring-green-700/30"
                  : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60"}`}
            >
              {tier.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-green-500 to-emerald-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow-md whitespace-nowrap">
                  {t("mostPopular") || "Most popular"}
                </div>
              )}
              {isCurrent && (
                <div className="absolute -top-3 right-4 bg-blue-600 text-white text-[10px] font-bold px-2.5 py-1 rounded-full shadow whitespace-nowrap">
                  {currentPlan === "trial"
                    ? (t("yourTrial") || "Your trial")
                    : (t("currentPlan") || "Current plan")}
                </div>
              )}

              <h3 className="text-xl font-bold text-gray-900 dark:text-white">{tier.name}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 min-h-[2.5em]">{tier.tagline}</p>

              <div className="mt-4 mb-1">
                {tier.custom ? (
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">{t("pricingCustom") || "Custom"}</div>
                ) : isFoundingPro ? (
                  <>
                    <div className="text-3xl font-bold text-gray-900 dark:text-white">
                      {tier.founding_price}
                      <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">{t("pricingKrPerMonth") || "kr/mo"}</span>
                    </div>
                    <div className="text-xs text-gray-400 line-through">{price} {t("pricingKrPerMonth") || "kr/mo"} {t("pricingRegular") || "regular"}</div>
                  </>
                ) : (
                  <div className="text-3xl font-bold text-gray-900 dark:text-white">
                    {price === 0 ? (t("pricingFree") || "Free") : `${price}`}
                    {price > 0 && <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">{t("pricingKrPerMonth") || "kr/mo"}</span>}
                  </div>
                )}
                {annual && price > 0 && !isFoundingPro && !tier.custom && (
                  <div className="text-[11px] text-green-600 dark:text-green-400">{t("pricingBilledAnnually") || "billed annually"}</div>
                )}
              </div>

              {tier.badge && (
                <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-md px-2 py-1 mt-1 mb-3 text-center">
                  {tier.badge}
                </div>
              )}

              <button
                onClick={() => handleCta(tier.id)}
                disabled={isCurrent || pending === tier.id || (tier.id !== "business" && joined.has(tier.id))}
                className={`w-full py-2 rounded-lg text-sm font-medium transition mt-3 mb-4
                  ${isCurrent
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 cursor-default"
                    : joined.has(tier.id) && tier.id !== "business"
                      ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800"
                      : tier.highlight
                        ? "bg-green-600 hover:bg-green-700 text-white shadow-sm disabled:opacity-60"
                        : "bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-60"}`}
              >
                {isCurrent
                  ? currentPlan === "trial"
                    ? (t("onTrialFullPro") || "On trial — full Pro features")
                    : `✓ ${t("currentPlan") || "Current plan"}`
                  : pending === tier.id
                    ? (t("pricingJoining") || "Joining…")
                    : joined.has(tier.id) && tier.id !== "business"
                      ? (t("pricingOnTheList") || "✓ On the list")
                      : cta}
              </button>

              {/* Manage / Cancel — only when user has a real Stripe sub on this tier */}
              {isCurrent && hasStripeSub && tier.id === "pro" && (
                <button
                  onClick={handleManage}
                  disabled={pending === "manage"}
                  className="w-full text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline mt-1 mb-3 disabled:opacity-50"
                >
                  {pending === "manage" ? (t("pricingOpening") || "Opening…") : (t("pricingManageOrCancel") || "Manage subscription / cancel")}
                </button>
              )}

              <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                {tier.features.map((f, i) => {
                  if (f.divider) {
                    return (
                      <li key={i} aria-hidden="true" className="my-2 border-t border-gray-200/70 dark:border-gray-700/60" />
                    );
                  }
                  return (
                    <li key={i} className={`flex items-start gap-2 ${f.header ? "font-semibold mt-1" : ""}`}>
                      {f.header ? (
                        <span className="text-gray-400 shrink-0 mt-0.5">·</span>
                      ) : f.included ? (
                        <span className="text-green-500 dark:text-green-400 shrink-0 mt-0.5">✓</span>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600 shrink-0 mt-0.5">—</span>
                      )}
                      <span className={f.included ? "" : "text-gray-400 dark:text-gray-500"}>{f.text}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {/* What changes after trial — calm, transparent, no surprises */}
      <div className="mt-10 max-w-3xl mx-auto bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-2xl p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 flex items-center justify-center text-sm shrink-0 mt-0.5">i</div>
          <div className="flex-1">
            <h3 className="text-[15px] font-semibold text-gray-900 dark:text-white">{t("pricingAfterTrialTitle") || "What changes after the 14-day trial"}</h3>
            <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
              {t("pricingAfterTrialBody") || "Nothing dramatic. You stay signed in, your data is safe, every feature is still there. Free is genuinely usable — these are the only caps that come back when the trial ends:"}
            </p>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 mt-4 text-[13px] text-gray-700 dark:text-gray-300">
              {[
                t("pricingAfterTrialCap1") || "200 sales logged per month",
                t("pricingAfterTrialCap2") || "100 expenses logged per month",
                t("pricingAfterTrialCap3") || "30 receipt OCR scans per month",
                t("pricingAfterTrialCap4") || "30 AI Copilot questions per day",
                t("pricingAfterTrialCap5") || "Top 5 active AI insights at a time",
                t("pricingAfterTrialCap6") || "1 vertical module (pick one)",
                t("pricingAfterTrialCap7") || "90 days of full history (older stays read-only)",
                t("pricingAfterTrialCap8") || "1 business, 1 user",
              ].map((line) => (
                <div key={line} className="flex items-start gap-2">
                  <span className="mt-[7px] w-1 h-1 rounded-full bg-gray-400 dark:bg-gray-500 shrink-0" />
                  <span>{line}</span>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-4 leading-relaxed">
              {t("pricingAfterTrialClosing") || "No card needed to start the trial — it auto-runs when you sign up. You only enter a card if you click \"Lock in 99 kr/mo\" to keep the founding rate. Otherwise the trial just ends and you drop to Free."}
            </p>
          </div>
        </div>
      </div>

      {/* Reassurance row */}
      <div className="grid sm:grid-cols-4 gap-3 mt-10">
        <Reassure icon="🆓" title={t("pricingReassureNoCard") || "No card for trial"} sub={t("pricingReassureNoCardSub") || "14 days of Pro, no payment info needed."} />
        <Reassure icon="🇩🇰" title={t("pricingReassureDenmark") || "Built in Denmark"} sub={t("pricingReassureDenmarkSub") || "GDPR-first · EU-hosted · DKK + Moms native"} />
        <Reassure icon="🤝" title={t("pricingReassureCancel") || "Cancel anytime"} sub={t("pricingReassureCancelSub") || "No contracts. Export your data on the way out."} />
        <Reassure icon="🌏" title={t("pricingReassureLanguages") || "12 languages"} sub={t("pricingReassureLanguagesSub") || "Dansk, English, नेपाली, اردو + 8 more"} />
      </div>

      {/* FAQ */}
      <div className="mt-12 max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">{t("faqHeading") || "Common questions"}</h2>
        <div className="space-y-4">
          <FaqItem q={t("faqQ1") || "What happens when my 14-day trial ends?"} a={t("faqA1") || ""} />
          <FaqItem q={t("faqQ2") || "Why does Free have every feature, just with caps?"} a={t("faqA2") || ""} />
          <FaqItem q={t("faqQ3") || "How does the founding-member price work?"} a={t("faqA3") || ""} />
          <FaqItem q={t("faqQ4") || "I run a chain with multiple branches — what fits?"} a={t("faqA4") || ""} />
          <FaqItem q={t("faqQ5") || "Do I have to switch from Dinero / Billy / e-conomic?"} a={t("faqA5") || ""} />
          <FaqItem q={t("faqQ6") || "What about VAT (Moms)?"} a={t("faqA6") || ""} />
          <FaqItem q={t("faqQ7") || "Can I cancel anytime?"} a={t("faqA7") || ""} />
          <FaqItem q={t("faqQ8") || "Is my data safe?"} a={t("faqA8") || ""} />
        </div>

        {/* Trademark notice */}
        <p className="mt-10 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed text-center">
          {t("pricingTrademarkNotice") || "Dinero, Billy, e-conomic, MobilePay and Dankort are trademarks of their respective owners. BonBox is not affiliated with or endorsed by any of these companies. References are made for interoperability and comparative purposes under nominative fair use."}
        </p>
      </div>
    </div>
  );
}

function Reassure({ icon, title, sub }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 text-center">
      <div className="text-2xl mb-1">{icon}</div>
      <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3"
      >
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{q}</span>
        <span className="text-gray-400 transition-transform" style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}>▾</span>
      </button>
      {open && (
        <div className="px-4 pb-3 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">{a}</div>
      )}
    </div>
  );
}
