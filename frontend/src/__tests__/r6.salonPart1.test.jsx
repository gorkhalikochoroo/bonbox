/**
 * R6 — Salon, part 1 (27 Oct 2026).
 *
 *  • S2  a service is edited in place: Rediger → name, length, price → Gem.
 *        Only what changed is sent; an emptied price is cleared (null).
 *  • S3  Starttider every 15 or 30 min, saved on one tap.
 *  • S8  Pause mellem kunder 0/5/10/15, saved on one tap.
 *  • S7  next week with no published shift: a warning with one-tap
 *        "Kopiér sidste uge" (it lands as Kladde — the card then sends the
 *        owner to Udgiv in Vagtplan, on that week).
 *  • S6  appointments on a stylist's Ferie / Syg day, each with "Flyt".
 *  • S10 the guest page's day strip asks with the chosen service.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: vi.fn(() => Promise.resolve({ data: {} })),
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
  return { ...real, useAuth: () => ({ user: { business_type: "salon", role: "owner" }, logout: vi.fn(), refreshUser: vi.fn() }) };
});

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const BehandlingRowMod = await import("../components/reservations/BehandlingRow");
const BehandlingRow = BehandlingRowMod.default;
const { behandlingChanges } = BehandlingRowMod;
const RhythmMod = await import("../components/reservations/SalonRhythmCard");
const SalonRhythmCard = RhythmMod.default;
const { exampleTimes } = RhythmMod;
const AttentionMod = await import("../components/reservations/SalonAttention");
const SalonAttention = AttentionMod.default;
const { weekNeedsShifts, scheduleWeekHref, clockText } = AttentionMod;
const { weekFromQuery } = await import("../pages/StaffSchedulePage");
const { fmtClosureRange } = await import("../utils/closures");
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;

// The same t the components get from the page: DA strings, {vars} filled.
const t = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  localStorage.clear();
});
afterEach(() => cleanup());

const KLIP = { id: "b1", name: "Klip", duration_min: 30, price_kr: 399, active: true };

// ── Edit a service in place ───────────────────────────────────────────────
describe("behandlingChanges", () => {
  it("sends only what changed", () => {
    expect(behandlingChanges(KLIP, { name: "Klip", duration: "45", price: "399" })).toEqual({ changes: { duration_min: 45 } });
    expect(behandlingChanges(KLIP, { name: " Klip dame ", duration: "30", price: "450" }))
      .toEqual({ changes: { name: "Klip dame", price_kr: 450 } });
  });
  it("an emptied price is cleared", () => {
    expect(behandlingChanges(KLIP, { name: "Klip", duration: "30", price: "" })).toEqual({ changes: { price_kr: null } });
  });
  it("nothing changed is nothing to send", () => {
    expect(behandlingChanges(KLIP, { name: "Klip", duration: "30", price: "399" })).toEqual({ changes: {} });
  });
  it("refuses a blank name and a length outside 15–600", () => {
    expect(behandlingChanges(KLIP, { name: "  ", duration: "30", price: "" })).toEqual({ error: "name" });
    expect(behandlingChanges(KLIP, { name: "Klip", duration: "10", price: "" })).toEqual({ error: "duration" });
    expect(behandlingChanges(KLIP, { name: "Klip", duration: "700", price: "" })).toEqual({ error: "duration" });
    expect(behandlingChanges(KLIP, { name: "Klip", duration: "", price: "" })).toEqual({ error: "duration" });
  });
});

function mountRow(props = {}) {
  const onSaved = vi.fn();
  render(<ul><BehandlingRow b={KLIP} t={t} onToggle={vi.fn()} onRemove={vi.fn()} onSaved={onSaved} {...props} /></ul>);
  return { onSaved };
}

describe("a service row edits in place", () => {
  it("Rediger, a new length, Gem: one PATCH with only the length", async () => {
    h.patch.mockResolvedValue({ data: { ...KLIP, duration_min: 45 } });
    const { onSaved } = mountRow();
    fireEvent.click(screen.getByRole("button", { name: "Rediger Klip" }));               // tap 1
    const len = screen.getByRole("textbox", { name: da.rsvpBehandlingDurationLabel });
    expect(len.value).toBe("30");
    fireEvent.change(len, { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: da.save }));                        // tap 2
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...KLIP, duration_min: 45 }));
    expect(h.patch).toHaveBeenCalledWith("/reservations/behandlinger/b1", { duration_min: 45 });
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("Klip")).toBeTruthy();
  });

  it("says that booked appointments keep their length", () => {
    mountRow();
    fireEvent.click(screen.getByTestId("behandling-edit"));
    expect(screen.getByText(da.rsvpBehandlingEditKeepsBooked)).toBeTruthy();
  });

  it("an emptied price is sent as null", async () => {
    h.patch.mockResolvedValue({ data: { ...KLIP, price_kr: null } });
    mountRow();
    fireEvent.click(screen.getByTestId("behandling-edit"));
    fireEvent.change(screen.getByRole("textbox", { name: da.rsvpBehandlingPriceLabel }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: da.save }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith("/reservations/behandlinger/b1", { price_kr: null }));
  });

  it("a blank name is refused on the spot, nothing is sent", () => {
    mountRow();
    fireEvent.click(screen.getByTestId("behandling-edit"));
    fireEvent.change(screen.getByRole("textbox", { name: da.rsvpBehandlingNameLabel }), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: da.save }));
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpBehandlingNameRequired);
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("a length out of range is refused on the spot", () => {
    mountRow();
    fireEvent.click(screen.getByTestId("behandling-edit"));
    fireEvent.change(screen.getByRole("textbox", { name: da.rsvpBehandlingDurationLabel }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: da.save }));
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpBehandlingDurationRange);
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("Annuller and Escape leave the service as it was", () => {
    mountRow();
    fireEvent.click(screen.getByTestId("behandling-edit"));
    fireEvent.click(screen.getByRole("button", { name: da.cancel }));
    expect(screen.queryByRole("button", { name: da.save })).toBeNull();
    fireEvent.click(screen.getByTestId("behandling-edit"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: da.rsvpBehandlingNameLabel }), { key: "Escape" });
    expect(screen.queryByRole("button", { name: da.save })).toBeNull();
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("a failed save says so and keeps the form", async () => {
    h.patch.mockRejectedValue({ response: { status: 500 } });
    mountRow();
    fireEvent.click(screen.getByTestId("behandling-edit"));
    fireEvent.change(screen.getByRole("textbox", { name: da.rsvpBehandlingDurationLabel }), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: da.save }));
    expect((await screen.findByRole("alert")).textContent).toBe(da.rsvpBehandlingSaveError);
    expect(screen.getByRole("button", { name: da.save })).toBeTruthy();
  });

  it("keeps Aktiv and delete on the row", () => {
    const onToggle = vi.fn();
    const onRemove = vi.fn();
    mountRow({ onToggle, onRemove });
    fireEvent.click(screen.getByRole("button", { name: da.rsvpBehandlingActiveLabel }));
    fireEvent.click(screen.getByRole("button", { name: da.delete }));
    expect(onToggle).toHaveBeenCalledWith(KLIP);
    expect(onRemove).toHaveBeenCalledWith(KLIP);
  });
});

// ── Starttider and the pause ──────────────────────────────────────────────
describe("Tider for aftaler", () => {
  it("writes example times the way the owner reads a clock", () => {
    expect(exampleTimes(30, "da")).toEqual(["10.00", "10.30", "11.00"]);
    expect(exampleTimes(15, "en")).toEqual(["10:00", "10:15", "10:30"]);
  });

  it("shows what is stored and saves a new start step on one tap", async () => {
    const onSaved = vi.fn();
    h.put.mockResolvedValue({ data: { settings: { slot_granularity_min: 15, service_buffer_min: 0 } } });
    render(<SalonRhythmCard t={t} lang="da" settings={{ slot_granularity_min: 30, service_buffer_min: 0 }} onSaved={onSaved} />);
    const steps = screen.getByRole("radiogroup", { name: da.rsvpStartTimesLabel });
    expect(within(steps).getByRole("radio", { name: "Hvert 30. min" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Kunderne kan vælge 10.00, 10.30, 11.00 …")).toBeTruthy();
    fireEvent.click(within(steps).getByRole("radio", { name: "Hvert 15. min" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.put).toHaveBeenCalledWith("/reservations/settings", { settings: { slot_granularity_min: 15 } });
  });

  it("saves the pause on one tap and says what it does", async () => {
    h.put.mockResolvedValue({ data: { settings: { slot_granularity_min: 30, service_buffer_min: 10 } } });
    const { rerender } = render(<SalonRhythmCard t={t} lang="da" settings={{ slot_granularity_min: 30, service_buffer_min: 0 }} onSaved={vi.fn()} />);
    expect(screen.getByText(da.rsvpBufferHintNone)).toBeTruthy();
    const pause = screen.getByRole("radiogroup", { name: da.rsvpBufferLabel });
    expect(within(pause).getAllByRole("radio").map((b) => b.textContent)).toEqual(["Ingen", "5 min", "10 min", "15 min"]);
    fireEvent.click(within(pause).getByRole("radio", { name: "10 min" }));
    await waitFor(() => expect(h.put).toHaveBeenCalledWith("/reservations/settings", { settings: { service_buffer_min: 10 } }));
    rerender(<SalonRhythmCard t={t} lang="da" settings={{ slot_granularity_min: 30, service_buffer_min: 10 }} onSaved={vi.fn()} />);
    expect(screen.getByText(da.rsvpBufferHint)).toBeTruthy();
  });

  it("tapping the stored choice sends nothing", () => {
    render(<SalonRhythmCard t={t} lang="da" settings={{ slot_granularity_min: 30, service_buffer_min: 0 }} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Hvert 30. min" }));
    fireEvent.click(screen.getByRole("radio", { name: "Ingen" }));
    expect(h.put).not.toHaveBeenCalled();
  });

  it("a failed save says so", async () => {
    h.put.mockRejectedValue({ response: { status: 500 } });
    render(<SalonRhythmCard t={t} lang="da" settings={{ slot_granularity_min: 30, service_buffer_min: 0 }} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Hvert 15. min" }));
    expect((await screen.findByRole("alert")).textContent).toBe(da.rsvpSettingsSaveError);
  });

  it("a step stored some other way is shown as the one that applies", () => {
    render(<SalonRhythmCard t={t} lang="da" settings={{ slot_granularity_min: 60 }} onSaved={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Hvert 60. min" }).getAttribute("aria-checked")).toBe("true");
  });
});

// ── What needs the owner's attention ──────────────────────────────────────
function attention(data) {
  h.get.mockImplementation((url) => (url === "/reservations/salon/attention"
    ? (data instanceof Error ? Promise.reject(data) : Promise.resolve({ data }))
    : Promise.resolve({ data: {} })));
}
const NONE = { count: 0, items: [] };
const EMPTY_WEEK = { week_start: "2026-11-02", this_week_start: "2026-10-26", stylists: 1, published: 0, drafts: 0, this_week: 4 };
function mountAttention(props = {}) {
  return render(<MemoryRouter><SalonAttention t={t} lang="da" {...props} /></MemoryRouter>);
}

describe("next week without published shifts", () => {
  it("only when a stylist works shifts and none is published", () => {
    expect(weekNeedsShifts(null)).toBe(false);
    expect(weekNeedsShifts({ stylists: 0, published: 0 })).toBe(false);
    expect(weekNeedsShifts({ stylists: 2, published: 1 })).toBe(false);
    expect(weekNeedsShifts({ stylists: 2, published: 0 })).toBe(true);
    expect(scheduleWeekHref("2026-11-02")).toBe("/staff/schedule?week=2026-11-02");
  });

  it("warns and copies this week into next week on one tap, then sends the owner to Udgiv", async () => {
    attention({ next_week: EMPTY_WEEK, absence_conflicts: NONE });
    h.post.mockResolvedValue({ data: { copied: 4, skipped: 0, skipped_overlap: 0, skipped_absence: 0 } });
    mountAttention();
    const card = await screen.findByTestId("salon-week-empty");
    expect(within(card).getByText(da.rsvpWeekEmptyTitle)).toBeTruthy();
    expect(card.textContent).toContain(`Fra mandag ${fmtClosureRange("2026-11-02", null, "da")} kan kunderne ikke booke`);
    fireEvent.click(within(card).getByRole("button", { name: da.rsvpWeekCopyBtn }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/staff/schedules/copy-week", {
      source_week: "2026-10-26", target_week: "2026-11-02",
    }));
    await screen.findByText(t("rsvpWeekCopiedN", "", { n: 4 }));
    const link = screen.getByTestId("salon-week-publish");
    expect(link.getAttribute("href")).toBe("/staff/schedule?week=2026-11-02");
    expect(link.textContent).toContain(da.rsvpWeekPublishCta);
  });

  it("names who was left out of the copy", async () => {
    attention({ next_week: EMPTY_WEEK, absence_conflicts: NONE });
    h.post.mockResolvedValue({ data: { copied: 3, skipped_absence: 1, skipped_absence_names: ["Mia"], skipped_overlap: 0 } });
    mountAttention();
    fireEvent.click(await screen.findByRole("button", { name: da.rsvpWeekCopyBtn }));
    await screen.findByText((txt) => txt.includes("1 sprunget over (fravær eller overlap): Mia"));
  });

  it("an empty this week: nothing to copy", async () => {
    attention({ next_week: EMPTY_WEEK, absence_conflicts: NONE });
    h.post.mockRejectedValue({ response: { status: 404 } });
    mountAttention();
    fireEvent.click(await screen.findByRole("button", { name: da.rsvpWeekCopyBtn }));
    await screen.findByText(da.schedCopyNothing);
  });

  it("drafts already there: Udgiv, not another copy", async () => {
    attention({ next_week: { ...EMPTY_WEEK, drafts: 3 }, absence_conflicts: NONE });
    mountAttention();
    await screen.findByText(t("rsvpWeekDraftsN", "", { n: 3 }));
    expect(screen.queryByRole("button", { name: da.rsvpWeekCopyBtn })).toBeNull();
    expect(screen.getByTestId("salon-week-publish").getAttribute("href")).toBe("/staff/schedule?week=2026-11-02");
  });

  it("nothing this week either: a link to plan shifts", async () => {
    attention({ next_week: { ...EMPTY_WEEK, this_week: 0 }, absence_conflicts: NONE });
    mountAttention();
    await screen.findByText(da.rsvpWeekPlanCta);
    expect(screen.queryByRole("button", { name: da.rsvpWeekCopyBtn })).toBeNull();
  });

  it("a published next week, a self-chair salon or a failed read: no card", async () => {
    for (const data of [
      { next_week: { ...EMPTY_WEEK, published: 2 }, absence_conflicts: NONE },
      { next_week: null, absence_conflicts: NONE },
      new Error("offline"),
    ]) {
      attention(data);
      const { unmount } = mountAttention();
      await settle();
      expect(screen.queryByTestId("salon-attention")).toBeNull();
      unmount();
    }
  });
});

describe("appointments on a stylist's absence day", () => {
  const item = (i, extra = {}) => ({
    id: `r${i}`, day: "2026-10-31", time: "14:00", guest_name: `Kunde ${i}`,
    service_name: "Klip", stylist: "Mia", kind: "ferie", status: "confirmed", ...extra,
  });

  it("lists each with its day, service, stylist and why — and Flyt opens it", async () => {
    attention({ next_week: null, absence_conflicts: { count: 1, items: [item(1)] } });
    const onOpenBooking = vi.fn();
    mountAttention({ onOpenBooking });
    const card = await screen.findByTestId("salon-absence-conflicts");
    expect(within(card).getByText(da.rsvpAbsenceConflictsOne)).toBeTruthy();
    const row = within(card).getByTestId("salon-absence-conflict");
    expect(row.textContent).toContain("Kunde 1");
    expect(row.textContent).toContain(`${fmtClosureRange("2026-10-31", null, "da")} 14.00 · Klip · Mia (Ferie)`);
    // The why is never cut off: the details line wraps (judge 27 Oct: "Mia (F…" at 390).
    const details = within(row).getByText((txt) => txt.includes("Mia (Ferie)"));
    expect(details.className).not.toContain("truncate");
    expect(details.className).toContain("break-words");
    fireEvent.click(within(row).getByRole("button", { name: "Flyt aftalen med Kunde 1" }));
    expect(onOpenBooking).toHaveBeenCalledWith(item(1));
  });

  it("shows five and counts the rest", async () => {
    const items = Array.from({ length: 7 }, (_, i) => item(i + 1, { kind: i % 2 ? "sick" : "ferie" }));
    attention({ next_week: null, absence_conflicts: { count: 9, items } });
    mountAttention();
    await screen.findByText(t("rsvpAbsenceConflictsN", "", { n: 9 }));
    expect(screen.getAllByTestId("salon-absence-conflict")).toHaveLength(5);
    expect(screen.getByText("+4 flere")).toBeTruthy();
  });

  it("a guest's link in the name is shown defanged, never as a link", async () => {
    attention({ next_week: null, absence_conflicts: { count: 1, items: [item(1, { guest_name: "Bo www.spam.example" })] } });
    mountAttention();
    const row = await screen.findByTestId("salon-absence-conflict");
    expect(row.querySelector("a")).toBeNull();
    expect(row.textContent).not.toContain("www.spam.example");
  });

  it("re-reads when the book changes", async () => {
    attention({ next_week: null, absence_conflicts: { count: 1, items: [item(1)] } });
    const { rerender } = render(<MemoryRouter><SalonAttention t={t} lang="da" refreshKey={1} /></MemoryRouter>);
    await screen.findByTestId("salon-absence-conflicts");
    attention({ next_week: null, absence_conflicts: NONE });
    rerender(<MemoryRouter><SalonAttention t={t} lang="da" refreshKey={2} /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByTestId("salon-absence-conflicts")).toBeNull());
  });

  it("a time reads with a dot in Danish", () => {
    expect(clockText("09:30", "da")).toBe("09.30");
    expect(clockText("09:30", "en")).toBe("09:30");
  });
});

// ── Vagtplan opens on the week the card points at ─────────────────────────
describe("Vagtplan ?week=", () => {
  it("reads a real date and nothing else", () => {
    expect(weekFromQuery("?week=2026-11-02").getDate()).toBe(2);
    for (const q of ["", "?week=", "?week=2026-13-01", "?week=2026-02-30", "?week=tomorrow", "?w=2026-11-02"]) {
      expect(weekFromQuery(q), q).toBeNull();
    }
  });
});

// ── The guest page's strip asks with the chosen service ───────────────────
describe("the salon page's day strip", () => {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  it("sends the chosen behandling with the summary", async () => {
    const today = new Date();
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/saks") {
        return Promise.resolve({ data: { business_name: "Frisør Saks", business_type: "salon", providers: [{ id: "r1", name: "Mia" }], max_party_size: 10, max_advance_days: 60, lead_time_min: 60, language: "da" } });
      }
      if (url === "/public/reservations/saks/behandlinger") {
        return Promise.resolve({ data: { behandlinger: [{ id: "b1", name: "Dameklip", duration_min: 45, price_kr: 450 }] } });
      }
      if (url === "/public/reservations/saks/availability-summary") {
        return Promise.resolve({ data: { next_open_day: iso(today), days: [{ date: iso(today), has_slots: true, reason: null }] } });
      }
      if (url === "/public/reservations/saks/provider-availability") return Promise.resolve({ data: { slots: [] } });
      return Promise.resolve({ data: {} });
    });
    window.scrollTo = () => {};
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    render(
      <MemoryRouter initialEntries={["/r/saks"]}>
        <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
      </MemoryRouter>,
    );
    await settle(14);
    expect(h.get).toHaveBeenCalledWith("/public/reservations/saks/availability-summary", {
      params: expect.objectContaining({ party: 1, behandling_id: "b1" }),
    });
  });
});

// ── The words ─────────────────────────────────────────────────────────────
describe("the R6 words", () => {
  const KEYS = [
    "rsvpBehandlingEdit", "rsvpBehandlingEditAria", "rsvpBehandlingEditTitle", "rsvpBehandlingEditKeepsBooked",
    "rsvpBehandlingDurationRange", "rsvpBehandlingSaveError", "rsvpRhythmTitle", "rsvpRhythmIntro",
    "rsvpStartTimesLabel", "rsvpStartTimesEvery", "rsvpStartTimesExample", "rsvpBufferLabel", "rsvpBufferNone",
    "rsvpBufferMin", "rsvpBufferHint", "rsvpBufferHintNone", "rsvpWeekEmptyTitle", "rsvpWeekEmptyBody",
    "rsvpWeekCopyBtn", "rsvpWeekCopiedOne", "rsvpWeekCopiedN", "rsvpWeekCopiedNone", "rsvpWeekCopySkipped",
    "rsvpWeekDraftsOne", "rsvpWeekDraftsN", "rsvpWeekPublishCta", "rsvpWeekPlanCta", "rsvpAbsenceConflictsOne",
    "rsvpAbsenceConflictsN", "rsvpAbsenceConflictsBody", "rsvpAbsenceConflictMove", "rsvpAbsenceConflictMoveAria",
    "rsvpAbsenceConflictsMore",
  ];
  it("exist in en and da", () => {
    for (const k of KEYS) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).toBeTruthy();
    }
  });
  it("are Danish in da and English in en where the words differ", () => {
    expect(da.rsvpWeekCopyBtn).toBe("Kopiér sidste uge");
    expect(da.rsvpStartTimesLabel).toBe("Starttider");
    expect(da.rsvpBufferLabel).toBe("Pause mellem kunder");
    expect(da.rsvpWeekPublishCta).toBe("Udgiv i Vagtplan");
    expect(da.rsvpWeekCopiedN).toContain("kladde");
    expect(en.rsvpWeekCopyBtn).toBe("Copy last week");
    expect(en.rsvpWeekPublishCta).toBe("Publish in Schedule");
    for (const k of KEYS.filter((k) => !["rsvpBufferMin"].includes(k))) {
      expect(da[k], k).not.toBe(en[k]);
    }
  });
});
