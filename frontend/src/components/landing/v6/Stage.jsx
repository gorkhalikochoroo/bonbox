/* The pinned day (v6.3 src.html "#track" → "#frame"): venue, date, the index, the clock, the plate, the three
 * statements of the story layout, the six scenes 10.00 → 00.10 and the story nav.
 *
 * Static. The engine (engine.js) owns, inside this tree: every mode class and inline style it writes, data-beat,
 * hidden on #prev, inert on #snend, aria-current / tabindex on the index and the statements' links, the clock
 * digits (.dg b), the counters (#count, #dcount) and the Z-bon amounts (dd[data-v]). React renders their first
 * value here and never a different one (PORT_PLAN 1.3), so a re-render writes nothing.
 *
 * Demo data stays as the screenshots show it in every language: the venue and table names, the staff names, the
 * axis hours and the amounts (Danish money format, as the app prints DKK everywhere). Every picture is demo data
 * and says so.
 *
 * The pictures are the app in the page's language (23 Oct 2026, "eng should be eng and danish should be danish"):
 * images.js imagesFor(lang) gives the Danish screens on the Danish page and the English screens on the English one
 * (a Turkish reader's too), one file per <img> / <source>. A language switch re-keys the page, so the new set comes in
 * with the new text; each pair has the same pixel box, so the engine's layout does not move. */
import { Link } from "react-router-dom";
import { imagesFor } from "./images";
import RoomSvg from "./RoomSvg";
import StoreLink from "./StoreLink";
import { rich } from "./rich";

const VENUE = "Bistro Nørrebro";
const TABLE = "Vindue 2";
const CM = (
  <>
    <i className="cm c1"></i><i className="cm c2"></i><i className="cm c3"></i><i className="cm c4"></i>
  </>
);
/* fix round (gate budgets): the stage pictures sit in the pinned frame, inside the viewport, so "lazy" cannot hold them back;
   fetchpriority low lets the page's script, styles and fonts go first on a slow line */
const Img = ({ img, alt }) => <img src={img.src} width={img.width} height={img.height} alt={alt} loading="lazy" decoding="async" fetchPriority="low" />;
const Dg = ({ d }) => <span className="dg"><b className="sx f1">{d}</b><b className="sx f1"></b></span>;

