// bookingEmbed — everything an owner pastes into their own website, built
// from ONE booking URL. Pure string functions (no DOM, no React), so the
// snippets the owner copies, the e-mail they send their web person and the
// local embed check all come from the same code.
//
// Two routes serve the same booking page: the pretty root (/{slug}) and /r/
// {slug}. Only /r/ carries the frame-ancestors CSP that lets another site
// frame it (vercel.json); the bare root inherits the app's frame-ancestors
// 'none'. So: links and buttons may use the pretty URL, an iframe never does.

export const EMBED_FALLBACK_ORIGIN = "https://www.bonbox.dk";

/** Attribute-safe text for the snippets (venue names carry quotes and &). */
export function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The frameable /r/ form of a booking URL.
 *
 * The /r/ prefix is ADDED, not appended blindly: a legacy slug that collides
 * with an app route already comes back as ".../r/<slug>", and an
 * unconditional replace turned that into ".../r/r/<slug>" — a path no route
 * matches, so the owner pasted an iframe that could only show "not found".
 */
export function embedSrcFor(publicUrl) {
  const u = String(publicUrl || "");
  if (/\/r\/[^/]+\/?$/.test(u)) return u.replace(/\/$/, "");
  return u.replace(/\/([^/]+)\/?$/, "/r/$1");
}

/** Origin the height messages must come from. */
export function embedOriginFor(publicUrl) {
  try {
    return new URL(embedSrcFor(publicUrl)).origin;
  } catch {
    return EMBED_FALLBACK_ORIGIN;
  }
}

// One style for the button snippet AND the owner's on-screen preview of it,
// so what they see is what their guests get. Neutral near-black: it sits on
// any site's palette without fighting it.
export const BUTTON_STYLE =
  "display:inline-flex;align-items:center;gap:8px;padding:12px 22px;" +
  "border-radius:12px;background:#111827;color:#fff;font:600 15px/1 system-ui," +
  "sans-serif;text-decoration:none";

/**
 * A plain <a> styled inline — works on any site, opens the booking page.
 * Centred in the owner's column (booking R4): a wrapper with text-align, the
 * one centring every site builder leaves alone (the button is inline-flex).
 */
export function buttonSnippet({ publicUrl, label }) {
  return (
    `<div style="text-align:center">\n` +
    `  <a href="${escapeAttr(publicUrl)}" target="_blank" rel="noopener"\n` +
    `    style="${BUTTON_STYLE}">${escapeAttr(label)}</a>\n` +
    `</div>`
  );
}

/**
 * The page's own query for the iframe. From 450 px the booking draws itself
 * as ONE white card on the host's ground (booking R3); `flat` (&flat=1) keeps
 * it flat for a site that already frames it. `compact` (&compact=1, booking
 * R4) is the short header: no logo, name or address — the owner's own page
 * already shows them — so the times start higher on a phone; the trust line
 * and the DA/EN switch stay.
 *
 * Order is fixed (flat, then compact), so a snippet reads the same for the
 * same choices. With no options it is the bare "?embed=1" every snippet
 * pasted before R4 carries — those keep the full header.
 */
export function embedQuery({ flat = false, compact = false } = {}) {
  let q = "?embed=1";
  if (flat) q += "&flat=1";
  if (compact) q += "&compact=1";
  return q;
}

/**
 * How wide the booking may get in the owner's column (booking R4). The frame
 * is centred and never wider than the column; inside, the card follows the
 * frame up to 560 px (ReservationPublicPage, EMBED_MAX). 460 is the width
 * every snippet had before R4.
 */
export const EMBED_WIDTHS = [460, 560];
export const EMBED_WIDTH_DEFAULT = 460;
export function embedWidthOf(width) {
  const n = Number(width);
  return EMBED_WIDTHS.includes(n) ? n : EMBED_WIDTH_DEFAULT;
}

