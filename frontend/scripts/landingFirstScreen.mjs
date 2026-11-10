// The landing's first screen in the HTML (landing speed, step 2; 10 Nov 2026). Build time only (vite.config.js
// landingFirstScreen); the source index.html is never touched.
//
// For a prospect on "/" or "/v2" (window.__lp6First, set by preloadLanding's head guard) an inline script inside
// #root writes the top bar and the hero while the page is still parsing, in Danish or English, styled by an inline
// <style> that carries landingV6.css's first-screen rules. The app's stylesheet then stops holding that first paint.
// React's first commit empties #root and puts the real landing there (main.jsx waits for the landing chunk, the app
// stylesheet and the visitor's dictionary first), so the visitor sees the first screen from about 0.8 s instead of
// about 3.4 s on a slow phone, and nothing moves at takeover.
//
//   firstScreenCss()        the /*<fs>*/ ... /*</fs>*/ ranges of landingV6.css (every rule that can match a first-screen
//                           element; landingSpeedFirstScreen.test.js checks it), minified, plus the rules that hold only
//                           while the static screen is up (#lp6-first)
//   firstScreenTemplate()   the markup: TopBar.jsx + Hero.jsx without React's ids and the engine's data-go, and without the
//                           second (night-side) lockup, which is display:none until the engine adds .xing
//   firstScreenStrings()    the project's own dictionary text (src/i18n/da.js, en.js), HTML-escaped here, at build time
//   firstScreenScript()     the inline script for #root
//
// Not in components/landing/v6 or pages/LandingV6Page.jsx on purpose: those keep no HTML sink (landingV6Security).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'

// paths, not URL objects: under the tests' jsdom the global URL is not Node's, and fs refuses it
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8')

// the first screen's strings, in template order ({0} ... {9})
const KEYS = ['nav.label', 'nav.prices', 'nav.login', 'cta', 'h1.shifts', 'h1.tables', 'h1.till', 'sub', 'seePrices', 'trial']
export const FIRST_SCREEN_KEYS = KEYS.map((k) => 'landingV6.' + k)

