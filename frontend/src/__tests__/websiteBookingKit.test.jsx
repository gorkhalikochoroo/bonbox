/**
 * "Book bord på din hjemmeside" (components/reservations/WebsiteBookingKit).
 *
 * The one place an owner gets booking onto their website: link + button +
 * QR, the embed with a live preview, site-builder steps, and a mailto: for
 * whoever makes the website. Rendered with the REAL Danish and English
 * dictionaries, so a missing key or a stray placeholder fails here, not in
 * front of an owner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const saveFile = vi.fn(async () => ({ ok: true, channel: "download" }));
vi.mock("../utils/download", () => ({ saveFile: (...a) => saveFile(...a) }));

import WebsiteBookingKit from "../components/reservations/WebsiteBookingKit";
import { sampleLookQuery } from "../utils/bookingEmbed";
// Booking R13: a new snippet matches the website by default; the preview shows it on the light sample site.
const LOOK_Q = "&" + sampleLookQuery("light", { mode: "auto", accent: "site" });

// The app's t(): dictionary lookup + {var} substitution, no fallbacks — a
// missing key renders as the raw key, which the assertions below catch.
const makeT = (dict) => (key, vars) => {
  const s = dict[key] ?? key;
  return vars && typeof vars === "object"
    ? s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m))
    : s;
};
const tDa = makeT(da);
const tEn = makeT(en);

const PUBLIC = "https://www.bonbox.dk/cafe-mirabelle";
const APP = "https://www.bonbox.dk";

function renderKit(props = {}) {
  return render(
    <WebsiteBookingKit
      publicUrl={PUBLIC}
      venueName="Café Mirabelle"
      enabled
      t={tDa}
      appOrigin={APP}
      canFramePreview
      {...props}
    />,
  );
}

let writeText;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  saveFile.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

const noRawKeys = (container) => {
  expect(container.textContent).not.toMatch(/rsvp[A-Z]\w+/);
  expect(container.textContent).not.toMatch(/\{\w+\}/);
};

describe("WebsiteBookingKit — before the page is live", () => {
  it("is still one place, and says what to switch on first", () => {
    const { container } = renderKit({ enabled: false });
    expect(screen.getByRole("heading", { name: "Book bord på din hjemmeside" })).toBeInTheDocument();
    expect(screen.getByText(/Slå online reservationer til øverst på siden/)).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("website-mailto")).toBeNull();
    expect(container.querySelector("#website")).not.toBeNull();
  });
});

describe("WebsiteBookingKit — 1. Link og knap (the default, fastest)", () => {
  it("offers three options, fastest first", () => {
    renderKit();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab").map((b) => b.textContent);
    expect(tabs).toEqual(["Link og knap", "Indlejr", "Vejledning"]);
    expect(screen.getByRole("tab", { name: "Link og knap" })).toHaveAttribute("aria-selected", "true");
  });

  it("copies the booking link in one tap", async () => {
    renderKit();
    expect(screen.getByTestId("website-link")).toHaveTextContent(PUBLIC);
    await act(async () => fireEvent.click(screen.getByTestId("website-copy-link")));
    expect(writeText).toHaveBeenCalledWith(PUBLIC);
    expect(screen.getByTestId("website-copy-link")).toHaveTextContent("Kopieret");
  });

  it("the ONE link row: Kopiér link + Åbn siden, side by side", () => {
    renderKit();
    const row = screen.getByTestId("website-link").parentElement;
    expect(within(row).getByTestId("website-copy-link")).toBeInTheDocument();
    const open = within(row).getByRole("link", { name: "Åbn siden" });
    expect(open).toHaveAttribute("href", PUBLIC);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // Icon-only on a phone, still named and titled.
    expect(open).toHaveAttribute("title", "Åbn siden");
    expect(open.className).toContain("max-sm:w-10");
    // One link row and one QR in the whole kit.
    expect(screen.getAllByTestId("website-link")).toHaveLength(1);
    expect(screen.getAllByTitle("QR-kode til din bookingside")).toHaveLength(1);
  });

  it("when the clipboard is refused, the link is offered to copy by hand", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
      configurable: true,
    });
    const exec = document.execCommand;
    document.execCommand = () => false;
    const prompt = vi.spyOn(window, "prompt").mockImplementation(() => null);
    try {
      renderKit();
      await act(async () => fireEvent.click(screen.getByTestId("website-copy-link")));
      expect(prompt).toHaveBeenCalledWith("Kopiér dette link", PUBLIC);
      expect(screen.getByTestId("website-copy-link")).toHaveTextContent("Kopiér link");
    } finally {
      document.execCommand = exec;
      prompt.mockRestore();
    }
  });

  it("copies a ready “Book bord” button that links to the booking page", async () => {
    renderKit();
    expect(screen.getByText("En færdig “Book bord”-knap")).toBeInTheDocument();
    const preview = screen.getByTestId("website-button-preview");
    expect(preview).toHaveAttribute("href", PUBLIC);
    expect(preview).toHaveTextContent("Book bord");
    await act(async () => fireEvent.click(screen.getByTestId("website-copy-button")));
    const code = writeText.mock.calls[0][0];
    expect(code).toContain(`<a href="${PUBLIC}"`);
    expect(code).toContain(">Book bord</a>");
    expect(screen.getByTestId("website-button-code").textContent).toBe(code);
  });

  it("names Facebook, Instagram and Google in one line", () => {
    renderKit();
    expect(screen.getByText(/Facebook-side.*Instagram-bio.*Google-profil/)).toBeInTheDocument();
  });

  it("downloads the QR as a PNG named after the slug", async () => {
    // jsdom has no canvas: stand in for the SVG → PNG raster step.
    const blob = new Blob(["png"], { type: "image/png" });
    const origImage = window.Image;
    const getCtx = HTMLCanvasElement.prototype.getContext;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    window.Image = class { set src(_v) { setTimeout(() => this.onload?.(), 0); } };
    HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {}, set fillStyle(_v) {}, set imageSmoothingEnabled(_v) {} });
    HTMLCanvasElement.prototype.toBlob = (cb) => cb(blob);
    try {
      renderKit();
      expect(screen.getByTitle("QR-kode til din bookingside")).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByTestId("website-qr-download"));
        await new Promise((r) => setTimeout(r, 5));
      });
      expect(saveFile).toHaveBeenCalledTimes(1);
      const [data, name, opts] = saveFile.mock.calls[0];
      expect(data).toBe(blob);
      expect(name).toBe("booking-qr-cafe-mirabelle.png");
      expect(opts.type).toBe("image/png");
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      window.Image = origImage;
      HTMLCanvasElement.prototype.getContext = getCtx;
      HTMLCanvasElement.prototype.toBlob = toBlob;
    }
  });

  it("says so when the PNG could not be made, instead of a silent no-op", async () => {
    const origImage = window.Image;
    window.Image = class { set src(_v) { setTimeout(() => this.onerror?.(), 0); } };
    try {
      renderKit();
      await act(async () => {
        fireEvent.click(screen.getByTestId("website-qr-download"));
        await new Promise((r) => setTimeout(r, 5));
      });
      expect(saveFile).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(/Billedet kunne ikke hentes/);
    } finally {
      window.Image = origImage;
    }
  });
});

describe("WebsiteBookingKit — 2. Indlejr", () => {
  it("copies ONE snippet that frames /r/<slug>?embed=1 and sizes itself", async () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    await act(async () => fireEvent.click(screen.getByTestId("website-copy-embed")));
    const code = writeText.mock.calls[0][0];
    // Booking R4: a new snippet carries the compact header by default.
    expect(code).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1&amp;compact=1&amp;look=1"');
    // R13 fix round: the sizing comes from the hosted script on the booking origin (one file for every
    // new snippet); it listens for the page's bonbox:height from that origin only.
    expect(code).toContain('<script src="https://www.bonbox.dk/static/embed1.js"></script>');
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const hosted = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../public/static/embed1.js"), "utf8");
    expect(hosted).toContain('dt.type !== "bonbox:height"');
    expect(hosted).toContain("e.origin !== o");
    expect(code).toContain("Åbn booking i nyt vindue →");
    expect(screen.getByText(/skal køre på https/)).toBeInTheDocument();
  });

  it("previews the real booking page at phone width", () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    const frame = screen.getByTestId("website-preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", "https://www.bonbox.dk/r/cafe-mirabelle?embed=1&compact=1" + LOOK_Q);
    expect(frame).toHaveAttribute("title", "Forhåndsvisning af din bookingside");
    expect(frame.parentElement.className).toContain("max-w-[375px]");
  });

  it("a local build previews its own page, not production's", () => {
    renderKit({ appOrigin: "http://127.0.0.1:15977" });
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    expect(screen.getByTestId("website-preview")).toHaveAttribute("src", "http://127.0.0.1:15977/r/cafe-mirabelle?embed=1&compact=1" + LOOK_Q);
  });

  it("sizes the preview from the frame's own height messages only", () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    const frame = screen.getByTestId("website-preview");
    const send = (data, origin, source) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
      });
    send({ type: "bonbox:height", height: 912 }, APP, frame.contentWindow);
    expect(frame.style.height).toBe("912px");
    // Another window, another origin, another message type: ignored.
    send({ type: "bonbox:height", height: 50 }, APP, window);
    send({ type: "bonbox:height", height: 51 }, "https://evil.example", frame.contentWindow);
    send({ type: "other", height: 52 }, APP, frame.contentWindow);
    expect(frame.style.height).toBe("912px");
  });

  it("does not frame the preview where it cannot load (iOS app)", () => {
    renderKit({ canFramePreview: false });
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    expect(screen.queryByTestId("website-preview")).toBeNull();
    expect(screen.getByRole("link", { name: /Åbn siden/ })).toHaveAttribute("href", PUBLIC);
  });

  it("links on to the site-builder steps", () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    fireEvent.click(screen.getByRole("button", { name: "Se hvordan i din hjemmesidebygger" }));
    expect(screen.getByRole("tab", { name: "Vejledning" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("WebsiteBookingKit — 3. Vejledning", () => {
  it("has ≤ 4 steps for each of the six builders, in real Danish", () => {
    const { container } = renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    const names = ["Wix", "WordPress", "Squarespace", "One.com", "Simply.com", "Shopify"];
    for (const n of names) {
      fireEvent.click(screen.getByRole("radio", { name: n }));
      expect(screen.getByRole("radio", { name: n })).toHaveAttribute("aria-checked", "true");
      const steps = within(screen.getByTestId("website-guide-steps")).getAllByRole("listitem");
      expect(steps.length).toBeLessThanOrEqual(4);
      expect(screen.getByText(`Kun en knap? Tilføj en knap i ${n}, og sæt dit bookinglink som knappens link.`)).toBeInTheDocument();
      noRawKeys(container);
    }
  });

  it("step 3 copies the embed code right there — the same snippet as “Indlejr”", async () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    const steps = within(screen.getByTestId("website-guide-steps")).getAllByRole("listitem");
    expect(steps[2]).toHaveTextContent("Kopiér koden, og indsæt den i blokken.");
    const btn = within(steps[2]).getByTestId("website-guide-copy-embed");
    expect(btn).toHaveTextContent("Kopiér kode");
    await act(async () => fireEvent.click(btn));
    const fromGuide = writeText.mock.calls[0][0];
    expect(fromGuide).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1&amp;compact=1&amp;look=1"');
    expect(btn).toHaveTextContent("Kopieret");
    // Same builder output as the Indlejr tab's own copy button.
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    await act(async () => fireEvent.click(screen.getByTestId("website-copy-embed")));
    expect(writeText.mock.calls[1][0]).toBe(fromGuide);
    // Only step 3 carries it, for every builder.
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    for (const n of ["Wix", "WordPress", "Squarespace", "One.com", "Simply.com", "Shopify"]) {
      fireEvent.click(screen.getByRole("radio", { name: n }));
      const li = within(screen.getByTestId("website-guide-steps")).getAllByRole("listitem");
      expect(li.map((x) => !!within(x).queryByTestId("website-guide-copy-embed"))).toEqual([false, false, true, false]);
    }
  });

  it("WordPress: an HTML block; One.com points WordPress sites to that guide", () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    fireEvent.click(screen.getByRole("radio", { name: "WordPress" }));
    // Booking R4: the block's Danish name, as WordPress shows it.
    expect(screen.getByText("Tilføj blokken “Tilpasset HTML” (Custom HTML), hvor bookingen skal stå.")).toBeInTheDocument();
    expect(screen.queryByText(/følg WordPress-vejledningen/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "One.com" }));
    expect(screen.getByText(/følg WordPress-vejledningen/)).toBeInTheDocument();
  });
});

describe("WebsiteBookingKit — send to whoever makes the website", () => {
  it("opens a pre-filled mail with the link and the embed — BonBox sends nothing", () => {
    renderKit();
    const a = screen.getByTestId("website-mailto");
    expect(a).toHaveTextContent("Send til den, der laver din hjemmeside");
    expect(screen.getByText(/BonBox sender ikke noget/)).toBeInTheDocument();
    const href = a.getAttribute("href");
    expect(href.startsWith("mailto:?subject=")).toBe(true); // no recipient: the owner picks one
    const q = new URLSearchParams(href.slice("mailto:?".length));
    expect(q.get("subject")).toBe("Booking på vores hjemmeside");
    const body = q.get("body");
    // R13 fix round: one mailto: link of at most 2,000 characters — the link and the whole snippet
    expect(body).toContain(`Eller link bare hertil: ${PUBLIC}`);
    expect(href.length).toBeLessThanOrEqual(2000);
    expect(body).toContain(`<a href="${PUBLIC}"`);
    expect(body).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1&amp;compact=1&amp;look=1"');
    expect(body).toContain("HTML- eller Indlejr-blok");
    expect(body).not.toMatch(/\{(link|button|iframe)\}/);
  });

  // R14 (28 Oct): a site whose Content-Security-Policy blocks other sites'
  // frames and scripts (lamfuz.dk) shows only the link — the kit and the mail
  // say what to allow, with the booking's own origin filled in.
  it("tells the owner and the web person what to allow when the site blocks the booking", () => {
    renderKit();
    const help = screen.getByTestId("website-csp-help");
    expect(help).toHaveTextContent("Vises bookingen ikke?");
    expect(help).toHaveTextContent("tilføje https://www.bonbox.dk til frame-src og script-src");
    const body = new URLSearchParams(screen.getByTestId("website-mailto").getAttribute("href").slice("mailto:?".length)).get("body");
    expect(body).toContain("Vises den ikke? Tilføj https://www.bonbox.dk til frame-src og script-src.");
    expect(body).not.toContain("{origin}");
  });
});

describe("WebsiteBookingKit — wording", () => {
  it("a salon gets “Book tid”, not “Book bord”", async () => {
    renderKit({ isProvider: true });
    expect(screen.getByRole("heading", { name: "Tidsbestilling på din hjemmeside" })).toBeInTheDocument();
    expect(screen.getByTestId("website-button-preview")).toHaveTextContent("Book tid");
    await act(async () => fireEvent.click(screen.getByTestId("website-copy-button")));
    expect(writeText.mock.calls[0][0]).toContain(">Book tid</a>");
  });

  it("renders in English with no raw keys or placeholders", () => {
    const { container } = renderKit({ t: tEn });
    expect(screen.getByRole("heading", { name: "Table booking on your website" })).toBeInTheDocument();
    noRawKeys(container);
    fireEvent.click(screen.getByRole("tab", { name: "Embed" }));
    noRawKeys(container);
    fireEvent.click(screen.getByRole("tab", { name: "Guides" }));
    noRawKeys(container);
  });

  it("renders in Danish with no raw keys or placeholders", () => {
    const { container } = renderKit();
    noRawKeys(container);
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    noRawKeys(container);
  });
});

// Reservationer wiring (the page is too large to mount here; the browser run
// walks it for real). Source-level, so a refactor that drops a way in fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

describe("Reservationer — the ways in", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../pages/ReservationsPage.jsx"),
    "utf8",
  );
  // R9: "Din bookingside" is its own component now (the real address, the
  // warning before a change, the old links) — read where it lives.
  const linkCard = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../components/reservations/BookingLinkCard.jsx"),
    "utf8",
  );
  it("the page header links to the kit from every tab", () => {
    expect(src).toContain('websiteHref="/reservations?tab=settings&show=website"');
    expect(src).toContain('{t("rsvpWebEntry")}');
  });
  it("Settings always renders the kit (it explains itself until the page is live)", () => {
    expect(src).toMatch(/<WebsiteBookingKit\s+publicUrl=\{publicUrl\}/);
    expect(src).not.toMatch(/enabled && publicUrl && \(\s*<WebsiteBookingKit/);
    // R9: ?show= lands on the kit (and, from the Profile hours, on hours).
    expect(src).toContain('website: ["website", "website-title"]');
    expect(src).toContain('hours: ["rsvp-hours", "rsvp-hours-title"]');
  });
  it("the header entry never cuts the title: icon-only below 390px, named and titled; wraps rather than cuts", () => {
    const entry = src.slice(src.indexOf('data-testid="rsvp-website-entry"'), src.indexOf("</Link>", src.indexOf('data-testid="rsvp-website-entry"')));
    expect(entry).toContain('aria-label={t("rsvpWebEntry")}');
    expect(entry).toContain('title={t("rsvpWebEntry")}');
    expect(entry).toContain("max-[389px]:w-10");
    expect(entry).toMatch(/<span className="max-\[389px\]:hidden">\{t\("rsvpWebEntry"\)\}<\/span>/);
    const row = src.slice(src.indexOf("function PageTitle("), src.indexOf('data-testid="rsvp-website-entry"'));
    expect(row).toContain('className="flex flex-wrap items-center justify-between gap-3"');
  });
  // Removal audit for the merge: "Din bookingside" + the kit used to show two
  // QR codes and two copy-link rows. One of each now, and every action that
  // card had is still reachable — the QR (+ PNG), the link with Kopiér and
  // Åbn siden in the kit (asserted above), the custom link here.
  it("Din bookingside keeps the custom link; QR and link row live once, in the kit", () => {
    // R9: the card's markup moved to BookingLinkCard.jsx, nothing removed.
    expect(linkCard).toContain('t("rsvpShareTitle", "Your booking page")');
    expect(linkCard).toContain('t("rsvpCustomLink", "Customise your link")');
    expect(linkCard).toContain('id="rsvp-slug"');
    expect(linkCard).toContain('data-testid="rsvp-share-card"');
    for (const s of [src, linkCard]) {
      expect(s).not.toContain("<QRCodeSVG");
      expect(s).not.toContain('t("rsvpCopy", "Copy")');
    }
    // Order: the card, then the kit right under it.
    expect(src.indexOf("<BookingLinkCard")).toBeGreaterThan(-1);
    expect(src.indexOf("<BookingLinkCard")).toBeLessThan(src.indexOf("<WebsiteBookingKit"));
  });
});
