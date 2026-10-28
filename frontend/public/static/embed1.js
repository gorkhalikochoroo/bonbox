/*
 * BonBox booking embed, version 1.
 * Served from https://www.bonbox.dk/static/embed1.js (frontend/public/static/
 * embed1.js; its Cache-Control is in vercel.json). Loaded by the booking
 * snippet a restaurant pastes on its own website (the owner app's "Sæt på din
 * hjemmeside", src/utils/bookingEmbed.js). For every booking frame on the
 * page (iframe[data-bonbox-booking]) it:
 *   - sizes the frame to the booking's own height (messages from the booking
 *     origin only) and hides the fallback link under it once it is up;
 *   - hides the frame on a plain-http page (an https booking page cannot be
 *     framed there): the link under it is the way in;
 *   - with data-bonbox-look (the owner left "match my website" on): reads
 *     this page's look — the surface behind the box, its text colour, the
 *     main button (colour, text colour, corners), a system font, the frame's
 *     color-scheme — and hands the frame hex digits and fixed words only, as
 *     a message to the booking origin. The frame's address already says
 *     look=1 ("a look comes by message"): it paints nothing until the look
 *     arrives (at most 1.3 s), tells this page {type:"bonbox:ready"}, and is
 *     answered at once — and again after a theme switch on this page. This
 *     file never changes a frame's src: every frame loads exactly once. The
 *     frame checks every value again (src/lib/bookingLook.js).
 * It reads styles only, sends nothing anywhere else and stores nothing.
 * The v1 contract — data-bonbox-booking, data-bonbox-look="auto|light|dark",
 * data-bonbox-accent="own", data-bonbox-booking-wrap, data-bonbox-booking-link
 * — holds for every snippet that loads this file; a new contract is a new file.
 */
