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
// Everything is inside try/catch: this script can only ever add speed.
import { RESERVED_SLUGS } from "../src/lib/bookingPath.js";
import { SKELETON_VARIANTS, skeletonHtml } from "../src/components/booking/bookingWait.js";

export const PROBE_TIMEOUT_MS = 15000;

/** The <script> element's text (without the tags). */
// JSON that is safe inside an inline <script>: no "</script" can end it early.
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

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
