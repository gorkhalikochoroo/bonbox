import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
// The date shown is the TERMS_VERSION the server stamps on an account that
// accepts these terms (src/legal/terms.js ↔ backend/app/services/terms.py).
// TERMS_EXISTING_FROM is the date they apply to existing accounts (every
// account without an acceptance of TERMS_VERSION) — the deploy day + 15 days;
// the in-app notice runs until then. Both are release-time constants.
import { TERMS_EXISTING_FROM, TERMS_VERSION, termsDate } from "../legal/terms";
import { isNativeApp } from "../utils/platform";

function Section({ num, title, children }) {
  return (
    <section>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-10 mb-3">{num}. {title}</h2>
      {children}
    </section>
  );
}

// The page chrome around the document (nav + footer). The terms themselves are
// NOT split into dictionary keys: each language is one whole document below
// (TermsEn / TermsDa), so a reviewer can read — and a lawyer can approve —
// each version top to bottom. Keep the two in step: same numbered sections,
// same order, same links. If you change one, change the other in the same commit.
//
// The iPhone app (App Store 3.1.1 / 3.1.3) renders this page too. It has no
// purchase path, no prices and no billing portal, and must carry no link or
// call to action to buy outside the app. So in the native build (`native`),
// four § 8 sentences say the same thing without a link, an address or an
// instruction: where prices are shown, how to cancel, how to switch plan and
// where to update the card; and the founding-price paragraph names no amount
// (App Review 3.1.1 — the app names no price). Everything else is the same
// text. Keep the two variants side by side below, and change both together.
const CHROME = {
  en: { privacy: "Privacy", cookies: "Cookies", back: "Back to BonBox" },
  da: { privacy: "Privatliv", cookies: "Cookies", back: "Tilbage til BonBox" },
};

