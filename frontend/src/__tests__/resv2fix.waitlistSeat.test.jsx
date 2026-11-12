/**
 * Fix round 12 Nov — the Venteliste at the door.
 *
 * #1 "Free now and fits: Bord 2" with the guest standing at the bar: one tap
 *    seats them there now (POST /waitlist/{id}/seat with the fit's tables),
 *    the toast says where with an Undo (POST /waitlist/{id}/unseat), and the
 *    book is read again. When two parties fit the same table, the one who
 *    has waited longest gets the dark button and "next in line"; the other
 *    keeps a quiet Seat. A refusal is said in words, never a code.
 * #5 The time the guest was told at the door is saved (quoted_at) and shown
 *    ("lovet ca. 17.19"), amber once it has passed; phones read one way.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), toast: vi.fn(), stand: null }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: (...a) => h.patch(...a) },
}));
vi.mock("../services/standAuth", () => ({
  getStandToken: () => h.stand, setStandToken: vi.fn(), clearStandToken: vi.fn(), standRewrite: () => null,
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ t, lang: "da" }) };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));

const WaitlistSection = (await import("../components/reservations/WaitlistSection")).default;
const { seatLineup, quotedCue } = await import("../utils/tonight");
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const DAY = "2026-11-12";
const entry = (id, name, extra = {}) => ({
  id, guest_name: name, guest_phone: "20 55 66 77", party_size: 2, waitlist_date: DAY,
  desired_from: null, desired_to: null, status: "waiting", source: "manual", note: null,
  notify_count: 0, created_at: null, held: false, held_reason: null, quoted_at: null, ...extra,
});
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const rowOf = (name) => screen.getByText(name).closest("li");
const FIT2 = { tableId: "t2", tableIds: ["t2"], label: "2", seats: 2 };

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.toast.mockReset();
  h.stand = null;
});
afterEach(() => cleanup());

describe("seatLineup — who gets the one-tap seat", () => {
  it("gives the first party the table and marks it next in line when another waits on it", () => {
    const rows = [entry("a", "A"), entry("b", "B"), entry("c", "C")];
    const fits = { a: FIT2, b: FIT2, c: { tableIds: ["t5"], label: "5" } };
    const m = seatLineup(rows, (e) => fits[e.id] || null);
    expect(m.get("a")).toMatchObject({ primary: true, nextInLine: true });
    expect(m.get("b")).toMatchObject({ primary: false });
    expect(m.get("c")).toMatchObject({ primary: true, nextInLine: false });
  });
  it("counts an overlap of pushed-together tables as the same table", () => {
    const rows = [entry("a", "A"), entry("b", "B")];
    const fits = { a: { tableIds: ["t6", "t7"], label: "6 + 7" }, b: { tableIds: ["t7"], label: "7" } };
    const m = seatLineup(rows, (e) => fits[e.id]);
    expect(m.get("a").primary).toBe(true);
    expect(m.get("b").primary).toBe(false);
  });
  it("is empty without a fit rule, and skips parties nothing fits", () => {
    expect(seatLineup([entry("a", "A")], null).size).toBe(0);
    expect(seatLineup([entry("a", "A")], () => null).size).toBe(0);
  });
});

describe("quotedCue — the time they were told", () => {
  const NOW = Date.parse("2026-11-12T16:00:00Z");
  it("is null when nothing was quoted", () => {
    expect(quotedCue(null, NOW)).toBeNull();
    expect(quotedCue("not a time", NOW)).toBeNull();
  });
  it("is not late before the time, late after", () => {
    expect(quotedCue("2026-11-12T16:19:00Z", NOW)).toEqual({ ms: Date.parse("2026-11-12T16:19:00Z"), late: false });
    expect(quotedCue("2026-11-12T15:50:00Z", NOW).late).toBe(true);
  });
  it("reads a stamp without a zone as UTC", () => {
    expect(quotedCue("2026-11-12T16:19:00", NOW).ms).toBe(Date.parse("2026-11-12T16:19:00Z"));
  });
  it("has real words", () => {
    expect(da.rsvpWlQuoted).toBe("lovet ca. {time}");
    expect(en.rsvpWlQuoted).toBe("quoted ~{time}");
  });
});

describe("Seat at Bord 2 — one tap from the Venteliste", () => {
  const rows = [entry("a", "Norgaard", { note: "Vindue tak <3" }), entry("b", "Berg")];
  const fitFor = (e) => (e.id === "a" || e.id === "b" ? FIT2 : null);

  it("the longest-waiting party gets the dark button and 'next in line'; the next a quiet Seat", async () => {
    h.get.mockResolvedValue({ data: { waitlist: rows, day: DAY, active_count: 2 } });
    render(<WaitlistSection day={DAY} fitFor={fitFor} />);
    await settle();
    const first = rowOf("Norgaard");
    const primary = first.querySelector('[data-wl-seat="primary"]');
    expect(primary.textContent).toContain("Sæt ved Bord 2");
    expect(first.querySelector("[data-wl-next]").textContent).toBe(da.rsvpWlNextInLine);
    expect(first.textContent).toContain("Ledigt nu og passer: Bord 2");
    const second = rowOf("Berg");
    expect(second.querySelector('[data-wl-seat="primary"]')).toBeNull();
    const quiet = second.querySelector('[data-wl-seat="secondary"]');
    expect(quiet.textContent).toBe(da.rsvpSeatAction);
    expect(second.querySelector("[data-wl-next]")).toBeNull();
    // Notify / Book / × stay as they were.
    expect(within(first).getByRole("button", { name: da.rsvpWlNotify })).toBeTruthy();
    expect(within(first).getByRole("button", { name: da.rsvpWlBook })).toBeTruthy();
    expect(within(first).getByRole("button", { name: da.rsvpWlRemove })).toBeTruthy();
  });

  it("one tap posts the fit's tables, re-reads the book and says where, with Undo", async () => {
    h.get.mockResolvedValue({ data: { waitlist: rows, day: DAY, active_count: 2 } });
    h.post.mockResolvedValue({
      data: {
        entry: { ...rows[0], status: "converted" },
        reservation: { id: "r1", status: "seated", source: "walk_in", resource_id: "t2", guest_notes: "Vindue tak <3" },
      },
    });
    const onConverted = vi.fn();
    const changed = vi.fn();
    window.addEventListener("bonbox-reservations-changed", changed);
    render(<WaitlistSection day={DAY} fitFor={fitFor} onConverted={onConverted} tableLabelFor={() => "Bord 2"} />);
    await settle();
    const reads = h.get.mock.calls.length;
    await act(async () => {
      fireEvent.click(rowOf("Norgaard").querySelector('[data-wl-seat="primary"]'));
    });
    await settle();
    window.removeEventListener("bonbox-reservations-changed", changed);
    expect(h.post).toHaveBeenCalledWith("/reservations/waitlist/a/seat", { resource_ids: ["t2"] });
    expect(h.get.mock.calls.length).toBeGreaterThan(reads);
    expect(onConverted).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    const toast = h.toast.mock.calls.at(-1)[0];
    expect(toast.severity).toBe("success");
    expect(toast.message).toBe("Norgaard sat ved Bord 2");
    expect(toast.action.label).toBe(da.rsvpWlSeatUndo);

    // Undo puts them back on the list.
    h.post.mockReset();
    h.post.mockResolvedValue({ data: { entry: rows[0], reservation: { id: "r1", status: "cancelled" } } });
    await act(async () => { toast.action.onClick(); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/reservations/waitlist/a/unseat", {});
    expect(h.toast.mock.calls.at(-1)[0].message).toBe("Fortrudt — Norgaard er tilbage på ventelisten.");
  });

  it("an undo that comes too late is said, with what to do instead", async () => {
    h.get.mockResolvedValue({ data: { waitlist: rows, day: DAY, active_count: 2 } });
    h.post.mockResolvedValueOnce({ data: { entry: rows[0], reservation: { id: "r1", resource_id: "t2" } } });
    render(<WaitlistSection day={DAY} fitFor={fitFor} />);
    await settle();
    await act(async () => { fireEvent.click(rowOf("Norgaard").querySelector('[data-wl-seat="primary"]')); });
    await settle();
    const toast = h.toast.mock.calls.at(-1)[0];
    // No tableLabelFor: the fit's own tables, named.
    expect(toast.message).toBe("Norgaard sat ved Bord 2");
    h.post.mockRejectedValueOnce(Object.assign(new Error("x"), { response: { status: 409, data: { detail: { error: "not_undoable" } } } }));
    await act(async () => { toast.action.onClick(); });
    await settle();
    expect(h.toast.mock.calls.at(-1)[0]).toMatchObject({ severity: "notice", message: da.rsvpWlUndoErr });
  });

  it.each([
    [{ error: "table_occupied", occupant: { name: "Kristensen", table: "2" } }, "Bord 2 er stadig optaget — Kristensen sidder der."],
    [{ error: "slot_unavailable", table: "2", at: "16:49" }, "Bord 2 er booket kl. 16.49 — vælg et andet bord, eller Book en tid."],
    [{ error: "slot_unavailable", table: "2", at: null }, "Bord 2 er holdt til en booking, der skal komme nu."],
    [{ error: "slot_unavailable" }, da.rsvpSeatTableTaken],
    [{ error: "not_seatable" }, da.rsvpWlGuestLeft],
  ])("a refusal (%o) is said in words and the list is read again", async (detail, words) => {
    h.get.mockResolvedValue({ data: { waitlist: rows, day: DAY, active_count: 2 } });
    h.post.mockRejectedValue(Object.assign(new Error("x"), { response: { status: 409, data: { detail } } }));
    const onConverted = vi.fn();
    render(<WaitlistSection day={DAY} fitFor={fitFor} onConverted={onConverted} />);
    await settle();
    const reads = h.get.mock.calls.length;
    await act(async () => { fireEvent.click(rowOf("Norgaard").querySelector('[data-wl-seat="primary"]')); });
    await settle();
    expect(screen.getByText(words)).toBeTruthy();
    expect(h.get.mock.calls.length).toBeGreaterThan(reads);
    expect(onConverted).toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("on a door device whose API has no seat route yet, says so", async () => {
    h.stand = "tok";
    h.get.mockResolvedValue({ data: { waitlist: rows, day: DAY, active_count: 2 } });
    h.post.mockRejectedValue(Object.assign(new Error("x"), { response: { status: 405, data: { detail: "Method Not Allowed" } } }));
    render(<WaitlistSection day={DAY} fitFor={fitFor} />);
    await settle();
    await act(async () => { fireEvent.click(rowOf("Norgaard").querySelector('[data-wl-seat="primary"]')); });
    await settle();
    expect(screen.getByText(da.rsvpWlStandUnavailable)).toBeTruthy();
  });

  it("no fit, no seat button", async () => {
    h.get.mockResolvedValue({ data: { waitlist: rows, day: DAY, active_count: 2 } });
    render(<WaitlistSection day={DAY} />);
    await settle();
    expect(document.querySelector("[data-wl-seat]")).toBeNull();
  });
});

describe("the time they were told, and the phone (#5)", () => {
  it("shows 'lovet ca.' with the venue's clock, amber once it has passed", async () => {
    const soon = new Date(Date.now() + 20 * 60000);
    soon.setSeconds(0, 0);
    const past = new Date(Date.now() - 5 * 60000);
    past.setSeconds(0, 0);
    h.get.mockResolvedValue({
      data: {
        waitlist: [
          entry("a", "Ahead", { quoted_at: soon.toISOString() }),
          entry("b", "Overdue", { quoted_at: past.toISOString() }),
          entry("c", "Never", { quoted_at: null }),
        ],
        day: DAY,
        active_count: 3,
      },
    });
    render(<WaitlistSection day={DAY} />);
    await settle();
    const hhmm = (d) => d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
    const ahead = rowOf("Ahead").querySelector("[data-wl-quoted]");
    expect(ahead.textContent).toBe(`lovet ca. ${hhmm(soon)}`);
    expect(ahead.getAttribute("data-wl-quoted")).toBe("");
    expect(ahead.className).not.toContain("amber");
    const late = rowOf("Overdue").querySelector("[data-wl-quoted]");
    expect(late.getAttribute("data-wl-quoted")).toBe("late");
    expect(late.className).toContain("text-amber-700");
    expect(rowOf("Never").querySelector("[data-wl-quoted]")).toBeNull();
  });

  it("writes the phone one way, the tel: link keeps the stored digits", async () => {
    h.get.mockResolvedValue({ data: { waitlist: [entry("a", "Ahead", { guest_phone: "+4511223344" })], day: DAY, active_count: 1 } });
    render(<WaitlistSection day={DAY} phoneCountry="DK" />);
    await settle();
    const link = rowOf("Ahead").querySelector('a[href^="tel:"]');
    expect(link.textContent).toBe("+45 11 22 33 44");
    expect(link.getAttribute("href")).toBe("tel:+4511223344");
  });

  it("the drop-in chip's time is saved with the entry when the party is the chip's", async () => {
    h.get.mockResolvedValue({ data: { waitlist: [], day: DAY, active_count: 0 } });
    h.post.mockResolvedValue({ data: {} });
    const at = Date.parse("2026-11-12T16:19:00Z");
    const quoteFor = vi.fn(() => Date.parse("2026-11-12T17:00:00Z"));
    render(<WaitlistSection day={DAY} addRequest={{ party: 2, at, n: 1 }} quoteFor={quoteFor} />);
    await settle();
    fireEvent.change(screen.getByLabelText(da.rsvpWlPhoneReq), { target: { value: "20556677" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpWlAdd })); });
    await settle();
    const [url, body] = h.post.mock.calls[0];
    expect(url).toBe("/reservations/waitlist");
    expect(body.quoted_at).toBe("2026-11-12T16:19:00.000Z");
    expect(body.guest_phone).toBe("20556677");
    expect(quoteFor).not.toHaveBeenCalled();
  });

  it("the Add button sends what the drop-in rule says for that size now, or nothing", async () => {
    h.get.mockResolvedValue({ data: { waitlist: [], day: DAY, active_count: 0 } });
    h.post.mockResolvedValue({ data: {} });
    const quoteFor = vi.fn((n) => (n === 2 ? Date.parse("2026-11-12T17:00:00Z") : null));
    render(<WaitlistSection day={DAY} quoteFor={quoteFor} />);
    await settle();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpWlAddCta })); });
    fireEvent.change(screen.getByLabelText(da.rsvpWlPhoneReq), { target: { value: "20556677" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpWlAdd })); });
    await settle();
    expect(quoteFor).toHaveBeenCalledWith(2);
    expect(h.post.mock.calls[0][1].quoted_at).toBe("2026-11-12T17:00:00.000Z");

    // Nothing known: no quoted_at sent at all.
    h.post.mockClear();
    quoteFor.mockReturnValue(null);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpWlAddCta })); });
    fireEvent.change(screen.getByLabelText(da.rsvpWlPhoneReq), { target: { value: "20556677" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpWlAdd })); });
    await settle();
    expect("quoted_at" in h.post.mock.calls[0][1]).toBe(false);
  });
});

describe("Notify, when the number can't be texted (#10's honest words)", () => {
  it("says the number could not be texted — not 'no SMS on this plan' — with the number to call", async () => {
    h.get.mockResolvedValue({ data: { waitlist: [entry("a", "Silva", { guest_phone: "912345678" })], day: DAY, active_count: 1 } });
    h.post.mockResolvedValue({ data: { channel: "call", sms_sent: false, sms_error: "bad_number", phone: "912345678" } });
    render(<WaitlistSection day={DAY} phoneCountry="DK" />);
    await settle();
    await act(async () => { fireEvent.click(within(rowOf("Silva")).getByRole("button", { name: da.rsvpWlNotify })); });
    await settle();
    expect(screen.getByText("Kunne ikke sende SMS til det nummer — ring til Silva på 912345678.")).toBeTruthy();
  });

  it("an older API (no sms_error) keeps the plan wording, the number written one way", async () => {
    h.get.mockResolvedValue({ data: { waitlist: [entry("a", "Holm", { guest_phone: "20556677" })], day: DAY, active_count: 1 } });
    h.post.mockResolvedValue({ data: { channel: "call", sms_sent: false, phone: "20556677" } });
    render(<WaitlistSection day={DAY} />);
    await settle();
    await act(async () => { fireEvent.click(within(rowOf("Holm")).getByRole("button", { name: da.rsvpWlNotify })); });
    await settle();
    expect(screen.getByText(da.rsvpWlNotifyCall.replace("{name}", "Holm").replace("{phone}", "+45 20 55 66 77"))).toBeTruthy();
  });
});
