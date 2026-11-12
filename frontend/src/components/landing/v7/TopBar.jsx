/* The v7 landing's top bar: the wordmark, the section links (wide screens), the language menu, Log ind and Prøv gratis.
 *
 * Its first render is the HTML's first screen exactly (scripts/landingFirstScreenV7.mjs; landingV7FirstScreen.test.jsx
 * compares them): the language menu's list joins once the page is mounted (`armed`), as do the hero's moving parts.
 *
 * The logo (12 Nov 2026, founder: "put our original logo"): the kit's mark (BonBoxMark, the "Rullen" b) on the forest
 * tile, paper b, ~0.8 of the 32 px tile, and the kit's wordmark (BonBoxWordmark) at ~0.6 of the tile, as the app and the
 * old landing draw them. It replaced a typed "b" on an ink tile and the word typed in Sora. The first screen writes the
 * same two SVGs, path for path (it reads them from those two files).
 *
 * Language menu: one quiet button, a small menu on demand (the design's), Danish and English only. Arrow keys, Home / End,
 * Escape and Tab as a menu does; a tap outside or the window losing focus closes it. A pick calls onLang (the app's
 * language, hooks/useLanguage) and puts the focus back on the button. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Chevron, Globe } from "./icons";
import { PAGE_LANGS_V7, SECTION } from "./assets";
import BonBoxMark from "../../BonBoxMark";
import BonBoxWordmark from "../../BonBoxWordmark";

const vib = () => { try { if (navigator.vibrate) navigator.vibrate(8); } catch { /* no vibration */ } };

function LangMenu({ t, lang, onLang, armed }) {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const setOpen = (v) => { openRef.current = v; setOpenState(v); };
  const box = useRef(null);
  const btn = useRef(null);
  const items = useRef([]);
  const cur = PAGE_LANGS_V7.find((l) => l.code === lang) || PAGE_LANGS_V7[0];
  const word = t("landingV7.lang.word");

  const focusItem = (i) => { const n = items.current.length; const el = items.current[((i % n) + n) % n]; if (el) el.focus({ preventScroll: true }); };
  const openMenu = (which) => {
    setOpen(true);
    const at = which === "last" ? PAGE_LANGS_V7.length - 1 : Math.max(0, PAGE_LANGS_V7.findIndex((l) => l.code === lang));
    // the list is in the DOM already (armed); focus once the class has made it visible
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => focusItem(at)); else setTimeout(() => focusItem(at), 0);
  };
  const closeMenu = useCallback((refocus) => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpenState(false);
    if (refocus && btn.current) btn.current.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (box.current && !box.current.contains(e.target)) closeMenu(false); };
    const blur = () => closeMenu(false);
    document.addEventListener("pointerdown", down);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", down); window.removeEventListener("blur", blur); };
  }, [open, closeMenu]);

  const onBtnKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); openMenu(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); openMenu("last"); }
  };
  const onMenuKey = (e) => {
    const i = items.current.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(PAGE_LANGS_V7.length - 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
    else if (e.key === "Tab") { closeMenu(false); }
  };
  const pick = (code) => {
    const changed = code !== lang;
    closeMenu(true);
    if (changed) { vib(); onLang(code); }
  };

  return (
    <div className={open ? "lang open" : "lang"} ref={box}>
      <button type="button" className="lang-btn" ref={btn} aria-haspopup="menu" aria-expanded={open ? "true" : "false"} aria-controls="lp7-lang-menu" aria-label={`${word}: ${cur.name}`}
        onClick={() => (open ? closeMenu(false) : openMenu())} onKeyDown={onBtnKey}>
        <Globe /><span className="lang-cur">{cur.short}</span><Chevron />
      </button>
      {armed ? (
        <div className="lang-menu" id="lp7-lang-menu" role="menu" aria-label={word} onKeyDown={onMenuKey}>
          {PAGE_LANGS_V7.map((l, i) => (
            <button key={l.code} type="button" role="menuitemradio" aria-checked={l.code === lang ? "true" : "false"} lang={l.code} tabIndex={-1}
              ref={(el) => { items.current[i] = el; }} onClick={() => pick(l.code)}>
              <Check className="ck" /><span>{l.name}</span><span className="code" aria-hidden="true">{l.short}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function TopBar({ t, lang, onLang, armed, barRef }) {
  return (
    <header className="top" id="top" ref={barRef}>
      <div className="wrap">
        <a className="brand" href="#top" aria-label="BonBox"><span className="mark" aria-hidden="true"><BonBoxMark size={26} /></span><BonBoxWordmark height={19} title="" /></a>
        <nav className="nav" aria-label={t("landingV7.nav.label")}>
          <a href={`#${SECTION.shifts}`}>{t("landingV7.nav.shifts")}</a>
          <a href={`#${SECTION.tables}`}>{t("landingV7.nav.tables")}</a>
          <a href={`#${SECTION.till}`}>{t("landingV7.nav.till")}</a>
          <a href={`#${SECTION.addons}`}>{t("landingV7.nav.addons")}</a>
          <a href={`#${SECTION.prices}`}>{t("landingV7.nav.prices")}</a>
        </nav>
        <div className="top-actions">
          <LangMenu t={t} lang={lang} onLang={onLang} armed={armed} />
          <Link className="login" to="/login">{t("landingV7.nav.login")}</Link>
          <Link className="btn btn-ink btn-sm" to="/register">{t("landingV7.cta")}</Link>
        </div>
      </div>
    </header>
  );
}
