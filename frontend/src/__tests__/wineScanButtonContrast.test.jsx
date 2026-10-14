/**
 * Vinkort's "📷 Scan flaske" was white text on bg-gray-50: a blank pill in
 * light mode (computed rgb(255,255,255) on oklch(0.985 …)). Pre-existing, but
 * Push 8's item 10 now sends a fresh bar's owner there from the menu, so the
 * first action button on the page must be readable (Push 8 review, round 5).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: {
    get: vi.fn((url) => Promise.resolve({ data: url.includes("summary") ? null : [] })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: { id: "u1", business_type: "bar", currency: "DKK" } }) };
});
vi.mock("../hooks/useToast", () => ({ useToast: () => vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const WineListPage = (await import("../pages/WineListPage")).default;
const { da } = await import("../i18n/da");

afterEach(() => cleanup());

// Tailwind backgrounds too light for white text.
const LIGHT_BG = /(^|\s)bg-(white|gray-50|gray-100|gray-200|transparent)(\s|$)/;

describe("Vinkort's scan button is readable in light mode", () => {
  it("'Scan flaske' sits on a dark ground, not white on near-white", async () => {
    render(<MemoryRouter><WineListPage /></MemoryRouter>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const btn = screen.getByRole("button", { name: new RegExp(da.wineScanBottle) });
    const cls = btn.className;
    expect(cls).toMatch(/(^|\s)text-white(\s|$)/);
    expect(cls).not.toMatch(LIGHT_BG);
    expect(cls).toMatch(/(^|\s)bg-gray-900(\s|$)/);
  });
});
