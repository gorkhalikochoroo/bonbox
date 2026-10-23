/* The language switch in the top bar and the footer (PORT_PLAN 2.3; Manoj 23 Oct: "instead of dk en just put flag").
 * The page is Danish or English, so the switch offers exactly those two, always in that order: two drawn flags
 * (Flag.jsx), no letters and no separator, each a real button with a 44 x 44 px target. A button is named in its own
 * language ("Dansk" / "English" from i18n/languageCatalog.js, lang set, so a screen reader says each name in its language)
 * and says whether it is the page's language (aria-pressed). The language on screen keeps its flag in full colour with a
 * thin line under it; the other flag is dimmed until hovered or focused (landingV6.css), so the state never rests on colour
 * alone. Pressing the other flag calls the app's setLang (stores the choice, clears the auto-pick); pressing the one
 * already on screen does nothing. The flags keep their own colours on paper and on night: nothing here takes part in the
 * night edge's colour split (.sx). */
import { ALL_LANGUAGES } from "../../../i18n/languageCatalog";
import Flag from "./Flag";
import { PAGE_LANGS } from "./site";

const entry = (code) => ALL_LANGUAGES.find((l) => l.code === code);

export default function LangSwitch({ lang, onPick }) {
  return (
    <span className="lang">
      {PAGE_LANGS.map((code) => {
        const on = code === lang;
        return (
          <button type="button" key={code} lang={code} aria-label={entry(code).label} aria-pressed={on} onClick={on ? undefined : () => onPick(code)}>
            <Flag code={code} />
          </button>
        );
      })}
    </span>
  );
}
