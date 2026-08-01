import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { COMPLETE_LANGUAGE_COUNT, COMPLETE_LANGUAGE_NAMES } from "../i18n/languageCatalog";
import { useConfirm } from "../hooks/useConfirm";
import { trackEvent } from "../hooks/useEventLog";
import useFounderRateStatus from "../hooks/useFounderRateStatus";
import { useEntitlements } from "../hooks/useEntitlements";
import api from "../services/api";
import { safeExternalUrl } from "../utils/safeUrl";
import { errText } from "../utils/errText";
import { Button, Card } from "../components/ui";

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
 * BonBox subscription tiers — premium, time-saved-first pricing page.
 *
 * Strategy: every new signup gets 14 days of full Pro free, no card. After
 * the trial they choose Free / Starter / Pro. This kills the "I haven't
 * validated this yet, why would I pay" hesitation that kills new-product
 * conversion.
 *
 * Voice: each tier leads with a one-sentence job-to-be-done from the
 * owner's mouth ("BonBox closes my day in 90 seconds") + the time it
 * saves them per month. Features are secondary, listed as short verb-led
 * lines below the job. No "premium / unlock / advanced" marketing-speak —
 * the value moments speak for themselves.
 *
 * Three tiers only — no "Coming soon" placeholders. Cleaner choice.
 *   Free:    forever, real but limited           — ~10 min/day saved
 *   Starter: 129 kr/mo founding (regular 199)    — ~3 hrs/month saved
 *   Pro:     249 kr/mo founding (regular 349)    — ~12 hrs/month saved
 */

// Founding-member counter. Wired to the public, rate-limited
// /api/public/founder-rate-status endpoint (Task #89 P2-2) — same
// source the landing-page FounderRatePill uses, so the count on the
// pricing page and the count on the marketing site can never drift.
// FOUNDING_LIMIT is the visual fallback when the endpoint hasn't
// loaded yet; the real `max_slots` arrives from the backend.
const FOUNDING_LIMIT = 100;

/**
 * Build the pricing tiers from the i18n dictionary so every visible string
 * routes through `t()` and renders in the user's selected language. Pricing
 * SKU + numeric values stay constant across languages — only the label
 * text translates. Some terms intentionally stay Danish even in English UI
 * per the jurisdiction-language rule (kasserapport, revisor, Moms,
 * lønseddel, Dinero, Billy, e-conomic, Dankort, MobilePay, faktura) —
 * these are bookkeeping + tax terms that lose meaning when translated.
 *
 * Tier object shape preserved exactly: { id, name, cta, cta_unauth, badge,
 * highlight, founding_price, price_monthly, price_annual, features }.
 * The Stripe checkout flow keys off `id` ("starter" / "pro") so renaming
 * is forbidden — handleCta and the backend price-ID router must agree.
 */
