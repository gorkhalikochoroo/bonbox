/**
 * The host stand's computed readouts (utils/hostStand.js).
 *
 * Every number here is worked out from the day's bookings, never measured —
 * so the rules under test are as much about what is NOT shown as what is:
 *   • "free now" only when a fitting table is free for the party's WHOLE
 *     sitting, and then the smallest that fits;
 *   • otherwise the first time a fitting table is booked free, from the
 *     bookings' own ends — or nothing, when that cannot be known (a party
 *     still seated past its end) or it falls after closing;
 *   • covers count seated / confirmed-still-to-come / finished, never a
 *     request and never a removed drop-in;
 *   • the finished list's time at the table needs both stamps;
 *   • combined tables join neighbour to neighbour, from their own positions;
 *   • tables are joined for a party exactly as the booking engine joins them
 *     (findCombo runs the engine's own cases, shared with the backend), and a
 *     wait is never a later time from one table while another that could
 *     take the party has a free time nobody can know.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  WALK_IN_SIZES,
  tableFreeAt,
  walkInOptions,
  closeMsFor,
  coverCounts,
  stayMinutes,
  bySeatedTime,
  comboLinks,
  findCombo,
  comboRules,
  joinedSeatingNow,
  seatingNow,
  tablesOf,
  sameTables,
  stampIso,
} from "../utils/hostStand";

const DAY = "2026-10-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const ms = (hhmm) => new Date(at(hhmm)).getTime();
const NOW = ms("19:00");
const sitting = (n) => (n <= 2 ? 90 : 120);

const table = (id, seats, extra = {}) => ({ id, label: id, capacity_seats: seats, kind: "table", is_active: true, ...extra });
const booking = (id, tableId, status, from, to, party = 2, extra = {}) => ({
  id, resource_id: tableId, status, starts_at: at(from), ends_at: at(to), party_size: party, ...extra,
});

describe("tableFreeAt", () => {
  it("is now for a table with nothing on it", () => {
    expect(tableFreeAt(table("41", 2), [], NOW, 90)).toBe(NOW);
  });

  it("is the seated party's booked end", () => {
    const rs = [booking("a", "21", "seated", "18:00", "19:30")];
    expect(tableFreeAt(table("21", 2), rs, NOW, 90)).toBe(ms("19:30"));
  });

  it("is unknowable while a party sits past its end — not 'now'", () => {
    const rs = [booking("a", "21", "seated", "17:00", "18:30")];
    expect(tableFreeAt(table("21", 2), rs, NOW, 90)).toBeNull();
  });

  it("skips a gap too short for a whole sitting", () => {
    // Free 19:00–19:45, then booked until 21:15: a 90-minute party fits after.
    const rs = [booking("b", "22", "confirmed", "19:45", "21:15")];
    expect(tableFreeAt(table("22", 2), rs, NOW, 90)).toBe(ms("21:15"));
    // A 30-minute sitting fits in the gap now.
    expect(tableFreeAt(table("22", 2), rs, NOW, 30)).toBe(NOW);
  });

  it("holds a table for a combined party on every table it joins", () => {
    const rs = [{ ...booking("c", null, "seated", "18:30", "20:30", 8), combined_resource_ids: ["31", "32"] }];
    expect(tableFreeAt(table("32", 2), rs, NOW, 90)).toBe(ms("20:30"));
  });

  it("ignores finished, cancelled and no-show rows, and a booking whose window is over", () => {
    const rs = [
      booking("d", "23", "completed", "17:00", "19:30"),
      booking("e", "23", "cancelled", "18:30", "20:00"),
      booking("f", "23", "no_show", "18:30", "20:00"),
      booking("g", "23", "confirmed", "16:00", "17:30"),
    ];
    expect(tableFreeAt(table("23", 4), rs, NOW, 120)).toBe(NOW);
  });
});

describe("walkInOptions", () => {
  const resources = [table("21", 2), table("22", 2), table("23", 4), table("25", 6), table("41", 2), table("P", 1, { kind: "provider" })];
  const reservations = [
    booking("a", "21", "seated", "18:00", "19:30"),
    booking("b", "22", "seated", "18:30", "20:00"),
    booking("c", "23", "seated", "18:15", "20:15", 4),
    booking("d", "25", "seated", "18:45", "20:45", 6),
  ];

  it("offers 1–6, six standing for six or more", () => {
    expect(WALK_IN_SIZES).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("says free now with the smallest table that fits — never a bigger one", () => {
    const opts = walkInOptions({ reservations, resources, nowMs: NOW, sittingFor: sitting });
    expect(opts[0]).toMatchObject({ size: 1, freeNow: true, tableId: "41" });
    expect(opts[1]).toMatchObject({ size: 2, freeNow: true, tableId: "41" });
  });

  it("otherwise gives the first time a fitting table is booked free", () => {
    const opts = walkInOptions({ reservations, resources, nowMs: NOW, sittingFor: sitting });
    expect(opts[2]).toMatchObject({ size: 3, freeNow: false, at: ms("20:15") });
    expect(opts[3]).toMatchObject({ size: 4, freeNow: false, at: ms("20:15") });
    expect(opts[4]).toMatchObject({ size: 5, freeNow: false, at: ms("20:45") });
    expect(opts[5]).toMatchObject({ size: 6, freeNow: false, at: ms("20:45") });
  });

  it("shows nothing when no fitting table's free time can be known", () => {
    const over = [booking("d", "25", "seated", "16:00", "18:30", 6)];
    const opts = walkInOptions({ reservations: over, resources: [table("25", 6)], nowMs: NOW, sittingFor: sitting });
    expect(opts[5]).toMatchObject({ size: 6, freeNow: false, at: null });
  });

  it("shows nothing for a size no single table seats", () => {
    const opts = walkInOptions({ reservations: [], resources: [table("21", 2)], nowMs: NOW, sittingFor: sitting });
    expect(opts[2]).toMatchObject({ size: 3, freeNow: false, at: null });
  });

  it("leaves out a wait that only ends after closing", () => {
    const opts = walkInOptions({ reservations, resources, nowMs: NOW, sittingFor: sitting, closeMs: ms("20:30") });
    expect(opts[2].at).toBe(ms("20:15"));
    expect(opts[4].at).toBeNull();
  });

  it("does not count an inactive table", () => {
    const opts = walkInOptions({ reservations: [], resources: [table("41", 2, { is_active: false })], nowMs: NOW, sittingFor: sitting });
    expect(opts[1]).toMatchObject({ freeNow: false, at: null });
  });
});

describe("walkInOptions — a wait nobody can know", () => {
  it("shows no time when a fitting table's party sits past its end — not a later one from another table", () => {
    // 23's party was due to leave at 18.30 and is still there: it could free
    // any minute. 33 frees at 20.15. "approx. 20.15" would be a worst case
    // dressed as the wait.
    const rs = [
      booking("c", "23", "seated", "16:30", "18:30", 4),
      booking("d", "33", "seated", "18:15", "20:15", 4),
    ];
    const opts = walkInOptions({ reservations: rs, resources: [table("23", 4), table("33", 4)], nowMs: NOW, sittingFor: sitting });
    expect(opts[3]).toMatchObject({ size: 4, freeNow: false, at: null });
  });

  it("still says free now when a fitting table is free, whatever the others do", () => {
    const rs = [booking("c", "23", "seated", "16:30", "18:30", 4)];
    const opts = walkInOptions({ reservations: rs, resources: [table("23", 4), table("33", 4)], nowMs: NOW, sittingFor: sitting });
    expect(opts[3]).toMatchObject({ size: 4, freeNow: true, tableId: "33", tableIds: ["33"], label: "33" });
  });
});

// The engine's own cases — the same file backend/tests/test_find_combo_parity.py
// runs through availability_engine.find_combo.
const CASES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "findComboCases.json"), "utf8"),
).cases;

describe("findCombo — the booking engine's joining rule, case for case", () => {
  it.each(CASES.map((c) => [c.name, c]))("%s", (_name, c) => {
    const tables = c.tables.map((tb) => ({
      id: tb.id, label: tb.id, capacity_seats: tb.seats, combinable: tb.combinable, zone: tb.zone,
    }));
    expect(findCombo(c.party, tables, c.max)).toEqual(c.expected);
  });
});

describe("comboRules", () => {
  it("reads the settings as the engine does: on unless switched off, three tables unless set", () => {
    expect(comboRules(null)).toBeNull();
    expect(comboRules({})).toEqual({ enabled: true, maxSize: 3 });
    expect(comboRules({ combine_enabled: false, max_combo_size: 2 })).toEqual({ enabled: false, maxSize: 2 });
    expect(comboRules({ combine_enabled: true, max_combo_size: 0 })).toEqual({ enabled: true, maxSize: 3 });
  });
});

describe("walkInOptions — joined tables", () => {
  // 6 + 7 + 8 are a joinable row (4 + 4 + 2); 4 and 9 are not joinable.
  const room = [
    table("4", 4, { zone: "Sal" }),
    table("6", 4, { zone: "Sal", combinable: true }),
    table("7", 4, { zone: "Sal", combinable: true }),
    table("8", 2, { zone: "Sal", combinable: true }),
    table("9", 6, { zone: "Sal" }),
  ];
  const join = { enabled: true, maxSize: 3 };
  const bigTablesTaken = [
    booking("x", "9", "seated", "18:30", "20:30", 6),
    booking("y", "4", "seated", "18:45", "20:30", 4),
  ];

  it("says free now for a party only joined tables seat — the set the engine would use", () => {
    const opts = walkInOptions({ reservations: bigTablesTaken, resources: room, nowMs: NOW, sittingFor: sitting, combine: join });
    expect(opts[3]).toMatchObject({ size: 4, freeNow: true, tableId: "6", tableIds: ["6"] });
    expect(opts[4]).toMatchObject({ size: 5, freeNow: true, tableId: null, tableIds: ["6", "8"], label: "6 + 8" });
    expect(opts[5]).toMatchObject({ size: 6, freeNow: true, tableId: null, tableIds: ["6", "8"], label: "6 + 8" });
  });

  it("joins nothing when the venue has joining switched off", () => {
    const opts = walkInOptions({
      reservations: bigTablesTaken, resources: room, nowMs: NOW, sittingFor: sitting, combine: { enabled: false, maxSize: 3 },
    });
    expect(opts[5]).toMatchObject({ size: 6, freeNow: false, at: ms("20:30") });
  });

  it("waits for the first seating that opens — joined tables before a later six-top", () => {
    const rs = [
      booking("x", "9", "seated", "19:30", "21:30", 6),
      booking("p", "6", "seated", "18:15", "20:15", 4),
      booking("q", "7", "seated", "18:30", "21:00", 4),
      booking("r", "8", "seated", "18:30", "20:00", 2),
      booking("s", "4", "seated", "18:45", "20:45", 4),
    ];
    const opts = walkInOptions({ reservations: rs, resources: room, nowMs: NOW, sittingFor: sitting, combine: join });
    expect(opts[5]).toMatchObject({ size: 6, freeNow: false, at: ms("20:15") });
  });

  it("shows no time when a joinable table that could take them has a party past its end", () => {
    const rs = [
      booking("x", "9", "seated", "18:45", "20:45", 6),
      booking("q", "7", "seated", "17:00", "18:45", 4),
      booking("p", "6", "seated", "18:15", "20:15", 4),
      booking("r", "8", "seated", "18:30", "20:00", 2),
      booking("s", "4", "seated", "18:45", "20:45", 4),
    ];
    const opts = walkInOptions({ reservations: rs, resources: room, nowMs: NOW, sittingFor: sitting, combine: join });
    expect(opts[5]).toMatchObject({ size: 6, freeNow: false, at: null });
  });

  it("never joins across zones", () => {
    const split = [table("in", 4, { zone: "Sal", combinable: true }), table("out", 4, { zone: "Terrasse", combinable: true })];
    const opts = walkInOptions({ reservations: [], resources: split, nowMs: NOW, sittingFor: sitting, combine: join });
    expect(opts[5]).toMatchObject({ size: 6, freeNow: false, at: null });
  });

  it("names the engine's joined set for the seat sheet, and nothing when joining is off", () => {
    const args = { reservations: bigTablesTaken, resources: room, nowMs: NOW, size: 6, sittingMin: 120 };
    expect(joinedSeatingNow({ ...args, combine: join })).toEqual({ tableIds: ["6", "8"], label: "6 + 8", seats: 6 });
    expect(joinedSeatingNow({ ...args, combine: { enabled: false, maxSize: 3 } })).toBeNull();
  });
});

describe("seatingNow — the one rule behind the row's Free now and the seat sheet's pick", () => {
  // A six-top that never joins; 51 + 52 that do (4 + 2).
  const room = [
    table("10", 6, { zone: "Sal" }),
    table("51", 4, { zone: "Sal", combinable: true }),
    table("52", 2, { zone: "Sal", combinable: true }),
  ];
  const join = { enabled: true, maxSize: 3 };

  it("a six-top booked inside their whole sitting is not free — the joined pair is", () => {
    // Booked 21.10; six guests sit 150 minutes from 19.00, to 21.30.
    const rs = [booking("x", "10", "confirmed", "21:10", "23:40", 6)];
    expect(seatingNow({ reservations: rs, resources: room, nowMs: NOW, size: 6, sittingMin: 150, combine: join }))
      .toEqual({ tableId: null, tableIds: ["51", "52"], label: "51 + 52", seats: 6 });
  });

  it("a six-top free for the whole sitting is the seating — one table, not two", () => {
    // Booked 20.40; six guests sit 90 minutes from 19.00, to 20.30.
    const rs = [booking("x", "10", "confirmed", "20:40", "22:10", 6)];
    expect(seatingNow({ reservations: rs, resources: room, nowMs: NOW, size: 6, sittingMin: 90, combine: join }))
      .toEqual({ tableId: "10", tableIds: ["10"], label: "10", seats: 6 });
  });

  it("joins nothing without the joining rule — no rule, switched off, or one table at most", () => {
    const rs = [booking("x", "10", "confirmed", "21:10", "23:40", 6)];
    const args = { reservations: rs, resources: room, nowMs: NOW, size: 6, sittingMin: 150 };
    expect(seatingNow({ ...args, combine: null })).toBeNull();
    expect(seatingNow({ ...args, combine: { enabled: false, maxSize: 3 } })).toBeNull();
    expect(seatingNow({ ...args, combine: { enabled: true, maxSize: 1 } })).toBeNull();
  });

  it("is, size by size, exactly the seating walkInOptions counts as free now", () => {
    const floor = [
      table("4", 4, { zone: "Sal" }),
      table("6", 4, { zone: "Sal", combinable: true }),
      table("7", 4, { zone: "Sal", combinable: true }),
      table("8", 2, { zone: "Sal", combinable: true }),
      table("9", 6, { zone: "Sal" }),
      table("22", 2, { zone: "Terrasse" }),
    ];
    const books = [
      [],
      [booking("x", "9", "seated", "18:30", "20:30", 6), booking("y", "4", "seated", "18:45", "20:30", 4)],
      [booking("p", "6", "confirmed", "20:00", "22:00", 4), booking("q", "9", "confirmed", "21:00", "23:00", 6)],
      [booking("r", "8", "seated", "17:00", "18:30", 2), booking("s", "22", "confirmed", "19:30", "21:00", 2)],
    ];
    for (const reservations of books) {
      for (const combine of [join, null, { enabled: false, maxSize: 3 }, { enabled: true, maxSize: 2 }]) {
        const opts = walkInOptions({ reservations, resources: floor, nowMs: NOW, sittingFor: sitting, combine });
        for (const o of opts) {
          const s = seatingNow({ reservations, resources: floor, nowMs: NOW, size: o.size, sittingMin: sitting(o.size), combine });
          expect(s ? s.tableIds : null).toEqual(o.freeNow ? o.tableIds : null);
          if (s) expect(s.label).toBe(o.label);
        }
      }
    }
  });
});

describe("what the server answered a seat with", () => {
  it("is the tables it holds the booking at — the joined set, else the one table", () => {
    expect(tablesOf({ resource_id: "51", combined_resource_ids: ["51", "52"] })).toEqual(["51", "52"]);
    expect(tablesOf({ resource_id: 41, combined_resource_ids: null })).toEqual(["41"]);
    expect(tablesOf({ resource_id: null, combined_resource_ids: [] })).toEqual([]);
    expect(tablesOf(null)).toEqual([]);
  });

  it("is the same seating when the tables are the same, in any order", () => {
    expect(sameTables(["51", "52"], ["52", "51"])).toBe(true);
    expect(sameTables(["41"], [41])).toBe(true);
    expect(sameTables(["41"], ["51", "52"])).toBe(false);
    expect(sameTables(["51"], ["51", "52"])).toBe(false);
    expect(sameTables([], ["41"])).toBe(false);
  });
});

describe("closeMsFor", () => {
  it("is the end of the day's last window", () => {
    const hours = { mon: [["11:30", "15:00"], ["17:00", "22:00"]] };
    expect(closeMsFor(DAY, hours)).toBe(ms("22:00")); // 12 Oct 2026 is a Monday
  });
  it("reads a close past midnight as the next day", () => {
    expect(closeMsFor(DAY, { mon: [["17:00", "01:00"]] })).toBe(ms("00:00") + 25 * 3600000);
  });
  it("is null when the hours are unknown or the day is closed", () => {
    expect(closeMsFor(DAY, null)).toBeNull();
    expect(closeMsFor(DAY, { mon: [] })).toBeNull();
  });
});

describe("coverCounts", () => {
  it("counts guests and parties seated, still expected and finished", () => {
    const c = coverCounts([
      booking("a", "21", "seated", "18:00", "19:30", 2),
      booking("b", "23", "seated", "18:15", "20:15", 4),
      booking("c", "22", "confirmed", "19:30", "21:00", 3),
      booking("d", "22", "completed", "17:00", "18:30", 5),
      booking("e", null, "requested", "20:00", "21:30", 6),
      booking("f", null, "no_show", "18:00", "19:30", 2),
      booking("g", null, "cancelled", "18:00", "19:30", 2),
      booking("h", "41", "seated", "18:50", "20:20", 2, { cancel_reason: "walk_in_removed" }),
    ]);
    expect(c.seated).toEqual({ guests: 6, parties: 2 });
    expect(c.expected).toEqual({ guests: 3, parties: 1 });
    expect(c.finished).toEqual({ guests: 5, parties: 1 });
  });
});

describe("finished history", () => {
  const z = (hhmm) => new Date(at(hhmm)).toISOString();
  it("is the time between the two stamps, and nothing without both", () => {
    expect(stayMinutes({ seated_at: z("17:02"), completed_at: z("18:10") })).toBe(68);
    expect(stayMinutes({ seated_at: z("17:02"), completed_at: null })).toBeNull();
    expect(stayMinutes({ seated_at: null, completed_at: z("18:10") })).toBeNull();
    expect(stayMinutes({ seated_at: z("18:10"), completed_at: z("17:02") })).toBeNull();
  });
  it("orders by the time they sat down, booked time when that is unknown", () => {
    const rows = [
      { id: "riis", starts_at: at("17:00"), seated_at: z("17:20") },
      { id: "hansen", starts_at: at("17:10"), seated_at: z("16:55") },
      { id: "old", starts_at: at("17:05"), seated_at: null },
    ];
    expect([...rows].sort(bySeatedTime).map((r) => r.id)).toEqual(["hansen", "old", "riis"]);
  });

  // What /book sends: utc_now() with microseconds, "2026-10-12T15:02:00.123456Z".
  const micro = (hhmm, frac) => z(hhmm).replace(/\.\d{3}Z$/, `.${frac}Z`);

  it("reads the server's stamps — six-digit fractions, Z or not — as the UTC instants they are", () => {
    expect(stayMinutes({ seated_at: micro("17:02", "123456"), completed_at: micro("18:10", "654321") })).toBe(68);
    // The same instants without the Z, as most endpoints send a stamp: still UTC.
    expect(stayMinutes({ seated_at: micro("17:02", "123456").slice(0, -1), completed_at: micro("18:10", "654321") })).toBe(68);
    expect(stampIso(micro("17:02", "123456"))).toBe(z("17:02").replace(".000Z", ".123Z"));
    expect(stampIso(micro("17:02", "123456").slice(0, -1))).toBe(z("17:02").replace(".000Z", ".123Z"));
    expect(stampIso(null)).toBe("");
    expect(stampIso("garbage")).toBe("");
  });

  it("orders six-digit stamps against booked wall-clock times by the instant", () => {
    const rows = [
      { id: "riis", starts_at: at("17:00"), seated_at: micro("17:20", "123456").slice(0, -1) },
      { id: "hansen", starts_at: at("17:10"), seated_at: micro("16:55", "999999") },
      { id: "old", starts_at: at("17:05"), seated_at: null },
    ];
    expect([...rows].sort(bySeatedTime).map((r) => r.id)).toEqual(["hansen", "old", "riis"]);
  });
});

describe("comboLinks", () => {
  const pos = { 31: { x: 10, y: 50 }, 32: { x: 20, y: 50 }, 33: { x: 30, y: 50 }, 99: { x: 90, y: 90 } };
  it("joins a row of tables neighbour to neighbour — never across", () => {
    const [g] = comboLinks([{ id: "e", status: "seated", combined_resource_ids: ["31", "33", "32"] }], pos);
    const pairs = g.edges.map(([a, b]) => [a.id, b.id].sort().join("-")).sort();
    expect(pairs).toEqual(["31-32", "32-33"]);
    expect(g.status).toBe("seated");
  });
  it("draws nothing for a single table, or tables the floor does not place", () => {
    expect(comboLinks([{ id: "x", status: "seated", combined_resource_ids: ["31"] }], pos)).toEqual([]);
    expect(comboLinks([{ id: "y", status: "confirmed", combined_resource_ids: ["31", "77"] }], pos)).toEqual([]);
    expect(comboLinks([{ id: "z", status: "confirmed", resource_id: "31" }], pos)).toEqual([]);
  });
  it("draws one group per booking even when every table repeats it", () => {
    const r = { id: "e", status: "seated", combined_resource_ids: ["31", "32"] };
    expect(comboLinks([r, r, r], pos)).toHaveLength(1);
  });
});