function TermsEn({ native = false }) {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Terms of Service</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm">Last updated: {termsDate(TERMS_VERSION, "en")}</p>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8" data-testid="terms-effective-dates">Applies to new accounts from {termsDate(TERMS_VERSION, "en")} and to existing accounts from {termsDate(TERMS_EXISTING_FROM, "en")}.</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section num={1} title="About BonBox">
          <p>
            BonBox is a multi-terminal close consolidation tool for small hospitality businesses (restaurants, bars, cafés, takeaways). It helps front-of-house staff complete the end-of-shift cash reconciliation and delivers the consolidated daily-close PDF to owners and revisors.
          </p>
          <p className="mt-2">
            BonBox is provided by <strong>DukaanAI v/Manoz Chaudhary</strong>, CVR 46417321 (&ldquo;we&rdquo;, &ldquo;us&rdquo;). You can reach us at <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>.
          </p>
          <p className="mt-2">BonBox is a service for businesses. These terms apply between us and the business that creates the account.</p>
          <p className="mt-2">By creating an account or using BonBox, you agree to these terms.</p>
        </Section>

        <Section num={2} title="What BonBox is — and what it is not">
          <p className="font-semibold mb-2">BonBox is:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>A multi-terminal end-of-shift close consolidation tool</li>
            <li>An OCR-and-aggregation system for printed kasserapport receipts</li>
            <li>An invoicing (faktura) and mileage (k&oslash;rselsgodtg&oslash;relse) data-capture tool</li>
            <li>A generator of daily-close (kasserapport) PDFs</li>
            <li>A reporting layer that exports to Dinero / Billy / e-conomic</li>
            <li>An optional personal finance tracker (Personal Mode &mdash; free of charge; paid plans cannot be bought for it, see &sect;8)</li>
          </ul>
          <p className="font-semibold mt-4 mb-2">BonBox is NOT:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Accounting software as defined under Danish Bogf&oslash;ringsloven (the Bookkeeping Act)</li>
            <li>A certified bookkeeping system (registreret digitalt bogf&oslash;ringssystem)</li>
            <li>A point-of-sale (POS) system &mdash; BonBox does not process card transactions or replace your till hardware</li>
            <li>A tax advisory or tax filing service</li>
            <li>A payment processor &mdash; BonBox does not move, hold, or transfer money</li>
            <li>A replacement for professional accounting, legal, or financial advice</li>
          </ul>

          <div className="mt-6 bg-amber-50 dark:bg-amber-900/20 border-l-4 border-amber-400 dark:border-amber-600 rounded-r-lg p-4 space-y-2 text-sm">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              Important: BonBox is not a registered digital bookkeeping system
            </p>
            <p className="text-amber-900/90 dark:text-amber-100/90">
              <strong>Dansk:</strong> BonBox er <strong>ikke</strong> et registreret digitalt
              bogf&oslash;ringssystem under Erhvervsstyrelsens anmelderordning, jf.
              Bogf&oslash;ringsloven (2024). BonBox skal bruges sammen med din revisor eller
              et registreret bogf&oslash;ringssystem (f.eks. Dinero, Billy, e-conomic).
            </p>
            <p className="text-amber-900/90 dark:text-amber-100/90">
              <strong>English:</strong> BonBox is <strong>not</strong> a registered digital
              bookkeeping system under the Danish Business Authority's registration scheme
              pursuant to the 2024 Bookkeeping Act. BonBox is designed to be used together
              with your accountant or a registered bookkeeping system (e.g. Dinero, Billy,
              e-conomic). If your business is legally required to use a registered system,
              you must continue to use one alongside BonBox.
            </p>
          </div>
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
            <li>You can download a copy of your data at any time as a CSV file (Profile)</li>
            <li>You can delete your account at any time under Profile. Deleting asks for your password: if you created the account with Google, Apple or an e-mail link, first choose a password with &ldquo;Forgot?&rdquo; on the login page, or write to <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>. If the account has team members with their own login, remove them first.</li>
            <li>See our <Link to="/privacy" className="text-blue-600 dark:text-blue-400 hover:underline">Privacy Policy</Link> for full details on data handling</li>
          </ul>

          <p className="font-semibold mt-4">Your accounting records</p>
          <p className="mt-1">Under the Danish Bookkeeping Act it is you — not BonBox — who must keep your business&rsquo;s accounting records, as a rule for 5 years from the end of the financial year they relate to. BonBox is not a registered bookkeeping system (see &sect;2) and is not an archive you can rely on for that duty. Download your data and the PDFs you need (for example kasserapporter and invoices) before you delete your account.</p>

          <p className="font-semibold mt-4">Change log</p>
          <p className="mt-1">Changes to financial records (for example marking an invoice paid or voiding it) are written to a change log with the action, the time, your IP address and the state before and after. The log cannot be edited or deleted through BonBox &mdash; neither by you nor by us.</p>

          <p className="font-semibold mt-4">Deleting your account</p>
          <p className="mt-1">When you delete your account, we delete the account and the data in it straight away. We keep the change log, the security and error logs, and the images of accounting documents you uploaded (kasserapport photos, receipt and sales photos, and stock import files); we keep those images for about 6 years after the deletion and then delete them. If there are no invoices for you at Stripe, we also delete your customer record at Stripe. If there are, we keep the customer record and the invoices at Stripe, because we must keep our own accounting records for 5 years from the end of the financial year; then we delete them. Copies in our backups disappear when those backups expire. An active subscription stops at the same moment (see &sect;8).</p>
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
          <p>When you upload a bank CSV file:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>You confirm that you are authorized to access and share the bank account data</li>
            <li>BonBox reads transaction data in read-only mode — we cannot initiate payments or transfers</li>
            <li>Auto-categorization of transactions is a suggestion that may not always be accurate — always review imported transactions</li>
            <li>You can delete the entries an import created (sales and expenses)</li>
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

        <Section num={8} title="Subscription and payment">
          <p><strong>Plans and prices.</strong> BonBox has a free plan (Free) and two paid subscriptions (Starter and Pro). {native ? <>Subscriptions are managed outside the app.</> : <>The prices are shown on <a href="/#pricing" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk under Pricing</a> and on the Plan &amp; Billing page when you use BonBox in a browser.</>} Prices are per business, in Danish kroner and per month. The amount you pay is shown at checkout before you confirm the purchase. Every plan has usage caps (for example how many receipts you can scan per month). We may change, limit or remove features and usage caps with reasonable notice.</p>
          <p className="mt-3"><strong>Businesses only.</strong> Paid subscriptions are for businesses only. By buying a subscription you confirm that you buy it for your business and not as a consumer. An account set up for personal finance (Personal Mode) can use BonBox for free but cannot buy a paid subscription. As subscriptions are sold business to business, the consumer right of withdrawal (fortrydelsesret) under the Danish Consumer Contracts Act does not apply.</p>
          <p className="mt-3"><strong>Trial.</strong> A new account gets 14 days with the Pro features, free of charge and without a payment card. If you do not buy a subscription, the account moves to the Free plan when the trial ends, and you are not charged. If you buy a subscription during the trial, you enter a payment card at checkout, and the first charge is made when the trial ends.</p>
          <p className="mt-3"><strong>Payment and renewal.</strong> Payment is handled by Stripe. A subscription is paid one month in advance at a time, by payment card or another payment method Stripe offers at checkout, and it renews automatically every month until it is cancelled. We never charge retroactively.</p>
          <p className="mt-3" data-testid="terms-founding-price"><strong>Founding price.</strong> While fewer than 100 businesses have a paid subscription with us, new subscriptions get the founding price{native ? "." : <>: Starter 129 kr. and Pro 249 kr. per month (regular price: Starter 199 kr. and Pro 349 kr.).</>} You keep the founding price as long as your subscription stays active without a break. If you cancel the subscription, or it ends because a payment does not go through, the founding price is lost, and a new subscription later costs the price that applies at that time.</p>
          <p className="mt-3" data-testid="terms-plan-switch"><strong>Switching plans.</strong> {native ? <>We switch a subscription between Starter and Pro for you, outside the app.</> : <>If you want to switch between Starter and Pro, write to <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a> &mdash; we will switch the plan for you.</>} The switch applies from the day we make it. The price difference for the rest of the period is added to your next payment or deducted from it.</p>
          <p className="mt-3"><strong>Cancellation.</strong> {native ? <>You can cancel at any time. This is done outside the app, in Stripe&rsquo;s customer portal.</> : <>You can cancel at any time when you use BonBox in a browser: on the Plan &amp; Billing page, choose Manage subscription, which opens Stripe&rsquo;s customer portal.</>} The cancellation takes effect at the end of the period you have paid for. Until then you keep the plan&rsquo;s features; after that the account moves to the Free plan, and your data stays in the account. We do not refund part of a period.</p>
          <p className="mt-3"><strong>Deleting the account.</strong> If you delete your account, an active subscription stops at once, and the rest of the period is not refunded.</p>
          <p className="mt-3"><strong>Failed payment.</strong> If a payment fails, Stripe tries to charge it again. {native ? <>Meanwhile you can update your card outside the app, in Stripe&rsquo;s customer portal.</> : <>Meanwhile, when you use BonBox in a browser, the Plan &amp; Billing page shows that the payment failed, and you can update your card there.</>} If the payment still does not go through, the subscription ends and the account moves to the Free plan; your data stays in the account.</p>
          <p className="mt-3"><strong>Price changes.</strong> We may change our prices. We give at least 30 days&rsquo; notice by e-mail before a price change applies to your running subscription, and you may cancel the subscription before the change takes effect. We do not raise the founding price while your subscription stays active without a break.</p>
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
            "BonBox" and the BonBox logo are trademarks of DukaanAI v/Manoz Chaudhary (CVR 46417321).
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
            We may update these terms from time to time. When we make significant changes, we will notify you via email or through a notice in BonBox at least 14 days before the changes take effect. Price changes follow &sect;8 (at least 30 days&rsquo; notice by e-mail). Continued use after the effective date constitutes acceptance. If you do not accept the changes, you can cancel your subscription or delete your account before they take effect.
          </p>
        </Section>

        <Section num={15} title="Contact and language">
          <p>For questions about these terms:</p>
          <p className="mt-2">
            <strong>DukaanAI v/Manoz Chaudhary</strong>, CVR 46417321<br />
            <strong>Email:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
            <strong>Website:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
          </p>
          <p className="mt-4">These terms exist in Danish and English. If they differ, the Danish version applies.</p>
        </Section>
      </div>
    </>
  );
}

