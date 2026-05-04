import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { trackEvent } from "../hooks/useEventLog";
import api from "../services/api";

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
 *   Pro: 14-day trial → 99 kr/mo founding (first 1000 customers, regular 249)
 *   Business: talk to sales — multi-branch chains (no public price, custom)
 */

const TIERS = [
  {
    id: "free",
    name: "Free",
    tagline: "Every feature, including AI. Casual usage. Forever.",
    price_monthly: 0,
    price_annual: 0,
    cta: "Start free",
    cta_unauth: "Sign up free",
    highlight: false,
    features: [
      { text: "AI Copilot + AI insights included — every plan, even Free:", included: true, header: true },
      { text: "30 AI Copilot questions / day + voice input", included: true },
      { text: "Top 5 active AI insights at a time", included: true },
      { text: "AI receipt OCR — 30 scans / month", included: true },
      { text: "AI anomaly detection on sales & expenses", included: true },
      { divider: true },
      { text: "200 sales logged / month", included: true },
      { text: "100 expenses logged / month", included: true },
      { text: "1 vertical module (Bar Pour, Workshop, etc. — pick one)", included: true },
      { text: "90 days of full history (older stays read-only)", included: true },
      { text: "Generic CSV export to your accountant", included: true },
      { text: "1 business, 1 user", included: true },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "Unleash the AI. Every cap removed. Most popular.",
    price_monthly: 249,
    price_annual: 199,
    founding_price: 99,
    founding_limit: 1000, // first N customers lock in this price
    cta: "Upgrade to Pro",
    cta_unauth: "Start 14-day free trial",
    highlight: true,
    badge: "🎁 14 days free · No card required",
    features: [
      { text: "AI, no limits — the way it was meant to work:", included: true, header: true },
      { text: "Unlimited AI Copilot conversations + voice input", included: true },
      { text: "Unlimited AI insights archive — never auto-dropped", included: true },
      { text: "Predictive AI: revenue forecast, churn risk, stockout alerts", included: true },
      { text: "AI-powered receipt OCR (unlimited scans)", included: true },
      { text: "AI staff & wage anomaly detection", included: true },
      { text: "Custom AI playbooks tuned to YOUR business pattern", included: true },
      { divider: true },
      { text: "Unlimited sales, expenses, history", included: true },
      { text: "ALL vertical modules at once (Bar Pour + Workshop + etc.)", included: true },
      { text: "Direct Dinero / Billy / e-conomic CSV exports", included: true },
      { text: "Up to 3 businesses, 5 users with role permissions", included: true },
      { text: "Bank import (multi-bank, multi-currency)", included: true },
      { text: "Priority email support", included: true },
    ],
  },
  {
    id: "business",
    name: "Business",
    tagline: "Multi-branch chains. AI that thinks across every location.",
    price_monthly: null, // hidden — custom quote per chain
    cta: "Talk to sales",
    cta_unauth: "Talk to sales",
    highlight: false,
    custom: true,
    features: [
      { text: "Chain-level AI — Pro's AI, but across every branch:", included: true, header: true },
      { text: "Group AI Copilot — asks span all branches, not just one", included: true },
      { text: "Cross-branch AI benchmarking — spot the underperformer in seconds", included: true },
      { text: "AI staffing optimiser — predicts shifts per branch + day", included: true },
      { text: "Group-level revenue forecasting + cash flow projection", included: true },
      { text: "AI churn detection across your entire customer base", included: true },
      { text: "Custom AI playbooks per branch type (kitchen / bar / retail)", included: true },
      { divider: true },
      { text: "Everything in Pro, plus chain operations:", included: true, header: true },
      { text: "Unlimited branches + group-level daily close consolidation", included: true },
      { text: "Per-branch P&L + manager-scoped dashboards", included: true },
      { text: "Branch-manager role (sees only their location)", included: true },
      { text: "Centralised chart of accounts + standard SOPs", included: true },
      { text: "Multi-location inventory & wage tracking", included: true },
      { text: "Unlimited users with role permissions", included: true },
      { text: "API + custom integrations (POS, payroll, suppliers)", included: true },
      { text: "Dedicated onboarding, training & quarterly review", included: true },
      { text: "SLA + 24h priority support", included: true },
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
  const [annual, setAnnual] = useState(false);
  const [billing, setBilling] = useState(null);
  const [joined, setJoined] = useState(new Set());
  const [pending, setPending] = useState(null);
  const [msg, setMsg] = useState("");

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
        if (res.data?.url) {
          // Already paid → portal URL was returned; otherwise checkout URL
          if (res.data.already_subscribed) {
            trackEvent("stripe_portal_opened", "subscription", "pro");
          } else {
            trackEvent("stripe_checkout_started", "subscription", "pro");
          }
          window.location.href = res.data.url;
          return;
        }
        setMsg("Couldn't open checkout. Please try again.");
      } catch (e) {
        if (e?.response?.status === 403 && e.response.data?.redirect_to_web) {
          // Backend says native iOS — open web (we may have missed isNative check)
          window.open("https://bonbox.dk/subscription", "_blank");
        } else if (e?.response?.status === 429) {
          setMsg("Too many requests — please try again in a minute.");
        } else {
          setMsg(e?.response?.data?.detail || "Could not start checkout. Please try again.");
        }
      } finally {
        setPending(null);
      }
      return;
    }

    // Fallback — Stripe not configured yet. Use the waitlist flow so we still
    // capture intent. This is the temporary path until Stripe keys are live.
    if (joined.has(tierId)) {
      setMsg("You're already on the list — we'll be in touch when payment is ready.");
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
          ? "🎉 You're on the founding-member list — when payment opens, you'll lock in 99 kr/mo for as long as you stay subscribed."
          : `🎉 You're on the ${tierId} list — we'll email you when it opens.`
      );
      setTimeout(() => setMsg(""), 8000);
    } catch (e) {
      setMsg(
        e?.response?.status === 429
          ? "Too many requests — please try again in a minute."
          : "Couldn't add you to the list. Email hello@bonbox.dk if this keeps happening."
      );
      setTimeout(() => setMsg(""), 5000);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-10 pb-32 sm:pb-16 max-w-6xl mx-auto">
      {/* Trial status banner — only shown when trial is active */}
      {trialDaysLeft != null && trialDaysLeft > 0 && (
        <div className="mb-6 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
          <div className="text-3xl">⏳</div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Your free Pro trial ends in {trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"}.
            </div>
            <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              You're using all Pro features right now — AI insights, unlimited Copilot, full history,
              vertical modules. After the trial you can stay on Free (limited) or upgrade.
            </div>
          </div>
          <button
            onClick={() => handleCta("pro")}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg shadow-sm whitespace-nowrap"
          >
            Lock in 99 kr/mo
          </button>
        </div>
      )}

      {/* Hero */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-r from-purple-100 to-pink-100 dark:from-purple-900/30 dark:to-pink-900/30 border border-purple-200/60 dark:border-purple-700/40 text-xs font-semibold text-purple-700 dark:text-purple-300 mb-4">
          ✨ AI-first business platform
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white">
          AI that runs your business with you.
        </h1>
        <p className="text-sm sm:text-base text-gray-500 dark:text-gray-400 mt-3 max-w-2xl mx-auto">
          Every plan — even Free — includes the BonBox AI Copilot, predictive insights, anomaly
          detection, and receipt OCR. Pro removes the caps. Business spreads it across every branch.
          New signups get 14 days of fully-uncapped Pro, no card required.
        </p>
        <div className="mt-4 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
          🔥 First 1,000 customers lock in 99 kr/mo Pro for life
        </div>

        {/* Annual / monthly toggle */}
        <div className="inline-flex items-center bg-gray-100 dark:bg-gray-800 rounded-full p-1 mt-6">
          <button
            onClick={() => setAnnual(false)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${!annual ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
          >
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition relative ${annual ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
          >
            Annual
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
                  Most popular
                </div>
              )}
              {isCurrent && (
                <div className="absolute -top-3 right-4 bg-blue-600 text-white text-[10px] font-bold px-2.5 py-1 rounded-full shadow whitespace-nowrap">
                  {currentPlan === "trial" ? "Your trial" : "Current plan"}
                </div>
              )}

              <h3 className="text-xl font-bold text-gray-900 dark:text-white">{tier.name}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 min-h-[2.5em]">{tier.tagline}</p>

              <div className="mt-4 mb-1">
                {tier.custom ? (
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">Custom</div>
                ) : isFoundingPro ? (
                  <>
                    <div className="text-3xl font-bold text-gray-900 dark:text-white">
                      {tier.founding_price}
                      <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">kr/mo</span>
                    </div>
                    <div className="text-xs text-gray-400 line-through">{price} kr/mo regular</div>
                  </>
                ) : (
                  <div className="text-3xl font-bold text-gray-900 dark:text-white">
                    {price === 0 ? "Free" : `${price}`}
                    {price > 0 && <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">kr/mo</span>}
                  </div>
                )}
                {annual && price > 0 && !isFoundingPro && !tier.custom && (
                  <div className="text-[11px] text-green-600 dark:text-green-400">billed annually</div>
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
                    ? "On trial — full Pro features"
                    : "✓ Current plan"
                  : pending === tier.id
                    ? "Joining…"
                    : joined.has(tier.id) && tier.id !== "business"
                      ? "✓ On the list"
                      : cta}
              </button>

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

      {/* Reassurance row */}
      <div className="grid sm:grid-cols-4 gap-3 mt-10">
        <Reassure icon="🆓" title="No card for trial" sub="14 days of Pro, no payment info needed." />
        <Reassure icon="🇩🇰" title="Built in Denmark" sub="GDPR-first · EU-hosted · DKK + Moms native" />
        <Reassure icon="🤝" title="Cancel anytime" sub="No contracts. Export your data on the way out." />
        <Reassure icon="🌏" title="12 languages" sub="Dansk, English, नेपाली, اردو + 8 more" />
      </div>

      {/* FAQ */}
      <div className="mt-12 max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Common questions</h2>
        <div className="space-y-4">
          <FaqItem
            q="What happens when my 14-day trial ends?"
            a="You automatically drop to Free. Every feature stays — only the usage caps come back. Your data stays untouched (sales, expenses, history). You will NEVER be charged automatically. We don't even ask for a card during the trial."
          />
          <FaqItem
            q="Why does Free have every feature, just with caps?"
            a="Because feature-gating is a tax on small shops. A side-business owner shouldn't be locked out of AI insights just because they only do 50 sales a month — they need the insights MORE than a busy shop does. Caps mean Free users get full value, and only upgrade when they've actually outgrown what Free can support."
          />
          <FaqItem
            q="How does the founding-member price work?"
            a="The first 1,000 Pro subscribers lock in 99 kr/mo for as long as they stay subscribed — even when our regular Pro price moves to 249 kr/mo. Cancel and rejoin? You'd pay regular price. Stay subscribed continuously? You're locked in. That's a 60% discount, locked for life."
          />
          <FaqItem
            q="I run a chain with multiple branches — what fits?"
            a="The Business plan is built for multi-branch chains: group-level daily close consolidation, per-branch P&L, manager-scoped dashboards (so each location only sees its own numbers), centralised SOPs, and a custom integration path for your existing POS, payroll, and supplier systems. Pricing is custom because chain setups vary enormously — a 3-branch café group has very different needs than a 25-location restaurant chain. Click 'Talk to sales' on the Business card and we'll quote you within 1 business day."
          />
          <FaqItem
            q="Do I have to switch from Dinero / Billy / e-conomic?"
            a="No. BonBox sits ALONGSIDE your bookkeeping platform — keep using whichever one your accountant prefers. We even export clean CSVs to all three. We focus on the operational + AI layer that bookkeeping platforms don't build."
          />
          <FaqItem
            q="What about VAT (Moms)?"
            a="All prices shown are excl. moms. Danish businesses are invoiced with 25% Moms automatically. EU businesses with valid VAT numbers are reverse-charged."
          />
          <FaqItem
            q="Can I cancel anytime?"
            a="Yes. No contracts, no notice period. You'll keep access until the end of the current billing period and can export all your data at any time."
          />
          <FaqItem
            q="Is my data safe?"
            a="EU-hosted, encrypted at rest and in transit, GDPR-compliant, never sold, never shared with marketers, never used to train AI models. Full export and delete tools are built in."
          />
        </div>

        {/* Trademark notice */}
        <p className="mt-10 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed text-center">
          Dinero, Billy, e-conomic, MobilePay and Dankort are trademarks of their
          respective owners. BonBox is not affiliated with or endorsed by any of
          these companies. References are made for interoperability and
          comparative purposes under nominative fair use.
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
