/**
 * Fix round 5 (gate, ESLint rules-of-hooks): BookingHoursSourceNote called
 * useAuth inside a try/catch so that a card without a session context never
 * broke. It now calls useAuth({ optional: true }) at the top, unconditionally
 * — the same behaviour: no session = the restaurant's words; a session = its
 * own words. useAuth without the option still throws outside its provider.
 *
 * Run: cd frontend && npx vitest run src/__tests__/fix27.hoursNoteNoSession.test.jsx
 */
import { render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../hooks/useLanguage", async () => {
  const { da } = await import("../i18n/da");
  return { useLanguage: () => ({ lang: "da", t: (k, fb) => da[k] ?? fb }) };
});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { default: BookingHoursSourceNote } = await import("../components/BookingHoursSourceNote");
const { useAuth } = await import("../hooks/useAuth");
const { da } = await import("../i18n/da");

describe("BookingHoursSourceNote without a session context", () => {
  it("renders the restaurant's words — never breaks its card", () => {
    render(<MemoryRouter><BookingHoursSourceNote status={{ days: [], chairs_only: false }} /></MemoryRouter>);
    expect(screen.getByTestId("profile-hours-note").textContent).toContain(da.profileHoursNoteProfile);
  });

  it("useAuth({ optional: true }) is null outside the provider; useAuth() still throws", () => {
    const { result } = renderHook(() => useAuth({ optional: true }));
    expect(result.current).toBeNull();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useAuth())).toThrow(/within AuthProvider/);
    quiet.mockRestore();
  });

  it("the hook is called at the top, never inside a try/catch", () => {
    const src = fs.readFileSync(path.join(SRC, "components/BookingHoursSourceNote.jsx"), "utf8");
    expect(src).toContain("const user = useAuth({ optional: true })?.user || null;");
    expect(src).not.toMatch(/try\s*\{\s*user = useAuth/);
  });
});
