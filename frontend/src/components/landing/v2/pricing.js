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
 * null  -> the page says nothing about MOMS on the price.
 * "excl" -> every price on the landing gets "ekskl. moms" / "excl. VAT".
 * "incl" -> every price on the landing gets "inkl. moms" / "incl. VAT".
 * "none" -> the seller is not registered for moms: the customer pays the listed
 *           price, and the landing says "Der kommer ikke moms oven i prisen."
 *           (landingV6.price.momsNone). Neither prepared sentence is true then.
 *
 * "none" since 10 Nov 2026 (landing fix round 2). Not provable from this repo;
 * it rests on the lead's read-only look at the Stripe dashboard that day: no
 * tax registration is collecting, "Set up Tax" is not done, the default
 * "Include tax in prices" is Automatic (included for DKK), and Orvexlo (a PMV)
 * is not registered for moms. The code agrees as far as it can: checkout
 * passes automatic_tax = STRIPE_AUTOMATIC_TAX, off by default (config.py), and
 * Stripe refuses a checkout with it on and no registration.
 * The day the company registers for moms, this value and the sentence change
 * in the same release as the Stripe setting.
 */
export const PRICE_MOMS_BASIS = "none";

/** The i18n key for the old (unrouted) v2 landing's MOMS note, or null: it has
 *  the two prepared sentences only, so "none" says nothing there. */
export function momsNoteKey(basis = PRICE_MOMS_BASIS) {
  if (basis === "excl") return "landingV2.pricing.momsExcl";
  if (basis === "incl") return "landingV2.pricing.momsIncl";
  return null;
}