// The script under the frame. One copy serves every booking frame on the
// page (it finds the frame a message came from, so a builder that renders
// the block twice — a desktop and a mobile copy — still sizes the visible
// one). It trusts only the booking origin AND a frame of ours, takes the
// height as a bounded whole number, and sets it !important so a theme's
// "iframe { height: … !important }" can't pin the frame. On a plain-http
// page the frame can never load (frame-ancestors is https:), so it hides
// the empty box at once and the link under it is the way in.
// ES5 and no // comments: site builders paste it as-is, some on one line.
function heightScript(origin) {
  return (
    `  <script>\n` +
    `  (function(){\n` +
    `    var o='${origin}';\n` +
    `    function all(){return document.querySelectorAll('iframe[data-bonbox-booking]');}\n` +
    `    if(location.protocol==='http:'&&o.indexOf('https:')===0){\n` +
    `      var a=all();for(var i=0;i<a.length;i++)a[i].style.display='none';\n` +
    `    }\n` +
    `    window.addEventListener('message',function(e){\n` +
    `      var d=e.data,h=d&&Math.round(+d.height);\n` +
    `      if(e.origin!==o||!d||d.type!=='bonbox:height'||!(h>0&&h<20000))return;\n` +
    `      var a=all();\n` +
    `      for(var i=0;i<a.length;i++){\n` +
    `        if(a[i].contentWindow!==e.source)continue;\n` +
    `        a[i].style.setProperty('height',h+'px','important');\n` +
    `        var w=a[i].closest&&a[i].closest('[data-bonbox-booking-wrap]');\n` +
    `        var l=w&&w.querySelector('[data-bonbox-booking-link]');\n` +
    `        if(l)l.style.display='none';\n` +
    `      }\n` +
    `    });\n` +
    `  })();\n` +
    // Split so this file never contains a literal closing script tag.
    `  <` + `/script>\n`
  );
}

// ── The restaurant's look (booking R13) ──────────────────────────────
// Manoj, 27–28 Oct 2026: the booking matches the website it sits in,
// automatically, with an owner override. A NEW snippet that opted in
// (data-bonbox-look on the frame; the kit's default) loads ONE small script
// from the booking's own origin — /static/embed1.js (frontend/public/static/
// embed1.js, cached for an hour, vercel.json) — instead of carrying the code
// inline: the snippet stays about 0.9 kB (R4's inline one is 1.4 kB) and the
// hand-off mail fits a mailto: link that every mail program keeps whole
// (R13 fix round: the inline look made it 5.7 kB, the mail 10 kB). The file
// sizes the frame like R4's inline script, and reads the host page's look
// (its surface, text colour, main button, a system font, the frame's
// color-scheme) for the frame — hex digits and fixed words only, to the
// booking origin only; the frame checks every value again
// (src/lib/bookingLook.js).
// A snippet without data-bonbox-look (every one pasted before R13, and a new
// one with "Tilpas automatisk" off) is the R4 snippet, byte for byte.

/** A new snippet's frame title, in mail characters at most (see iframeSnippet). */
export const TITLE_BUDGET = 75;

/** The hosted embed script (v1): its path on the booking origin. */
export const EMBED_SCRIPT_PATH = "/static/embed1.js";

/** The frame's corner (the card's rung) for each ladder step (embed1.js
 *  sets the same on the frame). */
export const LOOK_FRAME_RADIUS = { sharp: "4px", soft: "16px", round: "24px" };

/**
 * The booking form inside the owner's page.
 *
 * The frame reports its own height (ReservationPublicPage, ?embed=1 posts
 * {type:"bonbox:height"}), and the script resizes the iframe to match — a
 * fixed height was wrong on every site: cut off on a phone, dead white space
 * on a desktop.
 *
 * Booking R4 ("fits any website"): the wrapper is centred in the owner's
 * column (width:100% + max-width + margin:0 auto — it also centres inside a
 * builder's flex column) at the width the owner chose (EMBED_WIDTHS). The
 * frame and the link carry data- attributes the script finds them by, so no
 * id can collide with the owner's page or a second copy of the block.
 *
 * The link under the frame is for the owner whose site is still plain http
 * (frame-ancestors is https:, so the frame is blank there; the script hides
 * the empty box). It hides itself the moment the frame proves it loaded.
 * Everything degrades: if the site builder strips the <script>, the frame
 * keeps its 720px (an inner scroll if the form is taller) and the link stays.
 *
 * A snippet pasted before R4 (id="bonbox-booking", its own listener) keeps
 * working unchanged: the page still posts the same message.
 */
