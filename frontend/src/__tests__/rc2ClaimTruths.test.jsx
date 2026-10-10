/**
 * R-c round 2 — P0-2 step 1 and three claim truths (round 1 review nits).
 *
 *  4. The landing footer's "Databehandleraftale" link opened /privacy — the
 *     privacy policy, not a data processing agreement. It is gone until the
 *     real DPA ships; nothing stands in its place.
 *  5a. The login page's cold-start line says only what the client knows: no
 *     answer from BonBox (a dead phone line looks the same as a sleeping
 *     server), and it is retrying — never "the server is waking up".
 *  5b. The Free card's export line says what the code does: a period export
 *     of up to 7 days at a time (the plan cap, billing.daily_close_export_days)
 *     — and each day's kasserapport PDF has no such cap.
 *  5c. A copy of figures the form let go of ("Hent {dag}s salg") MAY be
 *     stored (its save got no answer — it may have landed): said as unknown,
 *     never "were not saved".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import FooterV2 from "../components/landing/v2/FooterV2";
import { LanguageProvider } from "../hooks/useLanguage";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const sourceFiles = (dir) => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = path.join(dir, e.name);
  if (e.isDirectory()) return ["i18n", "__tests__", "test"].includes(e.name) ? [] : sourceFiles(rel);
  return /\.(jsx?|tsx?)$/.test(e.name) ? [rel] : [];
});

describe("4. no \"Databehandleraftale\" link until the DPA ships", () => {
  for (const lang of ["da", "en", "tr"]) {
    it(`the landing footer (${lang}) links Handelsbetingelser and Privatlivspolitik only — nothing labelled Databehandleraftale`, async () => {
      localStorage.setItem("lang", lang);
      render(<LanguageProvider><MemoryRouter><FooterV2 /></MemoryRouter></LanguageProvider>);
      const links = await screen.findAllByRole("link");
      expect(links.some((a) => /databehandler/i.test(a.textContent))).toBe(false);
      const legal = links.filter((a) => ["/terms", "/privacy"].includes(a.getAttribute("href")));
      expect(legal.map((a) => a.getAttribute("href")).sort()).toEqual(["/privacy", "/terms"]);
      expect(document.body.textContent).not.toMatch(/Databehandleraftale/);
    });
  }
  it("no page or component renders the DPA label anywhere (swept)", () => {
    // (Code that renders it: the key, a label, or JSX text — not a comment about it.)
    const users = sourceFiles(".").filter((f) => /landingV2\.footer\.dpa|label:\s*["']Databehandleraftale|>\s*Databehandleraftale\s*</.test(read(f)));
    expect(users).toEqual([]);
  });
});

describe("5. claims say only what is true", () => {
  it("5a the cold-start line: no answer, retrying — never a server waking up (da, en, tr, and the inline fallback)", () => {
    expect(da.loginWarmingUp).toBe("Kan ikke nå BonBox lige nu — prøver igen.");
    expect(en.loginWarmingUp).toBe("Can't reach BonBox right now — retrying.");
    expect(tr.loginWarmingUp).toBe("BonBox'a şu anda ulaşılamıyor — yeniden deneniyor.");
    const login = read("pages/LoginPage.jsx");
    expect(login).toContain(`t("loginWarmingUp", "Can't reach BonBox right now — retrying.")`);
    for (const s of [da.loginWarmingUp, en.loginWarmingUp, tr.loginWarmingUp]) expect(s).not.toMatch(/vågner|waking up|uyanıyor/i);
  });

  it("5b the Free card: a period export of up to 7 days at a time, each day's kasserapport PDF with no limit (da, en, tr, and the inline fallback)", () => {
    expect(da["landingV2.pricing.free.f6"]).toBe("1 bruger, 1 afdeling, op til 3 medarbejdere på vagtplanen, periodeeksport op til 7 dage ad gangen — hver dags kasserapport som PDF uden grænse");
    expect(en["landingV2.pricing.free.f6"]).toBe("1 user, 1 location, up to 3 staff on the rota, period export up to 7 days at a time — each day's kasserapport as a PDF, no limit");
    expect(tr["landingV2.pricing.free.f6"]).toBe("1 kullanıcı, 1 şube, vardiya planında en fazla 3 çalışan, bir seferde en fazla 7 günlük dönem dışa aktarımı — her günün kasserapport'u PDF olarak, sınırsız");
    expect(read("components/landing/v2/PricingV2.jsx")).toContain(`"${en["landingV2.pricing.free.f6"]}"`);
    for (const s of [da["landingV2.pricing.free.f6"], en["landingV2.pricing.free.f6"]]) expect(s).not.toMatch(/eksporthistorik|export history/);
    // (R-c round 2 fix-up — the Turkish line names the rota's staff cap too, as da and en do.)
    expect(tr["landingV2.pricing.free.f6"]).toContain("vardiya planında en fazla 3 çalışan");
    // (The cap it names is the plan's: Free exports a period of at most 7 days.)
    const billing = fs.readFileSync(path.join(SRC, "../../backend/app/services/billing.py"), "utf8");
    expect(billing).toMatch(/"daily_close_export_days": 7,/);
  });

  it("5c a let-go copy may be stored — said as unknown, never \"not saved\" (da, en, and the inline fallback)", () => {
    expect(da.dcQueueErrLetGo).toBe("Disse tal er måske ikke gemt: de er fra før, du hentede en anden dags salg. Gem dem som dagens kladde (det erstatter det, der er gemt nu), eller fjern kopien.");
    expect(en.dcQueueErrLetGo).toBe("These figures may not be saved: they are from before you fetched another day's sales. Save them as the day's draft (it replaces what is saved now), or remove this copy.");
    expect(read("pages/DailyClosePage.jsx")).toContain(`t("dcQueueErrLetGo", "${en.dcQueueErrLetGo}")`);
    expect(da.dcQueueErrLetGo).not.toMatch(/blev ikke gemt/);
    expect(en.dcQueueErrLetGo).not.toMatch(/were not saved/);
  });
});