function TermsDa({ native = false }) {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Handelsbetingelser</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm">Sidst opdateret: {termsDate(TERMS_VERSION, "da")}</p>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8" data-testid="terms-effective-dates">Gælder for nye konti fra {termsDate(TERMS_VERSION, "da")} og for eksisterende konti fra {termsDate(TERMS_EXISTING_FROM, "da")}.</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section num={1} title="Om BonBox">
          <p>
            BonBox er et værktøj til små virksomheder i restaurationsbranchen (restauranter, barer, caféer, takeaway-steder), som samler kasserapporter fra flere terminaler. Det hjælper front-of-house-personalet med at gennemføre kasseafstemningen ved vagtens afslutning og leverer den samlede kasserapport som PDF til ejere og revisorer.
          </p>
          <p className="mt-2">
            BonBox leveres af <strong>DukaanAI v/Manoz Chaudhary</strong>, CVR 46417321 (»vi«, »os«). Du kan kontakte os på <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>.
          </p>
          <p className="mt-2">BonBox er en tjeneste til virksomheder. Disse vilkår gælder mellem os og den virksomhed, der opretter kontoen.</p>
          <p className="mt-2">Ved at oprette en konto eller bruge BonBox accepterer du disse vilkår.</p>
        </Section>

        <Section num={2} title="Hvad BonBox er — og hvad BonBox ikke er">
          <p className="font-semibold mb-2">BonBox er:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Et værktøj, der ved vagtens afslutning samler kasserapporterne fra flere terminaler</li>
            <li>Et system til OCR-aflæsning og sammentælling af udskrevne kasserapporter</li>
            <li>Et værktøj til registrering af data til fakturaer og kørselsgodtgørelse</li>
            <li>Et værktøj, der danner kasserapporter som PDF</li>
            <li>Et rapporteringslag, der eksporterer til Dinero / Billy / e-conomic</li>
            <li>Et valgfrit værktøj til at følge din private økonomi (personlig tilstand — gratis; der kan ikke købes betalte abonnementer til den, se § 8)</li>
          </ul>
          <p className="font-semibold mt-4 mb-2">BonBox er IKKE:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Regnskabssoftware som defineret i bogføringsloven</li>
            <li>Et certificeret bogføringssystem (registreret digitalt bogføringssystem)</li>
            <li>Et kassesystem (POS) — BonBox behandler ikke korttransaktioner og erstatter ikke dit kasseapparat</li>
            <li>En tjeneste til skatterådgivning eller indberetning af skat</li>
            <li>En betalingsformidler — BonBox hverken flytter, opbevarer eller overfører penge</li>
            <li>En erstatning for professionel rådgivning om regnskab, jura eller økonomi</li>
          </ul>

          {/* The English version shows this notice in both languages. Here the
              Danish sentence is kept word for word, and the English paragraph's
              extra sentence ("If your business is legally required…") is added
              in Danish so nothing is lost for a reader of this version. */}
          <div className="mt-6 bg-amber-50 dark:bg-amber-900/20 border-l-4 border-amber-400 dark:border-amber-600 rounded-r-lg p-4 space-y-2 text-sm">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              Vigtigt: BonBox er ikke et registreret digitalt bogføringssystem
            </p>
            <p className="text-amber-900/90 dark:text-amber-100/90">
              BonBox er <strong>ikke</strong> et registreret digitalt
              bogføringssystem under Erhvervsstyrelsens anmelderordning, jf.
              bogføringsloven (2024). BonBox skal bruges sammen med din revisor eller
              et registreret bogføringssystem (f.eks. Dinero, Billy, e-conomic).
              Hvis din virksomhed efter loven skal bruge et registreret system, skal
              du fortsat bruge et sådant sammen med BonBox.
            </p>
          </div>
        </Section>

        <Section num={3} title="Din konto">
          <p>
            Du er ansvarlig for at holde dine loginoplysninger fortrolige. Du er ansvarlig for al aktivitet på din konto. Du skal give korrekte oplysninger, når du opretter din konto. Du må kun oprette én konto pr. person.
          </p>
          <p className="mt-2">Vi forbeholder os ret til at suspendere eller slette konti, der overtræder disse vilkår, eller som har været inaktive i mere end 24 måneder.</p>
        </Section>

        <Section num={4} title="Dine data">
          <p>Alle økonomiske data, du indtaster i BonBox, tilhører dig. Vi gør ikke krav på ejerskab over dine data.</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Du kan til enhver tid hente en kopi af dine data som en CSV-fil (Profil)</li>
            <li>Du kan til enhver tid slette din konto under Profil. Sletningen beder om din adgangskode: har du oprettet kontoen med Google, Apple eller et e-maillink, så vælg først en adgangskode via »Glemt?« på login-siden, eller skriv til <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>. Har kontoen teammedlemmer med eget login, skal de fjernes først.</li>
            <li>Se vores <Link to="/privacy" className="text-blue-600 dark:text-blue-400 hover:underline">privatlivspolitik</Link> for alle detaljer om, hvordan vi behandler data</li>
          </ul>

          <p className="font-semibold mt-4">Dit regnskabsmateriale</p>
          <p className="mt-1">Efter bogføringsloven er det dig — ikke BonBox — der skal opbevare din virksomheds regnskabsmateriale, som hovedregel i 5 år fra udgangen af det regnskabsår, materialet vedrører. BonBox er ikke et registreret bogføringssystem (se § 2) og er ikke et arkiv, du kan regne med til den pligt. Hent dine data og de PDF'er, du har brug for (f.eks. kasserapporter og fakturaer), før du sletter din konto.</p>

          <p className="font-semibold mt-4">Ændringslog</p>
          <p className="mt-1">Ændringer af økonomiske poster (f.eks. når en faktura markeres som betalt eller annulleres) skrives i en ændringslog med handlingen, tidspunktet, din IP-adresse og tilstanden før og efter. Loggen kan ikke redigeres eller slettes gennem BonBox — hverken af dig eller af os.</p>

          <p className="font-semibold mt-4">Sletning af din konto</p>
          <p className="mt-1">Når du sletter din konto, sletter vi kontoen og dataene i den med det samme. Vi beholder ændringsloggen, sikkerheds- og fejlloggene og billederne af de regnskabsbilag, du har uploadet (fotos af kasserapporter, kvitteringer og salg samt filer fra lagerimport); billederne gemmer vi i ca. 6 år efter sletningen og sletter dem derefter. Er der ingen fakturaer til dig hos Stripe, sletter vi også dine kundeoplysninger hos Stripe. Er der fakturaer, beholder vi kundeoplysningerne og fakturaerne hos Stripe, fordi vi skal opbevare vores egne regnskabsbilag i 5 år fra udgangen af regnskabsåret; derefter sletter vi dem. Kopier i vores sikkerhedskopier forsvinder, når sikkerhedskopierne udløber. Et aktivt abonnement stopper samtidig (se § 8).</p>
        </Section>

        <Section num={5} title="Økonomiske rapporter og forbehold">
          <p>BonBox laver rapporter, herunder daglige oversigter, kasserapport, MOMS-estimater og ugerapporter. Rapporterne er udelukkende til din virksomheds interne brug.</p>
          <div className="mt-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-3 text-sm">
            <p><strong>Kasserapporter og økonomiske oversigter</strong>, som BonBox laver, er værktøjer, der hjælper dig med at holde orden i dit materiale. De er ikke certificerede regnskabsdokumenter. Få altid din revisor til at kontrollere vigtigt økonomisk materiale.</p>
            <p><strong>MOMS-beregninger</strong> i BonBox er estimater baseret på de data, du indtaster. De er ikke officielle indberetninger. Du er ansvarlig for at indsende korrekte momsangivelser til SKAT eller den relevante skattemyndighed. Kontakt din revisor eller skatterådgiver i officielle skattespørgsmål.</p>
            <p><strong>Omsætningsprognoser og scorer for forretningssundhed</strong> er estimater baseret på dine historiske data. De er ikke en garanti for fremtidige resultater.</p>
            <p><strong>BonBox er ikke ansvarlig</strong> for økonomiske tab, skattemæssige sanktioner eller forretningsbeslutninger, der træffes på grundlag af data eller rapporter fra BonBox. Resultaternes nøjagtighed afhænger fuldt ud af nøjagtigheden af de data, du leverer.</p>
          </div>
        </Section>

        <Section num={6} title="Import af bankdata">
          <p>Når du uploader en CSV-fil fra din bank:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Du bekræfter, at du har ret til at tilgå og dele dataene fra bankkontoen</li>
            <li>BonBox har kun læseadgang til transaktionsdata — vi kan ikke igangsætte betalinger eller overførsler</li>
            <li>Den automatiske kategorisering af transaktioner er et forslag, som ikke altid er korrekt — gennemgå altid importerede transaktioner</li>
            <li>Du kan slette de posteringer, en import har oprettet (salg og udgifter)</li>
          </ul>
        </Section>

        <Section num={7} title="Opslag i virksomhedsregistre">
          <p>Når du bruger funktionen til opslag i virksomhedsregistre:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>BonBox henter offentligt tilgængelige virksomhedsoplysninger fra myndighedernes registre (CVR i Danmark, Companies House i Storbritannien osv.)</li>
            <li>Disse oplysninger er offentligt tilgængelige i henhold til lovgivningen og er ikke fortrolige</li>
            <li>Du er ansvarlig for at kontrollere, at automatisk udfyldte oplysninger er korrekte</li>
            <li>BonBox er ikke ansvarlig for fejl i data fra myndighedernes registre</li>
          </ul>
        </Section>

        <Section num={8} title="Abonnement og betaling">
          <p><strong>Planer og priser.</strong> BonBox har en gratis plan (Free) og to betalte abonnementer (Starter og Pro). {native ? <>Abonnementer administreres uden for appen.</> : <>Priserne står på <a href="/#pricing" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk under Priser</a> og på siden Abonnement &amp; betaling, når du bruger BonBox i en browser.</>} Priserne er pr. virksomhed, i danske kroner og pr. måned. Beløbet, du skal betale, vises ved betalingen, før du bekræfter købet. Alle planer har forbrugslofter (f.eks. hvor mange kvitteringer du kan scanne pr. måned). Vi kan ændre, begrænse eller fjerne funktioner og forbrugslofter med rimeligt varsel.</p>
          <p className="mt-3"><strong>Kun for virksomheder.</strong> Betalte abonnementer er kun for virksomheder. Når du køber et abonnement, bekræfter du, at du køber det til din virksomhed og ikke som forbruger. En konto, der er oprettet til privatøkonomi (personlig tilstand), kan bruge BonBox gratis, men kan ikke købe et betalt abonnement. Da abonnementerne sælges mellem virksomheder, gælder forbrugeraftalelovens regler om fortrydelsesret ikke.</p>
          <p className="mt-3"><strong>Prøveperiode.</strong> En ny konto får 14 dage med Pro-funktionerne gratis og uden betalingskort. Køber du ikke et abonnement, overgår kontoen til Free-planen, når prøveperioden slutter, og du bliver ikke opkrævet. Køber du et abonnement i prøveperioden, angiver du et betalingskort ved betalingen, og det første træk sker, når prøveperioden slutter.</p>
          <p className="mt-3"><strong>Betaling og fornyelse.</strong> Betalingen håndteres af Stripe. Abonnementet betales forud for én måned ad gangen med betalingskort eller en anden betalingsmetode, som Stripe tilbyder ved betalingen, og det fornyes automatisk hver måned, indtil det bliver opsagt. Vi opkræver aldrig betaling med tilbagevirkende kraft.</p>
          <p className="mt-3" data-testid="terms-founding-price"><strong>Stifterpris.</strong> Så længe færre end 100 virksomheder har et betalt abonnement hos os, får nye abonnementer stifterprisen{native ? "." : <>: Starter 129 kr. og Pro 249 kr. pr. måned (normalpris: Starter 199 kr. og Pro 349 kr.).</>} Du beholder stifterprisen, så længe dit abonnement er aktivt uden afbrydelse. Opsiger du abonnementet, eller ophører det, fordi en betaling ikke går igennem, mister du stifterprisen, og et nyt abonnement senere koster den pris, der gælder på det tidspunkt.</p>
          <p className="mt-3" data-testid="terms-plan-switch"><strong>Skift af plan.</strong> {native ? <>Et skift mellem Starter og Pro foretager vi for dig uden for appen.</> : <>Vil du skifte mellem Starter og Pro, så skriv til <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a> — så skifter vi planen for dig.</>} Skiftet gælder fra den dag, vi skifter. Prisforskellen for resten af perioden lægges på næste betaling eller fratrækkes.</p>
          <p className="mt-3"><strong>Opsigelse.</strong> {native ? <>Du kan opsige abonnementet når som helst. Det sker uden for appen, i Stripes kundeportal.</> : <>Du kan opsige abonnementet når som helst, når du bruger BonBox i en browser: på siden Abonnement &amp; betaling vælger du Administrer abonnement, som åbner Stripes kundeportal.</>} Opsigelsen får virkning ved udgangen af den periode, du har betalt for. Indtil da beholder du planens funktioner; derefter overgår kontoen til Free-planen, og dine data bliver i kontoen. Vi refunderer ikke for en del af en periode.</p>
          <p className="mt-3"><strong>Sletning af kontoen.</strong> Sletter du din konto, stopper et aktivt abonnement med det samme, og der refunderes ikke for resten af perioden.</p>
          <p className="mt-3"><strong>Betaling, der mislykkes.</strong> Mislykkes en betaling, forsøger Stripe at trække beløbet igen. {native ? <>Imens kan du opdatere dit kort uden for appen, i Stripes kundeportal.</> : <>Imens kan du, når du bruger BonBox i en browser, se på siden Abonnement &amp; betaling, at betalingen er fejlet, og opdatere dit kort der.</>} Går betalingen stadig ikke igennem, ophører abonnementet, og kontoen overgår til Free-planen; dine data bliver i kontoen.</p>
          <p className="mt-3"><strong>Prisændringer.</strong> Vi kan ændre vores priser. En prisændring på dit løbende abonnement varsler vi pr. e-mail mindst 30 dage, før den får virkning, og du kan opsige abonnementet, før ændringen træder i kraft. Stifterprisen hæver vi ikke, så længe dit abonnement er aktivt uden afbrydelse.</p>
        </Section>

        <Section num={9} title="Acceptabel brug">
          <p>Du indvilliger i ikke at:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Bruge BonBox til ulovlige formål</li>
            <li>Forsøge at få adgang til andre brugeres data</li>
            <li>Uploade skadelige filer eller forsøge at kompromittere BonBox' sikkerhed</li>
            <li>Bruge automatiserede værktøjer til at skrabe data fra eller overbelaste BonBox' servere</li>
            <li>Fremstille rapporter fra BonBox, som om de var certificerede regnskabsdokumenter</li>
            <li>Videresælge eller videredistribuere BonBox' tjeneste uden tilladelse</li>
          </ul>
        </Section>

        <Section num={10} title="Tilgængelighed og support">
          <p>
            BonBox leveres »som den er« og »som den er tilgængelig«. Vi stræber efter høj tilgængelighed, men garanterer ikke uafbrudt drift. Vi yder support via e-mail (<a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>) efter bedste evne.
          </p>
        </Section>

        <Section num={11} title="Ansvarsbegrænsning">
          <p>I det videst mulige omfang, som dansk ret og EU-ret tillader:</p>
          <ul className="list-disc pl-6 space-y-2 mt-2">
            <li>BonBox leveres uden garantier af nogen art, hverken udtrykkelige eller underforståede</li>
            <li>Vi er ikke ansvarlige for direkte eller indirekte skader, hændelige skader eller følgeskader, der opstår som følge af din brug af BonBox</li>
            <li>Vi er ikke ansvarlige for økonomiske tab, overskredne skattefrister, forkerte skatteberegninger eller forretningsbeslutninger baseret på data fra BonBox</li>
            <li>Vores samlede ansvar kan ikke overstige det beløb, du har betalt os i de 12 måneder forud for kravet</li>
          </ul>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Denne begrænsning udelukker ikke ansvar for svig, grov uagtsomhed eller andet, som ikke kan udelukkes efter dansk ret.</p>
        </Section>

        <Section num={12} title="Lovvalg og tvister">
          <p>
            Disse vilkår er underlagt dansk ret. Eventuelle tvister skal afgøres ved domstolene i København, Danmark, som eksklusivt værneting.
          </p>
          <p className="mt-2">Før du indleder en retssag, opfordrer vi dig til at kontakte os på <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>, så vi kan forsøge at løse sagen direkte.</p>
        </Section>

        <Section num={13} title="Varemærker og tredjeparters navne">
          <p>
            »BonBox« og BonBox-logoet er varemærker tilhørende DukaanAI v/Manoz Chaudhary (CVR 46417321).
          </p>
          <p className="mt-3">
            Alle andre produkt-, tjeneste- og virksomhedsnavne, der nævnes i BonBox eller i
            vores markedsføringsmateriale — herunder, men ikke begrænset til,{" "}
            <strong>Dinero</strong>, <strong>Billy</strong>, <strong>e-conomic</strong>,{" "}
            <strong>Visma</strong>, <strong>Saldi</strong>, <strong>Uniconta</strong>,{" "}
            <strong>MobilePay</strong>, <strong>Dankort</strong>, <strong>Apple</strong>,{" "}
            <strong>App Store</strong>, <strong>Google Play</strong>, <strong>Anthropic</strong>{" "}
            og <strong>Claude</strong> — er varemærker eller registrerede varemærker tilhørende
            deres respektive ejere. Navnene nævnes udelukkende:
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>For at beskrive interoperabilitet (f.eks. »eksporterer til Dineros CSV-format«)</li>
            <li>Som sammenlignende eller faktuel henvisning (nominativ fair use)</li>
            <li>For korrekt at oplyse om tredjepartstjenester, vi bruger (Anthropic til AI, Apple til iOS osv.)</li>
          </ul>
          <p className="mt-3">
            Brugen af disse navne indebærer ikke nogen anbefaling, sponsorering, partnerskab
            eller tilknytning mellem varemærkeejeren og BonBox. BonBox drives uafhængigt og
            er <strong>ikke</strong> tilknyttet eller anbefalet af nogen af de ovennævnte
            parter.
          </p>
          <p className="mt-3">
            Sammenlignende eller konkurrencemæssige udsagn, som BonBox fremsætter i
            markedsføringen, er baseret på offentligt tilgængelige oplysninger og udbyderens
            vurdering i god tro på tidspunktet for offentliggørelsen. Hvis et udsagn virker
            forkert, så kontakt os på <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a>, så gennemgår vi det hurtigst muligt.
          </p>
        </Section>

        <Section num={14} title="Ændringer af disse vilkår">
          <p>
            Vi kan opdatere disse vilkår fra tid til anden. Når vi foretager væsentlige ændringer, giver vi dig besked via e-mail eller gennem en meddelelse i BonBox mindst 14 dage, før ændringerne træder i kraft. Prisændringer følger § 8 (mindst 30 dages varsel pr. e-mail). Fortsat brug efter ikrafttrædelsesdatoen betragtes som accept. Accepterer du ikke ændringerne, kan du opsige dit abonnement eller slette din konto, før de træder i kraft.
          </p>
        </Section>

        <Section num={15} title="Kontakt og sprog">
          <p>Hvis du har spørgsmål til disse vilkår:</p>
          <p className="mt-2">
            <strong>DukaanAI v/Manoz Chaudhary</strong>, CVR 46417321<br />
            <strong>E-mail:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
            <strong>Hjemmeside:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
          </p>
          <p className="mt-4">Vilkårene findes på dansk og engelsk. Ved uoverensstemmelse gælder den danske version.</p>
        </Section>
      </div>
    </>
  );
}

export default function TermsPage() {
  const { lang } = useLanguage();
  // Danish reads the Danish document; every other UI language reads English.
  const docLang = lang === "da" ? "da" : "en";
  const c = CHROME[docLang];
  // The iPhone app gets the § 8 variant without links or instructions to buy
  // or manage outside the app (see the note above CHROME).
  const native = isNativeApp();
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
            <Link to="/privacy" className="text-gray-400 hover:text-white transition">{c.privacy}</Link>
            <Link to="/cookies" className="text-gray-400 hover:text-white transition">{c.cookies}</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {docLang === "da" ? <TermsDa native={native} /> : <TermsEn native={native} />}

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium">&larr; {c.back}</Link>
          <div className="flex gap-4 text-sm text-gray-400">
            <Link to="/privacy" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.privacy}</Link>
            <Link to="/cookies" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.cookies}</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
