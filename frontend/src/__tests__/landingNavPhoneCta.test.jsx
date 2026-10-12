/**
 * Mobile walk, 12 Oct 2026 — the landing bar's "Prøv gratis" pill, the first
 * tap of the sign-up, broke onto two lines at 375 px (109 px for it) and
 * 360 px (94 px). Under 400 px the gap after the logo is 16 px instead of
 * 36 px, and the pill does not wrap. (Measured on the phone profiles: one
 * line, 44 px tall, no sideways scroll at 360.)
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: "da", setLang: () => {}, t: (k, fb) => (k === "landingV2.nav.cta" ? "Prøv gratis" : typeof fb === "string" ? fb : k) }),
}));

import NavV2 from "../components/landing/v2/NavV2";

describe("the landing bar's Prøv gratis on a phone", () => {
  it("stays on one line, with room made under 400 px", () => {
    render(<MemoryRouter><NavV2 /></MemoryRouter>);
    const cta = screen.getByRole("link", { name: "Prøv gratis" });
    expect(cta.getAttribute("href")).toBe("/register");
    expect(cta.className).toMatch(/\bwhitespace-nowrap\b/);
    const row = cta.closest("header").firstElementChild;
    expect(row.className).toMatch(/max-\[399px\]:gap-4/);
    // desktop keeps its 36 px gap
    expect(row.className).toMatch(/\bgap-9\b/);
  });
});
