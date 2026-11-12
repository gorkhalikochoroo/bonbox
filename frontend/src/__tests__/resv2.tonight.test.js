// Reservations v2 — the numbers behind "I aften" (utils/tonight.js).
// Every value comes from the book on screen; unknown stays null, never 0.
import { describe, it, expect } from "vitest";
import {
  liveStatus,
  minutesAtTable,
  peakSeats,
  needsAction,
  firstWaiting,
  waitlistFits,
  weekStrip,
  addDays,
  SOON_MIN,
} from "../utils/tonight";

// Naive venue wall-clock, read as local time (the suite runs TZ=UTC).
const at = (hm) => new Date(`2026-11-12T${hm}:00`).getTime();
const bk = (o) => ({ id: o.id || Math.random().toString(36).slice(2), party_size: 2, status: "confirmed", ...o });

describe("liveStatus", () => {
  it("seated: minutes since seated_at, never the booked time", () => {
    const r = bk({ status: "seated", starts_at: "2026-11-12T17:30:00", ends_at: "2026-11-12T19:30:00", // A UTC stamp of 17.32 venue time, whatever zone the suite runs in.
      seated_at: new Date(at("17:32")).toISOString() });
    expect(liveStatus(r, at("18:20"))).toEqual({ kind: "seated", min: 48, over: 0 });
    const noStamp = { ...r, seated_at: null };
    expect(liveStatus(noStamp, at("18:20")).min).toBeNull();
    expect(minutesAtTable(noStamp, at("18:20"))).toBeNull();
  });

  it("late: confirmed, past its start by the 5-minute grace", () => {
    const r = bk({ starts_at: "2026-11-12T18:00:00", ends_at: "2026-11-12T20:00:00" });
    expect(liveStatus(r, at("18:20"))).toEqual({ kind: "late", min: 20 });
    // Inside the grace it is due now, not late.
    expect(liveStatus(r, at("18:03"))).toEqual({ kind: "soon", min: 0 });
  });

  it("soon: within SOON_MIN; further out it is just confirmed", () => {
    const r = bk({ starts_at: "2026-11-12T18:30:00" });
    expect(SOON_MIN).toBe(15);
    expect(liveStatus(r, at("18:20"))).toEqual({ kind: "soon", min: 10 });
    expect(liveStatus(r, at("18:00"))).toEqual({ kind: "confirmed" });
  });

  it("another day: the stored status only", () => {
    const r = bk({ starts_at: "2026-11-12T18:00:00" });
    expect(liveStatus(r, at("18:20"), false)).toEqual({ kind: "confirmed" });
    expect(liveStatus(bk({ status: "no_show" }), at("18:20"))).toEqual({ kind: "no_show" });
  });
});

describe("peakSeats", () => {
  it("counts seats at the busiest moment, departures first at the same minute", () => {
    const rows = [
      bk({ party_size: 4, starts_at: "2026-11-12T18:00:00", ends_at: "2026-11-12T19:30:00" }),
      bk({ party_size: 6, starts_at: "2026-11-12T19:00:00", ends_at: "2026-11-12T21:00:00" }),
      bk({ party_size: 2, starts_at: "2026-11-12T19:30:00", ends_at: "2026-11-12T21:00:00" }),
      bk({ party_size: 8, status: "cancelled", starts_at: "2026-11-12T19:00:00", ends_at: "2026-11-12T21:00:00" }),
    ];
    // 19.00: 4 + 6 = 10; at 19.30 the 4 leave before the 2 arrive → 8.
    expect(peakSeats(rows)).toEqual({ peak: 10, at: "19.00" });
  });

  it("a party that has left still counts: the peak never shrinks as the night empties", () => {
    // 19.30: 25 booked. By 21.00 most have eaten and gone (completed) — the
    // booked peak is still 25 at 19.30, never 8 (review 12 Nov, MUST 1).
    const rows = [
      bk({ party_size: 10, status: "completed", starts_at: "2026-11-12T18:00:00", ends_at: "2026-11-12T20:00:00" }),
      bk({ party_size: 7, status: "completed", starts_at: "2026-11-12T19:00:00", ends_at: "2026-11-12T21:00:00" }),
      bk({ party_size: 8, status: "seated", starts_at: "2026-11-12T19:30:00", ends_at: "2026-11-12T21:30:00" }),
      bk({ party_size: 4, status: "no_show", starts_at: "2026-11-12T19:30:00", ends_at: "2026-11-12T21:30:00" }),
    ];
    expect(peakSeats(rows)).toEqual({ peak: 25, at: "19.30" });
    // After the last party leaves the night still reads as booked.
    const allGone = rows.map((r) => (r.status === "seated" ? { ...r, status: "completed" } : r));
    expect(peakSeats(allGone)).toEqual({ peak: 25, at: "19.30" });
  });

  it("a held online request holds nothing; an empty day is 0 with no time", () => {
    const held = bk({ status: "requested", source: "public", party_size: 2, held: { reason: "check" }, starts_at: "2026-11-12T19:00:00", ends_at: "2026-11-12T20:00:00" });
    expect(peakSeats([held])).toEqual({ peak: 0, at: null });
    expect(peakSeats([])).toEqual({ peak: 0, at: null });
  });
});

