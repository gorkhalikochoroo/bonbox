/**
 * R1a fix round (24 Oct 2026) — what a guest typed is kept, and shown with
 * its links defanged on the owner's screens.
 *
 * The blocker: R1 rewrote anything link-like in a booking to "[link]" when it
 * was saved, and "Glutenfri.Laktosefri.Nøddeallergi" lost the allergy. Now the
 * server stores the guest's words exactly as typed, and a link is made
 * harmless only where it is SHOWN: utils/guestText.js (the e-mails do the same
 * in backend app/utils/text.py, and a backend test keeps the ending lists
 * equal). Display only — the edit form keeps the raw text, so a save never
 * writes "[.]" back.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPLAY_TLDS, defangLinks, guestText } from "../utils/guestText";

const HOSTISH = new RegExp(`https?://|www\\.|[\\p{L}\\p{N}_-]\\.(?:${DISPLAY_TLDS})(?![\\p{L}\\p{N}_])`, "iu");

describe("defangLinks — the owner's screens", () => {
  it.each([
    "evil.com", "login.bonbox-refund.com/claim", "www2.evil.com", "my.evil.dk", "claim-prize.eu",
    "evil.co.uk", "1.2.3.4/login", "t.me/x", "wa.me/4512345678", "evil。com",
    "Mette secure.mobilepay-refund.dk/x", "WIN cash.xyz", "https://bit.ly/abc", "ｅｖｉｌ.com",
    "https://secure-refund.com/claim?u=@me", "https://user@evil.com/login", "user@evil.com/login",
    "evil.com/claim@x", "secure-pay.zip", "bonbox-refund.lol", "refund.nu",
    "secure.mobilepay-refund.rocks", "evil.lol/claim", "evil.com:8080/x", "www.evil.dk",
    // an ending no list names, with a path after it: a link all the same
    "refund.banana/claim", "secure.pay-dk.zzz/login",
  ])("defangs %s", (link) => {
    const out = defangLinks(`Se ${link} nu`);
    expect(out).not.toBe(`Se ${link} nu`);
    expect(out).not.toMatch(HOSTISH);
    expect(defangLinks(out)).toBe(out);
  });

  it.each([
    "Glutenfri.Laktosefri.Nøddeallergi", "Anne.Marie.Jensen", "Hans.Chr.Andersen",
    "Vi kommer kl.19.Vi er 4", "kl.19.30 tak", "f.eks. nødder, bl.a. mandler",
    "Skaldyrsallergi.Meget alvorlig", "anna@cafe.dk", "ring 12.34.56.78", "J.P.Hansen",
    "Første linje\nAnden linje",
  ])("shows %s exactly as typed", (text) => {
    expect(defangLinks(text)).toBe(text);
  });

  // The same answers as the e-mails (backend defang_links), pair by pair.
  it.each([
    ["https://secure-refund.com/claim?u=@me", "hxxps://secure-refund[.]com/claim?u=@me"],
    ["Jordnødder.De skal undgås helt", "Jordnødder[.]De skal undgås helt"],
    ["login.bonbox-refund.com", "login[.]bonbox-refund[.]com"],
    ["ｅｖｉｌ．ｃｏｍ", "evil[.]com"],
    ["www.evil.dk", "www[.]evil[.]dk"],
    ["Ole Hansen (firma.dk)", "Ole Hansen (firma[.]dk)"],
    ["user@evil.com/login", "user@evil[.]com/login"],
    ["evil.com.Glutenfri", "evil[.]com.Glutenfri"],
    ["x.dk/http://evil2.com", "x[.]dk/hxxp://evil2[.]com"],
    ["a\nb evil.com\nc", "a\nb evil[.]com\nc"],
  ])("%s → %s", (input, shown) => {
    expect(defangLinks(input)).toBe(shown);
  });

  it("passes anything that is not text through untouched", () => {
    expect(guestText(null)).toBe(null);
    expect(guestText(undefined)).toBe(undefined);
    expect(guestText("")).toBe("");
  });

  it("stays linear on a long note", () => {
    const t0 = performance.now();
    for (const note of ["a.".repeat(1000), "ab.".repeat(700), "abc.d".repeat(400), "a@".repeat(1000)]) {
      defangLinks(note);
    }
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

// ── The book, the drawer, the edit form ────────────────────────────────
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), confirm: vi.fn(), toast: vi.fn() }));
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useToast: () => h.toast };
});

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const soon = new Date(Date.now() + 3 * 3600000);

const PHISH = {
  guest_name: "Mette secure.refund-dk.com",
  guest_notes: "Klik login.mobilepay-refund.dk/x for refusion",
  allergy_note: "Nødder — se https://evil.com/allergi",
  occasion: "Fødselsdag www.evil-party.dk",
};
const RAW = ["secure.refund-dk.com", "login.mobilepay-refund.dk", "https://evil.com", "www.evil-party.dk"];

function routes() {
  const rows = [
    { id: "p1", ...PHISH, guest_email: "mette@example.dk", party_size: 2, status: "confirmed", source: "public",
      resource_id: "t1", combined_resource_ids: null, allergen_tags: ["nuts"], allergy_severity: "severe",
      guest_mailed: true, starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 90 * 60000)) },
    { id: "p2", guest_name: "Glutenfri Gæst", guest_notes: "Glutenfri.Laktosefri.Nøddeallergi",
      allergy_note: "Glutenfri.Laktosefri.Nøddeallergi", party_size: 2, status: "confirmed", source: "public",
      resource_id: "t1", combined_resource_ids: null, allergen_tags: [], guest_mailed: true,
      starts_at: localIso(new Date(soon.getTime() + 2 * 3600000)),
      ends_at: localIso(new Date(soon.getTime() + 3.5 * 3600000)) },
  ];
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: { reservations_enabled: true, reservation_slug: "havnen", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures: [], public_name: "Havnen" } });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: rows, summary: { total: 2, by_status: { confirmed: 2 } } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.confirm.mockReset(); h.confirm.mockResolvedValue(true); h.toast.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("the owner's book shows a guest's links defanged", () => {
  it("in the book and the drawer — and the edit form keeps the guest's own words", async () => {
    routes();
    render(
      <MemoryRouter initialEntries={["/reservations"]}>
        <ReservationsPage />
      </MemoryRouter>,
    );
    await settle();
    // The book: names, notes, tooltips and labels — nowhere a raw host.
    for (const raw of RAW) expect(document.body.innerHTML).not.toContain(raw);
    expect(document.body.textContent).toContain("Mette secure[.]refund-dk[.]com");
    // A dotted allergy note is the guest's own words, untouched.
    expect(document.body.innerHTML).toContain("Glutenfri.Laktosefri.Nøddeallergi");

    await act(async () => { fireEvent.click(screen.getAllByText("Mette secure[.]refund-dk[.]com")[0]); });
    await settle(4);
    for (const raw of RAW) expect(document.body.innerHTML).not.toContain(raw);
    expect(document.body.textContent).toContain("login[.]mobilepay-refund[.]dk/x");
    expect(document.body.textContent).toContain("www[.]evil-party[.]dk");

    // Edit: the fields carry the RAW text, so a save writes back what was
    // stored — never "[.]".
    const edit = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === da.rsvpEditAction);
    expect(edit).toBeTruthy();
    await act(async () => { fireEvent.click(edit); });
    await settle(4);
    const values = [...document.querySelectorAll("input, textarea")].map((el) => el.value);
    expect(values).toContain(PHISH.guest_name);
    expect(values).toContain(PHISH.guest_notes);
    expect(values.some((v) => v.includes("[.]"))).toBe(false);
  });
});
