/* The v6 landing's stylesheet and the one extra Inter weight it needs (PORT_PLAN 1.8).
 *
 * main.jsx loads Inter 400/500/600/700/800 (latin) for the whole app. The stage
 * clock is Inter 300, so the landing brings latin-300 with it: one self-hosted
 * woff2 (~24 KB) from @fontsource/inter, hashed under /assets/ (CSP font-src
 * 'self'), fetched only on the landing. The prototype's own fonts/ folder and
 * its <link rel=preload> are not ported. Danish letters are in the latin file.
 *
 * Imported by the landing page only, so both stylesheets ride in its lazy chunk.
 * landingV6.css carries no @import of its own: a CSS @import would make
 * @tailwindcss/postcss treat the file as a Tailwind root.
 */
import "@fontsource/inter/latin-300.css";
import "./landingV6.css";
