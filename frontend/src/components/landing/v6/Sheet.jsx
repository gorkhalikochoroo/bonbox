/* The morning sheet that rises over the night (v6.3 src.html "#sheet"): Timer · Lager · Økonomi, Priser,
 * Tryghed, Spørgsmål and who is behind it.
 *
 * Prices are frozen (Manoj, 21 Oct): names, numbers, the first-100 line and the price note are the prototype's.
 * Every number comes from lib/planPrices.js (= backend config.py) and lib/planLimits.js (= billing.py PLAN_CAPS);
 * nothing is typed. No MOMS note while PRICE_MOMS_BASIS (components/landing/v2/pricing.js) is null.
 * Added to the prototype (PORT_PLAN section 3, Claude's suggestions until Manoj answers section 8):
 *   - "Vælg Starter" / "Vælg Pro" under the paid cards (→ /register?plan=…) — item 3;
 *   - the price note's two sentences from the live footnote (the amount at checkout, the end of the paid month) — 17;
 *   - the data-handling row in Tryghed (who reads receipt images, not yet confirmed where) — 18.
 * The price section is #pricing (Terms § 8 links to /#pricing). */
import { Link } from "react-router-dom";
import { FOUNDING_LIMIT, PLAN_PRICES } from "../../../lib/planPrices";
import { PLAN_LIMITS, teamBesidesOwner } from "../../../lib/planLimits";
import { PRICE_MOMS_BASIS } from "../v2/pricing";
import StoreLink from "./StoreLink";
import { rich } from "./rich";
import { CONTACT_EMAIL } from "./site";

