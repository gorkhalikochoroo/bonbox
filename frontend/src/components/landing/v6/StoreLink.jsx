/* A link to one of the two live iPhone apps, or to the web app on Android (PORT_PLAN 1.2, removal audit 6).
 * Both apps are iPhone-only. An Android visitor offered "Vagtplan i App Store" is offered a store they cannot use,
 * so there the same place links into the app in the browser instead: staff → /join ("Vagtplan i browseren"),
 * owner → /register ("BonBox i browseren"), as the old landing did (push 9, A5; v2/platform.js isAndroidBrowser).
 * iPhone, iPad and desktop keep the App Store link, in the same tab, as the prototype has it. Plain text links
 * wearing the page's own classes (no App Store badge). */
import { Link } from "react-router-dom";
import { APP_STORE } from "./site";

export default function StoreLink({ app, t, isAndroid, className }) {
  if (isAndroid) {
    return app === "scheduler"
      ? <Link className={className} to="/join">{t("landingV6.web.scheduler")}</Link>
      : <Link className={className} to="/register">{t("landingV6.web.owner")}</Link>;
  }
  return app === "scheduler"
    ? <a className={className} href={APP_STORE.scheduler}>{t("landingV6.app.scheduler")}</a>
    : <a className={className} href={APP_STORE.owner}>{t("landingV6.app.owner")}</a>;
}
