/* www.bonbox.dk "/" for a logged-out visitor: the v7 landing (Claude Design, 12 Nov 2026), ported from Manoj's static page
 * ("bonbox-landing 2/index.html") into React: the same markup, stylesheet and motion, with the repo's own words
 * (landingV7.* in src/i18n/da.js and en.js), prices (lib/planPrices.js, lib/planLimits.js) and links.
 *
 * Language. The page is Danish or English (pageLangV7: "da" for Danish, else "en"); a reader in another app language reads
 * the English page, never a mix, and the root's lang says so. The design's Portuguese is not offered yet (Portugal is a
 * later stage; its words wait in the lab). The menu changes the app's language (hooks/useLanguage setLang); the page
 * re-renders in place, so the reader keeps their place and the motion keeps running.
 *
 * Boot. App.jsx renders this page lazily on "/" and "/v2" (LandingRoute); for a prospect the built index.html has already
 * drawn the top bar and the hero (scripts/landingFirstScreenV7.mjs, #lp6-first) and started their arrival. React's first
 * commit equals that screen exactly, so nothing moves at takeover: the page then renders "calm", its arrival carrying on
 * from where the HTML's had got to (--lp7-elapsed; the 3D rise only while it is not over). The parts that are hidden at
 * rest (the language list, the hero's published week, tap ring, banner and toast) join right after the mount (`armed`),
 * then the motion starts (components/landing/v7/motion.js).
 *
 * The root carries data-bb-consent-skip (the motion writes on every scroll frame; the cookie banner ignores it) and the
 * phone's sticky bar is marked data-bb-consent-clear, so the banner sits on it instead of covering it. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { isAndroidBrowser } from "../components/landing/v2/platform";
import { reportClientError } from "../utils/reportClientError";
import TopBar from "../components/landing/v7/TopBar";
import Hero from "../components/landing/v7/Hero";
import Sections, { Footer, PhoneBar } from "../components/landing/v7/Sections";
import { mountMotion } from "../components/landing/v7/motion";
import { arrivalOf, pageLangV7 } from "../components/landing/v7/assets";
import { bootState } from "../components/landing/v7/boot";
import { LANDING_TITLE_VALUES, holdLandingTitle, landingTitle, shellTitle } from "../lib/shellTitles";
import "../components/landing/v7/styles";

const DARK = "(prefers-color-scheme: dark)";

export default function LandingV7Page() {
  const { lang, t, setLang } = useLanguage();
  const pageLang = pageLangV7(lang);
  const [boot] = useState(bootState);
  const { calm } = boot;
  const [armed, setArmed] = useState(false);
  const [isAndroid] = useState(() => isAndroidBrowser());
  const root = useRef(null);
  const parts = useRef({});
  const motion = useRef(null);
  useLandingTitle(pageLang, lang);
  useDarkBar();

  // the parts hidden at rest join right after the first commit (which equals the HTML's first screen)
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 0);
    return () => clearTimeout(id);
  }, []);
  useLayoutEffect(() => {
    if (!armed || !root.current) return undefined;
    try {
      motion.current = mountMotion(root.current, parts);
    } catch (err) {
      motion.current = null;
      try { console.error("Landing motion:", err); } catch { /* no console */ }
      reportClientError({ kind: "render", message: `landing v7 motion: ${(err && err.message) || err}` });
    }
    return () => { if (motion.current) motion.current.destroy(); motion.current = null; };
  }, [armed]);

  // an arrival on a section's address (/#priser …) opens the page there: the section exists only once React has drawn it,
  // after the browser's own fragment jump (the HTML's first screen is not drawn for such a visit)
  useEffect(() => {
    let id = null;
    try { id = arrivalOf(window.location.hash); } catch { id = null; }
    const el = id && root.current ? root.current.querySelector(`#${id}`) : null;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start", behavior: "auto" });
  }, []);

  const replay = () => {
    try { if (navigator.vibrate) navigator.vibrate(8); } catch { /* no vibration */ }
    if (motion.current) motion.current.play();
  };
  const put = (k) => (el) => { parts.current[k] = el; };

  return (
    <div ref={root} className={calm ? "lp7 lp7-calm" : "lp7"} data-page="landing" lang={pageLang} data-bb-consent-skip="" style={calm ? { "--lp7-elapsed": `${boot.elapsed}ms` } : undefined}>
      <a className="skip" href="#lp7-main">{t("landingV7.skip")}</a>
      <TopBar t={t} lang={pageLang} onLang={setLang} armed={armed} barRef={put("bar")} />
      <main id="lp7-main">
        <Hero t={t} armed={armed} refs={parts} onReplay={replay} enter={boot.enter} />
        <Sections t={t} isAndroid={isAndroid} endRef={put("end")} />
      </main>
      <PhoneBar t={t} barRef={put("mbar")} />
      <Footer t={t} />
    </div>
  );
}

/* The tab names the landing while it is on screen: the headline in the page's language (lib/shellTitles.js; index.html
 * ships the Danish one), handed back to the app's own title when the page goes (as the v6 page did). */
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

/* The design has a dark ground in the phone's dark mode; "/" is a paper route for the app (utils/themeColor.js), so in dark
 * mode the browser bar is given the page's night ground while the page is up, and the paper back when it goes. */
function useDarkBar() {
  useEffect(() => {
    let mq = null;
    try { mq = window.matchMedia ? window.matchMedia(DARK) : null; } catch { mq = null; }
    const meta = typeof document !== "undefined" ? document.querySelector('meta[name="theme-color"]') : null;
    if (!mq || !meta) return undefined;
    const before = meta.getAttribute("content");
    const apply = () => { if (mq.matches) meta.setAttribute("content", "#121110"); else if (before) meta.setAttribute("content", before); };
    apply();
    try { mq.addEventListener("change", apply); } catch { /* old Safari */ }
    return () => {
      try { mq.removeEventListener("change", apply); } catch { /* old Safari */ }
      if (before) meta.setAttribute("content", before);
    };
  }, []);
}