export default function Sheet({ t, isAndroid }) {
  const free = PLAN_LIMITS.free, starter = PLAN_LIMITS.starter, pro = PLAN_LIMITS.pro;
  const momsNote = PRICE_MOMS_BASIS === "excl" ? t("landingV6.price.momsExcl") : PRICE_MOMS_BASIS === "incl" ? t("landingV6.price.momsIncl") : null;
  return (
    <div className="sheet" id="sheet">
      <section className="sec wrap" id="mere" aria-label={t("landingV6.more.label")}>
        <ul className="rows">
          <li data-r="" style={{ "--dl": "0s" }}><span className="mn" aria-hidden="true">04</span><b>{t("landingV6.more.hours")}</b><p>{t("landingV6.more.hoursBody")}</p></li>
          <li data-r="" style={{ "--dl": ".06s" }}><span className="mn" aria-hidden="true">05</span><b>{t("landingV6.more.stock")}</b><p>{t("landingV6.more.stockBody")}</p></li>
          <li data-r="" style={{ "--dl": ".12s" }}><span className="mn" aria-hidden="true">06</span><b>{t("landingV6.more.money")}</b><p>{t("landingV6.more.moneyBody")}</p></li>
        </ul>
      </section>

      <section className="sec wrap" id="pricing" aria-labelledby="pricing-h">
        <div className="rail">
          <div className="lead">
            <p className="label" data-r="">{t("landingV6.price.eyebrow")}</p>
            <h2 className="ph" id="pricing-h" data-r="">{t("landingV6.price.headline", { founding: PLAN_PRICES.starter.founding, n: FOUNDING_LIMIT, regular: PLAN_PRICES.starter.regular })}</h2>
            <p className="psub" data-r="" style={{ "--dl": ".04s" }}>{t("landingV6.price.subhead")}</p>
          </div>
          <div className="body">
            <ul className="prices">
              <li className="price free" data-r="" style={{ "--dl": "0s" }}><span className="pn"></span><span className="pp">{t("landingV6.price.freeName")}</span><span className="then">{t("landingV6.price.noCard")}</span><span className="pd"><span className="pos">{t("landingV6.price.freePos")}</span><span className="inc"><span>{t("landingV6.price.freeTeam", { users: free.team_users, branches: free.branches, staff: free.staff_members })}</span><span>{t("landingV6.price.freeResv", { resv: free.reservations_per_month, tables: free.bookable_resources_max })}</span><span>{t("landingV6.price.freeScans", { scans: free.z_report_scans_per_day })}</span></span></span></li>
              <li className="price" data-r="" style={{ "--dl": ".06s" }}><span className="pn">{t("landingV6.price.starterName")}</span><span className="pp">{t("landingV6.price.perMonth", { price: PLAN_PRICES.starter.founding })}</span><span className="then">{t("landingV6.price.then", { n: FOUNDING_LIMIT, price: PLAN_PRICES.starter.regular })}</span><span className="pd"><span className="pos">{t("landingV6.price.starterPos")}</span><span className="inc"><span>{t("landingV6.price.starterTeam", { team: teamBesidesOwner("starter"), staff: starter.staff_members })}</span><span>{t("landingV6.price.unlimited")}</span></span><span className="pick"><Link className="tlink" to="/register?plan=starter">{t("landingV6.price.pickStarter")}</Link></span></span></li>
              <li className="price" data-r="" style={{ "--dl": ".12s" }}><span className="pn">{t("landingV6.price.proName")}</span><span className="pp">{t("landingV6.price.perMonth", { price: PLAN_PRICES.pro.founding })}</span><span className="then">{t("landingV6.price.then", { n: FOUNDING_LIMIT, price: PLAN_PRICES.pro.regular })}</span><span className="pd"><span className="pos">{t("landingV6.price.proPos")}</span><span className="inc"><span>{t("landingV6.price.proTeam", { branches: pro.branches, team: teamBesidesOwner("pro"), staff: pro.staff_members })}</span><span>{t("landingV6.price.unlimited")}</span></span><span className="pick"><Link className="tlink" to="/register?plan=pro">{t("landingV6.price.pickPro")}</Link></span></span></li>
            </ul>
            <p className="pnote" data-r="" style={{ "--dl": ".14s" }}>{rich(t("landingV6.price.note"))} {t("landingV6.price.noteCheckout")}</p>
            {momsNote ? <p className="pnote">{momsNote}</p> : null}
            <div className="prices-cta" id="pcta" data-r=""><Link className="btn btn-lg" to="/register">{t("landingV6.cta")}</Link></div>
          </div>
        </div>
      </section>

      <section className="sec wrap" id="tryghed" aria-labelledby="tryghed-h">
        <div className="rail">
          <div className="lead">
            <h2 className="label" id="tryghed-h" data-r="">{t("landingV6.trust.label")}</h2>
            <p className="tst" data-r="" style={{ "--dl": ".04s" }}>{t("landingV6.trust.noCut")}</p>
          </div>
          <ul className="body trust">
            <li data-r="" style={{ "--dl": "0s" }}><span className="t">{rich(t("landingV6.trust.db"), (c) => <Link className="tlink" to="/privacy">{c}</Link>)}</span></li>
            <li data-r="" style={{ "--dl": ".04s" }}><span className="t">{t("landingV6.trust.data")}</span></li>
            <li className="tdup" data-r="" style={{ "--dl": ".04s" }}>{t("landingV6.trust.noCut")}</li>
            <li data-r="" style={{ "--dl": ".08s" }}><b>{t("landingV6.trust.staffRole")}</b><span className="who">{t("landingV6.trust.staffDetail")}</span></li>
          </ul>
        </div>
      </section>

      <section className="sec wrap" id="faq" aria-labelledby="faq-h">
        <div className="rail">
          <div className="lead">
            <h2 className="label" id="faq-h" data-r="">{t("landingV6.faq.label")}</h2>
          </div>
          <div className="body qas">
            <details className="qa" data-r="" style={{ "--dl": "0s" }}><summary><span>{t("landingV6.faq.posQ")}</span><i aria-hidden="true"></i></summary><p>{t("landingV6.faq.posA")}</p></details>
            <details className="qa" data-r="" style={{ "--dl": ".05s" }}><summary><span>{t("landingV6.faq.trialQ")}</span><i aria-hidden="true"></i></summary><p>{t("landingV6.faq.trialA")}</p></details>
            <details className="qa" data-r="" style={{ "--dl": ".1s" }}><summary><span>{t("landingV6.faq.staffQ")}</span><i aria-hidden="true"></i></summary><p>{t("landingV6.faq.staffA")} <StoreLink app="scheduler" t={t} isAndroid={isAndroid} className="tlink" /></p></details>
          </div>
          <div className="human" data-r="" style={{ "--dl": ".06s" }}>
            <h3 className="label">{t("landingV6.founder.label")}</h3>
            <p className="hm-1">{t("landingV6.founder.name")}</p>
            <p className="hm-2">{t("landingV6.founder.reply")}</p>
            <p className="hm-m"><a className="tlink" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
          </div>
        </div>
      </section>
    </div>
  );
}
