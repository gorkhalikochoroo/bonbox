/**
 * The host-stand pop-out (↗) is not offered inside the iPhone/iPad app (13 Nov
 * 2026 device pass). WKWebView ignores window.open(…, "_blank"), so the button
 * did nothing — a dead end. Opening the stand in place would leave the owner on
 * a screen whose only exit is "Log ud". The web keeps it (new tab); Android's
 * WebView opens it in place and BACK returns, so Android keeps it too.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), user: null, hidden: new Set() }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: h.user, logout: vi.fn(), refreshUser: vi.fn() }) };
});
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: h.hidden, isReady: true, setPillarHidden: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../hooks/useUndoToast", () => ({ useUndoToast: () => ({ show: vi.fn(), ToastUI: null }) }));
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
const plat = vi.hoisted(() => ({ isNative: false, isIOS: false, isAndroid: false, isWeb: true }));
vi.mock("../utils/platform", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, platform: plat, isNativeApp: () => plat.isNative };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

const SETTINGS = {
  reservations_enabled: true, reservation_slug: "shop", public_url: "https://www.bonbox.dk/r/shop",
  business_name: "Butik Nord", hours_declared: true,
  settings: {
    turn_time_tiers: [{ up_to: 2, minutes: 60 }], default_duration_min: 60, max_party_size: 10,
    group_request_threshold: 8, lead_time_min: 60, max_advance_days: 60, combine_enabled: true,
    guest_can_pick_table: false, booking_hours: { mon: "00:00-23:59", tue: "00:00-23:59", wed: "00:00-23:59", thu: "00:00-23:59", fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" },
  },
};
function bookRows() {
  const now = new Date();
  const soon = new Date(now.getTime() + 60 * 60000);
  const earlier = new Date(now.getTime() - 20 * 60000);
  return [
    { id: "b1", guest_name: "Hansen", party_size: 2, status: "confirmed", resource_id: null, combined_resource_ids: null,
      starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 60 * 60000)), source: "manual" },
    { id: "b2", guest_name: "Jensen", party_size: 1, status: "seated", resource_id: null, combined_resource_ids: null,
      starts_at: localIso(earlier), ends_at: localIso(new Date(earlier.getTime() + 60 * 60000)), source: "manual" },
  ];
}
let resources = [];
let rows = [];
function routes() {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: SETTINGS });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { reservations: rows, summary: { total: rows.length, covers: 3, by_status: { confirmed: 1, seated: 1 } } } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    if (url === "/stand/links") return Promise.resolve({ data: { devices: [] } });
    if (url === "/staff/members") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.hidden = new Set();
  resources = []; rows = [];
  routes();
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
});
afterEach(() => cleanup());

const asOwner = (type) => { h.user = { id: "u1", business_type: type, business_name: "Butik Nord", role: "owner" }; };
const renderOwner = (path, type) => {
  asOwner(type);
  return render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
};
const pageText = () => document.body.textContent || "";

const cafeBook = () => {
  resources = [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }];
  rows = bookRows().map((r) => ({ ...r, resource_id: "t1" }));
};
const setPlat = (p) => Object.assign(plat, { isNative: false, isIOS: false, isAndroid: false, isWeb: false }, p);

describe("host-stand pop-out per platform", () => {
  it("web: the button is there and opens a new tab", async () => {
    setPlat({ isWeb: true });
    cafeBook();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderOwner("/reservations", "cafe");
    await settle(14);
    fireEvent.click(screen.getByRole("button", { name: da.rsvpOpenStand }));
    expect(open).toHaveBeenCalledWith("/reservations/stand", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("iPhone/iPad app: no dead button", async () => {
    setPlat({ isNative: true, isIOS: true });
    cafeBook();
    renderOwner("/reservations", "cafe");
    await settle(14);
    expect(screen.queryByRole("button", { name: da.rsvpOpenStand })).toBeNull();
    // The book itself still renders.
    expect(pageText()).toContain("Hansen");
  });

  it("Android app: kept (the WebView opens it in place, BACK returns)", async () => {
    setPlat({ isNative: true, isAndroid: true });
    cafeBook();
    renderOwner("/reservations", "cafe");
    await settle(14);
    expect(screen.getByRole("button", { name: da.rsvpOpenStand })).toBeInTheDocument();
  });
});
