// The booking page's parse-time script (booking R5, "fast on slow phones").
//
// vite.config.js (bonbox-booking-boot) writes this into index.html right
// after <meta charset>, ahead of every other script and of the stylesheet.
// On a booking address only — /r/<slug> or the root vanity /<slug> (the
// same rule as src/lib/bookingPath.js, whose RESERVED_SLUGS it carries) —
// and never in the native apps, it:
//   1. marks the page (window.__bbBooking = { slug, embed, ... }) for the
//      scripts after it: the dictionary preload stays away (the page brings
//      its own words), the manifest and the service worker stay away (a
//      guest's booking form is not the owner app);
//   2. picks the wait's look (window.__bbBooking.ph) — the page's own
//      skeleton (components/booking/bookingWait.js); a tiny script inside
//      <div id="root"> puts it on screen, so the first paint is the page's
//      shape, not a blank white box, and React's first commit replaces it
//      with the same markup;
//   3. starts the page's code with the app's (modulepreload of the
//      ReservationPublicPage chunk and its own imports — build only);
//   4. starts the page's data with the page: GET /public/reservations/<slug>,
//      and — unless it is a receipt link — the times and the 14-day summary
//      for the likely first answer (today or ?d=, ?party= or 2). Plain GETs
//      with no credentials and no custom header: no CORS preflight. The page
//      takes them over only when they are exactly what it would ask
//      (lib/bookingBoot.js); a wrong guess costs one spare request, never a
//      wrong page. Each gives up after 15 s and the page asks again itself.
//   5. (booking R13) in an embed whose snippet opted in (`look=1`), paints
//      the restaurant's look before the first paint: src/lib/bookingLook.js
//      reads the address strictly and sets classes and custom properties on
//      <html> (index.css "BOOKING LOOK"); later looks come from the host
//      page as {type:"bonbox:look", q} messages — only from the frame's own
//      parent, read by the same function. No `look=1`, nothing changes.
// Everything is inside try/catch: this script can only ever add speed.
import { RESERVED_SLUGS } from "../src/lib/bookingPath.js";
import { SKELETON_VARIANTS, skeletonHtml } from "../src/components/booking/bookingWait.js";
import { LOOK_FONTS, LOOK_RADII, applyLook, lookFrom } from "../src/lib/bookingLook.js";

export const PROBE_TIMEOUT_MS = 15000;

/** The <script> element's text (without the tags). */
// JSON that is safe inside an inline <script>: no "</script" can end it early.
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

// A function's own source on one line (bookingLook.js keeps its bodies free
// of comments and ends every statement with ";", so joining lines is safe —
// r13.bookingLook.test.js runs the joined copy).
const oneLine = (fn) => fn.toString().replace(/\n\s*/g, " ");

/** How long a frame whose snippet promised a look by message waits for it,
 *  painting nothing, before it shows the default look (a blocked or stripped
 *  host script). */
export const LOOK_WAIT_MS = 1300;

/** The look half of the script (R13): runs only in an embed with `look=1`.
 *  An address with look values (the owner's kit preview) is painted with
 *  them at once. A BARE `look=1` (every new snippet, R13 fix round 2) means
 *  "the look comes by message": the frame takes the default look, paints
 *  nothing (html.bb-look-wait: transparent, body hidden — the snippet's
 *  `color-scheme:light` on the <iframe> matches this document, so no box
 *  either), tells its parent {type:"bonbox:ready"} and shows itself the
 *  moment the look arrives — in the same task as the look, so the first
 *  thing painted is the restaurant's look — or after LOOK_WAIT_MS with the
 *  default. The frame loads once: the host script never touches its src. */
export function lookSource() {
  return (
    `var LR=${js(LOOK_RADII)},LF=${js(LOOK_FONTS)},lookFrom=${oneLine(lookFrom)},applyLook=${oneLine(applyLook)};` +
    "var LK=lookFrom(q,LR,LF);" +
    "if(LK){B.look=LK;applyLook(D,LK,LR,LF);" +
    'var RT=D.documentElement,show=function(){RT.classList.remove("bb-look-wait")};' +
    'if(!/[?&](theme|scheme|surface|ink|accent|accent_ink|radius|font)=/.test(q)){' +
    'RT.classList.add("bb-look-wait");B.waitT=setTimeout(show,' + LOOK_WAIT_MS + ');' +
    'try{if(w.parent!==w)w.parent.postMessage({type:"bonbox:ready"},"*")}catch(y){}}' +
    'w.addEventListener("message",function(ev){try{var x=ev.data;' +
    'if(ev.source!==w.parent||!x||x.type!=="bonbox:look"||typeof x.q!=="string"||x.q.length>400)return;' +
    'var N=lookFrom("?"+x.q,LR,LF);if(N){B.look=N;applyLook(D,N,LR,LF);clearTimeout(B.waitT);show()}}catch(y){}})}'
  );
}

/** R13 fix: the host's embed script may arrive after the frame is up (a
 *  builder that makes scripts async): it asks {type:"bonbox:hello"} and the
 *  frame says its height again — and, waiting for a look, that it is ready
 *  for one — to its own parent only. Old snippets never ask, so nothing
 *  changes for them. */
