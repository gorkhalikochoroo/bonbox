/**
 * R11 — the pure parts and the small components (rubric B7, B8, B10, B11):
 * allergy words, the freed-table diff, the device's remembered shape, the
 * no-fit sheet and the nudge in their own words (table and appointment), and
 * every new word in English and Danish.
 *
 * Run: cd frontend && npx vitest run src/__tests__/r11.rightTable.units.test.jsx
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import { allergyFacts, allergySentence, allergyTone, allergyWord, hasRecordedAllergy } from "../utils/allergyWords";
import AllergyLine, { AllergyIcon } from "../components/reservations/AllergyWords";
import { freedSince, tablesHeld } from "../utils/freedTables";
import { rememberStandLayout, rememberedStandLayout } from "../services/standAuth";
import NoTableFitsSheet from "../components/reservations/NoTableFitsSheet";
import FreedTableNudge from "../components/reservations/FreedTableNudge";

const tt = (_k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  return String(typeof fb === "string" ? fb : _k).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
};
const daT = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  return String(da[k] ?? (typeof fb === "string" ? fb : k)).replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? v[n] : m));
};

describe("allergy words (B8)", () => {
  it("names the level, from what was recorded", () => {
    expect(allergyFacts({ allergy_severity: "severe", allergen_tags: ["nuts"] }).level).toBe("severe");
    expect(allergyFacts({ allergy_severity: "intolerance" }).level).toBe("intolerance");
    expect(allergyFacts({ allergy_severity: "preference", allergen_tags: ["milk"] }).level).toBe("preference");
    expect(allergyFacts({ allergen_tags: ["gluten"] }).level).toBe("allergy");
    expect(allergyFacts({ allergy_note: "Ingen skaldyr" }).level).toBe("allergy");
    expect(allergyFacts({ ai_allergy: { has_ai_suggested_allergy: true, ai_tags: ["gluten"] } }))
      .toEqual({ level: "possible", tags: ["gluten"], note: "" });
    // A recorded allergy wins over the AI's reading.
    expect(allergyFacts({ allergen_tags: ["fish"], ai_allergy: { has_ai_suggested_allergy: true } }).level).toBe("allergy");
    expect(allergyFacts({}).level).toBeNull();
    expect(allergyFacts(null).level).toBeNull();
    expect(hasRecordedAllergy({ allergen_tags: [] })).toBe(false);
  });

  it("says each level as a word, in Danish too", () => {
    expect(["severe", "intolerance", "preference", "allergy", "possible"].map((l) => allergyWord(l, daT)))
      .toEqual(["Alvorlig", "Intolerans", "Præference", "Allergi", "Mulig allergi"]);
    expect(allergySentence({ allergy_severity: "severe", allergen_tags: ["peanuts"], allergy_note: "Søn tåler ikke nødder" }, daT))
      .toBe("Alvorlig allergi · Jordnødder · Søn tåler ikke nødder");
  });

  it("colours follow the level, and a cancelled row reads grey", () => {
    expect(allergyTone("severe")).toContain("text-red-700");
    expect(allergyTone("allergy")).toContain("text-amber-800");
    expect(allergyTone("severe", true)).toContain("text-gray-500");
  });

  it("the line: icon + word + allergens + the note; an octagon for severe only", () => {
    const { container, rerender } = render(
      <AllergyLine r={{ allergy_severity: "severe", allergen_tags: ["peanuts", "nuts"], allergy_note: "Min søn" }} t={daT} />,
    );
    const line = container.querySelector("[data-allergy-line]");
    expect(line.textContent).toBe("Alvorlig · Jordnødder, Trænødder · Min søn");
    expect(line.querySelector('[data-allergy-icon="severe"]')).not.toBeNull();
    rerender(<AllergyLine r={{ allergen_tags: ["gluten"] }} t={daT} />);
    expect(container.querySelector("[data-allergy-line]").textContent).toBe("Allergi · Gluten (korn)");
    expect(container.querySelector('[data-allergy-icon="allergy"]')).not.toBeNull();
    rerender(<AllergyLine r={{}} t={daT} />);
    expect(container.querySelector("[data-allergy-line]")).toBeNull();
  });

  it("a link in the guest's note is shown defanged — the stored words never change", () => {
    const r = { allergen_tags: ["nuts"], allergy_note: "Glutenfri.Laktosefri.Nøddeallergi — se www.evil.com" };
    const { container } = render(<AllergyLine r={r} t={tt} />);
    const text = container.querySelector("[data-allergy-line]").textContent;
    expect(text).toContain("Glutenfri.Laktosefri.Nøddeallergi");
    expect(text).not.toContain("www.evil.com");
    expect(r.allergy_note).toBe("Glutenfri.Laktosefri.Nøddeallergi — se www.evil.com");
  });

  it("the icon alone: octagon, question mark or triangle", () => {
    const { container, rerender } = render(<AllergyIcon level="severe" />);
    expect(container.querySelector("svg").getAttribute("data-allergy-icon")).toBe("severe");
    rerender(<AllergyIcon level="possible" />);
    expect(container.querySelector("svg").getAttribute("data-allergy-icon")).toBe("possible");
    rerender(<AllergyIcon level="intolerance" />);
    expect(container.querySelector("svg").getAttribute("data-allergy-icon")).toBe("allergy");
  });

  it("the floor tile, the flags column, the timeline and the rail draw severe as an octagon", () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = (f) => fs.readFileSync(path.resolve(SRC, f), "utf8");
    expect(src("components/FloorPlan.jsx")).toMatch(/allergy === "severe"\s*\?\s*<OctagonAlert/);
    const rp = src("pages/ReservationsPage.jsx");
    expect((rp.match(/level=\{allergy === "severe" \? "severe" : "allergy"\}/g) || []).length).toBe(2);
    expect(rp).toMatch(/level=\{severe \? "severe" : "allergy"\}\s*\n\s*role="img"/);
    expect(src("components/reservations/UpcomingRail.jsx")).toContain('level={severe ? "severe" : "allergy"}');
  });
});

describe("a table freed between two reads (B10)", () => {
  const live = (id, status, table, extra = {}) => ({ id, status, resource_id: table, ...extra });
  it("cancelled or no-show after holding a table", () => {
    const before = [live("a", "confirmed", "t1"), live("b", "seated", "t2"), live("c", "confirmed", "t3")];
    const after = [live("a", "cancelled", "t1"), live("b", "no_show", "t2"), live("c", "confirmed", "t3")];
    expect(freedSince(before, after)).toEqual(["a", "b"]);
  });
  it("a table cleared from a live booking frees it too", () => {
    expect(freedSince([live("a", "confirmed", "t1")], [live("a", "confirmed", null)])).toEqual(["a"]);
    const joined = live("j", "confirmed", "t1", { combined_resource_ids: ["t1", "t2"] });
    expect(tablesHeld(joined)).toEqual(["t1", "t2"]);
    expect(freedSince([joined], [{ ...joined, status: "cancelled" }])).toEqual(["j"]);
  });
  it("not: a request with no table, a finished party, a new booking, this screen's own change", () => {
    expect(freedSince([live("r", "requested", null)], [live("r", "cancelled", null)])).toEqual([]);
    expect(freedSince([live("a", "seated", "t1")], [live("a", "completed", "t1")])).toEqual([]);
    expect(freedSince([], [live("n", "cancelled", "t1")])).toEqual([]);
    expect(freedSince([live("a", "confirmed", "t1")], [live("a", "cancelled", "t1")], new Set(["a"]))).toEqual([]);
  });
  it("at most two per read, and nothing from a missing read", () => {
    const before = ["a", "b", "c"].map((id) => live(id, "confirmed", "t" + id));
    const after = before.map((r) => ({ ...r, status: "cancelled" }));
    expect(freedSince(before, after)).toEqual(["a", "b"]);
    expect(freedSince(null, after)).toEqual([]);
    expect(freedSince(before, undefined)).toEqual([]);
  });
});

describe("the door screen remembers its shape (B11)", () => {
  it("table or provider, nothing else", () => {
    localStorage.clear();
    expect(rememberedStandLayout()).toBeNull();
    rememberStandLayout("provider");
    expect(rememberedStandLayout()).toBe("provider");
    rememberStandLayout("junk");
    expect(rememberedStandLayout()).toBe("provider");
    localStorage.setItem("bonbox_stand_layout", "<script>");
    expect(rememberedStandLayout()).toBeNull();
    rememberStandLayout("table");
    expect(rememberedStandLayout()).toBe("table");
  });
  it("private mode never throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(rememberedStandLayout()).toBeNull();
    expect(() => rememberStandLayout("table")).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
});

describe("the no-fit sheet and the nudge in their own words", () => {
  const r = { id: "g", guest_name: "Selskab Nørgaard", party_size: 8, starts_at: "2026-10-12T20:30:00", guest_phone: null };
  const facts = { party_size: 8, at: "20:30", largest_table: 8, free_seats: 0, times: [] };

  it("Danish: the title, every table taken, no times, no call link without a phone", () => {
    const { container } = render(
      <NoTableFitsSheet r={r} facts={facts} t={daT} onPickTables={() => {}} onMoveTo={() => {}} onConfirmAnyway={() => {}} onClose={() => {}} />,
    );
    const sheet = screen.getByTestId("no-table-fits");
    expect(sheet.textContent).toContain("Intet bord passer til 8 gæster kl. 20.30");
    expect(sheet.textContent).toContain("Alle borde er optaget kl. 20.30.");
    expect(sheet.textContent).toContain("Vælg borde selv");
    expect(sheet.textContent).toContain("Bekræft uden bord");
    expect(container.ownerDocument.querySelector("[data-no-fit-times]")).toBeNull();
    expect(container.ownerDocument.querySelector("[data-no-fit-call]")).toBeNull();
  });

  it("a shop or a workshop speaks of spaces and people", () => {
    render(
      <NoTableFitsSheet r={{ ...r, party_size: 3 }} facts={{ ...facts, party_size: 3, at: "12:00", free_seats: 2, times: ["13:00"] }}
        t={daT} apptWords onPickTables={() => {}} onMoveTo={() => {}} onConfirmAnyway={() => {}} onClose={() => {}} />,
    );
    const sheet = screen.getByTestId("no-table-fits");
    expect(sheet.textContent).toContain("Ingen plads passer til 3 personer kl. 12.00");
    expect(sheet.textContent).toContain("Vælg plads selv");
    expect(sheet.textContent).toContain("Bekræft uden plads");
    expect(sheet.textContent).toContain("Flyt til 13.00 og bekræft");
    expect(sheet.textContent).toContain("kunden får en e-mail");
    expect(sheet.textContent).not.toMatch(/gæst|bord /i);
  });

  it("each action is its own tap", () => {
    const calls = [];
    render(
      <NoTableFitsSheet r={r} facts={{ ...facts, times: ["19:00", "21:45"] }} t={tt}
        onPickTables={() => calls.push("pick")} onMoveTo={(x) => calls.push("move " + x)}
        onConfirmAnyway={() => calls.push("anyway")} onClose={() => calls.push("close")} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Choose tables yourself/ }));
    fireEvent.click(screen.getByRole("button", { name: /Move to 21.45 and confirm/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm without a table/ }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(calls).toEqual(["pick", "move 21:45", "anyway", "close"]);
  });

  it("the nudge: one or many, at most three names, appointment words", () => {
    const m = (id, name, n) => ({ id, guest_name: name, party_size: n });
    const { container, rerender } = render(<FreedTableNudge matches={[m("1", "Bo", 4)]} t={daT} onShow={() => {}} onDismiss={() => {}} />);
    let el = container.querySelector("[data-freed-nudge]");
    expect(el.textContent).toContain("Et bord kan være blevet ledigt");
    expect(el.textContent).toContain("1 på ventelisten passer");
    expect(el.textContent.replace(/\s+/g, "")).toContain("Bo·4");
    rerender(<FreedTableNudge matches={[m("1", "A", 2), m("2", "B", 2), m("3", "C", 2), m("4", "D", 2)]} t={daT} apptWords onShow={() => {}} onDismiss={() => {}} />);
    el = container.querySelector("[data-freed-nudge]");
    expect(el.textContent).toContain("En tid kan være blevet ledig");
    expect(el.textContent).toContain("4 på ventelisten passer");
    expect(el.querySelectorAll("[data-freed-names] li").length).toBe(3);
    rerender(<FreedTableNudge matches={[{ id: "x", guest_name: null }]} t={daT} onShow={() => {}} onDismiss={() => {}} />);
    expect(container.querySelector("[data-freed-names]")).toBeNull();
    rerender(<FreedTableNudge matches={[]} t={daT} onShow={() => {}} onDismiss={() => {}} />);
    expect(container.querySelector("[data-freed-nudge]")).toBeNull();
  });
});

describe("every R11 word, in English and Danish", () => {
  const KEYS = [
    "rsvpConfirmedTables", "rsvpConfirmedNoTable", "rsvpConfirmedNoTableAppt", "rsvpMovedConfirmed",
    "rsvpConfirmTakenAgain", "rsvpConfirmTakenAgainAppt", "rsvpNoFitTitle", "rsvpNoFitTitleAppt",
    "rsvpNoFitTooBig", "rsvpNoFitTooBigAppt", "rsvpNoFitTaken", "rsvpNoFitTakenAppt", "rsvpNoFitFree",
    "rsvpNoFitFreeAppt", "rsvpNoFitFreeNone", "rsvpNoFitFreeNoneAppt", "rsvpNoFitPick", "rsvpNoFitPickAppt",
    "rsvpNoFitPickHint", "rsvpNoFitPickHintAppt", "rsvpNoFitTimes", "rsvpNoFitTimesAppt", "rsvpNoFitMoveTo",
    "rsvpNoFitMoveHint", "rsvpNoFitMoveHintAppt", "rsvpNoFitCall", "rsvpNoFitAnyway", "rsvpNoFitAnywayAppt",
    "rsvpNoFitAnywayHint", "rsvpNoFitAnywayHintAppt", "rsvpAllergyPossible", "rsvpFreedTitle",
    "rsvpFreedTitleAppt", "rsvpFreedFitsOne", "rsvpFreedFitsN", "rsvpFreedShow",
  ];
  const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(",");
  it.each(KEYS)("%s", (k) => {
    expect(typeof en[k]).toBe("string");
    expect(typeof da[k]).toBe("string");
    expect(en[k].trim()).not.toBe("");
    expect(da[k].trim()).not.toBe("");
    expect(da[k]).not.toBe(en[k]);
    expect(holes(da[k])).toBe(holes(en[k]));
  });
  it("appointment variants never speak of tables or guests", () => {
    KEYS.filter((k) => k.endsWith("Appt")).forEach((k) => {
      expect(en[k]).not.toMatch(/\btables?\b|\bguests?\b/i);
      expect(da[k]).not.toMatch(/\bbord\b|\bborde\b|\bgæst/i);
    });
  });
});
