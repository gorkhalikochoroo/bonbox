/**
 * EntryCard — autofocus the amount field, but only where it helps.
 *
 * Context: this came out of asking how the expense form behaves when an owner
 * is in a hurry. On a laptop, landing in the amount field saves a click and
 * costs nothing. On a phone it is actively harmful: focusing a numeric input
 * raises the keyboard on page load, which shoves "Snap a receipt" — the
 * FASTER path, and the one that keeps the bilag and sets the category — off
 * the screen. Autofocus would make the slower path the default on the exact
 * device where the hurry actually happens.
 *
 * So the guard is the feature, and these pin it:
 *   • desktop focuses the amount field
 *   • a coarse pointer does not, whatever the viewport width says
 *   • a narrow viewport does not, whatever the pointer says
 *   • it never steals focus from something the owner already selected
 *   • it stays off unless a caller opts in
 *
 * The two conditions are tested independently on purpose. A tablet reports a
 * coarse pointer at 1024px wide, and a desktop window dragged narrow reports a
 * fine pointer at 500px — checking only one would let a keyboard pop up on a
 * real device.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { LanguageProvider } from "../hooks/useLanguage";
import EntryCard from "../components/ui/EntryCard";

const AMOUNT_LABEL = /beløb|amount/i;

/** jsdom ships no matchMedia; the component optional-chains it, so absence
 *  reads as "not coarse". Install one only when a test needs coarse to be true. */
function setPointer(coarse) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: coarse && query.includes("coarse"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setWidth(px) {
  Object.defineProperty(window, "innerWidth", {
    value: px,
    writable: true,
    configurable: true,
  });
}

function renderCard(props = {}) {
  return render(
    <LanguageProvider>
      <EntryCard
        title="Tilføj udgift"
        amount=""
        onAmountChange={() => {}}
        onSubmit={() => {}}
        {...props}
      />
    </LanguageProvider>,
  );
}

const amountField = () => screen.getByPlaceholderText(/custom amount|beløb/i);

describe("EntryCard autoFocusAmount", () => {
  const realMatchMedia = window.matchMedia;
  const realWidth = window.innerWidth;

  beforeEach(() => {
    delete window.matchMedia; // absent = fine pointer, the desktop default
    setWidth(1280);
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    setWidth(realWidth);
    vi.restoreAllMocks();
  });

  it("focuses the amount field on a desktop pointer", () => {
    renderCard({ autoFocusAmount: true });
    expect(document.activeElement).toBe(amountField());
  });

  it("stays off unless the caller opts in", () => {
    renderCard();
    expect(document.activeElement).not.toBe(amountField());
  });

  // ── the two guards, separately ──────────────────────────────────────────

  it("does NOT focus on a coarse pointer, even on a wide viewport", () => {
    setPointer(true);
    setWidth(1024); // a tablet is wide and still must not raise a keyboard
    renderCard({ autoFocusAmount: true });
    expect(document.activeElement).not.toBe(amountField());
  });

  it("does NOT focus on a narrow viewport, even with a fine pointer", () => {
    setWidth(390); // iPhone width
    renderCard({ autoFocusAmount: true });
    expect(document.activeElement).not.toBe(amountField());
  });

  // ── never take focus away from a person ─────────────────────────────────

  it("does not steal focus from a field the owner already selected", () => {
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    renderCard({ autoFocusAmount: true });

    expect(document.activeElement).toBe(other);
    other.remove();
  });
});
