/**
 * The plan prices the landing page prints (push 9, A2/A3).
 *
 * The numbers live in lib/planPrices.js — ONE module shared with the in-app
 * plan page and the upgrade nudges, held to backend config.py
 * PLAN_PRICES_DKK and FOUNDING_MEMBER_LIMIT by a test (landingPush9Claims).
 * The founding price is stated as "129 kr./md. for the first 100 — then 199
 * kr./md.", never as a struck-through "was 199" that nobody paid.
 */
export { FOUNDING_LIMIT, FROM_PRICE, PLAN_PRICES } from "../../../lib/planPrices";

/**
 * MOMS on our own prices — NOT KNOWN from the code (push 9, A3).
 *
 * Checkout charges the Stripe Price's unit_amount; Stripe Tax is behind
 * STRIPE_AUTOMATIC_TAX (off by default, set per environment), and the Prices'
 * tax behaviour lives in the Stripe dashboard, not in this repo. Whether 129
 * kr. is "ekskl. moms" or "inkl. moms" therefore cannot be proven here, and
 * the owner has the VAT status marked [TIL AFKLARING: momsstatus].
 *
 * null  -> the page says nothing about MOMS on the price (today).
 * "excl" -> every price on the landing gets "ekskl. moms" / "excl. VAT".
 * "incl" -> every price on the landing gets "inkl. moms" / "incl. VAT".
 * Flip it here once the owner confirms; the copy for both is already keyed.
 */
export const PRICE_MOMS_BASIS = null;

/** The i18n key for the MOMS note, or null while the basis is unknown. */
export function momsNoteKey(basis = PRICE_MOMS_BASIS) {
  if (basis === "excl") return "landingV2.pricing.momsExcl";
  if (basis === "incl") return "landingV2.pricing.momsIncl";
  return null;
}