const buildTiers = (t) => [
  {
    id: "free",
    name: t("pricingTierFree") || "Free",
    // Job-to-be-done sentence (from an owner's mouth, not marketing)
    job:
      t("pricingJobFree", "BonBox closes my day in 90 seconds.") ||
      "BonBox closes my day in 90 seconds.",
    timeSaved: t("pricingTimeFree", "~10 min saved every day"),
    tagline:
      t("pricingTaglineFree") ||
      "Daily close in 90 seconds. Every day, free.",
    price_monthly: 0,
    price_annual: 0,
    cta: t("pricingStartFree") || "Start free",
    cta_unauth: t("pricingSignUpFree") || "Sign up free",
    highlight: false,
    variant: "default",
    features: [
      // Refreshed May 2026 — reflect the real Free-tier value:
      // the morning brief, MOMS countdown, receipt OCR with a
      // monthly cap, single-location operator. Removed the cuisine
      // market scan (0 production usage — see SubscriptionPage
      // notes; replaced by features owners actually open).
      { text: t("featFreeBrief2", "AI Daily Brief with tap-to-action insights") || "AI Daily Brief with tap-to-action insights" },
      { text: t("featFreeMomsCountdown", "MOMS countdown — see when SKAT is due + estimated amount") || "MOMS countdown — see when SKAT is due + estimated amount" },
      { text: t("featFreeReceiptOCR10", "Receipt OCR — snap a photo, we fill the expense (10 / month)") || "Receipt OCR — snap a photo, we fill the expense (10 / month)" },
      { text: t("featFreeClose", "30-second daily close") || "30-second daily close" },
      { text: t("featFreeSalesExp", "Sales & expenses logging") || "Sales & expenses logging" },
      { text: t("featFreeHistory7", "7 days of export history") || "7 days of export history" },
      { text: t("featFreeExportManual", "Download Excel / PDF / CSV manually") || "Download Excel / PDF / CSV manually" },
      { text: t("featFreeSingle", "1 user, 1 branch") || "1 user, 1 branch" },
    ],
  },
  {
    id: "starter",
    name: t("pricingTierStarter") || "Starter",
    job:
      t(
        "pricingJobStarter",
        "I never paste-attach a PDF to my bogholder again.",
      ) || "I never paste-attach a PDF to my bogholder again.",
    timeSaved: t("pricingTimeStarter", "~3 hours saved every month"),
    tagline:
      t("pricingTaglineStarter") ||
      "For the café or shop that closes every night.",
    price_monthly: 199,
    price_annual: 159,
    founding_price: 129,
    founding_limit: FOUNDING_LIMIT,
    cta: t("pricingUpgradeStarter") || "Upgrade to Starter",
    // Anonymous CTA: just "Sign up free". The 14-day trial we offer is
    // FULL PRO, not Starter — every signup gets Pro entitlements for 14
    // days, then on day 14 chooses Free / Starter / Pro.
    cta_unauth: t("pricingSignUpFree") || "Sign up free",
    highlight: false,
    variant: "default",
    addsHeader: t("featStarterAdds", "Everything in Free, plus:") || "Everything in Free, plus:",
    features: [
      // Refreshed May 2026 — Starter is the "real bookkeeping" tier.
      // The killers are accountant read-only login (the stickiness
      // moat) + bank reconciliation auto-match + recurring expenses.
      // These ship today; before they shipped, Starter was thin.
      { text: t("featStarterAccountantLogin", "Your revisor logs in for free — read-only, audit-logged, GDPR-safe") || "Your revisor logs in for free — read-only, audit-logged, GDPR-safe" },
      { text: t("featStarterBankRec", "Bank reconciliation — upload netbank CSV, auto-match payments to fakturaer") || "Bank reconciliation — upload netbank CSV, auto-match payments to fakturaer" },
      { text: t("featStarterRecurring", "Recurring expenses — rent, internet, subscriptions auto-post on schedule") || "Recurring expenses — rent, internet, subscriptions auto-post on schedule" },
      { text: t("featStarterReceipt200", "Receipt OCR — 300 / month, AI vision-grade accuracy") || "Receipt OCR — 300 / month, AI vision-grade accuracy" },
      // Supplier auto-detection — Starter-exclusive value-add. Pairs
      // naturally with bank reconciliation: snap the supplier invoice,
      // 30 categorized inventory rows appear, the matching MobilePay /
      // bank line auto-reconciles. Free still gets generic inventory
      // OCR so the bullet's HONESTLY a tier upsell, not a "Free can't
      // OCR" lie.
      { text: t("featStarterSupplierDetect", "Auto-detect 16+ Danish suppliers (Hørkram, BC Catering, AB Catering, …) — instant categorization on every invoice") || "Auto-detect 16+ Danish suppliers (Hørkram, BC Catering, AB Catering, …) — instant categorization on every invoice" },
      // Phase 1 expiry chain (May 2026, Manoj-confirmed). Starter
      // unlocks the in-app + Brief alerts; Pro adds push notifications.
      // Pinned 5,000+ kr/year as the marketing number — a 30-cover
      // café losing 10-20% of food cost to waste is ~50,000 kr/year;
      // preventing 5% of that via active alerts is ~2,500-5,000 kr.
      // We round CONSERVATIVELY (5,000+) per the "honest marketing"
      // doctrine — easy to defend, easy to over-deliver on.
      { text: t("featStarterExpiryAlerts", "Inventory expiry alerts — we warn you before items spoil, saves 5,000+ DKK/year") || "Inventory expiry alerts — we warn you before items spoil, saves 5,000+ DKK/year" },
      { text: t("featStarterEmailRevisor", "Email kasserapport to your bogholder in one tap") || "Email kasserapport to your bogholder in one tap" },
      // Lane A — auto-email on lock. Starter's "the day is closed, no
      // extra tap needed" promise. PDF + scanned Z-report photo arrive
      // in owner + accountant inbox the moment FoH staff hits Confirm
      // & Lock. This bullet is the user-facing translation of the
      // close_auto_email + close_scan_attached entitlements.
      { text: t("featStarterCloseAutoEmail", "Auto-email kasserapport + scanned Z-report to your owner + accountant the moment you lock — no extra tap, no forgetting") || "Auto-email kasserapport + scanned Z-report to your owner + accountant the moment you lock — no extra tap, no forgetting" },
      // ── Moved to Starter under the 2026-07 tier doctrine ──────────────
      // Every functional feature now ships on Starter; Pro differs ONLY by
      // size (branches/seats), volume caps, white-label + priority support.
      // (Keys keep their featPro* names — only their tier placement moved.)
      { text: t("featProScheduleAutopilot", "Staff schedule autopilot — weather + revenue forecast + DK labor law, in one tap") || "Staff schedule autopilot — weather + revenue forecast + DK labor law, in one tap" },
      { text: t("featProStaffEmail", "Email schedule to every staff member at once") || "Email schedule to every staff member at once" },
      { text: t("featProTaxFilingPdf", "MOMS filing-ready PDF — pre-filled angivelse format your revisor can upload to SKAT") || "MOMS filing-ready PDF — pre-filled angivelse format your revisor can upload to SKAT" },
      { text: t("featProClosePush", "Push notification to owner when staff locks the close — peace of mind from anywhere") || "Push notification to owner when staff locks the close — peace of mind from anywhere" },
      { text: t("featProExpiryPush", "Push notification when items expire today — never lose a perishable to a forgotten reminder") || "Push notification when items expire today — never lose a perishable to a forgotten reminder" },
      { text: t("featStarterReservationInsights", "Reservation Insights — demand forecast + no-show detail per weekday") || "Reservation Insights — demand forecast + no-show detail per weekday" },
      { text: t("featProLoyalty", "Customer loyalty signal in the Brief — top regulars who haven't been back") || "Customer loyalty signal in the Brief — top regulars who haven't been back" },
      { text: t("featStarterFaktura30", "Faktura — up to 30 / month, emailed direct to customer") || "Faktura — up to 30 / month, emailed direct to customer" },
      { text: t("featStarterKreditnota", "Proper kreditnota flow — Bogføringsloven §7 compliant") || "Proper kreditnota flow — Bogføringsloven §7 compliant" },
      { text: t("featStarterHistory31", "31 days of history + Dinero / Billy / e-conomic CSV templates") || "31 days of history + Dinero / Billy / e-conomic CSV templates" },
      { text: t("featStarterTeam3", "Up to 3 team members with role permissions") || "Up to 3 team members with role permissions" },
      { text: t("featStarterAnomaly", "AI anomaly detection — flags a misread amount before close") || "AI anomaly detection — flags a misread amount before close" },
      { text: t("featStarterKhata", "Khata — unlimited") || "Khata — unlimited" },
      { text: t("featStarterBrief3", "AI brief — 3 refreshes / day, more chat capacity") || "AI brief — 3 refreshes / day, more chat capacity" },
    ],
  },
  {
    id: "pro",
    name: t("pricingTierPro") || "Pro",
    job:
      t(
        "pricingJobPro",
        "I run three locations from one login — bigger limits, my brand on every faktura, support that answers first.",
      ) ||
      "I run three locations from one login — bigger limits, my brand on every faktura, support that answers first.",
    timeSaved: t("pricingTimePro", "~12 hours saved every month"),
    tagline:
      t("pricingTaglinePro") ||
      "For 2-3 locations — more branches, more seats, higher limits, white-label, priority support.",
    price_monthly: 349,
    price_annual: 279,
    founding_price: 249,
    founding_limit: FOUNDING_LIMIT,
    cta: t("pricingUpgradePro") || "Upgrade to Pro",
    cta_unauth: t("pricingStartTrial") || "Start 14-day free trial",
    highlight: true,
    variant: "emphasis",
    badge:
      t("pricingBadgeFreeTrialPopular") ||
      "🎁 14 days free · No card required",
    addsHeader: t("featProAdds", "Everything in Starter, plus:") || "Everything in Starter, plus:",
    features: [
      // Doctrine 2026-07 — Pro is the SIZE + VOLUME + premium-perks tier.
      // Every functional AI/automation feature now also ships on Starter,
      // so Pro no longer advertises "AI Starter can't have". Pro's job is
      // MORE locations, MORE seats, HIGHER volume caps, white-label faktura
      // and priority support. (Autopilot, MOMS filing PDF, loyalty signal,
      // close/expiry push, bulk staff email + reservation insights all moved
      // up to the Starter list above.)
      { text: t("featProMulti3", "3 branches, 5 team members") || "3 branches, 5 team members" },
      { text: t("featProMultiTerm", "Multi-terminal close — merge Z-reports from every POS into one PDF") || "Multi-terminal close — merge Z-reports from every POS into one PDF" },
      { text: t("featProFakturaUnlimited", "Faktura — unlimited") || "Faktura — unlimited" },
      { text: t("featProReceipt500", "Receipt OCR — 500 / month, AI vision-grade accuracy") || "Receipt OCR — 500 / month, AI vision-grade accuracy" },
      { text: t("featProBrief5", "AI brief — 5 refreshes / day, 200 chat messages") || "AI brief — 5 refreshes / day, 200 chat messages" },
      { text: t("featProWhiteLabel", "White-label faktura PDFs — no BonBox brand") || "White-label faktura PDFs — no BonBox brand" },
      { text: t("featProPriority", "Priority email support") || "Priority email support" },
    ],
  },
];

