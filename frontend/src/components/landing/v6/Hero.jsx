/* The hero (v6.3 src.html "#hero"): the three headline words jump into the day (the engine handles [data-go]),
 * the audience line, "Prøv gratis" + "Se priser" (→ #pricing), and the trial line with the lowest price from
 * lib/planPrices.js. */
import { Link } from "react-router-dom";
import { FROM_PRICE } from "../../../lib/planPrices";
import { rich } from "./rich";

export default function Hero({ t }) {
  return (
    <div className="hero" id="hero">
      <h1 className="h1"><a href="#s1" data-go="1a"><span>{t("landingV6.h1.shifts")}</span><sup aria-hidden="true">01</sup></a> <a href="#s2" data-go="2a"><span>{t("landingV6.h1.tables")}</span><sup aria-hidden="true">02</sup></a> <a href="#s6" data-go="3a"><span>{t("landingV6.h1.till")}</span><sup aria-hidden="true">03</sup></a></h1>
      <p className="sub">{t("landingV6.sub")}</p>
      <div className="cta-row"><Link className="btn btn-lg" id="hero-cta" to="/register">{t("landingV6.cta")}</Link><a className="tlink" href="#pricing">{t("landingV6.seePrices")}</a></div>
      <p className="trial">{rich(t("landingV6.trial", { price: FROM_PRICE }))}</p>
    </div>
  );
}
