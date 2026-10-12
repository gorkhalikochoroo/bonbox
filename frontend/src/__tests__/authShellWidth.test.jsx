/**
 * Push 7 — /verify-email was wider than a phone below 384 px (QA: at 360 px
 * the 6th code box was cut, 44 of its 52 px visible, and the button ran to
 * the edge; at 375 px off-centre; at 320 px nine elements clipped).
 *
 * Cause: AuthShell's <main class="flex-1 flex …"> kept min-width:auto, and
 * the code row's minimum was 6 × 52 px + 5 × 8 px = 352 px, so <main> could
 * not shrink below 352 + 2 × 16 = 384 px.
 *
 * jsdom has no layout, so these pin the two classes that fix it; the widths
 * themselves were measured in headless Chromium at 320 / 360 / 375 / 390 px
 * (every AuthShell page: no element past the 16 px gutter, equal margins;
 * boxes 41.3 / 48 / 50.5 / 52 px).
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn(() => Promise.resolve({ data: {} })), get: vi.fn(() => Promise.resolve({ data: {} })) }));
vi.mock("../services/api", () => ({ default: { post: (...a) => h.post(...a), get: (...a) => h.get(...a), patch: vi.fn() } }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 7, email: "ole@cafe.dk", email_verified: false }, setEmailVerified: vi.fn(), refreshUser: vi.fn(), logout: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: "da", setLang: () => {}, LANGUAGES: [], t: (k) => k }),
  LanguageProvider: ({ children }) => children,
}));

const AuthShell = (await import("../components/auth/AuthUI")).default;
const VerifyEmailPage = (await import("../pages/VerifyEmailPage")).default;

describe("AuthShell — the column is the screen minus the 16 px gutters", () => {
  it("<main> may shrink below its content's minimum (min-w-0), keeps px-4", () => {
    const { container } = render(<MemoryRouter><AuthShell><p>x</p></AuthShell></MemoryRouter>);
    const main = container.querySelector("main");
    expect(main.className).toMatch(/(^|\s)flex-1(\s|$)/);
    expect(main.className).toMatch(/(^|\s)min-w-0(\s|$)/);
    expect(main.className).toMatch(/(^|\s)px-4(\s|$)/);
    // …and the column inside it stays the full width up to 400 px.
    expect(main.firstElementChild.className).toMatch(/(^|\s)w-full max-w-\[400px\](\s|$)/);
  });
});

describe("/verify-email — the code row asks for no width of its own", () => {
  it("each box: w-0 + flex-1 + min-w-0, capped at 52 px, 56 px tall", () => {
    render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>);
    const boxes = screen.getByTestId("verify-code-row").querySelectorAll("input");
    expect(boxes).toHaveLength(6);
    for (const b of boxes) {
      for (const c of ["w-0", "flex-1", "min-w-0", "max-w-[3.25rem]", "h-14"]) {
        expect(b.className.split(/\s+/), c).toContain(c);
      }
    }
  });
});
