/* The v7 landing below the hero: the three promises, a day at the restaurant, the three jobs (shifts, tables and the
 * guest's side, the till), the add-ons, opening a new restaurant, prices, questions, the apps and the last call, the
 * footer and the phone's sticky call to action.
 *
 * Honesty (12 Nov 2026, the facts Manoj approved):
 *   - every add-on carries "Kommer snart" / "Coming soon" (AddonSoon);
 *   - screens are "Skærme fra BonBox · eksempeldata", never "real";
 *   - no notification claim: the staff see the week in the Vagtplan app;
 *   - no payroll file: an export of approved hours;
 *   - the walk-in line says what the host stand does (a free table that fits, one tap), not a "free until" time;
 *   - every price and plan number comes from lib/planPrices.js and lib/planLimits.js; the MOMS line follows
 *     PRICE_MOMS_BASIS (components/landing/v2/pricing.js), the one place that fact is kept;
 *   - no competitor, no founder, no set-up promise.
 * Links are real links: Prøv gratis → /register, the plans → /register?plan=starter|pro, Log ind → /login, the two App
 * Store pages (not on Android), /contact, /privacy, /terms, /cookies. */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FOUNDING_LIMIT, FROM_PRICE, PLAN_PRICES } from "../../../lib/planPrices";
import { PLAN_LIMITS, teamBesidesOwner } from "../../../lib/planLimits";
import { momsLine } from "./moms";
import { APP_STORE, CONTACT_EMAIL, LEGAL_LINES } from "../v6/site";
import { FlowArrow } from "./icons";
import { IMG, SECTION, SIZES } from "./assets";

const TABLES_SHOTS = {
  host: { img: IMG.host, alt: "landingV7.alt.host", cap: "landingV7.tables.capHost", tab: "landingV7.tables.tabHost" },
  res: { img: IMG.res, alt: "landingV7.alt.res", cap: "landingV7.tables.capRes", tab: "landingV7.tables.tabRes" },
};
const vib = () => { try { if (navigator.vibrate) navigator.vibrate(8); } catch { /* no vibration */ } };

const Pic = ({ img, sizes, alt, className }) => (
  <img className={className} src={img.src} srcSet={img.srcSet} sizes={sizes} width={img.width} height={img.height} loading="lazy" decoding="async" alt={alt} />
);
const AddonSoon = ({ t }) => <span className="soon">{t("landingV7.addons.soon")}</span>;

function Strip({ t }) {
  return (
    <section className="strip" aria-label={t("landingV7.strip.label")}>
      <div className="wrap">
        <div className="item"><b>{t("landingV7.strip.till")}</b><span>{t("landingV7.strip.tillSub")}</span></div>
        <div className="item"><b>{t("landingV7.strip.fee")}</b><span>{t("landingV7.strip.feeSub")}</span></div>
        <div className="item"><b>{t("landingV7.strip.price")}</b><span>{t("landingV7.strip.priceSub")}</span></div>
      </div>
    </section>
  );
}

