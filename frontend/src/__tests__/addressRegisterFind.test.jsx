/**
 * DAWA replacement (12 Nov 2026). DAWA closed on 1 Oct 2026; the server now
 * checks addresses against Danmarks Adresseregister (KDS Adressevask) and
 * pins venues from the register, then OpenStreetMap.
 *
 * Pins the three owner surfaces:
 *  1. BusinessLookup (Profile → find my company): tick, near-match picker
 *     (copies the register's postcode and town too), "not found" and
 *     "couldn't check right now" as two different quiet lines; the save no
 *     longer sends dawa_address_id (the server owns it).
 *  2. The geofence "Find": _noRetry, 424 = lookup down, the street_only /
 *     need_postcode refusals, the OpenStreetMap caveat + credit, and the
 *     register credit.
 *  3. Market comparison: setup_hint "address_unverified" shows honest copy
 *     with a Profile link (reason stays "needs_setup" for old builds).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => {
      let out = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) for (const [name, val] of Object.entries(v)) out = out.replace(`{${name}}`, String(val));
      return out;
    },
    lang: "en", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));

const api = (await import("../services/api")).default;
const { default: BusinessLookup } = await import("../components/BusinessLookup");
const { ClockGeofenceSettings } = await import("../pages/StaffSchedulePage");
const { default: SmartPricingCard } = await import("../components/SmartPricingCard");

const CVR_HIT = {
  name: "Højgaard Café ApS", org_number: "12345678", address: "Højgaardsvej 3",
  zipcode: "4773", city: "Stensved", industry: "Restauranter", industry_code: "56.10.10",
  phone: "", email: "", source: "cvrapi.dk", confidence: "verified", status_flags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (String(url).includes("/business/countries")) {
      return Promise.resolve({ data: [{ code: "DK", name: "Danmark", auto_lookup: true, reg_label: "CVR" }] });
    }
    if (String(url).includes("/business/lookup")) return Promise.resolve({ data: [CVR_HIT] });
    return Promise.resolve({ data: [] });
  });
  api.put.mockResolvedValue({ data: {} });
});

async function pickCompany() {
  render(<BusinessLookup initialProfile={{ country: "DK" }} onSave={() => {}} />);
  const search = await screen.findByPlaceholderText(/Mirabelle ApS/);
  fireEvent.change(search, { target: { value: "Højgaard" } });
  const hit = await screen.findByText("Højgaard Café ApS", {}, { timeout: 2000 });
  fireEvent.click(hit);
}

describe("BusinessLookup — the address check", () => {
  it("asks once, without retries, and sends the country", async () => {
    api.post.mockResolvedValue({ data: { verified: false, status: "not_found", source: "dar" } });
    await pickCompany();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body, config] = api.post.mock.calls[0];
    expect(url).toBe("/business/verify-address");
    expect(body).toMatchObject({ address: "Højgaardsvej 3", zipcode: "4773", city: "Stensved", country: "DK" });
    expect(config).toMatchObject({ _noRetry: true });
  });

  it("shows the tick and the KDS credit for a verified address", async () => {
    api.post.mockResolvedValue({ data: {
      verified: true, matches_input: true, category: "A", status: "found", source: "dar",
      id: "x", betegnelse: "Højgaardsvej 3, 4773 Stensved",
    } });
    await pickCompany();
    expect(await screen.findByText("Address found in Danmarks Adresseregister")).toBeTruthy();
    expect(screen.getByTestId("addr-register-credit").textContent).toBe("Address data: Klimadatastyrelsen");
  });

  it("picking the register's version copies its street, postcode AND town, and the save sends no id", async () => {
    api.post.mockResolvedValue({ data: {
      verified: true, matches_input: false, category: "B", status: "found", source: "dar",
      id: "8dc244f4-3ead-4022-9ae9-a35ed427aff3", betegnelse: "Højgaardsvej 3B, 4760 Vordingborg",
      address_line: "Højgaardsvej 3B", vejnavn: "Højgaardsvej", husnr: "3B",
      postnr: "4760", postnrnavn: "Vordingborg",
    } });
    await pickCompany();
    expect(await screen.findByText("The address register writes it a little differently:")).toBeTruthy();
    fireEvent.click(screen.getByText("Højgaardsvej 3B, 4760 Vordingborg"));
    expect(await screen.findByText("Address found in Danmarks Adresseregister")).toBeTruthy();
    expect(screen.getByDisplayValue("Højgaardsvej 3B")).toBeTruthy();
    expect(screen.getByDisplayValue("4760")).toBeTruthy();
    expect(screen.getByDisplayValue("Vordingborg")).toBeTruthy();
    fireEvent.click(screen.getByText("Save Business Profile"));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const payload = api.put.mock.calls[0][1];
    expect(payload).toMatchObject({ address: "Højgaardsvej 3B", zipcode: "4760", city: "Vordingborg" });
    expect(payload).not.toHaveProperty("dawa_address_id");
  });

  it("'not found' is a quiet note, not a block", async () => {
    api.post.mockResolvedValue({ data: { verified: false, status: "not_found", source: "dar" } });
    await pickCompany();
    expect(await screen.findByTestId("addr-not-in-register")).toBeTruthy();
    expect(screen.getByText("Save Business Profile").disabled).toBe(false);
  });

  it("'couldn't check right now' is its own grey line — never 'not found'", async () => {
    api.post.mockResolvedValue({ data: { verified: false, status: "unavailable", source: "dar" } });
    await pickCompany();
    expect((await screen.findByTestId("addr-check-unavailable")).textContent)
      .toBe("Couldn't check the address right now. You can still save it.");
    expect(screen.queryByTestId("addr-not-in-register")).toBeNull();
  });

  it("an older server's bare {verified: false} reads as couldn't check (DAWA was down, not the address)", async () => {
    api.post.mockResolvedValue({ data: { verified: false } });
    await pickCompany();
    expect(await screen.findByTestId("addr-check-unavailable")).toBeTruthy();
  });

  it("a network error is couldn't check too", async () => {
    api.post.mockRejectedValue({ response: { status: 502 } });
    await pickCompany();
    expect(await screen.findByTestId("addr-check-unavailable")).toBeTruthy();
  });
});

// ── the geofence "Find" ──────────────────────────────────────────────────

function renderFind() {
  api.get.mockImplementation((url) => {
    if (String(url).includes("/staff/clock-geofence")) {
      return Promise.resolve({ data: { enabled: false, lat: null, lng: null, radius_m: 150, has_location: false } });
    }
    return Promise.resolve({ data: [] });
  });
  render(<ClockGeofenceSettings />);
}

async function find(query) {
  const input = await screen.findByPlaceholderText("…or type the address, or paste a map link");
  fireEvent.change(input, { target: { value: query } });
  fireEvent.click(screen.getByText("Find"));
}

describe("Geofence Find — the register, then OpenStreetMap", () => {
  it("sends _noRetry (a 5xx POST is otherwise replayed 4 times)", async () => {
    api.post.mockResolvedValue({ data: { lat: 55.675628, lng: 12.569578, label: "Rådhuspladsen 1, 1550 København V", source: "address", provider: "dar", dawa_id: "x" } });
    renderFind();
    await find("Rådhuspladsen 1, 1550 København V");
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][0]).toBe("/staff/clock-geofence/resolve");
    expect(api.post.mock.calls[0][2]).toMatchObject({ _noRetry: true });
  });

  it("a register hit shows the KDS credit and no OpenStreetMap caveat", async () => {
    api.post.mockResolvedValue({ data: { lat: 55.675628, lng: 12.569578, label: "Rådhuspladsen 1, 1550 København V", source: "address", provider: "dar", dawa_id: "x" } });
    renderFind();
    await find("Rådhuspladsen 1, 1550 København V");
    expect((await screen.findByTestId("geo-register-credit")).textContent).toBe("Address data: Klimadatastyrelsen");
    expect(screen.queryByTestId("geo-osm-credit")).toBeNull();
    expect(screen.queryByText(/Found by name on a public map/)).toBeNull();
  });

  it("an OpenStreetMap hit shows the 'check it's yours' caveat and the OSM credit", async () => {
    api.post.mockResolvedValue({ data: { lat: 55.6734, lng: 12.5692, label: "Tivoli, Vesterbrogade, 1609", source: "place_name", provider: "osm" } });
    renderFind();
    await find("Tivoli, København");
    expect((await screen.findByTestId("geo-osm-credit")).textContent).toBe("Map data © OpenStreetMap contributors");
    expect(screen.getByText(/Found by name on a public map/)).toBeTruthy();
    expect(screen.queryByTestId("geo-register-credit")).toBeNull();
  });

  it.each([
    [{ status: 424, data: { detail: { error: "lookup_unavailable" } } }, "The address lookup isn't answering right now. Try again in a few minutes, or paste a map link."],
    [{ status: 404, data: { detail: { error: "not_found", reason: "street_only" } } }, "We found the street, but not that house number. Paste a map link, or stand at the venue and use your location."],
    [{ status: 404, data: { detail: { error: "not_found", reason: "need_postcode" } } }, "That address exists in more than one town. Add the postcode."],
    [{ status: 404, data: { detail: { error: "not_found", reason: "postcode_mismatch" } } }, "Couldn't find that. Not every venue is on the map — type your street address instead, or paste a map link."],
    [{ status: 404, data: { detail: { error: "not_found" } } }, "Couldn't find that. Not every venue is on the map — type your street address instead, or paste a map link."],
  ])("refusal %#: the owner is told why, never 'Couldn't save'", async (response, text) => {
    api.post.mockRejectedValue({ response });
    renderFind();
    await find("Algade 1, 9000 Aalborg");
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText("Couldn't save. Try again.")).toBeNull();
  });
});

// ── market comparison: the honest setup hint ─────────────────────────────

describe("Market comparison — setup_hint", () => {
  it("SmartPricingCard says the address must be checked, with a Profile link", () => {
    render(<MemoryRouter><SmartPricingCard currencyCode="DKK" comparison={{
      canonical_name: "cappuccino", available: false, reason: "needs_setup",
      setup_hint: "address_unverified", min_samples: 5,
    }} /></MemoryRouter>);
    expect(screen.getByText(/Market comparison needs your address checked in Danmarks Adresseregister/)).toBeTruthy();
    // Review P3: straight to the company section, not the top of Profile
    // (App.jsx scrolls to the #business SectionAnchor).
    expect(screen.getByTestId("pricing-address-hint-link").getAttribute("href")).toBe("/profile#business");
  });

  it("without the hint the old setup copy stays", () => {
    render(<MemoryRouter><SmartPricingCard currencyCode="DKK" comparison={{
      canonical_name: "cappuccino", available: false, reason: "needs_setup", min_samples: 5,
    }} /></MemoryRouter>);
    expect(screen.getByText("Add your postal code and cuisine in Profile to see market comparisons.")).toBeTruthy();
    expect(screen.queryByTestId("pricing-address-hint-link")).toBeNull();
  });
});
