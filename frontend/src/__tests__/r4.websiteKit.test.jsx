/**
 * Booking R4 — the owner's kit ("Book bord på din hjemmeside") fits the
 * booking to any website:
 *
 *  - a width (460 / 560), the compact header (on for a new snippet) and the
 *    card (R3) — the code, the preview and the hand-off mail follow at once;
 *  - a live preview on a phone OR on their page on a computer (centred on a
 *    stand-in ground, at the chosen width, scaled down — never up — to fit);
 *  - short guides: WordPress (block editor + Elementor), Wix, Squarespace;
 *  - real Danish and English, no raw keys, the 27 Sep dark-pill rule.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

vi.mock("../utils/download", () => ({ saveFile: vi.fn(async () => ({ ok: true })) }));
import WebsiteBookingKit, { COMPACT_DEFAULT } from "../components/reservations/WebsiteBookingKit";
import { sampleLookQuery } from "../utils/bookingEmbed";
// Booking R13: a new snippet matches the website by default; the preview shows it on the light sample site.
const LOOK_Q = "&" + sampleLookQuery("light", { mode: "auto", accent: "site" });

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
    <WebsiteBookingKit publicUrl={PUBLIC} venueName="Café Mirabelle" enabled t={tDa} appOrigin={APP} canFramePreview {...props} />,
  );
}
const openEmbed = (name = "Indlejr") => fireEvent.click(screen.getByRole("tab", { name }));
const code = () => screen.getByTestId("website-embed-code").textContent;
const mailBody = () => new URLSearchParams(screen.getByTestId("website-mailto").getAttribute("href").slice("mailto:?".length)).get("body");
const noRawKeys = (container) => {
  expect(container.textContent).not.toMatch(/rsvp[A-Z]\w+/);
  expect(container.textContent).not.toMatch(/\{\w+\}/);
};

let writeText;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the options, and what a new snippet carries by default", () => {
  it("default: centred at 460 px, the compact header on, the card on", () => {
    expect(COMPACT_DEFAULT).toBe(true);
    renderKit();
    openEmbed();
    const width = screen.getByTestId("website-embed-width");
    expect(within(width).getByRole("radio", { name: "Standard · 460 px" })).toHaveAttribute("aria-checked", "true");
    expect(within(width).getByRole("radio", { name: "Bred · 560 px" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("website-embed-compact").checked).toBe(true);
    expect(screen.getByTestId("website-embed-flat").checked).toBe(false);
    expect(code()).toContain('style="width:100%;max-width:460px;margin:0 auto"');
    expect(code()).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1&amp;compact=1"');
    expect(screen.getByText("Kompakt top")).toBeInTheDocument();
    expect(screen.getByText(da.rsvpWebEmbedCompactHint)).toBeInTheDocument();
  });

  it("the compact header off: the bare ?embed=1 (the full header, as before R4)", () => {
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByTestId("website-embed-compact"));
    expect(code()).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1"');
    expect(screen.getByTestId("website-preview").getAttribute("src")).toBe(`${APP}/r/cafe-mirabelle?embed=1` + LOOK_Q);
  });

  it("560 px: the code widens and the preview turns to the computer, at that width", () => {
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByRole("radio", { name: "Bred · 560 px" }));
    expect(screen.getByRole("radio", { name: "Bred · 560 px" })).toHaveAttribute("aria-checked", "true");
    expect(code()).toContain("max-width:560px;margin:0 auto");
    expect(screen.getByRole("radio", { name: /Computer/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Sådan ser den ud på din side på en computer")).toBeInTheDocument();
    const host = screen.getByTestId("website-preview-host");
    const frame = within(host).getByTestId("website-preview");
    expect(frame.style.width).toBe("560px");
    expect(frame.getAttribute("src")).toBe(`${APP}/r/cafe-mirabelle?embed=1&compact=1` + LOOK_Q);
    // Back to 460: same frame, narrower.
    fireEvent.click(screen.getByRole("radio", { name: "Standard · 460 px" }));
    expect(within(screen.getByTestId("website-preview-host")).getByTestId("website-preview").style.width).toBe("460px");
  });

  it("the card off (flat) rides the code and the preview, and shows on the computer", () => {
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByTestId("website-embed-flat"));
    expect(code()).toContain("?embed=1&amp;flat=1&amp;compact=1\"");
    expect(screen.getByRole("radio", { name: /Computer/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("website-preview").getAttribute("src")).toBe(`${APP}/r/cafe-mirabelle?embed=1&flat=1&compact=1` + LOOK_Q);
  });

  it("the hand-off mail carries the snippet as chosen, and where it goes", () => {
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByRole("radio", { name: "Bred · 560 px" }));
    const body = mailBody();
    expect(body).toContain("max-width:560px;margin:0 auto");
    expect(body).toContain("?embed=1&amp;compact=1");
    // R13 fix round: the button snippet left the mail (it stays in the kit); where the code goes is one line
    expect(body).not.toContain('<div style="text-align:center">');
    expect(body).toContain("Indsæt koden i en HTML- eller Indlejr-blok.");
    expect(body).toContain("Tilpasset HTML");
    expect(body).toContain("Elementor");
    expect(body).toContain("Embed HTML");
    expect(body).toContain("Squarespace");
    expect(body).not.toMatch(/\{(link|button|iframe)\}/);
  });

  it("the copy button copies exactly the code on screen", async () => {
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByTestId("website-embed-compact"));
    fireEvent.click(screen.getByRole("radio", { name: "Bred · 560 px" }));
    await act(async () => fireEvent.click(screen.getByTestId("website-copy-embed")));
    expect(writeText).toHaveBeenCalledWith(code());
    expect(writeText.mock.calls[0][0]).toContain("max-width:560px");
    expect(writeText.mock.calls[0][0]).toContain('?embed=1"');
  });
});

describe("the live preview: a phone, or their page on a computer", () => {
  it("starts on the phone (375 px), and switches both ways", () => {
    renderKit();
    openEmbed();
    const device = screen.getByTestId("website-preview-device");
    expect(within(device).getByRole("radio", { name: /Telefon/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("website-preview").parentElement.className).toContain("max-w-[375px]");
    expect(screen.queryByTestId("website-preview-host")).toBeNull();
    fireEvent.click(within(device).getByRole("radio", { name: /Computer/ }));
    expect(screen.getByTestId("website-preview-host")).toBeInTheDocument();
    expect(screen.getAllByTestId("website-preview")).toHaveLength(1);
    fireEvent.click(within(device).getByRole("radio", { name: /Telefon/ }));
    expect(screen.queryByTestId("website-preview-host")).toBeNull();
    expect(screen.getByText(da.rsvpWebPreviewHeading)).toBeInTheDocument();
  });

  it("the computer frame sizes from its own height messages; its box follows", () => {
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByRole("radio", { name: /Computer/ }));
    const frame = screen.getByTestId("website-preview");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:height", height: 777 }, origin: APP, source: frame.contentWindow }));
    });
    expect(frame.style.height).toBe("777px");
    expect(frame.parentElement.style.height).toBe("777px");
    expect(frame.parentElement.style.width).toBe("460px");
    // Another window: ignored.
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:height", height: 400 }, origin: APP, source: window }));
    });
    expect(frame.style.height).toBe("777px");
  });

  it("on a narrow screen it scales DOWN to fit, keeping the frame's real width", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByRole("radio", { name: /Computer/ }));
    const frame = screen.getByTestId("website-preview");
    const s = 300 / 460;
    expect(frame.style.width).toBe("460px");
    expect(frame.style.transform).toBe(`scale(${s})`);
    expect(frame.getAttribute("data-scale")).toBe(s.toFixed(3));
    expect(frame.parentElement.style.width).toBe("300px");
  });

  it("on a wide screen it is never scaled up", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(2000);
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByRole("radio", { name: /Computer/ }));
    const frame = screen.getByTestId("website-preview");
    expect(frame.style.transform).toBe("");
    expect(frame.getAttribute("data-scale")).toBe("1.000");
    expect(frame.parentElement.style.width).toBe("460px");
  });

  it("the iOS app (no frames): no device switch, no preview, the page link stays", () => {
    renderKit({ canFramePreview: false });
    openEmbed();
    expect(screen.queryByTestId("website-preview-device")).toBeNull();
    expect(screen.queryByTestId("website-preview")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Bred · 560 px" }));
    expect(screen.queryByTestId("website-preview")).toBeNull();
    expect(screen.getByText(da.rsvpWebPreviewHeading)).toBeInTheDocument();
  });

  it("picked pills follow the 27 Sep phone rule: a raised grey in dark, never the white slab", () => {
    renderKit();
    openEmbed();
    const on = screen.getByRole("radio", { name: "Standard · 460 px" });
    expect(on.className).toContain("dark:bg-gray-600");
    expect(on.className).not.toContain("dark:bg-white");
    expect(on.className).toContain("h-10 sm:h-8 min-h-0!");
  });
});

describe("the guides: WordPress (block editor + Elementor), Wix, Squarespace", () => {
  const steps = () => within(screen.getByTestId("website-guide-steps")).getAllByRole("listitem").map((li) => li.textContent);
  const notes = () => screen.queryAllByTestId("website-guide-note").map((p) => p.textContent);
  const openGuide = (name) => {
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    fireEvent.click(screen.getByRole("radio", { name }));
  };

  it("WordPress: the Danish block name, preview, update — and a pointer to Elementor", () => {
    renderKit();
    openGuide("WordPress");
    const s = steps();
    expect(s).toHaveLength(4);
    expect(s[0]).toContain(da.rsvpWebGuideWpOpen);
    expect(s[1]).toContain("“Tilpasset HTML”");
    expect(s[2]).toContain(da.rsvpWebGuideWpPaste);
    expect(s[3]).toContain(da.rsvpWebGuideWpPublish);
    expect(notes()).toEqual([da.rsvpWebGuideWpElementorNote, da.rsvpWebGuideWpCodeNote]);
  });

  it("Elementor: its own four steps and the editor-height note", () => {
    renderKit();
    openGuide("Elementor");
    const s = steps();
    expect(s[0]).toContain("Rediger med Elementor");
    expect(s[1]).toContain("“HTML”");
    expect(s[2]).toContain(da.rsvpWebGuideElPaste);
    expect(notes()).toEqual([da.rsvpWebGuideElNote]);
  });

  it("Wix: Embed HTML, a box that is made tall enough (mobile too)", () => {
    renderKit();
    openGuide("Wix");
    const s = steps();
    expect(s[1]).toContain("“Embed Code” → “Embed HTML”");
    expect(s[3]).toContain("800 px");
    expect(s[3]).toContain("mobilvisningen");
    expect(notes()).toEqual([da.rsvpWebGuideWixNote]);
  });

  it("Squarespace: a Code block, the editor's “Script disabled”, a plan without code", () => {
    renderKit();
    openGuide("Squarespace");
    const s = steps();
    expect(s[1]).toContain("“Code”");
    expect(s[2]).toContain(da.rsvpWebGuidePastePlain);
    expect(notes()).toEqual([da.rsvpWebGuideSqNote, da.rsvpWebGuideSqPlanNote]);
  });

  it("every builder's step 3 copies the same snippet as Indlejr (with the options as chosen)", async () => {
    renderKit();
    openEmbed();
    fireEvent.click(screen.getByRole("radio", { name: "Bred · 560 px" }));
    const embedCode = code();
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    for (const n of ["Wix", "WordPress", "Elementor", "Squarespace", "One.com", "Simply.com", "Shopify"]) {
      fireEvent.click(screen.getByRole("radio", { name: n }));
      const li = within(screen.getByTestId("website-guide-steps")).getAllByRole("listitem");
      expect(li).toHaveLength(4);
      expect(li.map((x) => !!within(x).queryByTestId("website-guide-copy-embed"))).toEqual([false, false, true, false]);
    }
    await act(async () => fireEvent.click(screen.getByTestId("website-guide-copy-embed")));
    expect(writeText).toHaveBeenCalledWith(embedCode);
  });
});

describe("words", () => {
  it("English: every tab, both previews and every guide, with no raw keys", () => {
    const { container } = renderKit({ t: tEn });
    openEmbed("Embed");
    expect(screen.getByText("Compact header")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Wide · 560 px" })).toBeInTheDocument();
    noRawKeys(container);
    fireEvent.click(screen.getByRole("radio", { name: /Computer/ }));
    expect(screen.getByText("How it looks on your page on a computer")).toBeInTheDocument();
    noRawKeys(container);
    fireEvent.click(screen.getByRole("tab", { name: "Guides" }));
    for (const n of ["Wix", "WordPress", "Elementor", "Squarespace", "One.com", "Simply.com", "Shopify"]) {
      fireEvent.click(screen.getByRole("radio", { name: n }));
      noRawKeys(container);
    }
  });

  it("Danish: the same, and a salon gets “Book tid” in the code", () => {
    const { container } = renderKit({ isProvider: true });
    openEmbed();
    noRawKeys(container);
    expect(code()).toContain('title="Book tid — Café Mirabelle"');
    fireEvent.click(screen.getByRole("radio", { name: /Computer/ }));
    noRawKeys(container);
    fireEvent.click(screen.getByRole("tab", { name: "Vejledning" }));
    for (const n of ["WordPress", "Elementor", "Wix", "Squarespace"]) {
      fireEvent.click(screen.getByRole("radio", { name: n }));
      noRawKeys(container);
    }
  });

  it("the button snippet is centred, and its hint says so", async () => {
    renderKit();
    await act(async () => fireEvent.click(screen.getByTestId("website-copy-button")));
    expect(writeText.mock.calls[0][0].startsWith('<div style="text-align:center">')).toBe(true);
    expect(screen.getByText(da.rsvpWebButtonHint)).toBeInTheDocument();
    expect(da.rsvpWebButtonHint).toContain("i midten");
  });
});
