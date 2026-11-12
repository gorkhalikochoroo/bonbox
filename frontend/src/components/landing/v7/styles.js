/* The v7 landing's stylesheet and its type: Sora (headings, numbers) and DM Sans (body), the house family, self-hosted
 * from @fontsource (latin cut: the Danish letters are in it), hashed under /assets/ (CSP font-src 'self'). Only the
 * weights the page draws: Sora 400 / 600, DM Sans 400 / 500 / 600. The app's own Inter (main.jsx) stays for the cookie
 * banner and every app page.
 *
 * Imported by the landing page only, so all of it rides in its lazy chunk. landingV7.css carries no @import of its own
 * (a CSS @import would make @tailwindcss/postcss treat the file as a Tailwind root). */
import "@fontsource/sora/latin-400.css";
import "@fontsource/sora/latin-600.css";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "./landingV7.css";