export function helloSource() {
  return (
    'if(w.addEventListener)w.addEventListener("message",function(ev){try{' +
    'if(ev.source!==w.parent||!ev.data||ev.data.type!=="bonbox:hello")return;' +
    'if(B.look)w.parent.postMessage({type:"bonbox:ready"},"*");' +
    'var h=Math.ceil(D.documentElement.getBoundingClientRect().height);' +
    'if(h>0)w.parent.postMessage({type:"bonbox:height",height:h},"*")}catch(y){}});'
  );
}

/** R13 fix: the booking page on its own decides `.dark` here, in <head>,
 *  before anything is painted (a stored "dark", or the phone's dark mode) —
 *  in <body> it came one frame late now and then (a paper flash at 1440).
 *  index.html's body script keeps the same answer. It is marked
 *  html.bb-guest too (fix round 3): in dark its ground is the page's own
 *  gray-950, not the app's #111827 (index.css). */
export function darkSource() {
  return (
    'var dk=false;try{dk=w.localStorage.getItem("theme")==="dark"}catch(x){}' +
    'try{dk=dk||w.matchMedia("(prefers-color-scheme: dark)").matches===true}catch(x){}' +
    'D.documentElement.classList.add("bb-guest");if(dk)D.documentElement.classList.add("dark");'
  );
}

export function bookingBootSource({ apiUrl = "", preload = [] } = {}) {
  const ph = Object.fromEntries(SKELETON_VARIANTS.map((v) => [v, skeletonHtml(v)]));
  return (
    "(function(){try{" +
    `var R=${js(RESERVED_SLUGS)},P=${js(ph)},J=${js(preload)},A=${js(apiUrl || "")};` +
    'var w=window,l=location,D=document;' +
    'if(w.Capacitor||l.protocol==="capacitor:")return;' +
    'var p=l.pathname.replace(/\\/+$/,""),m=/^\\/r\\/([^\\/]+)$/.exec(p),v=0;' +
    'if(!m){m=/^\\/([^\\/]+)$/.exec(p);v=1}' +
    "if(!m)return;" +
    "var s=decodeURIComponent(m[1]);" +
    "if(!s||(v&&R.indexOf(s.toLowerCase())!==-1))return;" +
    'var q=l.search||"",has=function(k){return new RegExp("[?&]"+k+"=1(&|$)").test(q)};' +
    'var e=has("embed"),f=has("flat");' +
    "var B=w.__bbBooking={slug:s,embed:e};" +
    "var fr=false;try{fr=w.self!==w.top}catch(x){fr=true}" +
    'var wide=!e&&!fr&&!!w.matchMedia&&w.matchMedia("(min-width: 1024px)").matches;' +
    'B.ph=P[e?(f?"embedFlat":"embedCard"):(wide?"wide":"plain")];' +
    'if(e&&!f)D.documentElement.classList.add("bb-embed-card");' +
    "if(e){" + lookSource() + helloSource() + "}else{" + darkSource() + "}" +
    'for(var i=0;i<J.length;i++){var k=D.createElement("link");k.rel="modulepreload";k.crossOrigin="";k.href=J[i];D.head.appendChild(k)}' +
    'var a=A;if(a.charAt(0)!=="h"){var hn=l.hostname;a=(hn==="bonbox.dk"||/\\.bonbox\\.dk$/.test(hn))?"https://api.bonbox.dk/api":""}' +
    "if(!a||!w.fetch)return;" +
    'a=a.replace(/\\/+$/,"");' +
    "var go=function(path){var o={base:a,url:a+path,done:null},c=w.AbortController?new AbortController():null," +
    `t=c?setTimeout(function(){c.abort()},${PROBE_TIMEOUT_MS}):0;` +
    'o.promise=fetch(o.url,{credentials:"omit",signal:c?c.signal:void 0})' +
    ".then(function(r){return r.json().then(function(d){return{ok:r.ok,status:r.status,data:d}},function(){return{ok:false,status:r.ok?0:r.status,data:null}})},function(){return{ok:false,status:0,data:null}})" +
    ".then(function(r){clearTimeout(t);o.done=r;return r});return o};" +
    'var pre="/public/reservations/"+encodeURIComponent(s);' +
    "B.page=go(pre);" +
    "if(/[?&](booking|token)=/.test(q))return;" +
    'var d=new Date(),z=function(n){return(n<10?"0":"")+n},today=d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate());' +
    "var qd=(/[?&]d=(\\d{4}-\\d{2}-\\d{2})(&|$)/.exec(q)||[])[1],day=qd&&qd>=today?qd:today;" +
    "var qp=parseInt((/[?&]party=(\\d+)(&|$)/.exec(q)||[])[1],10),party=qp>=1&&qp<=100?qp:2;" +
    'B.avail=go(pre+"/availability?day="+day+"&party="+party);B.avail.day=day;B.avail.party=party;' +
    'B.summary=go(pre+"/availability-summary?from="+today+"&days=14&party="+party);B.summary.from=today;B.summary.days=14;B.summary.party=party;' +
    "}catch(x){}})()"
  );
}

/** The whole <script> element. */
export function bookingBootScript(opts) {
  return "<script>" + bookingBootSource(opts) + "</script>";
}