function daysRemaining(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86400000);
}

/**
 * renderStarterAcctTagline — live "saves your revisor ~X timer/md = ~Y kr"
 * line on the Starter pricing card.
 *
 * Honesty rules (Manoj's "those claims are big" mandate):
 *   • The numbers come from /api/accountant-savings/current-month —
 *     same source as the dashboard widget, so a user who tapped through
 *     the widget can NEVER see a mismatched number on the pricing card.
 *   • New accounts (no actions yet) get the generic fallback line, NOT
 *     "saves you 0 hours" — that would feel either broken or sarcastic.
 *   • A null acctSavings response (anonymous visitor, /current-month
 *     errored, Free user with the zero payload) also takes the
 *     fallback — we never lie about saving someone hours they haven't
 *     saved.
 *
 * Returns a plain string ready to drop into the markup.
 */
function renderStarterAcctTagline(t, acctSavings) {
  const fallback =
    t(
      "pricingStarterAcctTaglineFallback",
      "Saves your revisor hours every month",
    ) || "Saves your revisor hours every month";

  const hours = Number(acctSavings?.hours_saved) || 0;
  const money = Number(acctSavings?.money_saved_dkk) || 0;
  if (hours <= 0 || money <= 0) {
    return fallback;
  }

  // Render hours with one decimal (matches the dashboard widget's
  // formatting), money as integer-floor in the user's currency. The
  // backend already truncates; this is defense-in-depth so the
  // pricing card never overstates.
  const fmtHours = (Math.floor(hours * 10) / 10).toFixed(1).replace(".", ",");
  const currency = acctSavings?.currency || "DKK";
  const floored = Math.floor(money).toLocaleString("da-DK", {
    maximumFractionDigits: 0,
  });
  const moneyStr = currency === "DKK" ? `${floored} kr` : `${floored} ${currency}`;

  return (
    t(
      "pricingStarterAcctTagline",
      "Saves your revisor ~{hours} hours/month = ~{money}",
    )
      .replace("{hours}", fmtHours)
      .replace("{money}", moneyStr)
  );
}

