/* The ten real screens of the v6 landing, in the page's two languages.
 *
 * Fix round 2 (10 Nov 2026, review fix 5; Manoj: "this is bonbox inside so update accordingly landing page"): the pictures are the
 * CURRENT app. Every screen was opened again in the app as it is on this branch (the worktree's frontend and backend on this Mac,
 * on scratch copies of the story's demo venue; nothing from production) and compared with the picture the page had:
 *   - retaken, because the app has changed: the 10.00 week plan (the 3 Nov schedule: section tints, "1 vagt" pills, a check on
 *     every seen shift), the 12.30 guest page (its language switch and header) and the 16.40 next-shift card (it now names who
 *     you work with);
 *   - retaken for the crop: 16.40 is the card cut at its own rounded edge (phones under 780 px tall: its upper section, to the
 *     card's own divider), the 22.50 tiles at twice the resolution, the 00.10 photo step with the main button whole in both
 *     languages (the phone crop is taller; the wide one is the whole phone screen with the app's own tab bar);
 *   - kept, because the app renders them the same today: the 22.50 floor plan and the 00.10 MOMS card;
 *   - gone as a picture: the phone's "Sidder nu" tile is text on the page now (Stage.jsx), not a 252 px image.
 * How each was made, the measurements and the comparison with the live screens: bonbox-lab-state/landing-review-2026-11-10/fix2/
 * NOTES-B.md (tools-b/: the captures and the crops; crop only, no pixel resampled or drawn).
 *
 * Danish (<name>.webp) and English (<name>.en.webp; 23 Oct 2026, Manoj: "eng should be eng and danish should be danish") are the
 * same screen, moment, demo data, crop and WebP quality, the app in each language. Locked Danish terms the English app keeps
 * (MOMS, Kasserapport, Z-bon) and demo data (venue and table names, kr. amounts) stay as the app shows them.
 *
 * imagesFor(lang): the set for the page's language (site.js pageLangFor: Danish for "da", English for every other
 * app language, as the page itself), so the page references one language's files only: one <img> per picture,
 * never a hidden twin, never a second download. Width / height belong to the picture, not the language: each twin
 * has the same pixels (landingV6Assets.test.jsx reads both files' headers), so the page reserves the same box and the
 * engine's layout is the same in both languages.
 *
 * Imported through Vite, so they ship hashed under /assets/ (1-year immutable cache; sw.js fetches /assets/*
 * network-first, so a changed picture is never served stale). Nothing goes into public/. Every picture is over Vite's
 * 4 KB inline limit, so each is a file of its own and the landing chunk carries no picture.
 * Every picture is demo data and carries "Eksempel · demodata" / "Example · demo data" on the page. */
import { pageLangFor } from "./site";
import vagtUgeDa from "./img/vagt-uge-v9.webp";
import vagtUgeEn from "./img/vagt-uge-v9.en.webp";
import bookingGuestDa from "./img/booking-gaest-v2.webp";
import bookingGuestEn from "./img/booking-gaest-v2.en.webp";
import bookingGuestWideDa from "./img/bord-gaest-v2.webp";
import bookingGuestWideEn from "./img/bord-gaest-v2.en.webp";
import staffNextShiftDa from "./img/vagt-naeste-v9.webp";
import staffNextShiftEn from "./img/vagt-naeste-v9.en.webp";
import staffCardDa from "./img/vagt-kort-v9.webp";
import staffCardEn from "./img/vagt-kort-v9.en.webp";
import standFloorDa from "./img/2250_stand_bordplan.webp";
import standFloorEn from "./img/2250_stand_bordplan.en.webp";
import standTilesDa from "./img/stand-tal3.webp";
import standTilesEn from "./img/stand-tal3.en.webp";
import closePhotoDa from "./img/kasse-foto-v2.webp";
import closePhotoEn from "./img/kasse-foto-v2.en.webp";
import closePhotoWholeDa from "./img/kasse-foto-hel-v8.webp";
import closePhotoWholeEn from "./img/kasse-foto-hel-v8.en.webp";
import closeMomsDa from "./img/kasse-moms.webp";
import closeMomsEn from "./img/kasse-moms.en.webp";

// one picture: its pixel box, and its Danish and English file (the English file is the Danish name + ".en")
const pic = (name, width, height, da, en) =>
  Object.freeze({ width, height, da: Object.freeze({ src: da, file: `${name}.webp` }), en: Object.freeze({ src: en, file: `${name}.en.webp` }) });

export const IMG = Object.freeze({
  // 10.00, desktop: the week plan (Personale + MAN + I DAG; Køkken and Bar, to the end of the Bar section)
  vagtUge: pic("vagt-uge-v9", 1440, 1572, vagtUgeDa, vagtUgeEn),
  // 12.30, phone: the guest's booking page
  bookingGuest: pic("booking-gaest-v2", 800, 578, bookingGuestDa, bookingGuestEn),
  // 12.30, from 768 px: the guest's booking page, taller crop
  bookingGuestWide: pic("bord-gaest-v2", 1179, 1212, bookingGuestWideDa, bookingGuestWideEn),
  // 16.40, phones under 780 px tall: the next-shift card's upper section, down to the card's own divider
  staffNextShift: pic("vagt-naeste-v9", 1074, 766, staffNextShiftDa, staffNextShiftEn),
  // 16.40, tall phones and from 768 px: the whole next-shift card, cut at its own rounded edge
  staffCard: pic("vagt-kort-v9", 1074, 1024, staffCardDa, staffCardEn),
  // 22.50: the stand's floor plan (phone crops it; from 768 px whole)
  standFloor: pic("2250_stand_bordplan", 1101, 690, standFloorDa, standFloorEn),
  // 22.50, from 768 px: the two number tiles (Gæster · Sidder nu; en: Covers · Seated now)
  standTiles: pic("stand-tal3", 1010, 214, standTilesDa, standTilesEn),
  // 00.10, the stacked phone page: the Kasserapport photo step (the pinned phone story shows the Z-bon itself)
  closePhoto: pic("kasse-foto-v2", 1083, 1024, closePhotoDa, closePhotoEn),
  // 00.10, from 768 px: the whole photo step screen
  closePhotoWhole: pic("kasse-foto-hel-v8", 1179, 1880, closePhotoWholeDa, closePhotoWholeEn),
  // 00.10: MOMS worked out (the Kassen card)
  closeMoms: pic("kasse-moms", 1095, 1511, closeMomsDa, closeMomsEn),
});

// the two sets, built once: { key: { src, file, width, height } } in one language
const setOf = (code) => Object.freeze(Object.fromEntries(Object.entries(IMG).map(([k, v]) => [k, Object.freeze({ ...v[code], width: v.width, height: v.height })])));
const SETS = Object.freeze({ da: setOf("da"), en: setOf("en") });

/** The page's pictures for an app language: Danish for "da", English for every language that reads the English page. */
export const imagesFor = (lang) => SETS[pageLangFor(lang)];
