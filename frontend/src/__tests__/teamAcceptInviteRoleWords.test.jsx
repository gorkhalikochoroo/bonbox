/**
 * The team-invite page names the role in the page's language (Push 8).
 *
 * The raw role id was printed into the sentence, capitalised by CSS: a Danish
 * invitee read "Du er blevet inviteret som Manager". The role now comes from
 * the dictionary (da + en), a viewer's seat reads as access ("inviteret med
 * læseadgang"), and an id with no word reads "teammedlem", never the id.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ setUser: vi.fn() }) }));

let dict = da;
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb) => (dict[k] ?? (typeof fb === "string" ? fb : k)),
    lang: dict === da ? "da" : "en",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));

const TeamAcceptInvitePage = (await import("../pages/TeamAcceptInvitePage")).default;
const TOKEN = "t".repeat(43);

async function invitedAs(role, lang = da, query = "") {
  dict = lang;
  get.mockResolvedValue({ data: { email: "anna@cafe.dk", role, owner_business_name: "Bon Bakery" } });
  render(
    <MemoryRouter initialEntries={[`/accept-invite/team/${TOKEN}${query}`]}>
      <Routes>
        <Route path="/accept-invite/team/:token" element={<TeamAcceptInvitePage />} />
      </Routes>
    </MemoryRouter>,
  );
  const lead = await screen.findByText((_, el) => el?.tagName === "P"
    && /inviteret|invited/.test(el.textContent || "") && !!el.querySelector("span"));
  return lead.textContent.replace(/\s+/g, " ").trim();
}

afterEach(() => vi.clearAllMocks());

describe("TeamAcceptInvitePage — the role in the sentence", () => {
  it("Danish: manager", async () => {
    expect(await invitedAs("manager")).toMatch(/^Du er blevet inviteret som bestyrer\./);
  });
  it("Danish: cashier", async () => {
    expect(await invitedAs("cashier")).toMatch(/^Du er blevet inviteret som kasserer\./);
  });
  it("Danish: a viewer is invited WITH read access", async () => {
    expect(await invitedAs("viewer")).toMatch(/^Du er blevet inviteret med læseadgang\./);
  });
  it("never prints the raw id (the CSS capitalised it to 'Manager')", async () => {
    const text = await invitedAs("manager");
    expect(text).not.toMatch(/manager/i);
    expect(document.querySelector("p span.capitalize")).toBeNull();
  });
  it("an id with no word reads team member, in the page's language", async () => {
    expect(await invitedAs("accountant")).toMatch(/^Du er blevet inviteret som teammedlem\./);
  });
  it("English: manager", async () => {
    expect(await invitedAs("manager", en)).toMatch(/^You've been invited as a manager\./);
  });
  it("English: viewer", async () => {
    expect(await invitedAs("viewer", en)).toMatch(/^You've been invited with view-only access\./);
  });
});
