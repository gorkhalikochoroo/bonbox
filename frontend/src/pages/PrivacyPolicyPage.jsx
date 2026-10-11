import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { CookieSettingsButton } from "../components/CookieConsent";
// The "Last updated" date is PRIVACY_UPDATED (src/legal/terms.js). Push 3
// changed /privacy with the Terms (then it was TERMS_VERSION); a later push
// changes it on its own (the backup processor row + R-h's Analytics-consent
// sentences), so it has its own release-time date there, never earlier than
// TERMS_VERSION.
import { PRIVACY_UPDATED, termsDate } from "../legal/terms";
import BonBoxMark from "../components/BonBoxMark";

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

// The page chrome around the document (nav + footer). The legal text itself is
// NOT split into dictionary keys: each language is one whole document below
// (PrivacyEn / PrivacyDa), so a reviewer can read — and a lawyer can approve —
// each version top to bottom. Keep the two in step: same sections, same order,
// same links. If you change one, change the other in the same commit.
// cookieSettings reopens the consent banner's drawer (CookieSettingsButton) —
// the footer link the drawer itself points to.
//
// Push 3 (11 Oct 2026): retention and deletion say what the code does and
// what Terms of Service § 4 says (immediate deletion; change log, security
// and error logs and the accounting-document images kept; no retention
// setting; the owner, not BonBox, keeps the accounting records). A processor
// location is named only where it is confirmed (Supabase: Ireland, project
// in eu-west-1; Render: Frankfurt; Companies House: UK); every other row
// says "Not confirmed" / "Ikke bekræftet".
// Nightly backup (Manoj, 11 Oct 2026): the second Supabase row is the
// separate backup project (eu-central-1, Frankfurt) that the nightly job
// (backend services/backup_service) copies the database and the uploaded
// files to, encrypted on our server before upload.
const CHROME = {
  en: { terms: "Terms", cookies: "Cookies", cookieSettings: "Cookie settings", back: "Back to BonBox" },
  da: { terms: "Vilkår", cookies: "Cookies", cookieSettings: "Cookieindstillinger", back: "Tilbage til BonBox" },
};

