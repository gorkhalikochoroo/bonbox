/**
 * R2 (27 Oct 2026) — the block list in Indstillinger, and every promise true.
 *
 *   • "Blokerede kontakter": the masked list the server keeps (never the
 *     number or the address), Blokeret vs Spam, until when; block a typed
 *     phone or e-mail (with Fortryd); Fjern behind useConfirm; a typo is
 *     said, not sent.
 *   • The three untrue lines (rubric T12 / G7 / B8) and the live-alert hint
 *     now say what is true, in en, da and tr, and the inline fallbacks the
 *     source still carries say it too:
 *       – "vi holder bordet til dig": nothing holds a table before booking;
 *       – "sendt til køkkenet": nothing sends it — the person who taps does;
 *       – "Alvorlig giver en tydelig lyd": an edit makes no sound at all.
 *   • The receipt's calendar file takes the booking's real length (V5).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn(), confirm: vi.fn(), toast: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), delete: (...a) => h.del(...a) },
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useToast: () => h.toast };
});

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const { tr } = await import("../i18n/tr");
const CardModule = await import("../components/reservations/ContactBlocksCard");
const ContactBlocksCard = CardModule.default;
const { contactPayload, fmtBlockDate } = CardModule;
const { buildIcs, icsMinutesFor } = await import("../utils/reservationIcs");

const tDa = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

const LIST = {
  blocks: [
    { id: "a1b2c3d4", kind: "phone", hint: "•• •• •• 78", mode: "block", at: "2026-10-27", until: "2027-04-25" },
    { id: "e5f6a7b8", kind: "email", hint: "s•••@gmail.com", mode: "spam", at: "2026-10-26", until: "2027-04-24" },
  ],
  max: 200,
  days: 180,
};

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.confirm.mockResolvedValue(true);
});
afterEach(() => cleanup());

describe("Blokerede kontakter", () => {
  it("lists what the server keeps — masked, blocked or spam, until when — never more", async () => {
    h.get.mockResolvedValue({ data: LIST });
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    expect(h.get).toHaveBeenCalledWith("/reservations/contact-blocks");
    const rows = screen.getAllByTestId("rsvp-block-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("•• •• •• 78");
    expect(rows[0].textContent).toContain(da.rsvpBlocksBadgeBlock);
    expect(rows[1].textContent).toContain(da.rsvpBlocksBadgeSpam);
    expect(rows[0].textContent).toContain(tDa("rsvpBlocksUntil", { date: fmtBlockDate("2027-04-25", "da") }));
    expect(screen.getByTestId("rsvp-contact-blocks").textContent).toContain(tDa("rsvpBlocksHint", { days: 180 }));
  });

  it("empty says how to get one (customer's words at a salon)", async () => {
    h.get.mockResolvedValue({ data: { blocks: [], days: 180 } });
    render(<ContactBlocksCard t={tDa} apptWords />);
    await settle();
    expect(screen.getByTestId("rsvp-blocks-empty").textContent).toBe(da.rsvpBlocksEmptyAppt);
  });

  it("blocks a typed phone, and its toast takes it back", async () => {
    h.get.mockResolvedValue({ data: { blocks: [], days: 180 } });
    h.post.mockResolvedValue({ data: { ...LIST, created: ["a1b2c3d4"], upgraded: ["e5f6a7b8"],
      entries: [{ hint: "•• •• •• 78" }] } });
    h.del.mockResolvedValue({ data: { blocks: [], days: 180 } });
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    fireEvent.change(screen.getByTestId("rsvp-block-input"), { target: { value: "+45 12 34 56 78" } });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-block-add")); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/reservations/contact-blocks", { phone: "+45 12 34 56 78" });
    const toast = h.toast.mock.calls[0][0];
    expect(toast.message).toBe(tDa("rsvpBlocksAdded", { contact: "•• •• •• 78" }));
    await act(async () => { await toast.action.onClick(); });
    expect(h.del).toHaveBeenCalledWith("/reservations/contact-blocks/a1b2c3d4");
    // A block that upgraded an earlier spam mark goes back to the mark.
    expect(h.del).toHaveBeenCalledWith("/reservations/contact-blocks/e5f6a7b8", { params: { keep_mark: 1 } });
  });

  it("a typo is said, not sent", async () => {
    h.get.mockResolvedValue({ data: { blocks: [], days: 180 } });
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    fireEvent.change(screen.getByTestId("rsvp-block-input"), { target: { value: "123" } });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-block-add")); });
    expect(h.post).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpBlocksErrNoContact);
    expect(contactPayload(" anna@mail.dk ")).toEqual({ email: "anna@mail.dk" });
    expect(contactPayload("12 34 56 78")).toEqual({ phone: "12 34 56 78" });
    expect(contactPayload("12")).toBeNull();
  });

  it("Fjern asks, then lets the contact book online again", async () => {
    h.get.mockResolvedValue({ data: LIST });
    h.del.mockResolvedValue({ data: { blocks: [LIST.blocks[1]], days: 180 } });
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    await act(async () => { fireEvent.click(screen.getAllByTestId("rsvp-block-remove")[0]); });
    await settle();
    expect(h.confirm.mock.calls[0][0].message).toBe(tDa("rsvpBlocksRemoveConfirm", { contact: "•• •• •• 78" }));
    expect(h.del).toHaveBeenCalledWith("/reservations/contact-blocks/a1b2c3d4");
    expect(screen.getAllByTestId("rsvp-block-row")).toHaveLength(1);
  });

  it("Glem forgets everything kept for a typed contact (GDPR), after a destructive confirm", async () => {
    h.get.mockResolvedValue({ data: LIST });
    // An older server (fix round 27 Oct): no preview route → the list-only
    // confirm and toast, as before.
    h.post.mockImplementation((url) => (url.endsWith("/erase-preview")
      ? Promise.reject(Object.assign(new Error("405"), { response: { status: 405 } }))
      : Promise.resolve({ data: { blocks: [LIST.blocks[1]], days: 180, removed: 1 } })));
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    fireEvent.change(screen.getByTestId("rsvp-block-input"), { target: { value: "12 34 56 78" } });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-block-forget")); });
    await settle();
    const opts = h.confirm.mock.calls[0][0];
    expect(opts.destructive).toBe(true);
    expect(opts.message).toBe(tDa("rsvpBlocksForgetConfirm", { contact: "12 34 56 78" }));
    expect(h.post).toHaveBeenCalledWith("/reservations/contact-blocks/erase", { phone: "12 34 56 78" });
    expect(h.toast.mock.calls[0][0].message).toBe(tDa("rsvpBlocksForgotten", { n: 1 }));
    expect(screen.getAllByTestId("rsvp-block-row")).toHaveLength(1);
  });

  // ── Fix round 27 Oct (G): no answer is not "no blocked contacts" ──────
  it("a list that can't be read is said, with Prøv igen — never the empty state", async () => {
    h.get.mockRejectedValueOnce(Object.assign(new Error("500"), { response: { status: 500 } }));
    h.get.mockResolvedValueOnce({ data: LIST });
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    expect(screen.getByTestId("rsvp-blocks-load-failed").textContent).toContain(da.rsvpBlocksLoadFailed);
    expect(screen.queryByTestId("rsvp-blocks-empty")).toBeNull();
    expect(screen.queryAllByTestId("rsvp-block-row")).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-blocks-retry")); });
    await settle();
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("rsvp-blocks-load-failed")).toBeNull();
    expect(screen.getAllByTestId("rsvp-block-row")).toHaveLength(2);
  });

  it("an offline list is said too; only a 404 (an older server) is the empty state", async () => {
    h.get.mockRejectedValueOnce(new Error("offline"));
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    expect(screen.getByTestId("rsvp-blocks-load-failed")).toBeTruthy();
    cleanup();
    h.get.mockRejectedValueOnce(Object.assign(new Error("404"), { response: { status: 404 } }));
    render(<ContactBlocksCard t={tDa} />);
    await settle();
    expect(screen.queryByTestId("rsvp-blocks-load-failed")).toBeNull();
    expect(screen.getByTestId("rsvp-blocks-empty")).toBeTruthy();
    expect(da.rsvpBlocksLoadFailed).not.toBe(en.rsvpBlocksLoadFailed);
  });

  // ── Fix round 27 Oct (F): a real erase, counted first ──────────────────
  const glem = async (preview, erase, props = {}) => {
    h.get.mockResolvedValue({ data: LIST });
    h.post.mockImplementation((url) => {
      const r = url.endsWith("/erase-preview") ? preview : erase;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve({ data: r });
    });
    render(<ContactBlocksCard t={tDa} {...props} />);
    await settle();
    fireEvent.change(screen.getByTestId("rsvp-block-input"), { target: { value: "12 34 56 78" } });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-block-forget")); });
    await settle();
  };
  const PREVIEW = { would_erase: { blocks: 1, reservations: 3, waitlist: 1 }, future_kept: 2 };
  const ERASED = { blocks: [], days: 180, removed: 1, erased: PREVIEW.would_erase, future_kept: 2 };

  it("Glem counts first, says what goes and what upcoming bookings keep, then says what was deleted", async () => {
    await glem(PREVIEW, ERASED);
    expect(h.post.mock.calls[0]).toEqual(["/reservations/contact-blocks/erase-preview", { phone: "12 34 56 78" }]);
    const opts = h.confirm.mock.calls[0][0];
    expect(opts.destructive).toBe(true);
    expect(opts.title).toBe("Glem 12 34 56 78?");
    expect(opts.message).toContain("3 tidligere bookinger, 1 plads på ventelisten og 1 linje på denne liste");
    expect(opts.message).toContain("2 kommende bookinger beholder kontakten til besøget — aflys dem først, hvis gæsten bad om det.");
    expect(h.post.mock.calls[1]).toEqual(["/reservations/contact-blocks/erase", { phone: "12 34 56 78" }]);
    const said = h.toast.mock.calls[0][0].message;
    expect(said).toContain("Glemt: slettet fra 3 tidligere bookinger, 1 plads på ventelisten og 1 linje på denne liste.");
    expect(said).toContain("2 kommende bookinger beholder kontakten til besøget");
  });

  it("a cancelled confirm erases nothing", async () => {
    h.confirm.mockResolvedValue(false);
    await glem(PREVIEW, ERASED);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("a count that can't be read is said, and nothing is asked or erased", async () => {
    await glem(Object.assign(new Error("500"), { response: { status: 500 } }), ERASED);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpBlocksForgetCheckFailed);
  });

  it("nothing to delete asks nothing — and still names the upcoming bookings kept", async () => {
    await glem({ would_erase: { blocks: 0, reservations: 0, waitlist: 0 }, future_kept: 1 }, ERASED);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls[0][0].message).toBe(`${da.rsvpBlocksForgetNothingYet} ${da.rsvpBlocksForgetFutureOne}`);
    cleanup();
    h.toast.mockReset();
    h.post.mockReset();
    await glem({ would_erase: { blocks: 0, reservations: 0, waitlist: 0 }, future_kept: 0 }, ERASED);
    expect(h.toast.mock.calls[0][0].message).toBe(da.rsvpBlocksNothingKept);
  });

  it("an erase that doesn't answer is never called done", async () => {
    await glem(PREVIEW, Object.assign(new Error("offline"), {}));
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpBlocksForgetUnsure);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("a salon's card speaks of appointments and customers", async () => {
    await glem({ would_erase: { blocks: 0, reservations: 1, waitlist: 0 }, future_kept: 1 }, ERASED,
      { apptWords: true });
    const msg = h.confirm.mock.calls[0][0].message;
    expect(msg).toContain("1 tidligere aftale");
    expect(msg).toContain(da.rsvpBlocksForgetFutureOneAppt);
    expect(msg).not.toMatch(/gæst|booking/i);
  });

  it("the Glem words are real in en and da", () => {
    for (const k of ["rsvpBlocksForgetTitle", "rsvpBlocksForgetWhat", "rsvpBlocksForgetWhatAppt",
      "rsvpForgetPastOne", "rsvpForgetPastN", "rsvpForgetPastOneAppt", "rsvpForgetPastNAppt",
      "rsvpForgetWaitOne", "rsvpForgetWaitN", "rsvpForgetListOne", "rsvpForgetListN",
      "rsvpBlocksForgetFutureOne", "rsvpBlocksForgetFutureN", "rsvpBlocksForgetFutureOneAppt",
      "rsvpBlocksForgetFutureNAppt", "rsvpBlocksForgottenFrom", "rsvpBlocksForgetNothingYet",
      "rsvpBlocksForgetCheckFailed", "rsvpBlocksForgetUnsure"]) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
    }
    expect(da.rsvpBlocksForgetFutureN).toBe("{n} kommende bookinger beholder kontakten til besøget — aflys dem først, hvis gæsten bad om det.");
  });

  it("the card's words are real in en and da", () => {
    for (const k of ["rsvpBlocksTitle", "rsvpBlocksHint", "rsvpBlocksAddLabel", "rsvpBlocksAddPlaceholder",
      "rsvpBlocksAdd", "rsvpBlocksAdded", "rsvpBlocksEmpty", "rsvpBlocksEmptyAppt", "rsvpBlocksBadgeBlock",
      "rsvpBlocksBadgeSpam", "rsvpBlocksUntil", "rsvpBlocksRemove", "rsvpBlocksRemoveConfirm",
      "rsvpBlocksErrNoContact", "rsvpBlocksForget", "rsvpBlocksForgetConfirm", "rsvpBlocksForgetConfirmAppt",
      "rsvpBlocksForgotten", "rsvpBlocksNothingKept"]) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
    }
    expect(da.rsvpBlocksEmptyAppt).not.toMatch(/gæst|bord/i);
    expect(da.rsvpBlocksForgetConfirmAppt).not.toMatch(/gæst|bord/i);
    expect(en.rsvpBlocksForgetConfirmAppt).not.toMatch(/guest|table/i);
  });
});

describe("every promise true", () => {
  const FALSE = {
    rsvpFloorPicked: /holder bordet|hold it for you|tutuyoruz/i,
    liveAlertAck: /sendt til køkkenet|sent to kitchen|mutfağa iletildi/i,
    rsvpEditAllergySevereHint: /tydelig lyd|distinct sound|belirgin bir ses/i,
    liveAlertHint: /booking ændrer sig|booking changes|değiştiğinde/i,
  };
  it.each(Object.keys(FALSE))("%s says what is true in en, da and tr", (k) => {
    for (const dict of [en, da, tr]) {
      expect(dict[k], k).toBeTruthy();
      expect(dict[k], k).not.toMatch(FALSE[k]);
    }
    expect(da[k]).not.toBe(en[k]);
  });

  it("the edit's severe hint says an edit makes no sound, and who tells the kitchen", () => {
    expect(da.rsvpEditAllergySevereHint).toContain("ingen lyd");
    expect(en.rsvpEditAllergySevereHint).toContain("no sound");
    expect(en.liveAlertAck).toContain("I'll tell the kitchen");
  });

  it("the inline fallbacks in the source say it too", () => {
    const sources = {
      "pages/ReservationPublicPage.jsx": /vi holder bordet/,
      "hooks/useLiveAlerts.jsx": /sent to kitchen"\)/,
      "pages/ReservationsPage.jsx": /tydelig lyd/,
      "components/NotificationCenter.jsx": /when a booking changes or an allergy is noted/,
    };
    for (const [file, re] of Object.entries(sources)) expect(read(file), file).not.toMatch(re);
  });
});

describe("the calendar file's length", () => {
  it.each([
    ["the server's length wins", { server: 105, linked: 90, service: 30 }, 105],
    ["the linked receipt's length", { linked: 90 }, 90],
    ["an older server: the service's length", { service: 45 }, 45],
    ["nothing known: the old 120", {}, 120],
    ["junk is ignored", { server: "abc", linked: 0, service: -5 }, 120],
  ])("%s", (_n, args, want) => {
    expect(icsMinutesFor(args)).toBe(want);
  });

  it("a 90-minute sitting at 19:00 ends at 20:30 in the file", () => {
    const ics = buildIcs({ uid: "x@bonbox.dk", day: "2026-11-06", time: "19:00",
      minutes: icsMinutesFor({ server: 90 }), summary: "Bord", location: "", description: "" });
    expect(ics).toContain("DTSTART;TZID=Europe/Copenhagen:20261106T190000");
    expect(ics).toContain("DTEND;TZID=Europe/Copenhagen:20261106T203000");
  });

  it("the guest page builds it from the booking, not a hard-coded 120", () => {
    const src = read("pages/ReservationPublicPage.jsx");
    expect(src).not.toMatch(/minutes:\s*isProvider \? chosenBehandling\?\.duration_min : 120/);
    expect(src).toMatch(/icsMinutesFor\(\{\s*server: result\?\.duration_min/);
    expect(src).toMatch(/durationMin: b\.duration_min/);
  });
});
