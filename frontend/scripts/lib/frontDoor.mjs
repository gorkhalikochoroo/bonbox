/**
 * The front door's own document, checked on the live site (landing v7 review, 12 Nov 2026).
 *
 * "/" gets dist/landing.html (index.html + the hero picture's phone cut, <style id="lp7-hero">) only when Vercel's build
 * ran with VERCEL=1: vite.config.js landingDocument then leaves index.html out, and vercel.json's "/" rewrite decides.
 * Without it "/" quietly gets index.html: the page works, but the phone speed fix is not live. Every other address gets
 * app.html (index.html, no picture bytes). prod-healthcheck.mjs runs this after a deploy, so that quiet fallback is said
 * out loud. Three outcomes, never a boolean: the landing document, not the landing document, or couldn't check.
 *
 * No deps, no network here (the health check fetches; this only reads what it got), so a test can import it.
 */
export const FRONT_DOOR_MARKER = 'id="lp7-hero"'
/** An address that must get app.html, never the landing's document. */
export const FRONT_DOOR_OTHER = '/login'

/** rootHtml: what "/" answered (string). otherHtml: what FRONT_DOOR_OTHER answered, or null when it could not be read. */
export function frontDoorFindings(rootHtml, otherHtml) {
  const warnings = []
  const notes = []
  const root = typeof rootHtml === 'string' && rootHtml.includes(FRONT_DOOR_MARKER)
  notes.push(`front door: "/" ${root ? 'is' : 'is NOT'} the landing document (lp7-hero)`)
  if (!root) {
    warnings.push(
      'front door: "/" has no lp7-hero, so it is index.html, not landing.html: the phone hero picture is not live ' +
        '(was VERCEL=1 missing at build time? vite.config.js landingDocument). The page still works.',
    )
  }
  if (typeof otherHtml !== 'string') {
    warnings.push(`front door: could not read ${FRONT_DOOR_OTHER} to check it gets app.html (not checked)`)
  } else if (otherHtml.includes(FRONT_DOOR_MARKER)) {
    warnings.push(`front door: ${FRONT_DOOR_OTHER} carries lp7-hero: every address but "/" and "/v2" must get app.html`)
  } else {
    notes.push(`front door: ${FRONT_DOOR_OTHER} gets the app document (no lp7-hero)`)
  }
  return { warnings, notes }
}
