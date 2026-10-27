// The booking page's own words (booking R5) — registered when this module is
// evaluated, i.e. with the page's code and before its first render, so the
// first paint is already in the guest's language without the ~200 KB full
// dictionary. See lib/pageDict.js and vite.config.js (bonbox-booking-dict).
import BOOKING from "virtual:bonbox-booking-dict";
import { registerPageDict } from "./pageDict";

registerPageDict(BOOKING);

export default BOOKING;
