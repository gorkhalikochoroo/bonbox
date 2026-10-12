/**
 * Vagtplan — "Dit team": add a person, send them their way in, see who is in.
 *
 * The owner (12 Oct 2026): "this section managing staff and sharing code to
 * staff and to apps looks a bit confusing — make it more subtle, nicely
 * polished and easy for owners." What was on the page before:
 *   • the same credential in five places under five names — an unlabelled
 *     code chip on each roster row, a link icon → "Del portal-link" dialog,
 *     "Del link" in the edit drawer, a per-row "kopiér" in the week's share
 *     sheet, and a bare "App Store" link under the toolbar;
 *   • nobody's status anywhere on the roster — "has Sofie opened it?" only
 *     existed inside the share sheet, and only after it had been opened;
 *   • the empty schedule's only button ("Tilføj medarbejdere") opened a panel
 *     ~1.4 phone screens further down without scrolling to it.
 *
 * Whole page mounted, real Danish catalogue, api mocked per URL.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let ROLE = "owner";
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, role: ROLE, currency: "DKK", business_type: "cafe", plan: "pro", business_name: "Café Mirabelle" },
    loading: false,
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ isAtCap: () => false, cap: () => 25, isReady: true, plan: "pro", data: {} }),
}));
vi.mock("../hooks/useDeviceShare", () => ({
  useDeviceShare: () => ({ ready: true, enabled: false, hasPin: false, locked: false }),
}));

const api = (await import("../services/api")).default;
const { default: StaffSchedulePage } = await import("../pages/StaffSchedulePage");
const { LanguageProvider } = await import("../hooks/useLanguage");

// Naive UTC, the way the server sends it.
const nowUtcNaive = () => new Date().toISOString().slice(0, 19);

const TEAM = [
  { id: "a", name: "Sofie Holm", role: "Barista", active: true, contract_type: "part", base_rate: 165, phone: "22334455" },
  { id: "b", name: "Mads Kjær", role: "Barista", active: true, contract_type: "part", base_rate: 158 },
];
let STAFF = TEAM;
let LINKS = [];

function routeGet(url) {
  const u = String(url);
  if (u.includes("/staff/schedules/share-links")) return Promise.resolve({ data: LINKS });
  if (u.includes("/staff/members")) return Promise.resolve({ data: STAFF });
  if (u.includes("/staff/schedules/week-cost")) return Promise.reject({ response: { status: 500 } });
  if (u.includes("/staff/schedules/week-load")) return Promise.resolve({ data: { staff: [] } });
  if (u.includes("/staff/schedules/forecast")) return Promise.reject({ response: { status: 402 } });
  if (u.endsWith("/staff/schedules")) return Promise.resolve({ data: [] });
  if (u.includes("/staff/availability")) return Promise.resolve({ data: { availability: [] } });
  if (u.includes("/staff/absences")) return Promise.resolve({ data: [] });
  if (u.includes("/staff/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
}

const shareLinkCalls = () => api.get.mock.calls.filter(([u]) => String(u).includes("/share-links"));

beforeEach(() => {
  ROLE = "owner";
  STAFF = TEAM;
  LINKS = [
    { staff_id: "a", staff_name: "Sofie Holm", join_code: "2TC5NS", portal_url: "/s/cafe-mirabelle/sofie-holm/tokA", has_pin: false, last_accessed: null },
    { staff_id: "b", staff_name: "Mads Kjær", join_code: "J5QCKE", portal_url: "/s/cafe-mirabelle/mads-kjaer/tokB", has_pin: false, last_accessed: nowUtcNaive() },
  ];
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(routeGet);
  api.post.mockImplementation((url) => {
    const u = String(url);
    if (u.includes("/staff/members/a/link")) {
      return Promise.resolve({ data: { portal_url: "/s/cafe-mirabelle/sofie-holm/tokA", join_code: "2TC5NS" } });
    }
    if (u === "/staff/members") {
      return Promise.resolve({ data: { id: "n", name: "Freja Lund", active: true, role: "Barista" } });
    }
    return Promise.resolve({ data: {} });
  });
  localStorage.setItem("lang", "da");
  // A frame later, the way a browser runs it — after React has committed.
  vi.stubGlobal("requestAnimationFrame", (cb) => setTimeout(() => cb(0), 0));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <StaffSchedulePage />
        </LanguageProvider>
      </MemoryRouter>,
    );
  });
}

const teamToggle = () => screen.findByRole("button", { name: /Dit team/ }, { timeout: 8000 });

describe("who is in — at a glance, without opening anything", () => {
  it("asks the server on mount for an owner with a team", async () => {
    await mountPage();
    await teamToggle();
    await waitFor(() => expect(shareLinkCalls().length).toBeGreaterThan(0));
  });

  it("says in the team header how many are not in yet", async () => {
    await mountPage();
    const chip = await screen.findByTestId("team-reach-chip", {}, { timeout: 8000 });
    expect(chip.textContent).toBe("1 er ikke med endnu");
  });

  it("says 'Alle er med' once everybody has opened their link", async () => {
    LINKS = LINKS.map((r) => ({ ...r, last_accessed: nowUtcNaive() }));
    await mountPage();
    const chip = await screen.findByTestId("team-reach-chip", {}, { timeout: 8000 });
    expect(chip.textContent).toBe("Alle er med");
  });

  it("does not ask (and claims nothing) for a manager seat", async () => {
    ROLE = "manager";
    await mountPage();
    await teamToggle();
    // Give any effect a chance to fire.
    await act(async () => { await Promise.resolve(); });
    expect(shareLinkCalls()).toHaveLength(0);
    expect(screen.queryByTestId("team-reach-chip")).toBeNull();
  });

  it("the toolbar line points at the team, not at a bare App Store link", async () => {
    await mountPage();
    const seeWho = await screen.findByRole("button", { name: "Se hvem" }, { timeout: 8000 });
    expect(screen.getByText("1 af 2 er med")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "App Store" })).toBeNull();
    fireEvent.click(seeWho);
    expect(await screen.findByTestId("team-list")).toBeInTheDocument();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });
});

describe("the team list", () => {
  async function openTeam() {
    await mountPage();
    fireEvent.click(await teamToggle());
    return screen.findByTestId("team-list");
  }

  it("shows each person's status and one clear action — no unlabelled code chip", async () => {
    const list = await openTeam();
    const sofie = list.querySelector('[data-staff-row="a"]');
    const mads = list.querySelector('[data-staff-row="b"]');
    await waitFor(() => expect(within(sofie).getByText("Ikke åbnet endnu")).toBeInTheDocument());
    expect(within(mads).getByText("Aktiv · set i dag")).toBeInTheDocument();
    // Not in yet → the word. In already → a quiet "send again" icon.
    expect(within(sofie).getByRole("button", { name: "Invitér — Sofie Holm" })).toBeInTheDocument();
    expect(within(mads).queryByRole("button", { name: /^Invitér/ })).toBeNull();
    expect(within(mads).getByRole("button", { name: "Send linket igen — Mads Kjær" })).toBeInTheDocument();
    // The 6-character code is no longer a bare chip on the row.
    expect(within(sofie).queryByText("2TC5NS")).toBeNull();
    expect(within(sofie).queryByRole("button", { name: /Kopiér kode/ })).toBeNull();
  });

  it("'Invitér' opens ONE sheet: SMS / WhatsApp / copy, the labelled code, the app and the link", async () => {
    const list = await openTeam();
    const sofie = list.querySelector('[data-staff-row="a"]');
    fireEvent.click(await within(sofie).findByRole("button", { name: "Invitér — Sofie Holm" }));
    const sheet = await screen.findByTestId("staff-invite-sheet");
    expect(within(sheet).getByText("Invitér Sofie")).toBeInTheDocument();
    const wa = await waitFor(() => {
      const el = sheet.querySelector('[data-channel="whatsapp"]');
      expect(el).not.toBeNull();
      return el;
    });
    // Her 8-digit Danish number, with the link in the text.
    expect(wa.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/4522334455\?text=/);
    expect(decodeURIComponent(wa.getAttribute("href"))).toContain("/s/cafe-mirabelle/sofie-holm/tokA");
    expect(decodeURIComponent(wa.getAttribute("href"))).toContain("Log ind i appen med koden 2TC5NS");
    expect(sheet.querySelector('[data-channel="copy"]')).not.toBeNull();
    // The code, labelled for what it is for.
    expect(within(sheet).getByText("Kode til appen")).toBeInTheDocument();
    expect(within(sheet).getByTestId("staff-invite-code").textContent).toBe("2TC5NS");
    // The app, named and linked — next to the code that signs into it.
    expect(within(sheet).getByRole("link", { name: /BonBox Vagtplan i App Store/ }).getAttribute("href"))
      .toContain("id6787010793");
    expect(within(sheet).getByTestId("staff-invite-url").textContent).toContain("/s/cafe-mirabelle/sofie-holm/tokA");
    // The bare link alone is still one tap (what the old dialog's "Kopiér" did).
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: "Kopiér link" })); });
    expect(writeText).toHaveBeenCalledWith(within(sheet).getByTestId("staff-invite-url").textContent);
    // Status inside the sheet, from the same answer as the row.
    expect(within(sheet).getByText("Ikke åbnet endnu")).toBeInTheDocument();
  });

  it("after adding someone, offers to invite exactly that person", async () => {
    await openTeam();
    const name = screen.getByLabelText("Navn");
    fireEvent.change(name, { target: { value: "Freja Lund" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Tilføj" })); });
    const nudge = await screen.findByTestId("team-just-added");
    expect(nudge.textContent).toContain("Freja Lund er tilføjet.");
    api.post.mockImplementation(() => Promise.resolve({ data: { portal_url: "/s/cafe-mirabelle/freja-lund/tokN", join_code: "8ACA4S" } }));
    fireEvent.click(within(nudge).getByRole("button", { name: /Invitér Freja/ }));
    const sheet = await screen.findByTestId("staff-invite-sheet");
    expect(within(sheet).getByText("Invitér Freja")).toBeInTheDocument();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/staff/members/n/link"));
  });

  it("still reaches 'Deaktivér' — now in the person's drawer, not as a red bin on every row", async () => {
    const list = await openTeam();
    const sofie = list.querySelector('[data-staff-row="a"]');
    expect(within(sofie).queryByRole("button", { name: /Deaktivér/ })).toBeNull();
    fireEvent.click(within(sofie).getByRole("button", { name: "Rediger — Sofie Holm" }));
    expect(await screen.findByRole("button", { name: "Deaktivér" })).toBeInTheDocument();
  });
});

describe("a brand-new account", () => {
  beforeEach(() => {
    STAFF = [];
    LINKS = [];
  });

  it("'Tilføj medarbejdere' opens the team panel, scrolls to it and puts the cursor in Navn", async () => {
    await mountPage();
    const cta = await screen.findByRole("button", { name: "Tilføj medarbejdere" }, { timeout: 8000 });
    fireEvent.click(cta);
    const name = await screen.findByLabelText("Navn");
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  it("'Del' is dead with nobody on the team, and says why", async () => {
    await mountPage();
    await screen.findByRole("button", { name: "Tilføj medarbejdere" }, { timeout: 8000 });
    const del = screen.getByTitle("Tilføj dit team først");
    expect(del).toBeDisabled();
  });
});

describe("after publishing, when nobody was told", () => {
  it("'Del ugen' goes straight to the links (no chooser), and one copied link reads '1 link kopieret'", async () => {
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const today = iso(new Date());
    api.get.mockImplementation((url) =>
      String(url).endsWith("/staff/schedules")
        ? Promise.resolve({ data: [{ id: "s1", staff_id: "a", date: today, start_time: "08:00", end_time: "16:00", break_minutes: 30, status: "draft" }] })
        : routeGet(url),
    );
    api.post.mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/staff/schedules/publish")) return Promise.resolve({ data: { published: 1, notify_count: 0, skipped_no_email_names: ["Sofie Holm"] } });
      if (u.includes("/staff/members/a/link")) return Promise.resolve({ data: { portal_url: "/s/cafe-mirabelle/sofie-holm/tokA", join_code: "2TC5NS" } });
      return Promise.resolve({ data: {} });
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mountPage();
    fireEvent.click(await screen.findByTitle("Udgiv ugen", {}, { timeout: 8000 }));
    const confirmSheet = await screen.findByRole("dialog", { name: "Udgiv denne uge?" });
    await act(async () => { fireEvent.click(within(confirmSheet).getByRole("button", { name: "Udgiv ugen" })); });
    fireEvent.click(await screen.findByRole("button", { name: "Del ugen" }));
    const share = await screen.findByRole("dialog", { name: "Del denne uges vagtplan" });
    expect(screen.queryByText("Vælg hvordan ugen når dine medarbejdere")).toBeNull();
    // Just Sofie.
    fireEvent.click(within(share).getAllByRole("checkbox")[2]);
    await act(async () => { fireEvent.click(within(share).getByRole("button", { name: /Kopiér 1 link/ })); });
    expect(await within(share).findByText(/1 link kopieret/)).toBeInTheDocument();
    expect(within(share).queryByText(/1 links kopieret/)).toBeNull();
    expect(writeText).toHaveBeenCalled();
  });
});
