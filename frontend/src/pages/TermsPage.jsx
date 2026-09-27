import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

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
const CHROME = {
  en: { privacy: "Privacy", cookies: "Cookies", back: "Back to BonBox" },
  da: { privacy: "Privatliv", cookies: "Cookies", back: "Tilbage til BonBox" },
};

function TermsEn() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Terms of Service</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Last updated: 13 May 2026</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section num={1} title="About BonBox">
          <p>
            BonBox is a multi-terminal close consolidation tool for small hospitality businesses (restaurants, bars, cafés, takeaways). It helps front-of-house staff complete the end-of-shift cash reconciliation in roughly 90 seconds and delivers the consolidated daily-close PDF to owners and revisors. BonBox is operated by Manoj Kumar Chaudhary, based in Copenhagen, Denmark.
          </p>
          <p className="mt-2">By creating an account or using BonBox, you agree to these terms.</p>
        </Section>

        <Section num={2} title="What BonBox is — and what it is not">
          <p className="font-semibold mb-2">BonBox is:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>A multi-terminal end-of-shift close consolidation tool</li>
            <li>An OCR-and-aggregation system for printed kasserapport receipts</li>
            <li>An invoicing (faktura) and mileage (k&oslash;rselsgodtg&oslash;relse) data-capture tool</li>
            <li>A generator of daily-close PDFs (compatible with Bogf&oslash;ringsloven &sect;10 retention)</li>
            <li>A reporting layer that exports to Dinero / Billy / e-conomic</li>
            <li>An optional personal finance tracker (in Personal Mode)</li>
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
            <li>You can export your data at any time as CSV files</li>
            <li>You can delete your account and all data at any time</li>
            <li>See our <Link to="/privacy" className="text-blue-600 dark:text-blue-400 hover:underline">Privacy Policy</Link> for full details on data handling</li>
          </ul>

          <p className="font-semibold mt-4">Mandatory retention of accounting records</p>
          <p className="mt-1">Danish law (Bogf&oslash;ringsloven &sect;12) requires us to retain accounting records — including fakturaer, kreditnotaer, mileage logs, and the related audit trail — for at least 5 years from the end of the financial year they relate to. BonBox defaults to 6 years (5-year legal minimum plus a 1-year buffer) and you can extend up to 10 years (the maximum applicable Skatteforvaltningsloven &sect;31 window) from your Profile settings. You cannot set retention below 5 years; doing so would expose you to penalties under Bogf&oslash;ringsloven &sect;16.</p>

          <p className="font-semibold mt-4">Immutable audit log</p>
          <p className="mt-1">Every financial mutation (marking an invoice paid, voiding, brand changes, etc.) is recorded in an append-only audit log capturing the action, your IP address, and before/after state. These rows cannot be edited or deleted — by you or by us — for 10 years from creation, as required by Bogf&oslash;ringsloven &sect;9. This protects you in the event of a Skattestyrelsen dispute.</p>

          <p className="font-semibold mt-4">Account deletion and the legal-retention exception</p>
          <p className="mt-1">When you delete your account, all personal and financial data is purged within 30 days <em>except</em> records the law requires us to retain. Those rows remain in cold storage for the legal window, no longer linked to your identity. Backups are purged within 90 days.</p>
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
    </>
  );
}