describe("needsAction", () => {
  it("late parties (longest first) plus requests", () => {
    const rows = [
      bk({ guest_name: "Petersen", starts_at: "2026-11-12T18:00:00" }),
      bk({ guest_name: "Holm", starts_at: "2026-11-12T18:10:00" }),
      bk({ guest_name: "Ny", status: "requested", starts_at: "2026-11-12T20:00:00" }),
      bk({ guest_name: "Gone", status: "cancelled", cancel_reason: "walk_in_removed", starts_at: "2026-11-12T17:00:00" }),
    ];
    const n = needsAction(rows, at("18:20"));
    expect(n.late.map((x) => [x.r.guest_name, x.min])).toEqual([["Petersen", 20], ["Holm", 10]]);
    expect(n.requested).toBe(1);
    expect(n.total).toBe(3);
    expect(needsAction(rows, at("18:20"), false).late).toEqual([]);
  });
});

describe("waitlist", () => {
  it("firstWaiting: the first real party in the server's order, never a held one", () => {
    // The server lists real guests first (FIFO), then held entries — even a
    // held entry that came in earlier (reservations.py list_waitlist).
    const e = [
      { id: "c", status: "converted", created_at: "2026-11-12T16:00:00" },
      { id: "a", status: "notified", created_at: "2026-11-12T17:08:00" },
      { id: "b", status: "waiting", created_at: "2026-11-12T17:20:00" },
      { id: "bot", status: "waiting", held: true, created_at: "2026-11-12T16:30:00" },
    ];
    expect(firstWaiting(e).id).toBe("a");
    expect(firstWaiting([e[3]])).toBeNull();
    expect(firstWaiting([])).toBeNull();
  });

  it("waitlistFits: a held entry, or a party waiting for later, is never told 'free now'", () => {
    const resources = [{ id: "t3", kind: "table", label: "3", capacity_seats: 4, is_active: true }];
    const entries = [
      { id: "later", status: "waiting", party_size: 2, desired_from: "2026-11-12T20:00:00", desired_to: "2026-11-12T21:00:00" },
      { id: "around", status: "waiting", party_size: 2, desired_from: "2026-11-12T18:30:00" },
      { id: "bot", status: "waiting", party_size: 2, held: true },
      { id: "any", status: "waiting", party_size: 2 },
    ];
    const at1730 = waitlistFits({ entries, reservations: [], resources, nowMs: at("17:30"), sittingFor: () => 90 });
    expect([...at1730.keys()]).toEqual(["any"]);
    const at1800 = waitlistFits({ entries, reservations: [], resources, nowMs: at("18:00"), sittingFor: () => 90 });
    expect([...at1800.keys()]).toEqual(["around", "any"]);
    const at1950 = waitlistFits({ entries, reservations: [], resources, nowMs: at("19:50"), sittingFor: () => 90 });
    expect([...at1950.keys()]).toEqual(["later", "any"]);
  });

  it("waitlistFits: a table free for the whole sitting, never one booked within it", () => {
    const resources = [
      { id: "t3", kind: "table", label: "3", capacity_seats: 4, is_active: true },
      { id: "t7", kind: "table", label: "7", capacity_seats: 2, is_active: true },
    ];
    const reservations = [
      // Table 7 is booked at 19.00 — a 2-top sitting 120 min from 18.20 would run into it.
      bk({ resource_id: "t7", starts_at: "2026-11-12T19:00:00", ends_at: "2026-11-12T21:00:00" }),
    ];
    const entries = [
      { id: "kr", status: "waiting", party_size: 2, created_at: "2026-11-12T18:08:00" },
      { id: "big", status: "waiting", party_size: 6, created_at: "2026-11-12T18:09:00" },
    ];
    const fits = waitlistFits({ entries, reservations, resources, nowMs: at("18:20"), sittingFor: () => 120 });
    expect(fits.get("kr")?.label).toBe("3");
    expect(fits.has("big")).toBe(false);
    // No turn times known: no claim.
    expect(waitlistFits({ entries, reservations, resources, nowMs: at("18:20") }).size).toBe(0);
  });
});

describe("weekStrip", () => {
  it("covers per day, a bar relative to the busiest day shown, closed from the saved hours", () => {
    const openHours = { mon: [], tue: [["17:00", "23:00"]], wed: [["17:00", "23:00"]], thu: [["17:00", "23:00"]], fri: [["17:00", "23:00"]], sat: [["17:00", "23:00"]], sun: [["17:00", "22:00"]] };
    const days = weekStrip({
      start: "2026-11-12",
      loads: { "2026-11-12": { covers: 43, bookings: 12 }, "2026-11-14": { covers: 52, bookings: 15 } },
      knownMonths: ["2026-11"],
      openHours,
      today: "2026-11-12",
      selected: "2026-11-13",
    });
    expect(days.map((d) => d.iso)).toEqual([
      "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18",
    ]);
    expect(days[0]).toMatchObject({ covers: 43, isToday: true, selected: false });
    expect(days[1]).toMatchObject({ covers: 0, selected: true, fill: 0 });
    expect(days[2].fill).toBe(1);
    expect(days[0].fill).toBeCloseTo(43 / 52);
    // 16 Nov 2026 is a Monday — closed by the hours.
    expect(days[4]).toMatchObject({ weekday: 1, closed: true });
  });

  it("a month that did not answer is unknown (null), not an empty day", () => {
    const days = weekStrip({ start: "2026-11-28", loads: {}, knownMonths: ["2026-11"], today: "2026-11-12" });
    expect(days[0].covers).toBe(0);
    expect(days[4].iso).toBe("2026-12-02");
    expect(days[4].covers).toBeNull();
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
