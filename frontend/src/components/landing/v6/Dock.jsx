/* The bottom bar of every one-column stage (v6.3 src.html "#dock"): ← · Næste · n / 7 and the trial line, then
 * "Prøv gratis". data-bb-consent-clear: the cookie banner sits on this bar, never over its button. */
import { Link } from "react-router-dom";

export default function Dock({ t }) {
  const prev = t("landingV6.prev");
  return (
    <div className="dock" id="dock" data-bb-consent-clear="">
      <i className="hl sbg h" aria-hidden="true"></i>
      <div className="dk-left">
        <div className="dk-nav"><button className="next prev off" id="dprev" type="button" aria-controls="aften" aria-label={prev}><span className="ar sx f1" aria-hidden="true">←</span></button><button className="next" id="dnext" type="button" aria-controls="aften"><span className="sx f1">{t("landingV6.next")}</span><span className="ar sx f1" aria-hidden="true">→</span></button><span className="count sx f3" id="dcount">1 / 7</span></div>
        <p className="dk-trial sx f2">{t("landingV6.trialDock")}</p>
      </div>
      <Link className="btn xb" to="/register"><span className="bt">{t("landingV6.cta")}</span></Link>
      <i className="dk-prog sbg k" id="dprog" aria-hidden="true"></i>
    </div>
  );
}