export function iframeSnippet({
  publicUrl,
  label,
  venueName,
  fallbackLabel,
  flat = false,
  compact = false,
  width = EMBED_WIDTH_DEFAULT,
  // Booking R13: the restaurant's look — { mode: "auto" | "light" | "dark",
  // accent: "site" | "own" } — or null.
  look = null,
  // Booking R13 fix round: a NEW snippet (the kit always asks for one) loads
  // the hosted script (/static/embed1.js) instead of carrying R4's inline
  // one, with or without the look: short enough for a mailto: link. Without
  // `hosted` and without a look this is the R4 snippet, byte for byte — the
  // code owners have pasted since R4 (pinned by the tests).
  hosted = false,
}) {
  const src = embedSrcFor(publicUrl);
  const origin = embedOriginFor(publicUrl);
  const lk = lookOf(look);
  // A new snippet travels in a mailto: link (≤ 2,000 characters in every
  // case), so the frame's title (what a screen reader names it) keeps the
  // venue's name only as far as TITLE_BUDGET mail characters go — a name
  // full of æøå or "&" costs many. The R4 form is unchanged.
  let title = `${label} — ${venueName || "BonBox"}`;
  if (lk || hosted) {
    let name = String(venueName || "BonBox");
    while (name && encodeURIComponent(escapeAttr(`${label} — ${name}…`)).length > TITLE_BUDGET) name = name.slice(0, -1);
    if (name !== String(venueName || "BonBox")) title = `${label} — ${name.trimEnd()}…`;
  }
  const w = embedWidthOf(width);
  // The owner's colour is the exception, so only it is written out:
  // data-bonbox-accent="own"; no attribute = the site's button colour.
  const attrs = lk ? ` data-bonbox-look="${lk.mode}"` + (lk.accent === "own" ? ` data-bonbox-accent="own"` : "") : "";
  // R13 fix round 2. With the look, the frame's address says `look=1` from
  // the start ("a look comes by message"): the frame paints nothing until
  // the hosted script sends it (or 1.3 s pass) and the script never changes
  // the src — one load, never a white card first. A new snippet's <iframe>
  // also says color-scheme:light, the frame document's own scheme: a site
  // with `color-scheme: dark` can no longer make the browser put an opaque
  // box behind the frame, script or no script.
  const query = embedQuery({ flat, compact }) + (lk ? "&look=1" : "");
  const frameStyle = "display:block;border:0;width:100%;border-radius:16px" + (lk || hosted ? ";color-scheme:light" : "");
  return (
    `<div data-bonbox-booking-wrap style="width:100%;max-width:${w}px;margin:0 auto">\n` +
    `  <iframe data-bonbox-booking${attrs} src="${escapeAttr(src + query)}"\n` +
    `    title="${escapeAttr(title)}" width="100%" height="720" loading="lazy"\n` +
    `    style="${frameStyle}"></iframe>\n` +
    `  <p data-bonbox-booking-link style="margin:8px 0 0;text-align:center;font:400 14px/1.4 system-ui,sans-serif">\n` +
    `    <a href="${escapeAttr(publicUrl)}" target="_blank" rel="noopener">${escapeAttr(fallbackLabel)}</a>\n` +
    `  </p>\n` +
    (lk || hosted ? `  <script src="${escapeAttr(origin + EMBED_SCRIPT_PATH)}"><` + `/script>\n` : heightScript(origin)) +
    `</div>`
  );
}

/** The owner's look choice, read strictly: null = off. */
export const LOOK_MODES = ["auto", "light", "dark"];
export const LOOK_ACCENTS = ["site", "own"];
export function lookOf(look) {
  if (!look || typeof look !== "object") return null;
  const mode = LOOK_MODES.includes(look.mode) ? look.mode : "auto";
  const accent = LOOK_ACCENTS.includes(look.accent) ? look.accent : "site";
  return { mode, accent };
}

// Three stand-in websites for the kit's preview (R13: "show the owner what it
// will look like", light, dark and a photo). Exactly the values the script
// would send from such a site: a cream page in Georgia with round brown
// buttons, a black page with square gold buttons, a photo with white soft
// buttons.
export const LOOK_SAMPLES = {
  light: { surface: "f4efe6", ink: "2b2118", accent: "7c4a1e", accent_ink: "ffffff", radius: "round", font: "georgia" },
  dark: { surface: "121212", ink: "ededed", accent: "c9a45c", accent_ink: "111111", radius: "sharp", font: "helvetica" },
  photo: { surface: "photo", ink: "ffffff", accent: "ffffff", accent_ink: "1a1a1a", radius: "soft", font: "system" },
};
export const LOOK_SAMPLE_IDS = ["light", "dark", "photo"];

/**
 * The look query a sample site gives the frame (the kit's preview), in the
 * script's own order: look, theme (only when the owner forced one), surface,
 * ink, accent + accent_ink (only "Fra din hjemmeside"), radius, font.
 * "" when the look is off.
 */
export function sampleLookQuery(sampleId, look) {
  const lk = lookOf(look);
  const s = LOOK_SAMPLES[sampleId];
  if (!lk || !s) return "";
  let q = "look=1";
  if (lk.mode !== "auto") q += "&theme=" + lk.mode;
  q += "&surface=" + s.surface + "&ink=" + s.ink;
  if (lk.accent === "site") q += "&accent=" + s.accent + "&accent_ink=" + s.accent_ink;
  return q + "&radius=" + s.radius + "&font=" + s.font;
}

