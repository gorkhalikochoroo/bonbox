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
 * A mount that fails half-way leaves the static page and is reported through the client-error beacon. */
import { useLayoutEffect, useRef } from "react";
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
  return <LandingV6 key={pageLang} t={t} lang={pageLang} isAndroid={isAndroidBrowser()} onLang={setLang} />;
}

function LandingV6({ t, lang, isAndroid, onLang }) {
  const ref = useRef(null);
  useLayoutEffect(() => mountLanding(ref.current, { onError: engineFailed }), []);
  return (
    <div ref={ref} className="lp6" data-page="landing" lang={lang} data-bb-consent-skip="">
      <a className="skip" href="#main">{t("landingV6.skip")}</a>
      <div id="night" aria-hidden="true"></div>
      <TopBar t={t} lang={lang} onLang={onLang} />
      <main id="main">
        <section className="aften" id="aften" aria-labelledby="aften-h">
          <Hero t={t} />
          <Stage t={t} isAndroid={isAndroid} />
          <Dock t={t} />
        </section>
        <Sheet t={t} isAndroid={isAndroid} />
      </main>
      <Footer t={t} isAndroid={isAndroid} />
      <div id="probe" aria-hidden="true" style={PROBE}></div>
    </div>
  );
}
