/**
 * The shift sheet and the new fravær sheet, after the Vagtplan review round.
 *
 * Each block pins one finding an owner would hit:
 *   • Enter / Go saves (a real <form>), and a double submit makes ONE shift;
 *   • an edit sends the shift's own status — a published shift stays
 *     published (the PUT used to turn it into a draft);
 *   • start = end is refused in the sheet, in Danish, before any request;
 *   • the 11-hour and 48-hour rules are named BEFORE saving — and a legal
 *     split shift is not called a violation;
 *   • the overlap refusal names who and which shift;
 *   • Danish clock ("16.00"), errors that clear, a role that follows a
 *     reassignment, a 4-hour shift that does not inherit a 45-minute break;
 *   • fravær: the owner can register it, sees it, and can take it back.
 *
 * Danish catalogue throughout — the strings asserted are the shipped ones.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn(() => Promise.resolve({ data: [] }));
const apiPost = vi.fn(() => Promise.resolve({ data: {} }));
const apiPut = vi.fn(() => Promise.resolve({ data: {} }));
const apiDelete = vi.fn(() => Promise.resolve({ data: {} }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
    put: (...a) => apiPut(...a),
    delete: (...a) => apiDelete(...a),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "cafe", role: "owner" } }),
}));

const { ShiftModal, AbsenceSheet } = await import("../pages/StaffSchedulePage");
const { LanguageProvider, useLanguage } = await import("../hooks/useLanguage");

const WEEK = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 21 + i)); // Mon 21 Sep 2026
const MON = "2026-09-21";
const TUE = "2026-09-22";
const STAFF = [
  { id: "st-a", name: "Mette", role: "Server", active: true },
  { id: "st-b", name: "Jonas", role: "Chef", active: true },
];
const PUBLISHED = {
  id: "sh-1", staff_id: "st-a", date: TUE, start_time: "12:00", end_time: "20:00",
  break_minutes: 30, role_on_shift: "Server", status: "published",
};

beforeEach(() => {
  apiGet.mockClear();
  apiPost.mockReset();
  apiPost.mockImplementation(() => Promise.resolve({ data: {} }));
  apiPut.mockClear();
  apiDelete.mockClear();
});

async function mountSheet(modal, props = {}) {
  localStorage.setItem("lang", "da");
  const onSaved = props.onSaved || vi.fn();
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
          onSaved={onSaved}
          {...props}
        />
      </LanguageProvider>,
    );
  });
  return { ...utils, onSaved };
}

const body = () => document.querySelector("[data-sheet-body]");
const timeSelects = () => Array.from(body().querySelectorAll("select")).slice(2, 6);

describe("the shift sheet is a form", () => {
  it("saves on Enter (the keyboard's Go) and makes ONE shift on a double submit", async () => {
    let resolve;
    apiPost.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    const form = document.querySelector("[data-sheet-panel] form");
    expect(form).not.toBeNull();
    // Enter in the notes field submits the form; a second Enter lands before
    // the first request has answered.
    const notes = body().querySelectorAll("input")[1];
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(notes).toBeInTheDocument();
    await act(async () => { resolve({ data: { id: "new" } }); });
  });

  it("puts the save button in the form as its submit", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    const save = screen.getByRole("button", { name: "Tilføj vagt" });
    expect(save.getAttribute("type")).toBe("submit");
    // Every other button is type=button — a Cancel that submitted would save.
    for (const b of document.querySelectorAll("[data-sheet-panel] button")) {
      if (b !== save) expect(b.getAttribute("type")).toBe("button");
    }
  });
});

describe("an edit keeps the shift's status", () => {
  it("sends the published status back on a time change", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: PUBLISHED });
    fireEvent.change(timeSelects()[2], { target: { value: "21" } });
    fireEvent.click(screen.getByRole("button", { name: "Opdater vagt" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [url, payload] = apiPut.mock.calls[0];
    expect(url).toBe("/staff/schedules/sh-1");
    expect(payload.status).toBe("published");
    expect(payload.end_time).toBe("21:00");
  });

  it("does not invent a status for a new shift (the server makes it a draft)", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    fireEvent.click(screen.getByRole("button", { name: "Tilføj vagt" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).not.toHaveProperty("status");
  });
});

describe("start = end", () => {
  it("is refused in the sheet, in Danish, and never sent", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    const [sh, sm, eh, em] = timeSelects();
    fireEvent.change(sh, { target: { value: "16" } });
    fireEvent.change(sm, { target: { value: "00" } });
    fireEvent.change(eh, { target: { value: "16" } });
    fireEvent.change(em, { target: { value: "00" } });
    expect(screen.getByText("Start og slut kan ikke være samme tidspunkt.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Tilføj vagt" });
    expect(save).toBeDisabled();
    fireEvent.submit(document.querySelector("[data-sheet-panel] form"));
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("the rules, before saving", () => {
  const closing = [{ id: "c", staff_id: "st-a", date: MON, start_time: "14:00", end_time: "22:00", break_minutes: 0 }];

  it("names the person and the rest when 22:00 is followed by 06:00", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: null }, { shifts: closing });
    const [sh, , eh] = timeSelects();
    fireEvent.change(sh, { target: { value: "06" } });
    fireEvent.change(eh, { target: { value: "14" } });
    const box = await screen.findByTestId("shift-rule-warnings");
    expect(box.textContent).toMatch(/Mette: kun 8 t hvile i træk i døgnet fra/);
    expect(box.textContent).toContain("kl. 14.00");
    expect(box.textContent).toContain("11-timersreglen");
    // In the pinned footer, i.e. on screen right above "Tilføj vagt".
    expect(document.querySelector("[data-sheet-footer]").contains(box)).toBe(true);
  });

  it("stays quiet for a legal split shift", async () => {
    const lunch = [{ id: "l", staff_id: "st-a", date: TUE, start_time: "11:00", end_time: "15:00", break_minutes: 0 }];
    await mountSheet({ staffId: "st-a", date: TUE, shift: null }, { shifts: lunch });
    const [sh, , eh] = timeSelects();
    fireEvent.change(sh, { target: { value: "17" } });
    fireEvent.change(eh, { target: { value: "22" } });
    expect(screen.queryByTestId("shift-rule-warnings")).toBeNull();
  });

  it("names the 48-hour week with its hours", async () => {
    const long = [0, 1, 2, 3, 4].map((i) => ({
      id: `d${i}`, staff_id: "st-a", date: `2026-09-2${1 + i}`, start_time: "08:00", end_time: "18:00", break_minutes: 0,
    }));
    // The sheet seeds Saturday from her latest shift (08–18, no break):
    // 50 + 10 = 60 hours.
    await mountSheet({ staffId: "st-a", date: "2026-09-26", shift: null }, { shifts: long });
    const box = await screen.findByTestId("shift-rule-warnings");
    expect(box.textContent).toContain("Mette: 60 t denne uge — over 48-timersgrænsen");
  });

  it("flags a day the person is registered off", async () => {
    await mountSheet(
      { staffId: "st-a", date: TUE, shift: null },
      { absenceFor: (id, d) => (id === "st-a" && d.getDate() === 22 ? { kind: "ferie" } : null) },
    );
    const box = await screen.findByTestId("shift-rule-warnings");
    expect(box.textContent).toContain("Mette: Ferie denne dag — registreret som fraværende");
  });
});

describe("the overlap refusal", () => {
  it("names who and which shift, in the Danish clock", async () => {
    apiPost.mockRejectedValueOnce({
      response: { status: 409, data: { detail: {
        code: "shift_overlap", staff_name: "Mette", existing_start: "16:00", existing_end: "22:00",
      } } },
    });
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    fireEvent.click(screen.getByRole("button", { name: "Tilføj vagt" }));
    await waitFor(() =>
      expect(screen.getByText("Mette har allerede en vagt 16.00–22.00 den dag.")).toBeInTheDocument(),
    );
  });

  it("clears when the owner moves to another day", async () => {
    apiPost.mockRejectedValueOnce({ response: { status: 409, data: { detail: { code: "shift_overlap" } } } });
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    fireEvent.click(screen.getByRole("button", { name: "Tilføj vagt" }));
    await screen.findByText("Det overlapper en vagt, de allerede har den dag.");
    fireEvent.change(body().querySelectorAll("select")[1], { target: { value: "2026-09-23" } });
    expect(screen.queryByText("Det overlapper en vagt, de allerede har den dag.")).toBeNull();
  });
});

describe("the small things that made the sheet lie", () => {
  it("writes the time the Danish way", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    const seps = Array.from(body().querySelectorAll("span.self-center")).map((s) => s.textContent);
    expect(seps).toEqual([".", "."]);
    expect(body().textContent).toContain("Vagt: 16.00 – 23.00");
  });

  it("drops the inherited 45-minute break when the shift becomes a 4-hour one", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    const brk = body().querySelectorAll("input")[0];
    expect(brk.value).toBe("45"); // 16–23 seeds the DK break
    fireEvent.change(timeSelects()[2], { target: { value: "20" } }); // 16–20
    expect(brk.value).toBe("0");
    fireEvent.change(timeSelects()[2], { target: { value: "23" } }); // back to 7 h
    expect(brk.value).toBe("45");
  });

  it("leaves a break the owner typed alone", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: null });
    const brk = body().querySelectorAll("input")[0];
    fireEvent.change(brk, { target: { value: "30" } });
    fireEvent.change(timeSelects()[2], { target: { value: "20" } });
    expect(brk.value).toBe("30");
  });

  it("gives a reassigned shift the new person's role", async () => {
    await mountSheet({ staffId: "st-a", date: TUE, shift: PUBLISHED });
    const [staffSel] = body().querySelectorAll("select");
    const roleSel = body().querySelectorAll("select")[6];
    expect(roleSel.value).toBe("Server");
    fireEvent.change(staffSel, { target: { value: "st-b" } }); // Jonas, Chef
    expect(roleSel.value).toBe("Chef");
  });

  it("opens on the day it was given, not on Monday", async () => {
    await mountSheet({ staffId: null, date: "2026-09-26", shift: null });
    expect(body().querySelectorAll("select")[1].value).toBe("2026-09-26");
  });

  it("offers fravær for the person and day on screen", async () => {
    const onAbsence = vi.fn();
    await mountSheet({ staffId: "st-a", date: TUE, shift: PUBLISHED }, { onAbsence });
    fireEvent.click(screen.getByRole("button", { name: /Registrér fravær/ }));
    expect(onAbsence).toHaveBeenCalledWith("st-a", TUE);
  });
});

// ── Fravær sheet ─────────────────────────────────────────────────────

function AbsenceHarness(props) {
  const { t, lang } = useLanguage();
  return (
    <AbsenceSheet
      staff={STAFF}
      initialStaffId="st-a"
      initialDate="2026-10-07"
      absences={[]}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onSaved={vi.fn()}
      t={t}
      lang={lang}
      {...props}
    />
  );
}

async function mountAbsence(props = {}) {
  localStorage.setItem("lang", "da");
  await act(async () => {
    render(
      <LanguageProvider>
        <AbsenceHarness {...props} />
      </LanguageProvider>,
    );
  });
}

describe("the fravær sheet", () => {
  it("registers syg for the person and day it was opened on", async () => {
    const onSaved = vi.fn();
    const onChanged = vi.fn();
    await mountAbsence({ onSaved, onChanged });
    expect(screen.getByRole("button", { name: "Syg" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Gem fravær" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]).toEqual([
      "/staff/absences",
      { staff_id: "st-a", kind: "sick", date_from: "2026-10-07", date_to: "2026-10-07" },
    ]);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    expect(onSaved.mock.calls[0][0]).toMatch(/^Mette: Syg .* registreret$/);
  });

  it("registers ferie over a range", async () => {
    await mountAbsence();
    fireEvent.click(screen.getByRole("button", { name: "Ferie" }));
    fireEvent.change(screen.getByLabelText("Til"), { target: { value: "2026-10-11" } });
    fireEvent.click(screen.getByRole("button", { name: "Gem fravær" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toMatchObject({ kind: "ferie", date_from: "2026-10-07", date_to: "2026-10-11" });
  });

  it("refuses an end before the start, in Danish, without asking the server", async () => {
    await mountAbsence();
    fireEvent.change(screen.getByLabelText("Til"), { target: { value: "2026-10-01" } });
    expect(screen.getByText("Slutdatoen ligger før startdatoen.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gem fravær" })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("translates the server's refusal codes", async () => {
    apiPost.mockRejectedValueOnce({ response: { status: 422, data: { detail: { code: "out_of_window", message: "x" } } } });
    await mountAbsence();
    fireEvent.click(screen.getByRole("button", { name: "Gem fravær" }));
    expect(await screen.findByText("Vælg datoer fra den seneste måned og op til et år frem.")).toBeInTheDocument();
  });

  it("lists what is registered and takes a range back in two steps", async () => {
    const onChanged = vi.fn();
    const absences = [
      { id: "a1", staff_id: "st-a", kind: "ferie", date: "2026-10-12", status: "acknowledged" },
      { id: "a2", staff_id: "st-a", kind: "ferie", date: "2026-10-13", status: "acknowledged" },
      { id: "x9", staff_id: "st-b", kind: "sick", date: "2026-10-12", status: "pending" }, // not Mette's
    ];
    await mountAbsence({ absences, onChanged });
    const remove = screen.getByRole("button", { name: /^Fjern Ferie/ });
    fireEvent.click(remove);
    expect(apiDelete).not.toHaveBeenCalled(); // asks first
    fireEvent.click(screen.getByRole("button", { name: "Ja, fjern" }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(2));
    expect(apiDelete.mock.calls.map((c) => c[0])).toEqual(["/staff/absences/a1", "/staff/absences/a2"]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("is a form whose primary action is a submit", async () => {
    await mountAbsence();
    const panel = document.querySelector("[data-sheet-panel]");
    expect(within(panel).getByRole("button", { name: "Gem fravær" }).getAttribute("type")).toBe("submit");
  });
});
