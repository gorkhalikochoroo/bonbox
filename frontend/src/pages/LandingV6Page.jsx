/* www.bonbox.dk "/" for a logged-out visitor: the v6 landing (PORT_PLAN 1.1–1.3, port step 5).
 *
 * React renders the v6.3 prototype's DOM once, as static JSX (components/landing/v6/*: pure functions of the
 * dictionary, the page language and whether the browser is Android; no state). The prototype's scroll engine
 * (engine.js) runs as one imperative module on the root: mounted in a layout effect, so the first paint is already
 * the story layout, and torn down on unmount (it restores every attribute and text it wrote and removes every
 * listener, timer and observer). React never re-writes what the engine owns (PORT_PLAN 1.3).
 *
 * Language. The page is Danish or English: pageLang = "da" for Danish, else "en". A reader in another language
 * (Turkish today) gets the whole page in English, never a mix (landingV6.* exists in da.js and en.js only), and the
 * root's lang says so to screen readers and translators. A language change re-keys the tree: the old engine is
 * destroyed with its DOM, the new one lays out against the new text.
 *
 * Wiring (port step 7): App.jsx renders this page lazily on "/" (logged-out web visitor) and "/v2", inside its own
 * Suspense with no fallback; "/" and "/v2" are paper routes (utils/themeColor.js), so the app's browser bar and the
 * pre-paint agree with the page's paper ground, and the engine writes the night colour over it while the stage is
 * dark. The engine's default theme-color writer is the <meta> itself, which is what the app writes too, so no
 * setThemeColor is passed. data-bb-consent-skip on the root: the cookie banner's observer ignores the engine's
 * per-frame writes inside it (components/CookieConsent.jsx); the bottom bar (data-bb-consent-clear) still counts.
 * A mount that fails half-way leaves the static page and is reported through the client-error beacon.
 *
 * Fix round (gate, 22 Oct):
 *   - the root renders with .lp6-boot: transitions stay off until the engine's first layout (engine.js note 14), so no hidden
 *     stage picture fades out at load or after a language switch;
 *   - data-bb-consent-side="right": on the wide layouts the cookie banner floats bottom-right (components/CookieConsent.jsx),
 *     off the hero's trial line and button, which sit bottom-left on the two-column page;
 *   - a language switch keeps the reader where they were: the switch that was used keeps the focus (WCAG 2.4.3), open FAQ
 *     answers stay open, and in the morning sheet the section on screen stays where it was (in the day, the engine's own
 *     layout already keeps the place). The place is taken before setLang and put back after the new engine's first layout. */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { reportClientError } from "../utils/reportClientError";
import { isAndroidBrowser } from "../components/landing/v2/platform";
import { mountLanding } from "../components/landing/v6/engine";
import TopBar from "../components/landing/v6/TopBar";
import Hero from "../components/landing/v6/Hero";
import Stage from "../components/landing/v6/Stage";
import Dock from "../components/landing/v6/Dock";
import Sheet from "../components/landing/v6/Sheet";
import Footer from "../components/landing/v6/Footer";
import { pageLangFor } from "../components/landing/v6/site";
import { placeOf, putPlaceBack } from "../components/landing/v6/place";
import { LANDING_TITLE_VALUES, holdLandingTitle, landingTitle, shellTitle } from "../lib/shellTitles";
import "../components/landing/v6/styles";

// #probe = 100svh: the engine re-lays out when the small viewport changes (iOS bars, a growing frame)
const PROBE = { position: "fixed", left: "-9px", top: "0", width: "1px", height: "100svh", pointerEvents: "none", visibility: "hidden" };

/* A failed engine mount: the page stays readable (static layout), the error goes to the console and to the
 * super-admin error panel (kind "render", one of the beacon's known kinds; deduped per session by the beacon). */
function engineFailed(err) {
  try { console.error("Landing engine:", err); } catch { /* no console */ }
  reportClientError({ kind: "render", message: `landing engine: ${(err && err.message) || err}` });
}

export default function LandingV6Page() {
  const { lang, t, setLang } = useLanguage();
  const pageLang = pageLangFor(lang);
  // the reader's place across the re-key below (this component is not re-keyed, so the ref survives it)
  const carry = useRef(null);
  useLandingTitle(pageLang, lang);
  return <LandingV6 key={pageLang} t={t} lang={pageLang} isAndroid={isAndroidBrowser()} onLang={setLang} carryRef={carry} />;
}

/* The tab names the landing while it is on screen (security fix round, 23 Oct 2026; step_13 open item 9): the page's
 * headline in the page's language (lib/shellTitles.js LANDING_TITLES; index.html ships the Danish one). The app's own
 * default title (SHELL_TITLES, as on origin/main) is every signed-in page's that does not name itself, so the landing
 * holds the tab (the language provider then leaves the headline alone after a DK / EN switch) and, when it goes, hands
 * the tab back with the app's title in the language on screen then. Lives here, not in the re-keyed LandingV6, so a
 * language switch does not release and take the tab again. */
function useLandingTitle(pageLang, appLang) {
  const appLangRef = useRef(appLang);
  useEffect(() => { appLangRef.current = appLang; }, [appLang]);
  useEffect(() => {
    const release = holdLandingTitle();
    return () => {
      release();
      if (typeof document !== "undefined" && LANDING_TITLE_VALUES.includes(document.title)) document.title = shellTitle(appLangRef.current);
    };
  }, []);
  useEffect(() => {
    if (typeof document !== "undefined") document.title = landingTitle(pageLang);
  }, [pageLang]);
}

function LandingV6({ t, lang, isAndroid, onLang, carryRef }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const destroy = mountLanding(ref.current, { onError: engineFailed });
    const place = carryRef.current;
    if (place && place.to === lang) { carryRef.current = null; putPlaceBack(ref.current, place); }
    return destroy;
  }, [carryRef, lang]);
  const pick = useCallback((from) => (code) => { carryRef.current = placeOf(ref.current, from, pageLangFor(code)); onLang(code); }, [carryRef, onLang]);
  return (
    <div ref={ref} className="lp6 lp6-boot" data-page="landing" lang={lang} data-bb-consent-skip="" data-bb-consent-side="right">
      <a className="skip" href="#main">{t("landingV6.skip")}</a>
      <div id="night" aria-hidden="true"></div>
      <TopBar t={t} lang={lang} onLang={pick("top")} />
      <main id="main">
        <section className="aften" id="aften" aria-labelledby="aften-h">
          <Hero t={t} />
          <Stage t={t} isAndroid={isAndroid} />
          <Dock t={t} />
        </section>
        <Sheet t={t} isAndroid={isAndroid} />
      </main>
      <Footer t={t} isAndroid={isAndroid} lang={lang} onLang={pick("foot")} />
      <div id="probe" aria-hidden="true" style={PROBE}></div>
    </div>
  );
}
