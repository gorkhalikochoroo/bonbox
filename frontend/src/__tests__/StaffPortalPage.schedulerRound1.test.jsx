/**
 * BonBox Scheduler — round 1 blocking fixes, pinned on the REAL page.
 *
 *   • Frakobl asks first (C9): one tap used to forget the link, the PIN proof
 *     and push, and drop the staffer on /join — where their burned join code
 *     no longer works.
 *   • An open clock punch is a state, never "0 timer" (C3): the server now
 *     sends open punches apart from `entries`; the row says what it is.
 *   • The chat composer (C6/C11): 16px so iOS does not zoom on focus, and it
 *     rides on top of the keyboard instead of sitting under it.
 *   • The schedule hero never says "Ingen kommende vagt" before the schedule
 *     has answered, or when it failed (C10).
 *
 * Each test mounts StaffPortalPage against a mocked portalApi, so it pins the
 * whole path (fetch → state → rendered text), not a re-implementation of it.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokr1";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};

/** Swapped per test. */
let scheduleImpl = () => ok({ shifts: [] });
let hoursImpl = () => ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 0, entries: [] });
let kbLift = 0;

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return scheduleImpl();
  if (url.startsWith(`/portal/${TOK}/hours`)) return hoursImpl(url);
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  if (url.endsWith("/chat/threads")) {
    return ok({ threads: [{ thread_id: "th1", kind: "direct", title: "Testcafé", last_body: "Hej" }] });
  }
  if (url.includes("/chat/threads/th1")) return ok({ kind: "direct", messages: [] });
  return ok([]);
});

const unregister = vi.fn(() => Promise.resolve());

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => ok({})), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: (...a) => unregister(...a),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../hooks/useKeyboardLift", () => ({ useKeyboardLift: () => kbLift }));
vi.mock("../utils/haptics", () => ({ haptic: vi.fn() }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

async function mount(lang = "da") {
  localStorage.setItem("lang", lang);
  render(
    <LanguageProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
          <Routes>
            <Route path="/portal/:token" element={<StaffPortalPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
}

const navTo = (label) => {
  const nav = document.querySelector("nav");
  fireEvent.click(within(nav).getByText(label).closest("button"));
};

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  unregister.mockClear();
  kbLift = 0;
  scheduleImpl = () => ok({ shifts: [] });
  hoursImpl = () => ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 0, entries: [] });
});

describe("Frakobl denne telefon — asks before it disconnects", () => {
  it("cancel keeps the link, push and PIN proof; confirm disconnects", async () => {
    await mount("da");
    localStorage.setItem("bonbox_portal_token", TOK);
    localStorage.setItem("bonbox_pin_proof", "proof");
    fireEvent.click(screen.getByTitle("Rediger profil"));
    fireEvent.click(await screen.findByText("Frakobl denne telefon fra vagtplanen"));

    // The dialog, not the disconnect. (The profile sheet is a dialog too —
    // pick the confirm by its title.)
    const confirmDialog = async () =>
      (await screen.findByText("Frakoble denne telefon?")).closest('[role="dialog"]');
    const dialog = await confirmDialog();
    expect(within(dialog).getByText("Frakoble denne telefon?")).toBeInTheDocument();
    expect(unregister).not.toHaveBeenCalled();
    expect(localStorage.getItem("bonbox_portal_token")).toBe(TOK);

    fireEvent.click(within(dialog).getByRole("button", { name: "Annuller" }));
    await waitFor(() => expect(screen.queryByText("Frakoble denne telefon?")).toBeNull());
    expect(unregister).not.toHaveBeenCalled();
    expect(localStorage.getItem("bonbox_portal_token")).toBe(TOK);
    expect(localStorage.getItem("bonbox_pin_proof")).toBe("proof");

    // Second time, confirmed: now it really disconnects.
    fireEvent.click(screen.getByText("Frakobl denne telefon fra vagtplanen"));
    const again = await confirmDialog();
    fireEvent.click(within(again).getByRole("button", { name: "Frakobl" }));
    await waitFor(() => expect(unregister).toHaveBeenCalledWith(TOK));
    await waitFor(() => expect(localStorage.getItem("bonbox_portal_token")).toBeNull());
  });
});

describe("Timer — an open clock punch is a state, never 0 timer", () => {
  it("renders live and forgotten punches with words, outside the shift count", async () => {
    hoursImpl = () => ok({
      period_start: inDays(-10), period_end: inDays(10),
      total_hours: 7.5, hours_source: "logged",
      entries: [{ date: inDays(-1), start_time: "10:00", end_time: "17:30", total_hours: 7.5 }],
      open_punches: [
        { date: inDays(0), start_time: "16:58", state: "live" },
        { date: inDays(-3), start_time: "18:00", state: "forgotten" },
      ],
    });
    await mount("da");
    navTo("Timer");
    const rows = await screen.findAllByTestId("portal-open-punch");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Stemplet ind siden 16:58");
    expect(rows[1].textContent).toContain("Mangler udstempling — din leder retter den");
    for (const r of rows) {
      // No number of hours on an open punch — ever.
      expect(r.textContent).not.toMatch(/\b0\s*(t|timer)\b/);
    }
  });
});

describe("Chat composer — usable with the keyboard up", () => {
  async function openThread() {
    await mount("da");
    navTo("Beskeder");
    fireEvent.click(await screen.findByText("Testcafé", { selector: "button *" }));
    return screen.findByTestId("portal-chat-composer");
  }

  it("types at 16px so iOS does not zoom the page on focus", async () => {
    const composer = await openThread();
    const ta = composer.querySelector("textarea");
    expect(ta.style.fontSize || ta.style.font).toMatch(/16px/);
  });

  it("sits above the bottom nav at rest and on top of the keyboard when it opens", async () => {
    const composer = await openThread();
    expect(composer.style.bottom).toContain("3.5rem");
    kbLift = 300;
    // Any re-render picks up the hook's new value (the real hook re-renders
    // on the keyboard event itself).
    fireEvent.change(composer.querySelector("textarea"), { target: { value: "Hej" } });
    await waitFor(() => expect(screen.getByTestId("portal-chat-composer").style.bottom).toBe("300px"));
  });
});

describe("Schedule hero — never 'no shift' before the schedule has answered", () => {
  it("while loading: a placeholder, not 'Ingen kommende vagt'", async () => {
    scheduleImpl = () => new Promise(() => {});   // never answers
    await mount("da");
    expect(await screen.findByTestId("portal-hero-loading")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Ingen kommende vagt");
    expect(document.body.textContent).not.toContain("Ingen vagter denne uge");
  });

  it("when the schedule fails: says so and retries on tap", async () => {
    let calls = 0;
    scheduleImpl = () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error("Request failed");
        e.response = { status: 500, data: {} };
        return Promise.reject(e);
      }
      return ok({
        shifts: [{ id: "s1", date: inDays(1), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 6 }],
      });
    };
    await mount("da");
    const failed = await screen.findByTestId("portal-hero-failed");
    expect(failed.textContent).toContain("Kunne ikke hente din vagtplan");
    expect(document.body.textContent).not.toContain("Ingen kommende vagt");
    await act(async () => {
      fireEvent.click(within(failed).getByRole("button", { name: "Prøv igen" }));
    });
    await waitFor(() => expect(screen.queryByTestId("portal-hero-failed")).toBeNull());
    expect(document.body.textContent).toContain("16:00–22:00");
  });

  it("a real empty answer still says 'Ingen kommende vagt'", async () => {
    await mount("da");
    await waitFor(() => expect(document.body.textContent).toContain("Ingen kommende vagt"));
  });
});
