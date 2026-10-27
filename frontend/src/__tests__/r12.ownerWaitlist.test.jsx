/**
 * The host's Venteliste with guests who joined online (booking R12).
 *
 * The owner app and the paired door stand share WaitlistSection. An online
 * entry carries a grey "online" mark (a source, not a state), the time or the
 * evening the guest asked for, and — when the booking screen held it — an
 * amber "Tjek før du kontakter dem" with why. A guest's own name is shown with
 * any link disarmed (display only). A guest who left the list between the
 * owner's look and the tap is said plainly. The freed-table banner from a push
 * deep link (a match with no name) says how many fit, never a raw "{n}".
 *
 * Also here: the owner's one switch (PublicWaitlistSwitch) and the day rule
 * that keeps a full night the guest picked (utils/bookingDay.rescueDay).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), toast: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: (...a) => h.patch(...a), put: (...a) => h.put(...a) },
}));
vi.mock("../services/standAuth", () => ({
  getStandToken: () => null, setStandToken: vi.fn(), clearStandToken: vi.fn(), standRewrite: () => null,
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
const PublicWaitlistSwitch = (await import("../components/reservations/PublicWaitlistSwitch")).default;
const { rescueDay } = await import("../utils/bookingDay");
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const DAY = "2030-01-11";
const ROWS = [
  {
    id: "a", guest_name: "Agnes www.example.com", guest_phone: "+45 20 20 20 20", party_size: 2,
    waitlist_date: DAY, desired_from: "2030-01-11T19:30:00", desired_to: null, status: "waiting",
    source: "public", note: null, notify_count: 0, created_at: null, held: false, held_reason: null,
  },
  {
    id: "b", guest_name: "Bot", guest_phone: "+45 30 30 30 30", party_size: 4,
    waitlist_date: DAY, desired_from: "2030-01-11T17:00:00", desired_to: "2030-01-11T20:30:00",
    status: "waiting", source: "public", note: null, notify_count: 0, created_at: null,
    held: true, held_reason: "fast_fill",
  },
  {
    id: "c", guest_name: "Door", guest_phone: "40404040", party_size: 2, waitlist_date: DAY,
    desired_from: null, desired_to: null, status: "waiting", source: "manual", note: null,
    notify_count: 0, created_at: null, held: false, held_reason: null,
  },
  {
    id: "d", guest_name: "Same", guest_phone: "50505050", party_size: 2, waitlist_date: DAY,
    desired_from: null, desired_to: null, status: "waiting", source: "public", note: null,
    notify_count: 0, created_at: null, held: true, held_reason: "contact_active",
  },
];
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const rowOf = (name) => screen.getByText(name).closest("li");

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.put.mockReset();
  h.toast.mockReset();
  h.get.mockResolvedValue({ data: { waitlist: ROWS, day: DAY, active_count: ROWS.length } });
});
afterEach(() => cleanup());

describe("online entries on the host's list", () => {
  it("marks online entries, says the time asked for, and disarms a typed link", async () => {
    render(<WaitlistSection day={DAY} />);
    await settle();
    const agnes = rowOf("Agnes www[.]example[.]com");
    expect(within(agnes).getByText(da.rsvpSourceOnline)).toBeTruthy();
    expect(agnes.textContent).toContain("omkring kl. 19.30");
    expect(agnes.textContent).not.toContain(da.rsvpWlHeldLabel);
    const door = rowOf("Door");
    expect(within(door).queryByText(da.rsvpSourceOnline)).toBeNull();
    expect(rowOf("Bot").textContent).toContain("kl. 17.00–20.30");
  });

  it("a held entry says check first, and why", async () => {
    render(<WaitlistSection day={DAY} />);
    await settle();
    const bot = rowOf("Bot");
    expect(bot.textContent).toContain(da.rsvpWlHeldLabel);
    expect(bot.textContent).toContain(da.rsvpWlHeldRobot);
    const label = within(bot).getByText(da.rsvpWlHeldLabel).closest("p");
    expect(label.className).toContain("text-amber-800");
    expect(rowOf("Same").textContent).toContain(da.rsvpWlHeldSame);
  });

  it("a guest who left before Giv besked is said, and the list reloads", async () => {
    h.post.mockRejectedValue(Object.assign(new Error("x"), {
      response: { status: 409, data: { detail: { error: "non_notifiable" } } },
    }));
    render(<WaitlistSection day={DAY} />);
    await settle();
    const calls = h.get.mock.calls.length;
    await act(async () => {
      fireEvent.click(within(rowOf("Door")).getByRole("button", { name: da.rsvpWlNotify }));
    });
    await settle();
    expect(screen.getByText(da.rsvpWlGuestLeft)).toBeTruthy();
    expect(h.get.mock.calls.length).toBeGreaterThan(calls);
  });

  it("a guest who left before Book is said, never 'that slot just filled'", async () => {
    h.post.mockRejectedValue(Object.assign(new Error("x"), {
      response: { status: 409, data: { detail: { error: "not_convertible" } } },
    }));
    render(<WaitlistSection day={DAY} openHours={null} />);
    await settle();
    const row = rowOf("Door");
    fireEvent.click(within(row).getByRole("button", { name: da.rsvpWlBook }));
    const books = within(row).getAllByRole("button", { name: da.rsvpWlBook });
    await act(async () => {
      fireEvent.click(books[books.length - 1]);
    });
    await settle();
    expect(screen.getByText(da.rsvpWlGuestLeft)).toBeTruthy();
    expect(screen.queryByText(da.rsvpConvertFull)).toBeNull();
  });

  it("a freed-table deep link with no name says how many fit, never a raw {n}", async () => {
    render(<WaitlistSection day={DAY} spotMatches={[{ id: "a", guest_name: null }]} />);
    await settle();
    await waitFor(() => expect(document.body.textContent).toContain("1 venter, der passer"));
    expect(document.body.textContent).not.toContain("{n}");
  });
});

describe("a phone the owner marked as spam (fix round 27 Oct)", () => {
  const SPAM = {
    id: "s", guest_name: "Spam", guest_phone: "+45 12 34 56 78", party_size: 2, waitlist_date: DAY,
    desired_from: null, desired_to: null, status: "waiting", source: "public", note: null,
    notify_count: 0, created_at: null, held: true, held_reason: "marked_spam",
  };

  it("says why, and offers no Notify on that row only", async () => {
    h.get.mockResolvedValue({ data: { waitlist: [ROWS[2], SPAM], day: DAY, active_count: 2 } });
    render(<WaitlistSection day={DAY} />);
    await settle();
    const row = rowOf("Spam");
    expect(row.textContent).toContain(da.rsvpWlHeldLabel);
    expect(row.textContent).toContain(da.rsvpWlHeldSpam);
    expect(within(row).queryByRole("button", { name: da.rsvpWlNotify })).toBeNull();
    expect(within(row).getByRole("button", { name: da.rsvpWlBook })).toBeTruthy();
    expect(within(rowOf("Door")).getByRole("button", { name: da.rsvpWlNotify })).toBeTruthy();
    // The other held reasons keep Notify (the owner checks, then decides).
    cleanup();
    h.get.mockResolvedValue({ data: { waitlist: ROWS, day: DAY, active_count: ROWS.length } });
    render(<WaitlistSection day={DAY} />);
    await settle();
    expect(within(rowOf("Bot")).getByRole("button", { name: da.rsvpWlNotify })).toBeTruthy();
  });

  it("a server that refuses it (held_spam) is said, never 'sent'", async () => {
    h.post.mockRejectedValue(Object.assign(new Error("x"), {
      response: { status: 409, data: { detail: { error: "held_spam" } } },
    }));
    render(<WaitlistSection day={DAY} />);
    await settle();
    await act(async () => {
      fireEvent.click(within(rowOf("Door")).getByRole("button", { name: da.rsvpWlNotify }));
    });
    await settle();
    const said = h.toast.mock.calls.map((c) => c[0]).join(" | ") + " " + document.body.textContent;
    expect(said).toContain(da.rsvpWlNotifySpam);
    expect(said).not.toContain(da.rsvpWlSmsSent);
  });

  it("a repeat join's held row says the number is already on the list", async () => {
    const REPEAT = { ...SPAM, id: "r", guest_name: "Again", held_reason: "repeat_join" };
    h.get.mockResolvedValue({ data: { waitlist: [ROWS[2], REPEAT], day: DAY, active_count: 2 } });
    render(<WaitlistSection day={DAY} />);
    await settle();
    expect(rowOf("Again").textContent).toContain(da.rsvpWlHeldRepeat);
    expect(rowOf("Again").textContent).not.toContain(da.rsvpWlHeldRobot);
  });

  it("has real en and da words", () => {
    for (const k of ["rsvpWlHeldSpam", "rsvpWlNotifySpam", "rsvpWlHeldRepeat"]) {
      expect(typeof en[k]).toBe("string");
      expect(typeof da[k]).toBe("string");
      expect(da[k]).not.toBe(en[k]);
    }
  });
});

describe("the owner's switch", () => {
  it("shows on from the defaults and saves one tap", async () => {
    h.put.mockResolvedValue({ data: { settings: { public_waitlist: false } } });
    render(<PublicWaitlistSwitch t={(k, fb) => da[k] ?? fb} settings={{ public_waitlist: true }} />);
    const sw = screen.getByRole("switch", { name: da.rsvpPublicWaitlistSetting });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("rsvp-public-waitlist").textContent).toContain(da.rsvpPublicWaitlistSettingPrivacy);
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(h.put).toHaveBeenCalledWith("/reservations/settings", { settings: { public_waitlist: false } });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe(da.rsvpSaved);
    expect(sw.querySelector("span").className).toContain("bg-gray-300");
  });

  it("a failed save turns it back and says so", async () => {
    h.put.mockRejectedValue(new Error("down"));
    render(<PublicWaitlistSwitch t={(k, fb) => da[k] ?? fb} settings={{ public_waitlist: false }} />);
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe(da.rsvpSettingsSaveError);
  });

  it("is on in emerald, never green-*", async () => {
    render(<PublicWaitlistSwitch t={(k, fb) => da[k] ?? fb} settings={{}} />);
    const track = screen.getByRole("switch").querySelector("span");
    expect(track.className).toContain("bg-emerald-600");
    const src = fs.readFileSync(path.join(SRC, "components/reservations/PublicWaitlistSwitch.jsx"), "utf8");
    expect(src).not.toMatch(/\bgreen-\d/);
  });

  it("Indstillinger mounts it for table venues, under the colour, only when the server knows the key", () => {
    const src = fs.readFileSync(path.join(SRC, "pages/ReservationsPage.jsx"), "utf8");
    const at = src.indexOf("<PublicWaitlistSwitch");
    expect(at).toBeGreaterThan(src.indexOf("<BookingAccentRow t={t} />"));
    const guard = src.slice(at - 200, at);
    expect(guard).toContain("!apptWords && tableRules");
    expect(guard).toContain('"public_waitlist" in data.settings');
  });
});

describe("the day the guest picked (rescueDay)", () => {
  const map = { "2030-01-08": true, "2030-01-09": false, "2030-01-10": true };
  it("keeps a full night the guest picked, and only that one", () => {
    expect(rescueDay("2030-01-09", map, "2030-01-10", "2030-01-09")).toBe("2030-01-09");
    expect(rescueDay("2030-01-09", map, "2030-01-10", null)).toBe("2030-01-10");
    expect(rescueDay("2030-01-09", map, "2030-01-10", "2030-01-11")).toBe("2030-01-10");
    expect(rescueDay("2030-01-08", map, "2030-01-10", "2030-01-09")).toBe("2030-01-08");
    expect(rescueDay("2030-02-01", map, "2030-01-10")).toBe("2030-02-01");
  });
});

describe("words", () => {
  const KEYS = Object.keys(en).filter((k) => /^rsvp(Wl(VenueGeneric|OfferBody|OfferCta|FormTitle|NotBooking|Phone(Why|Needed)|PreferredTime|AnyTime|AnyTimeEvening|Privacy|DoneTitle|Done|DoneNoPhone|Around|Between|KeepPage|Leave|LeaveCall|LeaveConfirm\w+|Left|Erased|Booked|Over|Err\w+|LinkFailed|Held\w+|GuestLeft)|EveningFull|Nearest\w+|PublicWaitlist\w+)$/.test(k));
  it("every R12 word has real English and Danish, with the same placeholders", () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(40);
    for (const k of KEYS) {
      expect(da[k], k).toBeTruthy();
      const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
      expect(ph(da[k]), k).toBe(ph(en[k]));
    }
    // Danish is Danish (a sample): the waitlist is "ventelisten", not English.
    expect(da.rsvpWlOfferCta).toBe("Skriv mig på ventelisten");
    expect(da.rsvpWlHeldLabel).toBe("Tjek før du kontakter dem");
  });
});
