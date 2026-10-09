/**
 * Release gate R-b (9 Oct): the landing page's staff-app phone mock (the
 * "Dit team får deres egen app" section, ≥981 px) set its "Estimat · ≈ 1.812
 * kr. før skat" line in slate-400 on the white phone — 2.63:1 at 11.5 px.
 * It now uses slate-500 like the mock's other "kr." / hours text: #64748b on
 * #ffffff = 4.76:1 (≥ 4.5:1, WCAG AA for normal text).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k, fb) => (typeof fb === "string" ? fb : k), lang: "en" }),
}));

import PhoneFanV2 from "../components/landing/v2/PhoneFanV2";

// WCAG relative luminance contrast, for the two Tailwind slates involved.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const SLATE = { "text-slate-400": "#94a3b8", "text-slate-500": "#64748b", "text-slate-600": "#475569" };

describe("landing phone mock — the estimate line is readable", () => {
  it("is ≥ 4.5:1 on the white phone (not slate-400)", () => {
    render(<PhoneFanV2 />);
    const line = screen.getByText("Estimate · ≈ 1.812 kr. before tax");
    const cls = [...line.classList].find((c) => SLATE[c]);
    expect(cls).toBeTruthy();
    expect(cls).not.toBe("text-slate-400");
    expect(ratio(SLATE[cls], "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
