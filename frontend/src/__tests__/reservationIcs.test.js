/**
 * The confirmation's two silent-failure helpers.
 *
 * Both fail invisibly if they are wrong: a duplicated city just looks
 * sloppy, but a bad .ics writes the WRONG TIME into a guest's calendar
 * and the venue only finds out when the table sits empty. Neither shows
 * an error to anyone, so they get a test.
 */
import { describe, expect, it } from "vitest";
import { buildIcs, venueAddress } from "../utils/reservationIcs";

const base = {
  uid: "abc@bonbox.dk",
  day: "2026-08-01",
  time: "19:00",
  minutes: 120,
  summary: "Bord hos Café Hygge",
  location: "Valbygårdsvej 1, 2500 Valby",
  description: "#F3CCDF03 · Manoj",
};

// ── the address the owner typed twice ────────────────────────────────

describe("venueAddress", () => {
  it("drops the city when the postal line already ends with it", () => {
    expect(venueAddress("Valbygårdsvej 1, 2500 Valby", "Valby")).toBe(
      "Valbygårdsvej 1, 2500 Valby",
    );
  });

  it("keeps the city when the address really does not name it", () => {
    expect(venueAddress("Valbygårdsvej 1", "Valby")).toBe("Valbygårdsvej 1, Valby");
  });

  it("does not mistake a street for the city it starts with", () => {
    // "Valbygårdsvej" contains "Valby" as a substring. Dropping the city
    // here would lose it from an address that never carried it.
    expect(venueAddress("Valbygårdsvej 1", "Valby")).toContain("Valby");
    expect(venueAddress("Næstvedvej 3", "Næstved")).toBe("Næstvedvej 3, Næstved");
  });

  it("matches a city written in a different case", () => {
    expect(venueAddress("Havnegade 4, 5000 ODENSE C", "Odense C")).toBe(
      "Havnegade 4, 5000 ODENSE C",
    );
  });

  it("handles æøå cities, where a \\b word-boundary regex would not", () => {
    expect(venueAddress("Storegade 2, 6200 Aabenraa", "Aabenraa")).toBe(
      "Storegade 2, 6200 Aabenraa",
    );
    expect(venueAddress("Torvet 1, 4700 Næstved", "Næstved")).toBe(
      "Torvet 1, 4700 Næstved",
    );
  });

  it("handles the real production venue, which is what surfaced this", () => {
    // Live /public/reservations/bistro on 2026-07-26. The old
    // [address, city].join(", ") printed the town twice.
    expect(
      venueAddress("Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby", "Valby"),
    ).toBe("Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby");
  });

  it("survives either half being missing", () => {
    expect(venueAddress("", "Valby")).toBe("Valby");
    expect(venueAddress("Torvet 1", "")).toBe("Torvet 1");
    expect(venueAddress(null, null)).toBe("");
  });
});

// ── the calendar entry ───────────────────────────────────────────────

describe("buildIcs", () => {
  const lines = (ics) => ics.split("\r\n");
  // Scoped to the VEVENT: the VTIMEZONE block carries its OWN DTSTART
  // (the 1970 DST rule anchors), and a loose search finds that first.
  const find = (ics, prefix) => {
    const all = lines(ics);
    const from = all.indexOf("BEGIN:VEVENT");
    return all.slice(from).find((l) => l.startsWith(prefix));
  };

  it("writes the wall-clock time under TZID, never converted", () => {
    // THE load-bearing assertion. The guest's phone may be in any
    // timezone; 19:00 in Copenhagen must stay 19:00 in the file.
    const ics = buildIcs(base);
    expect(find(ics, "DTSTART")).toBe(
      "DTSTART;TZID=Europe/Copenhagen:20260801T190000",
    );
  });

  it("ships a real VTIMEZONE so strict clients can resolve the TZID", () => {
    const ics = buildIcs(base);
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:Europe/Copenhagen");
    expect(ics).toContain("TZOFFSETTO:+0200"); // CEST
    expect(ics).toContain("TZOFFSETTO:+0100"); // CET
  });

  it("rolls the end time over the hour", () => {
    const ics = buildIcs({ ...base, time: "19:30", minutes: 90 });
    expect(find(ics, "DTEND")).toBe("DTEND;TZID=Europe/Copenhagen:20260801T210000");
  });

  it("rolls the end time over midnight into the next day", () => {
    const ics = buildIcs({ ...base, time: "23:00", minutes: 120 });
    expect(find(ics, "DTEND")).toBe("DTEND;TZID=Europe/Copenhagen:20260802T010000");
  });

  it("rolls over a month end", () => {
    const ics = buildIcs({ ...base, day: "2026-08-31", time: "23:30", minutes: 60 });
    expect(find(ics, "DTEND")).toBe("DTEND;TZID=Europe/Copenhagen:20260901T003000");
  });

  it("defaults to two hours when no duration is known", () => {
    const ics = buildIcs({ ...base, minutes: undefined });
    expect(find(ics, "DTEND")).toBe("DTEND;TZID=Europe/Copenhagen:20260801T210000");
  });

  it("escapes commas and semicolons instead of splitting the field", () => {
    // An unescaped comma in LOCATION ends the value: the guest would get
    // an event pointing at "Valbygårdsvej 1" with the town silently gone.
    const ics = buildIcs({ ...base, summary: "Bord, Bar & Køkken; nede" });
    const summary = find(ics, "SUMMARY");
    expect(summary).toBe("SUMMARY:Bord\\, Bar & Køkken\\; nede");
  });

  it("escapes a backslash before anything else, not after", () => {
    const ics = buildIcs({ ...base, summary: "A\\B" });
    expect(find(ics, "SUMMARY")).toBe("SUMMARY:A\\\\B");
  });

  it("folds a long line and marks the continuation with a space", () => {
    const ics = buildIcs({ ...base, summary: "Restaurant " + "x".repeat(120) });
    const out = lines(ics);
    const i = out.findIndex((l) => l.startsWith("SUMMARY:"));
    expect(out[i + 1].startsWith(" ")).toBe(true);
    for (const l of out) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    }
  });

  it("folds on byte length, so an æøå name is not cut mid-character", () => {
    // "ø" is two bytes in UTF-8. Folding by character count would let a
    // line exceed 75 octets; folding mid-character would corrupt it.
    const ics = buildIcs({ ...base, summary: "Smørrebrødskælderen ".repeat(6) });
    for (const l of lines(ics)) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    }
    // and the text survives once unfolded
    expect(ics.replace(/\r\n /g, "")).toContain("Smørrebrødskælderen");
  });

  it("uses CRLF and closes every block it opens", () => {
    const ics = buildIcs(base);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.includes("\n\n")).toBe(false);
    for (const block of ["VCALENDAR", "VEVENT", "VTIMEZONE"]) {
      expect(ics).toContain(`BEGIN:${block}`);
      expect(ics).toContain(`END:${block}`);
    }
  });

  it("omits optional fields rather than emitting an empty one", () => {
    const ics = buildIcs({ ...base, location: "", description: "" });
    expect(find(ics, "LOCATION")).toBeUndefined();
    expect(find(ics, "DESCRIPTION")).toBeUndefined();
  });
});
