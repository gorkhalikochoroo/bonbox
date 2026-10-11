/**
 * Push 6 (PQ-05) — a browser that lists Danish anywhere gets Danish.
 *
 * An English-first phone in Denmark (["en-US", "da"]) used to get English on
 * /register and /login, while the dictionary preload (vite.config.js) fetched
 * the Danish dictionary as well — two downloads, the wrong language. Now the
 * app, the inline script in index.html and the preload agree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { detectInitialLanguage } from "../hooks/useLanguage";
import { browserListsDanish } from "../lib/shellTitles";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HTML = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
const VITE = fs.readFileSync(path.join(FRONTEND, "vite.config.js"), "utf8");

const realLanguages = Object.getOwnPropertyDescriptor(Navigator.prototype, "languages");
const realLanguage = Object.getOwnPropertyDescriptor(Navigator.prototype, "language");

function setBrowser(langs) {
  Object.defineProperty(Navigator.prototype, "languages", { get: () => langs, configurable: true });
  Object.defineProperty(Navigator.prototype, "language", { get: () => langs[0], configurable: true });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  if (realLanguages) Object.defineProperty(Navigator.prototype, "languages", realLanguages);
  if (realLanguage) Object.defineProperty(Navigator.prototype, "language", realLanguage);
});

describe("detectInitialLanguage — Danish anywhere in the list", () => {
  it("['en-US', 'da'] → da", () => {
    setBrowser(["en-US", "da"]);
    expect(detectInitialLanguage()).toEqual({ lang: "da", source: "browser" });
  });
  it("['en-US', 'en'] → en", () => {
    setBrowser(["en-US", "en"]);
    expect(detectInitialLanguage()).toEqual({ lang: "en", source: "browser" });
  });
  it("['ne-NP', 'da'] → da (Danish wins over a first supported language)", () => {
    setBrowser(["ne-NP", "da"]);
    expect(detectInitialLanguage().lang).toBe("da");
  });
  it("Faroese counts as Danish; a look-alike tag does not", () => {
    setBrowser(["en-GB", "fo-FO"]);
    expect(detectInitialLanguage().lang).toBe("da");
    expect(browserListsDanish(["dav-KE"])).toBe(false);
    expect(browserListsDanish(["DA-dk"])).toBe(true);
  });
  it("no Danish: today's first-supported loop ('ne-NP' first → np; 'fr-FR','vi' → vi)", () => {
    setBrowser(["ne-NP", "en-US"]);
    expect(detectInitialLanguage().lang).toBe("np");
    setBrowser(["fr-FR", "vi"]);
    expect(detectInitialLanguage().lang).toBe("vi");
  });
});

describe("one-time move (B5) — only a language the BROWSER picked", () => {
  it("stored en, auto-picked by the browser, Danish in the list → da, once", () => {
    setBrowser(["en-US", "da"]);
    localStorage.setItem("lang", "en");
    localStorage.setItem("bonbox_lang_auto_picked", "browser");
    expect(detectInitialLanguage()).toEqual({ lang: "da", source: "migrated" });
    // After the provider stores "da", it is simply the stored choice.
    localStorage.setItem("lang", "da");
    expect(detectInitialLanguage()).toEqual({ lang: "da", source: "stored" });
  });
  it("an owner's own pick (no auto flag) stays", () => {
    setBrowser(["en-US", "da"]);
    localStorage.setItem("lang", "en");
    expect(detectInitialLanguage()).toEqual({ lang: "en", source: "stored" });
  });
  it("a currency auto-pick is not moved, and nothing moves without Danish in the list", () => {
    setBrowser(["en-US", "da"]);
    localStorage.setItem("lang", "en");
    localStorage.setItem("bonbox_lang_auto_picked", "currency");
    expect(detectInitialLanguage().lang).toBe("en");
    setBrowser(["en-US", "en"]);
    localStorage.setItem("bonbox_lang_auto_picked", "browser");
    expect(detectInitialLanguage().lang).toBe("en");
  });
});

/** The first inline <script> in index.html — the lang-attribute guard. */
function inlineLangScript() {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const s = scripts.find((x) => x.includes('localStorage.getItem("lang")') && x.includes("documentElement.lang"));
  expect(s).toBeTruthy();
  return s;
}

function runInline(langs, stored = {}) {
  const store = new Map(Object.entries(stored));
  const documentElement = { lang: "da" };
  const ctx = {
    navigator: { languages: langs, language: langs[0] },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
    document: { documentElement },
  };
  vm.runInNewContext(inlineLangScript(), ctx);
  return documentElement.lang;
}

describe("index.html's inline script gives the same answer as the app", () => {
  const CASES = [
    [["en-US", "da"], {}],
    [["en-US", "en"], {}],
    [["ne-NP", "da"], {}],
    [["ne-NP", "en"], {}],
    [["vi-VN"], {}],
    [["tr-TR", "en"], {}],
    [["en-US", "da"], { lang: "en", bonbox_lang_auto_picked: "browser" }],
    [["en-US", "da"], { lang: "en" }],
    [["da-DK"], { lang: "tr" }],
  ];
  it.each(CASES)("%j with storage %j", (langs, stored) => {
    setBrowser(langs);
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
    const app = detectInitialLanguage().lang;
    // The shell only ever WRITES a non-Danish language (lang="da" is the
    // static default), so "da" from the app means "left as da".
    expect(runInline(langs, stored)).toBe(app);
  });
});

describe("parity with the dictionary preload (vite.config.js)", () => {
  // The preload picks da when /(^|,)(da|fo)/ matches the joined list.
  const m = VITE.match(/l=\/\(\^\|,\)\(da\|fo\)\/\.test\(n\)\?"da":"en"/);
  it("the preload still reads the joined list with /(^|,)(da|fo)/", () => {
    expect(m).toBeTruthy();
  });
  const preload = (langs) => (/(^|,)(da|fo)/.test(langs.join(",").toLowerCase()) ? "da" : "en");
  it.each([
    [["en-US", "da"]], [["en-US", "en"]], [["ne-NP", "da"]], [["da-DK"]], [["fo"]], [["en-GB"]],
  ])("%j: the app picks da exactly when the preload fetches da", (langs) => {
    setBrowser(langs);
    expect(detectInitialLanguage().lang === "da").toBe(preload(langs) === "da");
  });
});