const DAY = [
  { t: "10:00", n: 1, tone: "c-sage" },
  { t: "12:30", n: 2, tone: "c-sage" },
  { t: "16:45", n: 3, tone: "c-sage" },
  { t: "18:30", n: 4, tone: "c-brass" },
  { t: "21:15", n: 5, tone: "c-brass" },
  { t: "00:10", n: 6, tone: "c-sage" },
];
function Day({ t }) {
  return (
    <section className="sec" id={SECTION.day} aria-labelledby="lp7-day-h">
      <div className="wrap">
        <div className="sec-head rv fx">
          <p className="eyebrow">{t("landingV7.day.eyebrow")}</p>
          <h2 id="lp7-day-h">{t("landingV7.day.h")}</h2>
        </div>
        <div className="log">
          {DAY.map((r) => (
            <div className="log-row rv fx" key={r.n}>
              <span className="t">{r.t}</span>
              <h3>{t(`landingV7.day.r${r.n}`)}</h3>
              <p>{t(`landingV7.day.r${r.n}s`)}</p>
              <span className={`st ${r.tone}`}>{t(`landingV7.day.st${r.n}`)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Shifts({ t }) {
  return (
    <section className="sec flush" id={SECTION.shifts} aria-labelledby="lp7-shifts-h">
      <div className="wrap feat flip">
        <div className="feat-text rv fx">
          <p className="eyebrow">{t("landingV7.nav.shifts")}</p>
          <h2 id="lp7-shifts-h">{t("landingV7.shifts.h")}</h2>
          <p className="lede">{t("landingV7.shifts.p")}</p>
          <ul className="ticks">
            <li>{t("landingV7.shifts.a")}</li>
            <li>{t("landingV7.shifts.b")}</li>
            <li>{t("landingV7.shifts.c")}</li>
          </ul>
        </div>
        <div className="rv fx">
          <div className="duo">
            <figure className="dev phone fx duo-l"><div className="scr"><Pic img={IMG.week} sizes={SIZES.duo} alt={t("landingV7.alt.week")} /></div></figure>
            <figure className="dev phone fx duo-r"><div className="scr"><Pic img={IMG.swap} sizes={SIZES.duo} alt={t("landingV7.alt.swap")} /></div></figure>
          </div>
          <span className="demo-label">{t("landingV7.demo.label")}</span>
        </div>
      </div>
    </section>
  );
}

function Tables({ t }) {
  const [shot, setShot] = useState("host");
  const [shown, setShown] = useState("host");
  const [fade, setFade] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = (k) => {
    vib();
    setShot(k);
    if (k === shown) return;
    let reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* no matchMedia */ }
    clearTimeout(timer.current);
    if (reduce) { setShown(k); return; }
    setFade(true);
    timer.current = setTimeout(() => { setShown(k); setFade(false); }, 260);
  };
  const s = TABLES_SHOTS[shown];
  return (
    <section className="sec flush" id={SECTION.tables} aria-labelledby="lp7-tables-h">
      <div className="wrap">
        <div className="wide-head rv fx">
          <div className="feat-text">
            <p className="eyebrow">{t("landingV7.nav.tables")}</p>
            <h2 id="lp7-tables-h">{t("landingV7.tables.h")}</h2>
          </div>
          <div className="side">
            <p className="lede">{t("landingV7.tables.p")}</p>
            <ul className="ticks">
              <li>{t("landingV7.tables.a")}</li>
              <li>{t("landingV7.tables.b")}</li>
              <li>{t("landingV7.tables.c")}</li>
            </ul>
          </div>
        </div>
        <div className="wide-shot rv fx">
          <div className="shot-row">
            <div className="tabs" role="tablist" aria-label={t("landingV7.tables.tabs")}>
              {Object.keys(TABLES_SHOTS).map((k) => (
                <button key={k} type="button" role="tab" id={`lp7-tab-${k}`} aria-selected={shot === k ? "true" : "false"} aria-controls="lp7-tables-shot" onClick={() => pick(k)}>{t(TABLES_SHOTS[k].tab)}</button>
              ))}
            </div>
            <p className="shot-cap">{t(TABLES_SHOTS[shot].cap)}</p>
          </div>
          <figure className="dev ipad solo fx tilt-in" id="lp7-tables-shot" role="tabpanel" aria-labelledby={`lp7-tab-${shot}`}>
            <div className="scr"><Pic className={fade ? "swap-img fade" : "swap-img"} img={s.img} sizes={SIZES.wide} alt={t(s.alt)} /></div>
          </figure>
        </div>
      </div>
    </section>
  );
}

function Guest({ t }) {
  return (
    <section className="sec flush" id="gaest" aria-labelledby="lp7-guest-h">
      <div className="wrap feat">
        <div className="feat-text rv fx">
          <p className="eyebrow">{t("landingV7.guest.eyebrow")}</p>
          <h2 id="lp7-guest-h">{t("landingV7.guest.h")}</h2>
          <p className="lede">{t("landingV7.guest.p")}</p>
          <ul className="ticks">
            <li>{t("landingV7.guest.a")}</li>
            <li>{t("landingV7.guest.b")}</li>
            <li>{t("landingV7.guest.c")}</li>
          </ul>
        </div>
        <div className="rv fx">
          <div className="trio" role="img" aria-label={t("landingV7.alt.trio")}>
            <figure className="dev phone fx fan-l"><div className="scr"><Pic img={IMG.bookEn} sizes={SIZES.trio} alt="" /></div></figure>
            <figure className="dev phone fx fan-c"><div className="scr"><Pic img={IMG.book} sizes={SIZES.trio} alt="" /></div></figure>
            <figure className="dev phone fx fan-r"><div className="scr"><Pic img={IMG.bookPt} sizes={SIZES.trio} alt="" /></div></figure>
          </div>
          <span className="demo-label">{t("landingV7.guest.label")}</span>
        </div>
      </div>
    </section>
  );
}

function Till({ t }) {
  return (
    <section className="sec flush" id={SECTION.till} aria-labelledby="lp7-till-h">
      <div className="wrap">
        <div className="wide-head rv fx">
          <div className="feat-text">
            <p className="eyebrow">{t("landingV7.nav.till")}</p>
            <h2 id="lp7-till-h">{t("landingV7.till.h")}</h2>
          </div>
          <div className="side">
            <p className="lede">{t("landingV7.till.p")}</p>
            <ul className="ticks">
              <li>{t("landingV7.till.a")}</li>
              <li>{t("landingV7.till.b")}</li>
              <li>{t("landingV7.till.c")}</li>
            </ul>
          </div>
        </div>
        <div className="wide-shot rv fx">
          <figure className="dev ipad solo fx tilt-in"><div className="scr"><Pic img={IMG.close} sizes={SIZES.wide} alt={t("landingV7.alt.close")} /></div></figure>
          <p className="shot-cap">{t("landingV7.till.cap")}</p>
        </div>
      </div>
    </section>
  );
}

const SMALL_ADDONS = [1, 2, 3, 4];
function Addons({ t }) {
  return (
    <section className="sec flush" id={SECTION.addons} aria-labelledby="lp7-addons-h">
      <div className="wrap">
        <div className="sec-head rv fx">
          <p className="eyebrow">{t("landingV7.nav.addons")}</p>
          <h2 id="lp7-addons-h">{t("landingV7.addons.h")}</h2>
          <p className="lede">{t("landingV7.addons.p")}</p>
        </div>
        <div className="addons">
          <article className="addon rv fx" data-addon="egenkontrol">
            <div className="addon-top"><span className="tag">{t("landingV7.addons.a1t")}</span><AddonSoon t={t} /></div>
            <h3>{t("landingV7.addons.a1h")}</h3>
            <p>{t("landingV7.addons.a1p")}</p>
            <div className="thumb fx"><Pic img={IMG.egen} sizes={SIZES.thumb} alt={t("landingV7.alt.egen")} /></div>
          </article>
          <article className="addon rv fx" data-addon="drikkepenge">
            <div className="addon-top"><span className="tag">{t("landingV7.addons.a2t")}</span><AddonSoon t={t} /></div>
            <h3>{t("landingV7.addons.a2h")}</h3>
            <p>{t("landingV7.addons.a2p")}</p>
            <div className="thumb fx"><Pic img={IMG.tips} sizes={SIZES.thumb} alt={t("landingV7.alt.tips")} /></div>
          </article>
        </div>
        <div className="small-addons">
          {SMALL_ADDONS.map((n) => (
            <div className="rv fx" key={n} data-addon={`s${n}`}>
              <h3>{t(`landingV7.addons.s${n}h`)}</h3>
              <p>{t(`landingV7.addons.s${n}p`)}</p>
              <AddonSoon t={t} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function NewRestaurant({ t }) {
  return (
    <section className="sec newr" id="nye" aria-labelledby="lp7-newr-h">
      <div className="wrap">
        <div className="sec-head rv fx">
          <p className="eyebrow">{t("landingV7.newr.eyebrow")}</p>
          <h2 id="lp7-newr-h">{t("landingV7.newr.h")}</h2>
          <p className="lede">{t("landingV7.newr.p")}</p>
        </div>
        <div className="flow rv fx" role="img" aria-label={t("landingV7.flow.label")}>
          <div className="node r12"><span className="cap">{t("landingV7.flow.pos")}</span><b>{t("landingV7.flow.posB")}</b><small>{t("landingV7.flow.posS")}</small></div>
          <div className="edge r12"><b className="dir">{t("landingV7.flow.e1")}</b><FlowArrow /><span>{t("landingV7.flow.e1s")}</span></div>
          <div className="node bb r12"><b>BonBox</b><small>{t("landingV7.flow.bb")}</small></div>
          <div className="edge r1"><b className="dir">{t("landingV7.flow.e2")}</b><FlowArrow /><span>{t("landingV7.flow.e2s")}</span></div>
          <div className="node r1"><span className="cap">{t("landingV7.flow.acc")}</span><b>{t("landingV7.flow.accB")}</b></div>
          <div className="edge r2"><b className="dir">{t("landingV7.flow.e3")}</b><FlowArrow /><span>{t("landingV7.flow.e3s")}</span></div>
          <div className="node r2"><span className="cap">{t("landingV7.flow.pay")}</span><b>{t("landingV7.flow.payB")}</b></div>
        </div>
        <div className="checklist rv fx">
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n}><span className="cap">{n === 1 ? t("landingV7.check.cap") : ""}</span><span>{t(`landingV7.check.c${n}`)}</span></div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing({ t }) {
  const free = PLAN_LIMITS.free, starter = PLAN_LIMITS.starter, pro = PLAN_LIMITS.pro;
  const moms = momsLine(t);
  return (
    <section className="sec" id={SECTION.prices} aria-labelledby="lp7-price-h">
      <div className="wrap">
        <div className="sec-head rv fx">
          <p className="eyebrow">{t("landingV7.price.eyebrow")}</p>
          <h2 id="lp7-price-h">{t("landingV7.price.h", { founding: PLAN_PRICES.starter.founding, n: FOUNDING_LIMIT, regular: PLAN_PRICES.starter.regular })}</h2>
          <p className="lede">{t("landingV7.price.p")}</p>
        </div>
        <div className="plans">
          <div className="plan rv fx" data-plan="free">
            <div className="pn"><span>{t("landingV7.price.freeName")}</span></div>
            <div className="price num">{t("landingV7.price.kr", { price: 0 })}</div>
            <div className="after">{t("landingV7.price.noCard")}</div>
            <p className="for">{t("landingV7.price.freeFor")}</p>
            <ul>
              <li>{t("landingV7.price.free1", { users: free.team_users, branches: free.branches, staff: free.staff_members })}</li>
              <li>{t("landingV7.price.free2", { resv: free.reservations_per_month })}</li>
              <li>{t("landingV7.price.scans", { scans: free.z_report_scans_per_day })}</li>
            </ul>
            <Link className="btn btn-line" to="/register">{t("landingV7.price.freeBtn")}</Link>
          </div>
          <div className="plan hi rv fx" data-plan="starter">
            <div className="pn"><span>{t("landingV7.price.starter")}</span><span className="badge">{t("landingV7.price.badge")}</span></div>
            <div className="price num">{t("landingV7.price.kr", { price: PLAN_PRICES.starter.founding })}<small>{t("landingV7.price.perMonth")}</small></div>
            <div className="after">{t("landingV7.price.then", { n: FOUNDING_LIMIT, price: PLAN_PRICES.starter.regular })}</div>
            <p className="for">{t("landingV7.price.starterFor")}</p>
            <ul>
              <li>{t("landingV7.price.starter1", { team: teamBesidesOwner("starter"), staff: starter.staff_members })}</li>
              <li>{t("landingV7.price.unlimited")}</li>
              <li>{t("landingV7.price.scans", { scans: starter.z_report_scans_per_day })}</li>
            </ul>
            <Link className="btn btn-brass" to="/register?plan=starter">{t("landingV7.price.starterBtn")}</Link>
          </div>
          <div className="plan rv fx" data-plan="pro">
            <div className="pn"><span>{t("landingV7.price.pro")}</span></div>
            <div className="price num">{t("landingV7.price.kr", { price: PLAN_PRICES.pro.founding })}<small>{t("landingV7.price.perMonth")}</small></div>
            <div className="after">{t("landingV7.price.then", { n: FOUNDING_LIMIT, price: PLAN_PRICES.pro.regular })}</div>
            <p className="for">{t("landingV7.price.proFor")}</p>
            <ul>
              <li>{t("landingV7.price.pro1", { branches: pro.branches, team: teamBesidesOwner("pro"), staff: pro.staff_members })}</li>
              <li>{t("landingV7.price.unlimited")}</li>
              <li>{t("landingV7.price.scans", { scans: pro.z_report_scans_per_day })}</li>
            </ul>
            <Link className="btn btn-line" to="/register?plan=pro">{t("landingV7.price.proBtn")}</Link>
          </div>
        </div>
        <p className="price-note"><b>{t("landingV7.price.noteLead")}</b> {t("landingV7.price.note")}{moms ? ` ${moms}` : ""} {t("landingV7.price.allPlans")}</p>
      </div>
    </section>
  );
}

const FAQ = [1, 2, 3, 4, 5, 6];
function Faq({ t }) {
  const moms = momsLine(t);
  const answer = (n) => {
    if (n === 5) return moms ? `${t("landingV7.faq.a5")} ${moms}` : t("landingV7.faq.a5");
    if (n === 6) return t("landingV7.faq.a6", { n: FOUNDING_LIMIT });
    return t(`landingV7.faq.a${n}`);
  };
  return (
    <section className="sec flush" id="faq" aria-labelledby="lp7-faq-h">
      <div className="wrap faq">
        <div className="sec-head rv fx">
          <p className="eyebrow">{t("landingV7.faq.eyebrow")}</p>
          <h2 id="lp7-faq-h">{t("landingV7.faq.h")}</h2>
        </div>
        <div className="qa">
          {FAQ.map((n) => (
            <details className="rv fx" key={n}><summary><span>{t(`landingV7.faq.q${n}`)}</span><span className="pm" aria-hidden="true"></span></summary><p>{answer(n)}</p></details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Start({ t, isAndroid, endRef }) {
  return (
    <section className="sec flush" id={SECTION.start} aria-labelledby="lp7-end-h" ref={endRef}>
      <div className="wrap start-in">
        <div className="apps rv fx">
          <div><h3>{t("landingV7.apps.h")}</h3><p>{t("landingV7.apps.p")}</p></div>
          <div className="btns">
            {isAndroid ? null : <a className="btn btn-ink btn-sm" href={APP_STORE.owner} rel="noopener">{t("landingV7.apps.owner")}</a>}
            {isAndroid ? null : <a className="btn btn-ink btn-sm" href={APP_STORE.scheduler} rel="noopener">{t("landingV7.apps.staff")}</a>}
            <Link className="btn btn-line btn-sm" to="/login">{t("landingV7.apps.browser")}</Link>
          </div>
        </div>
        <div className="end rv fx">
          <div><h2 id="lp7-end-h">{t("landingV7.end.h")}</h2><p>{t("landingV7.end.p", { price: FROM_PRICE })}</p></div>
          <Link className="btn btn-brass" to="/register">{t("landingV7.cta")}</Link>
        </div>
      </div>
    </section>
  );
}

/* Who sells it (e-handelsloven § 7, as the v6 footer showed it): the company from the register's own lines (the name filled
 * into the product line, then "CVR …" as LEGAL_LINES has it, never retyped), the contact address and the contact page. */
export function Footer({ t }) {
  return (
    <footer className="wrap foot">
      <div className="foot-id">
        <span>{t("landingV7.foot.line", { company: LEGAL_LINES[0] })}</span>
        <span>{LEGAL_LINES.slice(1).join(" · ")} · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></span>
      </div>
      <nav aria-label={t("landingV7.foot.legal")}>
        <Link to="/contact">{t("landingV7.foot.contact")}</Link>
        <Link to="/privacy">{t("landingV7.foot.privacy")}</Link>
        <Link to="/terms">{t("landingV7.foot.terms")}</Link>
        <Link to="/cookies">{t("landingV7.foot.cookies")}</Link>
      </nav>
    </footer>
  );
}

export function PhoneBar({ t, barRef }) {
  return (
    <div className="mbar" ref={barRef} data-bb-consent-clear="">
      <Link className="btn btn-ink" to="/register">{t("landingV7.cta14")}</Link>
    </div>
  );
}

export default function Sections({ t, isAndroid, endRef }) {
  return (
    <>
      <Strip t={t} />
      <Day t={t} />
      <Shifts t={t} />
      <Tables t={t} />
      <Guest t={t} />
      <Till t={t} />
      <Addons t={t} />
      <NewRestaurant t={t} />
      <Pricing t={t} />
      <Faq t={t} />
      <Start t={t} isAndroid={isAndroid} endRef={endRef} />
    </>
  );
}
