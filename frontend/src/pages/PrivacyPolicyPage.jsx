import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

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
const CHROME = {
  en: { terms: "Terms", cookies: "Cookies", back: "Back to BonBox" },
  da: { terms: "Vilkår", cookies: "Cookies", back: "Tilbage til BonBox" },
};

function PrivacyEn() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Privacy Policy</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Last updated: 8 October 2026</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section title="Who we are">
          <p>
            BonBox is a product of <strong>DukaanAI v/Manoz Chaudhary</strong>, registered in Denmark
            as a Personligt ejet Mindre Virksomhed. That business is the data controller for
            everything described on this page.
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
            <li>Campaign code from a printed flyer, if any — the short code (for example <code>r1-a-03</code>) from the QR on a BonBox flyer you signed up from, so we can count which round of visits led to accounts. It is only counted, never used to contact you, and is included in your data export. Legal basis for this one item: our legitimate interest in knowing which visits work (GDPR Article 6(1)(f)).</li>
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
          </ul>
          <p className="mt-1">We do not use third-party tracking cookies. We do not use Google Analytics, Meta Pixel, or similar advertising trackers.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Legitimate interest (GDPR Article 6(1)(f)).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Product analytics events</h3>
          <p>To improve BonBox and detect anomalies in your business, we record events about how you use the app:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>Pages you visit and time spent on each</li>
            <li>Actions you take (sale logged, receipt scanned, AI question asked, daily close completed, login/logout)</li>
            <li>Up to the first 200 characters of questions you ask the BonBox AI Copilot (so we can improve the AI)</li>
            <li>Token usage of AI Copilot conversations (metadata only — used for cost monitoring, not content)</li>
          </ul>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            <strong>You can pause analytics at any time</strong> in <Link to="/profile" className="text-blue-600 dark:text-blue-400 hover:underline">Profile → Privacy & Data</Link>. When paused, no new events are recorded for your account.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            <strong>Retention:</strong> Product analytics events are automatically deleted after 180 days. Aggregated counts may be retained longer in anonymised form for product improvement.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400"><strong>Legal basis:</strong> Legitimate interest (GDPR Article 6(1)(f)) — improving BonBox and detecting business anomalies for your benefit.</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Derived insights (AI patterns)</h3>
          <p>BonBox computes pattern-recognition insights about your business from your data. Examples:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>"You close every Sunday around 22:00" (from event timestamps)</li>
            <li>"Today's revenue is below your usual Tuesday" (from sales aggregates)</li>
            <li>"Wage cost is above your trailing 4-week average" (from expense + sales data)</li>
          </ul>
          <p className="mt-1">These insights are computed on our servers, stored in your account, and shown only to you. We do <strong>not</strong> train external AI models on your data.</p>
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
            <li>Your message and a summary of your business context (revenue totals, top features used, recent insights — never raw customer data) are sent to Anthropic's API to generate a reply.</li>
            <li>Anthropic processes the data on EU/US servers and does not retain it beyond their operational logs (typically 30 days). Per Anthropic's commercial terms, they do <strong>not</strong> train their models on data sent through their API.</li>
            <li>We log the question (first 200 chars) and token usage in your account so you can review what was sent.</li>
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
              ["Supabase", "Database hosting (PostgreSQL)", "EU (Ireland)", "All account and business data"],
              ["Vercel", "Frontend hosting", "Global CDN", "No personal data stored"],
              ["Render", "Backend API hosting", "US/EU", "API requests, no persistent storage"],
              ["Resend", "Email delivery", "US", "Email address, email content"],
              ["Anthropic (Claude API)", "Reading receipts and documents, AI Copilot replies", "EU/US", "Photos of receipts, kasserapporter and other documents you upload, plus your chat messages and a summary of your business context; not retained beyond Anthropic's operational logs; not used for training"],
              ["Google Cloud Vision", "Reading text from receipt photos (when enabled)", "US", "Photos of receipts you upload"],
              ["Stripe", "Subscription payments", "US/EU", "Billing email, subscription status; card details go straight to Stripe and never reach our servers"],
              ["cvrapi.dk", "Business registration lookup", "Denmark", "CVR numbers (public data)"],
              ["Mindee", "Reading receipts and invoices (when enabled)", "EU", "Photos of receipts and invoices you upload"],
              ["Cloudflare", "Network security and routing in front of our servers", "Global", "IP address and request data, in transit only"],
              ["GatewayAPI", "SMS reminders to guests (when a venue turns them on)", "EU (Denmark)", "Guest phone number, message text"],
              ["Twilio", "SMS/WhatsApp messages (when enabled)", "US/EU", "Phone number, message text"],
              ["Apple Push Notification service", "Notifications to the BonBox iPhone apps", "US", "A device token and the notification text"],
              ["Web push (Google, Apple, Mozilla)", "Browser notifications you switch on", "US/EU", "A push subscription and the notification text"],
              ["Google / Apple sign-in", "Signing in with your Google or Apple account (if you choose to)", "US", "Your email address and name from that account"],
              ["Google Places", "Looking up nearby businesses in the competitor view (when used)", "US", "The area and business type you search for"],
              ["Sentry", "Error reports from our servers (when enabled)", "EU/US", "Technical error details; personal data is stripped"],
              ["Slack", "Alerting us to urgent support requests", "US", "The request's subject and your account email"],
            ]}
          />
          <p>
            We do not sell your data, and we do not share it for advertising. Your books stay in our
            database and only you can see them. The one exception is the list above: to read a receipt
            we have to send the photo to an OCR provider, and that photo is financial data. Those
            providers process it on our instructions, do not train on it, and do not keep it beyond
            their operational logs.
          </p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Law enforcement</h3>
          <p>We may disclose personal data if required by Danish or EU law, or in response to a valid legal request from a Danish court or the Danish Data Protection Agency (Datatilsynet).</p>
        </Section>

        <Section title="How long we keep your data">
          <Table
            headers={["Data type", "Retention period"]}
            rows={[
              ["Account data", "Until you delete your account"],
              ["Business profile (incl. logo)", "Until you delete your account"],
              ["Financial data (sales, expenses, inventory)", "Until you delete your account"],
              ["Fakturaer + customer records", "6 years (Bogføringsloven §12 minimum) — adjustable 5–10 years"],
              ["Mileage / kørselsgodtgørelse log", "Per your faktura retention setting (5–10 years)"],
              ["Audit log (every mark-paid / void / brand change)", "10 years (Skatteforvaltningsloven §31 maximum)"],
              ["Payment-match suggestions (pending)", "Until accepted/rejected by you"],
              ["Payment-match suggestions (resolved)", "1 year after resolution"],
              ["Bank CSV files (raw)", "Deleted within 30 days of import"],
              ["Parsed bank transactions", "Per your faktura retention setting"],
              ["Product analytics events", "180 days (auto-purged daily)"],
              ["AI insights derived from events", "Auto-expire 1–30 days; can be dismissed any time"],
              ["AI Copilot question logs (first 200 chars)", "180 days"],
              ["Technical/access logs", "30 days"],
              ["Security audit log (admin access attempts)", "365 days"],
              ["Email communication logs", "90 days"],
            ]}
          />
          <p className="mt-3"><strong>Why fakturaer and audit logs stay so long:</strong> Danish law (Bogføringsloven §12) requires us to retain accounting records for at least 5 years from the end of the financial year. Skattestyrelsen disputes can reach back 10 years (Skatteforvaltningsloven §31). We default to 6 years (5-year legal minimum + 1-year buffer) and let you extend up to 10 years from your Profile. We will not let you go below 5 years — that would expose you to penalties under Bogføringsloven §16.</p>
          <p className="mt-3"><strong>Audit log immutability:</strong> Every time you mark an invoice paid, void it, upload a logo, or change brand settings, we write a row to an append-only audit log capturing the action, your IP, and before/after state. These rows cannot be edited or deleted — by you, by us, or by anyone except after the 10-year window expires. This is required by Bogføringsloven §9 (every accounting entry must be traceable to source).</p>
          <p className="mt-3">When you delete your account, all your personal and financial data is permanently deleted within 30 days <em>except</em> records the law requires us to retain — those remain in cold storage for the legal window, no longer linked to your identity once you delete. Backups are purged within 90 days.</p>
        </Section>

        <Section title="Your rights under GDPR">
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Right of access (Article 15):</strong> Request a copy of all data we hold about you.</li>
            <li><strong>Right to rectification (Article 16):</strong> Correct inaccurate data at any time in your settings.</li>
            <li><strong>Right to erasure (Article 17):</strong> Delete your account from your settings. Your personal data — including uploaded photos, staff images and your logo — is erased within 30 days; legally-required accounting records (see Data retention) are kept for the 5-year window, then deleted.</li>
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
    </>
  );
}

