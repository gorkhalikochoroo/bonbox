// The v7 landing's first screen in the HTML (12 Nov 2026). Build time only (vite.config.js landingFirstScreen); the source
// index.html is never touched. Same boot protocol as the v6 first screen (scripts/landingFirstScreen.mjs, landing speed
// step 2, 10 Nov 2026), so main.jsx, App.jsx (LandingRoute, KeepFirstScreen, FirstScreenHandover) and lib/landingBoot.js
// carry it unchanged: window.__lp6First marks the visitor (a prospect on "/" or "/v2", no hash, not a reload or a back /
// forward step), #lp6-first is the drawn screen.
//
// For that visitor an inline script inside #root writes the v7 top bar and hero (its headline, line, calls to action,
// price line and the device composition with the week's draft) while the page is still parsing, in Danish or English,
// styled by an inline <style> carrying landingV7.css's first-screen part and drawn in three committed font cuts, so the
// visitor sees the page's first screen from the document alone; React's first commit then puts the same markup there
// (TopBar.jsx + Hero.jsx before they are armed; landingV7FirstScreen.test.jsx compares them) and nothing moves.
//
//   firstScreenCssV7()        the /*<fs>*/ ... /*</fs>*/ part of landingV7.css, minified, plus the rules that hold only
//                             while the static screen is up
//   firstScreenFacesV7()      "Sora First" 600 and "DM Sans First" 400 / 600 as data: faces (scripts/landingFirstFontsV7.mjs)
//   firstScreenTemplateV7()   the markup with {n} for the strings, {L} for the language
//   firstScreenStringsV7()    the project's own dictionary text (src/i18n/da.js, en.js), HTML-escaped here, at build time
//   firstScreenScriptV7()     the inline script for #root
//
// Not in components/landing/v7 or pages/LandingV7Page.jsx on purpose: those keep no HTML sink.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { esc, js } from './landingFirstScreen.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8')

// The picture the first screen draws largest (components/landing/v7/assets.js HERO_TABLET), in the exact attribute strings
// React writes, so the head preload, this screen and the page all use one download.
const PICS = '/static/landing-v7/'
export const HERO_IMG_V7 = Object.freeze({
  src: `${PICS}sched-draft.webp`,
  srcset: `${PICS}sched-draft-700.webp 700w, ${PICS}sched-draft-1100.webp 1100w, ${PICS}sched-draft.webp 1600w`,
  sizes: '(max-width: 719px) calc(100vw - 40px), (max-width: 1099px) calc(84vw - 40px), 968px',
})
// The stage's 3D rise (the design's arrival) plays only on a wide screen with a fine pointer: on a phone or a tablet the
// stage sits at the first screen's foot, half in view, and the rise would only delay its picture. LandingV7Page bootState
// asks the same question.
export const RISE_QUERY_V7 = '(hover: hover) and (pointer: fine) and (min-width: 720px)'
const STAFF_IMG = {
  src: `${PICS}staff.webp`,
  srcset: `${PICS}staff-320.webp 320w, ${PICS}staff.webp 640w`,
  sizes: '(max-width: 719px) 40vw, (max-width: 1099px) 22vw, 280px',
}

