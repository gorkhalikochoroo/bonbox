/* The eleven real screens of the v6 landing (port step 2, PORT_PLAN 1.8), in the page's two languages.
 *
 * Danish (<name>.webp): byte-for-byte copies of the v6.3 prototype's pictures
 * (bonbox-lab-state/landing-v4-2026-10-21/final/site/img/), the v8 / c15 / v7 recaptures included.
 * English (<name>.en.webp, 23 Oct 2026; Manoj: "eng should be eng and danish should be danish"): byte-for-byte
 * copies of the English captures (bonbox-lab-state/landing-v4-2026-10-21/captures-en/img/, report.json): the same
 * demo data, moment, crop, size and WebP quality as each Danish twin, the app in English. The 10.00 week plan is the
 * capture's alternate box (captures-en/img/alt/vagt-uge-v8.en.alt.webp, 5 px left, no Wednesday sliver), saved under
 * the main name; decisions 23 Oct ~08:10. Locked Danish terms the English app keeps (MOMS, Kasserapport, Z-bon) and
 * demo data (venue and table names, kr. amounts) stay as the app shows them.
 *
 * imagesFor(lang): the set for the page's language (site.js pageLangFor: Danish for "da", English for every other
 * app language, as the page itself), so the page references one language's files only: one <img> per picture,
 * never a hidden twin, never a second download. Width / height belong to the picture, not the language: each twin
 * has the same pixels (landingV6Assets.test.jsx reads both files' headers), so the page reserves the same box and the
 * engine's layout is the same in both languages.
 *
 * Imported through Vite, so they ship hashed under /assets/ (1-year immutable cache; sw.js fetches /assets/*
 * network-first, so a changed picture is never served stale). Nothing goes into public/. Vite inlines a file under
 * its 4 KB limit as a data: URI into the landing chunk (CSP img-src allows data:): the Danish stand-sidder (2.6 KB)
 * stays inlined as before; its English twin is imported with ?no-inline, a file of its own, so the chunk every
 * visitor waits for at first paint does not carry an English picture a Danish reader never sees (inlined it cost
 * +3.4 KB gzip on the chunk; as a file +0.4 KB). Every other picture is over 4 KB and always a file.
 * Every picture is demo data and carries "Eksempel · demodata" / "Example · demo data" on the page. */
import { pageLangFor } from "./site";
import vagtUgeDa from "./img/vagt-uge-v8.webp";
import vagtUgeEn from "./img/vagt-uge-v8.en.webp";
import bookingGuestDa from "./img/1945_booking_gaest.webp";
import bookingGuestEn from "./img/1945_booking_gaest.en.webp";
import bookingGuestWideDa from "./img/bord-gaest.webp";
import bookingGuestWideEn from "./img/bord-gaest.en.webp";
import staffNextShiftDa from "./img/1640_vagtplan_naeste_vagt_c15.webp";
import staffNextShiftEn from "./img/1640_vagtplan_naeste_vagt_c15.en.webp";
import staffAppDa from "./img/vagt-app-v8.webp";
import staffAppEn from "./img/vagt-app-v8.en.webp";
import standSeatedDa from "./img/stand-sidder.webp";
import standSeatedEn from "./img/stand-sidder.en.webp?no-inline";
import standFloorDa from "./img/2250_stand_bordplan.webp";
import standFloorEn from "./img/2250_stand_bordplan.en.webp";
import standTilesDa from "./img/stand-tal2.webp";
import standTilesEn from "./img/stand-tal2.en.webp";
import closePhotoDa from "./img/kasse-foto.webp";
import closePhotoEn from "./img/kasse-foto.en.webp";
import closePhotoWholeDa from "./img/kasse-foto-hel-v7.webp";
import closePhotoWholeEn from "./img/kasse-foto-hel-v7.en.webp";
import closeMomsDa from "./img/kasse-moms.webp";
import closeMomsEn from "./img/kasse-moms.en.webp";

// one picture: its pixel box, and its Danish and English file (the English file is the Danish name + ".en")
const pic = (name, width, height, da, en) =>
  Object.freeze({ width, height, da: Object.freeze({ src: da, file: `${name}.webp` }), en: Object.freeze({ src: en, file: `${name}.en.webp` }) });

export const IMG = Object.freeze({
  // 10.00, desktop: the week plan (Personale + MAN + I DAG)
  vagtUge: pic("vagt-uge-v8", 962, 1572, vagtUgeDa, vagtUgeEn),
  // 12.30, phone: the guest's booking page
  bookingGuest: pic("1945_booking_gaest", 800, 578, bookingGuestDa, bookingGuestEn),
  // 12.30, from 768 px: the guest's booking page, taller crop
  bookingGuestWide: pic("bord-gaest", 1179, 1212, bookingGuestWideDa, bookingGuestWideEn),
  // 16.40, phone: the staff member's next shift (card crop)
  staffNextShift: pic("1640_vagtplan_naeste_vagt_c15", 786, 570, staffNextShiftDa, staffNextShiftEn),
  // 16.40, tall phones and from 768 px: the whole Vagtplan app screen
  staffApp: pic("vagt-app-v8", 1170, 1100, staffAppDa, staffAppEn),
  // 22.50, phone: the stand's "Sidder nu" tile at 1:1
  standSeated: pic("stand-sidder", 252, 107, standSeatedDa, standSeatedEn),
  // 22.50: the stand's floor plan (phone crops it; from 768 px whole)
  standFloor: pic("2250_stand_bordplan", 1101, 690, standFloorDa, standFloorEn),
  // 22.50, from 768 px: the two number tiles (Gæster · Sidder nu; en: Covers · Seated now)
  standTiles: pic("stand-tal2", 505, 107, standTilesDa, standTilesEn),
  // 00.10, phone: the Kasserapport photo step
  closePhoto: pic("kasse-foto", 1083, 924, closePhotoDa, closePhotoEn),
  // 00.10, from 768 px: the whole photo step screen
  closePhotoWhole: pic("kasse-foto-hel-v7", 1179, 1880, closePhotoWholeDa, closePhotoWholeEn),
  // 00.10: MOMS worked out (the Kassen card)
  closeMoms: pic("kasse-moms", 1095, 1511, closeMomsDa, closeMomsEn),
});

// the two sets, built once: { key: { src, file, width, height } } in one language
const setOf = (code) => Object.freeze(Object.fromEntries(Object.entries(IMG).map(([k, v]) => [k, Object.freeze({ ...v[code], width: v.width, height: v.height })])));
const SETS = Object.freeze({ da: setOf("da"), en: setOf("en") });

/** The page's pictures for an app language: Danish for "da", English for every language that reads the English page. */
export const imagesFor = (lang) => SETS[pageLangFor(lang)];