/**
 * Where the owner's live preview loads the booking page from.
 *
 * The app's own origin when it is a web origin: in production that IS the
 * booking origin (www.bonbox.dk), and in a local or preview build it is the
 * page the same build serves — never a production page for a slug that only
 * exists locally. The native shell's custom scheme falls back to the public
 * URL.
 */
export function previewSrcFor(publicUrl, appOrigin, { flat = false, compact = false, lookQuery = "" } = {}) {
  const src = embedSrcFor(publicUrl);
  const q = embedQuery({ flat, compact }) + (lookQuery ? "&" + lookQuery : "");
  let path = "";
  try {
    path = new URL(src).pathname;
  } catch {
    return `${src}${q}`;
  }
  if (typeof appOrigin === "string" && /^https?:\/\/[^/]+$/.test(appOrigin)) {
    return `${appOrigin}${path}${q}`;
  }
  return `${src}${q}`;
}

/** mailto: that only OPENS the owner's mail app — BonBox sends nothing. */
export function mailtoHref({ subject, body }) {
  return (
    "mailto:?subject=" + encodeURIComponent(subject || "") +
    "&body=" + encodeURIComponent(body || "")
  );
}

/** File name for the QR download: the slug, so a print shop can tell them apart. */
export function qrFileName(publicUrl) {
  const m = String(publicUrl || "").match(/\/([a-z0-9-]+)\/?$/i);
  return `booking-qr-${m ? m[1].toLowerCase() : "bonbox"}.png`;
}

// Site builders the guide covers, in the order Danish venues use them. Four
// numbered steps each — open, add, paste (the step that carries the copy
// button), publish — plus short notes under them. A builder names its own
// paste/publish step where the generic one would mislead; otherwise the
// generic one. Menu names are the ones the builder shows (WordPress and
// Elementor in Danish; Wix and Squarespace by their English names, which is
// what their help pages and most Danish owners' editors show) — a wrong menu
// name is worse than none, so the rest stays generic.
// WordPress has two editors in Danish venues' sites: the block editor and
// Elementor; the WordPress guide points to Elementor's for "Rediger med
// Elementor" (booking R4).
export const SITE_BUILDERS = [
  {
    id: "wix", name: "Wix",
    open: "rsvpWebGuideWixOpen", add: "rsvpWebGuideWixAdd",
    publish: "rsvpWebGuideWixPublish", notes: ["rsvpWebGuideWixNote"],
  },
  {
    id: "wordpress", name: "WordPress",
    open: "rsvpWebGuideWpOpen", add: "rsvpWebGuideWpAdd",
    paste: "rsvpWebGuideWpPaste", publish: "rsvpWebGuideWpPublish",
    notes: ["rsvpWebGuideWpElementorNote", "rsvpWebGuideWpCodeNote"],
  },
  {
    id: "elementor", name: "Elementor",
    open: "rsvpWebGuideElOpen", add: "rsvpWebGuideElAdd",
    paste: "rsvpWebGuideElPaste", publish: "rsvpWebGuideWpPublish",
    notes: ["rsvpWebGuideElNote"],
  },
  {
    id: "squarespace", name: "Squarespace",
    open: "rsvpWebGuideSqOpen", add: "rsvpWebGuideSqAdd",
    paste: "rsvpWebGuidePastePlain", notes: ["rsvpWebGuideSqNote", "rsvpWebGuideSqPlanNote"],
  },
  { id: "onecom", name: "One.com", open: "rsvpWebGuideOneOpen", add: "rsvpWebGuideGenericAdd", wpNote: true },
  { id: "simply", name: "Simply.com", open: "rsvpWebGuideSimplyOpen", add: "rsvpWebGuideGenericAdd", wpNote: true },
  { id: "shopify", name: "Shopify", open: "rsvpWebGuideShopifyOpen", add: "rsvpWebGuideShopifyAdd" },
];

/** The four step keys of a builder's guide, in order (paste is index 2). */
export function guideStepKeys(builder) {
  const b = builder || SITE_BUILDERS[0];
  return [b.open, b.add, b.paste || "rsvpWebGuidePaste", b.publish || "rsvpWebGuidePublish"];
}

/** The note keys under a builder's steps (WordPress-based hosts point there). */
export function guideNoteKeys(builder) {
  const b = builder || SITE_BUILDERS[0];
  return [...(b.notes || []), ...(b.wpNote ? ["rsvpWebGuideWpNote"] : [])];
}
