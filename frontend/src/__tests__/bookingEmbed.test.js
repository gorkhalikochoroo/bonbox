/**
 * The snippets an owner pastes into their own website (utils/bookingEmbed.js).
 *
 * The owner never reads this code — they copy it, or e-mail it to their web
 * person, and it has to work on a site we will never see. So the contract is
 * pinned here: the iframe always loads the frameable /r/ route with ?embed=1,
 * the height listener only trusts the booking origin, the link and button use
 * the pretty URL, and nothing the venue typed can break out of an attribute.
 */
import { describe, it, expect } from "vitest";
import {
  embedSrcFor,
  embedOriginFor,
  buttonSnippet,
  iframeSnippet,
  previewSrcFor,
  mailtoHref,
  qrFileName,
  escapeAttr,
  SITE_BUILDERS,
} from "../utils/bookingEmbed";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const URL_ROOT = "https://www.bonbox.dk/cafe-mirabelle";
const URL_LEGACY = "https://www.bonbox.dk/r/login"; // a reserved slug keeps /r/

describe("embedSrcFor — the iframe must load the /r/ route", () => {
  it("adds /r/ to a pretty root URL", () => {
    expect(embedSrcFor(URL_ROOT)).toBe("https://www.bonbox.dk/r/cafe-mirabelle");
    expect(embedSrcFor(URL_ROOT + "/")).toBe("https://www.bonbox.dk/r/cafe-mirabelle");
  });
  it("never doubles it on a legacy /r/ URL", () => {
    expect(embedSrcFor(URL_LEGACY)).toBe(URL_LEGACY);
    expect(embedSrcFor(URL_LEGACY + "/")).toBe(URL_LEGACY);
  });
  it("derives the message origin from the booking URL", () => {
    expect(embedOriginFor(URL_ROOT)).toBe("https://www.bonbox.dk");
    expect(embedOriginFor("http://127.0.0.1:15977/cafe")).toBe("http://127.0.0.1:15977");
    expect(embedOriginFor("")).toBe("https://www.bonbox.dk");
  });
});

describe("buttonSnippet", () => {
  it("is a plain link to the pretty URL with the label (centred since booking R4)", () => {
    const s = buttonSnippet({ publicUrl: URL_ROOT, label: "Book bord" });
    expect(s).toMatch(/^<div style="text-align:center">\n  <a href="https:\/\/www\.bonbox\.dk\/cafe-mirabelle" target="_blank" rel="noopener"/);
    expect(s).toContain(">Book bord</a>");
    expect(s).not.toContain("<script");
  });
});

describe("iframeSnippet", () => {
  const s = iframeSnippet({
    publicUrl: URL_ROOT,
    label: "Book bord",
    venueName: 'Café "Mocca" & Co <3',
    fallbackLabel: "Åbn booking i nyt vindue →",
  });

  it("frames /r/<slug>?embed=1, never the bare root", () => {
    expect(s).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1"');
    expect(s).not.toContain('src="https://www.bonbox.dk/cafe-mirabelle');
  });
  // Booking R4: one listener for every frame of ours on the page; the
  // behaviour is run for real in r4.embedSnippet.test.js.
  it("only resizes on height messages from the booking origin and a frame of ours", () => {
    expect(s).toContain("var o='https://www.bonbox.dk'");
    expect(s).toContain("e.origin!==o");
    expect(s).toContain("a[i].contentWindow!==e.source");
    expect(s).toContain("d.type!=='bonbox:height'");
    expect(s).toContain("a[i].style.setProperty('height',h+'px','important')");
  });
  it("keeps a 720px fallback height and a working link for sites that strip scripts", () => {
    expect(s).toContain('height="720"');
    expect(s).toContain('<a href="https://www.bonbox.dk/cafe-mirabelle" target="_blank" rel="noopener">Åbn booking i nyt vindue →</a>');
  });
  it("escapes the venue name inside the title attribute", () => {
    expect(s).toContain('title="Book bord — Café &quot;Mocca&quot; &amp; Co &lt;3"');
  });
  it("points the listener at whatever origin the booking page is served from", () => {
    const local = iframeSnippet({ publicUrl: "http://127.0.0.1:15977/cafe", label: "Book bord", venueName: "X", fallbackLabel: "x" });
    expect(local).toContain('src="http://127.0.0.1:15977/r/cafe?embed=1"');
    expect(local).toContain("var o='http://127.0.0.1:15977'");
  });
});

describe("previewSrcFor — the owner's live preview", () => {
  it("loads the same build's /r/ page when the app runs on a web origin", () => {
    expect(previewSrcFor(URL_ROOT, "https://www.bonbox.dk")).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1");
    // A local or preview build shows its OWN page, never production's.
    expect(previewSrcFor(URL_ROOT, "http://127.0.0.1:15977")).toBe("http://127.0.0.1:15977/r/cafe-mirabelle?embed=1");
  });
  it("falls back to the public /r/ URL inside the native shell", () => {
    expect(previewSrcFor(URL_ROOT, "capacitor://localhost")).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1");
    expect(previewSrcFor(URL_LEGACY, undefined)).toBe("https://www.bonbox.dk/r/login?embed=1");
  });
});

describe("mailtoHref", () => {
  it("only pre-fills a mail — no recipient, everything encoded", () => {
    const href = mailtoHref({ subject: "Booking på vores hjemmeside", body: "a & b\n<c>" });
    expect(href.startsWith("mailto:?subject=")).toBe(true);
    const q = new URLSearchParams(href.slice("mailto:?".length));
    expect(q.get("subject")).toBe("Booking på vores hjemmeside");
    expect(q.get("body")).toBe("a & b\n<c>");
  });
});

describe("helpers", () => {
  it("names the QR file after the slug", () => {
    expect(qrFileName(URL_ROOT)).toBe("booking-qr-cafe-mirabelle.png");
    expect(qrFileName("")).toBe("booking-qr-bonbox.png");
  });
  it("escapes attribute text", () => {
    expect(escapeAttr(`a"b<c>&`)).toBe("a&quot;b&lt;c&gt;&amp;");
  });
  it("every site builder's steps exist in both Danish and English", () => {
    const keys = ["rsvpWebGuidePaste", "rsvpWebGuidePublish", "rsvpWebGuideWpNote", "rsvpWebGuideButtonOnly"];
    for (const b of SITE_BUILDERS) keys.push(b.open, b.add);
    for (const k of keys) {
      expect(typeof da[k], k).toBe("string");
      expect(typeof en[k], k).toBe("string");
      expect(da[k].length, k).toBeGreaterThan(0);
    }
    // Booking R4: WordPress's Elementor editor has its own guide.
    expect(SITE_BUILDERS.map((b) => b.name)).toEqual(["Wix", "WordPress", "Elementor", "Squarespace", "One.com", "Simply.com", "Shopify"]);
  });
});
