/* The landing's fixed facts: not copy, never translated, never through t().
 *
 * CONTACT_EMAIL is the address /contact, the Terms and the privacy policy give (pages/ContactPage.jsx SUPPORT_EMAIL).
 * LEGAL_LINES match the CVR register verbatim (as the old footer, components/landing/v2/FooterV2.jsx): the name, then the
 * CVR. The company was renamed Orvexlo on 3 Nov 2026 (same CVR; the register shows just "Orvexlo"). The footer names the
 * product once, "BonBox – et produkt fra Orvexlo" (landingV6.foot.operatedBy, copy that translates, {company} = the
 * register's name), then the CVR line.
 * CVR_REGISTER (fix round 2, 10 Nov 2026): the public register's page for that CVR, the link /contact, /privacy and /cookies
 * already give. askHref: the question link's address, the contact address with a prefilled subject (the page's own words,
 * encoded; nothing from the visitor or the address bar goes into it).
 * APP_STORE: the two live iPhone apps (Vagtplan = the staff app, BonBox = the owner app).
 * PAGE_LANGS / pageLangFor: the page is Danish or English; every other app language reads the English page
 * (landingV6.* exists in da.js and en.js only), never a mix (PORT_PLAN 2.2). */
export const CONTACT_EMAIL = "contact@bonbox.dk";

export const LEGAL_LINES = Object.freeze(["Orvexlo", "CVR 46417321"]);

export const CVR_REGISTER = "https://datacvr.virk.dk/enhed/virksomhed/46417321";

export const askHref = (subject) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;

export const APP_STORE = Object.freeze({
  scheduler: "https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793",
  owner: "https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960",
});

export const PAGE_LANGS = Object.freeze(["da", "en"]);

/** The page's language for an app language. */
export const pageLangFor = (lang) => (lang === "da" ? "da" : "en");