function PrivacyEn() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Privacy Policy</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8" data-testid="privacy-updated">Last updated: {termsDate(PRIVACY_UPDATED, "en")}</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section title="Who we are">
          <p>
            BonBox is a product of <strong>DukaanAI v/Manoz Chaudhary</strong>, registered in Denmark
            as a Personligt ejet Mindre Virksomhed. That business is the data controller for the data
            about you and your BonBox account described on this page.
          </p>
          <p className="mt-2" data-testid="privacy-processor-role">
            For the data a business puts into BonBox about its guests, customers and staff (for example
            reservations, khata customers and staff details), that business is the data controller, and
            we process the data on its behalf as its data processor.
          </p>
          {/* Clock-in location (brand release, 11 Oct 2026). True to the code:
              StaffPortalPage useClock reads the position only on clock-IN and
              only when geofence_on (enabled + a venue location set); the server
              (staff_portal.portal_clock_in) only computes the distance and
              stores no coordinates — HoursLogged.notes gets "Location
              unverified" when there is no usable fix, which the owner sees as
              the "Location not verified" chip. Keep in step with the Danish. */}
          <p className="mt-2" data-testid="privacy-clock-in-location">
            Location at clock-in: the BonBox Vagtplan app (and the staff page in a browser) reads the phone&rsquo;s location only when a staff member clocks in at a workplace that has turned on the location check; BonBox uses the coordinates only to check the distance to the workplace and does not save them, and the business sees only a &ldquo;Location not verified&rdquo; mark on a clock-in made without a usable location.
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Registered name:</strong> DukaanAI v/Manoz Chaudhary</li>
            <li><strong>CVR:</strong> <a href="https://datacvr.virk.dk/enhed/virksomhed/46417321" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">46417321</a> — you can check us in the public register</li>
            <li><strong>Website:</strong> bonbox.dk</li>
            <li><strong>Contact email:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a></li>
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
            <li>Campaign code from a printed flyer, if any — the short code (for example <code>r1-a-03</code>) from the QR on a BonBox flyer you signed up from. It is kept with your account so BonBox can count, per printed code (one code is one visit), how many accounts were created and how far they got in BonBox: e-mail confirmed, setup finished, first daily close, staff link made and opened, active in the last 7 days. We note which venue we left each flyer at, so the numbers for one code show how far that venue's account got. Only the founder sees them. The code itself is never used to contact you, is never shared, and is included in your data export. It is deleted 12 months after you create your account, or earlier if you delete your account. If you ask for an e-mail sign-in link, the code is added to that link, so an account created from it can carry it. On your device it is kept for up to 30 days, and only if you allow Marketing in the cookie banner (see the <Link to="/cookies" className="text-blue-600 dark:text-blue-400 hover:underline">Cookie Policy</Link>). Legal basis for this one item: our legitimate interest in knowing which visits work (GDPR Article 6(1)(f)).</li>
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
            <li>Do not save the original CSV file: it is read in memory during the import and then discarded</li>
          </ul>
          <p className="mt-1">We do not have access to your bank login credentials.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Consent (GDPR Article 6(1)(a)).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Technical data</h3>
          <p>When you use bonbox.dk, we automatically collect:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>IP address — kept in our error log for 30 days, and in the change log and the security log with no end date (see &ldquo;How long we keep your data&rdquo;)</li>
            <li>Browser type and version</li>
            <li>Device type (desktop, mobile, tablet)</li>
            <li data-testid="privacy-last-seen">When your account was last used — one timestamp. Our server records it when you sign in and updates it at most once every 5 minutes while you use BonBox, also when Analytics is off or paused. Each new value replaces the old one. It is used for support and to see which accounts are in use; only the founder sees it, in BonBox&rsquo;s admin view. It is kept until you delete your account. It is included in the account owner&rsquo;s data export; team members and revisors can ask for theirs at <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>.</li>
          </ul>
          <p className="mt-1">We do not use third-party tracking cookies. We do not use Google Analytics, Meta Pixel, or similar advertising trackers.</p>
          <p className="mt-1" data-testid="privacy-own-settings">Settings you choose yourself in BonBox (for example light/dark theme and dismissed tips) are stored on your device because they are necessary for what you asked BonBox to do. They are not used for anything else (see the <Link to="/cookies" className="text-blue-600 dark:text-blue-400 hover:underline">Cookie Policy</Link>).</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Legitimate interest (GDPR Article 6(1)(f)).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Product analytics events</h3>
          <p>To improve BonBox and detect anomalies in your business, we record events about how you use the app:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>Pages you visit and time spent on each</li>
            <li>Actions you take (sale logged, receipt scanned, AI question asked, daily close completed, login/logout)</li>
            <li>For the BonBox AI Copilot: that you asked a question — not the question itself</li>
            <li>Token usage of AI Copilot conversations (metadata only — used for cost monitoring, not content)</li>
          </ul>
          <p className="mt-1" data-testid="privacy-analytics-consent">The events your browser sends (pages you visit and actions you take) are recorded only after you turn on Analytics in the cookie banner.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            <strong>You can pause analytics at any time</strong> in <Link to="/profile" className="text-blue-600 dark:text-blue-400 hover:underline">Profile → Privacy & Data</Link>. When paused, no new events are recorded for your account, except the record of each AI chat turn, Smart Sale Entry and upgrade checkout that BonBox needs to enforce your plan's limits.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            <strong>Retention:</strong> Product analytics events are automatically deleted after 180 days. Aggregated counts may be retained longer in anonymised form for product improvement.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="privacy-analytics-basis"><strong>Legal basis:</strong> For the events your browser sends: consent (GDPR Article 6(1)(a)), which you give by turning on Analytics in the cookie banner and can withdraw at any time under &ldquo;Cookie settings&rdquo;. For the records our server writes itself (AI token usage, the business-type guess during setup, and the record of each AI chat turn, Smart Sale Entry and upgrade checkout described above): legitimate interest (GDPR Article 6(1)(f)) — improving BonBox and detecting business anomalies for your benefit.</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Derived insights (AI patterns)</h3>
          <p>BonBox computes pattern-recognition insights about your business from your data. Examples:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>"You close every Sunday around 22:00" (from event timestamps)</li>
            <li>"Today's revenue is below your usual Tuesday" (from sales aggregates)</li>
            <li>"Wage cost is above your trailing 4-week average" (from expense + sales data)</li>
          </ul>
          <p className="mt-1">These insights are computed on our servers, stored in your account and shown in BonBox to you and to the people you give access to. They are part of what the Copilot and the daily brief send to Anthropic (see below). We do <strong>not</strong> train external AI models on your data.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Performance of contract (GDPR Article 6(1)(b)).</p>
        </Section>

        <Section title="What we do NOT collect">
          <ul className="list-disc pl-6 space-y-1">
            <li>We do not collect your CPR number (Danish personal ID)</li>
            <li>We do not collect biometric data</li>
            <li>We do not collect data from social media profiles</li>
            <li>We do not sell, rent, or share your data with third parties for marketing</li>
            <li>We do not train external AI models on your data, and our AI provider (Anthropic) does not train on data sent through their API</li>
            <li>We do not display advertising in BonBox</li>
          </ul>
        </Section>

        <Section title="AI Copilot and your data">
          <p>BonBox includes an AI assistant ("BonBox AI Copilot") powered by Anthropic's Claude API. When you chat with the Copilot:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li data-testid="privacy-copilot-sends">Your message, the earlier messages in the same conversation (up to 10) and the data from your account that the answer needs are sent to Anthropic's API to generate a reply. That data is your business name and type, figures (for example revenue, expenses, stock, waste, credit (khata) and the cash book), the names of your products, khata customers and staff, staff roles and shifts, the pages you use most and recent insights. We never send the phone numbers or e-mail addresses stored in your account.</li>
            <li>Anthropic processes the data on its servers (we have not confirmed where; see the table below) and keeps it only as long as Anthropic's commercial terms and privacy policy allow (link below). Per Anthropic's commercial terms, they do <strong>not</strong> train their models on data sent through their API.</li>
            <li>We record that you asked a question and how many tokens the reply used — not the text of your question. Until mid-July 2026 we also saved the first 200 characters of each question; those are deleted 180 days after they were asked.</li>
            <li>You can disable AI Copilot interactions by simply not using it — the rest of BonBox works without it.</li>
          </ul>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Performance of contract (GDPR Article 6(1)(b)) — providing the Copilot feature you requested.</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400"><strong>Anthropic's privacy policy:</strong> <a href="https://www.anthropic.com/privacy" className="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">anthropic.com/privacy</a></p>
        </Section>

        <Section title="Who has access to your data">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-4 mb-2">Service providers (data processors)</h3>
          <Table
            headers={["Service", "Purpose", "Location", "Data processed"]}
            rows={[
              ["Supabase", "Database (PostgreSQL) and file storage", "EU (Ireland)", "All account and business data, and the files you upload"],
              ["Supabase", "Encrypted backup copy (database + the files you upload)", "EU (Germany, Frankfurt)", "All account and business data and the files you upload, encrypted before they leave BonBox"],
              ["Vercel", "Frontend hosting", "Global CDN", "No personal data stored"],
              ["Render", "Backend API hosting", "EU (Frankfurt, Germany)", "API requests, no persistent storage"],
              ["Resend", "Email delivery", "Not confirmed", "Email address, email content"],
              ["Postmark", "Receiving the e-mails you forward to your BonBox receipt address (when switched on)", "Not confirmed", "The forwarded e-mail and its attachments"],
              ["Anthropic (Claude API)", "Reading receipts and documents, AI Copilot replies, the daily brief and other AI features", "Not confirmed", "Photos of receipts, kasserapporter and other documents you upload. For the AI Copilot: your messages and the data from your account the answer needs (figures, the names of products, khata customers and staff, staff roles and shifts), never the phone numbers or e-mail addresses stored in your account. For the daily brief: figures, item names, the names of khata customers who haven't been back for a while, your business name and type, the pages you use most and recent insights — never phone numbers or e-mail addresses. For other AI features: the figures, item names, text or photos the feature works on. Not used for training; kept only as long as Anthropic's terms allow"],
              ["Google Cloud Vision", "Reading text from receipt photos (when enabled)", "Not confirmed", "Photos of receipts you upload"],
              ["OCR.space", "Reading text from receipt photos (when enabled)", "Not confirmed", "Photos of receipts you upload"],
              ["Stripe", "Subscription payments", "Not confirmed", "Billing email and business name, your BonBox account id, plan, business type and the Terms version you accepted, subscription status; card details go straight to Stripe and never reach our servers. When you delete your account: if there are no invoices for you at Stripe, we also delete your customer record at Stripe; if there are, we keep the customer record at Stripe for 5 years from the end of the financial year, because we must keep our own accounting records, and then delete it. The issued invoices stay at Stripe, which does not allow an issued invoice to be deleted"],
              ["cvrapi.dk", "Business registration lookup", "Not confirmed", "CVR numbers (public data)"],
              ["Companies House", "Business registration lookup for UK companies (when used)", "United Kingdom", "The company name or number you search (public data)"],
              ["Mindee", "Reading receipts and invoices (when enabled)", "Not confirmed", "Photos of receipts and invoices you upload"],
              ["Cloudflare", "Network security and routing in front of our servers", "Global", "IP address and request data, in transit only"],
              ["GatewayAPI", "SMS reminders to guests (when a venue turns them on)", "Not confirmed", "Guest phone number, message text"],
              ["Twilio", "SMS/WhatsApp messages (when enabled)", "Not confirmed", "Phone number, message text"],
              ["Apple Push Notification service", "Notifications to the BonBox iPhone apps", "Not confirmed", "A device token and the notification text"],
              ["Web push (Google, Apple, Mozilla)", "Browser notifications you switch on", "Not confirmed", "A push subscription and the notification text"],
              ["Google / Apple sign-in", "Signing in with your Google or Apple account (if you choose to)", "Not confirmed", "Your email address and name from that account"],
              ["Google Places", "Looking up nearby businesses in the competitor view (when used)", "Not confirmed", "The area and business type you search for"],
              ["Sentry", "Error reports from our servers (when enabled)", "Not confirmed", "Technical error details, sent without IP addresses or cookies"],
              ["Slack", "Alerting us to urgent support requests", "Not confirmed", "The request's subject and your account email"],
              ["Simply.com", "Our e-mail inbox for contact@bonbox.dk", "Not confirmed", "The e-mails you send us"],
            ]}
          />
          <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="privacy-location-note">
            &ldquo;Not confirmed&rdquo; means we have not yet confirmed where that provider processes the data. It may be outside the EU/EEA (see &ldquo;International data transfers&rdquo;).
          </p>
          <p>
            We do not sell your data, and we do not share it for advertising. Your books stay in our
            database. In BonBox, you see them, and so do the team members and the revisor you give
            access to, as far as their access allows. To give you the AI features (the Copilot, the
            daily brief and reading receipts) we send data to Anthropic as described above, and to read
            a receipt we may send the photo to another OCR provider on the list. Those providers process
            the data on our instructions. Anthropic does not train its models on it (Anthropic&rsquo;s
            commercial terms).
          </p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Law enforcement</h3>
          <p>We may disclose personal data if required by Danish or EU law, or in response to a valid legal request from a Danish court or the Danish Data Protection Agency (Datatilsynet).</p>
        </Section>

        <Section title="How long we keep your data">
          <Table
            headers={["Data type", "Retention period"]}
            rows={[
              ["Account data", "Until you delete your account"],
              ["When your account was last used (one timestamp, replaced each time)", "Until you delete your account"],
              ["Campaign code from a printed flyer (on the account)", "Deleted 12 months after you create your account, or earlier if you delete your account"],
              ["Business profile (incl. logo)", "Until you delete your account"],
              ["Financial data (sales, expenses, inventory)", "Until you delete your account"],
              ["Images of accounting documents you upload (kasserapport photos, receipt and sales photos, stock import files)", "Until you delete your account, then about 6 years after the deletion; then deleted"],
              ["Fakturaer + customer records", "Until you delete your account. Draft invoices that were never sent are deleted about 6 years after their date"],
              ["Mileage / kørselsgodtgørelse log", "Deleted about 6 years after the trip date (entries linked to an invoice: until you delete your account), and at the latest when you delete your account"],
              ["Change log (every mark-paid / void / brand change), incl. your IP address", "No end date: it cannot be edited or deleted through BonBox, and it is kept when you delete your account"],
              ["Payment-match suggestions (pending)", "Until accepted/rejected by you"],
              ["Payment-match suggestions (resolved)", "1 year after resolution"],
              ["Bank CSV files (raw)", "Not saved: read in memory during the import"],
              ["Parsed bank transactions", "Until you delete your account (they are saved as sales and expenses)"],
              ["Product analytics events", "180 days (auto-purged daily)"],
              ["AI insights derived from events", "Until you delete your account; expired and dismissed insights stay in your insights archive"],
              ["AI Copilot questions", "Only the fact that a question was asked is recorded: 180 days, like other analytics events. Question texts saved until mid-July 2026 (first 200 characters) are deleted 180 days after they were asked"],
              ["Error log (technical errors, incl. IP address)", "30 days, also after you delete your account"],
              ["Security log (sign-ups we block or flag, e-mail sign-in links, admin access attempts and admin actions, changes to subscriptions and trials, plan limits and locked features you run into, and price lookups; some of them with IP address)", "No end date; kept when you delete your account"],
              ["Email communication logs", "Until you delete your account"],
              ["Payment records at Stripe (the customer record and the invoices)", "No invoices for you at Stripe: the customer record is deleted when you delete your account. With invoices: the customer record is kept for 5 years from the end of the financial year, because we must keep our own accounting records; then it is deleted. The issued invoices stay at Stripe, which does not allow an issued invoice to be deleted"],
              ["Backups of our database", "Copies disappear when those backups expire"],
            ]}
          />
          <p className="mt-3"><strong>Your accounting records:</strong> Under the Danish Bookkeeping Act it is you — not BonBox — who must keep your business&rsquo;s accounting records, as a rule for 5 years from the end of the financial year they relate to. BonBox is not a registered bookkeeping system and is not an archive you can rely on for that duty (see <Link to="/terms" className="text-blue-600 dark:text-blue-400 hover:underline">Terms of Service</Link> &sect;4). Download your data and the PDFs you need before you delete your account. There is no setting in BonBox that changes how long we keep data.</p>
          <p className="mt-3"><strong>Change log:</strong> Every time you mark an invoice paid, void it, upload a logo, or change brand settings, we write a row to a change log capturing the action, the time, your IP address and the state before and after. The log cannot be edited or deleted through BonBox — neither by you nor by us — and we have set no end date for it.</p>
          <p className="mt-3" data-testid="privacy-deletion">When you delete your account, we delete the account and the data in it straight away. We keep the change log, the security and error logs, and the images of accounting documents you uploaded (kasserapport photos, receipt and sales photos, and stock import files); we keep those images for about 6 years after the deletion and then delete them. If there are no invoices for you at Stripe, we also delete your customer record at Stripe. If there are, we keep the customer record at Stripe for 5 years from the end of the financial year, because we must keep our own accounting records; then we delete it. The issued invoices stay at Stripe, which does not allow an issued invoice to be deleted. Copies in our backups disappear when those backups expire.</p>
        </Section>

        <Section title="Your rights under GDPR">
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Right of access (Article 15):</strong> Request a copy of all data we hold about you.</li>
            <li><strong>Right to rectification (Article 16):</strong> Correct inaccurate data at any time in your settings.</li>
            <li><strong>Right to erasure (Article 17):</strong> Delete your account under Profile. We delete the account and the data in it straight away, including staff photos and documents, chat photos and your logo. We keep the change log, the security and error logs, the images of accounting documents you uploaded (about 6 years) and, if there are invoices for you, the customer record at Stripe (5 years from the end of the financial year) and the invoices, which stay at Stripe — see &ldquo;How long we keep your data&rdquo;.</li>
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
            <li>Every request is limited to your own business in our server code, and the database cannot be reached directly from outside (row-level security denies it)</li>
            <li>API endpoints require JWT authentication</li>
            <li>Bank CSV files are read in memory during the import and are not saved</li>
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
    </>
  );
}

