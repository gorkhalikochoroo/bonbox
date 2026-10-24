/**
 * R1 fix round (24 Oct 2026) — the pause, on the owner's side.
 *
 *  • While a pause covers today the online card said "Din offentlige side er
 *    live og tager imod bookinger" right above the amber pause line (review).
 *    It now says the page is live but online booking is paused, and until
 *    when.
 *  • In English at 375 px the pause row's Save ran 33 px past the screen
 *    (review, geom-pause-row): the label now has its own line on a phone and
 *    the date field gives way (min-w-0) — measured in the runtime walk, the
 *    classes that do it are pinned here.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayIso } from "../utils/closures";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
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
  return { ...real, useAuth: () => ({ user: { business_type: "restaurant", business_name: "Havnen" }, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { PauseControl } = await import("../components/reservations/ClosuresCard");
const { da } = await import("../i18n/da");

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const plusDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return todayIso(d);
};

function routes(closures) {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: {
        reservations_enabled: true, reservation_slug: "havnen", public_url: "https://x/havnen",
        business_name: "Havnen", public_name: "Havnen", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures, open_hours: {},
      } });
    }
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    return Promise.resolve({ data: {} });
  });
}
const mountSettings = async () => {
  render(
    <MemoryRouter initialEntries={["/reservations?tab=settings"]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
  await settle();
  return screen.getByTestId("rsvp-accept-sub").textContent;
};

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("the online card while paused", () => {
  it("not paused: live and taking bookings", async () => {
    routes([]);
    expect(await mountSettings()).toBe(da.rsvpAcceptOn);
  });

  it("paused for the rest of today: says so, never 'tager imod bookinger'", async () => {
    routes([{ id: "p1", from: todayIso(), to: todayIso(), note: null, kind: "pause", bookings: 0 }]);
    const sub = await mountSettings();
    expect(sub).toBe(da.rsvpAcceptOnPausedToday);
    expect(sub).not.toContain("tager imod bookinger");
  });

  it("paused until a later day: names it", async () => {
    routes([{ id: "p2", from: todayIso(), to: plusDays(2), note: null, kind: "pause", bookings: 0 }]);
    const sub = await mountSettings();
    expect(sub.startsWith(da.rsvpAcceptOnPaused.split("{date}")[0])).toBe(true);
    expect(sub).not.toContain("{date}");
  });

  it("a closed date (not a pause) leaves the card as it was", async () => {
    routes([{ id: "c1", from: plusDays(3), to: plusDays(3), note: "Lukket", kind: "closed", bookings: 0 }]);
    expect(await mountSettings()).toBe(da.rsvpAcceptOn);
  });
});

describe("the pause row on a phone", () => {
  it("the label has its own line and the date field gives way", async () => {
    const t = (k, fb) => da[k] ?? fb;
    render(<PauseControl t={t} lang="da" closures={[]} onChanged={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-pause-open")); });
    const row = screen.getByTestId("rsvp-pause-until-row");
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(row.className).toMatch(/\bmin-w-0\b/);
    const label = row.querySelector('label[for="rsvp-pause-until"]');
    expect(label).toBeTruthy();
    expect(label.className).toMatch(/\bw-full\b/);
    expect(label.className).not.toMatch(/\bsr-only\b/);
    expect(screen.getByTestId("rsvp-pause-until").className).toMatch(/\bmin-w-0\b/);
    expect(screen.getByTestId("rsvp-pause-save").className).toMatch(/\bshrink-0\b/);
  });
});
