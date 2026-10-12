/**
 * Push 8 — desktop /register jumped ~42 px down when the cookie banner was
 * answered (QA click-through, 12 Oct 2026; measured 42 px at 1440 × 900,
 * /login 92 px).
 *
 * The auth frame padded its bottom by the banner's footprint (--bb-consent-h)
 * at every width. On md+ the banner is a 420 px card 24 px off the left edge;
 * beside the register panel (lg+, 46 % wide) — and from 1288 px for a lone
 * 400 px column — the card never sits over the form, so the padding did one
 * thing there: it re-centred the form 227/2 px higher while the banner was
 * up, and answering the banner dropped it back. It now pads only where the
 * card (or the phone's full-width sheet) can cover the form column.
 */
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: "da", setLang: () => {}, LANGUAGES: [], t: (k, fb) => (typeof fb === "string" ? fb : k) }),
}));

const AuthShell = (await import("../components/auth/AuthUI")).default;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frame = (props) =>
  render(<MemoryRouter><AuthShell {...props}><form><input /></form></AuthShell></MemoryRouter>)
    .container.querySelector("[data-auth-shell]");
const padClasses = (el) => el.className.split(/\s+/).filter((c) => c.includes("--bb-consent-h"));

describe("the auth frame pads for the cookie banner only where it can cover the form", () => {
  it("beside the register panel: below lg only (the card sits over the panel from lg up)", () => {
    const el = frame({ aside: <aside>panel</aside> });
    expect(padClasses(el)).toEqual(["max-lg:pb-[var(--bb-consent-h,0px)]"]);
    expect(el.style.paddingBottom).toBe("");
  });

  it("a lone column (login, verify, forgot): below 1288 px only", () => {
    const el = frame({});
    expect(padClasses(el)).toEqual(["max-[1288px]:pb-[var(--bb-consent-h,0px)]"]);
    expect(el.style.paddingBottom).toBe("");
  });

  it("no width-independent padding is left to re-centre the form", () => {
    const src = fs.readFileSync(path.join(SRC, "components/auth/AuthUI.jsx"), "utf8");
    expect(src).not.toContain('paddingBottom: "var(--bb-consent-h');
    expect(src).not.toMatch(/["\s]pb-\[var\(--bb-consent-h/);
  });

  it("/register gives the frame its panel (so the lg rule is the one it gets)", () => {
    const src = fs.readFileSync(path.join(SRC, "pages/RegisterPage.jsx"), "utf8");
    expect(src).toMatch(/<AuthShell aside=\{aside\}/);
    expect(src).toMatch(/<aside className="hidden lg:flex lg:w-\[46%\]/);
  });

  it("the banner's md+ geometry the 1288 px rule rests on is unchanged (left 24 px, 420 px wide)", () => {
    const src = fs.readFileSync(path.join(SRC, "components/CookieConsent.jsx"), "utf8");
    expect(src).toContain("md:left-6 md:w-[420px]");
    expect(src).toContain("bottom = wide ? (clear > 0 ? clear + 16 : 24) : clear");
  });
});
