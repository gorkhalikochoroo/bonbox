import { Link } from "react-router-dom";

export default function CookiePolicyPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      <nav className="bg-slate-950 border-b border-white/5">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-10 h-10 bg-white/10 rounded-xl">
              <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2" />
                <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M4 20h20" stroke="#FCD34D" strokeWidth="2" />
              </svg>
            </div>
            <span className="text-xl font-bold text-white tracking-tight">BonBox</span>
          </Link>
          <div className="flex gap-4 text-sm">
            <Link to="/privacy" className="text-gray-400 hover:text-white transition">Privacy</Link>
            <Link to="/terms" className="text-gray-400 hover:text-white transition">Terms</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Cookie Policy</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Last updated: April 7, 2026</p>

        <div className="prose prose-gray dark:prose-invert max-w-none space-y-6 text-gray-700 dark:text-gray-300 leading-relaxed">

          <section>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">What are cookies?</h2>
            <p>Cookies are small text files stored on your device when you visit a website. They help the website remember your preferences and keep you logged in.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Cookies we use</h2>
            <p>BonBox uses only essential cookies that are strictly necessary for the service to function. We do not use advertising, tracking, or analytics cookies from third parties.</p>

            <div className="overflow-x-auto my-4">
              <table className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">Cookie</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">Purpose</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">Type</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["session_token", "Keeps you logged in", "Essential", "Until logout or 30 days"],
                    ["language_pref", "Remembers your language choice", "Essential", "1 year"],
                    ["theme_pref", "Remembers dark/light mode", "Essential", "1 year"],
                    ["csrf_token", "Protects against cross-site request forgery", "Essential", "Session"],
                  ].map(([cookie, purpose, type, duration], i) => (
                    <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-800 dark:text-gray-200">{cookie}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{purpose}</td>
                      <td className="px-4 py-2.5"><span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium rounded-full">{type}</span></td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{duration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">What we do NOT use</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>No Google Analytics cookies</li>
              <li>No Meta/Facebook Pixel</li>
              <li>No advertising or retargeting cookies</li>
              <li>No third-party tracking cookies of any kind</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Your choices</h2>
            <p>
              Since we only use essential cookies required for BonBox to function, we do not display a cookie consent banner. Under GDPR and the ePrivacy Directive, strictly necessary cookies do not require consent.
            </p>
            <p className="mt-2">
              You can delete cookies at any time through your browser settings. Note that deleting the session cookie will log you out of BonBox.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Contact</h2>
            <p>If you have questions about our use of cookies:</p>
            <p className="mt-2">
              <strong>Email:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
              <strong>Website:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium">&larr; Back to BonBox</Link>
          <div className="flex gap-4 text-sm text-gray-400">
            <Link to="/privacy" className="hover:text-gray-600 dark:hover:text-gray-300 transition">Privacy</Link>
            <Link to="/terms" className="hover:text-gray-600 dark:hover:text-gray-300 transition">Terms</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
