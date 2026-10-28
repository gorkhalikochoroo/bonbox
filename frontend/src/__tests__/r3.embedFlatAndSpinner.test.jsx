/**
 * Booking R3 — the owner's `&flat=1` escape for the embed card (judge
 * change 4) and the guest wait (change 8: grey, only after 600 ms).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { embedQuery, iframeSnippet, previewSrcFor } from "../utils/bookingEmbed";
import { sampleLookQuery } from "../utils/bookingEmbed";
// Booking R13: a new snippet matches the website by default; the preview shows it on the light sample site.
const LOOK_Q = "&" + sampleLookQuery("light", { mode: "auto", accent: "site" });
import GuestSpinner from "../components/GuestSpinner";

vi.mock("../utils/download", () => ({ saveFile: vi.fn(async () => ({ ok: true })) }));
import WebsiteBookingKit from "../components/reservations/WebsiteBookingKit";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const URL_ROOT = "https://www.bonbox.dk/cafe-mirabelle";
const makeT = (dict) => (key, vars) => {
  const s = dict[key] ?? key;
  return vars && typeof vars === "object" ? s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m)) : s;
};

describe("&flat=1 — the embed without its card", () => {
  it("embedQuery: the card is the default, flat is opt-in", () => {
    expect(embedQuery()).toBe("?embed=1");
    expect(embedQuery({ flat: true })).toBe("?embed=1&flat=1");
  });

  it("the snippet: unchanged by default; flat adds &flat=1, escaped for the attribute", () => {
    const base = { publicUrl: URL_ROOT, label: "Book bord", venueName: "X", fallbackLabel: "x" };
    expect(iframeSnippet(base)).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1"');
    const flat = iframeSnippet({ ...base, flat: true });
    // "&flat" written raw could read as the ♭ entity; &amp; is the safe form.
    expect(flat).toContain('src="https://www.bonbox.dk/r/cafe-mirabelle?embed=1&amp;flat=1"');
    expect(flat).toContain('height="720"');
  });

  it("the owner's preview loads the same variant", () => {
    expect(previewSrcFor(URL_ROOT, "https://www.bonbox.dk")).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1");
    expect(previewSrcFor(URL_ROOT, "https://www.bonbox.dk", { flat: true })).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1&flat=1");
    expect(previewSrcFor(URL_ROOT, "capacitor://localhost", { flat: true })).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1&flat=1");
  });

  it("the kit offers it as a switch, in real Danish and English; the copied code follows it", () => {
    for (const [dict, lang] of [[da, "da"], [en, "en"]]) {
      const view = render(
        <WebsiteBookingKit publicUrl={URL_ROOT} venueName="Café" enabled t={makeT(dict)} appOrigin="https://www.bonbox.dk" canFramePreview />,
      );
      fireEvent.click(screen.getByRole("tab", { name: dict.rsvpWebTabEmbed || (lang === "da" ? "Indlejr" : "Embed") }));
      const box = screen.getByTestId("website-embed-flat");
      expect(box.checked).toBe(false);
      expect(screen.getByText(dict.rsvpWebEmbedFlat)).toBeTruthy();
      expect(screen.getByText(dict.rsvpWebEmbedFlatHint)).toBeTruthy();
      // Booking R4: the kit's default also carries the compact header.
      expect(screen.getByTestId("website-embed-code").textContent).toContain("?embed=1&amp;compact=1&amp;look=1\""); // R13: look=1
      fireEvent.click(box);
      expect(screen.getByTestId("website-embed-code").textContent).toContain("?embed=1&amp;flat=1");
      expect(screen.getByTestId("website-preview").getAttribute("src")).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1&flat=1&compact=1" + LOOK_Q);
      expect(view.container.textContent).not.toMatch(/rsvpWebEmbedFlat/);
      view.unmount();
    }
  });

  it("both keys exist in en and da, and differ (a real translation)", () => {
    for (const k of ["rsvpWebEmbedFlat", "rsvpWebEmbedFlatHint"]) {
      expect(typeof da[k]).toBe("string");
      expect(typeof en[k]).toBe("string");
      expect(da[k]).not.toBe(en[k]);
    }
  });
});

describe("the guest wait: grey, and only after 600 ms", () => {
  it("GuestSpinner: hidden for 600 ms (.bb-late), grey, language-free", () => {
    const { container } = render(<GuestSpinner testId="page-loader" />);
    const late = container.querySelector(".bb-late");
    expect(late).not.toBeNull();
    expect(late.querySelector(".animate-spin")).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/blue/);
    expect(container.innerHTML).toMatch(/border-t-gray-500/);
    expect(screen.getByTestId("page-loader")).toBeTruthy();
    expect(container.textContent.trim()).toBe("…");
  });

  // Booking R5: the guest route's Suspense shows the page's own skeleton (the
  // markup index.html already painted — r5.bookingWait.test.jsx); the
  // PageLoader on a guest surface keeps this grey, late spinner.
  it("App.jsx: the PageLoader on a guest surface uses it, the guest route waits on the page's skeleton (R5); the app's own loader is unchanged", () => {
    const app = read("App.jsx");
    expect(app).toContain('<Suspense fallback={<BookingSkeleton variant={variantForHere()} />}>');
    expect(app).toMatch(/function PageLoader\(\) \{[\s\S]{0,400}if \(isGuestSurface\(\)\) return <GuestSpinner testId="page-loader" \/>;/);
    // Owner app loader: untouched (surgical — no global change).
    expect(app).toContain('className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-3"');
  });
});