export default function Stage({ t, lang, isAndroid }) {
  const IMG = imagesFor(lang);
  const demo = t("landingV6.demo");
  const cap = <figcaption className="demo sx f3">{demo}</figcaption>;
  const schedule = t("landingV6.label.schedule");
  const reservations = t("landingV6.label.reservations");
  const close = t("landingV6.label.close");
  const s1 = t("landingV6.s1.line");
  const s3 = t("landingV6.s3.line");
  const s2 = t("landingV6.s2.line");
  const s4 = t("landingV6.s4.line");
  const s2aside = rich(t("landingV6.s2.aside"));
  const s4aside = t("landingV6.s4.aside");
  const stand = t("landingV6.s5.stand");
  const guests = rich(t("landingV6.s5.guests"));
  const photo = t("landingV6.s6.photo");
  const fill = t("landingV6.s6.fill");
  const cutoff = t("landingV6.s6.cutoff");
  const archive = t("landingV6.s6.archive");
  const altBooking = t("landingV6.alt.booking");
  const altStaffApp = t("landingV6.alt.staffApp");
  const altStandFloor = t("landingV6.alt.standFloor");
  const altClosePhoto = t("landingV6.alt.closePhoto");
  const prev = t("landingV6.prev");
  const next = t("landingV6.next");

  return (
    <div className="track" id="track">
      <div className="frame" id="frame" data-beat="1a">
        <h2 className="venue label sx f3" id="aften-h">{t("landingV6.venue")}</h2>
        <p className="date label sx f3" id="date"><time dateTime="2026-10-20">{t("landingV6.date")}</time></p>
        <nav className="ix" id="ix" aria-label={t("landingV6.ix.label")}>
          <a href="#s1" data-go="1a" data-c="1"><span className="n sx f3">01</span><span className="w sx f1">{t("landingV6.ix.shifts")}</span><i className="ixr sbg h"></i></a>
          <a href="#s2" data-go="2a" data-c="2"><span className="n sx f3">02</span><span className="w sx f3">{t("landingV6.ix.tables")}</span><i className="ixr sbg h"></i></a>
          <a href="#s6" data-go="3a" data-c="3"><span className="n sx f3">03</span><span className="w sx f3">{t("landingV6.ix.till")}</span><i className="ixr sbg h"></i></a>
        </nav>
        <div className="clock" id="clock" aria-hidden="true"><Dg d="1" /><Dg d="0" /><span className="dot sx f1">{t("landingV6.clock.sep")}</span><Dg d="0" /><Dg d="0" /></div>
        <div className="scene" id="scene" aria-hidden="true"></div>
        <div className="plate" id="plate" aria-hidden="true">{CM}<span className="demo pcap sx f3">{demo}</span></div>
        <i className="zbl" id="zbline" aria-hidden="true"></i>

        {/* the stage's three statements (story only): the beat decides which sentence is ink and which aside shows */}
        <div className="copy sc" id="c1">
          <h3 className="label sx f3">{schedule}</h3>
          <p className="line"><span className="s s1 sx">{s1}</span> <span className="s s2 sx">{s3}</span></p>
          <div className="asides"><p className="aside" data-b="h 1a 1b A"><StoreLink app="scheduler" t={t} isAndroid={isAndroid} className="tlink sx f1" /></p></div>
        </div>
        <div className="copy sc" id="c2">
          <h3 className="label sx f3">{reservations}</h3>
          <p className="line"><span className="s s1 sx">{s2}</span> <span className="s s2 sx">{s4}</span></p>
          <div className="asides"><p className="aside note sx f2" data-b="2a A2">{s2aside}</p><p className="aside note sx f2" data-b="S">{s4aside}</p><p className="aside note sx f2" data-b="B2">{stand}</p><p className="aside note sx f2" data-b="2b C">{guests}</p></div>
        </div>
        <div className="copy sc" id="c3">
          <h3 className="label sx f3">{close}</h3>
          <p className="line"><span className="s s1 sx">{photo}</span> <span className="s s2 sx">{fill}</span></p>
          <div className="asides"><p className="aside note sx f2" data-b="3a">{cutoff}</p><p className="aside note sx f2" data-b="3b end">{archive}</p></div>
        </div>

        {/* 10.00 · the plan is ready before the day */}
        <article className="ch" id="s1" aria-labelledby="s1-t">
          <div className="copy st">
            <time dateTime="2026-10-20T10:00">{t("landingV6.time.s1")}</time>
            <h3 className="label" id="s1-t">{schedule}</h3>
            <p className="line">{s1}</p>
          </div>
          <figure className="fig fx roster on" id="roster" aria-label={t("landingV6.roster.aria")}>
            <div className="ro" aria-hidden="true">
              <div className="ro-head"><span className="label">{VENUE}</span><span className="cap">{t("landingV6.roster.day")}</span></div>
              <div className="ro-axis"><span style={{ left: "0" }}>16</span><span style={{ left: "25%" }}>18</span><span style={{ left: "50%" }}>20</span><span style={{ left: "75%" }}>22</span><span style={{ left: "100%" }}>00</span></div>
              <ul>
                <li className="shift" style={{ "--i": "0", "--role": "var(--role-k)" }}><div className="shift-top"><span className="shift-name">Mads K.</span><span className="shift-role">{t("landingV6.role.chef")}</span><span className="shift-time">{t("landingV6.roster.t1")}</span></div><div className="trk"><i style={{ "--i": "0", "--a": "0", "--b": ".75" }}></i></div></li>
                <li className="shift" style={{ "--i": "1", "--role": "var(--role-f)" }}><div className="shift-top"><span className="shift-name">Sofie M.</span><span className="shift-role">{t("landingV6.role.server")}</span><span className="shift-time">{t("landingV6.roster.t2")}</span></div><div className="trk"><i style={{ "--i": "1", "--a": ".125", "--b": ".8125" }}></i></div></li>
                <li className="shift" style={{ "--i": "2", "--role": "var(--role-b)" }}><div className="shift-top"><span className="shift-name">Freja N.</span><span className="shift-role">{t("landingV6.role.bartender")}</span><span className="shift-time">{t("landingV6.roster.t3")}</span></div><div className="trk"><i style={{ "--i": "2", "--a": ".1875", "--b": ".875" }}></i></div></li>
              </ul>
            </div>
            {cap}
          </figure>
          <figure className="fig fx card uge dk-only" id="uge">
            <span className="scr"><span className="win"><Img img={IMG.vagtUge} alt={t("landingV6.alt.week")} /></span>{CM}</span>
            {cap}
          </figure>
        </article>

        {/* 12.30 · the guest books on their own phone */}
        <article className="ch" id="s2" aria-labelledby="s2-t">
          <div className="copy st">
            <time dateTime="2026-10-20T12:30">{t("landingV6.time.s2")}</time>
            <h3 className="label" id="s2-t">{reservations}</h3>
            <p className="line">{s2}</p>
            <p className="aside note">{s2aside}</p>
          </div>
          <figure className="fig fx card booking ph-only" id="booking">
            <span className="scr"><Img img={IMG.bookingGuest} alt={altBooking} /></span>
            {cap}
          </figure>
          <figure className="fig fx card bookw wd-only" id="bookw">
            <span className="scr"><span className="win"><Img img={IMG.bookingGuestWide} alt={altBooking} /></span>{CM}</span>
            {cap}
          </figure>
        </article>

        {/* 16.40 · the staff are on their way */}
        <article className="ch" id="s3" aria-labelledby="s3-t">
          <div className="copy st">
            <time dateTime="2026-10-20T16:40">{t("landingV6.time.s3")}</time>
            <h3 className="label" id="s3-t">{schedule}</h3>
            <p className="line">{s3}</p>
            <p className="aside"><StoreLink app="scheduler" t={t} isAndroid={isAndroid} className="tlink" /></p>
          </div>
          <figure className="fig fx card vagt ph-only" id="vagt">
            <span className="scr"><picture><source media="(max-width:767px) and (min-height:780px)" srcSet={IMG.staffApp.src} width={IMG.staffApp.width} height={IMG.staffApp.height} /><Img img={IMG.staffNextShift} alt={altStaffApp} /></picture></span>
            {cap}
          </figure>
          <figure className="fig fx card vapp wd-only" id="vapp">
            <span className="scr"><span className="win"><Img img={IMG.staffApp} alt={altStaffApp} /></span>{CM}</span>
            {cap}
          </figure>
        </article>

        <div className="nb" id="nb">
          {/* 19.45 · front of house: the same guest arrives and is seated at Vindue 2 */}
          <article className="ch" id="s4" aria-labelledby="s4-t">
            <div className="copy st">
              <time dateTime="2026-10-20T19:45">{t("landingV6.time.s4")}</time>
              <h3 className="label" id="s4-t">{reservations}</h3>
              <p className="line">{s4}</p>
              <p className="aside note">{s4aside}</p>
            </div>
            <figure className="fig fx room-fig" id="room" aria-hidden="true">
              <div className="room-box" id="roombox">
                <span className="rl vindue">{t("landingV6.room.window")}</span>
                <span className="rl v2l" id="v2l">{TABLE}</span>
                <RoomSvg />
                <span className="rl rbar">{t("landingV6.room.bar")}</span>
              </div>
              <div className="room-foot" id="roomfoot">
                <span className="demo">{demo}</span>
                <span className="rl indgang">{t("landingV6.room.entrance")}</span>
                <span className="legend"><span><i className="lg-seat"></i>{t("landingV6.room.seated")}</span><span><i className="lg-up"></i>{t("landingV6.room.soon")}</span><span className="lgl"><i className="lg-late"></i>{t("landingV6.room.late")}</span><span><i className="lg-on"><svg viewBox="-12 -12 24 24" aria-hidden="true"><circle r="10.5" /><ellipse rx="4.4" ry="10.5" /><path d="M-10.5 0H10.5" /></svg></i>{t("landingV6.room.online")}</span></span>
              </div>
            </figure>
          </article>

          {/* 22.50 · the host stand and the late table */}
          <article className="ch" id="s5" aria-labelledby="s5-t">
            <div className="copy st">
              <time dateTime="2026-10-20T22:50">{t("landingV6.time.s5")}</time>
              <h3 className="label" id="s5-t">{reservations}</h3>
              <p className="aside note">{stand}</p>
              <p className="aside note">{guests}</p>
            </div>
            <figure className="fig fx card tal ph-only" id="tal">
              <span className="scr"><span className="win"><Img img={IMG.standSeated} alt={t("landingV6.alt.standSeated")} /></span></span>
            </figure>
            <figure className="fig fx card stand ph-only" id="stand">
              <span className="scr"><span className="win"><Img img={IMG.standFloor} alt={altStandFloor} /></span></span>
              {cap}
            </figure>
            <figure className="fig fx card standw wd-only" id="standw">
              <span className="duo"><span className="scr tw"><Img img={IMG.standTiles} alt={t("landingV6.alt.standTiles")} /></span> <span className="scr pw"><span className="win"><Img img={IMG.standFloor} alt={altStandFloor} /></span></span>{CM}</span>
              {cap}
            </figure>
          </article>

          {/* 00.10 · closing: report and record */}
          <article className="ch" id="s6" aria-labelledby="s6-t">
            <div className="copy st">
              <time dateTime="2026-10-21T00:10">{t("landingV6.time.s6")}</time>
              <h3 className="label" id="s6-t">{close}</h3>
              <p className="line">{photo} {fill}</p>
              <p className="aside note">{cutoff}</p>
              <p className="aside note">{archive}</p>
            </div>
            <figure className="fig fx card foto hold ph-only" id="foto">
              <span className="scr"><Img img={IMG.closePhoto} alt={altClosePhoto} /></span>
              {cap}
            </figure>
            <figure className="fig fx card fotow hold wd-only" id="fotow">
              <span className="scr"><Img img={IMG.closePhotoWhole} alt={altClosePhoto} />{CM}</span>
              {cap}
            </figure>
            <figure className="fig fx zb" id="zb">
              <div className="zb-in">
                <div className="zb-slot" aria-hidden="true"></div>
                <div className="zb-clip"><div className="zb-paper">
                  <div className="zb-head" aria-hidden="true"><i></i><i></i><i></i></div>
                  <dl className="zb-rows">
                    <div><dt>{t("landingV6.zb.cash")}</dt><dd data-v="640">640,00</dd></div>
                    <div><dt>{t("landingV6.zb.card")}</dt><dd data-v="6610">6.610,00</dd></div>
                    <div><dt>{t("landingV6.zb.mobilepay")}</dt><dd data-v="990">990,00</dd></div>
                    <div className="tot"><dt>{t("landingV6.zb.total")}</dt><dd data-v="8240">8.240,00</dd></div>
                  </dl>
                </div></div>
              </div>
              {cap}
            </figure>
            <figure className="fig fx card kasse hold" id="kasse">
              <span className="scr"><span className="win"><Img img={IMG.closeMoms} alt={t("landingV6.alt.closeMoms")} /></span>{CM}</span>
              {cap}
            </figure>
          </article>
        </div>

        <div className="story-nav" id="snav">
          <div className="sn-ev" id="snev">
            <span className="count sx f3" id="count">1 / 7</span>
            <span className="prog sbg h" aria-hidden="true"><i className="sbg k" id="prog"></i></span>
            <button className="next prev" id="prev" type="button" aria-controls="aften" hidden><span className="ar sx f1" aria-hidden="true">←</span><span className="sx f1">{prev}</span></button>
            <button className="next" id="next" type="button" aria-controls="aften"><span className="sx f1">{next}</span><span className="ar sx f1" aria-hidden="true">→</span></button>
          </div>
          <div className="sn-end" id="snend" inert>
            <Link className="btn btn-lg xb" to="/register"><span className="bt">{t("landingV6.cta")}</span></Link>
            <span className="sn-trial sx f2">{t("landingV6.trialEnd")}</span>
            <button className="next prev" id="eprev" type="button" aria-controls="aften" aria-label={prev}><span className="ar sx f1" aria-hidden="true">←</span><span className="lb sx f1">{prev}</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}
