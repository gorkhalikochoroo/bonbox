import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";

function CookieTable({ headers, rows }) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="text-left px-4 py-2.5 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([cookie, purpose, type, duration], i) => (
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
  );
}

// The page chrome around the document (nav + footer). The policy itself is NOT
// split into dictionary keys: each language is one whole document below
// (CookiesEn / CookiesDa), so a reviewer can read — and a lawyer can approve —
// each version top to bottom. Keep the two in step: same sections, same order,
// same cookie names. If you change one, change the other in the same commit.
const CHROME = {
  en: { privacy: "Privacy", terms: "Terms", back: "Back to BonBox" },
  da: { privacy: "Privatliv", terms: "Vilkår", back: "Tilbage til BonBox" },
};

function CookiesEn() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Cookie Policy</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Last updated: 8 October 2026</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-6 text-gray-700 dark:text-gray-300 leading-relaxed">

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">What are cookies?</h2>
          <p>Cookies are small text files stored on your device when you visit a website. They help the website remember your preferences and keep you logged in.</p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Cookies we use</h2>
          <p>BonBox uses only essential cookies that are strictly necessary for the service to function. We do not use advertising, tracking, or analytics cookies from third parties.</p>

          <CookieTable
            headers={["Cookie", "Purpose", "Type", "Duration"]}
            rows={[
              ["bonbox_session", "Keeps you logged in. HttpOnly, so page scripts cannot read it.", "Necessary", "30 days, or until you log out"],
              ["bonbox_csrf", "Protects against cross-site request forgery. Readable by our own scripts on purpose — that is how the check works.", "Necessary", "30 days, or until you log out"],
              ["bonbox_acct_client", "Only set for accountants: remembers which client's books you are looking at. HttpOnly.", "Necessary", "30 days, or until you log out"],
            ]}
          />
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Things we store in your browser that are not cookies</h2>
          <p>
            Cookies are not the only way a site stores things on your device, and the rules
            (ePrivacy Art. 5(3), and cookiebekendtgørelsen here in Denmark) cover the others too. So
            they belong on this page even though your browser files them separately.
          </p>
          <p className="mt-2">
            BonBox keeps around twenty small values in your browser's local storage. They stay on your
            device and are not sent to us as cookies are. They fall into four groups:
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              <strong>Settings you chose</strong> — language, currency, dark mode, which branch you are
              viewing, whether the sidebar is collapsed, your recent searches, and which tips you have
              dismissed.
            </li>
            <li>
              <strong>Signing you in</strong> — an access token, a copy of your own account details for
              the app to render, and, for staff using a shared device, proof that a PIN was entered.
              Clearing site data signs you out.
            </li>
            <li>
              <strong>Your cookie answer</strong> — <code>bonbox_cookie_consent</code>, so we do not ask
              again on every visit.
            </li>
            <li>
              <strong>A printed flyer's campaign code — only if you allow Analytics</strong> —{" "}
              <code>bonbox_signup_ref</code>. If you opened BonBox from the QR code on a BonBox flyer, the
              address ends in a short code such as <code>?ref=r1-a-03</code> (round, argument, visit). If
              you then create an account, the code goes with it, so we can count which round of visits
              led to accounts. Without Analytics consent the code is held only while the page is open and
              never written to your device. With it, it is kept for up to 30 days. Either way it is removed
              when you create an account or sign in, and withdrawing consent removes it.
            </li>
          </ul>
          <p className="mt-2">
            None of it is used for advertising, profiling or tracking you between sites — the flyer code
            only counts which visits led to a signup. You can wipe all of it by clearing site data for
            bonbox.dk in your browser.
          </p>
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
            The three cookies above are strictly necessary, and under the ePrivacy Directive those do
            not require consent. You will still see a consent banner on your first visit. It is there
            for the optional analytics category, which is switched off until you turn it on. No
            analytics tool is loaded. Turning it on lets us keep a flyer's campaign code (above) on your
            device for up to 30 days; declining keeps it off your device. If we ever add an analytics
            tool, the banner is already the gate, and declining will keep it from loading.
          </p>
          <p className="mt-2">
            Your answer is remembered in local storage under <code>bonbox_cookie_consent</code>. Clear
            your browser's site data for bonbox.dk to be asked again.
          </p>
          <p className="mt-2">
            You can delete cookies at any time through your browser settings. Deleting the session
            cookie logs you out of BonBox.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Contact</h2>
          <p>If you have questions about our use of cookies:</p>
          <p className="mt-2">
            <strong>Email:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
            <strong>Website:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
          </p>
          {/* e-handelsloven §7 wants a name, a real address and a CVR on a
              page like this — "email us" is not an identifiable trader.
              Values are the CVR register's, not the ones printed on the
              app's own gavekort template. */}
          <p className="mt-3">
            BonBox is a product of <strong>DukaanAI v/Manoz Chaudhary</strong>, registered in Denmark
            as a Personligt ejet Mindre Virksomhed.<br />
            Registered in Copenhagen, Denmark · CVR{" "}
            <a href="https://datacvr.virk.dk/enhed/virksomhed/46417321" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">46417321</a>
          </p>
        </section>
      </div>
    </>
  );
}

