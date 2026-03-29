import { Link } from "react-router-dom";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
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
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <h1 className="text-3xl font-extrabold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-gray-500 text-sm mb-8">Last updated: March 29, 2026</p>

        <div className="prose prose-gray max-w-none space-y-6 text-gray-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">1. Introduction</h2>
            <p>
              BonBox ("we", "our", "us") is a free business dashboard application operated by
              Manoj Chaudhary. This Privacy Policy explains how we collect, use, and protect
              your information when you use our web application and mobile app (collectively, the "Service").
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">2. Information We Collect</h2>
            <p className="font-semibold mb-2">Account Information:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Name, email address, and password (hashed) when you register</li>
              <li>Business name and preferred currency</li>
            </ul>
            <p className="font-semibold mt-4 mb-2">Business Data:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Sales records, expenses, inventory items, and staff schedules you enter</li>
              <li>Receipt photos you upload for OCR scanning</li>
              <li>Khata (credit book) entries and loan records</li>
            </ul>
            <p className="font-semibold mt-4 mb-2">Technical Data:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Device type and browser information</li>
              <li>Anonymous usage analytics to improve the Service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">3. How We Use Your Information</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>To provide and maintain the Service</li>
              <li>To process receipt images using third-party OCR services (OCR.space, Google Cloud Vision)</li>
              <li>To send transactional emails (welcome email, password reset codes)</li>
              <li>To generate business reports and analytics for your account</li>
              <li>To improve the Service based on anonymous usage patterns</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">4. Data Storage and Security</h2>
            <p>
              Your data is stored securely on cloud servers (Render, Supabase). Passwords are
              hashed using bcrypt. All data transmission is encrypted via HTTPS/TLS.
              Receipt images are stored in Supabase Storage with access controls.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">5. Third-Party Services</h2>
            <p>We use the following third-party services:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Supabase</strong> — database and file storage</li>
              <li><strong>Render</strong> — backend hosting</li>
              <li><strong>Vercel</strong> — frontend hosting</li>
              <li><strong>OCR.space / Google Cloud Vision</strong> — receipt text extraction</li>
              <li><strong>Resend</strong> — transactional emails</li>
            </ul>
            <p className="mt-2">
              These services have their own privacy policies. We do not sell or share your
              personal data with third parties for marketing purposes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">6. Data Retention</h2>
            <p>
              Your data is retained as long as your account is active. You can delete your
              account and all associated data at any time by contacting us. Deleted data is
              moved to a recovery period of 30 days before permanent deletion.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">7. Your Rights</h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Access the personal data we hold about you</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Export your data</li>
              <li>Withdraw consent at any time</li>
            </ul>
            <p className="mt-2">
              If you are in the EU/EEA, you have additional rights under GDPR. Contact us to exercise any of these rights.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">8. Children's Privacy</h2>
            <p>
              BonBox is not intended for children under 13. We do not knowingly collect
              personal information from children under 13.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">9. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. Changes will be posted on
              this page with an updated revision date.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">10. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy, contact us at:
            </p>
            <p className="mt-2">
              <strong>Manoj Chaudhary</strong><br />
              Email: <a href="mailto:contact@bonbox.dk" className="text-blue-600 hover:underline">contact@bonbox.dk</a><br />
              Website: <a href="https://bonbox.dk" className="text-blue-600 hover:underline">bonbox.dk</a>
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-gray-200 text-center">
          <Link to="/" className="text-blue-600 hover:underline text-sm font-medium">
            &larr; Back to BonBox
          </Link>
        </div>
      </div>
    </div>
  );
}
