import { Link } from "react-router-dom";

function Section({ title, children }) {
  return (
    <section>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-10 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Table({ headers, rows }) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>{headers.map((h, i) => <th key={i} className="text-left px-4 py-2.5 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
              {row.map((cell, j) => <td key={j} className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrivacyPolicyPage() {
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
            <Link to="/terms" className="text-gray-400 hover:text-white transition">Terms</Link>
            <Link to="/cookies" className="text-gray-400 hover:text-white transition">Cookies</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Privacy Policy</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Last updated: April 7, 2026</p>

        <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

          <Section title="Who we are">
            <p>
              BonBox is a free business analytics dashboard operated by Manoj Kumar Chaudhary, based in Copenhagen, Denmark.
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li><strong>Website:</strong> bonbox.dk</li>
              <li><strong>Contact email:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a></li>
              <li><strong>Location:</strong> Copenhagen, Denmark</li>
            </ul>
            <p className="mt-3">
              We process personal data in accordance with the EU General Data Protection Regulation (GDPR) and the Danish Data Protection Act (Databeskyttelsesloven, Act No. 502 of 23 May 2018).
            </p>
          </Section>

          <Section title="What data we collect and why">
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-4 mb-2">Account data</h3>
            <p>When you create a BonBox account, we collect:</p>
            <ul className="list-disc pl-6 space-y-1 mt-1">
              <li>Email address — to authenticate your account and send service-related communications</li>
              <li>Password — stored as a bcrypt hash (we never store your actual password)</li>
              <li>Name (optional) — to personalize your experience</li>
              <li>Preferred language — to display BonBox in your chosen language</li>
            </ul>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Performance of contract (GDPR Article 6(1)(b)).</p>

            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Business profile data</h3>
            <p>If you set up a business profile, we collect:</p>
            <ul className="list-disc pl-6 space-y-1 mt-1">
              <li>Business name, address, and registration number (e.g. CVR in Denmark)</li>
              <li>Industry type and company type</li>
              <li>Tax identification number (for Moms/VAT calculations)</li>
            </ul>
            <p className="mt-1">This data is entered by you or auto-filled from public government registers (such as CVR via cvrapi.dk). We only retrieve publicly available business information.</p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Performance of contract (GDPR Article 6(1)(b)).</p>

            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Financial data you enter</h3>
            <p>When you use BonBox, you may enter:</p>
            <ul className="list-disc pl-6 space-y-1 mt-1">
              <li>Daily sales and revenue figures</li>
              <li>Expense records with amounts, categories, and descriptions</li>
              <li>Inventory items and quantities</li>
              <li>Wage and staffing information</li>
              <li>Personal finance data (if using Personal Mode)</li>
            </ul>
            <p className="mt-1">This data is entered manually by you or imported via bank CSV files that you upload. We do not access your bank account directly.</p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Performance of contract (GDPR Article 6(1)(b)).</p>

            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Bank transaction data (CSV import)</h3>
            <p>If you upload a bank CSV file, we:</p>
            <ul className="list-disc pl-6 space-y-1 mt-1">
              <li>Parse the file to extract transaction date, description, and amount</li>
              <li>Auto-categorize transactions based on keywords</li>
              <li>Store the parsed transactions in your BonBox account</li>
              <li>Delete the original CSV file from our servers within 30 days of import</li>
            </ul>
            <p className="mt-1">We do not have access to your bank login credentials.</p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Consent (GDPR Article 6(1)(a)).</p>

            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Technical data</h3>
            <p>When you use bonbox.dk, we automatically collect:</p>
            <ul className="list-disc pl-6 space-y-1 mt-1">
              <li>IP address (anonymized after 30 days)</li>
              <li>Browser type and version</li>
              <li>Device type (desktop, mobile, tablet)</li>
              <li>Pages visited and time spent</li>
            </ul>
            <p className="mt-1">We do not use third-party tracking cookies. We do not use Google Analytics, Meta Pixel, or similar advertising trackers.</p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Legitimate interest (GDPR Article 6(1)(f)).</p>
          </Section>

          <Section title="What we do NOT collect">
            <ul className="list-disc pl-6 space-y-1">
              <li>We do not collect your CPR number (Danish personal ID)</li>
              <li>We do not collect biometric data</li>
              <li>We do not collect data from social media profiles</li>
              <li>We do not sell, rent, or share your data with third parties for marketing</li>
              <li>We do not use your data to train AI models</li>
              <li>We do not display advertising in BonBox</li>
            </ul>
          </Section>

          <Section title="Who has access to your data">
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-4 mb-2">Service providers (data processors)</h3>
            <Table
              headers={["Service", "Purpose", "Location", "Data processed"]}
              rows={[
                ["Supabase", "Database hosting (PostgreSQL)", "EU/US", "All account and business data"],
                ["Vercel", "Frontend hosting", "Global CDN", "No personal data stored"],
                ["Render", "Backend API hosting", "US/EU", "API requests, no persistent storage"],
                ["Resend", "Email delivery", "US", "Email address, email content"],
                ["cvrapi.dk", "Business registration lookup", "Denmark", "CVR numbers (public data)"],
              ]}
            />
            <p>We do not share your financial data with any third party. Your data stays in our database and is only accessible to you.</p>

            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Law enforcement</h3>
            <p>We may disclose personal data if required by Danish or EU law, or in response to a valid legal request from a Danish court or the Danish Data Protection Agency (Datatilsynet).</p>
          </Section>

          <Section title="How long we keep your data">
            <Table
              headers={["Data type", "Retention period"]}
              rows={[
                ["Account data", "Until you delete your account"],
                ["Business profile", "Until you delete your account"],
                ["Financial data (sales, expenses)", "Until you delete your account"],
                ["Bank CSV files (raw)", "Deleted within 30 days of import"],
                ["Parsed bank transactions", "Until you delete your account"],
                ["Technical/access logs", "30 days"],
                ["Email communication logs", "90 days"],
              ]}
            />
            <p>When you delete your account, all your personal and financial data is permanently deleted within 30 days. Backups are purged within 90 days.</p>
          </Section>

          <Section title="Your rights under GDPR">
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Right of access (Article 15):</strong> Request a copy of all data we hold about you.</li>
              <li><strong>Right to rectification (Article 16):</strong> Correct inaccurate data at any time in your settings.</li>
              <li><strong>Right to erasure (Article 17):</strong> Delete your account and all data from your settings. Deleted within 30 days.</li>
              <li><strong>Right to data portability (Article 20):</strong> Export all your data as CSV files from BonBox.</li>
              <li><strong>Right to restrict processing (Article 18):</strong> Request we stop processing while a complaint is resolved.</li>
              <li><strong>Right to object (Article 21):</strong> Object to processing based on legitimate interest.</li>
              <li><strong>Right to withdraw consent:</strong> Withdraw consent at any time without affecting prior processing.</li>
            </ul>
            <p className="mt-3">To exercise any of these rights, contact us at <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>. We will respond within 30 days.</p>
          </Section>

          <Section title="Data security">
            <ul className="list-disc pl-6 space-y-1">
              <li>All data in transit is encrypted via HTTPS/TLS</li>
              <li>Passwords are hashed using bcrypt (never stored in plain text)</li>
              <li>Database access is restricted by Row Level Security (RLS) — each user can only access their own data</li>
              <li>API endpoints require JWT authentication</li>
              <li>Bank CSV files are processed in memory and deleted after import</li>
              <li>We do not store bank login credentials under any circumstances</li>
            </ul>
          </Section>

          <Section title="International data transfers">
            <p>
              Some of our service providers may process data outside the EU/EEA. Where this occurs, we ensure appropriate safeguards are in place, including Standard Contractual Clauses (SCCs) approved by the European Commission.
            </p>
          </Section>

          <Section title="Children">
            <p>BonBox is a business tool and is not intended for use by individuals under 18 years of age. We do not knowingly collect data from children.</p>
          </Section>

          <Section title="Changes to this policy">
            <p>We may update this privacy policy from time to time. When we do, we will update the date at the top. For significant changes, we will notify you via email or through a notice in BonBox.</p>
          </Section>

          <Section title="Complaints">
            <p>If you believe we have not handled your personal data correctly, you have the right to lodge a complaint with:</p>
            <div className="mt-2 bg-gray-50 dark:bg-gray-800 rounded-lg p-4 text-sm">
              <p className="font-semibold text-gray-800 dark:text-gray-200">Datatilsynet</p>
              <p>Carl Jacobsens Vej 35</p>
              <p>DK-2500 Valby, Denmark</p>
              <p>Website: <a href="https://www.datatilsynet.dk" className="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">www.datatilsynet.dk</a></p>
              <p>Email: <a href="mailto:dt@datatilsynet.dk" className="text-blue-600 dark:text-blue-400 hover:underline">dt@datatilsynet.dk</a></p>
            </div>
          </Section>

          <Section title="Contact us">
            <p>For any questions about this privacy policy or your personal data:</p>
            <p className="mt-2">
              <strong>Email:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
              <strong>Website:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
            </p>
          </Section>
        </div>

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium">&larr; Back to BonBox</Link>
          <div className="flex gap-4 text-sm text-gray-400">
            <Link to="/terms" className="hover:text-gray-600 dark:hover:text-gray-300 transition">Terms</Link>
            <Link to="/cookies" className="hover:text-gray-600 dark:hover:text-gray-300 transition">Cookies</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
