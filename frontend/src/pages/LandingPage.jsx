import { useState } from "react";
import { Link } from "react-router-dom";

const features = [
  {
    title: "Sales + Expenses + Cash Flow",
    description: "Log sales, track expenses, see cash flow — all auto-synced. No double entry.",
    icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  },
  {
    title: "Inventory & Waste Tracking",
    description: "Stock levels, low-stock alerts, waste logs. Know what you have and what you lose.",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
  },
  {
    title: "Staff Scheduling",
    description: "AI-powered scheduling based on your busiest days. Right people, right time.",
    icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
  },
  {
    title: "WhatsApp Bot",
    description: "Text 'sale 450' to log a sale. Text 'balance' to check cash flow. From the app you already use.",
    icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
  },
  {
    title: "Khata (Credit Book)",
    description: "Track who owes what. Partial payments, customer balances — the way you already do business.",
    icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
  },
  {
    title: "Personal Finance Mode",
    description: "Switch to personal mode. Track income, spending, budgets, loans — separately from business.",
    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  },
  {
    title: "VAT Reports & PDF Export",
    description: "Auto VAT calculation for your country. Professional PDF reports ready for tax time.",
    icon: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
  {
    title: "12 Currencies, 10+ Languages",
    description: "DKK, NPR, INR, USD, EUR and more. VAT terms adapt to your country automatically.",
    icon: "M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  {
    title: "Voice-Powered Entry",
    description: "Say '5000 cash' and it logs instantly. No typing, no friction.",
    icon: "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z",
  },
];

const steps = [
  { number: "1", title: "Sign up in 30 seconds", subtitle: "Name + email. That's it." },
  { number: "2", title: "Log your first sale", subtitle: "Tap, type, or speak" },
  { number: "3", title: "See your business clearly", subtitle: "Dashboard lights up instantly" },
];

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="bg-gradient-to-r from-blue-900 to-blue-700">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-10 h-10 bg-white/10 rounded-xl">
              <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M4 20h20" stroke="#FCD34D" strokeWidth="2" />
              </svg>
            </div>
            <span className="text-xl font-bold text-white">BonBox</span>
          </div>
          <div className="hidden sm:flex items-center gap-3">
            <Link to="/login" className="px-4 py-2 text-sm font-medium text-blue-100 hover:text-white transition">
              Sign In
            </Link>
            <Link to="/register" className="px-4 py-2 text-sm font-medium bg-white text-blue-700 rounded-lg hover:bg-blue-50 transition">
              Get Started
            </Link>
          </div>
          <button onClick={() => setMenuOpen(!menuOpen)} className="sm:hidden text-white p-2">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
        {menuOpen && (
          <div className="sm:hidden px-4 pb-4 space-y-2">
            <Link to="/login" className="block w-full text-center px-4 py-3 text-sm font-medium text-white border border-white/30 rounded-lg">Sign In</Link>
            <Link to="/register" className="block w-full text-center px-4 py-3 text-sm font-medium bg-white text-blue-700 rounded-lg">Get Started</Link>
          </div>
        )}
      </nav>

      {/* Hero */}
      <section className="bg-gradient-to-br from-blue-900 to-blue-700 text-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20 md:py-28 text-center">
          <p className="inline-flex items-center gap-2 px-5 py-2 bg-white/10 backdrop-blur-sm rounded-full text-sm font-medium text-white mb-6 border border-white/20">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            Not another accounting tool
          </p>
          <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold leading-tight">
            Stop guessing.
            <br />
            <span className="text-yellow-300">Start knowing.</span>
          </h1>
          <p className="mt-6 text-lg md:text-xl text-blue-100 max-w-2xl mx-auto">
            Sales, expenses, inventory, staff, cash flow, and WhatsApp — all in one free dashboard. Built for shop owners, not accountants.
          </p>
          <div className="mt-4 flex items-center justify-center gap-6 text-sm text-blue-200">
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              100% free
            </span>
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              No credit card
            </span>
            <span className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              Works on any phone
            </span>
          </div>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/register" className="w-full sm:w-auto px-8 py-3.5 bg-white text-blue-700 font-semibold rounded-lg hover:bg-blue-50 transition shadow-lg shadow-blue-900/30 text-center">
              Get Started — It's Free
            </Link>
            <Link to="/login" className="w-full sm:w-auto px-8 py-3.5 border-2 border-white/30 text-white font-semibold rounded-lg hover:bg-white/10 transition text-center">
              Sign In
            </Link>
          </div>

          {/* Dashboard Preview */}
          <div className="mt-14 max-w-4xl mx-auto">
            <div className="bg-gray-900 rounded-xl border border-gray-700 shadow-2xl shadow-black/40 p-4 sm:p-6 text-left">
              {/* Top bar */}
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-white text-sm font-semibold">Welcome, Your Shop</p>
                  <p className="text-gray-500 text-xs">Tuesday, 24 March 2026</p>
                </div>
                <div className="hidden sm:flex gap-2">
                  <span className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg font-medium">+ Quick Sale</span>
                  <span className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-lg">PDF Report</span>
                </div>
              </div>
              {/* KPI Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-4">
                <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
                  <p className="text-gray-500 text-xs">Revenue</p>
                  <p className="text-white text-lg font-bold">24,500</p>
                  <p className="text-green-400 text-xs">+12% vs yesterday</p>
                </div>
                <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
                  <p className="text-gray-500 text-xs">Profit</p>
                  <p className="text-white text-lg font-bold">70,097</p>
                  <p className="text-gray-500 text-xs">57.8% margin</p>
                </div>
                <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
                  <p className="text-gray-500 text-xs">Top Expense</p>
                  <p className="text-white text-lg font-bold">Wages</p>
                  <p className="text-gray-500 text-xs">17,500</p>
                </div>
                <div className="bg-gray-800 p-3 rounded-lg border border-red-800/50">
                  <p className="text-gray-500 text-xs">Khata Receivable</p>
                  <p className="text-red-400 text-lg font-bold">40,000</p>
                  <p className="text-gray-500 text-xs">Outstanding credit</p>
                </div>
              </div>
              {/* Health Score */}
              <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 flex items-center gap-6">
                <div className="text-center flex-shrink-0">
                  <div className="w-14 h-14 rounded-full border-4 border-green-500 flex items-center justify-center">
                    <span className="text-green-400 font-bold text-lg">64</span>
                  </div>
                  <p className="text-gray-500 text-xs mt-1">Health</p>
                </div>
                <div className="flex-1 space-y-2 hidden sm:block">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs w-24">Profitability</span>
                    <div className="flex-1 h-1.5 bg-gray-700 rounded-full"><div className="h-full bg-yellow-500 rounded-full" style={{width: "75%"}} /></div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs w-24">Consistency</span>
                    <div className="flex-1 h-1.5 bg-gray-700 rounded-full"><div className="h-full bg-yellow-500 rounded-full" style={{width: "95%"}} /></div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs w-24">Cost Control</span>
                    <div className="flex-1 h-1.5 bg-gray-700 rounded-full"><div className="h-full bg-yellow-500 rounded-full" style={{width: "60%"}} /></div>
                  </div>
                </div>
              </div>
            </div>
            <p className="text-blue-300/60 text-xs mt-3">This is what your dashboard looks like</p>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-16 sm:py-20 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
              Everything you need to run your shop
            </h2>
            <p className="mt-4 text-gray-500 text-lg max-w-xl mx-auto">
              Built for the kiosk owner, the grillbar chef, the corner shop
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <div key={feature.title} className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:shadow-md hover:border-blue-200 transition">
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={feature.icon} />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{feature.title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-16 sm:py-20 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
              Up and running in 60 seconds
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-3xl mx-auto">
            {steps.map((step) => (
              <div key={step.number} className="text-center">
                <div className="w-14 h-14 bg-blue-600 text-white rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-4">
                  {step.number}
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">{step.title}</h3>
                <p className="text-gray-500 text-sm">{step.subtitle}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Built for real businesses */}
      <section className="py-16 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 text-center">
          <p className="text-gray-400 text-sm font-medium uppercase tracking-wider mb-3">Built for</p>
          <p className="text-gray-700 text-lg font-medium">
            Shops, restaurants, cafes, salons, food trucks, and freelancers
          </p>
          <div className="flex flex-wrap justify-center gap-3 mt-5">
            {["Denmark", "Nepal", "India"].map((c) => (
              <span key={c} className="px-3 py-1.5 bg-gray-100 text-gray-600 text-sm rounded-full">{c}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-16 sm:py-20 bg-gradient-to-br from-blue-900 to-blue-700 text-white text-center">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Your business deserves better than guesswork
          </h2>
          <p className="text-blue-200 text-lg mb-8">
            Join BonBox and see your business clearly — sales, stock, staff, cash, all in one place.
          </p>
          <Link to="/register" className="inline-block px-10 py-4 bg-white text-blue-700 font-bold rounded-lg hover:bg-blue-50 transition shadow-lg shadow-blue-900/30 text-lg">
            Get Started Free
          </Link>
          <p className="mt-4 text-blue-300 text-sm">No credit card. No monthly fees. No catch.</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 bg-gray-900 text-center">
        <p className="text-gray-400 text-sm">
          Built by Manoj Chaudhary | MSc Data-Driven Business Development, SDU
        </p>
        <Link to="/contact" className="inline-block mt-3 text-blue-400 text-sm hover:text-blue-300 transition">
          Contact
        </Link>
      </footer>
    </div>
  );
}
