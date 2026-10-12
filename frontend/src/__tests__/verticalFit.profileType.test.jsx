/**
 * Vertical fit (12 Oct 2026) — changing the business type in Profile.
 *
 * Before: the Profile type field changed one column. The wording followed,
 * but the cutoff, modules, categories and pillar preset stayed the old type's
 * — while the preview promised "Dagsskifte kl. 00:00" it never saved. Værksted
 * and Andet were not in the list, and the card "Hvad serverer du" asked a
 * salon what it serves.
 *
 * Now: saving a NEW type asks first (useConfirm) with the server's plan —
 * "Anvend" applies the defaults, "Behold mine indstillinger" changes the type
 * only, "Annuller" saves nothing — and the type list is the shared catalogue.
 *
 * Review round: the sheet only says "because you use it" where there is a
 * usage signal ("Bliver i menuen" otherwise), and it names the tools the new
 * type takes out of (or puts into) the menu — the same filter the sidebar
 * runs, so a tool in use is never on the list.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), me: {}, plan: null, business: {}, refreshPillars: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: (...a) => h.patch(...a), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.me, refreshUser: vi.fn() }) }));
vi.mock("../hooks/usePillars", () => ({ usePillars: () => ({ hiddenPillars: new Set(), refresh: h.refreshPillars }) }));
const used = vi.hoisted(() => ({ surfaces: new Set() }));
vi.mock("../hooks/useActivation", () => ({ useActivation: () => ({ usedSurfaces: used.surfaces }) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
    lang: "da", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/usePushNotifications", () => ({
  default: () => ({ permission: "default", supported: false, subscribed: false, busy: false,
    subscribe: vi.fn(), unsubscribe: vi.fn(), sendTest: vi.fn() }),
}));
vi.mock("../components/OperatingProfileSection", () => ({ default: () => null }));
vi.mock("../components/SmartStaffingCard", () => ({ default: () => null }));
vi.mock("../components/DeviceShareSettingsCard", () => ({ default: () => null }));
vi.mock("../components/BusinessLookup", () => ({ default: () => null, countryFromCurrency: () => "DK" }));

const ProfilePage = (await import("../pages/ProfilePage")).default;
const { ConfirmProvider } = await import("../hooks/useConfirm");

const CAFE = { id: "u1", email: "ejer@cafe.dk", business_name: "Café Nora", business_type: "cafe",
  currency: "DKK", role: "owner", email_verified: true, claim_question_open: false };
const SALON_PLAN = {
  from_type: "cafe", to_type: "salon", from_archetype: "food_service", to_archetype: "salon",
  cutoff: { from: 6, to: 0 }, cutoff_kept: null, modules_add: [], categories_add: ["Produkter"],
  pillars_show: ["insights"], pillars_hide: [], pillars_kept: [], has_changes: true,
};

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.patch.mockReset(); h.refreshPillars.mockReset();
  h.me = { ...CAFE };
  h.plan = SALON_PLAN;
  used.surfaces = new Set();
  h.business = { day_cutoff_hour: 6 };
  h.get.mockImplementation((url) => {
    if (url === "/auth/me") return Promise.resolve({ data: h.me });
    if (url === "/business") return Promise.resolve({ data: h.business });
    if (url === "/auth/business-type/preview") return Promise.resolve({ data: h.plan });
    if (url === "/billing/usage") return Promise.resolve({ data: { meters: [] } });
    return Promise.resolve({ data: {} });
  });
  h.post.mockResolvedValue({ data: { business_type: "salon", applied: null } });
  h.patch.mockImplementation((url, body) => Promise.resolve({ data: { ...h.me, ...body } }));
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  }
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function renderProfile() {
  const view = render(<MemoryRouter><ConfirmProvider><ProfilePage /></ConfirmProvider></MemoryRouter>);
  await waitFor(() => expect(view.container.querySelector('select option[value="salon"]')).not.toBeNull());
  await settle();
  const select = view.container.querySelector('select option[value="salon"]').closest("select");
  return { ...view, select };
}

async function pickAndSave(select, value) {
  fireEvent.change(select, { target: { value } });
  await act(async () => { fireEvent.submit(select.closest("form")); });
  await settle();
}

describe("the type list is the shared catalogue", () => {
  it("offers Værksted, Andet, Freelancer and Eventarrangør — and no second 'Andet'", async () => {
    const { select } = await renderProfile();
    const values = [...select.querySelectorAll("option")].map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(["workshop", "general", "freelancer", "event_organizer"]));
    expect(values).not.toContain("other");
  });

  it("a workshop account sees Værksted selected, not a raw 'workshop' option", async () => {
    h.me = { ...CAFE, business_type: "workshop" };
    const { select } = await renderProfile();
    const opts = [...select.querySelectorAll('option[value="workshop"]')];
    expect(opts).toHaveLength(1);
    expect(select.value).toBe("workshop");
  });
});

describe("saving a new type asks first", () => {
  it("lists what changes; 'Anvend' applies the defaults, then saves the profile", async () => {
    const { select } = await renderProfile();
    await pickAndSave(select, "salon");
    expect(h.get).toHaveBeenCalledWith("/auth/business-type/preview", { params: { business_type: "salon" } });
    const summary = await screen.findByTestId("type-change-summary");
    expect(summary.textContent).toContain("Day rollover 06:00 → 00:00");
    expect(summary.textContent).toContain("New expense categories: Produkter");
    expect(summary.textContent).toContain("None of your data is deleted");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply" })); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/auth/business-type", { business_type: "salon", apply_defaults: true });
    expect(h.patch).toHaveBeenCalledWith("/auth/profile", expect.objectContaining({ business_type: "salon" }));
    expect(h.refreshPillars).toHaveBeenCalled();
  });

  it("'Behold mine indstillinger' changes the type only", async () => {
    const { select } = await renderProfile();
    await pickAndSave(select, "salon");
    await screen.findByTestId("type-change-summary");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep my settings" })); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/auth/business-type", { business_type: "salon", apply_defaults: false });
    expect(h.patch).toHaveBeenCalled();
  });

  it("'Annuller' saves nothing", async () => {
    const { select } = await renderProfile();
    await pickAndSave(select, "salon");
    await screen.findByTestId("type-change-summary");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    await settle();
    expect(h.post).not.toHaveBeenCalled();
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("a type with nothing to apply saves without a question", async () => {
    h.plan = { ...SALON_PLAN, to_type: "restaurant", cutoff: null, categories_add: [], pillars_show: [], has_changes: false };
    const { select } = await renderProfile();
    await pickAndSave(select, "restaurant");
    expect(screen.queryByTestId("type-change-summary")).toBeNull();
    expect(h.post).toHaveBeenCalledWith("/auth/business-type", { business_type: "restaurant", apply_defaults: true });
  });

  it("the same type saves exactly as before — no preview, no type call", async () => {
    const { select } = await renderProfile();
    await act(async () => { fireEvent.submit(select.closest("form")); });
    await settle();
    expect(h.get).not.toHaveBeenCalledWith("/auth/business-type/preview", expect.anything());
    expect(h.post).not.toHaveBeenCalled();
    expect(h.patch).toHaveBeenCalled();
  });
});

describe("the business card fits the type", () => {
  it("a café is asked what it serves; a salon is not; a salon that saved one keeps the card", async () => {
    const cafe = await renderProfile();
    expect(screen.getByText("profileCuisineCardTitle")).toBeInTheDocument();
    cafe.unmount();

    h.me = { ...CAFE, business_type: "salon" };
    const salon = await renderProfile();
    expect(screen.queryByText("profileCuisineCardTitle")).toBeNull();
    salon.unmount();

    h.me = { ...CAFE, business_type: "salon" };
    h.business = { day_cutoff_hour: 0, cuisine: "Herreklip" };
    await renderProfile();
    expect(screen.getByText("profileCuisineCardTitle")).toBeInTheDocument();
  });

  it("links to the feature switches", async () => {
    await renderProfile();
    expect(screen.getByTestId("profile-modules-link").getAttribute("href")).toBe("/modules");
  });

  it("the preview names the SAVED cutoff, and a new type's default only as a default", async () => {
    const { select } = await renderProfile();
    expect(screen.getByText(/Dagsskifte kl\. 06:00/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "salon" } });
    await settle();
    expect(screen.getByText(/Dagsskifte kl\. 06:00/).textContent).toContain("the usual for this type is 00:00");
  });
});

describe("the sheet tells the truth (review round)", () => {
  it("a pillar with no usage signal stays without a claimed reason", async () => {
    h.plan = { ...SALON_PLAN, pillars_show: [], pillars_kept: [], pillars_stay: ["insights"] };
    const { select } = await renderProfile();
    await pickAndSave(select, "salon");
    const summary = await screen.findByTestId("type-change-summary");
    expect(summary.textContent).toContain("Stays in your menu: pillarLabelInsights");
    expect(summary.textContent).not.toContain("because you use it");
  });

  it("names the tools the new type takes out of the menu — not used yet", async () => {
    const { select } = await renderProfile();
    await pickAndSave(select, "salon");
    const summary = await screen.findByTestId("type-change-summary");
    expect(summary.textContent).toContain("Leaves the menu with the new type (not used yet): expiryForecasting, wasteTracker");
  });

  it("a tool in use stays, and is not on the list", async () => {
    used.surfaces = new Set(["waste"]);
    const { select } = await renderProfile();
    await pickAndSave(select, "salon");
    const summary = await screen.findByTestId("type-change-summary");
    expect(summary.textContent).toContain("(not used yet): expiryForecasting");
    expect(summary.textContent).not.toContain("wasteTracker");
  });

  it("a type that puts tools into the menu says so", async () => {
    h.me = { ...CAFE, business_type: "salon" };
    h.plan = { ...SALON_PLAN, from_type: "salon", to_type: "cafe", to_archetype: "food_service" };
    const { select } = await renderProfile();
    await pickAndSave(select, "cafe");
    const summary = await screen.findByTestId("type-change-summary");
    expect(summary.textContent).toContain("New in the menu: expiryForecasting, wasteTracker");
  });

  it("nothing to apply but the menu changes: one way forward, no 'Keep my settings'", async () => {
    h.plan = { ...SALON_PLAN, to_type: "jewelry", cutoff: null, categories_add: [], pillars_show: [], has_changes: false };
    const { select } = await renderProfile();
    await pickAndSave(select, "jewelry");
    const summary = await screen.findByTestId("type-change-summary");
    expect(summary.textContent).toContain("(not used yet): expiryForecasting, wasteTracker");
    expect(summary.textContent).toContain("None of your data is deleted.");
    expect(summary.textContent).not.toContain("Keep my settings");
    expect(screen.queryByRole("button", { name: "Keep my settings" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Change type" })); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/auth/business-type", { business_type: "jewelry", apply_defaults: true });
  });
});
