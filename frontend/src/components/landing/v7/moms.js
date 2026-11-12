/* The v7 landing's MOMS sentence (the price note and the lock-in answer), from PRICE_MOMS_BASIS
 * (components/landing/v2/pricing.js), the one place that fact is kept: "none" today (Orvexlo is not registered for moms),
 * so the page says no moms comes on top; the day the basis changes, the sentence changes with it. null = no basis known. */
import { PRICE_MOMS_BASIS } from "../v2/pricing";

export function momsLine(t, basis = PRICE_MOMS_BASIS) {
  if (basis === "excl") return t("landingV7.price.momsExcl");
  if (basis === "incl") return t("landingV7.price.momsIncl");
  if (basis === "none") return t("landingV7.price.momsNone");
  return null;
}
