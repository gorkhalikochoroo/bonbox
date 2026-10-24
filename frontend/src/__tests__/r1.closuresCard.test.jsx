/**
 * R1 B5/B6 (24 Oct 2026) — "Lukkedage og pauser" in Reservationer →
 * Indstillinger, and the pause in the online-booking card.
 *
 * Christmas was two months away and an owner could not close a date. Now:
 *   • "Luk juleaften" is two taps — the Juleaften chip (prefills the form,
 *     saves nothing), then Tilføj;
 *   • each closed date lists its note, a Pause badge for a pause, and — when
 *     bookings already sit on those days — an amber link to that day's book;
 *   • Fjern asks first (useConfirm, never window.confirm): it reopens online
 *     booking for those days;
 *   • "Sæt online booking på pause…" → "Resten af i dag" pauses today; while
 *     a pause covers today an amber line says so, with "Genoptag nu".
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ post: vi.fn(), del: vi.fn(), confirm: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: (...a) => h.del(...a) },
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));

const { default: ClosuresCard, PauseControl } = await import("../components/reservations/ClosuresCard");
const { closurePresets, fmtClosureRange, activePause } = await import("../utils/closures");
const { da } = await import("../i18n/da");

const t = (k, fb, vars) => {
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const TODAY = "2026-10-24";
// The weekday as this runtime's CLDR writes it ("tors" in current Danish
// data, "tor" in older): the format around it is what is pinned here.
const wd = (iso, loc = "da-DK") =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(loc, { weekday: "short" }).replace(/\.$/, "");
const renderCard = (props = {}) =>
  render(
    <MemoryRouter>
      <ClosuresCard t={t} lang="da" today={TODAY} closures={[]} onChanged={vi.fn()} {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  h.post.mockReset(); h.del.mockReset(); h.confirm.mockReset();
});
afterEach(() => cleanup());

describe("closure helpers", () => {
  it("presets are the next Christmas Eve, Christmas and New Year", () => {
    const p = Object.fromEntries(closurePresets(TODAY).map((x) => [x.id, x]));
    expect([p.xmasEve.from, p.xmasEve.to]).toEqual(["2026-12-24", null]);
    expect([p.xmas.from, p.xmas.to]).toEqual(["2026-12-24", "2026-12-26"]);
    expect([p.newYear.from, p.newYear.to]).toEqual(["2026-12-31", "2027-01-01"]);
    // After Christmas Eve has passed, Christmas Eve is next year's.
    const later = Object.fromEntries(closurePresets("2026-12-25").map((x) => [x.id, x]));
    expect(later.xmasEve.from).toBe("2027-12-24");
    expect(later.xmas.from).toBe("2026-12-24");          // 26 Dec is still ahead
  });

  it("dates read like a Danish owner writes them", () => {
    const thu = wd("2026-12-24");
    expect(fmtClosureRange("2026-12-24", null, "da")).toBe(`${thu} 24. dec`);
    expect(fmtClosureRange("2026-12-24", "2026-12-26", "da")).toBe(`${thu} 24.–${wd("2026-12-26")} 26. dec`);
    expect(fmtClosureRange("2026-12-31", "2027-01-01", "da")).toBe(`${thu} 31. dec–${wd("2027-01-01")} 1. jan`);
    expect(fmtClosureRange("2026-12-24", "2026-12-26", "en")).toBe("Thu 24–Sat 26 Dec");
  });

  it("activePause finds the pause covering today", () => {
    const list = [{ id: "a", from: "2026-12-24", to: "2026-12-24", kind: "closed" },
                  { id: "b", from: TODAY, to: "2026-10-26", kind: "pause" }];
    expect(activePause(list, TODAY).id).toBe("b");
    expect(activePause(list, "2026-10-27")).toBeNull();
  });
});

describe("ClosuresCard", () => {
  it("Juleaften chip, then Tilføj: two taps post the right body", async () => {
    const after = [{ id: "c3f9a1b2", from: "2026-12-24", to: "2026-12-24", note: "Lukket juleaften", kind: "closed", bookings: 0 }];
    h.post.mockResolvedValue({ data: { closures: after } });
    const onChanged = vi.fn();
    renderCard({ onChanged });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-closure-preset-xmasEve")); });   // tap 1
    expect(h.post).not.toHaveBeenCalled();                                                            // a preset saves nothing
    expect(screen.getByTestId("rsvp-closure-from").value).toBe("2026-12-24");
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-closure-add")); });             // tap 2
    expect(h.post).toHaveBeenCalledWith("/reservations/closures", {
      from: "2026-12-24", to: null, note: "Lukket juleaften", kind: "closed",
    });
    expect(onChanged).toHaveBeenCalledWith(after);
  });

  it("renders the list: dates, note, the Pause badge and the bookings link", () => {
    renderCard({ closures: [
      { id: "a1b2c3d4", from: "2026-12-24", to: "2026-12-26", note: "Lukket i julen", kind: "closed", bookings: 3 },
      { id: "e5f6a7b8", from: TODAY, to: TODAY, note: null, kind: "pause", bookings: 1 },
    ] });
    const rows = screen.getAllByTestId("rsvp-closure-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain(`${wd("2026-12-24")} 24.–${wd("2026-12-26")} 26. dec`);
    expect(rows[0].textContent).toContain("Lukket i julen");
    const links = screen.getAllByTestId("rsvp-closure-bookings");
    expect(links[0].getAttribute("href")).toBe("/reservations?date=2026-12-24");
    expect(links[0].textContent).toBe("3 bookinger ligger allerede på disse dage. Se dem");
    expect(links[1].textContent).toBe(da.rsvpClosureBookingsOne);
    expect(within(rows[1]).getByText(da.rsvpPauseBadge)).toBeTruthy();
  });

  it("the empty state", () => {
    renderCard();
    expect(screen.getByTestId("rsvp-closures-empty").textContent).toBe(da.rsvpClosureEmpty);
  });

  it("Fjern goes through useConfirm and deletes only on yes", async () => {
    const onChanged = vi.fn();
    const c = { id: "a1b2c3d4", from: "2026-12-24", to: "2026-12-24", note: null, kind: "closed", bookings: 0 };
    h.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    h.del.mockResolvedValue({ data: { closures: [] } });
    renderCard({ closures: [c], onChanged });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-closure-remove")); });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0].message).toBe(`Åbn ${wd("2026-12-24")} 24. dec for online-booking igen?`);
    expect(h.del).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-closure-remove")); });
    expect(h.del).toHaveBeenCalledWith("/reservations/closures/a1b2c3d4");
    expect(onChanged).toHaveBeenCalledWith([]);
  });

  it("a refused add says why", async () => {
    h.post.mockRejectedValue({ response: { status: 422, data: { detail: { error: "too_many" } } } });
    renderCard();
    await act(async () => { fireEvent.change(screen.getByTestId("rsvp-closure-from"), { target: { value: "2026-11-02" } }); });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-closure-add")); });
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpClosureErrTooMany);
  });
});

describe("PauseControl", () => {
  it("Resten af i dag pauses today; Genoptag nu resumes without a confirm", async () => {
    const paused = [{ id: "9e0d4c11", from: TODAY, to: TODAY, note: null, kind: "pause", bookings: 0 }];
    h.post.mockResolvedValue({ data: { closures: paused } });
    h.del.mockResolvedValue({ data: { closures: [] } });
    const onChanged = vi.fn();
    const { rerender } = render(<PauseControl t={t} lang="da" today={TODAY} closures={[]} onChanged={onChanged} />);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-pause-open")); });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-pause-today")); });
    expect(h.post).toHaveBeenCalledWith("/reservations/closures", { kind: "pause", to: TODAY });
    expect(onChanged).toHaveBeenLastCalledWith(paused);

    rerender(<PauseControl t={t} lang="da" today={TODAY} closures={paused} onChanged={onChanged} />);
    expect(screen.getByTestId("rsvp-pause-active").textContent).toContain(da.rsvpPauseActiveToday);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-pause-resume")); });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.del).toHaveBeenCalledWith("/reservations/closures/9e0d4c11");
    expect(onChanged).toHaveBeenLastCalledWith([]);
  });

  it("a pause until a later date names that date", () => {
    render(<PauseControl t={t} lang="da" today={TODAY} onChanged={vi.fn()}
      closures={[{ id: "x1y2z3w4", from: TODAY, to: "2026-10-26", kind: "pause" }]} />);
    expect(screen.getByTestId("rsvp-pause-active").textContent)
      .toContain(`Online-booking er sat på pause til og med ${wd("2026-10-26")} 26. okt.`);
  });

  it("Til og med… posts the chosen day", async () => {
    h.post.mockResolvedValue({ data: { closures: [] } });
    render(<PauseControl t={t} lang="da" today={TODAY} closures={[]} onChanged={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-pause-open")); });
    await act(async () => { fireEvent.change(screen.getByTestId("rsvp-pause-until"), { target: { value: "2026-10-28" } }); });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-pause-save")); });
    expect(h.post).toHaveBeenCalledWith("/reservations/closures", { kind: "pause", to: "2026-10-28" });
  });
});
