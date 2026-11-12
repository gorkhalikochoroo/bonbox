/**
 * Fix round 12 Nov (#4): a table named only by a number read like a party
 * size — "👥 2   2", "Drop-in finished — 2 is free.", "Free now and fits: 2".
 * One display helper says "Bord 2" / "Table 2" ("Plads 2" / "Space 2" for an
 * appointment venue); any other label is shown as the owner wrote it. It is
 * display only and idempotent, so a name made once passes through again.
 */
import { describe, it, expect } from "vitest";
import { tableName, tablesName } from "../utils/tableName";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const tFor = (dict) => (k, fb, vars) => {
  const s = dict[k] ?? fb;
  return vars ? s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m)) : s;
};
const tDa = tFor(da);
const tEn = tFor(en);

describe("tableName", () => {
  it("says a digits-only label as a table, in the owner's language", () => {
    expect(tableName("2", tDa)).toBe("Bord 2");
    expect(tableName("2", tEn)).toBe("Table 2");
    expect(tableName(" 12 ", tEn)).toBe("Table 12");
    expect(tableName(7, tDa)).toBe("Bord 7");
  });

  it("says a place at an appointment venue", () => {
    expect(tableName("3", tDa, { appt: true })).toBe("Plads 3");
    expect(tableName("3", tEn, { appt: true })).toBe("Space 3");
  });

  it("leaves any other label as the owner wrote it", () => {
    expect(tableName("Vindue 3", tDa)).toBe("Vindue 3");
    expect(tableName("A2", tDa)).toBe("A2");
    expect(tableName("2b", tEn)).toBe("2b");
    expect(tableName("Bord 2", tDa)).toBe("Bord 2");
  });

  it("passes nothing through as nothing", () => {
    expect(tableName(null, tDa)).toBeNull();
    expect(tableName(undefined, tDa)).toBeUndefined();
    expect(tableName("", tDa)).toBe("");
  });

  it("is idempotent", () => {
    expect(tableName(tableName("4", tDa), tDa)).toBe("Bord 4");
  });

  it("has real Danish and English words", () => {
    expect(da.rsvpTableNumbered).toBe("Bord {n}");
    expect(en.rsvpTableNumbered).toBe("Table {n}");
    expect(da.rsvpSpaceNumbered).toBe("Plads {n}");
    expect(en.rsvpSpaceNumbered).toBe("Space {n}");
  });
});

describe("tablesName", () => {
  it("names each of the tables pushed together", () => {
    expect(tablesName("6 + 7", tEn)).toBe("Table 6 + Table 7");
    expect(tablesName(["6", "Vindue 1"], tDa)).toBe("Bord 6 + Vindue 1");
    expect(tablesName("Bord 6 + Bord 7", tDa)).toBe("Bord 6 + Bord 7");
  });

  it("passes nothing through as nothing", () => {
    expect(tablesName(null, tDa)).toBeNull();
    expect(tablesName("", tDa)).toBe("");
  });
});