/** The first-screen part of landingV7.css (raw text). */
export function firstScreenRangeV7(css = read('components/landing/v7/landingV7.css')) {
  const parts = [...css.matchAll(/\/\*<fs>\*\/([\s\S]*?)\/\*<\/fs>\*\//g)].map((m) => m[1])
  const opens = (css.match(/\/\*<fs>\*\//g) || []).length
  const closes = (css.match(/\/\*<\/fs>\*\//g) || []).length
  if (parts.length !== 1 || opens !== 1 || closes !== 1) throw new Error('landingFirstScreenV7: landingV7.css needs exactly one /*<fs>*/ … /*</fs>*/ part')
  return parts[0]
}

// Only while the static screen is up (React's first commit removes #lp6-first): the scrollbar the full page will have
// (no sideways jump at takeover on a desktop with classic scrollbars).
export const STATE_CSS_V7 = ':root:has(#lp6-first){overflow-y:scroll}'

export const FIRST_FACES_V7 = [
  { family: 'Sora First', weight: 600, file: 'sora-600-first.woff2' },
  { family: 'DM Sans First', weight: 400, file: 'dmsans-400-first.woff2' },
  { family: 'DM Sans First', weight: 600, file: 'dmsans-600-first.woff2' },
]
/** The three cuts as data: faces. font-display:block: a data: face is ready within a frame. Never named Sora / DM Sans:
 *  the landing sheet's own faces of those names would replace them and draw the text again (a swap). */
export function firstScreenFacesV7() {
  return FIRST_FACES_V7.map(({ family, weight, file }) => {
    const b64 = fs.readFileSync(path.join(SRC, 'components/landing/v7/fonts', file)).toString('base64')
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2")}`
  }).join('')
}

export function firstScreenCssV7(faces = '') {
  const { code } = transform({ filename: 'landing-first-screen-v7.css', code: Buffer.from(firstScreenRangeV7() + STATE_CSS_V7), minify: true })
  return faces + code.toString()
}

// the strings, in template order ({0} … {21}); 6 and 7 are the language button's label and code
const KEYS = ['nav.label', 'nav.shifts', 'nav.tables', 'nav.till', 'nav.addons', 'nav.prices', null, null, 'nav.login', 'cta',
  'hero.eyebrow', 'h1.shifts', 'h1.tables', 'h1.till', 'hero.lede', 'cta14', 'ctaDay', 'hero.fine', 'alt.sched', 'alt.staff',
  'demo.caption', 'demo.again']
export const FIRST_SCREEN_KEYS_V7 = ['lang.word', ...KEYS.filter(Boolean)].map((k) => 'landingV7.' + k)
const LANG = { da: { name: 'Dansk', short: 'DK' }, en: { name: 'English', short: 'ENG' } }

// TopBar.jsx + Hero.jsx as React renders them before they are armed (attribute order and all)
const ICON = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'
export function firstScreenTemplateV7() {
  return '<div id="lp6-first" class="lp7" lang="{L}">' +
    '<header class="top" id="top"><div class="wrap">' +
    '<a class="brand" href="#top" aria-label="BonBox"><span class="mark" aria-hidden="true">b</span>BonBox</a>' +
    '<nav class="nav" aria-label="{0}"><a href="#vagterne">{1}</a><a href="#bordene">{2}</a><a href="#kassen">{3}</a><a href="#tilvalg">{4}</a><a href="#priser">{5}</a></nav>' +
    '<div class="top-actions"><div class="lang">' +
    '<button type="button" class="lang-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="lp7-lang-menu" aria-label="{6}">' +
    `<svg width="16" height="16" viewBox="0 0 24 24" stroke-width="1.6" ${ICON}><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3c2.4 2.5 3.7 5.5 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.5-3.7-9S9.6 5.5 12 3z"></path></svg>` +
    '<span class="lang-cur">{7}</span>' +
    `<svg class="chev" width="12" height="12" viewBox="0 0 24 24" stroke-width="2.2" ${ICON}><path d="m6 9 6 6 6-6"></path></svg>` +
    '</button></div>' +
    '<a class="login" href="/login">{8}</a><a class="btn btn-ink btn-sm" href="/register">{9}</a>' +
    '</div></div></header>' +
    '<main id="lp7-main"><section class="hero" aria-labelledby="lp7-h1"><div class="wrap"><div class="hero-grid">' +
    '<div><p class="eyebrow load">{10}</p><h1 id="lp7-h1" class="load d1">{11}<span class="dot">.</span><br>{12}<span class="dot">.</span><br>{13}<span class="dot">.</span></h1></div>' +
    '<div class="hero-side"><p class="lede load d2">{14}</p>' +
    '<div class="ctas load d3"><a class="btn btn-ink" href="/register"><span>{15}</span>' +
    `<svg class="arrow" width="16" height="16" viewBox="0 0 24 24" stroke-width="2" ${ICON}><path d="M5 12h14M13 6l6 6-6 6"></path></svg></a>` +
    '<a class="btn btn-line" href="#dag">{16}</a></div>' +
    '<p class="fine load d4">{17}</p></div></div>' +
    '<div class="stage-wrap load d2"><div class="stage">' +
    // React writes an <img>'s srcset and src last (after sizes): the same order here
    `<figure class="dev ipad"><div class="scr"><img sizes="${HERO_IMG_V7.sizes}" width="1600" height="1112" alt="{18}" fetchpriority="high" srcset="${HERO_IMG_V7.srcset}" src="${HERO_IMG_V7.src}"></div></figure>` +
    `<figure class="dev phone"><div class="scr"><img sizes="${STAFF_IMG.sizes}" width="640" height="1385" alt="{19}" srcset="${STAFF_IMG.srcset}" src="${STAFF_IMG.src}"></div></figure>` +
    '</div><div class="caption"><span>{20}</span><button class="replay" type="button">{21}</button></div></div>' +
    '</div></section></main></div>'
}

export function firstScreenStringsV7(dict, lang, price) {
  const v = (k) => {
    const s = dict['landingV7.' + k]
    if (typeof s !== 'string' || !s) throw new Error('landingFirstScreenV7: missing landingV7.' + k)
    return s
  }
  const l = LANG[lang === 'da' ? 'da' : 'en']
  return KEYS.map((k, i) => {
    if (i === 6) return esc(`${v('lang.word')}: ${l.name}`)
    if (i === 7) return esc(l.short)
    const s = v(k)
    return esc(k === 'hero.fine' ? s.replace(/\{price\}/g, String(price)) : s)
  })
}

/** The finished markup for one language, as the inline script writes it (tests compare it with React's render). */
export function firstScreenMarkupV7(lang, { da, en, price }) {
  const l = lang === 'da' ? 'da' : 'en'
  const s = firstScreenStringsV7(l === 'da' ? da : en, l, price)
  return firstScreenTemplateV7().replace(/\{(\d+)\}/g, (m, i) => s[+i]).replace('{L}', l)
}

// Which control a tap or a focus was on, as { r: region, s: selector, i: index }: the same control in React's landing is
// root.querySelector("." + r).querySelectorAll(s)[i] (lib/landingBoot.js replayFirstScreen). Only the controls that do
// nothing until the app has taken over: the language button and the in-page links. "Prøv gratis" and "Log ind" are real
// links and stay real links.
const KEY_FN = 'function(t){' +
  'var a=t&&t.closest?t.closest("button.lang-btn,a[href^=\\"#\\"]"):null;if(!a)return null;' +
  'var g=a.closest(".top")?"top":a.closest(".hero")?"hero":null;if(!g)return null;' +
  'var s=a.tagName==="BUTTON"?"button.lang-btn":"a[href=\\""+a.getAttribute("href")+"\\"]";' +
  'var b=a.closest("."+g),n=b.querySelectorAll(s),i=0;for(;i<n.length;i++)if(n[i]===a)break;' +
  'return{r:g,s:s,i:i}}'

// ── The landing's own document (12 Nov 2026) ──────────────────────────────────────────────────────────────────────────
// "/" and "/v2" get their own HTML (vite.config.js landingDocument writes dist/landing.html; vercel.json sends both
// addresses there): today's index.html plus one small phone cut of the hero picture, so on a phone the week's draft paints
// with the first screen instead of waiting for its download (~1.5 s on the bench's phone line). Every other route, and
// the native apps, keep index.html as it was: no picture bytes there.
//
// The cut is drawn as the iPad screen's background, not as an <img>: the markup stays the first screen's (React's first
// render, landingV7FirstScreen.test.jsx), and the network picture (srcset, preloaded) still draws over it once it is in.
// Phone layout only (the same breakpoint as the hero's `sizes`): wider screens draw the iPad far larger than this cut.
// 700 px wide (cwebp -q 30 -m 6 -resize 700 487, from public/static/landing-v7/sched-draft.webp): never narrower than the
// screen draws it on a phone (at most 679 CSS px), so Chrome sizes it as the network picture and keeps it as the largest
// paint. A more specific selector than the blur placeholder's (.lp7 .stage .ipad .scr), which the page's own stylesheet
// repeats later in the document.
export const HERO_PHONE_FILE_V7 = 'components/landing/v7/inline/sched-draft-phone.webp'
export const HERO_PHONE_QUERY_V7 = '(max-width:719px)'
export const LANDING_DOC_V7 = 'landing.html'
export const APP_DOC_V7 = 'app.html'
export function heroPhoneCssV7() {
  const b64 = fs.readFileSync(path.join(SRC, HERO_PHONE_FILE_V7)).toString('base64')
  return `@media ${HERO_PHONE_QUERY_V7}{.lp7 .stage-wrap .stage .ipad .scr{background:var(--paper) url(data:image/webp;base64,${b64}) center top/cover no-repeat}}`
}
/** The landing's document: the built index.html with the hero cut's rule, last in <body> (React never touches it, and the
 *  first screen's text is not held back behind the picture's bytes). */
export function landingDocumentV7(indexHtml, css = heroPhoneCssV7()) {
  const html = String(indexHtml)
  if (html.includes('id="lp7-hero"')) throw new Error('landingDocumentV7: the document already carries the hero cut')
  if (!html.includes('<style id="lp6-css">')) throw new Error('landingDocumentV7: no landing first screen in index.html')
  const at = html.lastIndexOf('</body>')
  if (at < 0 || html.indexOf('</body>') !== at) throw new Error('landingDocumentV7: expected one </body> in index.html')
  return html.slice(0, at) + `<style id="lp7-hero">${css}</style>` + html.slice(at)
}

export function firstScreenScriptV7({ da, en, price }) {
  const T = firstScreenTemplateV7()
  const S = { da: firstScreenStringsV7(da, 'da', price), en: firstScreenStringsV7(en, 'en', price) }
  return '<script>(function(){try{var f=window.__lp6First;if(!f)return;' +
    `var RISE=${js(RISE_QUERY_V7)};` +
    `var T=${js(T)},S=${js(S)},l=f.lang==="da"?"da":"en",s=S[l],d=document;` +
    'var h=T.replace(/\\{(\\d+)\\}/g,function(m,i){return s[+i]}).replace("{L}",l);' +
    'd.currentScript.insertAdjacentHTML("beforebegin",h);' +
    'var r=d.getElementById("lp6-first");f.drawn=true;try{f.at=performance.now()}catch(e){}' +
    // the arrival (the design's): the stage rises in 3D once, here; React's page then renders calm (LandingV7Page)
    'var mm=function(q){try{return window.matchMedia&&matchMedia(q).matches}catch(e){return false}};' +
    'if(!mm("(prefers-reduced-motion: reduce)")&&mm(RISE)){var st=r.querySelector(".stage");if(st){st.classList.add("enter");st.addEventListener("animationend",function a(e){if(e.target===st&&e.animationName==="lp7-rise3d"){st.classList.remove("enter");st.removeEventListener("animationend",a)}})}}' +
    // the phone's dark mode: the page's night ground in the browser bar from the first frame (LandingV7Page keeps it)
    'if(mm("(prefers-color-scheme: dark)")){var tc=d.querySelector("meta[name=\\"theme-color\\"]");if(tc)tc.setAttribute("content","#121110")}' +
    // main.jsx keeps ?ref= (a leave-behind QR's code) in memory only: a tap on these real links before the app has taken
    // over is a full page load, so they carry it (set as an attribute value through the DOM, never as markup)
    'var q=null;try{q=new URLSearchParams(location.search).get("ref")}catch(e){}' +
    'if(q){var x=r.querySelectorAll("a[href=\\"/register\\"],a[href=\\"/login\\"]");for(var j=0;j<x.length;j++)x[j].setAttribute("href",x[j].getAttribute("href")+"?ref="+encodeURIComponent(q))}' +
    `var k=${KEY_FN};` +
    'r.addEventListener("click",function(e){if(e.defaultPrevented||e.button||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;var c=k(e.target);if(c){e.preventDefault();f.tap=c}});' +
    'r.addEventListener("focusin",function(e){f.focus=k(e.target)});' +
    // the page's full fonts (and the app's Inter for the cookie banner) start right after this screen's first frame (a
    // font preload known before the first paint delays that paint in Chromium), at 1.5 s at the latest, and no later than
    // DOMContentLoaded; crossorigin, or each file loads twice (as the v6 first screen)
    'var L=function(w){var o=0;return function(){if(o)return;o=1;for(var i=0;i<w.length;i++){var n=d.createElement("link");n.rel="preload";n.setAttribute("as","font");n.type="font/woff2";n.setAttribute("crossorigin","");n.href=w[i];d.head.appendChild(n)}}};' +
    // every font here draws below the first screen or in the cookie banner (React's commit): they wait for the hero picture
    // (the first screen's largest paint, which they would otherwise share the line with), 2.5 s at the latest, and no later
    // than DOMContentLoaded; the app's Inter (the banner) first, then the page's Sora and DM Sans
    'var P=L((f.fonts||[]).concat(f.later||[]));' +
    'var im=r.querySelector(".ipad img");if(im&&!im.complete){im.addEventListener("load",P);im.addEventListener("error",P)}else if(window.requestAnimationFrame)requestAnimationFrame(function(){setTimeout(P,0)});else P();setTimeout(P,2500);d.addEventListener("DOMContentLoaded",P);' +
    '}catch(e){}})()</script>'
}
