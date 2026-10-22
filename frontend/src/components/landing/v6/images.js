/* The eleven real screens of the v6 landing (port step 2, PORT_PLAN 1.8).
 *
 * Byte-for-byte copies of the v6.3 prototype's pictures
 * (bonbox-lab-state/landing-v4-2026-10-21/final/site/img/), the v8 / c15 / v7
 * recaptures included. Imported through Vite, so they ship hashed under
 * /assets/ (1-year immutable cache; sw.js fetches /assets/* network-first, so a
 * changed picture is never served stale). Vite inlines a file under its 4 KB
 * limit as a data: URI (stand-sidder, 2.6 KB); CSP img-src allows data:.
 * Nothing goes into public/.
 *
 * width / height are each file's own pixels, exactly as the prototype's markup
 * gives them, so the page reserves the box before the picture arrives.
 * Every picture is demo data and carries "Eksempel · demodata" on the page.
 */
import vagtUge from "./img/vagt-uge-v8.webp";
import bookingGuest from "./img/1945_booking_gaest.webp";
import bookingGuestWide from "./img/bord-gaest.webp";
import staffNextShift from "./img/1640_vagtplan_naeste_vagt_c15.webp";
import staffApp from "./img/vagt-app-v8.webp";
import standSeated from "./img/stand-sidder.webp";
import standFloor from "./img/2250_stand_bordplan.webp";
import standTiles from "./img/stand-tal2.webp";
import closePhoto from "./img/kasse-foto.webp";
import closePhotoWhole from "./img/kasse-foto-hel-v7.webp";
import closeMoms from "./img/kasse-moms.webp";

export const IMG = {
  // 10.00, desktop: the week plan (Personale + MAN + I DAG)
  vagtUge: { src: vagtUge, file: "vagt-uge-v8.webp", width: 962, height: 1572 },
  // 12.30, phone: the guest's booking page
  bookingGuest: { src: bookingGuest, file: "1945_booking_gaest.webp", width: 800, height: 578 },
  // 12.30, from 768 px: the guest's booking page, taller crop
  bookingGuestWide: { src: bookingGuestWide, file: "bord-gaest.webp", width: 1179, height: 1212 },
  // 16.40, phone: the staff member's next shift (card crop)
  staffNextShift: { src: staffNextShift, file: "1640_vagtplan_naeste_vagt_c15.webp", width: 786, height: 570 },
  // 16.40, tall phones and from 768 px: the whole Vagtplan app screen
  staffApp: { src: staffApp, file: "vagt-app-v8.webp", width: 1170, height: 1100 },
  // 22.50, phone: the stand's "Sidder nu" tile at 1:1
  standSeated: { src: standSeated, file: "stand-sidder.webp", width: 252, height: 107 },
  // 22.50: the stand's floor plan (phone crops it; from 768 px whole)
  standFloor: { src: standFloor, file: "2250_stand_bordplan.webp", width: 1101, height: 690 },
  // 22.50, from 768 px: the two number tiles (Gæster · Sidder nu)
  standTiles: { src: standTiles, file: "stand-tal2.webp", width: 505, height: 107 },
  // 00.10, phone: the Kasserapport photo step
  closePhoto: { src: closePhoto, file: "kasse-foto.webp", width: 1083, height: 924 },
  // 00.10, from 768 px: the whole photo step screen
  closePhotoWhole: { src: closePhotoWhole, file: "kasse-foto-hel-v7.webp", width: 1179, height: 1880 },
  // 00.10: MOMS worked out (the Kassen card)
  closeMoms: { src: closeMoms, file: "kasse-moms.webp", width: 1095, height: 1511 },
};
