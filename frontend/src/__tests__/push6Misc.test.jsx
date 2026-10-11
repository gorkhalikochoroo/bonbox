/**
 * Push 6 — the small pieces: the price table carries the plan to /register,
 * Profile → Slet konto says how to get a password (LEG-14 hint), and the
 * three existing keys edited in place say what is true.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return { useLanguage: () => ({ lang: "da", t: (k, fb) => DA[k] ?? (typeof fb === "string" ? fb : k) }) };
});
vi.mock("../hooks/useFounderRateStatus", () => ({
  default: () => ({ status: { max_slots: 100, available: 100, claimed: 0 }, valid: true }),
}));

const PricingV2 = (await import("../components/landing/v2/PricingV2")).default;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
afterEach(cleanup);

describe("the price table carries the plan (PQ-17, B6)", () => {
  it("Starter → /register?plan=starter, Pro → /register?plan=pro, Free → /register", () => {
    const { container } = render(<MemoryRouter><PricingV2 /></MemoryRouter>);
    const hrefs = [...container.querySelectorAll('a[href^="/register"]')].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/register", "/register?plan=starter", "/register?plan=pro"]);
  });
});

describe("Profile → Slet konto: no password yet (LEG-14 hint)", () => {
  const src = fs.readFileSync(path.join(SRC, "pages/ProfilePage.jsx"), "utf8");
  it("the hint and the link sit under the password field, the link to /forgot-password with the account's address", () => {
    const pw = src.indexOf("value={deletePassword}");
    const hint = src.indexOf('t("suDeleteNoPwHint")');
    expect(pw).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(pw);
    expect(src.slice(hint, hint + 400)).toContain('to="/forgot-password"');
    expect(src.slice(hint, hint + 400)).toContain("state={{ email: user?.email }}");
    expect(src.slice(hint, hint + 600)).toContain('t("suDeleteNoPwLink")');
  });
  it("Danish and English text", () => {
    expect(da.suDeleteNoPwHint).toBe("Oprettede du kontoen med Google, Apple eller et login-link? Så har du ingen adgangskode endnu — lav en først, og kom så tilbage hertil.");
    expect(en.suDeleteNoPwLink).toBe("Create a password");
  });
});

describe("existing keys edited in place say what is true", () => {
  it("magicLinkSent / magicLinkSentDetail: the link goes to any address and creates the account", () => {
    expect(da.magicLinkSent).toBe("Tjek din e-mail");
    expect(en.magicLinkSent).toBe("Check your email");
    expect(da.magicLinkSentDetail).toContain("Har du ingen konto endnu, opretter linket en til dig.");
    expect(en.magicLinkSentDetail).toContain("If you don't have an account yet, the link creates one for you.");
    for (const d of [da, en]) expect(d.magicLinkSentDetail).not.toMatch(/^(Hvis|If) \{email\} (er registreret|is registered)/);
  });
  it("onbStep1Card1Body: a photo, and we read the numbers (kasserapport stays Danish in English)", () => {
    expect(da.onbStep1Card1Body).toBe("Tag et billede af kasserapporten — så læser vi tallene.");
    expect(en.onbStep1Card1Body).toBe("Take a photo of your kasserapport — we read the numbers.");
  });
});
