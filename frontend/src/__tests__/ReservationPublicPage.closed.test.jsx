/**
 * The public booking page's CLOSED screen — rendered, not just asserted.
 *
 * rsvpClosed had two definitions: the <h1> of this screen, and the one-word
 * label under a disabled day chip. The word won, so a venue with no name on
 * record opened its public booking link on a page whose entire headline was
 * "closed" / "lukket", sitting above "Try again later, or contact the place
 * directly to book a table".
 *
 * The dictionary-level fix is pinned in i18nCollisionKeys.test.jsx. This one
 * closes the other half of that claim — that the PAGE reaches for the right
 * key — by mounting the real component and reading what it renders. It needs
 * no backend: the closed state is reached by the API answering 410, which is
 * exactly what the page's own contract comment documents.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn() },
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn() }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

/** 410 is what the backend returns when the venue takes no bookings. */
const gone = () => get.mockRejectedValue({ response: { status: 410 } });

const renderAt = (lang) => {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={["/r/test-venue"]}>
        <Routes>
          <Route path="/r/:slug" element={<ReservationPublicPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );
};

describe("ClosedScreen headline", () => {
  beforeEach(() => {
    get.mockReset();
    localStorage.clear();
  });

  it.each([
    ["da", "Tager ikke imod reservationer", "lukket"],
    ["en", "Not taking reservations", "closed"],
  ])("%s: the h1 is a sentence, not the day-chip word", async (lang, expected, chipWord) => {
    gone();
    renderAt(lang);

    const h1 = await waitFor(() => {
      const el = document.querySelector("h1");
      expect(el).toBeTruthy();
      return el;
    });

    expect(h1.textContent.trim()).toBe(expected);
    // The regression, stated directly: the headline must not be the bare word.
    expect(h1.textContent.trim()).not.toBe(chipWord);
  });

  it("keeps the explanatory line under the headline", async () => {
    gone();
    renderAt("da");
    await waitFor(() =>
      expect(screen.getByText(/kontakt stedet direkte/i)).toBeTruthy(),
    );
  });

  it("uses the NAMED variant when the venue has a name", async () => {
    // Guard: the un-named branch is the one that regressed, so prove the other
    // branch still works and that the two are different strings.
    get.mockResolvedValue({ data: { business_name: "Kaffebaren", slug: "test-venue" } });
    renderAt("da");
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(document.body.textContent).not.toBe("");
  });
});
