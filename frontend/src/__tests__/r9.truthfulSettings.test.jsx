/**
 * R9 (27 Oct 2026) — settings that tell the truth: the pieces.
 *
 *   • the link box shows the real address ("www.bonbox.dk/", never "/r/"),
 *     a "Nyt link" line in the server's spelling, a warning before a change
 *     that is true for the server it talks to, and the old links with Stop;
 *   • the guest page, opened on an old link, moves its address to the new
 *     one (query and hash kept, /r/ kept);
 *   • "Online-booking er slået til" when the first table switched it on;
 *   • one save per card: "Ikke gemt endnu", and a Gem that follows the card
 *     on a phone;
 *   • the phone's jump row, the Profile hours' note, the pacing gap and the
 *     hours' source, the closed-day lookup;
 *   • every new key in en and da.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), confirm: vi.fn(), toast: vi.fn(),
  navigate: vi.fn(), user: { business_type: "restaurant" },
}));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    delete: (...a) => h.del(...a),
  },
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
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
vi.mock("react-router-dom", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useNavigate: () => h.navigate };
});

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const {
  slugPreview, linkDisplay, linkPrefix, newLinkDisplay, canonicalPath, SLUG_MAX,
} = await import("../utils/bookingLink");
const { takeActivation, announceActivation, ACTIVATION_EVENT } = await import("../utils/bookingActivation");
const { bookingHoursDays, hoursSource, profileHoursNote, pacingGap } = await import("../utils/settingsTruth");
const { closureOn } = await import("../utils/closures");
const CardSaveBar = (await import("../components/reservations/CardSaveBar")).default;
const BookingLiveNotice = (await import("../components/reservations/BookingLiveNotice")).default;
const BookingLinkCard = (await import("../components/reservations/BookingLinkCard")).default;
const SettingsJumpRow = (await import("../components/reservations/SettingsJumpRow")).default;
const BookingHoursSourceNote = (await import("../components/BookingHoursSourceNote")).default;

const t = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const fill = (k, vars) => t(k, vars);
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.del, h.confirm, h.toast, h.navigate]) f.mockReset();
  h.user = { business_type: "restaurant" };
});
afterEach(() => cleanup());

// ── The link, as text ──────────────────────────────────────────────────────

describe("the link helpers", () => {
  it.each([
    ["Café Mocca", "cafe-mocca"],
    ["Smørrebrød & Øl", "smoerrebroed-oel"],
    ["Århus Bistro", "aarhus-bistro"],
    ["  --Kaffe  bar--  ", "kaffe-bar"],
    ["Ünïcode Café 1", "unicode-cafe-1"],
    ["", ""],
    ["!!!", ""],
  ])("slugPreview(%j) = %j — the server's spelling", (raw, want) => {
    expect(slugPreview(raw)).toBe(want);
  });

  it("caps at the server's 60 and never ends on a dash", () => {
    const s = slugPreview("a".repeat(59) + " b c");
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s.endsWith("-")).toBe(false);
  });

  it("shows the real address, never /r/ for a normal link", () => {
    expect(linkDisplay("https://www.bonbox.dk/bistro")).toBe("www.bonbox.dk/bistro");
    expect(linkPrefix("https://www.bonbox.dk/bistro", "bistro")).toBe("www.bonbox.dk/");
    // A legacy reserved word keeps its /r/ address — shown as it is.
    expect(linkPrefix("https://www.bonbox.dk/r/bar", "bar")).toBe("www.bonbox.dk/r/");
    expect(linkPrefix("", "")).toBe("www.bonbox.dk/");
    // A NEW link is always at the root (the server refuses reserved words).
    expect(newLinkDisplay("https://www.bonbox.dk/r/bar", "bar", "bar-ny")).toBe("www.bonbox.dk/bar-ny");
    expect(newLinkDisplay("https://www.bonbox.dk/bistro", "bistro", "ny")).toBe("www.bonbox.dk/ny");
  });

  it("the guest page's move from an old link keeps /r/ and touches nothing else", () => {
    expect(canonicalPath("/gammel", "ny")).toBe("/ny");
    expect(canonicalPath("/r/gammel", "ny")).toBe("/r/ny");
    expect(canonicalPath("/r/gammel/", "ny")).toBe("/r/ny");
    expect(canonicalPath("/ny", "ny")).toBeNull();
    expect(canonicalPath("/s/abc/def", "ny")).toBeNull();
    expect(canonicalPath("/gammel", null)).toBeNull();
    expect(canonicalPath(null, "ny")).toBeNull();
  });
});

// ── "Booking went on" ──────────────────────────────────────────────────────

describe("the activation facts", () => {
  it("takes the key off the resource and keeps the rest", () => {
    const { resource, activated } = takeActivation({
      id: "t1", label: "Bord 1",
      reservations_activated: { reservations_enabled: true, reservation_slug: "cafe", public_url: "https://www.bonbox.dk/cafe" },
    });
    expect(resource).toEqual({ id: "t1", label: "Bord 1" });
    expect(activated).toEqual({ public_url: "https://www.bonbox.dk/cafe", reservation_slug: "cafe" });
  });

  it("reads the stylist route's `activation` too, and ignores junk", () => {
    expect(takeActivation({ resource: {}, activation: { public_url: "https://x/y", reservation_slug: "y" } }).activated)
      .toEqual({ public_url: "https://x/y", reservation_slug: "y" });
    expect(takeActivation({ id: "t2" }).activated).toBeNull();
    expect(takeActivation({ reservations_activated: { public_url: "" } }).activated).toBeNull();
    expect(takeActivation({ reservations_activated: { reservations_enabled: false, public_url: "https://x" } }).activated).toBeNull();
    expect(takeActivation(null)).toEqual({ resource: null, activated: null });
  });

  it("announces with the kind, and says nothing without facts", () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener(ACTIVATION_EVENT, on);
    expect(announceActivation(null)).toBe(false);
    expect(announceActivation({ public_url: "https://www.bonbox.dk/cafe" }, "stylist")).toBe(true);
    window.removeEventListener(ACTIVATION_EVENT, on);
    expect(seen).toEqual([{ public_url: "https://www.bonbox.dk/cafe", kind: "stylist" }]);
  });
});

describe("BookingLiveNotice", () => {
  const fire = (detail) => act(async () => { window.dispatchEvent(new CustomEvent(ACTIVATION_EVENT, { detail })); });

  it("is silent until the switch went on, then says it with the link", async () => {
    render(<MemoryRouter><BookingLiveNotice t={t} /></MemoryRouter>);
    expect(screen.queryByTestId("rsvp-live-notice")).toBeNull();
    await fire({ public_url: "https://www.bonbox.dk/cafe-sofie", kind: "table" });
    const box = screen.getByTestId("rsvp-live-notice");
    expect(box.textContent).toContain(da.rsvpLiveTitle);
    expect(box.textContent).toContain(da.rsvpLiveBodyTable.split("{link}")[0]);
    const a = box.querySelector("a");
    expect(a.getAttribute("href")).toBe("https://www.bonbox.dk/cafe-sofie");
    expect(a.textContent).toBe("www.bonbox.dk/cafe-sofie");
    // The toast says it too, with the way to the switch.
    expect(h.toast).toHaveBeenCalledTimes(1);
    const opts = h.toast.mock.calls[0][0];
    expect(opts.message).toBe(fill("rsvpLiveToast", { link: "www.bonbox.dk/cafe-sofie" }));
    opts.action.onClick();
    expect(h.navigate).toHaveBeenCalledWith("/reservations?tab=settings");
  });

  it.each([["stylist", "rsvpLiveBodyStylist"], ["place", "rsvpLiveBodyPlace"]])(
    "%s: the customers' words", async (kind, key) => {
      render(<MemoryRouter><BookingLiveNotice t={t} /></MemoryRouter>);
      await fire({ public_url: "https://www.bonbox.dk/salon", kind });
      const text = screen.getByTestId("rsvp-live-notice").textContent;
      expect(text).toContain(da[key].split("{link}")[0]);
      expect(text).not.toMatch(/gæst/i);
    },
  );

  it("copies the link, goes to Indstillinger, and closes", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MemoryRouter><BookingLiveNotice t={t} /></MemoryRouter>);
    await fire({ public_url: "https://www.bonbox.dk/cafe" });
    await act(async () => { fireEvent.click(screen.getByTestId("rsvp-live-copy")); });
    expect(writeText).toHaveBeenCalledWith("https://www.bonbox.dk/cafe");
    expect(screen.getByTestId("rsvp-live-copy").textContent).toContain(da.rsvpCopied);
    // Indstillinger: there the switch's own line says it — the notice goes.
    fireEvent.click(screen.getByTestId("rsvp-live-settings"));
    expect(h.navigate).toHaveBeenCalledWith("/reservations?tab=settings");
    expect(screen.queryByTestId("rsvp-live-notice")).toBeNull();
  });

  it("× closes it", async () => {
    render(<MemoryRouter><BookingLiveNotice t={t} /></MemoryRouter>);
    await fire({ public_url: "https://www.bonbox.dk/cafe" });
    fireEvent.click(screen.getByRole("button", { name: da.dismiss }));
    expect(screen.queryByTestId("rsvp-live-notice")).toBeNull();
  });
});

// ── One save per card ──────────────────────────────────────────────────────

describe("CardSaveBar", () => {
  it("clean: no note, and the row rests at the card's end", () => {
    render(<CardSaveBar t={t} testId="bar" onSave={() => {}} />);
    const bar = screen.getByTestId("bar");
    expect(bar.textContent).not.toContain(da.rsvpCardUnsaved);
    expect(bar.className).not.toMatch(/sticky/);
    expect(bar.getAttribute("data-dirty")).toBe("false");
  });

  it("changed: says so, and sticks above the phone's tab bar (phone only)", () => {
    const onSave = vi.fn();
    render(<CardSaveBar t={t} testId="bar" dirty onSave={onSave} />);
    const bar = screen.getByTestId("bar");
    expect(bar.textContent).toContain(da.rsvpCardUnsaved);
    expect(bar.className).toMatch(/\bmax-sm:sticky\b/);
    expect(bar.className).toMatch(/max-sm:bottom-\[calc\(4\.5rem\+env\(safe-area-inset-bottom,0px\)\)\]/);
    // Phone only: nothing sticky from sm up, and no transform (iOS wobble).
    expect(bar.className).not.toMatch(/(^|\s)sticky\b/);
    expect(bar.className).not.toMatch(/translate|transform/);
    fireEvent.click(screen.getByRole("button", { name: da.save }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("saved: the check, and a submit button inside a form", () => {
    render(<form><CardSaveBar t={t} testId="bar" saved submit /></form>);
    expect(screen.getByTestId("bar").textContent).toContain(da.rsvpSaved);
    expect(screen.getByRole("button", { name: da.save }).getAttribute("type")).toBe("submit");
  });
});

// ── The link card ──────────────────────────────────────────────────────────

describe("BookingLinkCard", () => {
  const renderCard = (props = {}) => {
    const onSaved = vi.fn();
    render(
      <BookingLinkCard
        t={t}
        publicUrl="https://www.bonbox.dk/bistro"
        slug="bistro"
        aliases={[]}
        onSaved={onSaved}
        {...props}
      />,
    );
    return onSaved;
  };
  const type = (v) => fireEvent.change(screen.getByLabelText(da.rsvpCustomLink), { target: { value: v } });

  it("shows the real address in the box, never /r/", () => {
    renderCard();
    expect(screen.getByTestId("rsvp-slug-prefix").textContent).toBe("www.bonbox.dk/");
    expect(screen.getByTestId("rsvp-share-card").textContent).not.toContain("/r/");
  });

  it("shows the new link as the server will spell it, and Gem only for a change", () => {
    renderCard();
    expect(screen.getByRole("button", { name: da.save })).toBeDisabled();
    type("Bistro Århus");
    expect(screen.getByTestId("rsvp-link-preview").textContent)
      .toBe(fill("rsvpLinkChangeNew", { link: "www.bonbox.dk/bistro-aarhus" }));
    expect(screen.getByRole("button", { name: da.save })).not.toBeDisabled();
  });

  it("warns first — the old link keeps working — and only then changes it", async () => {
    h.confirm.mockResolvedValue(true);
    h.post.mockResolvedValue({ data: {
      reservation_slug: "bistro-aarhus", public_url: "https://www.bonbox.dk/bistro-aarhus",
      slug_aliases: [{ slug: "bistro", since: "2026-10-27", url: "https://www.bonbox.dk/bistro" }],
    } });
    const onSaved = renderCard();
    type("Bistro Århus");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    await settle();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const opts = h.confirm.mock.calls[0][0];
    expect(opts.title).toBe(da.rsvpLinkChangeTitle);
    expect(opts.confirmLabel).toBe(da.rsvpLinkChangeYes);
    expect(opts.irreversible).toBe(false);
    render(<div data-testid="msg">{opts.message}</div>);
    const msg = screen.getByTestId("msg").textContent;
    expect(msg).toContain(fill("rsvpLinkChangeKept", { old: "www.bonbox.dk/bistro" }));
    expect(msg).toContain(da.rsvpLinkChangeUpdate);
    expect(h.post).toHaveBeenCalledWith("/reservations/slug", { slug: "bistro-aarhus" });
    expect(onSaved).toHaveBeenCalledWith({
      reservation_slug: "bistro-aarhus", public_url: "https://www.bonbox.dk/bistro-aarhus",
      slug_aliases: [{ slug: "bistro", since: "2026-10-27", url: "https://www.bonbox.dk/bistro" }],
    });
  });

  it("a No sends nothing", async () => {
    h.confirm.mockResolvedValue(false);
    renderCard();
    type("nyt");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    await settle();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("an older server keeps no old link: the warning says it stops, and Cancel is the safe key", async () => {
    h.confirm.mockResolvedValue(false);
    renderCard({ aliases: undefined });
    type("nyt");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    const opts = h.confirm.mock.calls[0][0];
    render(<div data-testid="msg">{opts.message}</div>);
    expect(screen.getByTestId("msg").textContent).toContain(fill("rsvpLinkChangeDies", { old: "www.bonbox.dk/bistro" }));
    expect(opts.irreversible).toBe(true);
  });

  it("a full list names the old link that would stop", async () => {
    h.confirm.mockResolvedValue(false);
    const five = ["a", "b", "c", "d", "e"].map((s) => ({ slug: `gammel-${s}`, url: `https://www.bonbox.dk/gammel-${s}` }));
    renderCard({ aliases: five, aliasMax: 5 });
    type("nyt");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    const opts = h.confirm.mock.calls[0][0];
    render(<div data-testid="msg">{opts.message}</div>);
    expect(screen.getByTestId("msg").textContent).toContain(fill("rsvpLinkChangeDrops", { old: "www.bonbox.dk/gammel-e", n: 5 }));
    expect(opts.irreversible).toBe(true);
  });

  it("customers' words on an appointment book", async () => {
    h.confirm.mockResolvedValue(false);
    renderCard({ apptWords: true });
    type("salon-ny");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    const opts = h.confirm.mock.calls[0][0];
    render(<div data-testid="msg">{opts.message}</div>);
    const msg = screen.getByTestId("msg").textContent;
    expect(msg).toContain(fill("rsvpLinkChangeKeptAppt", { old: "www.bonbox.dk/bistro" }));
    expect(msg).not.toMatch(/gæst/i);
  });

  it.each([
    [{ response: { status: 409, data: { detail: { error: "slug_taken" } } } }, "rsvpSlugTaken"],
    [{ response: { status: 409, data: { detail: { error: "slug_reserved" } } } }, "rsvpSlugReserved"],
    [{ response: { status: 500 } }, "rsvpSlugError"],
  ])("a refusal is said in words (%#)", async (err, key) => {
    h.confirm.mockResolvedValue(true);
    h.post.mockRejectedValue(err);
    const onSaved = renderCard();
    type("nyt-navn");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    await settle();
    expect(screen.getByTestId("rsvp-share-card").textContent).toContain(da[key]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("too short is said, not sent", async () => {
    renderCard();
    type("x");
    fireEvent.submit(screen.getByLabelText(da.rsvpCustomLink).closest("form"));
    await settle();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("lists the old links that still work, and Stop asks first", async () => {
    h.confirm.mockResolvedValue(true);
    h.del.mockResolvedValue({ data: { slug_aliases: [] } });
    const onSaved = renderCard({ aliases: [{ slug: "gammel", since: "2026-10-27", url: "https://www.bonbox.dk/gammel" }] });
    const box = screen.getByTestId("rsvp-old-links");
    expect(box.textContent).toContain(da.rsvpOldLinksTitle);
    expect(box.textContent).toContain("www.bonbox.dk/gammel");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpOldLinkStop })); });
    await settle();
    const opts = h.confirm.mock.calls[0][0];
    expect(opts.destructive).toBe(true);
    expect(opts.message).toBe(fill("rsvpOldLinkStopBody", { old: "www.bonbox.dk/gammel" }));
    expect(h.del).toHaveBeenCalledWith("/reservations/slug/aliases/gammel");
    expect(onSaved).toHaveBeenCalledWith({ slug_aliases: [] });
  });

  it("no old-links box on an older server or with none", () => {
    renderCard({ aliases: undefined });
    expect(screen.queryByTestId("rsvp-old-links")).toBeNull();
    cleanup();
    renderCard({ aliases: [] });
    expect(screen.queryByTestId("rsvp-old-links")).toBeNull();
  });

  it("a new link from outside replaces an untouched field, never a typed one", () => {
    const { rerender } = render(<BookingLinkCard t={t} publicUrl="https://www.bonbox.dk/a" slug="a" aliases={[]} />);
    rerender(<BookingLinkCard t={t} publicUrl="https://www.bonbox.dk/b" slug="b" aliases={[]} />);
    expect(screen.getByLabelText(da.rsvpCustomLink).value).toBe("b");
    fireEvent.change(screen.getByLabelText(da.rsvpCustomLink), { target: { value: "mit-eget" } });
    rerender(<BookingLinkCard t={t} publicUrl="https://www.bonbox.dk/c" slug="c" aliases={[]} />);
    expect(screen.getByLabelText(da.rsvpCustomLink).value).toBe("mit-eget");
  });
});

// ── The phone's jump row ───────────────────────────────────────────────────

describe("SettingsJumpRow", () => {
  it("phone only, one button per card, each scrolls its card into view", () => {
    const target = document.createElement("div");
    target.id = "rsvp-hours";
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    render(<SettingsJumpRow t={t} items={[{ id: "rsvp-hours", label: "Åbningstider" }, { id: "x", label: "" }]} />);
    const nav = screen.getByTestId("rsvp-settings-jump");
    expect(nav.className).toMatch(/\bsm:hidden\b/);
    expect(nav.getAttribute("aria-label")).toBe(da.rsvpJumpAria);
    expect(nav.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Åbningstider" }));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    target.remove();
  });
});

// ── Which hours decide ─────────────────────────────────────────────────────

describe("the hours' source", () => {
  const week = (v) => Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, v]));

  it("reads both stored shapes, as the server does", () => {
    expect(bookingHoursDays({ mon: "closed", tue: "11:00-14:00", wed: [{ open: "11:00", close: "14:00" }], thu: [], fri: "x" }))
      .toEqual(["mon", "tue", "wed"]);
    expect(bookingHoursDays(null)).toEqual([]);
  });

  it("names where the online times come from", () => {
    expect(hoursSource({ bookingHours: week("17:00-22:00"), hoursDeclared: true })).toBe("booking");
    expect(hoursSource({ bookingHours: null, hoursDeclared: true })).toBe("profile");
    expect(hoursSource({ bookingHours: { mon: "closed" }, hoursDeclared: true })).toBe("mixed");
    expect(hoursSource({ bookingHours: null, hoursDeclared: false })).toBe("none");
    expect(hoursSource({ bookingHours: null, hoursDeclared: true, isProvider: true })).toBe("chairs");
  });

  it("the Profile note's words", () => {
    expect(profileHoursNote(null)).toBeNull();
    expect(profileHoursNote({ days: [], chairs_only: false })).toBe("profile");
    expect(profileHoursNote({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] })).toBe("booking");
    expect(profileHoursNote({ days: ["mon"] })).toBe("mixed");
    expect(profileHoursNote({ days: [], chairs_only: true })).toBe("chairs");
  });
});

describe("BookingHoursSourceNote (under the Profile hours)", () => {
  it.each([
    [{ days: [], chairs_only: false }, "profileHoursNoteProfile"],
    [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], chairs_only: false }, "profileHoursNoteBooking"],
    [{ days: ["mon"], chairs_only: false }, "profileHoursNoteMixed"],
    [{ days: [], chairs_only: true }, "profileHoursNoteChairs"],
  ])("%j → %s, with the way to the booking hours", (status, key) => {
    render(<MemoryRouter><BookingHoursSourceNote status={status} /></MemoryRouter>);
    const note = screen.getByTestId("profile-hours-note");
    expect(note.textContent).toContain(da[key]);
    expect(note.querySelector("a").getAttribute("href")).toBe("/reservations?tab=settings&show=hours");
  });

  it("no booking page: nothing to say", () => {
    render(<MemoryRouter><BookingHoursSourceNote status={null} /></MemoryRouter>);
    expect(screen.queryByTestId("profile-hours-note")).toBeNull();
  });

  it("asks for itself when told to, and a shop speaks of customers", async () => {
    h.user = { business_type: "workshop" };
    h.get.mockResolvedValue({ data: { booking_hours: { days: [], chairs_only: false } } });
    render(<MemoryRouter><BookingHoursSourceNote load /></MemoryRouter>);
    await settle();
    expect(h.get).toHaveBeenCalledWith("/business/operating-profile");
    expect(screen.getByTestId("profile-hours-note").textContent).toContain(da.profileHoursNoteProfileAppt);
  });

  it("a failed read says nothing", async () => {
    h.get.mockRejectedValue(new Error("down"));
    render(<MemoryRouter><BookingHoursSourceNote load /></MemoryRouter>);
    await settle();
    expect(screen.queryByTestId("profile-hours-note")).toBeNull();
  });
});

// ── Pacing counts guests ───────────────────────────────────────────────────

describe("the pacing gap", () => {
  it("names the party sizes a guests cap leaves with no online time", () => {
    expect(pacingGap({ pacing: "", maxParty: 10, requestFrom: 8 })).toBeNull();
    expect(pacingGap({ pacing: 20, maxParty: 10, requestFrom: 8 })).toBeNull();
    expect(pacingGap({ pacing: 6, maxParty: 10, requestFrom: 8 })).toEqual({ from: 7, to: 7 });
    expect(pacingGap({ pacing: 4, maxParty: 10, requestFrom: 8 })).toEqual({ from: 5, to: 7 });
    expect(pacingGap({ pacing: 4, maxParty: 6, requestFrom: "" })).toEqual({ from: 5, to: 6 });
    expect(pacingGap({ pacing: 4, maxParty: 0, requestFrom: "" })).toEqual({ from: 5, to: null });
    expect(pacingGap({ pacing: 4, maxParty: 1, requestFrom: 8 })).toBeNull();
  });
});

// ── The closed day in the new-booking sheet ────────────────────────────────

describe("closureOn", () => {
  const list = [
    { id: "p", from: "2026-12-23", to: "2026-12-24", kind: "pause", note: null },
    { id: "c", from: "2026-12-24", to: "2026-12-26", kind: "closed", note: "Jul" },
  ];
  it("a closed date wins over a pause; the range is inclusive", () => {
    expect(closureOn(list, "2026-12-24").id).toBe("c");
    expect(closureOn(list, "2026-12-23").id).toBe("p");
    expect(closureOn(list, "2026-12-26").id).toBe("c");
    expect(closureOn(list, "2026-12-27")).toBeNull();
    expect(closureOn([], "2026-12-24")).toBeNull();
    expect(closureOn(null, "2026-12-24")).toBeNull();
    expect(closureOn([{ from: "2026-12-31", kind: "closed" }], "2026-12-31").kind).toBe("closed");
  });
});

// ── Every new key, in both languages ───────────────────────────────────────

const R9_KEYS = [
  "rsvpCardUnsaved", "rsvpLiveTitle", "rsvpLiveBodyTable", "rsvpLiveBodyPlace", "rsvpLiveBodyStylist",
  "rsvpLiveNotReady", "rsvpLiveToast", "rsvpAutoOnTable", "rsvpAutoOnPlace", "rsvpAutoOnStylist",
  "rsvpLinkChangeTitle", "rsvpLinkChangeNew", "rsvpLinkChangeKept", "rsvpLinkChangeKeptAppt",
  "rsvpLinkChangeDies", "rsvpLinkChangeDiesAppt", "rsvpLinkChangeUpdate", "rsvpLinkChangeDrops",
  "rsvpLinkChangeYes", "rsvpLinkChangeNo", "rsvpOldLinksTitle", "rsvpOldLinkForwards", "rsvpOldLinkSince",
  "rsvpOldLinkWho", "rsvpOldLinkWhoAppt", "rsvpOldLinkStop", "rsvpOldLinksHint", "rsvpOldLinkStopTitle",
  "rsvpOldLinkStopBody", "rsvpOldLinkStopBodyAppt", "rsvpOldLinkStopYes", "rsvpOldLinkStopError",
  "rsvpJumpAria", "rsvpJumpLabel", "rsvpJumpLink", "rsvpJumpHours", "rsvpJumpClosures", "rsvpJumpRules",
  "rsvpJumpMessages", "rsvpJumpDevices", "rsvpHoursSourceBooking", "rsvpHoursSourceBookingAppt",
  "rsvpHoursSourceProfile", "rsvpHoursSourceProfileAppt", "rsvpHoursSourceMixed", "rsvpHoursSourceChairs",
  "rsvpSalonHoursSame", "rsvpPacingGuestsHint", "rsvpPacingGuestsHintAppt", "rsvpPacingGap",
  "rsvpPacingGapAppt", "rsvpPacingGapOne", "rsvpPacingGapOneAppt", "rsvpPacingGapOpen",
  "rsvpPacingGapOpenAppt", "rsvpNewClosedDay", "rsvpNewClosedDayNote", "rsvpNewPausedDay",
  "profileHoursNoteBooking", "profileHoursNoteBookingAppt", "profileHoursNoteProfile",
  "profileHoursNoteProfileAppt", "profileHoursNoteMixed", "profileHoursNoteMixedAppt",
  "profileHoursNoteChairs", "profileHoursNoteLink",
];

describe("i18n", () => {
  const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it.each(R9_KEYS)("%s: real en and da, same placeholders", (k) => {
    expect(typeof en[k], k).toBe("string");
    expect(typeof da[k], k).toBe("string");
    expect(en[k].trim().length).toBeGreaterThan(0);
    expect(da[k].trim().length).toBeGreaterThan(0);
    expect(holes(en[k])).toEqual(holes(da[k]));
  });

  it("Danish is Danish (only the shared words may match)", () => {
    const same = R9_KEYS.filter((k) => en[k] === da[k]);
    expect(same.sort()).toEqual(["rsvpOldLinkStop"].sort());
  });

  it("the DK words stay: behandler in da, stylist in en; customers on appointment keys", () => {
    expect(da.rsvpLiveBodyStylist).toContain("behandler");
    expect(en.rsvpLiveBodyStylist).toContain("stylist");
    for (const k of R9_KEYS.filter((x) => x.endsWith("Appt"))) {
      expect(da[k], k).not.toMatch(/gæst/i);
      expect(en[k], k).not.toMatch(/guest/i);
    }
  });

  it("the label means guests now — and says so", () => {
    expect(da.rsvpPacing).toBe("Maks. gæster pr. tid");
    expect(da.rsvpPacingGuestsHint).toMatch(/talt med alle i hver booking/);
    expect(en.rsvpPacingGuestsHint).toMatch(/counted with everyone in each booking/);
  });
});
