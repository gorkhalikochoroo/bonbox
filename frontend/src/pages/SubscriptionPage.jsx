import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { trackEvent } from "../hooks/useEventLog";

/**
 * BonBox subscription tiers — public pricing page.
 *
 * Today, every user is on Free. This page exists to:
 *   1. Show that BonBox has a real business model (legitimacy signal for
 *      reviewers, partners, journalists)
 *   2. Plant intent for paid features without blocking free use
 *   3. Capture interest in the "founding member" Pro tier — first 100 users
 *      lock in 149kr/mo instead of 249kr/mo as a thank-you
 *
 * No payment processing wired yet — "Upgrade" buttons currently capture
 * interest via email. Wire Stripe / MobilePay later.
 */

const TIERS = [
  {
    id: "free",
    name: "Free",
    tagline: "Try everything. No credit card.",
    price_monthly: 0,
    price_annual: 0,
    cta: "You're here",
    highlight: false,
    features: [
      { text: "1 business, 1 user", included: true },
      { text: "30-day history", included: true },
      { text: "Daily Close + Cash Book", included: true },
      { text: "10 OCR receipt scans / month", included: true },
      { text: "Web + iOS + Android", included: true },
      { text: "12 languages", included: true },
      { text: "AI Copilot (basic)", included: true },
      { text: "AI pattern insights", included: false },
      { text: "Bank import", included: false },
      { text: "Multi-user / role permissions", included: false },
    ],
  },
  {
    id: "starter",
    name: "Starter",
    tagline: "For solo shops & side businesses.",
    price_monthly: 89,
    price_annual: 79,
    cta: "Coming soon",
    highlight: false,
    features: [
      { text: "1 business, 2 users", included: true },
      { text: "Full history (unlimited)", included: true },
      { text: "All bookkeeping-adjacent modules", included: true },
      { text: "Unlimited OCR scans", included: true },
      { text: "Bank import (Dinero / e-conomic export)", included: true },
      { text: "Email support", included: true },
      { text: "AI pattern insights", included: false },
      { text: "Vertical modules (Bar Pour, etc.)", included: false },
      { text: "Multi-business", included: false },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "AI-powered analytics for SMEs with staff.",
    price_monthly: 249,
    price_annual: 199,
    founding_price: 149,
    cta: "Join founding members",
    highlight: true,
    badge: "🏆 First 100 users — 149 kr/mo for life",
    features: [
      { text: "Up to 3 businesses, 5 users with roles", included: true },
      { text: "Full AI Pattern Engine — anomalies, routines, dormant features", included: true },
      { text: "Smart Staffing — weather + event predictions", included: true },
      { text: "Price Optimization (per-product elasticity)", included: true },
      { text: "Customer Retention (churn prediction)", included: true },
      { text: "Business Health Score", included: true },
      { text: "Competitor scan", included: true },
      { text: "Vertical modules (Bar Pour, Workshop Manager, etc.)", included: true },
      { text: "Dinero / Billy export", included: true },
      { text: "Priority support", included: true },
    ],
  },
  {
    id: "business",
    name: "Business",
    tagline: "Multi-branch chains.",
    price_monthly: 599,
    price_annual: 499,
    cta: "Talk to sales",
    highlight: false,
    features: [
      { text: "Unlimited businesses + multi-branch consolidation", included: true },
      { text: "Unlimited users", included: true },
      { text: "API access", included: true },
      { text: "Dedicated onboarding", included: true },
      { text: "Custom integrations", included: true },
      { text: "SLA + priority support", included: true },
    ],
  },
];

export default function SubscriptionPage() {
  const { user } = useAuth();
  const [annual, setAnnual] = useState(false);

  const handleCta = (tierId) => {
    trackEvent("pricing_cta_clicked", "subscription", tierId);
    if (tierId === "free") return;
    // No payment processing yet — capture interest via email link
    const subject = encodeURIComponent(`Founding member: ${tierId}`);
    const body = encodeURIComponent(
      `Hi,\n\nI'd like to upgrade my BonBox account (${user?.email || "(your email)"}) to the ${tierId} tier.\n\nThanks!`
    );
    window.location.href = `mailto:hello@bonbox.dk?subject=${subject}&body=${body}`;
  };

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-10 max-w-6xl mx-auto">
      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white">
          Simple pricing. Built for SMEs.
        </h1>
        <p className="text-sm sm:text-base text-gray-500 dark:text-gray-400 mt-3 max-w-2xl mx-auto">
          BonBox sits alongside your bookkeeping (Dinero, Billy, e-conomic) — it doesn't replace it.
          Pay only for the operational + AI layer that bookkeeping platforms structurally don't build.
        </p>

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

      {/* Tiers */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {TIERS.map((tier) => {
          const price = annual ? tier.price_annual : tier.price_monthly;
          const isFoundingPro = tier.id === "pro" && tier.founding_price;
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

              <h3 className="text-xl font-bold text-gray-900 dark:text-white">{tier.name}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 min-h-[2.5em]">{tier.tagline}</p>

              <div className="mt-4 mb-1">
                {isFoundingPro ? (
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
                {annual && price > 0 && !isFoundingPro && (
                  <div className="text-[11px] text-green-600 dark:text-green-400">billed annually</div>
                )}
              </div>

              {tier.badge && (
                <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-md px-2 py-1 mt-1 mb-3">
                  {tier.badge}
                </div>
              )}

              <button
                onClick={() => handleCta(tier.id)}
                disabled={tier.id === "free"}
                className={`w-full py-2 rounded-lg text-sm font-medium transition mt-3 mb-4
                  ${tier.id === "free"
                    ? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-default"
                    : tier.highlight
                      ? "bg-green-600 hover:bg-green-700 text-white shadow-sm"
                      : "bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"}`}
              >
                {tier.cta}
              </button>

              <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                {tier.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {f.included ? (
                      <span className="text-green-500 dark:text-green-400 shrink-0 mt-0.5">✓</span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600 shrink-0 mt-0.5">—</span>
                    )}
                    <span className={f.included ? "" : "text-gray-400 dark:text-gray-500"}>{f.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Reassurance row */}
      <div className="grid sm:grid-cols-3 gap-3 mt-10">
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 text-center">
          <div className="text-2xl mb-1">🇩🇰</div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">Built in Denmark</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">GDPR-first · EU-hosted · DKK + Moms native</div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 text-center">
          <div className="text-2xl mb-1">🤝</div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">Cancel any time</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">No contracts. Export your data on the way out.</div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 text-center">
          <div className="text-2xl mb-1">🌏</div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">12 languages</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Dansk, English, नेपाली, اردو, عربي + 7 more</div>
        </div>
      </div>

      {/* FAQ */}
      <div className="mt-12 max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">FAQ</h2>
        <div className="space-y-4">
          <FaqItem
            q="Do I have to switch from Dinero / Billy / e-conomic?"
            a="No. BonBox is a complement, not a replacement. Keep your bookkeeping platform — BonBox adds the operational and AI layer your bookkeeper doesn't build."
          />
          <FaqItem
            q="How does the founding-member price work?"
            a="The first 100 Pro subscribers lock in 149 kr/mo for life — even when our regular Pro price moves to 249 kr/mo. It's our way of saying thank you for being early."
          />
          <FaqItem
            q="What about VAT (Moms)?"
            a="All prices shown are excl. moms. We invoice Danish businesses with 25% Moms automatically. EU businesses with a valid VAT number are reverse-charged."
          />
          <FaqItem
            q="Can I cancel anytime?"
            a="Yes. No contracts, no notice period. You'll keep access until the end of your current billing period and can export all your data on the way out."
          />
          <FaqItem
            q="Is my data safe?"
            a="Yes. EU-hosted, encrypted at rest and in transit, GDPR-compliant, never sold or shared. You own your data — full export and delete tools are built in."
          />
        </div>

        {/* Trademark notice — referenced platform names belong to their owners */}
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
