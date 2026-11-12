/**
 * Address register follow-ups (approved by Manoj 12 Nov 2026, "yes").
 *
 * Real en + da dictionaries, so a missing Danish string fails here.
 *  T2 (P1)  Market comparison says exactly what is missing (address, CVR,
 *           both), one "Open Profile →" link to #business, never the words
 *           "Open Profile" twice.
 *  T3 (P2)  Profile's company banner: the company line speaks only about
 *           CVR, the address line only about the register; a tick only when
 *           the server set the register id. No contradicting lines.
 *  T4 (P4)  Geofence Find: a typed ADDRESS that is not found gets "check the
 *           street, number and postcode…"; "not every venue is on the map"
 *           only for a venue NAME.
 *  T5 (P7)  An OpenStreetMap hit for a typed ADDRESS says it came from
 *           OpenStreetMap; "found by name" only for a name lookup.
 *  T8       A Find message follows a language switch; "Pricing looks
 *           healthy" reads Danish on the Danish page.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const h = vi.hoisted(() => ({ lang: "en", get: null, post: null }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a),
    put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { currency: "DKK" }, refreshUser: vi.fn() }) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  return {
    useLanguage: () => ({
      t: (k, fb, vars) => {
        const dict = h.lang === "da" ? DA : EN;
        let s = dict[k] ?? EN[k] ?? (typeof fb === "string" ? fb : k);
        const v = typeof fb === "object" && fb ? fb : vars;
        if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
        return s;
      },
      lang: h.lang, setLang: () => {}, LANGUAGES: [],
    }),
    LanguageProvider: ({ children }) => children,
  };
});

const { default: MarketSetupHint } = await import("../components/MarketSetupHint");
const { default: SmartPricingCard } = await import("../components/SmartPricingCard");
const { default: PricingPage } = await import("../pages/PricingPage");
const { VerifiedBusinessBanner } = await import("../pages/ProfilePage");
const { ClockGeofenceSettings } = await import("../pages/StaffSchedulePage");

beforeEach(() => {
  h.lang = "en";
  h.get = vi.fn(() => Promise.resolve({ data: {} }));
  h.post = vi.fn(() => Promise.resolve({ data: {} }));
});
afterEach(cleanup);

const HINTS = {
  address_unverified: "pricingAddressUnverified",
  company_unverified: "pricingCompanyUnverified",
  address_and_company_unverified: "pricingAddressCompanyUnverified",
};

// ── T2: the market-comparison hint ───────────────────────────────────────

describe("Market comparison hint names exactly what is missing", () => {
  it.each(Object.entries(HINTS))("%s has real en + da copy that does not say 'Open Profile'", (_hint, key) => {
    for (const dict of [en, da]) {
      expect(dict[key], key).toBeTruthy();
      expect(dict[key]).not.toMatch(/Open Profile|Åbn Profil/);
    }
  });

  it("the address hint talks about the address only; the company hint about CVR only", () => {
    expect(en.pricingAddressUnverified).toContain("Danmarks Adresseregister");
    expect(en.pricingAddressUnverified).not.toContain("CVR");
    expect(da.pricingAddressUnverified).not.toContain("CVR");
    expect(en.pricingCompanyUnverified).toContain("CVR");
    expect(en.pricingCompanyUnverified).not.toContain("Adresseregister");
    expect(da.pricingCompanyUnverified).not.toContain("Adresseregister");
    for (const dict of [en, da]) {
      expect(dict.pricingAddressCompanyUnverified).toContain("CVR");
      expect(dict.pricingAddressCompanyUnverified).toContain("Danmarks Adresseregister");
    }
  });

  it.each(["en", "da"])("each hint renders its own text and ONE 'Open Profile →' link to #business (%s)", (lang) => {
    h.lang = lang;
    const dict = lang === "da" ? da : en;
    for (const [hint, key] of Object.entries(HINTS)) {
      render(<MemoryRouter><SmartPricingCard currencyCode="DKK" comparison={{
        canonical_name: "cappuccino", available: false, reason: "needs_setup", setup_hint: hint, min_samples: 5,
      }} /></MemoryRouter>);
      expect(screen.getByTestId("pricing-setup-hint").textContent).toBe(dict[key]);
      const link = screen.getByTestId("pricing-address-hint-link");
      expect(link.getAttribute("href")).toBe("/profile#business");
      expect(link.textContent).toBe(dict.openProfile);
      // "Open Profile" / "Åbn Profil" once on the card, not twice in a row.
      const words = lang === "da" ? /Åbn Profil/g : /Open Profile/g;
      expect(document.body.textContent.match(words)).toHaveLength(1);
      cleanup();
    }
  });

  it("an unknown or missing hint keeps the old setup copy", () => {
    render(<MemoryRouter><MarketSetupHint hint="something_new" fallback="FALLBACK" /></MemoryRouter>);
    expect(screen.getByText("FALLBACK")).toBeTruthy();
    expect(screen.queryByTestId("pricing-address-hint-link")).toBeNull();
  });
});

// ── T2 + T8: the Pricing page (Danish) ───────────────────────────────────

describe("Pricing page in Danish", () => {
  function pricingGets(market) {
    h.get = vi.fn((url) => {
      if (url === "/pricing/insights") {
        return Promise.resolve({ data: {
          avg_ticket: 0, prev_avg_ticket: 0, ticket_change: 0, ticket_trend: "flat",
          daily_volume: 0, monthly_revenue: 0, total_transactions: 0,
          top_items: [], low_margin_items: [], no_sales_items: [],
          alerts: [{ type: "healthy", severity: "positive", icon: "✅",
            title: "Pricing looks healthy", detail: "No major issues detected.", action: null }],
        } });
      }
      if (url === "/smart-pricing/all") return Promise.resolve({ data: market });
      return Promise.resolve({ data: {} });
    });
  }

  it("'Pricing looks healthy / No major issues detected' reads Danish", async () => {
    h.lang = "da";
    pricingGets({ available_count: 0, unavailable_count: 0, comparisons: [], needs_setup: false });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    expect(await screen.findByText(da.ppAlertHealthyTitle)).toBeTruthy();
    expect(screen.getByText(da.ppAlertHealthyDetail)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Pricing looks healthy");
    expect(document.body.textContent).not.toContain("No major issues detected");
  });

  it("the market banner says the company (CVR) is missing, not the address", async () => {
    h.lang = "da";
    pricingGets({ available_count: 0, unavailable_count: 0, comparisons: [], needs_setup: true,
      message_key: "smartPricingNeedsSetup", setup_hint: "company_unverified" });
    render(<MemoryRouter><PricingPage /></MemoryRouter>);
    expect((await screen.findByTestId("pricing-setup-hint")).textContent).toBe(da.pricingCompanyUnverified);
    expect(screen.getByTestId("pricing-address-hint-link").getAttribute("href")).toBe("/profile#business");
    expect(document.body.textContent).not.toContain(da.pricingAddressUnverified);
  });
});

// ── T3: the Profile company banner ───────────────────────────────────────

describe("Profile company banner — one clear state per fact", () => {
  const typedByHand = { company_name: "Café Luna", country: "DK", address: "Rådhuspladsen 1", zipcode: "1550",
    cvr_verified_at: null, org_number: "" };

  it.each(["en", "da"])("typed by hand + address checked by the server: no contradicting lines (%s)", (lang) => {
    h.lang = lang;
    const dict = lang === "da" ? da : en;
    render(<VerifiedBusinessBanner profile={{ ...typedByHand, dawa_address_id: "0a3f50a0-23a8-32b8-e044-0003ba298018" }} />);
    expect(screen.getByText(dict.profVerifyManualEntry)).toBeTruthy();
    expect(screen.getByTestId("prof-address-checked").textContent).toBe(dict.profVerifyDawaChecked);
    expect(screen.getByTestId("prof-address-checked").querySelector("svg")).toBeTruthy();   // the tick
    // The old line said "not verified against any register" right above
    // "Address checked against Danmarks Adresseregister".
    expect(document.body.textContent).not.toMatch(/any register|noget register/);
    expect(dict.profVerifyManualEntry).toMatch(/CVR/);
    expect(screen.queryByTestId("prof-address-unchecked")).toBeNull();
  });

  it("no server-set id: no tick, and the address says it is not confirmed (DK)", () => {
    h.lang = "da";
    render(<VerifiedBusinessBanner profile={{ ...typedByHand, dawa_address_id: null }} />);
    expect(screen.queryByTestId("prof-address-checked")).toBeNull();
    expect(screen.getByTestId("prof-address-unchecked").textContent).toBe(da.profVerifyAddressNotConfirmed);
  });

  it("a non-DK address is never sent to the register, so no address line at all", () => {
    render(<VerifiedBusinessBanner profile={{ ...typedByHand, country: "UK", dawa_address_id: null }} />);
    expect(screen.queryByTestId("prof-address-checked")).toBeNull();
    expect(screen.queryByTestId("prof-address-unchecked")).toBeNull();
  });

  it("a CVR-verified company keeps its 'Verified' line next to the address tick", () => {
    render(<VerifiedBusinessBanner profile={{ ...typedByHand, org_number: "12345678",
      cvr_verified_at: new Date().toISOString(), cvr_verified_source: "cvrapi.dk",
      dawa_address_id: "0a3f50a0-23a8-32b8-e044-0003ba298018" }} />);
    expect(document.body.textContent).toContain(`${en.profVerifyVerified} · cvrapi.dk`);
    expect(screen.getByTestId("prof-address-checked")).toBeTruthy();
    expect(document.body.textContent).not.toContain(en.profVerifyManualEntry);
  });
});

// ── T4 / T5 / T8: geofence Find ──────────────────────────────────────────

function renderFind() {
  h.get = vi.fn((url) => {
    if (String(url).includes("/staff/clock-geofence")) {
      return Promise.resolve({ data: { enabled: false, lat: null, lng: null, radius_m: 150, has_location: false } });
    }
    return Promise.resolve({ data: [] });
  });
  return render(<ClockGeofenceSettings />);
}

async function find(query) {
  const dict = h.lang === "da" ? da : en;
  const input = await screen.findByPlaceholderText(dict.schedGeoAddrPlaceholder);
  fireEvent.change(input, { target: { value: query } });
  await act(async () => { fireEvent.click(screen.getByText(dict.schedGeoLookUp)); });
}

describe("Geofence Find — advice that fits what was typed", () => {
  it.each([
    // [query, server detail, expected key]
    ["Algade 1, 9000 Aalborg", { error: "not_found", reason: null, query_kind: "address" }, "schedGeoAddrNotFound"],
    ["Algade 1, 9000 Aalborg", { error: "not_found", reason: "postcode_mismatch", query_kind: "address" }, "schedGeoPostcodeMismatch"],
    ["Algade 1, 9000 Aalborg", { error: "not_found", reason: "street_only", query_kind: "address" }, "schedGeoStreetOnly"],
    ["Rentemestervej 8", { error: "not_found", reason: "need_postcode", query_kind: "address" }, "schedGeoNeedPostcode"],
    ["Silberbauer Bistro", { error: "not_found", reason: null, query_kind: "name" }, "schedGeoNotFound"],
    // An older server sends no query_kind: the panel reads the query itself.
    ["Algade 1, 9000 Aalborg", { error: "not_found" }, "schedGeoAddrNotFound"],
    ["Café Luna, 8000 Aarhus C", { error: "not_found" }, "schedGeoNotFound"],
  ])("%s → %j", async (query, detail, key) => {
    h.post = vi.fn(() => Promise.reject({ response: { status: 404, data: { detail } } }));
    renderFind();
    await find(query);
    expect(await screen.findByText(en[key])).toBeTruthy();
    if (key !== "schedGeoNotFound") {
      expect(document.body.textContent).not.toContain("Not every venue is on the map");
    }
  });

  it("the address advice exists in Danish and never says 'type your street address instead'", () => {
    for (const k of ["schedGeoAddrNotFound", "schedGeoPostcodeMismatch"]) {
      expect(da[k]).toBeTruthy();
      expect(en[k]).not.toMatch(/street address instead/);
      expect(da[k]).not.toMatch(/gadeadresse i stedet/);
    }
  });

  it("an OpenStreetMap hit for a typed ADDRESS says OpenStreetMap, not 'found by name'", async () => {
    h.post = vi.fn(() => Promise.resolve({ data: {
      lat: 55.6756, lng: 12.5696, label: "Rådhuspladsen 1, 1550", source: "place_name", provider: "osm", query_kind: "address",
    } }));
    renderFind();
    await find("Rådhuspladsen 1, 1550 København V");
    expect(await screen.findByText(en.schedGeoOsmAddrCaveat)).toBeTruthy();
    expect(screen.queryByText(en.schedGeoNameCaveat)).toBeNull();
    expect(screen.getByTestId("geo-osm-credit")).toBeTruthy();
  });

  it("an older server (no query_kind): a typed address still gets the OpenStreetMap caveat", async () => {
    h.post = vi.fn(() => Promise.resolve({ data: {
      lat: 55.6756, lng: 12.5696, label: "Rådhuspladsen 1, 1550", source: "place_name", provider: "osm",
    } }));
    renderFind();
    await find("Rådhuspladsen 1, 1550 København V");
    expect(await screen.findByText(en.schedGeoOsmAddrCaveat)).toBeTruthy();
  });

  it("a NAME found on OpenStreetMap keeps 'found by name'", async () => {
    h.post = vi.fn(() => Promise.resolve({ data: {
      lat: 55.6734, lng: 12.5692, label: "Tivoli, Vesterbrogade, 1609", source: "place_name", provider: "osm", query_kind: "name",
    } }));
    renderFind();
    await find("Tivoli, København");
    expect(await screen.findByText(en.schedGeoNameCaveat)).toBeTruthy();
    expect(screen.queryByText(en.schedGeoOsmAddrCaveat)).toBeNull();
  });

  it("a Find error follows a language switch (it kept the old language until the next lookup)", async () => {
    h.post = vi.fn(() => Promise.reject({ response: { status: 424, data: { detail: { error: "lookup_unavailable" } } } }));
    const view = renderFind();
    await find("Rådhuspladsen 1, 1550 København V");
    expect(await screen.findByText(en.schedGeoLookupDown)).toBeTruthy();
    h.lang = "da";
    view.rerender(<ClockGeofenceSettings />);
    await waitFor(() => expect(screen.getByText(da.schedGeoLookupDown)).toBeTruthy());
    expect(screen.queryByText(en.schedGeoLookupDown)).toBeNull();
  });
});
