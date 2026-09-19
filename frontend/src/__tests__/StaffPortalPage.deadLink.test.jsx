/**
 * The dead-link screen must speak the staffer's language.
 *
 * THE BUG (shipped, found by probing the live deploy):
 *   PortalError rendered `{message || t("portalErrorBody")}` — so any string
 *   the server sent WON over the catalogue copy. GET /portal/{token} answers a
 *   burned, deactivated or expired link with 404 detail "Link not found or
 *   inactive" (staff_portal.py), errText passes plain-string details straight
 *   through, and the result was a raw English sentence rendered directly under
 *   the Danish heading "Link virker ikke".
 *
 *   That is the ONE screen a staffer sees when their link stops working, and
 *   this repo has history here — share-links used to re-serve already-redeemed
 *   codes, so reconnects 404'd. The mixed-language screen was what those people
 *   hit, and the English string tells them nothing they can act on.
 *
 * WHAT CHANGED: the token-validation catch now CLASSIFIES (expected 404 vs
 * anything else) and the view renders catalogue copy for the expected case,
 * keeping the server's own words only where they are the only clue. The
 * backend and the token semantics are untouched.
 *
 * These tests mount the REAL page against a rejecting portalApi, so they pin
 * the whole path — axios error → errText → classification → rendered screen —
 * rather than a re-implementation of it.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "deadtok";

/** The server's raw English, exactly as staff_portal.py raises it. */
const SERVER_404_DETAIL = "Link not found or inactive";

/** Swapped per test: what GET /portal/{token} rejects with. */
let rejection = null;

const axiosError = (status, detail) => {
  const err = new Error("Request failed");
  err.response = { status, data: { detail } };
  return err;
};

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) return Promise.reject(rejection);
  return Promise.resolve({ data: [] });
});

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: vi.fn() }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

async function mountDeadLink(lang) {
  localStorage.setItem("lang", lang);
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
        <Routes>
          <Route path="/portal/:token" element={<StaffPortalPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );
  // The heading is catalogue-driven in both languages and was never the bug —
  // waiting on it proves we are on the error screen before reading the body.
  await waitFor(() => expect(screen.getByRole("heading")).toBeInTheDocument());
  return document.body.textContent;
}

describe("staff portal — dead or expired link", () => {
  beforeEach(() => {
    localStorage.clear();
    rejection = axiosError(404, SERVER_404_DETAIL);
  });

  it("da: shows the Danish body, never the server's English", async () => {
    const text = await mountDeadLink("da");
    expect(text).toContain("Link virker ikke");
    expect(text).toContain("Dette link er måske udløbet eller deaktiveret");
    // The regression itself: one screen, two languages.
    expect(text).not.toContain(SERVER_404_DETAIL);
  });

  it("en: shows the English catalogue body, not the raw server detail", async () => {
    const text = await mountDeadLink("en");
    expect(text).toContain("Link not working");
    expect(text).toContain("This link may have expired or been deactivated");
    // Close to the server string but not it — the catalogue copy is the one
    // that tells the reader what to DO about it.
    expect(text).not.toContain(SERVER_404_DETAIL);
  });

  it("da: the other 404 — an erased employee — is the same screen", async () => {
    // _get_staff_from_token raises 404 "Staff member not found" once the owner
    // has removed the employee. Same status, same experience for the staffer.
    rejection = axiosError(404, "Staff member not found");
    const text = await mountDeadLink("da");
    expect(text).toContain("Dette link er måske udløbet eller deaktiveret");
    expect(text).not.toContain("Staff member not found");
  });

  it("keeps the server's words for a status we did NOT anticipate", async () => {
    // The point of classifying rather than blanket-replacing: on an unexpected
    // failure the server's detail is the only diagnostic anyone gets, so it
    // must still reach the screen.
    rejection = axiosError(503, "Scheduled maintenance until 14:00");
    const text = await mountDeadLink("da");
    expect(text).toContain("Scheduled maintenance until 14:00");
  });

  it("falls back to catalogue copy when there is no server detail at all", async () => {
    // Network failure: no response object, so errText lands on err.message.
    // Whatever that is, the screen must still render a real sentence.
    rejection = new Error("Network Error");
    const text = await mountDeadLink("da");
    expect(text).toContain("Link virker ikke");
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