export default function SubscriptionPage() {
  const { user, refreshUser } = useAuth();
  const { t } = useLanguage();
  const { refresh: refreshEntitlements } = useEntitlements();
  const [annual, setAnnual] = useState(false);
  const [billing, setBilling] = useState(null);
  const [joined, setJoined] = useState(new Set());
  const [pending, setPending] = useState(null);
  const [msg, setMsg] = useState("");
  // Post-payment acknowledgment: null | "syncing" | "confirmed" | "processing".
  const [paymentAck, setPaymentAck] = useState(null);
  // Founder-rate live status (Task #89 P2-2). Same endpoint the
  // FounderRatePill uses on the landing page — factored into the
  // shared useFounderRateStatus hook. `valid === false` means we
  // haven't heard back yet OR the fetch failed; in either case we
  // hide the "X spots left" chip instead of showing a stale count.
  const { status: founderStatus, valid: founderStatusValid } = useFounderRateStatus();

  // Tiers re-build on every render so language changes pick up immediately.
  const TIERS = buildTiers(t);

  // Live accountant-hours-saved snapshot for the Starter pricing card
  // tagline. When the user has Starter+ entitlements this returns real
  // numbers from THIS calendar month; for Free / unauthenticated users
  // the backend returns the zero payload and the card falls back to the
  // generic "Saves your revisor hours every month" copy.
  const [acctSavings, setAcctSavings] = useState(null);

  // Load current plan + waitlist status + acct-savings in parallel.
  // The acct-savings call is intentionally NOT blocking on auth: the
  // endpoint returns 401 for anonymous visitors (silent ignore), and
  // 200 with zero payload for Free users — both render the fallback
  // tagline correctly.
  useEffect(() => {
    if (!user) return;
    Promise.all([
      api.get("/billing/me").catch(() => ({ data: null })),
      api.get("/waitlist/status").catch(() => ({ data: [] })),
      api
        .get("/accountant-savings/current-month", { _noRetry: true })
        .catch(() => ({ data: null })),
    ]).then(([b, w, s]) => {
      setBilling(b.data);
      setJoined(new Set((w.data || []).map((r) => r.tier)));
      setAcctSavings(s.data);
    });
  }, [user]);

  // Post-payment return handler. Stripe redirects to
  //   /subscription?success=1&session_id=...
  // but nothing read it before — a genuinely-completed checkout could leave the
  // owner staring at the pre-payment "Upgrade" CTA and conclude it failed. Read
  // it, force-reconcile directly from Stripe (so we don't depend on the webhook
  // having fired), refresh global entitlements + the /auth/me user so gates and
  // chrome update without a hard reload, then acknowledge what genuinely
  // happened with their money — never over-promising an unsettled async payment.
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("success") !== "1") return;
    // Strip the query immediately so a refresh / back can't re-run this.
    window.history.replaceState({}, "", window.location.pathname);
    setPaymentAck("syncing");
    let cancelled = false;
    (async () => {
      // Force a direct Stripe reconcile so /billing/me reflects the completed
      // checkout even if the webhook is lagging/misconfigured. Best-effort.
      try { await api.post("/billing/stripe/sync", {}); } catch { /* ignore */ }
      let fresh = null;
      try {
        const b = await api.get("/billing/me").catch(() => ({ data: null }));
        fresh = b?.data || null;
        if (!cancelled && fresh) setBilling(fresh);
      } catch { /* ignore */ }
      // Update global entitlements + user.plan so feature gates + chrome reflect
      // the new plan without a full reload.
      try { await refreshEntitlements?.(); } catch { /* ignore */ }
      try { await refreshUser?.(); } catch { /* ignore */ }
      if (cancelled) return;
      // Honest ack: only claim "unlocked" if the plan actually resolved to a
      // paid tier. An async method (SEPA/MobilePay) can be 'active' but still
      // settling — say "processing" instead of over-promising.
      const paidNow = ["starter", "pro"].includes(fresh?.plan);
      const stillSettling = !paidNow && fresh?.subscription_status === "active";
      setPaymentAck(stillSettling ? "processing" : "confirmed");
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // A confirmed ack is a transient celebration — auto-dismiss so the persistent
  // locked-in banner below carries the ongoing state. "processing" persists
  // (the owner needs to keep seeing that it's still clearing).
  useEffect(() => {
    if (paymentAck !== "confirmed") return;
    const id = setTimeout(() => setPaymentAck(null), 8000);
    return () => clearTimeout(id);
  }, [paymentAck]);

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
    // ── Paid-tier upgrade (Starter or Pro) — WEB ONLY ──
    // App Store compliance (Apple 3.1.1): the native app carries NO purchase
    // path and NO steering to an external (web/Stripe) checkout. On native the
    // component returns a read-only plan-status view above (the `if (isNative)`
    // block), so this handler — and the Stripe checkout below — is never
    // reachable inside the iOS app. The old native `Browser.open(bonbox.dk/
    // subscription)` external-purchase branch was removed so the binary carries
    // no external-checkout code. Backend ALSO blocks native checkout (defense
    // in depth).

    // Graceful fallback — this tier isn't ready for real checkout yet (early
    // launch, or its founding price ID is unset). Capture intent on the waitlist
    // instead of dead-ending. Used both when we know upfront the tier isn't
    // ready AND when the backend authoritatively says so (409 payment_unavailable).
    const joinWaitlist = async () => {
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
            ? (t("waitlistJoinedPro") || "🎉 You're on the founding-member list — when payment opens, you'll lock in 249 kr/mo for as long as you stay subscribed.")
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

    // Web flow — try real Stripe Checkout, but only for a tier the backend says
    // can ACTUALLY check out. checkout_ready is per-tier (founding price ID for
    // *this* tier present), so a misconfigured Starter never blocks a working
    // Pro. Fall back to stripe_configured for deploy-skew (old backend without
    // checkout_ready). Not-ready tiers route to the honest waitlist, never a 500.
    const tierReady =
      billing?.checkout_ready?.[tierId] ?? Boolean(billing?.stripe_configured);
    if ((tierId === "pro" || tierId === "starter") && tierReady) {
      setPending(tierId);
      setMsg("");
      let fallbackToWaitlist = false;
      try {
        const res = await api.post("/billing/stripe/checkout-session", { plan: tierId });
        const safeStripeUrl = safeExternalUrl(res.data?.url);
        if (safeStripeUrl) {
          // Already paid → portal URL was returned; otherwise checkout URL
          if (res.data.already_subscribed) {
            trackEvent("stripe_portal_opened", "subscription", tierId);
          } else {
            trackEvent("stripe_checkout_started", "subscription", tierId);
          }
          window.location.href = safeStripeUrl;
          return;
        }
        setMsg(t("checkoutOpenFailed") || "Couldn't open checkout. Please try again.");
      } catch (e) {
        if (e?.response?.status === 403 && e.response.data?.redirect_to_web) {
          window.open("https://bonbox.dk/subscription", "_blank");
        } else if (e?.response?.status === 409 && e.response.data?.payment_unavailable) {
          // Backend says this tier can't check out yet — degrade to waitlist.
          fallbackToWaitlist = true;
        } else if (e?.response?.status === 429) {
          setMsg(t("tooManyRequests") || "Too many requests — please try again in a minute.");
        } else {
          setMsg(errText(e, t("checkoutStartFailed") || "Could not start checkout. Please try again."));
        }
      } finally {
        setPending(null);
      }
      if (fallbackToWaitlist) return joinWaitlist();
      return;
    }

    // Stripe not ready for this tier — capture intent on the waitlist.
    return joinWaitlist();
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
      setMsg(errText(e, t("billingPortalFailed") || "Could not open the billing portal. Please try again."));
    } finally {
      setPending(null);
    }
  };

  // True iff the user has a real Stripe subscription (post lock-in).
  const hasStripeSub = ["active", "trialing", "past_due"].includes(billing?.subscription_status);

  // Founder counts derived from the live endpoint (Task #89 P2-2).
  // We only render the "X spots left" chip when we got a coherent
  // response back — otherwise hiding the pill is better than lying
  // about a number we don't actually have.
  const foundingLimit = founderStatusValid ? founderStatus.max_slots : FOUNDING_LIMIT;
  const foundingRemaining = founderStatusValid
    ? Math.max(founderStatus.available, 0)
    : null;

  // ── App Store compliance (Apple Guideline 3.1.1) ────────────────────
  // The native app must NOT sell, price, link out to purchase, OR steer the
  // user to the website to buy a paid plan (Apple treats steering-to-web as a
  // violation too). Show the current plan READ-ONLY with a neutral status note
  // that names no price, no upgrade path, and no website. No plan cards,
  // prices, buy buttons, or billing portal here. The web app (bonbox.dk) keeps
  // full self-serve billing — this branch only runs on native.
  if (isNative) {
    const planName =
      currentPlan === "pro"
        ? "Pro"
        : currentPlan === "starter"
          ? "Starter"
          : currentPlan === "trial"
            ? "Pro (trial)"
            : "Free";
    return (
      <div className="px-4 sm:px-6 py-6 sm:py-10 pb-32 sm:pb-16 max-w-2xl mx-auto">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("planBilling") || "Plan & billing"}
        </h1>
        <Card variant="emphasis" className="mt-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("currentPlan") || "Current plan"}
          </div>
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-1">
            {planName}
          </div>
          {trialDaysLeft != null && trialDaysLeft > 0 && (
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {(t("pricingTrialEndsIn") || "Your free Pro trial ends in {n} day{s}.")
                .replace("{n}", trialDaysLeft)
                .replace("{s}", trialDaysLeft === 1 ? "" : "s")}
            </div>
          )}
        </Card>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-5 leading-relaxed">
          {t("planNativeStatusNote") ||
            "This is your current plan. Plans are managed outside the app."}
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-10 pb-32 sm:pb-16 max-w-6xl mx-auto">
      {/* Post-payment acknowledgment — shown on the Stripe success return */}
      {paymentAck && (
        <Card variant="emphasis" className="mb-6">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="w-10 h-10 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0 text-lg">
              {paymentAck === "syncing" ? "…" : paymentAck === "processing" ? "⏳" : "🎉"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {paymentAck === "syncing"
                  ? (t("pricingPaymentConfirming") || "Confirming your payment…")
                  : paymentAck === "processing"
                    ? (t("pricingPaymentProcessing") || "Payment received — it's still clearing")
                    : (t("pricingPaymentConfirmed") || "Payment confirmed — your plan is unlocked 🎉")}
              </div>
              {paymentAck === "processing" && (
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t("pricingPaymentProcessingSub") ||
                    "Bank debits (MobilePay/SEPA) can take a few days to clear. We'll unlock your plan the moment it does — no need to pay again."}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Locked-in banner — for users with a real Stripe sub */}
      {hasStripeSub ? (
        <Card variant="emphasis" className="mb-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
            <div className="w-10 h-10 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0 text-lg">
              {billing?.subscription_status === "past_due" ? "!" : "✓"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
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
                    ? (["starter", "pro"].includes(billing?.plan)
                        ? (t("pricingLockedActive") || "Subscription active — billed monthly at your founding rate")
                        : (t("pricingLockedProcessing") || "Payment processing — your plan unlocks as soon as it clears"))
                    : billing?.subscription_status === "past_due"
                      ? (t("pricingLockedPastDue") || "Payment failed — please update your card to keep your plan")
                      : (t("pricingLockedGeneric") || "Subscription active")}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {t("pricingLockedSubtitle") || "All Pro features unlocked. Founding-member rate is locked for life as long as you stay subscribed."}
              </div>
            </div>
            <Button
              variant="secondary"
              size="md"
              busy={pending === "manage"}
              onClick={handleManage}
              className="whitespace-nowrap"
            >
              {pending === "manage" ? (t("pricingOpening") || "Opening…") : (t("pricingManageSubscription") || "Manage subscription")}
            </Button>
          </div>
        </Card>
      ) : trialDaysLeft != null && trialDaysLeft > 0 ? (
        <Card variant="emphasis" className="mb-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
            <div className="w-10 h-10 rounded-full bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
              <span aria-hidden="true">⏳</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {(t("pricingTrialEndsIn") || "Your free Pro trial ends in {n} day{s}.")
                  .replace("{n}", trialDaysLeft)
                  .replace("{s}", trialDaysLeft === 1 ? "" : "s")}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {t("pricingTrialUsing") || "You're using all Pro features right now — AI insights, unlimited Copilot, full history, vertical modules. After the trial you can stay on Free (limited) or upgrade."}
              </div>
            </div>
            <Button
              variant="accent"
              size="md"
              onClick={() => handleCta("pro")}
              className="whitespace-nowrap"
            >
              {t("pricingLockInRate") || "Lock in founding rate"}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* How it works — only relevant while on trial */}
      {trialDaysLeft != null && trialDaysLeft > 0 && (
        <Card variant="default" className="mb-10 max-w-4xl mx-auto">
          <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t("pricingHowTrialWorks") || "How your trial works"}
          </h3>
          <div className="grid sm:grid-cols-3 gap-4 sm:gap-5">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t("pricingTrialStep1Tag") || "Today"}
              </div>
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-1">
                {t("pricingTrialStep1Title") || "Trial started at sign-in"}
              </div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                {t("pricingTrialStep1Body") || "14 days of full Pro — every feature, no caps. No card, no charge."}
              </div>
            </div>
            <div className="sm:border-l sm:border-gray-200 sm:dark:border-gray-800 sm:pl-5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                {(t("pricingTrialStep2Tag") || "Anytime in the next {n} day{s}")
                  .replace("{n}", trialDaysLeft)
                  .replace("{s}", trialDaysLeft === 1 ? "" : "s")}
              </div>
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-1">
                {t("pricingTrialStep2Title") || "Pick your path"}
              </div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                <span className="block">→ {t("pricingTrialStep2BodyLock") || "Lock in founding rate: add card now, your founding price (Starter 129 / Pro 249) is locked for life"}</span>
                <span className="block mt-1">→ {t("pricingTrialStep2BodyDoNothing") || "Do nothing: trial runs out, you drop to Free"}</span>
              </div>
            </div>
            <div className="sm:border-l sm:border-gray-200 sm:dark:border-gray-800 sm:pl-5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                {t("pricingTrialStep3Tag") || "Day 14"}
              </div>
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-1">
                {t("pricingTrialStep3Title") || "What actually happens"}
              </div>
              <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                <span className="block">{t("pricingTrialStep3BodyLocked") || "If locked in: founding rate charged to your card"}</span>
                <span className="block mt-1">{t("pricingTrialStep3BodyDropped") || "If not: dropped to Free (caps return, data stays, no charge ever)"}</span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Hero — acquisition copy only */}
      {!billing?.trial_active && !billing?.is_paid && (
        <div className="text-center mb-10">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
            {t("pricingHeroTitleNew", "Plans built around time saved.") || "Plans built around time saved."}
          </h1>
          <p className="text-sm sm:text-base text-gray-500 dark:text-gray-400 mt-3 max-w-2xl mx-auto leading-relaxed">
            {t(
              "pricingHeroSubtitleNew",
              "Pick the plan that matches how much manual work you want to skip. Every signup starts with 14 days of full Pro — no card, no surprises.",
            ) ||
              "Pick the plan that matches how much manual work you want to skip. Every signup starts with 14 days of full Pro — no card, no surprises."}
          </p>
          {/* Hide the chip entirely on fetch failure so we never
              show a stale count. Defensive: if foundingRemaining
              somehow comes back as 0 the chip still renders ("0 spots
              left") which IS the truth and pairs nicely with the
              sold-out state. */}
          {foundingRemaining != null && (
            <div className="mt-5 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-medium text-gray-700 dark:text-gray-300">
              {(t("pricingFoundingChipNew", "First {limit} customers — founding price locked for life · {remaining} spots left") ||
                "First {limit} customers — founding price locked for life · {remaining} spots left")
                .replace("{remaining}", foundingRemaining)
                .replace("{limit}", foundingLimit)}
            </div>
          )}
        </div>
      )}

      {/* Quieter heading once user is engaged */}
      {(billing?.trial_active || billing?.is_paid) && (
        <div className="text-center mb-6">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
            {t("pricingComparePlansTitle") || "Compare plans"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1.5">
            {t("pricingComparePlansSubtitle") ||
              "What you get on each tier. Annual saves 20%."}
          </p>
        </div>
      )}

      {/* Annual / monthly toggle */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center bg-gray-100 dark:bg-gray-800 rounded-full p-1 mt-2">
          <button
            onClick={() => setAnnual(false)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
              !annual
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {t("pricingMonthly") || "Monthly"}
          </button>
          <button
            onClick={() => setAnnual(true)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition relative ${
              annual
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {t("pricingAnnual") || "Annual"}
            <span className="ml-2 inline-block bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-emerald-400 text-[10px] px-1.5 py-0.5 rounded font-semibold">
              -20%
            </span>
          </button>
        </div>
      </div>

      {/* Status confirmation banner */}
      {msg && (
        <div className="mb-6 text-center text-sm bg-gray-50 dark:bg-gray-800/50 text-gray-800 dark:text-gray-300 rounded-xl px-4 py-3 border border-gray-100/60 dark:border-gray-800/60">
          {msg}
        </div>
      )}

      {/* Tier cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5 items-stretch">
        {TIERS.map((tier) => {
          // "isCurrent" = user is a PAID subscriber on this exact tier.
          // Trial doesn't count — a trial user still needs to lock in.
          const isCurrent =
            (tier.id === "pro" && currentPlan === "pro") ||
            (tier.id === "starter" && currentPlan === "starter") ||
            (tier.id === "free" && currentPlan === "free");
          // Visual-only marker for the Pro card during trial.
          const showTrialBadge = tier.id === "pro" && currentPlan === "trial";
          // During trial, swap CTA label on Starter + Pro.
          const showTrialLockCTA =
            currentPlan === "trial" && (tier.id === "starter" || tier.id === "pro");
          // Per-tier readiness: this tier can really check out (its founding
          // price ID is set). Falls back to the coarse stripe_configured flag
          // for deploy-skew. Drives both the CTA label + the disabled state so
          // a not-ready tier honestly reads "Join the list", not "Lock in".
          const stripeReady =
            billing?.checkout_ready?.[tier.id] ?? !!billing?.stripe_configured;
          const price = annual ? tier.price_annual : tier.price_monthly;
          const isFounding = !!tier.founding_price;
          const cta = user ? tier.cta : tier.cta_unauth;

          // Which Button variant for the CTA? Per the design system:
          //   accent     — "Start trial" (Pro card for new visitors)
          //   primary    — "Upgrade" (paid tier action for signed-in users)
          //   secondary  — "Stay on Free" / neutral
          let ctaVariant = "primary";
          if (tier.id === "free") {
            ctaVariant = "secondary";
          } else if (tier.id === "pro") {
            // Anonymous visitor sees Pro as the "Start trial" accent CTA.
            ctaVariant = !user ? "accent" : "primary";
          }

          const ctaDisabled =
            isCurrent ||
            pending === tier.id ||
            (!stripeReady && joined.has(tier.id));

          let ctaLabel;
          if (isCurrent) {
            ctaLabel = `✓ ${t("currentPlan") || "Current plan"}`;
          } else if (pending === tier.id) {
            ctaLabel = t("pricingJoining") || "Joining…";
          } else if (!stripeReady && joined.has(tier.id)) {
            ctaLabel = t("pricingOnTheList") || "✓ On the list";
          } else if (!stripeReady && (tier.id === "starter" || tier.id === "pro")) {
            // Payment for this tier isn't open yet — the click joins the
            // waitlist, so the label must say so (not "Lock in").
            ctaLabel = t("pricingJoinWaitlist") || "Join the founding list";
          } else if (showTrialLockCTA) {
            ctaLabel = t("pricingLockInRate") || "Lock in founding rate";
          } else {
            ctaLabel = cta;
          }

          return (
            <Card
              key={tier.id}
              variant={tier.variant}
              className={`relative flex flex-col ${
                tier.highlight ? "ring-1 ring-emerald-500/40 dark:ring-emerald-400/30" : ""
              }`}
            >
              {/* Top-right status pill — stays gray-900 because "Current
                  plan" / "Your trial" are NEUTRAL info, not a brand
                  promotion. Only the "Recommended" pill earns brand-green. */}
              {(isCurrent || showTrialBadge) && (
                <div className="absolute -top-2.5 right-4 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full whitespace-nowrap">
                  {showTrialBadge
                    ? (t("yourTrial") || "Your trial")
                    : (t("currentPlan") || "Current plan")}
                </div>
              )}

              {/* "Recommended" pill — emerald-600 + emerald-500/40 ring on
                  the card. Per the "BRAND GREEN" token in index.css, the
                  recommended pricing tier is one of the locked brand-green
                  moments because it's the eye-magnet decision aid. */}
              {tier.highlight && !isCurrent && !showTrialBadge && (
                <div className="absolute -top-2.5 left-5 bg-emerald-600 text-white text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full whitespace-nowrap">
                  {t("pricingRecommended", "Recommended") || "Recommended"}
                </div>
              )}

              {/* Tier name */}
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {tier.name}
              </div>

              {/* Job-to-be-done — leads with the value */}
              {/* NOT quoted. These used to render inside curly quotation
                  marks, in the first person — "BonBox lukker min dag på 90
                  sekunder." — which reads as a customer saying it. There is
                  no such customer. A fabricated quotation on the pricing
                  page is the same fault as the invented testimonials, except
                  this one actually rendered. It is a plain "who this is for"
                  line now. */}
              <p className="mt-2 text-[15px] leading-snug font-medium text-gray-900 dark:text-gray-100 min-h-[3em]">
                {tier.job}
              </p>

              {/* Time saved */}
              <div className="mt-3 inline-flex items-center text-[12px] font-medium text-gray-700 dark:text-emerald-400">
                {tier.timeSaved}
              </div>

              {/* Price block — founding rate big + bold, regular strikethrough */}
              <div className="mt-5">
                {isFounding ? (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
                        {tier.founding_price}
                      </span>
                      <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t("pricingDkkPerMonth", "DKK / mo") || "DKK / mo"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-gray-400 dark:text-gray-500 line-through">
                        {price} {t("pricingDkkPerMonth", "DKK / mo") || "DKK / mo"}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                        {t("pricingFirst100Chip", "First 100") || "First 100"}
                      </span>
                    </div>
                  </>
                ) : price === 0 ? (
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
                      {t("pricingFree", "Free") || "Free"}
                    </span>
                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                      {t("pricingForever", "forever") || "forever"}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
                      {price}
                    </span>
                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                      {t("pricingDkkPerMonth", "DKK / mo") || "DKK / mo"}
                    </span>
                  </div>
                )}
                {annual && price > 0 && !isFounding && (
                  <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
                    {t("pricingBilledAnnually") || "billed annually"}
                  </div>
                )}
              </div>

              {/* Trial badge — Pro only */}
              {tier.badge && (
                <div className="text-[11px] font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-md px-2.5 py-1.5 mt-4 text-center">
                  {tier.badge}
                </div>
              )}

              {/* CTA button */}
              <div className="mt-5">
                <Button
                  variant={ctaVariant}
                  size="lg"
                  className="w-full"
                  disabled={ctaDisabled}
                  busy={pending === tier.id}
                  onClick={() => handleCta(tier.id)}
                >
                  {ctaLabel}
                </Button>
              </div>

              {/* Manage / Cancel — only when user has a real Stripe sub */}
              {isCurrent && hasStripeSub && (tier.id === "pro" || tier.id === "starter") && (
                <button
                  onClick={handleManage}
                  disabled={pending === "manage"}
                  className="w-full text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline mt-2 disabled:opacity-50"
                >
                  {pending === "manage" ? (t("pricingOpening") || "Opening…") : (t("pricingManageOrCancel") || "Manage subscription / cancel")}
                </button>
              )}

              {/* Feature list — verb-led, short lines */}
              <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-800 flex-1">
                {tier.addsHeader && (
                  <div className="text-[12px] font-semibold text-gray-900 dark:text-gray-100 mb-3">
                    {tier.addsHeader}
                  </div>
                )}
                <ul className="space-y-2.5 text-[13px] text-gray-700 dark:text-gray-300">
                  {tier.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 leading-snug">
                      <CheckIcon />
                      <span>{f.text}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Accountant-hours-saved tagline — bottom-anchored footer.
                  Starter shows a live "saves your revisor ~X timer/md = ~Y kr"
                  computed from the current user's actual data when they
                  have it; falls back to a generic "every month" line for
                  new accounts and anonymous visitors. Pro's footer pitches
                  its genuine differentiators (white-label faktura + priority
                  support) — the one-click month-end revisor pack moved to
                  Starter under the 2026-07 tier doctrine, so Pro no longer
                  claims it as an exclusive. */}
              {tier.id === "starter" && (
                <p className="mt-4 text-[12px] text-gray-700 dark:text-emerald-400 font-medium leading-snug">
                  {renderStarterAcctTagline(t, acctSavings)}
                </p>
              )}
              {tier.id === "pro" && (
                <p className="mt-4 text-[12px] text-gray-700 dark:text-emerald-400 font-medium leading-snug">
                  {t(
                    "pricingProAcctTagline",
                    "+ white-label faktura + priority support",
                  ) || "+ white-label faktura + priority support"}
                </p>
              )}
            </Card>
          );
        })}
      </div>

      {/* What changes after trial — calm transparency */}
      <Card variant="subtle" className="mt-10 max-w-3xl mx-auto">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 flex items-center justify-center text-sm font-semibold shrink-0">
            i
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
              {t("pricingAfterTrialTitle") || "What changes after the 14-day trial"}
            </h3>
            <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
              {t(
                "pricingAfterTrialBodyNew",
                "Nothing dramatic. Your data stays, every feature stays visible. These are the caps that come back when the trial ends:",
              ) ||
                "Nothing dramatic. Your data stays, every feature stays visible. These are the caps that come back when the trial ends:"}
            </p>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 mt-4 text-[13px] text-gray-700 dark:text-gray-300">
              {[
                t("pricingAfterTrialCapClose", "30-second daily close") || "30-second daily close",
                t("pricingAfterTrialCapHistory", "7 days of history") || "7 days of history",
                t("pricingAfterTrialCapOCR", "5 receipt scans / day") || "5 receipt scans / day",
                t("pricingAfterTrialCapChat", "10 AI chat messages / day") || "10 AI chat messages / day",
                t("pricingAfterTrialCapBrief", "1 AI brief refresh / day") || "1 AI brief refresh / day",
                t("pricingAfterTrialCapExport", "Manual Excel / PDF / CSV export") || "Manual Excel / PDF / CSV export",
                t("pricingAfterTrialCapSingle", "1 user, 1 branch") || "1 user, 1 branch",
                t("pricingAfterTrialCapNoFaktura", "Faktura locked (Starter+)") || "Faktura locked (Starter+)",
              ].map((line) => (
                <div key={line} className="flex items-start gap-2">
                  <span className="mt-[7px] w-1 h-1 rounded-full bg-gray-400 dark:bg-gray-500 shrink-0" />
                  <span>{line}</span>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-4 leading-relaxed">
              {t(
                "pricingAfterTrialClosingNew",
                'No card needed to start the trial — it runs automatically when you sign up. You only enter a card if you click "Lock in founding rate". Otherwise the trial just ends and you drop to Free.',
              ) ||
                'No card needed to start the trial — it runs automatically when you sign up. You only enter a card if you click "Lock in founding rate". Otherwise the trial just ends and you drop to Free.'}
            </p>
          </div>
        </div>
      </Card>

      {/* Reassurance row — warm stone, no random color blocks */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-10">
        <Reassure title={t("pricingReassureNoCard") || "No card for trial"} sub={t("pricingReassureNoCardSub") || "14 days of Pro, no payment info needed."} />
        <Reassure title={t("pricingReassureDenmark") || "Built in Denmark"} sub={t("pricingReassureDenmarkSub") || "Database in Ireland · DKK and MOMS built in"} />
        <Reassure title={t("pricingReassureCancel") || "Cancel anytime"} sub={t("pricingReassureCancelSub") || "No contracts. Export your data on the way out."} />
        {/*
          Count and list are DERIVED from the picker, never typed. This tile
          used to read a hardcoded "6" while the picker offered 7 and only 3
          were finished — a claim on a paid surface that the product itself
          contradicted. The sub is native language names, identical in every
          locale, so it needs no translation key: one source of truth.
        */}
        <Reassure
          title={t("pricingReassureLanguages", "{n} languages", { n: COMPLETE_LANGUAGE_COUNT })}
          sub={COMPLETE_LANGUAGE_NAMES}
        />
      </div>

      {/* FAQ */}
      <div className="mt-12 max-w-3xl mx-auto">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100 mb-4">
          {t("faqHeading") || "Common questions"}
        </h2>
        <div className="space-y-3">
          <FaqItem q={t("faqQ1") || "What happens when my 14-day trial ends?"} a={t("faqA1") || ""} />
          <FaqItem q={t("faqQ2") || "Why does Free have every feature, just with caps?"} a={t("faqA2") || ""} />
          <FaqItem q={t("faqQ3") || "How does the founding-member price work?"} a={t("faqA3") || ""} />
          <FaqItem q={t("faqQ10") || "Does my revisor need their own login?"} a={t("faqA10") || ""} />
          <FaqItem q={t("faqQ11") || "How does the staff schedule autopilot work?"} a={t("faqA11") || ""} />
          <FaqItem q={t("faqQ12") || "Will BonBox connect to my bank automatically?"} a={t("faqA12") || ""} />
          <FaqItem q={t("faqQ4") || "I run a chain with multiple branches — what fits?"} a={t("faqA4") || ""} />
          <FaqItem q={t("faqQ5") || "Do I have to switch from Dinero / Billy / e-conomic?"} a={t("faqA5") || ""} />
          <FaqItem q={t("faqQ9") || "Is BonBox a registered digital bookkeeping system?"} a={t("faqA9") || ""} />
          <FaqItem q={t("faqQ6") || "What about MOMS?"} a={t("faqA6") || ""} />
          <FaqItem q={t("faqQ7") || "Can I cancel anytime?"} a={t("faqA7") || ""} />
          <FaqItem q={t("faqQ8") || "Is my data safe?"} a={t("faqA8") || ""} />
        </div>

        {/* Trademark notice */}
        <p className="mt-10 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed text-center">
          {t("pricingTrademarkNotice") || "Dinero, Billy, e-conomic, MobilePay and Dankort are trademarks of their respective owners. BonBox is not affiliated with or endorsed by any of these companies. References are made for interoperability and comparative purposes under nominative fair use."}
        </p>

        {/* Dev tools — only renders if /api/billing/debug/status returns 200
            (super-admin + kill-switch ON). Hidden for every regular user. */}
        <DevToolsPanel />
      </div>
    </div>
  );
}

/** Small inline check icon — stone palette, no decorative color. */
function CheckIcon() {
  return (
    <svg
      className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.42 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function Reassure({ title, sub }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-900/60 border border-gray-200/70 dark:border-gray-800/70 rounded-xl p-4 text-center">
      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">{sub}</div>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3"
      >
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{q}</span>
        <span
          className="text-gray-400 transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
          {a}
        </div>
      )}
    </div>
  );
}


/**
 * DevToolsPanel — super-admin only, kill-switch gated.
 *
 * Probes GET /api/billing/debug/status on mount. Returns null (renders
 * nothing) on any non-200 response, so regular users and admins running
 * with the kill-switch off never see this panel.
 *
 * When visible: two action buttons (Expire Trial / Reset Trial) and a
 * "force" toggle for users who knowingly want to bypass the active-sub
 * refusal. Every action confirms before firing, then reloads the page
 * so /billing/me re-reads from the backend.
 */
function DevToolsPanel() {
  const [status, setStatus] = useState(null); // null = loading, false = unavailable, object = available
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const confirm = useConfirm();

  useEffect(() => {
    let alive = true;
    // api.js baseURL is already "https://api.bonbox.dk/api" — paths must
    // NOT re-prefix with /api/ or we get /api/api/... (404).
    api
      .get("/billing/debug/status")
      .then((res) => {
        if (alive) setStatus(res.data);
      })
      .catch(() => {
        if (alive) setStatus(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (status === null || status === false) return null;

  const run = async (action, days) => {
    const verb = action === "expire-trial" ? "expire your trial" : "reset your trial";
    const note = force
      ? " (force=true — will override active-subscription guard)"
      : "";
    if (!(await confirm({ message: `This will ${verb}${note}. Continue?`, destructive: true }))) return;
    setBusy(true);
    setLastResult(null);
    try {
      const params = new URLSearchParams();
      if (force) params.set("force", "true");
      if (action === "reset-trial" && days) params.set("days", String(days));
      const qs = params.toString();
      // api.js baseURL already includes /api — don't double-prefix.
      const url = `/billing/debug/${action}${qs ? "?" + qs : ""}`;
      const res = await api.post(url);
      setLastResult({ ok: true, data: res.data });
      // Reload after a beat so /billing/me reflects the new state in the
      // page above this panel.
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      const detail = e?.response?.data?.detail;
      setLastResult({
        ok: false,
        status: e?.response?.status,
        message:
          typeof detail === "string"
            ? detail
            : detail?.message || e?.message || "Request failed",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-12 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50/40 dark:bg-amber-950/20 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
            Dev tools · super-admin only
          </div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-1">
            Trial state controls
          </h3>
          <p className="text-[13px] text-gray-600 dark:text-gray-300 mt-1">
            Signed in as <span className="font-medium">{status.admin_email}</span>.
            Current plan:{" "}
            <span className="font-mono text-gray-900 dark:text-gray-100">
              {status.admin_summary?.plan}
            </span>
            {status.admin_summary?.subscription_status ? (
              <>
                {" "}
                · Stripe:{" "}
                <span className="font-mono">
                  {status.admin_summary.subscription_status}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => run("expire-trial")}
          className="px-3 h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-[13px] font-medium hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          Expire trial → Free
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run("reset-trial", 14)}
          className="px-3 h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-[13px] font-medium hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          Reset trial (14 days)
        </button>
        <label className="flex items-center gap-2 text-[12px] text-gray-600 dark:text-gray-300 ml-2">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          force (bypass active-sub guard)
        </label>
      </div>

      {busy && (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">Working…</p>
      )}

      {lastResult && (
        <div
          className={`mt-2 rounded-md border p-2 text-[12px] font-mono break-words ${
            lastResult.ok
              ? "border-gray-200 bg-gray-50 text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100"
              : "border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100"
          }`}
        >
          {lastResult.ok ? (
            <>
              <div>OK — target={lastResult.data?.target_email}</div>
              <div>
                before: plan={lastResult.data?.before?.plan} · trial_ends_at=
                {lastResult.data?.before?.trial_ends_at || "null"}
              </div>
              <div>
                after: plan={lastResult.data?.after?.plan} · trial_ends_at=
                {lastResult.data?.after?.trial_ends_at || "null"}
              </div>
              <div className="mt-1 text-gray-500">
                Reloading in 1s to refresh /billing/me…
              </div>
            </>
          ) : (
            <>
              <div>HTTP {lastResult.status} — {lastResult.message}</div>
              {lastResult.status === 409 && (
                <div className="mt-1">
                  Tip: tick the "force" checkbox to override.
                </div>
              )}
            </>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
        Hidden from non-admins. Disabled by default — requires the operator
        to set <code className="font-mono">DEBUG_BILLING_ENABLED=true</code> on
        Render. Every action writes a SecurityEvent row.
      </p>
    </div>
  );
}