/** The /*<fs>*\/ ranges of landingV6.css, in file order (raw text). */
export function firstScreenRanges(css = read('components/landing/v6/landingV6.css')) {
  const parts = [...css.matchAll(/\/\*<fs>\*\/([\s\S]*?)\/\*<\/fs>\*\//g)].map((m) => m[1])
  const opens = (css.match(/\/\*<fs>\*\//g) || []).length
  const closes = (css.match(/\/\*<\/fs>\*\//g) || []).length
  if (parts.length < 10 || opens !== parts.length || closes !== parts.length) {
    throw new Error('landingFirstScreen: the /*<fs>*/ markers of landingV6.css are missing or unbalanced')
  }
  return parts
}

// Only while the static screen is up (React's first commit removes #lp6-first, and these stop matching):
//  - the scrollbar the full page will have (no sideways jump at takeover on a classic-scrollbar desktop);
//  - the body rules of src/index.css (lines 144-157) the first screen inherits before that sheet has arrived (the
//    margin and the sideways insets come from landingV6.css's own :root:has(.lp6) body rule);
//  - on the two-column page the hero is the engine's to place: the bar only until the app takes over;
//  - a face named Inter that covers no character: a machine with Inter installed would otherwise draw the first
//    screen in its own copy until the app's sheet declares the web font (a phone has none). A face that merely fails
//    to load does not do it: Chromium then asks the system for "Inter" again.
export const STATE_CSS =
  '@font-face{font-family:Inter;src:local("Helvetica"),local("Arial"),local("Roboto");unicode-range:U+F8FF}' +
  ':root:has(#lp6-first){overflow-y:scroll}' +
  ':root:has(#lp6-first) body{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}' +
  '@media (min-width:1024px) and (min-aspect-ratio:5/4){#lp6-first .hero{visibility:hidden}}'

// Landing speed, step 3: the three committed cuts (scripts/landingFirstFonts.mjs) as data: faces of their own family.
// Never under the name Inter: the app sheet's later face of the same family and weight would replace them and draw the
// text again with the full file (a swap). font-display:block: a data: face is ready within a frame, and the text must
// never show in another face first. landingV6.css's one "Inter First" rule (.top, .hero) stays after the takeover;
// these faces stay with it (the inline sheet is never removed), so the first screen's text never changes face.
export const FIRST_FONT_WEIGHTS = [400, 500, 600]
export function firstScreenFaces() {
  return FIRST_FONT_WEIGHTS.map((w) => {
    const b64 = fs.readFileSync(path.join(SRC, `components/landing/v6/fonts/inter-first-${w}.woff2`)).toString('base64')
    return `@font-face{font-family:"Inter First";font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2")}`
  }).join('')
}

export function firstScreenCss(faces = '') {
  const { code } = transform({ filename: 'landing-first-screen.css', code: Buffer.from(firstScreenRanges().join('\n') + STATE_CSS), minify: true })
  return faces + code.toString()
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// components/landing/v6/rich.jsx's markers, on escaped text: <nw> a no-wrap span, <b> bold, <a> its text (the hero has no link)
const rich = (s) => esc(s)
  .replace(/&lt;nw&gt;([\s\S]*?)&lt;\/nw&gt;/g, '<span class="nw">$1</span>')
  .replace(/&lt;b&gt;([\s\S]*?)&lt;\/b&gt;/g, '<b>$1</b>')
  .replace(/&lt;a&gt;([\s\S]*?)&lt;\/a&gt;/g, '$1')

// components/landing/v6/Flag.jsx, as React renders it
const FLAG = {
  da: '<svg class="flag" viewBox="0 0 24 18" width="24" height="18" aria-hidden="true" focusable="false"><path fill="#C8102E" d="M0 0h24v18H0z"></path><path fill="#FFFFFF" d="M8 0h2v18H8zM0 8h24v2H0z"></path></svg>',
  en: '<svg class="flag" viewBox="0 0 24 18" width="24" height="18" aria-hidden="true" focusable="false"><path fill="#012169" d="M0 0h24v18H0z"></path><path stroke="#FFFFFF" stroke-width="3.6" d="M-4-3L28 21M28-3L-4 21"></path><path fill="#C8102E" d="M0 0L12 9L11.28 9.96L0 1.5ZM24 18L12 9L12.72 8.04L24 16.5ZM24 0L12 9L11.28 8.04L22 0ZM0 18L12 9L12.72 9.96L2 18Z"></path><path fill="#FFFFFF" d="M9 0h6v18H9zM0 6h24v6H0z"></path><path fill="#C8102E" d="M10 0h4v18h-4zM0 7h24v4H0z"></path></svg>',
}

export function firstScreenTemplate() {
  const lock = read('components/landing/v6/Lockup.jsx')
  const vb = lock.match(/LOCKUP_VIEWBOX = "([^"]+)"/)?.[1]
  const paths = [...lock.matchAll(/<path fill="currentColor" d="([^"]+)" \/>/g)].map((m) => `<path fill="currentColor" d="${m[1]}"></path>`)
  if (!vb || paths.length !== 2) throw new Error('landingFirstScreen: Lockup.jsx no longer has its viewBox and two paths')
  const lockup = `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${paths.join('')}</svg>`
  return '<div id="lp6-first" class="lp6 lp6-boot js" lang="{L}">' +
    '<header class="top"><div class="in">' +
    `<a class="logo" href="#main" aria-label="BonBox"><span class="lgA">${lockup}</span></a>` +
    '<nav class="nav" aria-label="{0}">' +
    `<span class="lang"><button type="button" lang="da" aria-label="Dansk" aria-pressed="{A}">${FLAG.da}</button><button type="button" lang="en" aria-label="English" aria-pressed="{B}">${FLAG.en}</button></span>` +
    '<a class="navl prices-l sx f1" href="#pricing">{1}</a>' +
    '<a class="navl login sx f1" href="/login">{2}</a>' +
    '<a class="btn xb" href="/register"><span class="bt">{3}</span></a>' +
    '</nav></div><i class="hl sbg h" aria-hidden="true"></i></header>' +
    '<main><section class="aften"><div class="hero">' +
    '<h1 class="h1"><a href="#s1"><span>{4}</span><sup aria-hidden="true">01</sup></a> <a href="#s2"><span>{5}</span><sup aria-hidden="true">02</sup></a> <a href="#s6"><span>{6}</span><sup aria-hidden="true">03</sup></a></h1>' +
    '<p class="sub">{7}</p>' +
    '<div class="cta-row"><a class="btn btn-lg" href="/register">{3}</a><a class="tlink" href="#pricing">{8}</a></div>' +
    '<p class="trial">{9}</p>' +
    '</div></section></main></div>'
}

export function firstScreenStrings(dict, price) {
  return KEYS.map((k) => {
    const v = dict['landingV6.' + k]
    if (typeof v !== 'string' || !v) throw new Error('landingFirstScreen: missing landingV6.' + k)
    return k === 'trial' ? rich(v.replace(/\{price\}/g, String(price))) : esc(v)
  })
}

/** The finished markup for one language, as the inline script writes it (tests compare it with React's render). */
export function firstScreenMarkup(lang, { da, en, price }) {
  const l = lang === 'da' ? 'da' : 'en'
  const s = firstScreenStrings(l === 'da' ? da : en, price)
  return firstScreenTemplate().replace(/\{(\d)\}/g, (m, i) => s[i]).replace('{L}', l).replace('{A}', String(l === 'da')).replace('{B}', String(l === 'en'))
}

// JSON inside an inline <script>: never a "</script" or "<!--" in the text
export const js = (v) => JSON.stringify(v).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

// Which control a tap or a focus was on, as { r: region, s: selector, i: index }: the same control in React's landing
// is root.querySelector("." + r).querySelectorAll(s)[i] (lib/landingBoot.js replayFirstScreen). Only the controls that
// do nothing until the app has taken over: the flags, "Priser", "Se priser", the headline words and the logo.
// "Prøv gratis" and "Log ind" are real links and stay real links.
const KEY_FN = 'function(t){' +
  'var a=t&&t.closest?t.closest("button[lang],a[href^=\\"#\\"]"):null;if(!a)return null;' +
  'var g=a.closest(".top")?"top":a.closest(".hero")?"hero":null;if(!g)return null;' +
  'var s=a.getAttribute("lang")?"button[lang=\\""+a.getAttribute("lang")+"\\"]":"a[href=\\""+a.getAttribute("href")+"\\"]";' +
  'var b=a.closest("."+g),n=b.querySelectorAll(s),i=0;for(;i<n.length;i++)if(n[i]===a)break;' +
  'return{r:g,s:s,i:i}}'

export function firstScreenScript({ da, en, price }) {
  const T = firstScreenTemplate()
  const S = { da: firstScreenStrings(da, price), en: firstScreenStrings(en, price) }
  return '<script>(function(){try{var f=window.__lp6First;if(!f)return;' +
    `var T=${js(T)},S=${js(S)},l=f.lang==="da"?"da":"en",s=S[l],d=document;` +
    'var h=T.replace(/\\{(\\d)\\}/g,function(m,i){return s[i]}).replace("{L}",l).replace("{A}",l==="da").replace("{B}",l==="en");' +
    'd.currentScript.insertAdjacentHTML("beforebegin",h);' +
    'var r=d.getElementById("lp6-first");' +
    // main.jsx keeps ?ref= (a leave-behind QR's code) in memory only: a tap on these two real links before the app has
    // taken over is a full page load, so they carry it (set as an attribute value through the DOM, never as markup)
    'var q=null;try{q=new URLSearchParams(location.search).get("ref")}catch(e){}' +
    'if(q){var x=r.querySelectorAll("a[href=\\"/register\\"],a[href=\\"/login\\"]");for(var j=0;j<x.length;j++)x[j].setAttribute("href",x[j].getAttribute("href")+"?ref="+encodeURIComponent(q))}' +
    // the other controls do nothing until the app takes over: the last tap or key on one is remembered and replayed
    // then, and keyboard focus moves to the same control (lib/landingBoot.js)
    `var k=${KEY_FN};` +
    'r.addEventListener("click",function(e){if(e.defaultPrevented||e.button||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;var c=k(e.target);if(c){e.preventDefault();f.tap=c}});' +
    'r.addEventListener("focusin",function(e){f.focus=k(e.target)});' +
    // landing speed, step 6: the stage's three Inter files (window.__lp6First.fonts, vite.config.js preloadLanding) start
    // right after this screen's first frame (a font preload known before the first paint delays that paint in Chromium),
    // at 1.5 s at the latest (a hidden tab draws no frame), and no later than DOMContentLoaded: on a fast line the
    // window's load event can come before that frame, and a preload added after it is not matched by the stylesheet's own
    // request (a "preloaded but not used" warning, the file read twice). crossorigin, or each file loads twice.
    'var w=f.fonts||[],o=0,P=function(){if(o)return;o=1;for(var i=0;i<w.length;i++){var n=d.createElement("link");n.rel="preload";n.setAttribute("as","font");n.type="font/woff2";n.setAttribute("crossorigin","");n.href=w[i];d.head.appendChild(n)}};' +
    'if(w.length){if(window.requestAnimationFrame)requestAnimationFrame(function(){setTimeout(P,0)});setTimeout(P,1500);d.addEventListener("DOMContentLoaded",P)}' +
    '}catch(e){}})()</script>'
}
