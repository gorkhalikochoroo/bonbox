/**
 * The Option-B grid's model, tested where it can actually be wrong.
 *
 * StaffSchedulePage is ~6.5k lines; mounting it drags in dnd-kit, four
 * providers and six network calls, so the pieces that carry a CLAIM to the
 * owner live in config/scheduleGrid.js and are pinned here:
 *
 *   • the day-header dot — amber says "you still owe this day a publish",
 *     emerald says "everybody has read it". Swap those two and an owner
 *     confidently sends nothing on a Friday.
 *   • "seen by staff" — `confirmed_current ?? !!confirmed_at`. `??` and not
 *     `||`, because an explicit `false` from the backend (the staffer DID
 *     acknowledge, but the owner has moved the shift since) must NOT fall
 *     through to the stale timestamp and re-claim "seen".
 *   • the section-grouping GATE — headers are chrome, and chrome over three
 *     people in one section is noise.
 *
 * The sentences are resolved through the REAL LanguageProvider, not a `t`
 * stub. A stub agrees with whatever it is handed; the thing worth asserting is
 * that a Danish owner reads "4 af 7 er stadig kladder" out of the shipped
 * catalogue.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CONTRACT_TYPES,
  DAY_DOT_CLASS,
  OTHER_SECTION,
  contractLabel,
  dayDotTone,
  dayTallyText,
  groupStaffBySection,
  isSeenByStaff,
  tallyDay,
} from "../config/scheduleGrid";
import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

/* ── real-catalogue harness ───────────────────────────────────────────── */

function Probe({ run }) {
  const { t } = useLanguage();
  return <span data-testid="out">{run(t)}</span>;
}

const withT = (run, lang = "da") => {
  localStorage.setItem("lang", lang);
  const { unmount } = render(
    <LanguageProvider>
      <Probe run={run} />
    </LanguageProvider>,
  );
  const text = screen.getByTestId("out").textContent;
  unmount();
  return text;
};

const draft = (id) => ({ id, status: "draft" });
const published = (id, extra = {}) => ({ id, status: "published", ...extra });

/* ── isSeenByStaff ────────────────────────────────────────────────────── */

describe("isSeenByStaff — the shared contract with the backend", () => {
  it("prefers confirmed_current over the raw timestamp", () => {
    // The owner moved the shift after the staffer acknowledged it: the
    // timestamp is still there, but it is about a shift that no longer exists.
    expect(
      isSeenByStaff({ confirmed_current: false, confirmed_at: "2026-09-15T08:00:00Z" }),
    ).toBe(false);
    expect(isSeenByStaff({ confirmed_current: true, confirmed_at: null })).toBe(true);
  });

  it("falls back to confirmed_at while the backend has not shipped the field", () => {
    expect(isSeenByStaff({ confirmed_at: "2026-09-15T08:00:00Z" })).toBe(true);
    expect(isSeenByStaff({ confirmed_at: null })).toBe(false);
    expect(isSeenByStaff({})).toBe(false);
  });

  it("is false, never a throw, for a missing shift", () => {
    expect(isSeenByStaff(null)).toBe(false);
    expect(isSeenByStaff(undefined)).toBe(false);
  });
});

/* ── tallyDay ─────────────────────────────────────────────────────────── */

describe("tallyDay", () => {
  it("counts drafts separately and never calls one unseen", () => {
    // A draft has not been sent, so it cannot have been ignored. Counting it
    // as unseen would paint a half-written day as staff not reading it.
    const t = tallyDay([draft("a"), draft("b"), published("c", { confirmed_current: true })]);
    expect(t).toEqual({ total: 3, drafts: 2, pub: 1, seen: 1 });
  });

  it("reads `seen` through isSeenByStaff, not through confirmed_at", () => {
    const t = tallyDay([
      published("a", { confirmed_at: "2026-09-15T08:00:00Z", confirmed_current: false }),
      published("b", { confirmed_at: "2026-09-15T08:00:00Z" }),
    ]);
    expect(t.pub).toBe(2);
    expect(t.seen).toBe(1);
  });

  it("survives an empty or ragged day", () => {
    expect(tallyDay([])).toEqual({ total: 0, drafts: 0, pub: 0, seen: 0 });
    expect(tallyDay(null)).toEqual({ total: 0, drafts: 0, pub: 0, seen: 0 });
    expect(tallyDay([null, undefined])).toEqual({ total: 0, drafts: 0, pub: 0, seen: 0 });
  });
});

/* ── dayDotTone ───────────────────────────────────────────────────────── */

describe("dayDotTone", () => {
  it("is silent on an empty day", () => {
    expect(dayDotTone(tallyDay([]))).toBe("none");
  });

  it("puts a draft ahead of everything else", () => {
    // Even when every PUBLISHED shift has been seen — the unsent one is the
    // only thing on the column that asks the owner to act.
    const t = tallyDay([draft("a"), published("b", { confirmed_current: true })]);
    expect(dayDotTone(t)).toBe("draft");
    expect(DAY_DOT_CLASS.draft).toBe("bg-amber-500");
  });

  it("only goes emerald when EVERY published shift has been seen", () => {
    expect(
      dayDotTone(tallyDay([published("a", { confirmed_current: true }), published("b", { confirmed_current: true })])),
    ).toBe("seen");
    expect(
      dayDotTone(tallyDay([published("a", { confirmed_current: true }), published("b")])),
    ).toBe("neutral");
    expect(DAY_DOT_CLASS.seen).toBe("bg-emerald-500");
  });

  it("stays neutral — not amber — when staff simply have not looked yet", () => {
    // Amber here would cry wolf every Monday morning. Nobody is late; the
    // rota went out an hour ago.
    expect(dayDotTone(tallyDay([published("a"), published("b")]))).toBe("neutral");
  });
});