function PrivacyDa() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Privatlivspolitik</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8" data-testid="privacy-updated">Senest opdateret: {termsDate(PRIVACY_UPDATED, "da")}</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section title="Hvem vi er">
          <p>
            BonBox er et produkt fra <strong>DukaanAI v/Manoz Chaudhary</strong>, der er registreret i Danmark
            som Personligt ejet Mindre Virksomhed. Denne virksomhed er dataansvarlig for de oplysninger om
            dig og din BonBox-konto, der er beskrevet på denne side.
          </p>
          <p className="mt-2" data-testid="privacy-processor-role">
            For de oplysninger, en virksomhed lægger ind i BonBox om sine gæster, kunder og medarbejdere
            (fx reservationer, khata-kunder og medarbejderoplysninger), er det den virksomhed, der er
            dataansvarlig, og vi behandler oplysningerne på dens vegne som dens databehandler.
          </p>
          <p className="mt-2" data-testid="privacy-clock-in-location">
            Placering ved indstempling: Appen BonBox Vagtplan (og personalesiden i en browser) læser kun telefonens placering, når en medarbejder stempler ind på en arbejdsplads, der har slået placeringstjek til; BonBox bruger kun koordinaterne til at tjekke afstanden til arbejdspladsen og gemmer dem ikke, og virksomheden ser kun mærket »Placering ikke verificeret« ved en indstempling uden en brugbar placering.
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Registreret navn:</strong> DukaanAI v/Manoz Chaudhary</li>
            <li><strong>CVR:</strong> <a href="https://datacvr.virk.dk/enhed/virksomhed/46417321" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">46417321</a> — du kan slå os op i det offentlige register</li>
            <li><strong>Hjemmeside:</strong> bonbox.dk</li>
            <li><strong>Kontakt-e-mail:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a></li>
          </ul>
          <p className="mt-3">
            Vi behandler personoplysninger i overensstemmelse med EU's databeskyttelsesforordning (GDPR) og databeskyttelsesloven (lov nr. 502 af 23. maj 2018).
          </p>
        </Section>

        <Section title="Hvilke oplysninger vi indsamler, og hvorfor">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-4 mb-2">Kontooplysninger</h3>
          <p>Når du opretter en BonBox-konto, indsamler vi:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>E-mailadresse — til at autentificere din konto og sende dig servicerelaterede meddelelser</li>
            <li>Adgangskode — gemt som en bcrypt-hash (vi gemmer aldrig selve din adgangskode)</li>
            <li>Navn (valgfrit) — for at gøre din oplevelse personlig</li>
            <li>Foretrukket sprog — for at vise BonBox på det sprog, du har valgt</li>
            <li>Kampagnekode fra en trykt folder, hvis der er en — den korte kode (fx <code>r1-a-03</code>) fra QR-koden på en BonBox-folder, som du brugte, da du oprettede din konto. Den gemmes sammen med din konto, så BonBox kan tælle, pr. trykt kode (én kode er ét besøg), hvor mange konti der blev oprettet, og hvor langt de er nået i BonBox: e-mail bekræftet, opsætning færdig, første daglige lukning (kasserapport), medarbejderlink lavet og åbnet, aktiv inden for de seneste 7 dage. Vi noterer, hvilket sted vi har afleveret hver folder, så tallene for én kode viser, hvor langt det steds konto er nået. Kun stifteren ser dem. Selve koden bruges aldrig til at kontakte dig, deles aldrig med andre og er med i din dataeksport. Den slettes 12 måneder efter, at du har oprettet din konto, eller tidligere, hvis du sletter kontoen. Beder du om et login-link på e-mail, sættes koden på linket, så en konto, der oprettes fra det, kan få den med. På din enhed gemmes den i op til 30 dage, og kun hvis du tillader Markedsføring i cookiebanneret (se <Link to="/cookies" className="text-blue-600 dark:text-blue-400 hover:underline">cookiepolitikken</Link>). Retsgrundlag for netop dette punkt: vores legitime interesse i at vide, hvilke besøg der virker (databeskyttelsesforordningens artikel 6, stk. 1, litra f).</li>
          </ul>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Opfyldelse af kontrakt (databeskyttelsesforordningens artikel 6, stk. 1, litra b).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Oplysninger i virksomhedsprofilen</h3>
          <p>Hvis du opretter en virksomhedsprofil, indsamler vi:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>Virksomhedens navn, adresse og registreringsnummer (f.eks. CVR-nummer i Danmark)</li>
            <li>Branche og virksomhedsform</li>
            <li>Skatteidentifikationsnummer (til MOMS-beregninger)</li>
          </ul>
          <p className="mt-1">Oplysningerne indtastes af dig eller udfyldes automatisk fra offentlige myndighedsregistre (f.eks. CVR via cvrapi.dk). Vi henter kun offentligt tilgængelige virksomhedsoplysninger.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Opfyldelse af kontrakt (databeskyttelsesforordningens artikel 6, stk. 1, litra b).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Økonomiske data, som du indtaster</h3>
          <p>Når du bruger BonBox, kan du indtaste:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>Tal for dagligt salg og omsætning</li>
            <li>Udgiftsposter med beløb, kategorier og beskrivelser</li>
            <li>Lagervarer og antal</li>
            <li>Oplysninger om løn og bemanding</li>
            <li>Private økonomiske data (hvis du bruger personlig tilstand)</li>
          </ul>
          <p className="mt-1">Disse data indtaster du selv, eller de importeres fra bank-CSV-filer, som du uploader. Vi har ikke direkte adgang til din bankkonto.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Opfyldelse af kontrakt (databeskyttelsesforordningens artikel 6, stk. 1, litra b).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Banktransaktioner (CSV-import)</h3>
          <p>Hvis du uploader en CSV-fil fra din bank, vil vi:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>Læse filen og udtrække transaktionsdato, beskrivelse og beløb</li>
            <li>Kategorisere transaktionerne automatisk ud fra nøgleord</li>
            <li>Gemme de indlæste transaktioner på din BonBox-konto</li>
            <li>Ikke gemme den oprindelige CSV-fil: den læses i hukommelsen under importen og kasseres derefter</li>
          </ul>
          <p className="mt-1">Vi har ikke adgang til dine loginoplysninger til banken.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Samtykke (databeskyttelsesforordningens artikel 6, stk. 1, litra a).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Tekniske data</h3>
          <p>Når du bruger bonbox.dk, indsamler vi automatisk:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>IP-adresse — den gemmes i vores fejllog i 30 dage og i ændringsloggen og sikkerhedsloggen uden en slutdato (se »Hvor længe vi opbevarer dine data«)</li>
            <li>Browsertype og -version</li>
            <li>Enhedstype (computer, mobil, tablet)</li>
            <li data-testid="privacy-last-seen">Hvornår din konto sidst blev brugt — ét tidspunkt. Vores server registrerer det, når du logger ind, og opdaterer det højst én gang hvert 5. minut, mens du bruger BonBox, også når Analyse er slået fra eller sat på pause. Hver ny værdi erstatter den gamle. Det bruges til support og til at se, hvilke konti der er i brug; kun stifteren ser det, i BonBox&rsquo; administrationsvisning. Det opbevares, indtil du sletter din konto. Det er med i kontoejerens dataeksport; teammedlemmer og revisorer kan bede om deres på <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>.</li>
          </ul>
          <p className="mt-1">Vi bruger ikke sporingscookies fra tredjeparter. Vi bruger ikke Google Analytics, Meta Pixel eller lignende sporingsværktøjer til annoncering.</p>
          <p className="mt-1" data-testid="privacy-own-settings">Indstillinger, du selv vælger i BonBox (fx lyst/mørkt tema og tip, du har lukket), gemmes på din enhed, fordi de er nødvendige for det, du har bedt BonBox om. De bruges ikke til andet (se <Link to="/cookies" className="text-blue-600 dark:text-blue-400 hover:underline">cookiepolitikken</Link>).</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Legitim interesse (databeskyttelsesforordningens artikel 6, stk. 1, litra f).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Hændelser til produktanalyse</h3>
          <p>For at forbedre BonBox og opdage uregelmæssigheder i din virksomhed registrerer vi hændelser om, hvordan du bruger appen:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>Hvilke sider du besøger, og hvor lang tid du bruger på hver af dem</li>
            <li>Handlinger, du foretager (salg registreret, kvittering scannet, spørgsmål stillet til AI, kasserapport afsluttet, login/logout)</li>
            <li>For BonBox AI Copilot: at du har stillet et spørgsmål — ikke selve spørgsmålet</li>
            <li>Tokenforbrug i samtaler med AI Copilot (kun metadata — bruges til at overvåge omkostninger, ikke indhold)</li>
          </ul>
          <p className="mt-1" data-testid="privacy-analytics-consent">De hændelser, din browser sender (hvilke sider du besøger, og hvilke handlinger du foretager), registreres først, når du har slået Analyse til i cookiebanneret.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            <strong>Du kan til enhver tid sætte analysen på pause</strong> under <Link to="/profile" className="text-blue-600 dark:text-blue-400 hover:underline">Profil → Privatliv & data</Link>. Mens den er sat på pause, registreres der ingen nye hændelser for din konto, bortset fra registreringen af hver AI-chatbesked, hver Smart salgsindtastning og hver påbegyndt betaling for en opgradering, som BonBox skal bruge for at håndhæve grænserne i din plan.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            <strong>Opbevaring:</strong> Hændelser til produktanalyse slettes automatisk efter 180 dage. Samlede optællinger kan opbevares længere i anonymiseret form med henblik på at forbedre produktet.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="privacy-analytics-basis"><strong>Retsgrundlag:</strong> For de hændelser, din browser sender: samtykke (databeskyttelsesforordningens artikel 6, stk. 1, litra a), som du giver ved at slå Analyse til i cookiebanneret, og som du til enhver tid kan trække tilbage under &bdquo;Cookieindstillinger&ldquo;. For det, vores server selv registrerer (tokenforbrug i AI, gættet på virksomhedstype under opsætningen og registreringen af hver AI-chatbesked, hver Smart salgsindtastning og hver påbegyndt betaling for en opgradering, som nævnt ovenfor): legitim interesse (databeskyttelsesforordningens artikel 6, stk. 1, litra f) — at forbedre BonBox og opdage uregelmæssigheder i din virksomhed til din fordel.</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Afledte indsigter (AI-mønstre)</h3>
          <p>BonBox beregner indsigter om din virksomhed ud fra dine data ved hjælp af mønstergenkendelse. Eksempler:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>»Du lukker hver søndag omkring kl. 22:00« (ud fra hændelsernes tidsstempler)</li>
            <li>»Dagens omsætning er under din normale tirsdag« (ud fra samlede salgstal)</li>
            <li>»Lønomkostningerne ligger over dit gennemsnit for de seneste 4 uger« (ud fra udgifts- og salgsdata)</li>
          </ul>
          <p className="mt-1">Indsigterne beregnes på vores servere, gemmes på din konto og vises i BonBox for dig og for dem, du giver adgang. De er en del af det, Copilot og morgenbriefen sender til Anthropic (se nedenfor). Vi træner <strong>ikke</strong> eksterne AI-modeller på dine data.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Opfyldelse af kontrakt (databeskyttelsesforordningens artikel 6, stk. 1, litra b).</p>
        </Section>

        <Section title="Hvad vi IKKE indsamler">
          <ul className="list-disc pl-6 space-y-1">
            <li>Vi indsamler ikke dit CPR-nummer (personnummer)</li>
            <li>Vi indsamler ikke biometriske data</li>
            <li>Vi indsamler ikke data fra profiler på sociale medier</li>
            <li>Vi hverken sælger, udlejer eller deler dine data med tredjeparter til markedsføring</li>
            <li>Vi træner ikke eksterne AI-modeller på dine data, og vores AI-leverandør (Anthropic) træner ikke på data, der sendes via deres API</li>
            <li>Vi viser ikke reklamer i BonBox</li>
          </ul>
        </Section>

        <Section title="AI Copilot og dine data">
          <p>BonBox indeholder en AI-assistent (»BonBox AI Copilot«), som drives af Anthropics Claude API. Når du chatter med Copilot:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li data-testid="privacy-copilot-sends">Din besked, de tidligere beskeder i samme samtale (op til 10) og de data fra din konto, som svaret kræver, sendes til Anthropics API for at generere et svar. Det er din virksomheds navn og type, tal (fx omsætning, udgifter, lager, spild, kredit (khata) og kassebog), navnene på dine varer, khata-kunder og medarbejdere, medarbejdernes roller og vagter, de sider, du bruger mest, og seneste indsigter. Vi sender aldrig de telefonnumre eller e-mailadresser, der er gemt på din konto.</li>
            <li>Anthropic behandler dataene på sine servere (vi har ikke bekræftet hvor; se tabellen nedenfor) og opbevarer dem kun så længe, som Anthropics kommercielle vilkår og privatlivspolitik tillader (link nedenfor). Ifølge Anthropics kommercielle vilkår træner de <strong>ikke</strong> deres modeller på data, der sendes via deres API.</li>
            <li>Vi registrerer, at du har stillet et spørgsmål, og hvor mange tokens svaret brugte — ikke selve teksten i dit spørgsmål. Indtil midten af juli 2026 gemte vi også de første 200 tegn af hvert spørgsmål; de slettes 180 dage efter, at de blev stillet.</li>
            <li>Du kan fravælge AI Copilot ved simpelthen ikke at bruge den — resten af BonBox fungerer uden den.</li>
          </ul>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Opfyldelse af kontrakt (databeskyttelsesforordningens artikel 6, stk. 1, litra b) — levering af den Copilot-funktion, du har bedt om.</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400"><strong>Anthropics privatlivspolitik:</strong> <a href="https://www.anthropic.com/privacy" className="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">anthropic.com/privacy</a></p>
        </Section>

        <Section title="Hvem har adgang til dine data">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-4 mb-2">Tjenesteudbydere (databehandlere)</h3>
          <Table
            headers={["Tjeneste", "Formål", "Placering", "Behandlede data"]}
            rows={[
              ["Supabase", "Database (PostgreSQL) og fillagring", "EU (Irland)", "Alle konto- og virksomhedsdata og de filer, du uploader"],
              ["Supabase", "Krypteret sikkerhedskopi (database + de filer, du uploader)", "EU (Tyskland, Frankfurt)", "Alle konto- og virksomhedsdata og de filer, du uploader, krypteret før de forlader BonBox"],
              ["Vercel", "Hosting af frontend", "Globalt CDN", "Ingen personoplysninger gemmes"],
              ["Render", "Hosting af backend-API", "EU (Frankfurt, Tyskland)", "API-forespørgsler, ingen varig lagring"],
              ["Resend", "Afsendelse af e-mails", "Ikke bekræftet", "E-mailadresse, e-mailens indhold"],
              ["Postmark", "Modtagelse af de e-mails, du videresender til din BonBox-kvitteringsadresse (når den er slået til)", "Ikke bekræftet", "Den videresendte e-mail og dens vedhæftede filer"],
              ["Anthropic (Claude API)", "Aflæsning af kvitteringer og dokumenter, svar fra AI Copilot, morgenbriefen og andre AI-funktioner", "Ikke bekræftet", "Billeder af kvitteringer, kasserapporter og andre dokumenter, du uploader. For AI Copilot: dine beskeder og de data fra din konto, som svaret kræver (tal, navnene på varer, khata-kunder og medarbejdere, medarbejdernes roller og vagter), aldrig de telefonnumre eller e-mailadresser, der er gemt på din konto. For morgenbriefen: tal, varenavne, navnene på khata-kunder, der ikke har været forbi i et stykke tid, din virksomheds navn og type, de sider, du bruger mest, og seneste indsigter — aldrig telefonnumre eller e-mailadresser. For andre AI-funktioner: de tal, varenavne, tekster eller billeder, funktionen arbejder med. Bruges ikke til træning; opbevares kun så længe, som Anthropics vilkår tillader"],
              ["Google Cloud Vision", "Aflæsning af tekst fra kvitteringsbilleder (når funktionen er slået til)", "Ikke bekræftet", "Billeder af kvitteringer, du uploader"],
              ["OCR.space", "Aflæsning af tekst fra kvitteringsbilleder (når funktionen er slået til)", "Ikke bekræftet", "Billeder af kvitteringer, du uploader"],
              ["Stripe", "Betaling af abonnementer", "Ikke bekræftet", "E-mail og virksomhedsnavn til fakturering, dit BonBox-konto-id, plan, virksomhedstype og den version af Handelsbetingelserne, du har accepteret, abonnementsstatus; kortoplysninger går direkte til Stripe og når aldrig vores servere. Når du sletter din konto: Er der ingen fakturaer til dig hos Stripe, sletter vi også dine kundeoplysninger hos Stripe; er der fakturaer, beholder vi kundeoplysningerne hos Stripe i 5 år fra udgangen af regnskabsåret, fordi vi skal opbevare vores egne regnskabsbilag, og sletter derefter kundeoplysningerne. De udstedte fakturaer bliver hos Stripe, som ikke tillader, at en udstedt faktura slettes"],
              ["cvrapi.dk", "Opslag i virksomhedsregistret", "Ikke bekræftet", "CVR-numre (offentlige data)"],
              ["Companies House", "Opslag af britiske virksomheder (når det bruges)", "Storbritannien", "Det virksomhedsnavn eller -nummer, du søger på (offentlige data)"],
              ["Mindee", "Aflæsning af kvitteringer og fakturaer (når slået til)", "Ikke bekræftet", "Billeder af kvitteringer og fakturaer, du uploader"],
              ["Cloudflare", "Netværkssikkerhed og routing foran vores servere", "Globalt", "IP-adresse og forespørgselsdata, kun under overførsel"],
              ["GatewayAPI", "SMS-påmindelser til gæster (når et spisested slår dem til)", "Ikke bekræftet", "Gæstens telefonnummer, beskedens tekst"],
              ["Twilio", "SMS/WhatsApp-beskeder (når slået til)", "Ikke bekræftet", "Telefonnummer, beskedens tekst"],
              ["Apple Push Notification service", "Notifikationer til BonBox-apps på iPhone", "Ikke bekræftet", "Et enheds-token og notifikationens tekst"],
              ["Web push (Google, Apple, Mozilla)", "Browser-notifikationer, du slår til", "Ikke bekræftet", "Et push-abonnement og notifikationens tekst"],
              ["Google / Apple-login", "Log ind med din Google- eller Apple-konto (hvis du vælger det)", "Ikke bekræftet", "Din e-mail og dit navn fra den konto"],
              ["Google Places", "Opslag af virksomheder i nærheden i konkurrentvisningen (når den bruges)", "Ikke bekræftet", "Området og den virksomhedstype, du søger på"],
              ["Sentry", "Fejlrapporter fra vores servere (når slået til)", "Ikke bekræftet", "Tekniske fejldetaljer, sendt uden IP-adresser og cookies"],
              ["Slack", "Besked til os om hastende supporthenvendelser", "Ikke bekræftet", "Henvendelsens emne og din kontos e-mail"],
              ["Simply.com", "Vores e-mailindbakke for contact@bonbox.dk", "Ikke bekræftet", "De e-mails, du sender os"],
            ]}
          />
          <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="privacy-location-note">
            »Ikke bekræftet« betyder, at vi endnu ikke har bekræftet, hvor udbyderen behandler dataene. Det kan være uden for EU/EØS (se »Internationale dataoverførsler«).
          </p>
          <p>
            Vi sælger ikke dine data, og vi deler dem ikke til annoncering. Dit regnskab bliver i vores
            database. I BonBox ser du det, og det gør de teammedlemmer og den revisor, du giver adgang,
            også, så langt deres adgang rækker. For at give dig AI-funktionerne (Copilot, morgenbriefen og
            aflæsning af kvitteringer) sender vi data til Anthropic som beskrevet ovenfor, og for at læse en
            kvittering kan vi sende billedet til en anden OCR-udbyder på listen. Disse udbydere behandler
            dataene efter vores instruks. Anthropic træner ikke sine modeller på dem (Anthropics
            kommercielle vilkår).
          </p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Retshåndhævelse</h3>
          <p>Vi kan videregive personoplysninger, hvis dansk ret eller EU-ret kræver det, eller som svar på en gyldig retlig anmodning fra en dansk domstol eller Datatilsynet.</p>
        </Section>

        <Section title="Hvor længe vi opbevarer dine data">
          <Table
            headers={["Datatype", "Opbevaringsperiode"]}
            rows={[
              ["Kontooplysninger", "Indtil du sletter din konto"],
              ["Hvornår din konto sidst blev brugt (ét tidspunkt, der erstattes hver gang)", "Indtil du sletter din konto"],
              ["Kampagnekode fra en trykt folder (på kontoen)", "Slettes 12 måneder efter, at du har oprettet din konto, eller tidligere, hvis du sletter kontoen"],
              ["Virksomhedsprofil (inkl. logo)", "Indtil du sletter din konto"],
              ["Økonomiske data (salg, udgifter, lager)", "Indtil du sletter din konto"],
              ["Billeder af regnskabsbilag, du uploader (fotos af kasserapporter, kvitteringer og salg samt filer fra lagerimport)", "Indtil du sletter din konto, derefter ca. 6 år efter sletningen; så slettes de"],
              ["Fakturaer + kundeoplysninger", "Indtil du sletter din konto. Fakturakladder, der aldrig er sendt, slettes ca. 6 år efter deres dato"],
              ["Kørselslog / kørselsgodtgørelse", "Slettes ca. 6 år efter kørselsdatoen (kørsler, der er knyttet til en faktura: indtil du sletter din konto), og senest når du sletter din konto"],
              ["Ændringslog (hver markering som betalt / annullering / ændring af branding), inkl. din IP-adresse", "Ingen slutdato: den kan ikke redigeres eller slettes gennem BonBox, og den beholdes, når du sletter din konto"],
              ["Forslag til betalingsmatch (afventende)", "Indtil du accepterer eller afviser dem"],
              ["Forslag til betalingsmatch (afklarede)", "1 år efter afklaring"],
              ["Bank-CSV-filer (rå)", "Gemmes ikke: de læses i hukommelsen under importen"],
              ["Indlæste banktransaktioner", "Indtil du sletter din konto (de gemmes som salg og udgifter)"],
              ["Hændelser til produktanalyse", "180 dage (slettes automatisk hver dag)"],
              ["AI-indsigter afledt af hændelser", "Indtil du sletter din konto; udløbne og fjernede indsigter bliver i dit arkiv over indsigter"],
              ["Spørgsmål til AI Copilot", "Kun at der blev stillet et spørgsmål, registreres: 180 dage, som andre hændelser til produktanalyse. Spørgsmålstekster, der blev gemt indtil midten af juli 2026 (de første 200 tegn), slettes 180 dage efter, at de blev stillet"],
              ["Fejllog (tekniske fejl, inkl. IP-adresse)", "30 dage, også efter at du har slettet din konto"],
              ["Sikkerhedslog (tilmeldinger, vi afviser eller markerer, login-links pr. e-mail, forsøg på administratoradgang og handlinger foretaget af en administrator, ændringer af abonnementer og prøveperioder, forbrugslofter og låste funktioner, du rammer, og prisopslag; nogle af dem med IP-adresse)", "Ingen slutdato; beholdes, når du sletter din konto"],
              ["Log over e-mailkommunikation", "Indtil du sletter din konto"],
              ["Betalingsoplysninger hos Stripe (kundeoplysninger og fakturaer)", "Ingen fakturaer til dig hos Stripe: kundeoplysningerne slettes, når du sletter din konto. Med fakturaer: kundeoplysningerne beholdes i 5 år fra udgangen af regnskabsåret, fordi vi skal opbevare vores egne regnskabsbilag; derefter slettes kundeoplysningerne. De udstedte fakturaer bliver hos Stripe, som ikke tillader, at en udstedt faktura slettes"],
              ["Sikkerhedskopier af vores database", "Kopierne forsvinder, når sikkerhedskopierne udløber"],
            ]}
          />
          <p className="mt-3"><strong>Dit regnskabsmateriale:</strong> Efter bogføringsloven er det dig — ikke BonBox — der skal opbevare din virksomheds regnskabsmateriale, som hovedregel i 5 år fra udgangen af det regnskabsår, materialet vedrører. BonBox er ikke et registreret bogføringssystem og er ikke et arkiv, du kan regne med til den pligt (se <Link to="/terms" className="text-blue-600 dark:text-blue-400 hover:underline">Handelsbetingelserne</Link> § 4). Hent dine data og de PDF'er, du har brug for, før du sletter din konto. Der er ingen indstilling i BonBox, der ændrer, hvor længe vi opbevarer data.</p>
          <p className="mt-3"><strong>Ændringslog:</strong> Hver gang du markerer en faktura som betalt, annullerer den, uploader et logo eller ændrer indstillinger for branding, skriver vi en række i en ændringslog med handlingen, tidspunktet, din IP-adresse og tilstanden før og efter. Loggen kan ikke redigeres eller slettes gennem BonBox — hverken af dig eller af os — og vi har ikke sat en slutdato for den.</p>
          <p className="mt-3" data-testid="privacy-deletion">Når du sletter din konto, sletter vi kontoen og dataene i den med det samme. Vi beholder ændringsloggen, sikkerheds- og fejlloggene og billederne af de regnskabsbilag, du har uploadet (fotos af kasserapporter, kvitteringer og salg samt filer fra lagerimport); billederne gemmer vi i ca. 6 år efter sletningen og sletter dem derefter. Er der ingen fakturaer til dig hos Stripe, sletter vi også dine kundeoplysninger hos Stripe. Er der fakturaer, beholder vi kundeoplysningerne hos Stripe i 5 år fra udgangen af regnskabsåret, fordi vi skal opbevare vores egne regnskabsbilag; derefter sletter vi kundeoplysningerne. De udstedte fakturaer bliver hos Stripe, som ikke tillader, at en udstedt faktura slettes. Kopier i vores sikkerhedskopier forsvinder, når sikkerhedskopierne udløber.</p>
        </Section>

        <Section title="Dine rettigheder efter databeskyttelsesforordningen">
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Ret til indsigt (artikel 15):</strong> Du kan anmode om en kopi af alle de data, vi har om dig.</li>
            <li><strong>Ret til berigtigelse (artikel 16):</strong> Du kan til enhver tid rette forkerte oplysninger i dine indstillinger.</li>
            <li><strong>Ret til sletning (artikel 17):</strong> Du kan slette din konto under Profil. Vi sletter kontoen og dataene i den med det samme, herunder billeder og dokumenter af medarbejdere, billeder fra chatten og dit logo. Vi beholder ændringsloggen, sikkerheds- og fejlloggene, billederne af de regnskabsbilag, du har uploadet (ca. 6 år), og, hvis der er fakturaer til dig, kundeoplysningerne hos Stripe (5 år fra udgangen af regnskabsåret) og fakturaerne, som bliver hos Stripe — se »Hvor længe vi opbevarer dine data«.</li>
            <li><strong>Ret til dataportabilitet (artikel 20):</strong> Du kan eksportere alle dine data som CSV-filer fra BonBox.</li>
            <li><strong>Ret til begrænsning af behandling (artikel 18):</strong> Du kan anmode om, at vi stopper behandlingen, mens en klage bliver afklaret.</li>
            <li><strong>Ret til indsigelse (artikel 21):</strong> Du kan gøre indsigelse mod behandling, der er baseret på legitim interesse.</li>
            <li><strong>Ret til at trække samtykke tilbage:</strong> Du kan til enhver tid trække dit samtykke tilbage, uden at det påvirker behandling, der allerede har fundet sted.</li>
          </ul>
          <p className="mt-3">Hvis du vil gøre brug af nogen af disse rettigheder, kan du kontakte os på <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>. Vi svarer inden for 30 dage.</p>
        </Section>

        <Section title="Datasikkerhed">
          <ul className="list-disc pl-6 space-y-1">
            <li>Alle data krypteres under overførsel via HTTPS/TLS</li>
            <li>Adgangskoder hashes med bcrypt (gemmes aldrig i klartekst)</li>
            <li>Hver forespørgsel er begrænset til din egen virksomhed i vores serverkode, og databasen kan ikke nås direkte udefra (row-level security afviser det)</li>
            <li>API-endepunkter kræver JWT-autentificering</li>
            <li>Bank-CSV-filer læses i hukommelsen under importen og gemmes ikke</li>
            <li>Vi gemmer under ingen omstændigheder loginoplysninger til banken</li>
          </ul>
        </Section>

        <Section title="Internationale dataoverførsler">
          <p>
            Nogle af vores tjenesteudbydere kan behandle data uden for EU/EØS. Når det sker, sikrer vi, at der er fornødne garantier på plads, herunder standardkontraktbestemmelser (SCC'er), som er godkendt af Europa-Kommissionen.
          </p>
        </Section>

        <Section title="Børn">
          <p>BonBox er et værktøj til virksomheder og er ikke beregnet til personer under 18 år. Vi indsamler ikke bevidst data fra børn.</p>
        </Section>

        <Section title="Ændringer i denne politik">
          <p>Vi kan opdatere denne privatlivspolitik fra tid til anden. Når vi gør det, opdaterer vi datoen øverst på siden. Ved væsentlige ændringer giver vi dig besked via e-mail eller gennem en meddelelse i BonBox.</p>
        </Section>

        <Section title="Klager">
          <p>Hvis du mener, at vi ikke har behandlet dine personoplysninger korrekt, har du ret til at indgive en klage til:</p>
          <div className="mt-2 bg-gray-50 dark:bg-gray-800 rounded-lg p-4 text-sm">
            <p className="font-semibold text-gray-800 dark:text-gray-200">Datatilsynet</p>
            <p>Carl Jacobsens Vej 35</p>
            <p>DK-2500 Valby, Danmark</p>
            <p>Hjemmeside: <a href="https://www.datatilsynet.dk" className="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">www.datatilsynet.dk</a></p>
            <p>E-mail: <a href="mailto:dt@datatilsynet.dk" className="text-blue-600 dark:text-blue-400 hover:underline">dt@datatilsynet.dk</a></p>
          </div>
        </Section>

        <Section title="Kontakt os">
          <p>Hvis du har spørgsmål til denne privatlivspolitik eller til dine personoplysninger:</p>
          <p className="mt-2">
            <strong>E-mail:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
            <strong>Hjemmeside:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
          </p>
        </Section>
      </div>
    </>
  );
}

export default function PrivacyPolicyPage() {
  const { lang } = useLanguage();
  // Danish reads the Danish document; every other UI language reads English.
  const docLang = lang === "da" ? "da" : "en";
  const c = CHROME[docLang];
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900" lang={docLang}>
      <nav className="bg-slate-950 border-b border-white/5">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <div className="inline-flex items-center justify-center w-10 h-10 bg-bb-forest text-bb-paper rounded-xl">
              <BonBoxMark size={32} />
            </div>
            <span className="text-xl font-bold text-white tracking-tight">BonBox</span>
          </Link>
          <div className="flex gap-4 text-sm">
            <Link to="/terms" className="text-gray-400 hover:text-white transition">{c.terms}</Link>
            <Link to="/cookies" className="text-gray-400 hover:text-white transition">{c.cookies}</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {docLang === "da" ? <PrivacyDa /> : <PrivacyEn />}

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium">&larr; {c.back}</Link>
          <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm text-gray-400">
            <Link to="/terms" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.terms}</Link>
            <Link to="/cookies" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.cookies}</Link>
            <CookieSettingsButton label={c.cookieSettings} className="hover:text-gray-600 dark:hover:text-gray-300 transition" />
          </div>
        </div>
      </div>
    </div>
  );
}
