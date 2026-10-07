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
 * WHAT CHANGED: the token-validation catch now CLASSIFIES. A 404/410 is the
 * dead-link screen in catalogue copy (and forgets the saved token); anything
 * else is "could not reach the server" — the link is kept and a retry is
 * offered (second describe block). The backend is untouched.
 *
 * These tests mount the REAL page against a rejecting portalApi, so they pin
 * the whole path — axios error → errText → classification → rendered screen —
 * rather than a re-implementation of it.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const defaultGet = (url) => {
  if (url === `/portal/${TOK}`) return Promise.reject(rejection);
  return Promise.resolve({ data: [] });
};
const get = vi.fn(defaultGet);

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
    get.mockImplementation(defaultGet);
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

  it("a dead link (404) forgets the saved token so the app stops booting into it", async () => {
    localStorage.setItem("bonbox_portal_token", TOK);
    await mountDeadLink("da");
    expect(localStorage.getItem("bonbox_portal_token")).toBeNull();
  });
});

/**
 * NOT a dead link: offline, a timeout, a 429, a 5xx while the backend wakes.
 *
 * THE BUG (scheduler round 1, blocking): the validation catch treated every
 * failure as a dead link — "Link virker ikke" over axios's English
 * "Network Error", no retry, AND it erased bonbox_portal_token, so the
 * Scheduler app booted to /join next launch. Join codes burn on use, so the
 * staffer then needed a new code from their manager for a link that was fine.
 */
describe("staff portal — could not reach the server", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("bonbox_portal_token", TOK);
    get.mockClear();
    get.mockImplementation(defaultGet);
  });

  async function mountOffline(lang = "da") {
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
    await waitFor(() => expect(screen.getByRole("heading")).toBeInTheDocument());
    return document.body.textContent;
  }

  it.each([
    ["no response (offline)", () => new Error("Network Error")],
    ["a 502", () => axiosError(502, "Bad Gateway")],
    ["a 503 with a server sentence", () => axiosError(503, "Scheduled maintenance until 14:00")],
    ["a 429", () => axiosError(429, "Too many requests")],
  ])("%s keeps the saved link and offers a retry", async (_label, make) => {
    rejection = make();
    const text = await mountOffline("da");
    expect(text).toContain("Ingen forbindelse");
    expect(screen.getByRole("button", { name: "Prøv igen" })).toBeInTheDocument();
    // Never the dead-link screen, never raw English.
    expect(text).not.toContain("Link virker ikke");
    expect(text).not.toContain("Network Error");
    expect(text).not.toContain("Scheduled maintenance");
    // The regression itself: the link survives.
    expect(localStorage.getItem("bonbox_portal_token")).toBe(TOK);
  });

  it("'Prøv igen' re-validates, and a good answer opens the portal", async () => {
    rejection = new Error("Network Error");
    await mountOffline("da");
    const calls = get.mock.calls.filter(([u]) => u === `/portal/${TOK}`).length;
    // Back online: the next validation succeeds.
    rejection = null;
    get.mockImplementation((url) => {
      if (url === `/portal/${TOK}`) {
        if (rejection) return Promise.reject(rejection);
        return Promise.resolve({ data: { has_pin: false, staff_name: "Ali", restaurant_name: "Sekuwa" } });
      }
      if (url.includes("/notifications")) return Promise.resolve({ data: { notifications: [] } });
      if (url.includes("/schedule")) return Promise.resolve({ data: { shifts: [] } });
      return Promise.resolve({ data: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: "Prøv igen" }));
    await waitFor(() =>
      expect(get.mock.calls.filter(([u]) => u === `/portal/${TOK}`).length).toBeGreaterThan(calls),
    );
    await waitFor(() => expect(document.body.textContent).not.toContain("Ingen forbindelse"));
    expect(localStorage.getItem("bonbox_portal_token")).toBe(TOK);
  });

  it("retries by itself when the browser comes back online", async () => {
    rejection = new Error("Network Error");
    await mountOffline("da");
    const before = get.mock.calls.filter(([u]) => u === `/portal/${TOK}`).length;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() =>
      expect(get.mock.calls.filter(([u]) => u === `/portal/${TOK}`).length).toBeGreaterThan(before),
    );
  });

  it("en: speaks English on the same screen", async () => {
    rejection = new Error("Network Error");
    const text = await mountOffline("en");
    expect(text).toContain("No connection");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
