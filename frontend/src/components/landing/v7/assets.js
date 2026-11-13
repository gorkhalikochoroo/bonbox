/* The v7 landing's pictures and fixed facts (not copy: never translated, never through t()).
 *
 * Pictures: the design's app screens (demo data), served from public/static/landing-v7/ (Vercel: 1 h cache + revalidate
 * in the background, vercel.json /static/*). Every tablet screen also comes as an 800 px wide cut (the hero's two as
 * 700 and 1100 px cuts) and every phone screen as a 320 px wide cut (cwebp), so a phone downloads the size it draws.
 * sched-pub (the published week) is the design's screen with one line changed (12 Nov 2026): "Personalet har fået besked
 * om de 6 nye vagter" now reads "Personalet ser den i Vagtplan-appen" (no notification claim). tips (Drikkepenge, coming
 * soon) is the design's screen without a payroll file or a named payroll system: "Godkend og send til Danløn" reads
 * "Godkend fordelingen", "Hent lønfil (CSV)" reads "Eksportér (CSV)", the "Danløn ›" link is gone. egen (Egenkontrol, shipped)
 * is not the design's screen: it is a real screenshot of the shipped kitchen-iPad screen (/kitchen/<token>, "I dag", Danish,
 * light, iPad landscape 1180 x 820 at 2x, scaled to 1600 x 1112) on demo data entered through the API (Bistro Nørrebro,
 * fredag 13. november 2026 at 14:10; taken 13 Nov 2026). The design's mock showed things that are not built (a cooling
 * section, an Allergener tab, a Service | Egenkontrol switch, 65 °C hot holding). width / height are the full file's, so
 * the box is known before the picture arrives (no shift).
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

/* The hero's sizes follow its stage (landingV7.css, 12 Nov 2026): from 1100 px the iPad's screen is 0.815 x the stage and
 * the phone's 0.2256 x. The stage is at most 1152 px (the live page's) up to a 1279 px window and on any window up to
 * 1362 px tall, so the screens draw at most 939 / 260 px there (the 1100 / 320 px files at 1x, as live); on a taller window
 * it grows with the height, (100vh - 642px) x 1.6, so the screens follow 1.304 x 100vh - 837px and 0.361 x 100vh - 232px
 * (the column caps the stage at 1680 px, so on the tallest windows these say a little more than is drawn, never less). */
export const SIZES = Object.freeze({
  heroTablet: "(max-width: 719px) calc(100vw - 40px), (max-width: 1099px) calc(84vw - 40px), (max-width: 1279px) 940px, (max-height: 1362px) 940px, calc(130.4vh - 837px)",
  heroPhone: "(max-width: 719px) 40vw, (max-width: 1099px) 22vw, (max-width: 1279px) 260px, (max-height: 1362px) 260px, calc(36.1vh - 232px)",
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
