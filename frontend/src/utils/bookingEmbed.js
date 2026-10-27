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

/** A plain <a> styled inline — works on any site, opens the booking page. */
export function buttonSnippet({ publicUrl, label }) {
  return (
    `<a href="${escapeAttr(publicUrl)}" target="_blank" rel="noopener"\n` +
    `  style="${BUTTON_STYLE}">${escapeAttr(label)}</a>`
  );
}

/**
 * The page's own query for the iframe. From 450 px the booking draws itself
 * as ONE white card on the host's ground (booking R3); `flat` (&flat=1) keeps
 * it flat for a site that already frames it.
 */
export function embedQuery({ flat = false } = {}) {
  return flat ? "?embed=1&flat=1" : "?embed=1";
}

/**
 * The booking form inside the owner's page.
 *
 * The frame reports its own height (ReservationPublicPage, ?embed=1 posts
 * {type:"bonbox:height"}), and the script resizes the iframe to match — a
 * fixed height was wrong on every site: cut off on a phone, dead white space
 * on a desktop. The listener only trusts messages from the booking origin
 * AND from this frame's own window.
 *
 * The link under the frame is for the owner whose site is still plain http
 * (frame-ancestors is https:, so the frame is silently blank there). It hides
 * itself the moment the frame proves it loaded. Everything degrades: if the
 * site builder strips the <script>, the frame keeps its 720px and the link
 * stays.
 */
export function iframeSnippet({ publicUrl, label, venueName, fallbackLabel, flat = false }) {
  const src = embedSrcFor(publicUrl);
  const origin = embedOriginFor(publicUrl);
  const title = `${label} — ${venueName || "BonBox"}`;
  return (
    `<div style="max-width:460px">\n` +
    `  <iframe id="bonbox-booking" src="${escapeAttr(src + embedQuery({ flat }))}"\n` +
    `    title="${escapeAttr(title)}" width="100%" height="720" loading="lazy"\n` +
    `    style="border:0;width:100%;border-radius:16px"></iframe>\n` +
    `  <p id="bonbox-booking-link" style="margin:8px 0 0;font:400 14px/1.4 system-ui,sans-serif">\n` +
    `    <a href="${escapeAttr(publicUrl)}" target="_blank" rel="noopener">${escapeAttr(fallbackLabel)}</a>\n` +
    `  </p>\n` +
    `  <script>\n` +
    `  (function(){\n` +
    `    var f=document.getElementById('bonbox-booking');\n` +
    `    var l=document.getElementById('bonbox-booking-link');\n` +
    `    window.addEventListener('message',function(e){\n` +
    `      if(e.origin!=='${origin}'||!f||e.source!==f.contentWindow)return;\n` +
    `      if(!e.data||e.data.type!=='bonbox:height')return;\n` +
    `      f.style.height=e.data.height+'px';\n` +
    `      if(l)l.style.display='none';\n` +
    `    });\n` +
    `  })();\n` +
    // Split so this file never contains a literal closing script tag.
    `  <` + `/script>\n` +
    `</div>`
  );
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
export function previewSrcFor(publicUrl, appOrigin, { flat = false } = {}) {
  const src = embedSrcFor(publicUrl);
  const q = embedQuery({ flat });
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

// Site builders the guide covers, in the order Danish venues use them. The
// steps are deliberately generic ("an HTML / Embed block") — menu names move
// between versions and languages, and a wrong menu name is worse than none.
export const SITE_BUILDERS = [
  { id: "wix", name: "Wix", open: "rsvpWebGuideWixOpen", add: "rsvpWebGuideWixAdd" },
  { id: "wordpress", name: "WordPress", open: "rsvpWebGuideWpOpen", add: "rsvpWebGuideWpAdd" },
  { id: "squarespace", name: "Squarespace", open: "rsvpWebGuideSqOpen", add: "rsvpWebGuideSqAdd" },
  { id: "onecom", name: "One.com", open: "rsvpWebGuideOneOpen", add: "rsvpWebGuideGenericAdd", wpNote: true },
  { id: "simply", name: "Simply.com", open: "rsvpWebGuideSimplyOpen", add: "rsvpWebGuideGenericAdd", wpNote: true },
  { id: "shopify", name: "Shopify", open: "rsvpWebGuideShopifyOpen", add: "rsvpWebGuideShopifyAdd" },
];
