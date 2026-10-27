/**
 * R2 (27 Oct 2026) — spam clean-up on the owner's book.
 *
 *   • "Spam" sits in the drawer's quiet action row for an ONLINE booking
 *     (requested, confirmed, no-show) — never for one the owner typed, a
 *     drop-in or a party already seated. One useConfirm: "Markér som spam"
 *     (the contact's next booking waits for the owner's OK) or, the quieter
 *     third answer, "Spam, og bloker kontakten". The toast carries
 *     "Fortryd", which asks the server to undo.
 *   • "Afvis alle N fra denne bølge" on an open online request that came in
 *     with others: one destructive confirm, the ids the owner was shown, no
 *     mail. Nothing below 2.
 *   • A booking already marked as spam says so in its drawer.
 *   • A held booking that looks like a robot's is never approved in one tap:
 *     the phone row's "Bekræft" and the drawer's ask once more, with the
 *     reason; a held booking for a person-like reason does not.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
  confirm: vi.fn(), toast: vi.fn(),
}));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: (...a) => h.del(...a),
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: { business_type: "restaurant", business_name: "Havnen" }, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useToast: () => h.toast };
});

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const Spam = await import("../components/reservations/SpamActions");
const { SpamButton, SpamWaveBox, SpamMarkedLine, canMarkSpam, hasContact, hintsOf, spamConfirmOpts } = Spam;
const { botApprovalConfirm, heldLooksLikeBot, heldWhy, isMarkedSpam } = await import("../utils/bookingHeld");
const ReservationsPage = (await import("../pages/ReservationsPage")).default;

const tDa = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const row = (over = {}) => ({
  id: "r1", guest_name: "Falsk Frida", party_size: 2, status: "confirmed", source: "public",
  guest_phone: "+45 22 33 44 55", guest_email: "falsk@example.com", ...over,
});

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.confirm.mockResolvedValue(true);
  h.get.mockResolvedValue({ data: {} });
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("who can be marked as spam, and what the confirm says", () => {
  it.each([
    ["an online confirmed booking", row(), true],
    ["an online request", row({ status: "requested" }), true],
    ["an online no-show", row({ status: "no_show" }), true],
    ["one the owner typed", row({ source: "manual" }), false],
    ["a drop-in", row({ source: "walk_in" }), false],
    ["a party seated", row({ status: "seated" }), false],
    ["already cancelled", row({ status: "cancelled" }), false],
  ])("%s", (_n, r, want) => {
    expect(canMarkSpam(r)).toBe(want);
  });

  it("a booking is cancelled out of the month; its contact waits; block is the quieter answer", () => {
    const o = spamConfirmOpts(row(), tDa);
    expect(o.title).toBe(da.rsvpSpamConfirmTitle);
    expect(o.message).toBe(`${tDa("rsvpSpamBodyCancel", { name: "Falsk Frida" })} ${da.rsvpSpamBodyMark}`);
    expect(o.confirmLabel).toBe(da.rsvpSpamConfirmYes);
    expect(o.extraLabel).toBe(da.rsvpSpamConfirmBlock);
    expect(o.destructive).toBe(true);
  });

  it("a request is declined (it never counted); a salon says the customer", () => {
    expect(spamConfirmOpts(row({ status: "requested" }), tDa).message)
      .toBe(`${tDa("rsvpSpamBodyDecline", { name: "Falsk Frida" })} ${da.rsvpSpamBodyMark}`);
    const appt = spamConfirmOpts(row(), tDa, { apptWords: true }).message;
    expect(appt).toBe(`${tDa("rsvpSpamBodyCancelAppt", { name: "Falsk Frida" })} ${da.rsvpSpamBodyMarkAppt}`);
    expect(appt).not.toMatch(/gæst|bord/i);
  });

  it("with no contact left to mark it promises no mark and offers no block", () => {
    const r = row({ guest_phone: null, guest_email: null });
    expect(hasContact(r)).toBe(false);
    const o = spamConfirmOpts(r, tDa);
    expect(o.message).toBe(tDa("rsvpSpamBodyCancel", { name: "Falsk Frida" }));
    expect(o.extraLabel).toBeUndefined();
    expect(hintsOf([{ hint: "•• •• •• 55" }, { hint: "f•••@example.com" }, {}])).toBe("•• •• •• 55 · f•••@example.com");
  });
});

describe("the Spam button", () => {
  it("marks it, says so, and its Fortryd asks the server to undo", async () => {
    const onDone = vi.fn();
    h.post.mockImplementation((url) => Promise.resolve({
      data: url.endsWith("/undo") ? { id: "r1", status: "confirmed" }
        : { id: "r1", status: "cancelled", contact: { mode: "spam", entries: [{ hint: "•• •• •• 55" }] } },
    }));
    render(<SpamButton r={row()} t={tDa} onDone={onDone} />);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-spam")); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/reservations/reservations/r1/spam", { block: false });
    const toast = h.toast.mock.calls[0][0];
    expect(toast.message).toBe(tDa("rsvpSpamDone", { name: "Falsk Frida" }));
    expect(toast.action.label).toBe(da.rsvpSpamUndo);
    expect(onDone).toHaveBeenCalledTimes(1);
    await act(async () => { await toast.action.onClick(); });
    expect(h.post).toHaveBeenLastCalledWith("/reservations/reservations/r1/spam/undo");
    expect(h.toast.mock.calls[1][0].message).toBe(da.rsvpSpamUndone);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("the quieter answer blocks the contact, and the toast names it masked", async () => {
    h.confirm.mockResolvedValue("extra");
    h.post.mockResolvedValue({ data: { contact: { mode: "block", entries: [{ hint: "•• •• •• 55" }, { hint: "f•••@example.com" }] } } });
    render(<SpamButton r={row()} t={tDa} onDone={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-spam")); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/reservations/reservations/r1/spam", { block: true });
    expect(h.toast.mock.calls[0][0].message)
      .toBe(tDa("rsvpSpamBlockedDone", { contact: "•• •• •• 55 · f•••@example.com" }));
  });

  it("a cancelled confirm sends nothing; an undo that lost the table says so", async () => {
    h.confirm.mockResolvedValue(false);
    render(<SpamButton r={row()} t={tDa} onDone={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-spam")); });
    await settle();
    expect(h.post).not.toHaveBeenCalled();
    cleanup();
    h.confirm.mockResolvedValue(true);
    h.post.mockImplementation((url) => (url.endsWith("/undo")
      ? Promise.reject({ response: { status: 409, data: { detail: { error: "slot_unavailable" } } } })
      : Promise.resolve({ data: { contact: { entries: [] } } })));
    render(<SpamButton r={row()} t={tDa} apptWords onDone={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-spam")); });
    await settle();
    expect(h.toast.mock.calls[0][0].message).toBe(da.rsvpSpamDoneNoContact);
    await act(async () => { await h.toast.mock.calls[0][0].action.onClick(); });
    expect(h.toast.mock.calls[1][0].message).toBe(da.rsvpSpamUndoTakenAppt);
  });

  it("shows nothing for a booking that cannot be spam", () => {
    const { container } = render(<SpamButton r={row({ source: "manual" })} t={tDa} onDone={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("a whole wave", () => {
  it("nothing below two; from two the box, one destructive confirm, the ids shown", async () => {
    h.get.mockResolvedValueOnce({ data: { count: 1, ids: ["r1"] } });
    const { container, unmount } = render(<SpamWaveBox r={row({ status: "requested" })} t={tDa} onDone={() => {}} />);
    await settle();
    expect(container.textContent).toBe("");
    unmount();
    const onDone = vi.fn();
    h.get.mockResolvedValueOnce({ data: { count: 3, ids: ["r1", "r2", "r3"], minutes: 10,
      first_at: "2026-10-27T18:02:00Z", last_at: "2026-10-27T18:09:00Z" } });
    h.post.mockResolvedValue({ data: { rejected: 3, ids: ["r1", "r2", "r3"] } });
    render(<SpamWaveBox r={row({ status: "requested" })} t={tDa} onDone={onDone} />);
    await settle();
    expect(h.get).toHaveBeenLastCalledWith("/reservations/spam-wave/r1");
    const box = screen.getByTestId("rsvp-spam-wave");
    expect(box.textContent).toContain("Én af 3 online-forespørgsler");
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-spam-wave-action")); });
    await settle();
    const opts = h.confirm.mock.calls[0][0];
    expect(opts.title).toBe(da.rsvpWaveConfirmTitle);
    expect(opts.destructive).toBe(true);
    expect(opts.confirmLabel).toBe(tDa("rsvpWaveConfirmYes", { n: 3 }));
    expect(h.post).toHaveBeenCalledWith("/reservations/spam-wave/r1", { ids: ["r1", "r2", "r3"] });
    expect(h.toast.mock.calls[0][0].message).toBe(tDa("rsvpWaveDone", { n: 3 }));
    expect(onDone).toHaveBeenCalled();
  });

  it("never asks for a confirmed booking", async () => {
    render(<SpamWaveBox r={row()} t={tDa} onDone={() => {}} />);
    await settle();
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe("marked as spam, said", () => {
  it("a booking cancelled as spam says so; another cancel does not", () => {
    expect(isMarkedSpam({ status: "cancelled", cancel_reason: "owner_spam" })).toBe(true);
    expect(isMarkedSpam({ status: "cancelled", cancel_reason: "guest_cancelled" })).toBe(false);
    render(<SpamMarkedLine r={{ status: "cancelled", cancel_reason: "owner_spam" }} t={tDa} />);
    expect(screen.getByTestId("rsvp-spam-marked").textContent).toContain(da.rsvpSpamMarked);
  });
});

describe("a robot-like held booking takes a second step to approve", () => {
  it.each([
    ["the server says bot", { reason: "venue_hour", bot: true }, true],
    ["the server says person", { reason: "fast_fill", bot: false }, false],
    ["an older server: a robot's reason", { reason: "fast_fill" }, true],
    ["an older server: marked as spam", { reason: "marked_spam" }, true],
    ["an older server: a busy hour", { reason: "venue_hour" }, false],
  ])("%s", (_n, held, want) => {
    expect(heldLooksLikeBot({ status: "requested", source: "public", held })).toBe(want);
  });

  it("asks with the reason, never as the Enter answer", () => {
    const r = { status: "requested", source: "public", held: { reason: "fast_fill", bot: true } };
    const o = botApprovalConfirm(r, tDa);
    expect(o.title).toBe(da.rsvpBotConfirmTitle);
    expect(o.message).toBe(heldWhy(r, tDa));
    expect(o.confirmLabel).toBe(da.rsvpBotConfirmYes);
    expect(o.irreversible).toBe(true);
    expect(botApprovalConfirm(r, tDa, { to: "seated", apptWords: true }).confirmLabel).toBe(da.rsvpBotSeatYesAppt);
  });
});

// ── Through the owner's book ──────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const soon = new Date(Date.now() + 3 * 3600000);

function routes(rows) {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: { reservations_enabled: true, reservation_slug: "havnen", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures: [], public_name: "Havnen" } });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: rows, summary: { total: rows.length, by_status: {} } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
}
const booking = (over) => ({
  party_size: 2, resource_id: null, combined_resource_ids: null, allergen_tags: [], guest_mailed: false,
  starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 90 * 60000)), ...over,
});

async function openDrawer(name) {
  render(
    <MemoryRouter initialEntries={["/reservations"]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
  await settle(12);
  await act(async () => { fireEvent.click(screen.getAllByText(name)[0]); });
  await settle(4);
  return screen.getAllByRole("dialog").pop();
}

describe("in the owner's book", () => {
  it("the drawer of an online booking has Spam; one the owner typed has none", async () => {
    routes([
      booking({ id: "web", guest_name: "Web Gæst", status: "confirmed", source: "public", resource_id: "t1", guest_phone: "22334455" }),
      booking({ id: "tel", guest_name: "Telefon Gæst", status: "confirmed", source: "manual", resource_id: "t1" }),
    ]);
    const drawer = await openDrawer("Web Gæst");
    expect(drawer.querySelector('[data-testid="rsvp-spam"]')).toBeTruthy();
    cleanup();
    const other = await openDrawer("Telefon Gæst");
    expect(other.querySelector('[data-testid="rsvp-spam"]')).toBeNull();
  });

  it("Bekræft on a robot-like held booking asks first; No sends nothing", async () => {
    routes([booking({ id: "bot", guest_name: "Robot Rasmus", status: "requested", source: "public",
      held: { reason: "fast_fill", bot: true, quiet: true, wanted: [], pinned: false } })]);
    h.confirm.mockResolvedValue(false);
    const drawer = await openDrawer("Robot Rasmus");
    const yes = [...drawer.querySelectorAll("button")].find((b) => b.textContent.trim() === da.rsvpConfirmAction);
    await act(async () => { fireEvent.click(yes); });
    await settle(4);
    expect(h.confirm).toHaveBeenCalled();
    expect(h.confirm.mock.calls[0][0].title).toBe(da.rsvpBotConfirmTitle);
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("…and Yes approves it", async () => {
    routes([booking({ id: "bot", guest_name: "Robot Rasmus", status: "requested", source: "public",
      held: { reason: "link_in_name", bot: true, quiet: true, wanted: [], pinned: false } })]);
    h.patch.mockResolvedValue({ data: { id: "bot", status: "confirmed" } });
    const drawer = await openDrawer("Robot Rasmus");
    const yes = [...drawer.querySelectorAll("button")].find((b) => b.textContent.trim() === da.rsvpConfirmAction);
    await act(async () => { fireEvent.click(yes); });
    await settle(6);
    expect(h.confirm.mock.calls[0][0].title).toBe(da.rsvpBotConfirmTitle);
    expect(h.patch.mock.calls.find(([u]) => u === "/reservations/reservations/bot/status")[1]).toMatchObject({ status: "confirmed" });
  });

  it("a held booking for a person-like reason is approved in one tap, as before", async () => {
    routes([booking({ id: "busy", guest_name: "Travl Tove", status: "requested", source: "public",
      held: { reason: "venue_hour", bot: false, quiet: false, wanted: [], pinned: false } })]);
    h.patch.mockResolvedValue({ data: { id: "busy", status: "confirmed" } });
    const drawer = await openDrawer("Travl Tove");
    const yes = [...drawer.querySelectorAll("button")].find((b) => b.textContent.trim() === da.rsvpConfirmAction);
    await act(async () => { fireEvent.click(yes); });
    await settle(6);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.patch).toHaveBeenCalled();
  });
});

describe("the words, en and da", () => {
  const KEYS = [
    "rsvpHeldWhySpam", "rsvpHeldWhySpamAppt", "rsvpSpamConfirmTitle", "rsvpSpamBodyCancel",
    "rsvpSpamBodyCancelAppt", "rsvpSpamBodyDecline", "rsvpSpamBodyDeclineAppt", "rsvpSpamBodyMark",
    "rsvpSpamBodyMarkAppt", "rsvpSpamConfirmYes", "rsvpSpamConfirmBlock", "rsvpSpamDone", "rsvpSpamDoneAppt",
    "rsvpSpamDoneNoContact", "rsvpSpamBlockedDone", "rsvpSpamUndo", "rsvpSpamUndone", "rsvpSpamUndoneAppt",
    "rsvpSpamUndoTaken", "rsvpSpamUndoTakenAppt", "rsvpSpamUndoFailed", "rsvpSpamFailed", "rsvpSpamMarked",
    "rsvpSpamMarkedHint", "rsvpSpamMarkedHintAppt", "rsvpBotConfirmTitle", "rsvpBotConfirmTitleAppt",
    "rsvpBotConfirmYes", "rsvpBotSeatYes", "rsvpBotSeatYesAppt", "rsvpWaveTitle", "rsvpWaveAction",
    "rsvpWaveConfirmTitle", "rsvpWaveConfirmBody", "rsvpWaveConfirmBodyAppt", "rsvpWaveConfirmYes",
    "rsvpWaveDone", "rsvpWaveFailed",
  ];
  it.each(KEYS)("%s is real in both, and Danish where Danish differs", (k) => {
    expect(en[k], k).toBeTruthy();
    expect(da[k], k).toBeTruthy();
    if (!["rsvpSpamAction"].includes(k)) expect(da[k], k).not.toBe(en[k]);
  });
  it("the customer's words carry no restaurant word", () => {
    for (const k of KEYS.filter((x) => x.endsWith("Appt"))) {
      expect(da[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/gæst|bord|selskab|køkken|reservation|couvert|vært/i);
      expect(en[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/guest|table|party|kitchen|reservation|\bcovers?\b|host/i);
    }
  });
  it("the drawer's own word is the same in both", () => {
    expect(en.rsvpSpamAction).toBe("Spam");
    expect(da.rsvpSpamAction).toBe("Spam");
  });
});
