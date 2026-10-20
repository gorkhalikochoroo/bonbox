/**
 * Profile crash (20 Oct 2026): a saved CVR flag ("no_vat") made the whole
 * Profile page fail with "e.map is not a function". The lookup returns flags
 * as an array, the saved profile stores them pipe-joined, and BusinessLookup
 * seeded its first render from the saved profile.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })), put: vi.fn(() => Promise.resolve({ data: {} })), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k, fb) => (typeof fb === "string" ? fb : k), lang: "da", setLang: () => {}, LANGUAGES: [] }),
  LanguageProvider: ({ children }) => children,
}));

import BusinessLookup, { toFlagList } from "../components/BusinessLookup";

describe("BusinessLookup with a saved CVR status flag", () => {
  it("renders instead of crashing when the saved profile carries a pipe-joined flag", () => {
    let view;
    expect(() => {
      view = render(<BusinessLookup initialProfile={{ country: "DK", company_name: "Café Test", status_flags: "no_vat" }} onSave={() => {}} />);
    }).not.toThrow();
    expect(view.container.firstChild).not.toBeNull();
  });

  it("still renders with several saved flags and with an array", () => {
    expect(() =>
      render(<BusinessLookup initialProfile={{ country: "DK", company_name: "Café Test", status_flags: "no_vat|protected" }} />),
    ).not.toThrow();
    expect(() =>
      render(<BusinessLookup initialProfile={{ country: "DK", company_name: "Café Test", status_flags: ["no_vat"] }} />),
    ).not.toThrow();
  });
});

describe("toFlagList", () => {
  it("reads both the lookup's array and the saved pipe-joined string", () => {
    expect(toFlagList(["no_vat", "protected"])).toEqual(["no_vat", "protected"]);
    expect(toFlagList("no_vat|protected")).toEqual(["no_vat", "protected"]);
    expect(toFlagList("no_vat")).toEqual(["no_vat"]);
    expect(toFlagList("")).toEqual([]);
    expect(toFlagList(null)).toEqual([]);
    expect(toFlagList(undefined)).toEqual([]);
    expect(toFlagList({})).toEqual([]);
    expect(toFlagList(["", null, "konkurs"])).toEqual(["konkurs"]);
  });
});
