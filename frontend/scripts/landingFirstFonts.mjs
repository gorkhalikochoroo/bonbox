// (No #! line: the tests import this file through Vite, which puts an import above line 1.)
// The first screen's own Inter (landing speed, step 3; 10 Nov 2026). Cuts the latin Inter 400 / 500 / 600 files the
// app already ships (@fontsource/inter) down to the characters the landing's first screen draws in Danish and English,
// every layout feature kept (kerning, contextual forms), and writes them to src/components/landing/v6/fonts/. The build
// inlines them as data: faces of the family "Inter First" (scripts/landingFirstScreen.mjs firstScreenFaces), so the
// first text is Inter from its first frame and never changes face, before or after the app takes over.
//
// Run by hand after a change to the first screen's words (needs fonttools' pyftsubset with brotli):
//   node scripts/landingFirstFonts.mjs
// landingSpeedFirstFonts.test.jsx fails when a character of those words is missing from the committed cut of its weight.
// WEIGHTS is the one list of which string is drawn at which weight (landingV6.css: .navl, .sub, .trial 400; .tlink and
// the headline's small numbers 500; the headline words and both "Prøv gratis" 600).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = (f) => path.join(ROOT, f)
const DIGITS = '0123456789'
export const WEIGHTS = {
  // the subline, the trial line (its price is a number: every digit), Priser, Log ind
  400: { keys: ['sub', 'trial', 'nav.prices', 'nav.login'], more: DIGITS },
  // "Se priser" beside the button; the headline's small numbers (01 02 03, two-column page)
  500: { keys: ['seePrices'], more: '0123' },
  // the headline's three words, "Prøv gratis" (hero and top bar)
  600: { keys: ['h1.shifts', 'h1.tables', 'h1.till', 'cta'], more: '' },
}
export const FIRST_FONT_FILE = (w) => `src/components/landing/v6/fonts/inter-first-${w}.woff2`
// Landing speed, step 6: Inter 300 is drawn by the stage clock and the stacked page's times only (landingV6.css
// .lp6.story .clock, .clock .dg b, .lp6:not(.story) .copy time): digits, "." (Danish) and ":" (English). Its own cut
// (fonts/inter-300-digits.woff2, inlined into the landing's stylesheet) replaces @fontsource/inter/latin-300.css
// (24 KB, a request of its own). The space is in the cut and in its unicode-range on purpose: a line's metrics come
// from the first font that covers U+0020; without it the system font's did, and the clock's digits sat 1 px lower.
export const DIGITS_300 = '0123456789.: '
export const DIGITS_300_FILE = 'src/components/landing/v6/fonts/inter-300-digits.woff2'

/** The characters a weight must hold: its strings in every given dictionary (markers and {price} out), plus extras. */
export function firstScreenChars(weight, dicts) {
  const w = WEIGHTS[weight]
  let text = ' ' + w.more
  for (const d of dicts) for (const k of w.keys) text += String(d['landingV6.' + k]).replace(/<\/?(nw|b|a)>/g, '').replace(/\{price\}/g, '')
  return [...new Set(text)].sort().join('')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [{ da }, { en }] = await Promise.all(['src/i18n/da.js', 'src/i18n/en.js'].map((f) => import(pathToFileURL(path.join(ROOT, f)).href)))
  for (const weight of Object.keys(WEIGHTS)) {
    const chars = firstScreenChars(weight, [da, en])
    const src = at(`node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`)
    const out = at(FIRST_FONT_FILE(weight))
    const r = spawnSync('pyftsubset', [src, `--text=${chars}`, '--layout-features=*', '--flavor=woff2', `--output-file=${out}`], { encoding: 'utf8' })
    if (r.status !== 0) { console.error(r.stderr || r.error); process.exit(1) }
    console.log(weight, JSON.stringify(chars), chars.length, 'chars ->', fs.statSync(out).size, 'bytes')
  }
  {
    const src = at('node_modules/@fontsource/inter/files/inter-latin-300-normal.woff2')
    const out = at(DIGITS_300_FILE)
    const r = spawnSync('pyftsubset', [src, `--text=${DIGITS_300}`, '--layout-features=*', '--flavor=woff2', `--output-file=${out}`], { encoding: 'utf8' })
    if (r.status !== 0) { console.error(r.stderr || r.error); process.exit(1) }
    console.log('300 digits ->', fs.statSync(out).size, 'bytes')
  }
}
