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

  it("a lone column (login, verify, forgot): pads at every width, and from lg the frame grows by the same height", () => {
    const el = frame({});
    // Push 8 review, second round: the padding stopped at 1288 px, and from
    // there the card sat over /login's footer line ("Lavet i København ·
    // database i …") with no way to scroll it clear. The padding is back
    // at every width; from lg the frame grows by it, so it moves nothing.
    expect(padClasses(el)).toEqual([
      "pb-[var(--bb-consent-h,0px)]",
      "lg:min-h-[calc(100dvh+var(--bb-consent-h,0px))]",
    ]);
    expect(el.style.paddingBottom).toBe("");
  });

  // Push 8 review: /login still jumped 42 px at 1280 × 800 and 26 px at
  // 1024 × 768 — the padding lifted the centred form while the banner was up.
  // On a desktop (lg up) the frame now grows by exactly the padding
  // (border-box), so the room the form is centred in stays 100dvh, banner or
  // not; the padding only adds scroll room under it. Measured in a browser
  // (vite preview): /login and /forgot-password move 0 px at 1024–1287 px,
  // and every control scrolls clear of the card. Below lg the padding alone.
  it("a lone column on a desktop: the frame grows by the banner, so the form is not lifted", () => {
    const el = frame({});
    const cls = el.className.split(/\s+/);
    expect(cls).toContain("min-h-[100dvh]");
    expect(cls).toContain("lg:min-h-[calc(100dvh+var(--bb-consent-h,0px))]");
    // The same variable as the padding it offsets, at every desktop width.
    expect(cls).toContain("pb-[var(--bb-consent-h,0px)]");
  });

  it("beside the register panel nothing grows (it measured 0 px at every size)", () => {
    const el = frame({ aside: <aside>panel</aside> });
    expect(el.className).not.toMatch(/min-h-\[calc/);
  });

  it("no padding is left to re-centre the form on a desktop", () => {
    const src = fs.readFileSync(path.join(SRC, "components/auth/AuthUI.jsx"), "utf8");
    expect(src).not.toContain('paddingBottom: "var(--bb-consent-h');
    // A desktop-wide padding only ever beside the frame's growth by the same
    // height (the lone column); the register frame pads below lg only.
    const unconditional = src.match(/["\s]pb-\[var\(--bb-consent-h,0px\)\][^"]*"/g) || [];
    expect(unconditional).toHaveLength(1);
    expect(unconditional[0]).toContain("lg:min-h-[calc(100dvh+var(--bb-consent-h,0px))]");
  });

  // Push 8 review: the frame's growth makes the page scroll while the banner
  // is up and stop once it is answered. Where a scrollbar takes room
  // (Windows' classic ones) that nudged the centred form half a scrollbar
  // sideways — a jump too. From lg the page keeps the gutter while a lone
  // column is on screen; beside the register panel nothing grows or changes.
  it("a lone column keeps the scrollbar gutter from lg, so the growth cannot nudge the form sideways", () => {
    expect(frame({}).hasAttribute("data-auth-grow")).toBe(true);
    expect(frame({ aside: <aside>panel</aside> }).hasAttribute("data-auth-grow")).toBe(false);
    const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*html:has\(\[data-auth-grow\]\) \{\s*scrollbar-gutter: stable;/);
  });

  it("/register gives the frame its panel (so the lg rule is the one it gets)", () => {
    const src = fs.readFileSync(path.join(SRC, "pages/RegisterPage.jsx"), "utf8");
    expect(src).toMatch(/<AuthShell aside=\{aside\}/);
    expect(src).toMatch(/<aside className="hidden lg:flex lg:w-\[46%\]/);
  });

  it("the banner's md+ geometry the 1288 px rule rests on is unchanged (left 24 px, 420 px wide)", () => {
    const src = fs.readFileSync(path.join(SRC, "components/CookieConsent.jsx"), "utf8");
    // landing fix round (22 Oct): a page may ask for the right side (data-bb-consent-side="right", the v6 landing only);
    // every other page, the auth pages included, keeps the card 24 px from the left
    expect(src).toContain('const side = wide && right ? "md:right-6" : "md:left-6";');
    expect(src).toContain("${side} md:w-[420px]");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "__tests__" ? [] : walk(path.join(d, e.name))) : /\.jsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
    const code = (f) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const askers = walk(SRC).filter((f) => /\sdata-bb-consent-side="right"/.test(code(f))).map((f) => path.relative(SRC, f));
    expect(askers).toEqual([path.join("pages", "LandingV6Page.jsx")]);
    expect(src).toContain("bottom = wide ? (clear > 0 ? clear + 16 : 24) : clear");
  });
});