function TermsDa() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Servicevilkår</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Senest opdateret: 13. maj 2026</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-4 text-gray-700 dark:text-gray-300 leading-relaxed">

        <Section num={1} title="Om BonBox">
          <p>
            BonBox er et værktøj til små virksomheder i restaurationsbranchen (restauranter, barer, caféer, takeaway-steder), som samler kasserapporter fra flere terminaler. Det hjælper front-of-house-personalet med at gennemføre kasseafstemningen ved vagtens afslutning på cirka 90 sekunder og leverer den samlede kasserapport som PDF til ejere og revisorer. BonBox drives af Manoj Kumar Chaudhary, der har base i København, Danmark.
          </p>
          <p className="mt-2">Ved at oprette en konto eller bruge BonBox accepterer du disse vilkår.</p>
        </Section>

        <Section num={2} title="Hvad BonBox er — og hvad BonBox ikke er">
          <p className="font-semibold mb-2">BonBox er:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Et værktøj, der ved vagtens afslutning samler kasserapporterne fra flere terminaler</li>
            <li>Et system til OCR-aflæsning og sammentælling af udskrevne kasserapporter</li>
            <li>Et værktøj til registrering af data til fakturaer og kørselsgodtgørelse</li>
            <li>Et værktøj, der danner kasserapporter som PDF (forenelige med opbevaring efter bogføringslovens § 10)</li>
            <li>Et rapporteringslag, der eksporterer til Dinero / Billy / e-conomic</li>
            <li>Et valgfrit værktøj til at følge din private økonomi (i personlig tilstand)</li>
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
            <li>Du kan til enhver tid eksportere dine data som CSV-filer</li>
            <li>Du kan til enhver tid slette din konto og alle data</li>
            <li>Se vores <Link to="/privacy" className="text-blue-600 dark:text-blue-400 hover:underline">privatlivspolitik</Link> for alle detaljer om, hvordan vi behandler data</li>
          </ul>

          <p className="font-semibold mt-4">Lovpligtig opbevaring af regnskabsmateriale</p>
          <p className="mt-1">Dansk lov (bogføringslovens § 12) kræver, at vi opbevarer regnskabsmateriale — herunder fakturaer, kreditnotaer, kørselslogge og det tilhørende revisionsspor — i mindst 5 år fra udgangen af det regnskabsår, materialet vedrører. BonBox opbevarer som standard i 6 år (lovens minimum på 5 år plus 1 års buffer), og du kan forlænge op til 10 år (den maksimale periode, der gælder efter skatteforvaltningslovens § 31) under dine profilindstillinger. Du kan ikke sætte opbevaringen til under 5 år; det ville udsætte dig for straf efter bogføringslovens § 16.</p>

          <p className="font-semibold mt-4">Revisionslog, der ikke kan ændres</p>
          <p className="mt-1">Enhver økonomisk ændring (markering af en faktura som betalt, annullering, ændringer af branding osv.) registreres i en revisionslog, der kun kan tilføjes til, og som indeholder handlingen, din IP-adresse og tilstanden før og efter. Rækkerne kan ikke redigeres eller slettes — hverken af dig eller af os — i 10 år fra oprettelsen, som krævet af bogføringslovens § 9. Det beskytter dig, hvis der opstår en sag med Skattestyrelsen.</p>

          <p className="font-semibold mt-4">Sletning af konto og undtagelsen for lovpligtig opbevaring</p>
          <p className="mt-1">Når du sletter din konto, slettes alle personoplysninger og økonomiske data inden for 30 dage — <em>undtagen</em> materiale, som loven kræver, at vi opbevarer. Disse rækker forbliver i arkivlager i den lovpligtige periode og er ikke længere knyttet til din identitet. Sikkerhedskopier slettes inden for 90 dage.</p>
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
          <p>Når du uploader en CSV-fil fra din bank eller forbinder din bank via Open Banking:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Du bekræfter, at du har ret til at tilgå og dele dataene fra bankkontoen</li>
            <li>BonBox har kun læseadgang til transaktionsdata — vi kan ikke igangsætte betalinger eller overførsler</li>
            <li>Den automatiske kategorisering af transaktioner er et forslag, som ikke altid er korrekt — gennemgå altid importerede transaktioner</li>
            <li>Du kan til enhver tid slette alle importerede bankdata</li>
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

        <Section num={8} title="Gratis tjeneste">
          <p>BonBox stilles i øjeblikket gratis til rådighed. Vi forbeholder os ret til at:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Indføre betalte abonnementer eller premiumfunktioner i fremtiden</li>
            <li>Ændre, begrænse eller lukke funktioner med rimeligt varsel</li>
            <li>Indføre forbrugsgrænser, hvis det er nødvendigt for at opretholde tjenestens kvalitet</li>
          </ul>
          <p className="mt-2">Hvis vi indfører betalte funktioner, forbliver den eksisterende gratis funktionalitet tilgængelig. Vi opkræver ikke med tilbagevirkende kraft betaling for funktioner, du allerede bruger gratis.</p>
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
            Vi kan opdatere disse vilkår fra tid til anden. Når vi foretager væsentlige ændringer, giver vi dig besked via e-mail eller gennem en meddelelse i BonBox mindst 14 dage, før ændringerne træder i kraft. Fortsat brug efter ikrafttrædelsesdatoen betragtes som accept.
          </p>
        </Section>

        <Section num={15} title="Kontakt">
          <p>Hvis du har spørgsmål til disse vilkår:</p>
          <p className="mt-2">
            <strong>E-mail:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
            <strong>Hjemmeside:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
          </p>
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
        {docLang === "da" ? <TermsDa /> : <TermsEn />}

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
