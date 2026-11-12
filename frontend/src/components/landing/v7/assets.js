/* The v7 landing's pictures and fixed facts (not copy: never translated, never through t()).
 *
 * Pictures: the design's app screens (demo data), served from public/static/landing-v7/ (Vercel: 1 h cache + revalidate
 * in the background, vercel.json /static/*). Every tablet screen also comes as an 800 px wide cut (the hero's two as
 * 700 and 1100 px cuts) and every phone screen as a 320 px wide cut (cwebp), so a phone downloads the size it draws.
 * sched-pub (the published week) is the design's screen with one line changed (12 Nov 2026): "Personalet har fået besked
 * om de 6 nye vagter" now reads "Personalet ser den i Vagtplan-appen" (no notification claim). tips (Drikkepenge, coming
 * soon) is the design's screen without a payroll file or a named payroll system: "Godkend og send til Danløn" reads
 * "Godkend fordelingen", "Hent lønfil (CSV)" reads "Eksportér (CSV)", the "Danløn ›" link is gone. width / height are the full file's, so the box is
 * known before the picture arrives (no shift).
 *
 * HERO_TABLET is the page's largest picture on a phone's first screen: the HTML's first screen and its head preload use
 * these exact strings (scripts/landingFirstScreenV7.mjs, vite.config.js preloadLanding), so the browser fetches it once. */
export const PICS = "/static/landing-v7/";

const tablet = (name) => Object.freeze({ src: `${PICS}${name}.webp`, srcSet: `${PICS}${name}-800.webp 800w, ${PICS}${name}.webp 1600w`, width: 1600, height: 1112 });
// the hero's iPad screens: a phone's first screen draws them ~340 px wide, so they come at 700 and 1100 px too (2x / 3x)
const heroTablet = (name) => Object.freeze({ src: `${PICS}${name}.webp`, srcSet: `${PICS}${name}-700.webp 700w, ${PICS}${name}-1100.webp 1100w, ${PICS}${name}.webp 1600w`, width: 1600, height: 1112 });
const phone = (name) => Object.freeze({ src: `${PICS}${name}.webp`, srcSet: `${PICS}${name}-320.webp 320w, ${PICS}${name}.webp 640w`, width: 640, height: 1385 });

export const IMG = Object.freeze({
  schedDraft: heroTablet("sched-draft"),
  schedPub: heroTablet("sched-pub"),
  host: tablet("host"),
  res: tablet("res"),
  close: tablet("close"),
  egen: tablet("egen"),
  tips: tablet("tips"),
  staff: phone("staff"),
  week: phone("week"),
  swap: phone("swap"),
  book: phone("book"),
  bookEn: phone("book-en"),
  bookPt: phone("book-pt"),
});

/* The hero's sizes follow its stage (landingV7.css, 12 Nov 2026): from 1100 px the iPad's screen is 0.815 x the stage, which
 * is at most the column (1440 px of content up to a 2300 px window, 1600 px at 2560) and never taller than the window, so
 * up to a 1600 px window it draws about 790-1040 px wide on a laptop's window (1366 x 768 to 1440 x 900; up to 1174 on a
 * taller one) and up to 1300 px beyond (1180 picks the 1600 px file at 1x); the
 * phone's screen is 0.2256 x the stage: at most ~325 px up to a 2300 px window (the 320 px file at 1x), ~360 px beyond. */
export const SIZES = Object.freeze({
  heroTablet: "(max-width: 719px) calc(100vw - 40px), (max-width: 1099px) calc(84vw - 40px), (max-width: 1599px) 1040px, 1180px",
  heroPhone: "(max-width: 719px) 40vw, (max-width: 1099px) 22vw, (max-width: 2303px) 300px, 360px",
  wide: "(max-width: 1099px) calc(100vw - 48px), 1040px",
  duo: "(max-width: 719px) 42vw, 240px",
  trio: "(max-width: 719px) 30vw, 200px",
  thumb: "(max-width: 1099px) calc(100vw - 96px), 540px",
});

export const HERO_TABLET = Object.freeze({ ...IMG.schedDraft, sizes: SIZES.heroTablet });

/* The page's languages: Danish and English (the design's Portuguese waits for the Portugal stage, lab file). Language
 * names are endonyms, the same in every language; the code is what the menu button shows. */
export const PAGE_LANGS_V7 = Object.freeze([
  Object.freeze({ code: "da", name: "Dansk", short: "DK" }),
  Object.freeze({ code: "en", name: "English", short: "ENG" }),
]);
export const pageLangV7 = (lang) => (lang === "da" ? "da" : "en");

/* The stage's 3D rise plays only on a wide screen with a fine pointer (scripts/landingFirstScreenV7.mjs RISE_QUERY_V7,
 * the same text): on a phone or a tablet the stage sits at the first screen's foot and the rise would only delay its
 * picture. */
export const RISE_QUERY = "(hover: hover) and (pointer: fine) and (min-width: 720px)";

/* In-page sections the top bar and the hero point at. */
export const SECTION = Object.freeze({ day: "dag", shifts: "vagterne", tables: "bordene", till: "kassen", addons: "tilvalg", prices: "priser", start: "start" });

/* Every place an address may open the page on (bonbox.dk/#priser …): the sections, the questions and the top. Exact
 * strings only; anything else in the fragment is ignored. */
export const ARRIVALS = Object.freeze([...Object.values(SECTION), "gaest", "nye", "faq", "top"]);
export const arrivalOf = (hash) => {
  const id = String(hash || "").replace(/^#/, "");
  return ARRIVALS.includes(id) ? id : null;
};
