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
function heightScript(origin, look = false) {
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
    (look ? LOOK_ON : "") +
    `        a[i].style.setProperty('height',h+'px','important');\n` +
    `        var w=a[i].closest&&a[i].closest('[data-bonbox-booking-wrap]');\n` +
    `        var l=w&&w.querySelector('[data-bonbox-booking-link]');\n` +
    `        if(l)l.style.display='none';\n` +
    `      }\n` +
    `    });\n` +
    (look ? LOOK_JS : "") +
    `  })();\n` +
    // Split so this file never contains a literal closing script tag.
    `  <` + `/script>\n`
  );
}

// ── The restaurant's look (booking R13) ──────────────────────────────
// Manoj, 27–28 Oct 2026: the booking matches the website it sits in,
// automatically, with an owner override. In a NEW snippet that opted in
// (data-bonbox-look on the frame; the kit's default), the script below reads
// the host page ONCE before the frame opens — then again on a theme switch
// (the phone's prefers-color-scheme, a class or data-theme change on <html> /
// <body>, the rest of the page parsed), at most five changes per page view:
//   surface  the first ancestor of the box with a background: its colour,
//            or "photo" for a background image (or gradient);
//   ink      the box's text colour (the page's own, not a browser default:
//            an unstyled document — Wix's Embed HTML box — gives none);
//   accent   the colour most of the page's visible buttons share (<button>,
//            submit inputs, role=button, and any class with "btn" or
//            "button"/"Button" in it — WordPress, Elementor, Squarespace and
//            Wix button classes among them), never one that is the surface's
//            own; its text colour (accent_ink) and its corners (radius:
//            sharp / soft / round) with it;
//   font     the body's or a heading's first family, when it is one of the
//            system fonts the frame can paint (LOOK_FONTS); else nothing and
//            Inter stays;
//   theme    only when the owner forced Lys / Mørk (data-bonbox-look);
//   scheme   the frame element's own color-scheme (light / dark / "light
//            dark" = ld), when the site sets one: a frame whose document
//            declares another scheme than its <iframe> gets an OPAQUE canvas
//            from the browser (CSS Color Adjust) — a white or black box round
//            the card on exactly the dark sites R13 is for. The frame
//            declares the same one, so its ground stays see-through.
// It sends hex digits and fixed words only, and only to the booking origin:
// first in the frame's address (`look=1&…`, before it loads), later as a
// {type:'bonbox:look', q} message once the frame has said its height (the
// guest's half-filled booking is never reloaded). The frame trusts none of
// it: it validates every value again (src/lib/bookingLook.js).
// A snippet without data-bonbox-look (every one pasted before R13, and a new
// one with "Tilpas automatisk" off) is the R4 snippet, byte for byte.
// ES5 and no line comments: builders paste it as-is, some on one line. No
// indentation either: the hand-off mail carries the snippet in a mailto:
// link, where every space costs three characters.

/** The frame's corner (the card's rung) for each ladder step. */
export const LOOK_FRAME_RADIUS = { sharp: "4px", soft: "16px", round: "24px" };

// Under the height listener: the first height says the frame is up; a look
// the page found after the frame's address was set is sent then.
const LOOK_ON =
  `        if(!a[i].bbOn){a[i].bbOn=1;if(a[i].bbQ!=null&&a[i].bbQ!==a[i].bbS){a[i].bbS=a[i].bbQ;a[i].contentWindow.postMessage({type:'bonbox:look',q:a[i].bbQ},o);}}\n`;

