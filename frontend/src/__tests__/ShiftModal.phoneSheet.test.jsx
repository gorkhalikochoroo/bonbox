/**
 * "An owner cannot add a shift on a phone."
 *
 * ShiftModal used to be a hand-rolled overlay: `fixed inset-0 flex
 * items-center justify-center` around a card with NO max-height and NO
 * internal scroll. On a 390×844 phone the form is taller than the viewport,
 * so a vertically-centred card overflows BOTH ways — the title is clipped off
 * the top and "Tilføj vagt" sits below the fold with nothing to scroll. The
 * job stops outright. This file pins that down as DOM.
 *
 * WHAT JSDOM CAN AND CANNOT PROVE. jsdom has no layout engine: every
 * offsetHeight is 0 and every getBoundingClientRect is a zero rect, so
 * "is it taller than 844px" is not measurable here and any test claiming to
 * measure it would be asserting a fiction. What IS measurable is the
 * mechanism that bounds the height — a cap, a flex column that clips, one
 * growing scroll region, a shrink-0 footer — and the containment question the
 * finding actually turns on: is the primary action inside the scroller (it
 * scrolls away) or outside it (it is pinned)?
 *
 * So: TAILWIND_FIXTURE below maps the exact utility classes these elements
 * ship to their real Tailwind declarations, jsdom cascades them, and the
 * assertions read computed style. Every class is asserted present on the
 * element BEFORE its value is read, so the fixture cannot quietly describe a
 * page that no longer exists. And the last describe block runs the same
 * audit against a reconstruction of the pre-port markup and shows it FAILING
 * on all four counts — the positive control that proves these assertions
 * discriminate rather than pass on anything.
 *
 * Danish catalogue throughout: the strings below are the shipped ones.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn(() => Promise.resolve({ data: [] }));
const apiPost = vi.fn(() => Promise.resolve({ data: {} }));
const apiDelete = vi.fn(() => Promise.resolve({ data: {} }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
    put: (...a) => vi.fn()(...a),
    delete: (...a) => apiDelete(...a),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "cafe", role: "owner" } }),
}));

const { ShiftModal } = await import("../pages/StaffSchedulePage");
const { LanguageProvider } = await import("../hooks/useLanguage");

// ── The phone the finding was made on ────────────────────────────────────
const PHONE = { width: 390, height: 844 };

// ── Tailwind fixture ─────────────────────────────────────────────────────
// Only the utilities the dialog's three structural rows depend on. Keys are
// the class strings exactly as they appear in the source; values are the
// declarations Tailwind generates for them.
const TAILWIND_FIXTURE = {
  "max-h-[92dvh]": "max-height:92dvh",
  flex: "display:flex",
  "flex-col": "flex-direction:column",
  "overflow-hidden": "overflow:hidden",
  "flex-1": "flex:1 1 0%",
  "overflow-y-auto": "overflow-y:auto",
  "shrink-0": "flex-shrink:0",
  // Needed by the focus-trap edge cases: a `display:none` focusable is the
  // shape that broke the trap, and jsdom resolves display from a class rule.
  hidden: "display:none",
};

function installTailwindFixture() {
  const css = Object.entries(TAILWIND_FIXTURE)
    .map(([cls, decl]) => `.${cls.replace(/[[\]]/g, (c) => "\\" + c)}{${decl}}`)
    .join("\n");
  const el = document.createElement("style");
  el.setAttribute("data-tailwind-fixture", "");
  el.textContent = css;
  document.head.appendChild(el);
}

/** Assert a class is really on the element, then read what it resolves to. */
function styleFrom(el, cls, prop) {
  expect(Array.from(el.classList)).toContain(cls);
  return getComputedStyle(el)[prop];
}

const WEEK = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 21 + i)); // Mon 21 Sep 2026
const STAFF = [
  { id: "st-a", name: "Mette", role: "Server", active: true },
  { id: "st-b", name: "Jonas", role: "Chef", active: true },
];
const EXISTING = {
  id: "sh-1",
  staff_member_id: "st-a",
  date: "2026-09-23",
  start_time: "12:00",
  end_time: "20:00",
  break_minutes: 30,
  role_on_shift: "Server",
  status: "published",
};

async function mount(modal, props = {}) {
  localStorage.setItem("lang", "da");
  let utils;
  await act(async () => {
    utils = render(
      <LanguageProvider>
        <ShiftModal
          modal={modal}
          staff={STAFF}
          shifts={[]}
          weekDates={WEEK}
          lastTemplate={null}
          onTemplateSave={vi.fn()}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          {...props}
        />
      </LanguageProvider>,
    );
  });
  return utils;
}