/* eslint-disable no-unused-vars -- plain ES5 on purpose: a catch needs its parameter */
(function () {
  "use strict";
  var w = window, d = document, o;
  var me = d.currentScript || d.querySelector('script[src$="/static/embed1.js"]');
  try {
    o = new URL(me.src).origin;
  } catch (x) {
    return;
  }
  /* A second snippet on the same page: one copy serves every frame. */
  if (w.__bonboxEmbed1) {
    w.__bonboxEmbed1.run();
    return;
  }
  var http = location.protocol === "http:" && o.indexOf("https:") === 0;
  var RADIUS = { sharp: "4px", soft: "16px", round: "24px" };
  var U = 0, T, cv;

  function all() {
    return d.querySelectorAll("iframe[data-bonbox-booking]");
  }
  function send(f, q) {
    f.bbS = q;
    try {
      f.contentWindow.postMessage({ type: "bonbox:look", q: q }, o);
    } catch (x) { /* the frame is gone */ }
  }

  /* The booking speaks, from its own origin only: "ready" for a look (it
     waits, painting nothing, until it has one) — it gets the look at once;
     its height — its frame is sized (a bounded whole number, set
     !important so a theme's iframe rule can't pin it) and the link hidden. */
  w.addEventListener("message", function (e) {
    var dt = e.data, a, i, f, h, wr, l;
    if (e.origin !== o || !dt) return;
    a = all();
    for (i = 0; i < a.length; i++) {
      f = a[i];
      if (f.contentWindow !== e.source) continue;
      if (dt.type === "bonbox:ready") {
        f.bbR = 1;
        if (f.getAttribute("data-bonbox-look")) {
          if (f.bbQ == null) f.bbQ = look(f)[0];
          send(f, f.bbQ);
        }
        continue;
      }
      h = Math.round(+dt.height);
      if (dt.type !== "bonbox:height" || !(h > 0 && h < 20000)) continue;
      f.style.setProperty("height", h + "px", "important");
      wr = f.closest && f.closest("[data-bonbox-booking-wrap]");
      l = wr && wr.querySelector("[data-bonbox-booking-link]");
      if (l) l.style.display = "none";
    }
  });

  /* A computed colour as [r, g, b, alpha]: rgb()/rgba(), else through a 1 px
     canvas (oklch(), color(), lab() …). */
  function rgb(c) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)(%?))?\s*\)$/.exec(c || ""), p;
    if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : m[5] ? m[4] / 100 : +m[4]];
    if (!c || c === "transparent") return null;
    try {
      if (!cv) cv = d.createElement("canvas").getContext("2d");
      if (!cv) return null;
      cv.fillStyle = "#010203";
      cv.fillStyle = c;
      if (cv.fillStyle === "#010203") return null;
      cv.clearRect(0, 0, 1, 1);
      cv.fillRect(0, 0, 1, 1);
      p = cv.getImageData(0, 0, 1, 1).data;
      return [p[0], p[1], p[2], p[3] / 255];
    } catch (x) {
      return null;
    }
  }
  /* "rrggbb" for an (almost) opaque colour, else null. */
  function hx(c) {
    var v = rgb(c);
    if (!v || v[3] < 0.5) return null;
    return ((1 << 24) + (Math.round(v[0]) << 16) + (Math.round(v[1]) << 8) + Math.round(v[2])).toString(16).slice(1);
  }
  function lu(h) {
    var n = parseInt(h, 16), r = 0, i, s;
    for (i = 0; i < 3; i++) {
      s = ((n >> (16 - 8 * i)) & 255) / 255;
      r += [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
    }
    return r;
  }
  function ct(a, b) {
    var x = lu(a), y = lu(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function cs(e) {
    return w.getComputedStyle(e);
  }
  /* The first ancestor with a background: its colour, or "photo". */
  function surface(e) {
    var s, g, h;
    for (; e && e.nodeType === 1; e = e.parentElement) {
      s = cs(e);
      g = s.backgroundImage;
      if (g && g !== "none") return "photo";
      h = hx(s.backgroundColor);
      if (h) return h;
    }
    return null;
  }
  /* A system font the booking can paint, by the first family named. */
  function font(e) {
    var f = e && cs(e).fontFamily, n;
    if (!f) return null;
    n = f.split(",")[0].replace(/["']/g, "").replace(/^\s+|\s+$/g, "").toLowerCase();
    if (/^(system-ui|-apple-system|blinkmacsystemfont|segoe ui|roboto)$/.test(n)) return "system";
    if (/^(helvetica neue|helvetica|arial)$/.test(n)) return "helvetica";
    if (n === "georgia") return "georgia";
    if (/^times( new roman)?$/.test(n)) return "times";
    return null;
  }
  /* The colour most of the page's visible buttons share — never the
     surface's own — with its style and box. A site whose buttons are only
     outlines (no fill; Madklubben, Geranium on 28 Oct) lends its outline
     colour instead, marked so its text colour is not sent: on our filled
     button that would be the fill's own colour (the frame picks one). */
  function button(wr, sf) {
    var q = d.querySelectorAll("button,[type=submit],[type=button],[role=button],[class*=btn],[class*=utton]");
    var n = {}, o = {}, b = null, ob = null, i, e, s, r, h;
    for (i = 0; i < q.length && i < 80; i++) {
      e = q[i];
      if (wr && wr.contains(e)) continue;
      s = cs(e);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue;
      r = e.getBoundingClientRect();
      if (r.width < 24 || r.height < 16) continue;
      h = hx(s.backgroundColor);
      if (h) {
        if (sf && sf !== "photo" && ct(h, sf) < 1.3) continue;
        n[h] = (n[h] || 0) + 1;
        if (!b || n[h] > n[b.h]) b = { h: h, s: s, r: r };
        continue;
      }
      /* no fill: an outline at least 1px wide that stands out from its ground */
      h = (parseFloat(s.borderTopWidth) || 0) >= 1 && s.borderTopStyle !== "none" && hx(s.borderTopColor);
      if (!h || (sf && sf !== "photo" && ct(h, sf) < 3)) continue;
      o[h] = (o[h] || 0) + 1;
      if (!ob || o[h] > o[ob.h]) ob = { h: h, s: s, r: r, outline: true };
    }
    return b || ob;
  }
  /* Its corners on the booking's ladder: sharp / soft / round. */
  function corners(b) {
    if (!b) return null;
    var t = b.s.borderTopLeftRadius || b.s.borderRadius || "", v = parseFloat(t) || 0;
    if (/%/.test(t)) return v >= 25 ? "round" : v > 0 ? "soft" : "sharp";
    if (v >= 24 || (v > 0 && b.r.height > 0 && v >= b.r.height / 2 - 1)) return "round";
    return v <= 6 ? "sharp" : "soft";
  }
  /* The look query for one frame, in a fixed order, and its corners. */
  function look(f) {
    var m = f.getAttribute("data-bonbox-look"), wr = f.closest && f.closest("[data-bonbox-booking-wrap]");
    var c = (wr && wr.parentElement) || d.body, styled = !!(d.styleSheets && d.styleSheets.length);
    var q = "look=1", s = surface(c), k, b, x;
    if (m === "light" || m === "dark") q += "&theme=" + m;
    /* The snippet pins the <iframe> to color-scheme:light, the frame's own;
       only a site that overrides that (an !important rule) is mirrored. */
    x = cs(f).colorScheme || "";
    x = /dark/.test(x) ? (/light/.test(x) ? "ld" : "dark") : "";
    if (x) q += "&scheme=" + x;
    if (s) q += "&surface=" + s;
    /* an unstyled document (Wix's Embed HTML box) has the browser's colours
       and font, not the site's */
    k = styled && hx(cs(c).color);
    if (k) q += "&ink=" + k;
    b = button(wr, s);
    if (b && f.getAttribute("data-bonbox-accent") !== "own") {
      q += "&accent=" + b.h;
      x = !b.outline && hx(b.s.color);
      if (x) q += "&accent_ink=" + x;
    }
    x = corners(b);
    if (x) q += "&radius=" + x;
    k = styled && (font(d.body) || font(d.querySelector("h1,h2")));
    if (k) q += "&font=" + k;
    return [q, x];
  }
  function schemeOf(q) {
    var m = /&scheme=(\w+)/.exec(q || "");
    return m ? m[1] : "";
  }
  function run() {
    var a = all(), i, f, r, q;
    for (i = 0; i < a.length; i++) {
      f = a[i];
      if (http) {
        f.style.display = "none";
        continue;
      }
      /* already up (this file arrived late)? it says its height again */
      if (!f.bbHi) {
        f.bbHi = 1;
        try {
          f.contentWindow.postMessage({ type: "bonbox:hello" }, o);
        } catch (x) { /* not up yet: it will say its height itself */ }
      }
      if (!f.getAttribute("data-bonbox-look")) continue;
      r = look(f);
      q = r[0];
      if (r[1]) f.style.borderRadius = RADIUS[r[1]];
      if (q === f.bbQ) continue;
      /* Five changes per page view at most — except a color-scheme change,
         always followed: a frame whose scheme differs from its <iframe>'s
         gets an opaque box from the browser. The first look is free. */
      if (f.bbS != null && schemeOf(q) === schemeOf(f.bbS)) {
        if (U > 4) continue;
        U++;
      }
      f.bbQ = q;
      /* Not ready yet: its "ready" fetches this look. */
      if (f.bbR) send(f, q);
    }
  }
  /* Read again when the page may have changed its look — the rest of the page
     parsed, the phone's dark mode, a class or data-theme on <html> / <body>.
     Debounced; reading costs nothing against the five changes (a change
     counts only once the frame has had a look). */
  function again() {
    clearTimeout(T);
    T = setTimeout(run, 250);
  }
  w.__bonboxEmbed1 = { run: run };
  run();
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", again);
  try {
    var mq = w.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", again);
    else if (mq.addListener) mq.addListener(again);
  } catch (x) { /* no matchMedia */ }
  if (w.MutationObserver) {
    var mo = new MutationObserver(again), op = { attributes: true, attributeFilter: ["class", "data-theme"] };
    mo.observe(d.documentElement, op);
    if (d.body) mo.observe(d.body, op);
  }
})();
