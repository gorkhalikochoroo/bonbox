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
 * The price section is #pricing (Terms § 8 links to /#pricing).
 * Orvexlo / audit round (3 Nov 2026):
 *   - Timer · Lager · Økonomi: each title is an h3 (styled as the old <b>) under a hidden h2 that carries the section's
 *     name (landingV6.more.label), so heading navigation reaches the three rows; nothing visible changes;
 *   - the Starter and Pro cards print their Z-bon photo reads a day too (PLAN_LIMITS z_report_scans_per_day: 20 / 100,
 *     never "unlimited"), and one line under the cards says what every plan has and what starts at Starter
 *     (landingV6.price.allPlans; billing.py: PLAN_CAPS invoices_per_month 0 on Free, PLAN_FEATURES bank_auto_reconcile
 *     and time_registration False on Free; clock-in, approved hours, the payroll export and stock are not gated);
 *   - one salon question (landingV6.faq.salonQ / salonA): a service, a stylist or the first free one, and a time on the
 *     booking page; each stylist is bookable in the opening hours or only on their published shifts (R7).
 * Fix round 2 (10 Nov 2026; landing review fixes 1–3, the owner's answers in bonbox-lab-state/landing-review-2026-11-10/SPEC.md):
 *   - prices: the headline's first-N are the Terms' ("virksomheder med et betalt abonnement"); the subhead is the flat-price line
 *     (landingV6.price.flat: one subscription per account, quantity 1, in stripe_billing.py; no fee or revenue share anywhere in
 *     billing), the founding-price condition follows it; Starter and Pro say tables are unlimited too (PLAN_LIMITS
 *     bookable_resources_max -1); the door tablet takes no login (stand_link.py pairs a device with a code; the team_users cap
 *     is enforced in team.py only); every plan ends with a quiet outlined button (Gratis: "Start gratis" → /register);
 *   - the MOMS line: PRICE_MOMS_BASIS is "none" (the seller is not registered for moms), so the note says no moms comes on top;
 *     the "exact amount at checkout" sentence left the price note (it read as a surcharge waiting);
 *   - beside the price button: a quiet question link (mailto with a subject, site.js askHref) and the address as text;
 *   - who is behind it (Founder): the founder's text as it was, then the company with the CVR linked to the public register,
 *     the main button and the trial line. No photo, no surname, no set-up promise (the owner, 10 Nov). On the one-column page
 *     (under 1200 px) the block sits directly under the prices (#bag); from 1200 px it stays beside the questions. It is in
 *     the markup twice and the stylesheet shows one (the other is display:none: not rendered, not read out, not focusable);
 *   - Tryghed: one row naming the two apps on the App Store (linked off Android; the names are the apps' own).
 * Polish pass (10 Nov 2026, after the reviews):
 *   - the end of the prices on the one-column page (under 1200 px) showed three identical "Prøv gratis" buttons and the address
 *     twice on one phone screen. There the address under the question link is not shown (the block right below carries it as a
 *     link; landingV6.css), and the "who is behind it" block ends with the company line and the address link: no button and no
 *     trial line of its own (the bottom bar carries the page's one "Prøv gratis" again once the price button has scrolled away).
 *     From 1200 px nothing changed: the copy beside the questions keeps its button and trial line, the address stands beside the
 *     question link;
 *   - the App Store row names the apps by their listings' titles (read on the two listings, 10 Nov): "BonBox Daily Close" and
 *     "BonBox Vagtplan" on the Danish store, "BonBox Daily Close" and "BonBox Shifts" on the English one. The row's first name
 *     is the owner app, its second the staff app (appLinks: by position, the names differ by language). */
import { Link } from "react-router-dom";
import { FOUNDING_LIMIT, PLAN_PRICES } from "../../../lib/planPrices";
import { PLAN_LIMITS, teamBesidesOwner } from "../../../lib/planLimits";
import { PRICE_MOMS_BASIS } from "../v2/pricing";
import StoreLink from "./StoreLink";
import { rich } from "./rich";
import { APP_STORE, CONTACT_EMAIL, CVR_REGISTER, LEGAL_LINES, askHref } from "./site";

/* Who is behind BonBox. up: the one-column page's copy, its own section under the prices (an h2); it ends with the company line
   and the address link (polish, 10 Nov: the price button is one screen above it, and the bottom bar is up again while it is
   read). Otherwise the copy beside the questions (an h3 under their h2), which ends with the main button and the trial line. */
function Founder({ t, up }) {
  const Label = up ? "h2" : "h3";
  return (
    <div className="human" data-r="" style={{ "--dl": ".06s" }}>
      <Label className="label" id={up ? "bag-h" : undefined}>{t("landingV6.founder.label")}</Label>
      <p className="hm-1">{t("landingV6.founder.name")}</p>
      <p className="hm-2">{t("landingV6.founder.reply")}</p>
      <p className="hm-c">{rich(t("landingV6.founder.company", { company: LEGAL_LINES[0], cvr: LEGAL_LINES[1] }), (c) => <a className="tlink" href={CVR_REGISTER} target="_blank" rel="noopener noreferrer">{c}</a>)}</p>
      <p className="hm-m"><a className="tlink" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
      {up ? null : <div className="hm-go"><Link className="btn btn-lg" to="/register">{t("landingV6.cta")}</Link><span className="hm-t">{t("landingV6.trialEnd")}</span></div>}
    </div>
  );
}

export default function Sheet({ t, isAndroid }) {
  const free = PLAN_LIMITS.free, starter = PLAN_LIMITS.starter, pro = PLAN_LIMITS.pro;
  const momsNote = PRICE_MOMS_BASIS === "excl" ? t("landingV6.price.momsExcl") : PRICE_MOMS_BASIS === "incl" ? t("landingV6.price.momsIncl") : PRICE_MOMS_BASIS === "none" ? t("landingV6.price.momsNone") : null;
  /* the two apps by their App Store titles, the owner app first, then the staff app (the titles differ by language, so the link
     goes by position); off Android each name is its App Store link (an Android visitor cannot use that store) */
  const appLinks = () => { const to = [APP_STORE.owner, APP_STORE.scheduler]; let i = 0; return (name) => { const href = to[i++]; return isAndroid || !href ? name : <a className="tlink" href={href}>{name}</a>; }; };
  return (
    <div className="sheet" id="sheet">
      <section className="sec wrap" id="mere" aria-labelledby="mere-h">
        <h2 className="sr" id="mere-h">{t("landingV6.more.label")}</h2>
        <ul className="rows">
          <li data-r="" style={{ "--dl": "0s" }}><span className="mn" aria-hidden="true">04</span><h3>{t("landingV6.more.hours")}</h3><p>{t("landingV6.more.hoursBody")}</p></li>
          <li data-r="" style={{ "--dl": ".06s" }}><span className="mn" aria-hidden="true">05</span><h3>{t("landingV6.more.stock")}</h3><p>{t("landingV6.more.stockBody")}</p></li>
          <li data-r="" style={{ "--dl": ".12s" }}><span className="mn" aria-hidden="true">06</span><h3>{t("landingV6.more.money")}</h3><p>{t("landingV6.more.moneyBody")}</p></li>
        </ul>
      </section>

      <section className="sec wrap" id="pricing" aria-labelledby="pricing-h">
        <div className="rail">
          <div className="lead">
            <p className="label" data-r="">{t("landingV6.price.eyebrow")}</p>
            <h2 className="ph" id="pricing-h" data-r="">{t("landingV6.price.headline", { founding: PLAN_PRICES.starter.founding, n: FOUNDING_LIMIT, regular: PLAN_PRICES.starter.regular })}</h2>
            <p className="psub" data-r="" style={{ "--dl": ".04s" }}>{t("landingV6.price.flat")}</p>
            <p className="psub pkeep" data-r="" style={{ "--dl": ".06s" }}>{t("landingV6.price.subhead")}</p>
          </div>
          <div className="body">
            <ul className="prices">
              <li className="price free" data-r="" style={{ "--dl": "0s" }}><span className="pn"></span><span className="pp">{t("landingV6.price.freeName")}</span><span className="then">{t("landingV6.price.noCard")}</span><span className="pd"><span className="pos">{t("landingV6.price.freePos")}</span><span className="inc"><span>{t("landingV6.price.freeTeam", { users: free.team_users, branches: free.branches, staff: free.staff_members })}</span><span>{t("landingV6.price.freeResv", { resv: free.reservations_per_month, tables: free.bookable_resources_max })}</span><span>{t("landingV6.price.freeScans", { scans: free.z_report_scans_per_day })}</span></span><span className="pick"><Link className="btn btn-q" to="/register">{t("landingV6.price.pickFree")}</Link></span></span></li>
              <li className="price" data-r="" style={{ "--dl": ".06s" }}><span className="pn">{t("landingV6.price.starterName")}</span><span className="pp">{t("landingV6.price.perMonth", { price: PLAN_PRICES.starter.founding })}</span><span className="then">{t("landingV6.price.then", { n: FOUNDING_LIMIT, price: PLAN_PRICES.starter.regular })}</span><span className="pd"><span className="pos">{t("landingV6.price.starterPos")}</span><span className="inc"><span>{t("landingV6.price.starterTeam", { team: teamBesidesOwner("starter"), staff: starter.staff_members })}</span><span>{t("landingV6.price.unlimited")}</span><span>{t("landingV6.price.paidScans", { scans: starter.z_report_scans_per_day })}</span></span><span className="pick"><Link className="btn btn-q" to="/register?plan=starter">{t("landingV6.price.pickStarter")}</Link></span></span></li>
              <li className="price" data-r="" style={{ "--dl": ".12s" }}><span className="pn">{t("landingV6.price.proName")}</span><span className="pp">{t("landingV6.price.perMonth", { price: PLAN_PRICES.pro.founding })}</span><span className="then">{t("landingV6.price.then", { n: FOUNDING_LIMIT, price: PLAN_PRICES.pro.regular })}</span><span className="pd"><span className="pos">{t("landingV6.price.proPos")}</span><span className="inc"><span>{t("landingV6.price.proTeam", { branches: pro.branches, team: teamBesidesOwner("pro"), staff: pro.staff_members })}</span><span>{t("landingV6.price.unlimited")}</span><span>{t("landingV6.price.paidScans", { scans: pro.z_report_scans_per_day })}</span></span><span className="pick"><Link className="btn btn-q" to="/register?plan=pro">{t("landingV6.price.pickPro")}</Link></span></span></li>
            </ul>
            <p className="pall" data-r="" style={{ "--dl": ".13s" }}>{t("landingV6.price.allPlans")}</p>
            <p className="pall" data-r="" style={{ "--dl": ".13s" }}>{t("landingV6.price.standNoLogin")}</p>
            <p className="pnote" data-r="" style={{ "--dl": ".14s" }}>{rich(t("landingV6.price.note"))} {t("landingV6.price.noteCancel")}</p>
            {momsNote ? <p className="pnote">{momsNote}</p> : null}
            <div className="prices-cta" id="pcta" data-r="">
              <Link className="btn btn-lg" to="/register">{t("landingV6.cta")}</Link>
              <p className="ask">{rich(t("landingV6.ask.line"), (c) => <a className="tlink" href={askHref(t("landingV6.ask.subject"))}>{c}</a>)} <span className="ask-at">{CONTACT_EMAIL}</span></p>
            </div>
          </div>
        </div>
      </section>

      <section className="sec wrap bag" id="bag" aria-labelledby="bag-h">
        <Founder t={t} up />
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
            <li data-r="" style={{ "--dl": ".12s" }}><span className="t">{rich(t("landingV6.trust.apps"), appLinks())}</span></li>
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
            <details className="qa" data-r="" style={{ "--dl": ".15s" }}><summary><span>{t("landingV6.faq.salonQ")}</span><i aria-hidden="true"></i></summary><p>{t("landingV6.faq.salonA")}</p></details>
          </div>
          <Founder t={t} />
        </div>
      </section>
    </div>
  );
}
