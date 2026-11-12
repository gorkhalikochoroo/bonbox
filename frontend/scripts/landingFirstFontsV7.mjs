// The v7 landing's first-screen fonts (12 Nov 2026): three small cuts of the house family holding exactly the characters
// the HTML's first screen draws (the top bar and the hero, Danish and English), committed beside the page and inlined
// into the built index.html as data: faces "Sora First" / "DM Sans First" (scripts/landingFirstScreenV7.mjs), so the
// first screen paints in its own type at once, with no font request and no swap. Same method as the v6 cuts
// (scripts/landingFirstFonts.mjs): pyftsubset with every layout feature, woff2.
//
//   node scripts/landingFirstFontsV7.mjs      (from frontend/; needs pyftsubset: pip install fonttools brotli)
//
// Re-run it whenever a first-screen string changes; landingV7FirstScreen.test.js fails while a character is missing.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = (f) => path.join(ROOT, f)
const DIGITS = '0123456789'

// Which first-screen strings each cut draws (keys under landingV7.*). The eyebrow is set in capitals by the stylesheet,
// so every cut holds both cases of its text.
export const FIRST_FONTS_V7 = {
  'sora-600': { pkg: '@fontsource/sora/files/sora-latin-600-normal.woff2', keys: ['h1.shifts', 'h1.tables', 'h1.till'], more: 'BonBoxb.' },
  'dmsans-400': { pkg: '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2', keys: ['nav.shifts', 'nav.tables', 'nav.till', 'nav.addons', 'nav.prices', 'nav.login', 'hero.lede', 'hero.fine', 'demo.caption'], more: DIGITS },
  'dmsans-600': { pkg: '@fontsource/dm-sans/files/dm-sans-latin-600-normal.woff2', keys: ['hero.eyebrow', 'cta', 'cta14', 'ctaDay', 'demo.again'], more: 'DKENG' },
}
export const FIRST_FONT_FILE_V7 = (cut) => `src/components/landing/v7/fonts/${cut}-first.woff2`

/** The characters a cut must hold: its strings in every dictionary ({…} placeholders out), both cases, plus extras. */
export function firstScreenCharsV7(cut, dicts) {
  const c = FIRST_FONTS_V7[cut]
  let text = ' ' + c.more
  for (const d of dicts) for (const k of c.keys) text += String(d['landingV7.' + k]).replace(/\{[a-z]+\}/g, '')
  text += text.toUpperCase() + text.toLowerCase()
  return [...new Set(text)].sort().join('')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [{ da }, { en }] = await Promise.all(['src/i18n/da.js', 'src/i18n/en.js'].map((f) => import(pathToFileURL(at(f)).href)))
  for (const cut of Object.keys(FIRST_FONTS_V7)) {
    const chars = firstScreenCharsV7(cut, [da, en])
    const out = at(FIRST_FONT_FILE_V7(cut))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const r = spawnSync('pyftsubset', [at('node_modules/' + FIRST_FONTS_V7[cut].pkg), `--text=${chars}`, '--layout-features=*', '--flavor=woff2', `--output-file=${out}`], { encoding: 'utf8' })
    if (r.status !== 0) { console.error(r.stderr || r.error); process.exit(1) }
    console.log(cut, chars.length, 'chars ->', fs.statSync(out).size, 'bytes')
  }
}
