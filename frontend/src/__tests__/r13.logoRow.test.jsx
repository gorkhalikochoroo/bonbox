/**
 * Booking R13 — the logo row in Reservationer → Indstillinger, next to
 * "Navn på bookingsiden" (Manoj, 27 Oct): the logo the booking page shows
 * (GET /business/brand, a signed link) or the page's monogram, and a link to
 * Profil → Brand — "Skift logo" with a logo, "Tilføj logo" without. Never an
 * error the owner can do nothing about here. Real en + da.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../services/api", () => ({ default: { get: (...a) => h.get(...a), post: vi.fn(), patch: vi.fn() } }));

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const BookingLogoRow = (await import("../components/reservations/BookingLogoRow")).default;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tOf = (dict) => (k) => dict[k] ?? k;

beforeEach(() => {
  h.get.mockReset();
});
afterEach(() => {
  cleanup();
});

function renderLogo(t = tOf(da), name = "Café Nordlys") {
  return render(
    <MemoryRouter>
      <BookingLogoRow t={t} publicName={name} />
    </MemoryRouter>,
  );
}
describe("the logo row in Reservationer → Indstillinger", () => {
  it("with a logo: the same logo the booking page shows, and 'Skift logo' to Profil → Brand", async () => {
    h.get.mockImplementation((url) => (url === "/business/brand" ? Promise.resolve({ data: { logo_url: "https://cdn.example/logo.png" } }) : Promise.reject(new Error(url))));
    renderLogo();
    const img = await screen.findByTestId("rsvp-booking-logo-img");
    expect(img.getAttribute("src")).toBe("https://cdn.example/logo.png");
    expect(img.getAttribute("alt")).toBe("");
    const link = screen.getByTestId("rsvp-booking-logo-link");
    expect(link.getAttribute("href")).toBe("/profile#brand");
    expect(link.textContent).toBe(da.rsvpLogoChange);
    // R14 (judge, 28 Oct): the same quiet filled button as "Ret" beside it, not an outline
    expect(link.className).toContain("bg-gray-100");
    expect(link.className).not.toMatch(/(^| )border( |$)/);
    expect(screen.getByText(da.rsvpLogoLabel)).toBeTruthy();
    expect(h.get).toHaveBeenCalledWith("/business/brand");
  });

  it("without one: the page's monogram, a plain line, and 'Tilføj logo'", async () => {
    h.get.mockResolvedValue({ data: { logo_url: null } });
    renderLogo();
    const mono = await screen.findByTestId("rsvp-booking-logo-monogram");
    expect(mono.textContent).toBe("CN");
    expect(screen.getByText(da.rsvpLogoNone)).toBeTruthy();
    expect(screen.getByTestId("rsvp-booking-logo-link").textContent).toBe(da.rsvpLogoAdd);
  });

  it("a failed read (or 402) and a broken image fall back to the monogram, never an error", async () => {
    h.get.mockRejectedValue({ response: { status: 402 } });
    renderLogo();
    expect(await screen.findByTestId("rsvp-booking-logo-monogram")).toBeTruthy();
    cleanup();
    h.get.mockResolvedValue({ data: { logo_url: "https://cdn.example/gone.png" } });
    renderLogo();
    fireEvent.error(await screen.findByTestId("rsvp-booking-logo-img"));
    expect(screen.getByTestId("rsvp-booking-logo-monogram")).toBeTruthy();
    expect(screen.getByTestId("rsvp-booking-logo-link").textContent).toBe(da.rsvpLogoAdd);
  });

  it("English, and mounted right under the name, before the colour", async () => {
    h.get.mockResolvedValue({ data: {} });
    const view = renderLogo(tOf(en));
    await screen.findByTestId("rsvp-booking-logo-monogram");
    expect(view.container.textContent).toContain(en.rsvpLogoLabel);
    expect(view.container.textContent).toContain(en.rsvpLogoAdd);
    const page = read("pages/ReservationsPage.jsx");
    const at = (s) => page.indexOf(s);
    expect(at("<BookingNameRow")).toBeLessThan(at("<BookingLogoRow"));
    expect(at("<BookingLogoRow")).toBeLessThan(at("<BookingAccentRow t={t} />"));
  });
});

describe("every new key in real en + da", () => {
  it.each(["rsvpLogoLabel", "rsvpLogoNone", "rsvpLogoChange", "rsvpLogoAdd"])("%s", (k) => {
    expect(typeof en[k]).toBe("string");
    expect(typeof da[k]).toBe("string");
    expect(en[k].trim().length).toBeGreaterThan(1);
    expect(da[k]).not.toBe(en[k]);
  });
});
