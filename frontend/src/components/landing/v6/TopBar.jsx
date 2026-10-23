/* The top bar (v6.3 src.html "header.top"): the lockup twice (lgA / lgB, the night edge clips one to each side),
 * the language switch (two flags), Priser, Log ind and the header's "Prøv gratis" (the engine shows it once the hero's button has scrolled
 * away). Log ind and Prøv gratis are router links (in-app, no reload, the ?ref= memory copy survives). */
import { Link } from "react-router-dom";
import Lockup from "./Lockup";
import LangSwitch from "./LangSwitch";

export default function TopBar({ t, lang, onLang }) {
  return (
    <header className="top" id="top-bar">
      <div className="in">
        <a className="logo" href="#main" aria-label="BonBox"><span className="lgA"><Lockup /></span><span className="lgB" aria-hidden="true"><Lockup /></span></a>
        <nav className="nav" aria-label={t("landingV6.nav.label")}>
          <LangSwitch lang={lang} onPick={onLang} />
          <a className="navl prices-l sx f1" href="#pricing">{t("landingV6.nav.prices")}</a>
          <Link className="navl login sx f1" to="/login">{t("landingV6.nav.login")}</Link>
          <Link className="btn xb" to="/register"><span className="bt">{t("landingV6.cta")}</span></Link>
        </nav>
      </div>
      <i className="hl sbg h" aria-hidden="true"></i>
    </header>
  );
}