const LOOK_JS = String.raw`var cv,U=0,N=0,T;
function rgb(c){
var m=/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s\/]+([\d.]+)(%?))?\s*\)$/.exec(c||'');
if(m)return [+m[1],+m[2],+m[3],m[4]==null?1:(m[5]?m[4]/100:+m[4])];
if(!c||c==='transparent')return null;
try{
if(!cv)cv=document.createElement('canvas').getContext('2d');
if(!cv)return null;
cv.fillStyle='#010203';cv.fillStyle=c;
if(cv.fillStyle==='#010203')return null;
cv.clearRect(0,0,1,1);cv.fillRect(0,0,1,1);
var p=cv.getImageData(0,0,1,1).data;return [p[0],p[1],p[2],p[3]/255];
}catch(x){return null;}
}
function hx(c){var v=rgb(c);if(!v||v[3]<0.5)return null;return ((1<<24)+(Math.round(v[0])<<16)+(Math.round(v[1])<<8)+Math.round(v[2])).toString(16).slice(1);}
function lu(h){var n=parseInt(h,16),r=0,i,s;for(i=0;i<3;i++){s=((n>>(16-8*i))&255)/255;r+=[0.2126,0.7152,0.0722][i]*(s<=0.04045?s/12.92:Math.pow((s+0.055)/1.055,2.4));}return r;}
function ct(a,b){var x=lu(a),y=lu(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
function cs(e){return window.getComputedStyle(e);}
function sf(e){for(;e&&e.nodeType===1;e=e.parentElement){var s=cs(e),g=s.backgroundImage;if(g&&g!=='none')return 'photo';var h=hx(s.backgroundColor);if(h)return h;}return null;}
function ff(e){var f=e&&cs(e).fontFamily;if(!f)return null;var n=f.split(',')[0].replace(/["']/g,'').replace(/^\s+|\s+$/g,'').toLowerCase();return /^(system-ui|-apple-system|blinkmacsystemfont|segoe ui|roboto)$/.test(n)?'system':/^(helvetica neue|helvetica|arial)$/.test(n)?'helvetica':n==='georgia'?'georgia':/^times( new roman)?$/.test(n)?'times':null;}
function bt(w,s0){
var q=document.querySelectorAll('button,[type=submit],[type=button],[role=button],[class*=btn],[class*=utton]'),n={},b=null,i,e,s,r,h;
for(i=0;i<q.length&&i<80;i++){
e=q[i];if(w&&w.contains(e))continue;
s=cs(e);if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)===0)continue;
r=e.getBoundingClientRect();if(r.width<24||r.height<16)continue;
h=hx(s.backgroundColor);if(!h||(s0&&s0!=='photo'&&ct(h,s0)<1.3))continue;
n[h]=(n[h]||0)+1;if(!b||n[h]>n[b.h])b={h:h,s:s,r:r};
}
return b;
}
function rd(b){
if(!b)return null;
var t=b.s.borderTopLeftRadius||b.s.borderRadius||'',v=parseFloat(t)||0;
if(/%/.test(t))return v>=25?'round':v>0?'soft':'sharp';
if(v>=24||(v>0&&b.r.height>0&&v>=b.r.height/2-1))return 'round';
return v<=6?'sharp':'soft';
}
function lq(f){
var m=f.getAttribute('data-bonbox-look'),w=f.closest&&f.closest('[data-bonbox-booking-wrap]'),c=(w&&w.parentElement)||document.body;
var st=!!(document.styleSheets&&document.styleSheets.length),q='look=1',s=sf(c),k,b,x;
if(m==='light'||m==='dark')q+='&theme='+m;
x=cs(f).colorScheme||'';x=/dark/.test(x)?(/light/.test(x)?'ld':'dark'):/light/.test(x)?'light':'';if(x)q+='&scheme='+x;
if(s)q+='&surface='+s;
k=st&&hx(cs(c).color);if(k)q+='&ink='+k;
b=bt(w,s);
if(b&&f.getAttribute('data-bonbox-accent')!=='own'){q+='&accent='+b.h;x=hx(b.s.color);if(x)q+='&accent_ink='+x;}
x=rd(b);if(x)q+='&radius='+x;
k=st&&(ff(document.body)||ff(document.querySelector('h1,h2')));if(k)q+='&font='+k;
return [q,x];
}
function run(){
var a=all(),i,f,r,q;
for(i=0;i<a.length;i++){
f=a[i];if(!f.getAttribute('data-bonbox-look'))continue;
if(f.bbB==null)f.bbB=f.getAttribute('src')||'';
r=lq(f);q=r[0];
if(r[1])f.style.borderRadius={sharp:'4px',soft:'16px',round:'24px'}[r[1]];
if(q===f.bbQ)continue;
if(f.bbQ!=null){if(U>4)continue;U++;}
f.bbQ=q;
if(f.bbS==null){f.bbS=q;f.src=f.bbB+(f.bbB.indexOf('?')<0?'?':'&')+q;}
else if(f.bbOn){f.bbS=q;f.contentWindow.postMessage({type:'bonbox:look',q:q},o);}
}
}
function again(){if(N>29)return;clearTimeout(T);T=setTimeout(function(){N++;run();},150);}
run();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',again);
try{var mq=window.matchMedia('(prefers-color-scheme: dark)');if(mq.addEventListener)mq.addEventListener('change',again);else if(mq.addListener)mq.addListener(again);}catch(x){}
if(window.MutationObserver){var mo=new MutationObserver(again),op={attributes:true,attributeFilter:['class','data-theme']};mo.observe(document.documentElement,op);if(document.body)mo.observe(document.body,op);}
`;

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
  // Booking R13: the restaurant's look. null (the default, and "Tilpas
  // automatisk" off) = the R4 snippet, byte for byte. Otherwise
  // { mode: "auto" | "light" | "dark", accent: "site" | "own" }.
  look = null,
}) {
  const src = embedSrcFor(publicUrl);
  const origin = embedOriginFor(publicUrl);
  const title = `${label} — ${venueName || "BonBox"}`;
  const w = embedWidthOf(width);
  const lk = lookOf(look);
  const attrs = lk ? ` data-bonbox-look="${lk.mode}" data-bonbox-accent="${lk.accent}"` : "";
  return (
    `<div data-bonbox-booking-wrap style="width:100%;max-width:${w}px;margin:0 auto">\n` +
    `  <iframe data-bonbox-booking${attrs} src="${escapeAttr(src + embedQuery({ flat, compact }))}"\n` +
    `    title="${escapeAttr(title)}" width="100%" height="720" loading="lazy"\n` +
    `    style="display:block;border:0;width:100%;border-radius:16px"></iframe>\n` +
    `  <p data-bonbox-booking-link style="margin:8px 0 0;text-align:center;font:400 14px/1.4 system-ui,sans-serif">\n` +
    `    <a href="${escapeAttr(publicUrl)}" target="_blank" rel="noopener">${escapeAttr(fallbackLabel)}</a>\n` +
    `  </p>\n` +
    heightScript(origin, !!lk) +
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
