/**
 * Booking R4 — "the embed fits any website": what the owner pastes
 * (utils/bookingEmbed.js).
 *
 *  - the frame and the button are centred in the owner's column, at the
 *    width the owner chose (460 or 560);
 *  - the compact header and the card are query switches, in a fixed order;
 *  - the script under the frame, RUN here in jsdom: it sizes only a frame of
 *    ours, only from the booking origin, with a bounded whole number set
 *    !important; it serves several frames on one page; on a plain-http page
 *    it hides the box that can never load;
 *  - a snippet pasted BEFORE R4 (its own id + listener) still sizes itself
 *    from the page's unchanged message;
 *  - the site-builder guides: WordPress (block editor + Elementor), Wix and
 *    Squarespace in detail, every step and note in real en + da.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBED_WIDTHS,
  EMBED_WIDTH_DEFAULT,
  SITE_BUILDERS,
  buttonSnippet,
  embedQuery,
  embedWidthOf,
  guideNoteKeys,
  guideStepKeys,
  iframeSnippet,
  previewSrcFor,
} from "../utils/bookingEmbed";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const URL_ROOT = "https://www.bonbox.dk/cafe-mirabelle";
const ORIGIN = "https://www.bonbox.dk";
const base = { publicUrl: URL_ROOT, label: "Book bord", venueName: "Café", fallbackLabel: "Åbn booking i nyt vindue →" };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the query: compact header and card, in a fixed order", () => {
  it("no options = the bare ?embed=1 every pre-R4 snippet carries", () => {
    expect(embedQuery()).toBe("?embed=1");
    expect(embedQuery({ compact: true })).toBe("?embed=1&compact=1");
    expect(embedQuery({ flat: true })).toBe("?embed=1&flat=1");
    expect(embedQuery({ compact: true, flat: true })).toBe("?embed=1&flat=1&compact=1");
  });

  it("the owner's preview loads the same variant", () => {
    expect(previewSrcFor(URL_ROOT, ORIGIN, { compact: true })).toBe(`${ORIGIN}/r/cafe-mirabelle?embed=1&compact=1`);
    expect(previewSrcFor(URL_ROOT, "capacitor://localhost", { compact: true, flat: true })).toBe(
      `${ORIGIN}/r/cafe-mirabelle?embed=1&flat=1&compact=1`,
    );
  });
});

describe("widths", () => {
  it("460 (every snippet before R4) and 560; anything else falls back to 460", () => {
    expect(EMBED_WIDTHS).toEqual([460, 560]);
    expect(EMBED_WIDTH_DEFAULT).toBe(460);
    expect(embedWidthOf(560)).toBe(560);
    expect(embedWidthOf("560")).toBe(560);
    expect(embedWidthOf(9999)).toBe(460);
    expect(embedWidthOf(undefined)).toBe(460);
  });
});

describe("the iframe snippet: centred, at the chosen width", () => {
  it("wraps the frame in a centred box (also inside a builder's flex column)", () => {
    const s = iframeSnippet(base);
    expect(s.startsWith('<div data-bonbox-booking-wrap style="width:100%;max-width:460px;margin:0 auto">')).toBe(true);
    expect(iframeSnippet({ ...base, width: 560 })).toContain("max-width:560px;margin:0 auto");
    expect(iframeSnippet({ ...base, width: 123 })).toContain("max-width:460px;margin:0 auto");
  });

  it("the frame: /r/<slug>, a block box, the 720px fallback height, no id to collide with", () => {
    const s = iframeSnippet(base);
    expect(s).toContain('<iframe data-bonbox-booking src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1"');
    expect(s).toContain('height="720"');
    expect(s).toContain('style="display:block;border:0;width:100%;border-radius:16px"');
    expect(s).not.toMatch(/\sid="/);
  });

  it("compact and flat ride the src, escaped for the attribute", () => {
    expect(iframeSnippet({ ...base, compact: true })).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1&amp;compact=1"');
    expect(iframeSnippet({ ...base, compact: true, flat: true })).toContain("?embed=1&amp;flat=1&amp;compact=1\"");
  });

  it("the fallback link sits centred under the frame and uses the pretty URL", () => {
    const s = iframeSnippet(base);
    expect(s).toContain('<p data-bonbox-booking-link style="margin:8px 0 0;text-align:center;');
    expect(s).toContain('<a href="https://www.bonbox.dk/cafe-mirabelle" target="_blank" rel="noopener">Åbn booking i nyt vindue →</a>');
  });

  it("the script is ES5 with no line comments (builders paste it as-is, some on one line)", () => {
    const body = scriptOf(iframeSnippet(base));
    // No "//" except the one in the origin's "https://".
    expect(body).not.toMatch(/(^|[^:])\/\//m);
    expect(body).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    // It still parses as one line.
    expect(() => new Function(body.replace(/\n/g, " "))).not.toThrow();
  });
});

describe("the button snippet: centred", () => {
  it("a plain link inside a centring box", () => {
    const s = buttonSnippet({ publicUrl: URL_ROOT, label: 'Book "bord" & co' });
    expect(s.startsWith('<div style="text-align:center">\n  <a href="https://www.bonbox.dk/cafe-mirabelle" target="_blank" rel="noopener"')).toBe(true);
    expect(s).toContain(">Book &quot;bord&quot; &amp; co</a>\n</div>");
    expect(s).not.toContain("<script");
  });
});

// ── The script, run ─────────────────────────────────────────────────────
function scriptOf(snippet) {
  const open = snippet.indexOf("<script>");
  const close = snippet.indexOf("</" + "script>");
  return snippet.slice(open + "<script>".length, close);
}
// Paste the snippet's markup (innerHTML never runs a script) and run its
// script, with `location` standing in for the host page's address.
function paste(snippet, { protocol = "https:" } = {}) {
  const holder = document.createElement("div");
  holder.innerHTML = snippet.replace(/<script>[\s\S]*<\/script>/, "");
  document.body.appendChild(holder);
  const listeners = [];
  const realAdd = window.addEventListener;
  window.addEventListener = function (type, fn, opts) {
    if (type === "message") listeners.push(fn);
    return realAdd.call(this, type, fn, opts);
  };
  try {
    new Function("location", scriptOf(snippet))({ protocol });
  } finally {
    window.addEventListener = realAdd;
  }
  return { holder, listeners };
}
const send = (data, origin, source) => window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
let pasted = [];
afterEach(() => {
  for (const p of pasted) for (const fn of p.listeners) window.removeEventListener("message", fn);
  pasted = [];
});

describe("the script under the frame (run in jsdom)", () => {
  it("sizes its frame from the booking origin's height message, !important, and hides the link", () => {
    const p = paste(iframeSnippet(base));
    pasted.push(p);
    const f = p.holder.querySelector("iframe[data-bonbox-booking]");
    const link = p.holder.querySelector("[data-bonbox-booking-link]");
    expect(f.style.display).toBe("block");
    send({ type: "bonbox:height", height: 777.4 }, ORIGIN, f.contentWindow);
    expect(f.style.height).toBe("777px");
    expect(f.style.getPropertyPriority("height")).toBe("important");
    expect(link.style.display).toBe("none");
  });

  it("ignores another origin, another window, another type and a height that is not a sane number", () => {
    const p = paste(iframeSnippet(base));
    pasted.push(p);
    const f = p.holder.querySelector("iframe");
    const link = p.holder.querySelector("[data-bonbox-booking-link]");
    send({ type: "bonbox:height", height: 500 }, "https://evil.example", f.contentWindow);
    send({ type: "bonbox:height", height: 501 }, ORIGIN, window);
    send({ type: "other", height: 502 }, ORIGIN, f.contentWindow);
    send({ type: "bonbox:height", height: "503px;display:none" }, ORIGIN, f.contentWindow);
    send({ type: "bonbox:height", height: -5 }, ORIGIN, f.contentWindow);
    send({ type: "bonbox:height", height: 999999 }, ORIGIN, f.contentWindow);
    send("bonbox:height", ORIGIN, f.contentWindow);
    send(null, ORIGIN, f.contentWindow);
    expect(f.style.height).toBe("");
    expect(link.style.display).toBe("");
  });

  it("serves every booking frame on the page: each message sizes only the frame it came from", () => {
    const a = paste(iframeSnippet(base));
    const b = paste(iframeSnippet({ ...base, publicUrl: "https://www.bonbox.dk/other" }));
    pasted.push(a, b);
    const fa = a.holder.querySelector("iframe");
    const fb = b.holder.querySelector("iframe");
    send({ type: "bonbox:height", height: 640 }, ORIGIN, fb.contentWindow);
    expect(fb.style.height).toBe("640px");
    expect(fa.style.height).toBe("");
    expect(b.holder.querySelector("[data-bonbox-booking-link]").style.display).toBe("none");
    expect(a.holder.querySelector("[data-bonbox-booking-link]").style.display).toBe("");
  });

  it("a builder that wraps the frame in a <p> (WordPress autop) still finds the link", () => {
    const s = iframeSnippet(base).replace("<iframe", "<p><iframe").replace("</iframe>", "</iframe></p>");
    const p = paste(s);
    pasted.push(p);
    const f = p.holder.querySelector("iframe");
    send({ type: "bonbox:height", height: 700 }, ORIGIN, f.contentWindow);
    expect(f.style.height).toBe("700px");
    expect(p.holder.querySelector("[data-bonbox-booking-link]").style.display).toBe("none");
  });

  it("on a plain-http page the https frame can never load: the box hides, the link stays", () => {
    const p = paste(iframeSnippet(base), { protocol: "http:" });
    pasted.push(p);
    expect(p.holder.querySelector("iframe").style.display).toBe("none");
    expect(p.holder.querySelector("[data-bonbox-booking-link]").style.display).toBe("");
  });

  it("a local (http) booking origin is never hidden on an http test page", () => {
    const local = iframeSnippet({ ...base, publicUrl: "http://127.0.0.1:5200/cafe" });
    expect(local).toContain("var o='http://127.0.0.1:5200'");
    const p = paste(local, { protocol: "http:" });
    pasted.push(p);
    const f = p.holder.querySelector("iframe");
    expect(f.style.display).toBe("block");
    send({ type: "bonbox:height", height: 690 }, "http://127.0.0.1:5200", f.contentWindow);
    expect(f.style.height).toBe("690px");
  });
});

describe("a snippet pasted before R4 keeps working", () => {
  // The exact listener every owner pasted before R4 (bookingEmbed.js @ R3).
  const OLD = [
    '<div style="max-width:460px">',
    '  <iframe id="bonbox-booking" src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1"',
    '    title="Book bord — Café" width="100%" height="720" loading="lazy"',
    '    style="border:0;width:100%;border-radius:16px"></iframe>',
    '  <p id="bonbox-booking-link" style="margin:8px 0 0;font:400 14px/1.4 system-ui,sans-serif">',
    '    <a href="https://www.bonbox.dk/cafe-mirabelle" target="_blank" rel="noopener">Åbn booking i nyt vindue →</a>',
    "  </p>",
    "  <script>",
    "  (function(){",
    "    var f=document.getElementById('bonbox-booking');",
    "    var l=document.getElementById('bonbox-booking-link');",
    "    window.addEventListener('message',function(e){",
    "      if(e.origin!=='https://www.bonbox.dk'||!f||e.source!==f.contentWindow)return;",
    "      if(!e.data||e.data.type!=='bonbox:height')return;",
    "      f.style.height=e.data.height+'px';",
    "      if(l)l.style.display='none';",
    "    });",
    "  })();",
    "  </" + "script>",
    "</div>",
  ].join("\n");

  it("the page's message — {type:'bonbox:height', height:<int>} — still sizes it", () => {
    const p = paste(OLD);
    pasted.push(p);
    const f = document.getElementById("bonbox-booking");
    send({ type: "bonbox:height", height: 777 }, ORIGIN, f.contentWindow);
    expect(f.style.height).toBe("777px");
    expect(document.getElementById("bonbox-booking-link").style.display).toBe("none");
  });

  it("an old and a new snippet on one page never size each other's frame", () => {
    const old = paste(OLD);
    const neu = paste(iframeSnippet({ ...base, publicUrl: "https://www.bonbox.dk/other" }));
    pasted.push(old, neu);
    const fOld = document.getElementById("bonbox-booking");
    const fNew = neu.holder.querySelector("iframe[data-bonbox-booking]");
    send({ type: "bonbox:height", height: 610 }, ORIGIN, fNew.contentWindow);
    expect(fNew.style.height).toBe("610px");
    expect(fOld.style.height).toBe("");
    send({ type: "bonbox:height", height: 620 }, ORIGIN, fOld.contentWindow);
    expect(fOld.style.height).toBe("620px");
    expect(fNew.style.height).toBe("610px");
  });
});

describe("the site-builder guides", () => {
  it("WordPress has two: the block editor and Elementor, right after it", () => {
    expect(SITE_BUILDERS.map((b) => b.name)).toEqual([
      "Wix", "WordPress", "Elementor", "Squarespace", "One.com", "Simply.com", "Shopify",
    ]);
  });

  it("every builder: four steps (paste third) and its notes, all in real en and da", () => {
    for (const b of SITE_BUILDERS) {
      const steps = guideStepKeys(b);
      expect(steps, b.id).toHaveLength(4);
      for (const k of [...steps, ...guideNoteKeys(b)]) {
        expect(typeof en[k], `${b.id} ${k}`).toBe("string");
        expect(typeof da[k], `${b.id} ${k}`).toBe("string");
        expect(en[k].length, k).toBeGreaterThan(8);
        expect(da[k], k).not.toBe(en[k]);
      }
    }
  });

  it("the detailed four name their own steps and notes", () => {
    const by = Object.fromEntries(SITE_BUILDERS.map((b) => [b.id, b]));
    expect(guideStepKeys(by.wordpress)).toEqual(["rsvpWebGuideWpOpen", "rsvpWebGuideWpAdd", "rsvpWebGuideWpPaste", "rsvpWebGuideWpPublish"]);
    expect(guideNoteKeys(by.wordpress)).toEqual(["rsvpWebGuideWpElementorNote", "rsvpWebGuideWpCodeNote"]);
    expect(guideStepKeys(by.elementor)).toEqual(["rsvpWebGuideElOpen", "rsvpWebGuideElAdd", "rsvpWebGuideElPaste", "rsvpWebGuideWpPublish"]);
    expect(guideNoteKeys(by.elementor)).toEqual(["rsvpWebGuideElNote"]);
    expect(guideStepKeys(by.wix)).toEqual(["rsvpWebGuideWixOpen", "rsvpWebGuideWixAdd", "rsvpWebGuidePaste", "rsvpWebGuideWixPublish"]);
    expect(guideNoteKeys(by.wix)).toEqual(["rsvpWebGuideWixNote"]);
    expect(guideStepKeys(by.squarespace)).toEqual(["rsvpWebGuideSqOpen", "rsvpWebGuideSqAdd", "rsvpWebGuidePastePlain", "rsvpWebGuidePublish"]);
    expect(guideNoteKeys(by.squarespace)).toEqual(["rsvpWebGuideSqNote", "rsvpWebGuideSqPlanNote"]);
    // WordPress-based hosts point to the WordPress guide, as before.
    expect(guideNoteKeys(by.onecom)).toEqual(["rsvpWebGuideWpNote"]);
    expect(guideNoteKeys(by.shopify)).toEqual([]);
  });

  it("the Danish names the editors really show; the Elementor note points the right way", () => {
    expect(da.rsvpWebGuideWpAdd).toContain("Tilpasset HTML");
    expect(da.rsvpWebGuideElOpen).toContain("Rediger med Elementor");
    expect(da.rsvpWebGuideWpElementorNote).toContain("Elementor-vejledningen");
    expect(en.rsvpWebGuideWpElementorNote).toContain("Elementor guide");
    expect(da.rsvpWebGuideWixAdd).toContain("Embed HTML");
    expect(da.rsvpWebGuideSqAdd).toContain("Code");
  });
});

describe("i18n: every new R4 key in real en + da", () => {
  const KEYS = [
    "rsvpWebEmbedWidth", "rsvpWebEmbedWidthStd", "rsvpWebEmbedWidthWide", "rsvpWebEmbedCompact",
    "rsvpWebEmbedCompactHint", "rsvpWebPreviewDevice", "rsvpWebPreviewPhone", "rsvpWebPreviewComputer",
    "rsvpWebPreviewHeadingDesktop", "rsvpWebGuidePastePlain", "rsvpWebGuideWixPublish", "rsvpWebGuideWixNote",
    "rsvpWebGuideWpPaste", "rsvpWebGuideWpPublish", "rsvpWebGuideWpElementorNote", "rsvpWebGuideWpCodeNote",
    "rsvpWebGuideElOpen", "rsvpWebGuideElAdd", "rsvpWebGuideElPaste", "rsvpWebGuideElNote",
    "rsvpWebGuideSqNote", "rsvpWebGuideSqPlanNote",
  ];
  // The same word in both languages, on purpose.
  const SAME = new Set(["rsvpWebEmbedWidthStd", "rsvpWebPreviewComputer"]);
  it.each(KEYS)("%s", (k) => {
    expect(typeof en[k]).toBe("string");
    expect(typeof da[k]).toBe("string");
    expect(en[k].trim().length).toBeGreaterThan(0);
    expect(da[k].trim().length).toBeGreaterThan(0);
    if (!SAME.has(k)) expect(da[k]).not.toBe(en[k]);
  });

  // R13 fix round: the mail is ONE mailto: link a mail program keeps whole (≤ 2,000 characters, r13.embedLook):
  // the link and the whole snippet stay, the ready-made button left the mail (it stays in the kit).
  it("the hand-off mail names where the code goes, keeps its two slots, in both languages", () => {
    for (const d of [da, en]) {
      const body = d.rsvpWebMailBody;
      for (const slot of ["{link}", "{iframe}"]) expect(body).toContain(slot);
      expect(body).not.toContain("{button}");
      for (const word of ["WordPress", "Elementor", "Wix", "Squarespace", "720 px", "https"]) expect(body).toContain(word);
    }
    expect(da.rsvpWebMailBody).toContain("Tilpasset HTML");
    expect(da.rsvpWebMailBody).toContain("HTML- eller Indlejr-blok");
  });
});
