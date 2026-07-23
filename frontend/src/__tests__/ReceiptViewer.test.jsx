/**
 * Tests for the <ReceiptViewer> modal.
 *
 * Three responsibilities pinned by these tests:
 *
 *   1. Security — the photo URL is wrapped through safeImageUrl. A
 *      caller passing a `javascript:`/`data:` URL must get a graceful
 *      placeholder, never have the bytes piped to <img src>. This is
 *      the LAST line of defense if a malicious receipt URL ever lands
 *      in the DB.
 *
 *   2. Behaviour — ESC closes the modal, click outside closes it,
 *      click inside doesn't.
 *
 *   3. OCR text highlighting — when detectedAmounts + suggestedAmount
 *      are passed (pre-save mode), the matching numbers in the OCR
 *      text get <mark>ed, with the suggested one styled differently.
 *      This is what makes the pre-save review actually useful for
 *      spot-checking.
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent } from "@testing-library/react";

import { LanguageProvider } from "../hooks/useLanguage";
import ReceiptViewer from "../components/ReceiptViewer";


function withProviders(ui) {
  return render(
    <MemoryRouter>
      <LanguageProvider>{ui}</LanguageProvider>
    </MemoryRouter>,
  );
}


describe("<ReceiptViewer> — render and metadata", () => {
  it("renders nothing when open is false", () => {
    const { container } = withProviders(
      <ReceiptViewer
        open={false}
        onClose={() => {}}
        imageUrl="https://example.com/r.jpg"
        amount={500}
        date="2026-05-07"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the recorded amount + date + payment method", () => {
    withProviders(
      <ReceiptViewer
        open
        onClose={() => {}}
        imageUrl="https://supabase.example/r.jpg"
        amount={1234.5}
        currency="DKK"
        date="2026-05-07"
        paymentMethod="card"
        kind="sale"
      />,
    );
    // Amount is rendered with toLocaleString formatting
    expect(screen.getByText(/1,234\.5|1.234,5/)).toBeInTheDocument();
    expect(screen.getByText("DKK")).toBeInTheDocument();
    expect(screen.getByText("2026-05-07")).toBeInTheDocument();
  });

  it("renders an em-dash when amount is null/undefined", () => {
    withProviders(
      <ReceiptViewer
        open
        onClose={() => {}}
        imageUrl="https://supabase.example/r.jpg"
        amount={null}
        date="2026-05-07"
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});


describe("<ReceiptViewer> — image URL safety (security-critical)", () => {
  // safeImageUrl is what stops a malicious receipt URL from running
  // in our origin. The viewer MUST NOT render an <img src> for any
  // value safeImageUrl rejects — instead it shows an icon placeholder.
  it.each([
    ["javascript: URL",     "javascript:alert(1)"],
    ["data:image/svg+xml",  'data:image/svg+xml,<svg onload="alert(1)"/>'],
    ["http: insecure",      "http://example.com/r.jpg"],
    ["empty",               ""],
    ["null",                null],
  ])("renders placeholder, NOT an <img>, for %s", (_label, badUrl) => {
    const { container } = withProviders(
      <ReceiptViewer
        open
        onClose={() => {}}
        imageUrl={badUrl}
        amount={100}
        date="2026-05-07"
      />,
    );
    // No <img> element should be rendered — the URL was blocked.
    const img = container.querySelector("img");
    expect(img).toBeNull();
    // The placeholder div renders inside the photo column, identifiable
    // by its `aspect-[3/4]` class. Scoping the icon lookup to it matters:
    // the header and the ✕ button render their own <svg>s, so an
    // unscoped container.querySelector("svg") would pass vacuously.
    const placeholder = container.querySelector(".aspect-\\[3\\/4\\]");
    expect(placeholder).not.toBeNull();
    // The placeholder renders the Lucide <Receipt> icon — an <svg>, not
    // the 🧾 emoji it used to be. Asserting on "there is an icon here"
    // rather than on a specific glyph keeps this from re-breaking every
    // time the design system swaps the icon set; the emoji itself is now
    // banned in chrome by scripts/check-design-doctrine.sh (rule 9).
    expect(placeholder.querySelector("svg")).not.toBeNull();
  });

  it("renders the <img> for a valid https URL", () => {
    const { container } = withProviders(
      <ReceiptViewer
        open
        onClose={() => {}}
        imageUrl="https://supabase.example/r.jpg"
        amount={100}
        date="2026-05-07"
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("https://supabase.example/r.jpg");
  });
});


describe("<ReceiptViewer> — close interactions", () => {
  it("calls onClose when ESC is pressed", () => {
    const onClose = vi.fn();
    withProviders(
      <ReceiptViewer
        open
        onClose={onClose}
        imageUrl="https://supabase.example/r.jpg"
        amount={100}
        date="2026-05-07"
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = withProviders(
      <ReceiptViewer
        open
        onClose={onClose}
        imageUrl="https://supabase.example/r.jpg"
        amount={100}
        date="2026-05-07"
      />,
    );
    // The outermost role="dialog" element IS the backdrop.
    const backdrop = container.querySelector('[role="dialog"]');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when the modal panel itself is clicked", () => {
    const onClose = vi.fn();
    withProviders(
      <ReceiptViewer
        open
        onClose={onClose}
        imageUrl="https://supabase.example/r.jpg"
        amount={100}
        date="2026-05-07"
      />,
    );
    // The recorded-amount label is inside the panel; click it and the
    // event must not bubble to backdrop.
    fireEvent.click(screen.getByText(/Recorded amount/i));
    expect(onClose).not.toHaveBeenCalled();
  });
});


describe("<ReceiptViewer> — OCR text + amount highlighting", () => {
  // The pre-save review surface: ReceiptCapture passes the OCR text
  // + detected amounts so the user can see at a glance which numbers
  // in the printed receipt drove the "detected amount" pick. This
  // test pins that the suggested amount gets a different style from
  // the others (the user shouldn't have to count to figure out which
  // one we picked).
  const sampleOcr = `
    Mirabelle Restaurant
    Vesterbrogade 12
    Sub-total      1200
    Tip              50
    Total          1250
  `;

  it("highlights every detected amount in the OCR text", () => {
    const { container } = withProviders(
      <ReceiptViewer
        open
        onClose={() => {}}
        imageUrl="https://supabase.example/r.jpg"
        amount={1250}
        date="2026-05-07"
        ocrText={sampleOcr}
        detectedAmounts={[1200, 50, 1250]}
        suggestedAmount={1250}
      />,
    );
    // Three <mark> elements for three detected amounts
    const marks = Array.from(container.querySelectorAll("mark"));
    expect(marks.length).toBe(3);
    expect(marks.map((m) => m.textContent).sort()).toEqual(["1200", "1250", "50"]);
    // The point of the highlighting is that the user can tell WHICH
    // match drove the "detected amount" pick without counting. So pin
    // the contrast, not the palette: the suggested mark must be styled
    // differently from the others, and the others must all share one
    // style. Naming the actual colour classes here is what made this
    // test stale — the design-system ship (db32753) recoloured the
    // suggested mark emerald → gray and nothing about the behaviour
    // changed.
    const suggested = marks.find((m) => m.textContent === "1250");
    const others = marks.filter((m) => m !== suggested);
    expect(others).toHaveLength(2);
    expect(others.every((m) => m.className !== suggested.className)).toBe(true);
    expect(new Set(others.map((m) => m.className)).size).toBe(1);
  });

  it("does not render the OCR panel when ocrText is omitted", () => {
    withProviders(
      <ReceiptViewer
        open
        onClose={() => {}}
        imageUrl="https://supabase.example/r.jpg"
        amount={1250}
        date="2026-05-07"
        // ocrText left undefined — this is the post-save case where
        // we don't persist OCR text on the row.
      />,
    );
    expect(screen.queryByText(/Receipt text recognized/i)).toBeNull();
  });
});