const ADD = { staffId: "st-a", date: "2026-09-23", shift: null };
const EDIT = { staffId: "st-a", date: "2026-09-23", shift: EXISTING };

beforeEach(() => {
  apiGet.mockClear();
  apiPost.mockClear();
  apiDelete.mockClear();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: PHONE.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: PHONE.height });
  // jsdom ships no visualViewport; the keyboard block below stubs one per
  // test, and this clears it so no other test inherits an open keyboard.
  Object.defineProperty(window, "visualViewport", { configurable: true, writable: true, value: undefined });
  document.querySelectorAll("[data-tailwind-fixture]").forEach((n) => n.remove());
  installTailwindFixture();
});

describe("ShiftModal on a 390×844 phone", () => {
  it("bounds its own height instead of running off both ends of the screen", async () => {
    await mount(ADD);
    const panel = document.querySelector("[data-sheet-panel]");
    expect(panel).not.toBeNull();

    // A cap, expressed against the VIEWPORT (dvh), not the content. Without
    // this the card is as tall as the form and centring pushes half of it
    // off-screen in each direction.
    const cap = styleFrom(panel, "max-h-[92dvh]", "maxHeight");
    const [, num, unit] = /^(\d+(?:\.\d+)?)(dvh|vh|svh)$/.exec(cap) || [];
    expect(unit, `max-height should be viewport-relative, got "${cap}"`).toBeTruthy();
    expect(Number(num)).toBeLessThanOrEqual(100);

    // …and a cap only bounds anything if the box actually clips: a flex
    // column with overflow hidden, so the rows below divide the capped space.
    expect(styleFrom(panel, "flex", "display")).toBe("flex");
    expect(styleFrom(panel, "flex-col", "flexDirection")).toBe("column");
    expect(styleFrom(panel, "overflow-hidden", "overflow")).toBe("hidden");
  });

  it("gives the form one scrolling region so nothing is unreachable", async () => {
    await mount(ADD);
    const body = document.querySelector("[data-sheet-body]");
    expect(body).not.toBeNull();
    expect(styleFrom(body, "overflow-y-auto", "overflowY")).toBe("auto");
    // flex-1 is what makes the body absorb the leftover height — without it a
    // scroll container inside a capped column is still sized by its content.
    expect(styleFrom(body, "flex-1", "flex")).toMatch(/^1 1 0(%|px)?$/);

    // The fields an owner fills are in there, and the body is the only
    // scroller — a second one would mean a nested trap.
    expect(body.querySelectorAll("select, input").length).toBeGreaterThan(5);
    const scrollers = Array.from(document.querySelectorAll("[data-sheet-panel] *")).filter((el) => {
      const o = getComputedStyle(el);
      return o.overflowY === "auto" || o.overflowY === "scroll";
    });
    expect(scrollers).toEqual([body]);
  });

  it("pins the primary action in a footer instead of letting it scroll away", async () => {
    await mount(ADD);
    const body = document.querySelector("[data-sheet-body]");
    const footer = document.querySelector("[data-sheet-footer]");
    expect(footer).not.toBeNull();

    const save = screen.getByRole("button", { name: "Tilføj vagt" });
    // THE assertion. Below the fold with nothing to scroll was the bug; being
    // outside the scroller is what fixes it.
    expect(footer.contains(save)).toBe(true);
    expect(body.contains(save)).toBe(false);
    expect(styleFrom(footer, "shrink-0", "flexShrink")).toBe("0");

    // Clear of the home indicator on a notched phone.
    expect(getComputedStyle(footer).paddingBottom).toContain("env(safe-area-inset-bottom)");
  });

  it("is a real dialog: portalled, labelled, and dismissible without hunting a glyph", async () => {
    const onClose = vi.fn();
    const { container } = await mount(ADD, { onClose });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // Portalled to <body>: a transformed or sticky ancestor on the schedule
    // page can no longer clip the sheet.
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Tilføj vagt");

    // The close control is a labelled button with a Lucide mark, not a bare
    // "×" character a screen reader reads as "multiplication sign".
    const close = screen.getByRole("button", { name: "Luk" });
    expect(close.textContent).not.toContain("×");
    expect(close.querySelector("svg")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps Tab inside the sheet and hands focus back on close", async () => {
    // aria-modal="true" claims the page behind is inert. Without a trap that
    // claim is false: Tab walks straight out into the schedule grid. These
    // three assertions are the behaviour behind the attribute.
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = await mount(ADD);
    const panel = document.querySelector("[data-sheet-panel]");
    // Focus lands on the PANEL, not the first select — focusing a field would
    // throw the keyboard over a sheet the owner has not read yet.
    expect(document.activeElement).toBe(panel);
    expect(document.body.style.overflow).toBe("hidden");

    const stops = Array.from(panel.querySelectorAll("button, select, input"));
    // Tab from the panel wraps to the first stop; Shift+Tab from it wraps to
    // the last — either way the focus ring never leaves the dialog.
    // Dispatched on the FOCUSED element, the way a browser does it: the trap
    // listens on the panel, not on document, so that a dialog stacked above a
    // still-mounted sheet keeps its own Tab (see the stacking test below).
    fireEvent.keyDown(document.activeElement, { key: "Tab" });
    expect(document.activeElement).toBe(stops[0]);
    stops[0].focus();
    fireEvent.keyDown(document.activeElement, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);

    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("wraps onto the last VISIBLE control, not a display:none one", async () => {
    // Snap-a-receipt ships `<input type="file" className="hidden">` as the
    // last focusable in its panel. An unfiltered querySelectorAll made that
    // undrawable input the computed `last`, so `activeElement === last` was
    // never true, the forward wrap never fired, and Tab walked out of the
    // dialog into the page behind — the exact leak the trap was added to
    // close. Reproduced here by putting the same shape in this sheet.
    await mount(ADD);
    const panel = document.querySelector("[data-sheet-panel]");
    const ghost = document.createElement("input");
    ghost.type = "file";
    ghost.className = "hidden";
    panel.appendChild(ghost);
    expect(getComputedStyle(ghost).display).toBe("none"); // the fixture really hides it

    const visible = Array.from(panel.querySelectorAll("button, select, input")).filter(
      (el) => getComputedStyle(el).display !== "none",
    );
    const lastVisible = visible[visible.length - 1];
    expect(lastVisible).not.toBe(ghost);

    lastVisible.focus();
    fireEvent.keyDown(document.activeElement, { key: "Tab" });
    // Wrapped forward to the first control — NOT escaped, and not parked on
    // an element the owner cannot see.
    expect(document.activeElement).toBe(visible[0]);

    visible[0].focus();
    fireEvent.keyDown(document.activeElement, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastVisible);
    ghost.remove();
  });

  it("leaves Tab alone inside a dialog stacked on top of it", async () => {
    // ReservationsPage opens its edit form over a drawer it deliberately keeps
    // mounted. While the trap listened on `document` it fired wherever focus
    // was, so every Tab in that form was thrown back into the drawer behind —
    // the form could not be traversed by keyboard at all. Scoping the listener
    // to the panel fixes it by construction; this pins that.
    await mount(ADD);
    const panel = document.querySelector("[data-sheet-panel]");
    expect(panel).not.toBeNull();

    const above = document.createElement("div");
    above.setAttribute("role", "dialog");
    above.innerHTML = '<input id="above-a" /><input id="above-b" />';
    document.body.appendChild(above);
    const a = above.querySelector("#above-a");
    a.focus();

    fireEvent.keyDown(document.activeElement, { key: "Tab" });
    // Still in the stacked dialog. Native tab order takes it from here; what
    // matters is that the sheet below did not grab it.
    expect(document.activeElement).toBe(a);
    expect(panel.contains(document.activeElement)).toBe(false);
    above.remove();
  });
});

describe("ShiftModal when the software keyboard is up", () => {
  // The height cap is `max-h-[92dvh]`, and dvh tracks the LAYOUT viewport —
  // which iOS does not shrink for the keyboard (index.html has no
  // interactive-widget hint, and Safari ignores it anyway). So the honest
  // statement of the original defect is landscape / short-window, and the
  // keyboard is a SEPARATE failure the cap alone does not cover: the sheet
  // keeps its full height and parks the pinned footer under the keyboard.
  // visualViewport is the only API that reports the real visible box.
  function stubVisualViewport({ height, offsetTop = 0 }) {
    const listeners = new Set();
    const vv = {
      height,
      offsetTop,
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, writable: true, value: vv });
    return vv;
  }

  it("caps and lifts the sheet to the visible height, not the layout height", async () => {
    // 390×844 phone, iOS keyboard open: innerHeight stays 844, the visual
    // viewport is 508.
    stubVisualViewport({ height: 508 });
    await mount(ADD);

    const overlay = document.querySelector('[role="dialog"]');
    const panel = document.querySelector("[data-sheet-panel]");
    // 844 − 508 − 0 = 336px of keyboard. The overlay's bottom edge moves up by
    // exactly that, so `items-end` lands the sheet ON TOP of the keyboard…
    expect(overlay.style.bottom).toBe("336px");
    // …and the panel is capped against the shrunken overlay rather than dvh,
    // so the footer is inside the visible box instead of below it.
    expect(panel.style.maxHeight).toBe("92%");
  });

  it("does not move for URL-bar chrome", async () => {
    // A 40px delta is the collapsing address bar, not a keyboard. Reacting to
    // it would make the sheet twitch on every scroll.
    stubVisualViewport({ height: 804 });
    await mount(ADD);
    const overlay = document.querySelector('[role="dialog"]');
    const panel = document.querySelector("[data-sheet-panel]");
    expect(overlay.style.bottom).toBe("");
    expect(panel.style.maxHeight).toBeFalsy();
  });
});

describe("ShiftModal — the container swap kept the form", () => {
  it("still seeds 16:00–23:00 and offers every field", async () => {
    await mount(ADD);
    const body = document.querySelector("[data-sheet-body]");
    // staff, date, start h/m, end h/m, role = 7 selects; break + notes = 2 inputs.
    expect(body.querySelectorAll("select")).toHaveLength(7);
    expect(body.querySelectorAll("input")).toHaveLength(2);
    expect(screen.getByText("Medarbejder")).toBeInTheDocument();
    expect(screen.getByText("Rolle på vagten")).toBeInTheDocument();
    expect(screen.getByText("Pause (minutter)")).toBeInTheDocument();
    const selects = Array.from(body.querySelectorAll("select")).map((s) => s.value);
    expect(selects.slice(2, 6)).toEqual(["16", "00", "23", "00"]);
  });

  it("still turns a 409 overlap into the honest Danish sentence, inside the scroller", async () => {
    apiPost.mockRejectedValueOnce({
      response: { status: 409, data: { detail: { code: "shift_overlap" } } },
    });
    await mount(ADD);
    fireEvent.click(screen.getByRole("button", { name: "Tilføj vagt" }));
    await waitFor(() =>
      expect(screen.getByText("Det overlapper en vagt, de allerede har den dag.")).toBeInTheDocument(),
    );
    // The error belongs in the scroll body; the footer stays the action row.
    const body = document.querySelector("[data-sheet-body]");
    expect(body.textContent).toContain("Det overlapper en vagt");
  });

  it("still deletes in two steps, and the confirm lands in the pinned footer", async () => {
    await mount(EDIT);
    expect(screen.getByRole("button", { name: "Opdater vagt" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Slet vagt" }));
    const footer = document.querySelector("[data-sheet-footer]");
    expect(footer.textContent).toContain("Slet denne vagt?");
    expect(apiDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Slet vagt" }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith("/staff/schedules/sh-1"));
  });
});

describe("the pre-port markup this replaced", () => {
  // The overlay exactly as it shipped at HEAD 8ddc34af — centred, uncapped,
  // no scroller, actions as the last child of the same box. Kept here as the
  // positive control: the four assertions above must FAIL on it, or they are
  // not testing anything.
  function LegacyShiftOverlay() {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
        <div
          data-legacy-panel=""
          className="relative bg-white rounded-xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-4"
        >
          <h2>Tilføj vagt</h2>
          <select />
          <div className="flex items-center justify-between pt-2">
            <button type="button">Tilføj vagt</button>
          </div>
        </div>
      </div>
    );
  }

  it("had no cap, no scroller, and its save button inside the same unscrollable box", () => {
    const { container } = render(<LegacyShiftOverlay />);
    const panel = container.querySelector("[data-legacy-panel]");

    // 1. No height cap at all.
    expect(getComputedStyle(panel).maxHeight).toBe("");
    // 2. Nothing in the tree scrolls.
    const scrollers = Array.from(panel.querySelectorAll("*")).filter((el) => {
      const o = getComputedStyle(el).overflowY;
      return o === "auto" || o === "scroll";
    });
    expect(scrollers).toHaveLength(0);
    // 3. No footer to pin anything to — the save button is just the last child.
    expect(container.querySelector("[data-sheet-footer]")).toBeNull();
    const save = screen.getByRole("button", { name: "Tilføj vagt" });
    expect(save.closest("[data-sheet-footer]")).toBeNull();
    // 4. Not a dialog, not portalled: no role, and it renders in place where a
    //    transformed ancestor can clip it.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.contains(panel)).toBe(true);
  });
});