/* ── dayTallyText (real catalogue) ────────────────────────────────────── */

describe("dayTallyText — the sentence behind the dot", () => {
  it("names the drafts in Danish", () => {
    const t = { total: 7, drafts: 4, pub: 3, seen: 3 };
    expect(withT((tr) => dayTallyText(t, tr), "da")).toBe("4 af 7 er stadig kladder");
    expect(withT((tr) => dayTallyText(t, tr), "en")).toBe("4 of 7 are still drafts");
  });

  it("says everyone has seen it when everyone has", () => {
    const t = tallyDay([published("a", { confirmed_current: true })]);
    expect(withT((tr) => dayTallyText(t, tr), "da")).toBe("Alle har set deres vagt");
    expect(withT((tr) => dayTallyText(t, tr), "en")).toBe("Everyone has seen their shift");
  });

  it("counts the partial case honestly", () => {
    const t = tallyDay([published("a", { confirmed_current: true }), published("b"), published("c")]);
    expect(withT((tr) => dayTallyText(t, tr), "da")).toBe("1 af 3 har set deres vagt");
  });

  it("does not say '0 of 0' for a status it does not know", () => {
    // Neither draft nor published — the shape we don't expect. Say the count.
    const t = tallyDay([{ id: "x", status: "archived" }]);
    expect(dayDotTone(t)).toBe("neutral");
    expect(withT((tr) => dayTallyText(t, tr), "da")).toBe("1 vagter denne dag");
  });

  it("has a real sentence for an empty day, never a raw key", () => {
    const t = tallyDay([]);
    expect(withT((tr) => dayTallyText(t, tr), "da")).toBe("Ingen vagter denne dag");
    expect(withT((tr) => dayTallyText(t, tr), "en")).toBe("No shifts this day");
  });
});

/* ── groupStaffBySection ──────────────────────────────────────────────── */

const cafe = (staff) => groupStaffBySection(staff, "cafe");

const people = (...roles) => roles.map((role, i) => ({ id: `s${i}`, name: `P${i}`, role }));

describe("groupStaffBySection — the gate", () => {
  it("does not group a vertical that has no sections", () => {
    // A shop has no Køkken and no Gulv. Inventing one is vocabulary theatre —
    // the same reason roleSections.sectionFor() returns null there.
    const staff = people("Sælger", "Sælger", "Lager", "Kasse");
    expect(groupStaffBySection(staff, "retail").grouped).toBe(false);
    expect(groupStaffBySection(staff, "personal").grouped).toBe(false);
  });

  it("does not group fewer than four people", () => {
    expect(cafe(people("Chef", "Server", "Bartender")).grouped).toBe(false);
  });

  it("does not group when only one real section is populated", () => {
    // Five servers and a DJ: one section and a stray, not two groups.
    const g = cafe(people("Server", "Server", "Tjener", "Runner", "DJ"));
    expect(g.grouped).toBe(false);
  });

  it("groups a real mixed roster in service order", () => {
    const g = cafe(people("Server", "Chef", "Bartender", "Opvasker"));
    expect(g.grouped).toBe(true);
    expect(g.sections.map((s) => s.id)).toEqual(["kitchen", "bar", "floor"]);
    expect(g.sections[0].members.map((m) => m.role)).toEqual(["Chef", "Opvasker"]);
  });

  it("files an unknown role under `other`, always last", () => {
    const g = cafe(people("Chef", "Server", "Bartender", "DJ"));
    expect(g.grouped).toBe(true);
    expect(g.sections.map((s) => s.id).at(-1)).toBe(OTHER_SECTION);
    // NOT kitchen/bar/floor: the raw sectionFor() is used precisely so the
    // grid's `|| "floor"` fallback cannot put a DJ under a Gulv header.
    expect(g.sections.find((s) => s.id === OTHER_SECTION).members[0].role).toBe("DJ");
  });

  it("splits a salon into its own two sections", () => {
    const g = groupStaffBySection(
      people("Frisør", "Kolorist", "Reception", "Barber"),
      "salon",
    );
    expect(g.sections.map((s) => s.id)).toEqual(["treatment", "front"]);
  });

  it("returns the flat shape, never a throw, for junk input", () => {
    expect(groupStaffBySection(null, "cafe").grouped).toBe(false);
    expect(groupStaffBySection([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], "cafe").grouped).toBe(false);
  });
});

/* ── contractLabel ────────────────────────────────────────────────────── */

describe("contractLabel", () => {
  it("reads Danish for a Danish owner", () => {
    expect(withT((tr) => contractLabel("full", tr), "da")).toBe("Fuldtid");
    expect(withT((tr) => contractLabel("part", tr), "da")).toBe("Deltid");
    expect(withT((tr) => contractLabel("student", tr), "da")).toBe("Studerende");
    expect(withT((tr) => contractLabel("freelance", tr), "da")).toBe("Freelance");
  });

  it("reads English for an English owner", () => {
    expect(withT((tr) => contractLabel("part", tr), "en")).toBe("Part-time");
  });

  it("returns an empty string for a missing value so no empty chip renders", () => {
    expect(withT((tr) => contractLabel(null, tr), "da")).toBe("");
    expect(withT((tr) => contractLabel("", tr), "da")).toBe("");
  });

  it("shows an unknown stored value rather than swallowing it", () => {
    expect(withT((tr) => contractLabel("vikar", tr), "da")).toBe("vikar");
  });

  it("gives every contract type a real word in both locales", () => {
    for (const ct of CONTRACT_TYPES) {
      for (const lang of ["en", "da"]) {
        expect(withT((tr) => contractLabel(ct.value, tr), lang), `${ct.value} @ ${lang}`)
          .not.toBe(ct.labelKey);
      }
    }
  });
});