function CookiesDa() {
  return (
    <>
      <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-2">Cookiepolitik</h1>
      <p className="text-gray-500 dark:text-gray-400 text-sm mb-8">Senest opdateret: 8. oktober 2026</p>

      <div className="prose prose-gray dark:prose-invert max-w-none space-y-6 text-gray-700 dark:text-gray-300 leading-relaxed">

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Hvad er cookies?</h2>
          <p>Cookies er små tekstfiler, der gemmes på din enhed, når du besøger en hjemmeside. De hjælper hjemmesiden med at huske dine præferencer og holde dig logget ind.</p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Cookies, vi bruger</h2>
          <p>BonBox bruger kun nødvendige cookies, som er strengt nødvendige for, at tjenesten kan fungere. Vi bruger ikke cookies fra tredjeparter til annoncering, sporing eller analyse.</p>

          <CookieTable
            headers={["Cookie", "Formål", "Type", "Varighed"]}
            rows={[
              ["bonbox_session", "Holder dig logget ind. HttpOnly, så sidens scripts ikke kan læse den.", "Nødvendig", "30 dage, eller indtil du logger ud"],
              ["bonbox_csrf", "Beskytter mod forfalskede forespørgsler fra andre hjemmesider (cross-site request forgery). Kan med vilje læses af vores egne scripts — det er sådan, kontrollen fungerer.", "Nødvendig", "30 dage, eller indtil du logger ud"],
              ["bonbox_acct_client", "Sættes kun for revisorer: husker, hvilken klients regnskab du kigger på. HttpOnly.", "Nødvendig", "30 dage, eller indtil du logger ud"],
            ]}
          />
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Det, vi gemmer i din browser, som ikke er cookies</h2>
          <p>
            Cookies er ikke den eneste måde, en hjemmeside kan gemme ting på din enhed, og reglerne
            (ePrivacy-direktivets artikel 5, stk. 3, og cookiebekendtgørelsen her i Danmark) omfatter også
            de andre måder. Derfor hører de med på denne side, selv om din browser gemmer dem separat.
          </p>
          <p className="mt-2">
            BonBox gemmer omkring tyve små værdier i din browsers lokale lager (local storage). De bliver
            på din enhed og sendes ikke til os, sådan som cookies gør. De falder i fire grupper:
          </p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>
              <strong>Indstillinger, du har valgt</strong> — sprog, valuta, mørk tilstand, hvilken afdeling
              du ser på, om sidemenuen er klappet sammen, dine seneste søgninger, og hvilke tips du har
              lukket.
            </li>
            <li>
              <strong>Login</strong> — et adgangstoken, en kopi af dine egne kontooplysninger, som appen
              viser, og, for personale på en delt enhed, bevis for, at der er indtastet en PIN-kode.
              Hvis du rydder webstedsdata, bliver du logget ud.
            </li>
            <li>
              <strong>Dit svar om cookies</strong> — <code>bonbox_cookie_consent</code>, så vi ikke spørger
              igen ved hvert besøg.
            </li>
            <li>
              <strong>Kampagnekoden fra en trykt folder — kun hvis du tillader Analyse</strong> —{" "}
              <code>bonbox_signup_ref</code>. Hvis du åbnede BonBox fra QR-koden på en BonBox-folder, slutter
              adressen med en kort kode som <code>?ref=r1-a-03</code> (runde, argument, besøg). Opretter du
              derefter en konto, følger koden med, så vi kan tælle, hvilken besøgsrunde der førte til
              konti. Uden samtykke til Analyse holdes koden kun, mens siden er åben, og skrives aldrig på
              din enhed. Med samtykke gemmes den i op til 30 dage. Den fjernes under alle omstændigheder,
              når du opretter en konto eller logger ind, og den fjernes, hvis du trækker dit samtykke
              tilbage.
            </li>
          </ul>
          <p className="mt-2">
            Intet af det bruges til annoncering, profilering eller til at spore dig på tværs af
            hjemmesider — folderkoden tæller kun, hvilke besøg der førte til en oprettelse. Du kan slette
            det hele ved at rydde webstedsdata for bonbox.dk i din browser.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Det bruger vi IKKE</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Ingen cookies fra Google Analytics</li>
            <li>Ingen Meta/Facebook Pixel</li>
            <li>Ingen cookies til annoncering eller retargeting</li>
            <li>Ingen sporingscookies fra tredjeparter af nogen art</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Dine valg</h2>
          <p>
            De tre cookies ovenfor er strengt nødvendige, og efter ePrivacy-direktivet kræver sådanne
            cookies ikke samtykke. Du vil alligevel se et samtykkebanner ved dit første besøg. Det er der
            for den valgfrie kategori til analyse, som er slået fra, indtil du slår den til. Der indlæses
            intet analyseværktøj. Slår du den til, må vi gemme kampagnekoden fra en folder (se ovenfor) på
            din enhed i op til 30 dage; afviser du, kommer den ikke på din enhed. Hvis vi en dag tilføjer
            et analyseværktøj, fungerer banneret allerede som adgangskontrol, og hvis du afviser, bliver
            det ikke indlæst.
          </p>
          <p className="mt-2">
            Dit svar gemmes i det lokale lager under <code>bonbox_cookie_consent</code>. Ryd din browsers
            webstedsdata for bonbox.dk for at blive spurgt igen.
          </p>
          <p className="mt-2">
            Du kan til enhver tid slette cookies via din browsers indstillinger. Hvis du sletter
            sessionscookien, bliver du logget ud af BonBox.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-8 mb-3">Kontakt</h2>
          <p>Hvis du har spørgsmål om vores brug af cookies:</p>
          <p className="mt-2">
            <strong>E-mail:</strong> <a href="mailto:contact@bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">contact@bonbox.dk</a><br />
            <strong>Hjemmeside:</strong> <a href="https://bonbox.dk" className="text-blue-600 dark:text-blue-400 hover:underline">bonbox.dk</a>
          </p>
          {/* Same trader identification as the English version (e-handelsloven
              §7): name, company form, place of registration and CVR. */}
          <p className="mt-3">
            BonBox er et produkt fra <strong>DukaanAI v/Manoz Chaudhary</strong>, der er registreret i
            Danmark som Personligt ejet Mindre Virksomhed.<br />
            Registreret i København, Danmark · CVR{" "}
            <a href="https://datacvr.virk.dk/enhed/virksomhed/46417321" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">46417321</a>
          </p>
        </section>
      </div>
    </>
  );
}

export default function CookiePolicyPage() {
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
            <Link to="/terms" className="text-gray-400 hover:text-white transition">{c.terms}</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {docLang === "da" ? <CookiesDa /> : <CookiesEn />}

        <div className="mt-12 pt-8 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium">&larr; {c.back}</Link>
          <div className="flex gap-4 text-sm text-gray-400">
            <Link to="/privacy" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.privacy}</Link>
            <Link to="/terms" className="hover:text-gray-600 dark:hover:text-gray-300 transition">{c.terms}</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
