/* The landing's fixed facts: not copy, never translated, never through t().
 *
 * CONTACT_EMAIL is the address /contact, the Terms and the privacy policy give (pages/ContactPage.jsx SUPPORT_EMAIL).
 * LEGAL_LINES match the CVR register verbatim (as the old footer, components/landing/v2/FooterV2.jsx); the line
 * before them ("BonBox er et produkt fra") is copy and translates.
 * APP_STORE: the two live iPhone apps (Vagtplan = the staff app, BonBox = the owner app).
 * PAGE_LANGS / pageLangFor: the page is Danish or English; every other app language reads the English page
 * (landingV6.* exists in da.js and en.js only), never a mix (PORT_PLAN 2.2). */
export const CONTACT_EMAIL = "contact@bonbox.dk";

export const LEGAL_LINES = Object.freeze(["DukaanAI v/Manoz Chaudhary", "CVR 46417321"]);

export const APP_STORE = Object.freeze({
  scheduler: "https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793",
  owner: "https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960",
});

export const PAGE_LANGS = Object.freeze(["da", "en"]);

/** The page's language for an app language. */
export const pageLangFor = (lang) => (lang === "da" ? "da" : "en");
