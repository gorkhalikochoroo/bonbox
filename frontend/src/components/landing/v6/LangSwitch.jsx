/* DK · EN in the top bar (PORT_PLAN 2.3). The page is Danish or English, so the switch offers exactly those two,
 * always in that order: the language on screen is text (aria-current), the other is a button named in its own
 * language ("English" / "Dansk", lang set) that calls the app's setLang (stores the choice, clears the auto-pick).
 * Codes and names come from i18n/languageCatalog.js (the catalog says "DK", not the prototype's "DA"), each with
 * its drawn flag (Flag.jsx). The codes take part in the night edge's colour split (.sx); the flags are pictures.
 * Under 400 px only the button shows (landingV6.css), one 44 px target. */
import { ALL_LANGUAGES } from "../../../i18n/languageCatalog";
import Flag from "./Flag";
import { PAGE_LANGS } from "./site";

const entry = (code) => ALL_LANGUAGES.find((l) => l.code === code);

export default function LangSwitch({ lang, onPick }) {
  return (
    <span className="lang">
      {PAGE_LANGS.map((code, i) => {
        const l = entry(code);
        const sep = i > 0 ? <span className="dot sx f3" aria-hidden="true">·</span> : null;
        if (code === lang) {
          return (
            <span className="lg-cur" key={code}>
              {sep}
              <Flag code={code} />
              <b className="sx f1" aria-current="true">{l.short}</b>
            </span>
          );
        }
        return (
          <span className="lg-alt" key={code}>
            {sep}
            <button type="button" lang={code} aria-label={l.label} onClick={() => onPick(code)}>
              <Flag code={code} />
              <span className="sx f3">{l.short}</span>
            </button>
          </span>
        );
      })}
    </span>
  );
}
