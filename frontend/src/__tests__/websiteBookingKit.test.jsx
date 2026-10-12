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
    expect(code).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1"');
    expect(code).toContain("bonbox:height");
    expect(code).toContain("e.origin!=='https://www.bonbox.dk'");
    expect(code).toContain("Åbn booking i nyt vindue →");
    expect(screen.getByText(/skal køre på https/)).toBeInTheDocument();
  });

  it("previews the real booking page at phone width", () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    const frame = screen.getByTestId("website-preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", "https://www.bonbox.dk/r/cafe-mirabelle?embed=1");
    expect(frame).toHaveAttribute("title", "Forhåndsvisning af din bookingside");
    expect(frame.parentElement.className).toContain("max-w-[375px]");
  });

  it("a local build previews its own page, not production's", () => {
    renderKit({ appOrigin: "http://127.0.0.1:15977" });
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    expect(screen.getByTestId("website-preview")).toHaveAttribute("src", "http://127.0.0.1:15977/r/cafe-mirabelle?embed=1");
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

  it("WordPress: an HTML block; One.com points WordPress sites to that guide", () => {
    renderKit();
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    fireEvent.click(screen.getByRole("radio", { name: "WordPress" }));
    expect(screen.getByText("Tilføj en HTML-blok (Custom HTML).")).toBeInTheDocument();
    expect(screen.queryByText(/følg WordPress-vejledningen/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "One.com" }));
    expect(screen.getByText(/følg WordPress-vejledningen/)).toBeInTheDocument();
  });
});

describe("WebsiteBookingKit — send to whoever makes the website", () => {
  it("opens a pre-filled mail with the link, the button and the embed — BonBox sends nothing", () => {
    renderKit();
    const a = screen.getByTestId("website-mailto");
    expect(a).toHaveTextContent("Send til den, der laver din hjemmeside");
    expect(screen.getByText(/BonBox sender ikke noget/)).toBeInTheDocument();
    const href = a.getAttribute("href");
    expect(href.startsWith("mailto:?subject=")).toBe(true); // no recipient: the owner picks one
    const q = new URLSearchParams(href.slice("mailto:?".length));
    expect(q.get("subject")).toBe("Booking på vores hjemmeside");
    const body = q.get("body");
    expect(body).toContain(`Vores bookinglink:\n${PUBLIC}\n`);
    expect(body).toContain(`<a href="${PUBLIC}"`);
    expect(body).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1"');
    expect(body).toContain("HTML- eller Indlejr-blok");
    expect(body).not.toMatch(/\{(link|button|iframe)\}/);
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
  it("the page header links to the kit from every tab", () => {
    expect(src).toContain('websiteHref="/reservations?tab=settings&show=website"');
    expect(src).toContain('{t("rsvpWebEntry")}');
  });
  it("Settings always renders the kit (it explains itself until the page is live)", () => {
    expect(src).toMatch(/<WebsiteBookingKit\s+publicUrl=\{publicUrl\}/);
    expect(src).not.toMatch(/enabled && publicUrl && \(\s*<WebsiteBookingKit/);
    expect(src).toContain('get("show") === "website"');
  });
  it("the share card (QR, link, copy, open, custom link) is still there", () => {
    expect(src).toContain('t("rsvpShareTitle", "Your booking page")');
    expect(src).toContain("<QRCodeSVG");
    expect(src).toContain('t("rsvpCustomLink", "Customise your link")');
  });
});
