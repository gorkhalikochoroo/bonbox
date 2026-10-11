/**
 * /contact is the App Store Support URL for both iPhone apps (Manoj, 11 Oct
 * 2026). Opened signed out it must show:
 *   • contact@bonbox.dk (the address the Terms and /privacy give), not Gmail;
 *   • the registered name from the Terms: DukaanAI v/Manoz Chaudhary, CVR
 *     46417321 (read from TermsPage here, so the two cannot drift apart);
 *   • no SDU / thesis framing, no "tøjbutikker", no "prisvenlig"/"affordable";
 *   • no link to /feedback (it needs a login) — only a signed-in visitor gets
 *     it; everyone else writes to the e-mail address.
 * And the back arrow is never a dead end on a direct visit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";

let langCode = "da";
const dict = () => (langCode === "da" ? da : en);
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: langCode,
    setLang: () => {},
    LANGUAGES: [],
    t: (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      let s = dict()[k] ?? en[k] ?? (typeof fb === "string" ? fb : k);
      if (v && typeof s === "string") s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
      return s;
    },
  }),
  LanguageProvider: ({ children }) => children,
}));

let authUser = null;
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authUser }),
  AuthProvider: ({ children }) => children,
}));

const ContactPage = (await import("../pages/ContactPage")).default;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TERMS = fs.readFileSync(path.join(SRC, "pages/TermsPage.jsx"), "utf8");

// What /contact must never say again.
const FORBIDDEN = /gmail|SDU|Syddansk|Southern Denmark|thesis|speciale|Master|kandidat|Data-Driven|tøjbutik|clothing|prisvenlig|affordable|billig|Manoj\b/i;

afterEach(() => {
  cleanup();
  langCode = "da";
  authUser = null;
});

const renderContact = () =>
  render(
    <MemoryRouter initialEntries={["/contact"]}>
      <Routes>
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/" element={<p>start page</p>} />
        <Route path="/feedback" element={<p>feedback page</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe("/contact signed out (the App Store Support URL)", () => {
  for (const lang of ["da", "en"]) {
    it(`${lang}: contact@bonbox.dk, the CVR name, no thesis / tøjbutikker / Gmail, no login-only link`, () => {
      langCode = lang;
      renderContact();
      const text = document.body.textContent;

      const mail = screen.getByTestId("contact-email");
      expect(mail.textContent).toBe("contact@bonbox.dk");
      expect(mail.getAttribute("href")).toBe("mailto:contact@bonbox.dk");

      const provider = screen.getByTestId("contact-provider").textContent;
      expect(provider).toBe(lang === "da"
        ? "BonBox leveres af DukaanAI v/Manoz Chaudhary, CVR 46417321."
        : "BonBox is provided by DukaanAI v/Manoz Chaudhary, CVR 46417321.");
      expect(screen.getByRole("link", { name: "46417321" }).getAttribute("href"))
        .toBe("https://datacvr.virk.dk/enhed/virksomhed/46417321");

      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toContain("Copenhagen");
      expect(text).not.toContain("København");
      expect(screen.queryByTestId("contact-feedback")).toBeNull();
      expect(document.querySelector('a[href="/feedback"]')).toBeNull();
      expect([...document.querySelectorAll("a")].every((a) => !/gmail/i.test(a.getAttribute("href") || ""))).toBe(true);
    });
  }

  it("the name and CVR are the ones the Terms give (§ 1 and § 15)", () => {
    expect(TERMS).toContain("<strong>DukaanAI v/Manoz Chaudhary</strong>, CVR 46417321");
    expect(TERMS).toContain("mailto:contact@bonbox.dk");
  });

  it("the back arrow goes to the start page on a direct visit (no history to go back to)", () => {
    renderContact();
    fireEvent.click(screen.getByRole("button", { name: "Tilbage" }));
    expect(screen.getByText("start page")).toBeInTheDocument();
  });
});

describe("/contact signed in", () => {
  it("the Feedback page link is there, and it works", () => {
    authUser = { id: "o1", role: "owner" };
    renderContact();
    expect(screen.getByTestId("contact-feedback")).toBeInTheDocument();
    fireEvent.click(document.querySelector('a[href="/feedback"]'));
    expect(screen.getByText("feedback page")).toBeInTheDocument();
  });
});

describe("the dictionaries (en / da / tr)", () => {
  it("the About text is real Danish and English, and names no thesis, clothing shops or cheap prices", () => {
    expect(da.contactAboutBody).toBe("BonBox er lavet til små virksomheder i Danmark – fx caféer, barer og restauranter – og samler kasserapport, reservationer, vagtplan, timer, lager og økonomi ét sted.");
    expect(en.contactAboutBody).toBe("BonBox is made for small businesses in Denmark, such as cafés, bars and restaurants, and brings the daily close (kasserapport), reservations, the staff schedule, hours, stock and money together in one place.");
    for (const d of [en, da, tr]) {
      expect(d.contactAboutBody).not.toMatch(FORBIDDEN);
      expect(d.contactProvidedBy).toContain("{name}");
      expect(d.contactProvidedBy).toContain("{cvr}");
    }
    // The unverified "Based in Copenhagen" line is gone from every table.
    for (const d of [en, da, tr]) expect(d.contactBasedIn).toBeUndefined();
  });
});
