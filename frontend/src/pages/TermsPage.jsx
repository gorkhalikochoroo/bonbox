import { Link } from "react-router-dom";

function Section({ num, title, children }) {
  return (
    <section>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-10 mb-3">{num}. {title}</h2>
      {children}
    </section>
  );
}

export default function TermsPage() {
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
            <Link to="/cookies" className="text-gray-400 hover:text-white transition">Cookies</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Terms of Service</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Last updated: April 7, 2026</p>

        <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

          <Section num={1} title="About BonBox">
            <p>
              BonBox is a free business analytics dashboard that helps small business owners track daily sales, expenses, inventory, and financial performance. BonBox is operated by Manoj Kumar Chaudhary, based in Copenhagen, Denmark.
            </p>
            <p className="mt-2">By creating an account or using BonBox, you agree to these terms.</p>
          </Section>

          <Section num={2} title="What BonBox is — and what it is not">
            <p className="font-semibold mb-2">BonBox is:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>A daily business overview and analytics dashboard</li>
              <li>A tool for tracking sales, expenses, inventory, waste, and cash flow</li>
              <li>A generator of reports including Kasserapport and financial summaries</li>
              <li>A personal finance tracker (in Personal Mode)</li>
            </ul>
            <p className="font-semibold mt-4 mb-2">BonBox is NOT:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Accounting software as defined under Danish Bogf&oslash;ringsloven (the Bookkeeping Act)</li>
              <li>A certified bookkeeping system</li>
              <li>A tax advisory or tax filing service</li>
              <li>A payment processor — BonBox does not move, hold, or transfer money</li>
              <li>A replacement for professional accounting, legal, or financial advice</li>
            </ul>
          </Section>

          <Section num={3} title="Your account">
            <p>
              You are responsible for maintaining the confidentiality of your login credentials. You are responsible for all activity under your account. You must provide accurate information when creating your account. You may only create one account per person.
            </p>
            <p className="mt-2">We reserve the right to suspend or delete accounts that violate these terms or that remain inactive for more than 24 months.</p>
          </Section>

          <Section num={4} title="Your data">
            <p>All financial data you enter into BonBox belongs to you. We do not claim ownership of your data.</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>You can export your data at any time as CSV files</li>
              <li>You can delete your account and all data at any time</li>
              <li>See our <Link to="/privacy" className="text-blue-600 dark:text-blue-400 hover:underline">Privacy Policy</Link> for full details on data handling</li>
            </ul>
          </Section>

          <Section num={5} title="Financial reports and disclaimers">
            <p>BonBox generates reports including daily summaries, Kasserapport, Moms/VAT estimates, and weekly reports. These reports are for your internal business use only.</p>
            <div className="mt-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-3 text-sm">
              <p><strong>Kasserapport and financial summaries</strong> generated by BonBox are tools to help you organize your records. They are not certified accounting documents. Always have your accountant verify important financial records.</p>
              <p><strong>Moms/VAT calculations</strong> in BonBox are estimates based on the data you enter. They are not official tax filings. You are responsible for filing accurate VAT returns with SKAT or the relevant tax authority. Consult your accountant or tax advisor for official tax matters.</p>
              <p><strong>Revenue forecasts and Business Health Scores</strong> are estimates based on your historical data. They are not guarantees of future performance.</p>
              <p><strong>BonBox is not liable</strong> for financial losses, tax penalties, or business decisions made based on data or reports generated by BonBox. The accuracy of outputs depends entirely on the accuracy of the data you provide.</p>
            </div>
          </Section>

          <Section num={6} title="Bank data import">
            <p>When you upload a bank CSV file or connect your bank via Open Banking:</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>You confirm that you are authorized to access and share the bank account data</li>
              <li>BonBox reads transaction data in read-only mode — we cannot initiate payments or transfers</li>
              <li>Auto-categorization of transactions is a suggestion that may not always be accurate — always review imported transactions</li>
              <li>You can delete all imported bank data at any time</li>
            </ul>
          </Section>

          <Section num={7} title="Business registration lookup">
            <p>When you use the business registration lookup feature:</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>BonBox retrieves publicly available business information from government registers (CVR in Denmark, Companies House in UK, etc.)</li>
              <li>This data is publicly available by law and is not confidential</li>
              <li>You are responsible for verifying that auto-filled information is correct</li>
              <li>BonBox is not responsible for inaccuracies in government register data</li>
            </ul>
          </Section>

          <Section num={8} title="Free service">
            <p>BonBox is currently provided free of charge. We reserve the right to:</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>Introduce paid plans or premium features in the future</li>
              <li>Change, limit, or discontinue features with reasonable notice</li>
              <li>Set usage limits if necessary to maintain service quality</li>
            </ul>
            <p className="mt-2">If we introduce paid features, existing free functionality will remain available. We will not retroactively charge for features you already use for free.</p>
          </Section>

          <Section num={9} title="Acceptable use">
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>Use BonBox for any illegal purpose</li>
              <li>Attempt to access other users' data</li>
              <li>Upload malicious files or attempt to compromise BonBox's security</li>
              <li>Use automated tools to scrape or overload BonBox's servers</li>
              <li>Misrepresent BonBox reports as certified accounting documents</li>
              <li>Resell or redistribute BonBox's service without permission</li>
            </ul>
          </Section>

          <Section num={10} title="Availability and support">
            <p>
              BonBox is provided "as is" and "as available." We strive for high availability but do not guarantee uninterrupted service. We provide support via email (<a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>) on a best-effort basis.
            </p>
          </Section>

          <Section num={11} title="Limitation of liability">
            <p>To the maximum extent permitted by Danish and EU law:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>BonBox is provided without warranties of any kind, whether express or implied</li>
              <li>We are not liable for any direct, indirect, incidental, or consequential damages arising from your use of BonBox</li>
              <li>We are not liable for financial losses, missed tax deadlines, incorrect tax calculations, or business decisions based on BonBox data</li>
              <li>Our total liability shall not exceed the amount you have paid us in the 12 months prior to the claim</li>
            </ul>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">This limitation does not exclude liability for fraud, gross negligence, or anything that cannot be excluded under Danish law.</p>
          </Section>

          <Section num={12} title="Governing law and disputes">
            <p>
              These terms are governed by Danish law. Any disputes shall be subject to the exclusive jurisdiction of the courts of Copenhagen, Denmark.
            </p>
            <p className="mt-2">Before initiating legal proceedings, we encourage you to contact us at <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a> so we can try to resolve the issue directly.</p>
          </Section>

          <Section num={13} title="Trademarks and third-party names">
            <p>
              "BonBox" and the BonBox logo are trademarks of Manoj Kumar Chaudhary.
            </p>
            <p className="mt-3">
              All other product, service, and company names referenced in BonBox or in
              our marketing materials — including but not limited to{" "}
              <strong>Dinero</strong>, <strong>Billy</strong>, <strong>e-conomic</strong>,{" "}
              <strong>Visma</strong>, <strong>Saldi</strong>, <strong>Uniconta</strong>,{" "}
              <strong>MobilePay</strong>, <strong>Dankort</strong>, <strong>Apple</strong>,{" "}
              <strong>App Store</strong>, <strong>Google Play</strong>, <strong>Anthropic</strong>{" "}
              and <strong>Claude</strong> — are trademarks or registered trademarks of their
              respective owners. References to these names are made only:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>To describe interoperability (e.g. "exports to Dinero CSV format")</li>
              <li>For comparative or factual reference under nominative fair use</li>
              <li>To accurately disclose third-party services we use (Anthropic for AI, Apple for iOS, etc.)</li>
            </ul>
            <p className="mt-3">
              Use of these names does not imply any endorsement, sponsorship, partnership,
              or affiliation between the trademark owner and BonBox. BonBox is operated
              independently and is <strong>not</strong> affiliated with or endorsed by any
              of the parties listed above.
            </p>
            <p className="mt-3">
              Comparative or competitive statements made by BonBox in marketing are
              based on publicly available information and the operator's good-faith
              judgement at the time of publication. If a statement appears inaccurate,
              please contact us at <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a> and we will review it promptly.
            </p>
          </Section>

          <Section num={14} title="Changes to these terms">
            <p>
              We may update these terms from time to time. When we make significant changes, we will notify you via email or through a notice in BonBox at least 14 days before the changes take effect. Continued use after the effective date constitutes acceptance.
            </p>
          </Section>

          <Section num={15} title="Contact">
            <p>For questions about these terms:</p>
            <p className="mt-2">
              <strong>Email:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
              <strong>Website:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
            </p>
          </Section>
        </div>

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium">&larr; Back to BonBox</Link>
          <div className="flex gap-4 text-sm text-gray-400">
            <Link to="/privacy" className="hover:text-gray-600 dark:hover:text-gray-300 transition">Privacy</Link>
            <Link to="/cookies" className="hover:text-gray-600 dark:hover:text-gray-300 transition">Cookies</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
