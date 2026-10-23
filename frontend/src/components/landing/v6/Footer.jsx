/* The footer (v6.3 src.html "footer.foot"): the lockup, who runs BonBox (registry lines, untranslated), the mail
 * address, the legal links, Cookieindstillinger, the owner app and Instagram, the copyright line.
 * Handelsbetingelser / Privatlivspolitik / Kontakt are router links (the prototype had absolute URLs); the legal
 * documents keep their Danish names on the English page too (as en.js does; PORT_PLAN section 8 item 9). No
 * Databehandleraftale link until a real DPA exists. "Cookieindstillinger" reopens the banner's drawer (GDPR
 * Art. 7(3): withdrawing is as easy as giving). On Android the owner app link goes to the web app (StoreLink).
 * The language switch (fix round, 22 Oct; two flags since 23 Oct): the same switch as the top bar's, so the language can always be changed at the end of the
 * page (under 500 px the top bar's switch steps aside while the header's "Prøv gratis" is up). */
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { CookieSettingsButton } from "../../CookieConsent";
import LangSwitch from "./LangSwitch";
import Lockup from "./Lockup";
import StoreLink from "./StoreLink";
import { CONTACT_EMAIL, LEGAL_LINES } from "./site";

export default function Footer({ t, isAndroid, lang, onLang }) {
  return (
    <footer className="foot" id="foot">
      <div className="wrap">
        <div className="legal">
          <a className="logo" href="#main" aria-label="BonBox"><Lockup /></a>
          <p>{t("landingV6.foot.operatedBy")}<br />{LEGAL_LINES.map((l) => <Fragment key={l}>{l}<br /></Fragment>)}<a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
        </div>
        <div className="right">
          <ul className="links">
            <li><Link to="/terms">{t("landingV6.foot.terms")}</Link></li>
            <li><Link to="/privacy">{t("landingV6.foot.privacy")}</Link></li>
            <li><Link to="/contact">{t("landingV6.foot.contact")}</Link></li>
            <li><CookieSettingsButton label={t("landingV6.foot.cookies")} /></li>
            <li><LangSwitch lang={lang} onPick={onLang} /></li>
          </ul>
          <div className="apps">
            <p><StoreLink app="owner" t={t} isAndroid={isAndroid} /></p>
            <p><a href="https://www.instagram.com/bonbox.dk/">{t("landingV6.foot.instagram")}</a></p>
            <p className="copy-r">{t("landingV6.foot.copyright")}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
