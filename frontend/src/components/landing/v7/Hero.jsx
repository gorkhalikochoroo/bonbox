/* The v7 landing's hero: the headline, the line under it, the two calls to action, the price line, and the week being
 * published on the iPad while the staff phone shows it (the design's device composition; screens with demo data).
 *
 * The first render is the HTML's first screen exactly (scripts/landingFirstScreenV7.mjs; landingV7FirstScreen.test.jsx).
 * The moving parts that are hidden at rest join once the page is mounted (`armed`): the published week over the draft,
 * the tap ring, the in-app banner on the phone and the toast. The sequence itself runs in motion.js.
 * No notification claim (honesty edit, 12 Nov 2026): the staff see the week in the Vagtplan app. */
import { Link } from "react-router-dom";
import { FROM_PRICE } from "../../../lib/planPrices";
import { Arrow, Calendar, Check } from "./icons";
import { HERO_TABLET, IMG, SECTION, SIZES } from "./assets";

const put = (refs, k) => (el) => { refs.current[k] = el; };

export default function Hero({ t, armed, refs, onReplay, enter = false }) {
  return (
    <section className="hero" aria-labelledby="lp7-h1">
      <div className="wrap">
        <div className="hero-grid">
          <div>
            <p className="eyebrow load">{t("landingV7.hero.eyebrow")}</p>
            <h1 id="lp7-h1" className="load d1">{t("landingV7.h1.shifts")}<span className="dot">.</span><br />{t("landingV7.h1.tables")}<span className="dot">.</span><br />{t("landingV7.h1.till")}<span className="dot">.</span></h1>
          </div>
          <div className="hero-side">
            <p className="lede load d2">{t("landingV7.hero.lede")}</p>
            <div className="ctas load d3">
              <Link className="btn btn-ink" to="/register"><span>{t("landingV7.cta14")}</span><Arrow /></Link>
              <a className="btn btn-line" href={`#${SECTION.day}`}>{t("landingV7.ctaDay")}</a>
            </div>
            <p className="fine load d4">{t("landingV7.hero.fine", { price: FROM_PRICE })}</p>
          </div>
        </div>
        <div className="stage-wrap load d2">
          <div className={enter ? "stage enter" : "stage"} ref={put(refs, "stage")}>
            {armed ? (
              <div className="toast" ref={put(refs, "toast")} aria-hidden="true">
                <span className="tick"><Check size={12} width="3.2" /></span>
                <span><span>{t("landingV7.demo.toast")}</span><small>{t("landingV7.demo.toastSub")}</small></span>
              </div>
            ) : null}
            <figure className="dev ipad">
              <div className="scr">
                <img src={HERO_TABLET.src} srcSet={HERO_TABLET.srcSet} sizes={HERO_TABLET.sizes} width={HERO_TABLET.width} height={HERO_TABLET.height} alt={t("landingV7.alt.sched")} fetchPriority="high" />
                {armed ? <img className="over" ref={put(refs, "pub")} src={IMG.schedPub.src} srcSet={IMG.schedPub.srcSet} sizes={SIZES.heroTablet} width={IMG.schedPub.width} height={IMG.schedPub.height} alt="" aria-hidden="true" decoding="async" fetchPriority="low" /> : null}
                {armed ? <span className="tap" ref={put(refs, "tap")} aria-hidden="true"></span> : null}
              </div>
            </figure>
            <figure className="dev phone">
              <div className="scr">
                <img src={IMG.staff.src} srcSet={IMG.staff.srcSet} sizes={SIZES.heroPhone} width={IMG.staff.width} height={IMG.staff.height} alt={t("landingV7.alt.staff")} />
                {armed ? (
                  <div className="p-banner" ref={put(refs, "banner")} aria-hidden="true">
                    <span className="mk"><Calendar /></span>
                    <span><span className="app">{t("landingV7.demo.app")}</span><b>{t("landingV7.demo.banner")}</b><small>{t("landingV7.demo.bannerSub")}</small></span>
                  </div>
                ) : null}
              </div>
            </figure>
          </div>
          <div className="caption"><span>{t("landingV7.demo.caption")}</span><button className="replay" type="button" onClick={onReplay}>{t("landingV7.demo.again")}</button></div>
        </div>
      </div>
    </section>
  );
}