function PrivacyDa() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Privatlivspolitik</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Senest opdateret: 8. oktober 2026</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section title="Hvem vi er">
          <p>
            BonBox er et produkt fra <strong>DukaanAI v/Manoz Chaudhary</strong>, der er registreret i Danmark
            som Personligt ejet Mindre Virksomhed. Denne virksomhed er dataansvarlig for alt, hvad der
            er beskrevet på denne side.
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
            <li>Kampagnekode fra en trykt folder, hvis der er en — den korte kode (fx <code>r1-a-03</code>) fra QR-koden på en BonBox-folder, du oprettede dig fra, så vi kan tælle, hvilken besøgsrunde der førte til konti. Den bliver kun talt, bruges aldrig til at kontakte dig og er med i din dataeksport. Retsgrundlag for netop dette punkt: vores legitime interesse i at vide, hvilke besøg der virker (databeskyttelsesforordningens artikel 6, stk. 1, litra f).</li>
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
            <li>Slette den oprindelige CSV-fil fra vores servere inden for 30 dage efter importen</li>
          </ul>
          <p className="mt-1">Vi har ikke adgang til dine loginoplysninger til banken.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Samtykke (databeskyttelsesforordningens artikel 6, stk. 1, litra a).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Tekniske data</h3>
          <p>Når du bruger bonbox.dk, indsamler vi automatisk:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>IP-adresse (anonymiseres efter 30 dage)</li>
            <li>Browsertype og -version</li>
            <li>Enhedstype (computer, mobil, tablet)</li>
          </ul>
          <p className="mt-1">Vi bruger ikke sporingscookies fra tredjeparter. Vi bruger ikke Google Analytics, Meta Pixel eller lignende sporingsværktøjer til annoncering.</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Legitim interesse (databeskyttelsesforordningens artikel 6, stk. 1, litra f).</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Hændelser til produktanalyse</h3>
          <p>For at forbedre BonBox og opdage uregelmæssigheder i din virksomhed registrerer vi hændelser om, hvordan du bruger appen:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>Hvilke sider du besøger, og hvor lang tid du bruger på hver af dem</li>
            <li>Handlinger, du foretager (salg registreret, kvittering scannet, spørgsmål stillet til AI, kasserapport afsluttet, login/logout)</li>
            <li>Op til de første 200 tegn af de spørgsmål, du stiller BonBox AI Copilot (så vi kan forbedre AI'en)</li>
            <li>Tokenforbrug i samtaler med AI Copilot (kun metadata — bruges til at overvåge omkostninger, ikke indhold)</li>
          </ul>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            <strong>Du kan til enhver tid sætte analysen på pause</strong> under <Link to="/profile" className="text-blue-600 dark:text-blue-400 hover:underline">Profil → Privatliv & data</Link>. Mens den er sat på pause, registreres der ingen nye hændelser for din konto.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            <strong>Opbevaring:</strong> Hændelser til produktanalyse slettes automatisk efter 180 dage. Samlede optællinger kan opbevares længere i anonymiseret form med henblik på at forbedre produktet.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400"><strong>Retsgrundlag:</strong> Legitim interesse (databeskyttelsesforordningens artikel 6, stk. 1, litra f) — at forbedre BonBox og opdage uregelmæssigheder i din virksomhed til din fordel.</p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Afledte indsigter (AI-mønstre)</h3>
          <p>BonBox beregner indsigter om din virksomhed ud fra dine data ved hjælp af mønstergenkendelse. Eksempler:</p>
          <ul className="list-disc pl-6 space-y-1 mt-1">
            <li>»Du lukker hver søndag omkring kl. 22:00« (ud fra hændelsernes tidsstempler)</li>
            <li>»Dagens omsætning er under din normale tirsdag« (ud fra samlede salgstal)</li>
            <li>»Lønomkostningerne ligger over dit gennemsnit for de seneste 4 uger« (ud fra udgifts- og salgsdata)</li>
          </ul>
          <p className="mt-1">Indsigterne beregnes på vores servere, gemmes på din konto og vises kun for dig. Vi træner <strong>ikke</strong> eksterne AI-modeller på dine data.</p>
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
            <li>Din besked og et resumé af din virksomheds kontekst (samlet omsætning, de mest brugte funktioner, seneste indsigter — aldrig rå kundedata) sendes til Anthropics API for at generere et svar.</li>
            <li>Anthropic behandler dataene på servere i EU/USA og opbevarer dem ikke ud over deres driftslogge (typisk 30 dage). Ifølge Anthropics kommercielle vilkår træner de <strong>ikke</strong> deres modeller på data, der sendes via deres API.</li>
            <li>Vi logger spørgsmålet (de første 200 tegn) og tokenforbruget på din konto, så du kan se, hvad der blev sendt.</li>
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
              ["Supabase", "Hosting af database (PostgreSQL)", "EU (Irland)", "Alle konto- og virksomhedsdata"],
              ["Vercel", "Hosting af frontend", "Globalt CDN", "Ingen personoplysninger gemmes"],
              ["Render", "Hosting af backend-API", "USA/EU", "API-forespørgsler, ingen varig lagring"],
              ["Resend", "Afsendelse af e-mails", "USA", "E-mailadresse, e-mailens indhold"],
              ["Anthropic (Claude API)", "Aflæsning af kvitteringer og dokumenter, svar fra AI Copilot", "EU/USA", "Billeder af kvitteringer, kasserapporter og andre dokumenter, du uploader, samt dine chatbeskeder og et resumé af din virksomheds kontekst; opbevares ikke ud over Anthropics driftslogge; bruges ikke til træning"],
              ["Google Cloud Vision", "Aflæsning af tekst fra kvitteringsbilleder (når funktionen er slået til)", "USA", "Billeder af kvitteringer, du uploader"],
              ["Stripe", "Betaling af abonnementer", "USA/EU", "E-mail til fakturering, abonnementsstatus; kortoplysninger går direkte til Stripe og når aldrig vores servere"],
              ["cvrapi.dk", "Opslag i virksomhedsregistret", "Danmark", "CVR-numre (offentlige data)"],
              ["Mindee", "Aflæsning af kvitteringer og fakturaer (når slået til)", "EU", "Billeder af kvitteringer og fakturaer, du uploader"],
              ["Cloudflare", "Netværkssikkerhed og routing foran vores servere", "Globalt", "IP-adresse og forespørgselsdata, kun under overførsel"],
              ["GatewayAPI", "SMS-påmindelser til gæster (når et spisested slår dem til)", "EU (Danmark)", "Gæstens telefonnummer, beskedens tekst"],
              ["Twilio", "SMS/WhatsApp-beskeder (når slået til)", "USA/EU", "Telefonnummer, beskedens tekst"],
              ["Apple Push Notification service", "Notifikationer til BonBox-apps på iPhone", "USA", "Et enheds-token og notifikationens tekst"],
              ["Web push (Google, Apple, Mozilla)", "Browser-notifikationer, du slår til", "USA/EU", "Et push-abonnement og notifikationens tekst"],
              ["Google / Apple-login", "Log ind med din Google- eller Apple-konto (hvis du vælger det)", "USA", "Din e-mail og dit navn fra den konto"],
              ["Google Places", "Opslag af virksomheder i nærheden i konkurrentvisningen (når den bruges)", "USA", "Området og den virksomhedstype, du søger på"],
              ["Sentry", "Fejlrapporter fra vores servere (når slået til)", "EU/USA", "Tekniske fejldetaljer; personoplysninger fjernes"],
              ["Slack", "Besked til os om hastende supporthenvendelser", "USA", "Henvendelsens emne og din kontos e-mail"],
            ]}
          />
          <p>
            Vi sælger ikke dine data, og vi deler dem ikke til annoncering. Dit regnskab bliver i vores
            database, og kun du kan se det. Den eneste undtagelse er listen ovenfor: For at kunne læse en
            kvittering skal vi sende billedet til en OCR-udbyder, og det billede er økonomiske data. Disse
            udbydere behandler det efter vores instruks, træner ikke på det og opbevarer det ikke ud over
            deres driftslogge.
          </p>

          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mt-6 mb-2">Retshåndhævelse</h3>
          <p>Vi kan videregive personoplysninger, hvis dansk ret eller EU-ret kræver det, eller som svar på en gyldig retlig anmodning fra en dansk domstol eller Datatilsynet.</p>
        </Section>

        <Section title="Hvor længe vi opbevarer dine data">
          <Table
            headers={["Datatype", "Opbevaringsperiode"]}
            rows={[
              ["Kontooplysninger", "Indtil du sletter din konto"],
              ["Virksomhedsprofil (inkl. logo)", "Indtil du sletter din konto"],
              ["Økonomiske data (salg, udgifter, lager)", "Indtil du sletter din konto"],
              ["Fakturaer + kundeoplysninger", "6 år (minimum efter bogføringslovens § 12) — kan justeres til 5–10 år"],
              ["Kørselslog / kørselsgodtgørelse", "Følger din opbevaringsindstilling for fakturaer (5–10 år)"],
              ["Revisionslog (hver markering som betalt / annullering / ændring af branding)", "10 år (maksimum efter skatteforvaltningslovens § 31)"],
              ["Forslag til betalingsmatch (afventende)", "Indtil du accepterer eller afviser dem"],
              ["Forslag til betalingsmatch (afklarede)", "1 år efter afklaring"],
              ["Bank-CSV-filer (rå)", "Slettes inden for 30 dage efter import"],
              ["Indlæste banktransaktioner", "Følger din opbevaringsindstilling for fakturaer"],
              ["Hændelser til produktanalyse", "180 dage (slettes automatisk hver dag)"],
              ["AI-indsigter afledt af hændelser", "Udløber automatisk efter 1–30 dage; kan til enhver tid fjernes"],
              ["Log over spørgsmål til AI Copilot (første 200 tegn)", "180 dage"],
              ["Tekniske logge og adgangslogge", "30 dage"],
              ["Sikkerhedslog (forsøg på administratoradgang)", "365 dage"],
              ["Log over e-mailkommunikation", "90 dage"],
            ]}
          />
          <p className="mt-3"><strong>Hvorfor fakturaer og revisionslogge opbevares så længe:</strong> Dansk lov (bogføringslovens § 12) kræver, at vi opbevarer regnskabsmateriale i mindst 5 år fra udgangen af regnskabsåret. Sager med Skattestyrelsen kan række 10 år tilbage (skatteforvaltningslovens § 31). Som standard opbevarer vi i 6 år (lovens minimum på 5 år + 1 års buffer), og du kan selv forlænge op til 10 år under din Profil. Vi lader dig ikke gå under 5 år — det ville udsætte dig for straf efter bogføringslovens § 16.</p>
          <p className="mt-3"><strong>Revisionsloggen kan ikke ændres:</strong> Hver gang du markerer en faktura som betalt, annullerer den, uploader et logo eller ændrer indstillinger for branding, skriver vi en række i en revisionslog, der kun kan tilføjes til. Rækken registrerer handlingen, din IP-adresse og tilstanden før og efter. Rækkerne kan ikke redigeres eller slettes — hverken af dig, af os eller af nogen anden, før 10-årsperioden er udløbet. Det kræves af bogføringslovens § 9 (enhver bogføringspost skal kunne spores tilbage til kilden).</p>
          <p className="mt-3">Når du sletter din konto, slettes alle dine personoplysninger og økonomiske data permanent inden for 30 dage — <em>undtagen</em> materiale, som loven kræver, at vi opbevarer. Det forbliver i arkivlager i den lovpligtige periode og er ikke længere knyttet til din identitet, når du har slettet kontoen. Sikkerhedskopier slettes inden for 90 dage.</p>
        </Section>

        <Section title="Dine rettigheder efter databeskyttelsesforordningen">
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Ret til indsigt (artikel 15):</strong> Du kan anmode om en kopi af alle de data, vi har om dig.</li>
            <li><strong>Ret til berigtigelse (artikel 16):</strong> Du kan til enhver tid rette forkerte oplysninger i dine indstillinger.</li>
            <li><strong>Ret til sletning (artikel 17):</strong> Du kan slette din konto i dine indstillinger. Dine personoplysninger — herunder uploadede billeder, billeder af medarbejdere og dit logo — slettes inden for 30 dage; lovpligtigt regnskabsmateriale (se »Hvor længe vi opbevarer dine data«) opbevares i 5-årsperioden og slettes derefter.</li>
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
            <li>Bank-CSV-filer behandles i hukommelsen og slettes efter import</li>
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
            <Link to="/terms" className="text-gray-400 hover:text-white transition">{c.terms}</Link>
            <Link to="/cookies" className="text-gray-400 hover:text-white transition">{c.cookies}</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {docLang === "da" ? <PrivacyDa /> : <PrivacyEn />}

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium">&larr; {c.back}</Link>
          <div className="flex gap-4 text-sm text-gray-400">
            <Link to="/terms" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.terms}</Link>
            <Link to="/cookies" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.cookies}</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
