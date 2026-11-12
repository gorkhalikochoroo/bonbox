/**
 * Egenkontrol R1b — the optional photo on a deviation and on goods receiving:
 *   • the hint, word for word: "Fotografér termometeret eller maden — ikke
 *     personer.";
 *   • the photo control sits BELOW the keys (after the deviation questions)
 *     and above "Hvem målte?" — nothing above the keys moves;
 *   • a fridge reading in limit has none; a delivery always may; a tick never;
 *   • the READING is saved first, then the photo with the reading's id;
 *   • a failed upload stays on the row ("Foto ikke sendt endnu · prøv igen")
 *     and "Prøv igen" sends it again; 409 photo_exists counts as done;
 *   • the Kontrolmappe shows a thumbnail (bytes through the loader); the
 *     kitchen's read-only folder has no "Fjern"; the owner's has, and a
 *     removed photo reads "Foto fjernet af ejeren …" (also after a 410).
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.photo
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({
  today: vi.fn(), staff: vi.fn(), saveEntry: vi.fn(), uploadPhoto: vi.fn(), toast: vi.fn(),
}));
vi.mock("../services/kitchenApi", () => ({
  default: {
    today: h.today, staff: h.staff, saveEntry: h.saveEntry, undo: vi.fn(), folder: vi.fn(), unpair: vi.fn(),
    uploadPhoto: h.uploadPhoto, photo: vi.fn(), documentFile: vi.fn(),
  },
  KITCHEN_TOKEN_RE: /^[A-Za-z0-9_-]{8,128}$/,
  forgetKitchenToken: vi.fn(),
  rememberKitchenToken: vi.fn(),
  rememberedKitchenToken: () => null,
  rememberedKitchenVenue: () => null,
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
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

const KitchenPage = (await import("../pages/KitchenPage")).default;
const RecordPanel = (await import("../components/egenkontrol/RecordPanel")).default;
const FolderView = (await import("../components/egenkontrol/FolderView")).default;
const { photoAllowed, photoAddedLater } = await import("../components/egenkontrol/ekLogic");

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const FRIDGE = {
  id: "c-k1", name: "Køl 1", note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  branch_id: null, active: true, limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null,
  schedule: { type: "daily", due: "08:00" }, action_codes: ["thermostat_adjusted", "other"], fate_codes: ["moved", "discarded", "other"],
  status: "due", slot: { due_at: "2026-11-12T07:00:00Z", due_local: "08:00" }, last: null, open_deviation: null,
};
const RECEIVING = {
  ...FRIDGE, id: "c-rec", name: "Varemodtagelse", kind: "receiving", template_key: "receiving", group_key: "receiving", limit: null,
  product_limits: [{ product_type: "chilled", limit_c: 5, direction: "max", source: "law" }], schedule: { type: "on_event" }, status: "on_event", slot: null,
};
const TICK = { ...FRIDGE, id: "c-t", kind: "tick", template_key: "cleaning", group_key: "cleaning", limit: null };
const TODAY = {
  business_date: "2026-11-12", server_now: "2026-11-12T07:05:00Z", timezone: "Europe/Copenhagen", cutoff_hour: 6, setup_done: true,
  checks: [FRIDGE], summary: { total: 1, done: 0, missing: 0, due: 1, open_deviations: 0 },
  venue_name: "Café Sol", device_label: "Køkken-iPad", branch_name: null,
};
const ENTRY = {
  id: "e-9", check_id: "c-k1", recorded_at: "2026-11-12T07:05:00Z", recorded_local: "08:05", recorded_local_date: "2026-11-12",
  value_c: 7, late: false, deviation_state: "closed", voided_at: null, undo_until: "2026-11-12T07:07:00Z",
};
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "foto.jpg", { type: "image/jpeg" });
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

async function takePhoto(panel) {
  const input = within(panel).getByTestId("ek-photo-take-input");
  await act(async () => { fireEvent.change(input, { target: { files: [jpeg()] } }); });
  await settle(3);
}

async function recordDeviationWithPhoto() {
  render(
    <MemoryRouter initialEntries={["/kitchen/kt_ABCdef123456"]}>
      <Routes><Route path="/kitchen/:kitchenToken" element={<KitchenPage />} /></Routes>
    </MemoryRouter>,
  );
  await settle();
  fireEvent.click(within(screen.getByTestId("ek-row-c-k1")).getAllByRole("button")[0]);
  const panel = screen.getByTestId("ek-record-panel");
  fireEvent.click(within(panel).getByRole("button", { name: "7" }));
  fireEvent.click(within(panel).getByRole("button", { name: da.ekActThermostatAdjusted }));
  fireEvent.click(within(panel).getByRole("button", { name: da.ekFateMoved }));
  await takePhoto(panel);
  fireEvent.click(within(panel).getByRole("button", { name: /Ali K\./ }));
  await act(async () => { fireEvent.click(within(panel).getByTestId("ek-save")); });
  await settle();
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.today.mockResolvedValue(TODAY);
  h.staff.mockResolvedValue({ staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] });
});

describe("where the photo control is, and when", () => {
  it("out of limit: the hint word for word, BELOW the keys and the questions, ABOVE 'Hvem målte?'", () => {
    render(<RecordPanel check={FRIDGE} staff={[]} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    expect(within(panel).queryByTestId("ek-photo-step")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "7" }));
    const step = within(panel).getByTestId("ek-photo-step");
    expect(within(step).getByTestId("ek-photo-hint")).toHaveTextContent("Fotografér termometeret eller maden — ikke personer.");
    expect(within(step).getByRole("button", { name: da.ekPhotoTake })).toBeInTheDocument();
    const input = within(step).getByTestId("ek-photo-take-input");
    expect(input).toHaveAttribute("accept", "image/jpeg,image/png");
    expect(input).toHaveAttribute("capture", "environment");
    expect(follows(within(panel).getByTestId("ek-keypad-keys"), step)).toBe(true);
    expect(follows(within(panel).getByTestId("ek-fate-row"), step)).toBe(true);
    expect(follows(step, within(panel).getByTestId("ek-name-picker"))).toBe(true);
  });

  it("a fridge in limit: none; a delivery in limit: yes; a tick: never", () => {
    expect(photoAllowed(FRIDGE, false)).toBe(false);
    expect(photoAllowed(FRIDGE, true)).toBe(true);
    expect(photoAllowed(RECEIVING, false)).toBe(true);
    expect(photoAllowed(TICK, true)).toBe(false);
    render(<RecordPanel check={RECEIVING} staff={[]} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    expect(screen.getByTestId("ek-photo-step")).toBeInTheDocument();
  });

  it("taken: 'Tag igen' and 'Fjern foto' (local, no confirm); the panel sends it as meta.photo", async () => {
    const onSave = vi.fn(async () => ({ ok: true, entry: ENTRY }));
    render(<RecordPanel check={RECEIVING} staff={[]} heldWho={{ kind: "staff", id: "s", label: "Bo" }} onSave={onSave} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    await takePhoto(panel);
    expect(within(panel).getByTestId("ek-photo-retake")).toHaveTextContent(da.ekPhotoRetake);
    fireEvent.click(within(panel).getByTestId("ek-photo-remove-local"));
    expect(within(panel).getByRole("button", { name: da.ekPhotoTake })).toBeInTheDocument();
    await takePhoto(panel);
    fireEvent.click(within(panel).getByRole("button", { name: da.ekProductChilled + " ≤ 5,0 °C" }));
    fireEvent.click(within(panel).getByRole("button", { name: "3" }));
    await act(async () => { fireEvent.click(within(panel).getByTestId("ek-save")); });
    expect(onSave.mock.calls[0][1].photo).toBeInstanceOf(File);
  });
});

describe("the reading first, then the photo", () => {
  it("saveEntry → uploadPhoto(token, the entry's id, the file); 'Foto gemt'", async () => {
    h.saveEntry.mockResolvedValue(ENTRY);
    h.uploadPhoto.mockResolvedValue({ id: "p-1", entry_id: "e-9" });
    await recordDeviationWithPhoto();
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    expect(h.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(h.saveEntry.mock.invocationCallOrder[0]).toBeLessThan(h.uploadPhoto.mock.invocationCallOrder[0]);
    const [tok, entryId, file] = h.uploadPhoto.mock.calls[0];
    expect(tok).toBe("kt_ABCdef123456");
    expect(entryId).toBe("e-9");
    expect(file).toBeInstanceOf(File);
    expect(h.saveEntry.mock.calls[0][1]).not.toHaveProperty("photo");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.ekPhotoSaved }));
  });

  it("a failed upload stays on the row; 'Prøv igen' sends it again", async () => {
    h.saveEntry.mockResolvedValue(ENTRY);
    h.uploadPhoto.mockRejectedValueOnce(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" })).mockResolvedValueOnce({ id: "p-1" });
    await recordDeviationWithPhoto();
    const row = screen.getByTestId("ek-row-c-k1");
    const failed = within(row).getByTestId("ek-photo-failed");
    expect(failed).toHaveTextContent(da.ekPhotoNotSent);
    await act(async () => { fireEvent.click(within(failed).getByRole("button", { name: da.ekRetry })); });
    await settle();
    expect(h.uploadPhoto).toHaveBeenCalledTimes(2);
    expect(h.uploadPhoto.mock.calls[1][1]).toBe("e-9");
    expect(within(screen.getByTestId("ek-row-c-k1")).queryByTestId("ek-photo-failed")).toBeNull();
  });

  it("409 photo_exists → done (no failed row)", async () => {
    h.saveEntry.mockResolvedValue(ENTRY);
    h.uploadPhoto.mockRejectedValue({ response: { status: 409, data: { detail: { code: "photo_exists" } } } });
    await recordDeviationWithPhoto();
    expect(within(screen.getByTestId("ek-row-c-k1")).queryByTestId("ek-photo-failed")).toBeNull();
  });

  it("409 photo_window_passed → says why, no retry button", async () => {
    h.saveEntry.mockResolvedValue(ENTRY);
    h.uploadPhoto.mockRejectedValue({ response: { status: 409, data: { detail: { code: "photo_window_passed" } } } });
    await recordDeviationWithPhoto();
    const p = within(screen.getByTestId("ek-row-c-k1")).getByTestId("ek-photo-problem");
    expect(p).toHaveTextContent(da.ekPhotoWindowPassed);
    expect(within(p).queryByRole("button", { name: da.ekRetry })).toBeNull();
  });
});

describe("photos in the Kontrolmappe", () => {
  const PHOTO = { id: "p-1", entry_id: "d1", uploaded_at: "2026-11-12T07:06:00Z", uploaded_local: "08:06", uploaded_local_date: "2026-11-12", size_bytes: 1234, removed_at: null, via: "kitchen" };
  const folder = (photo) => ({
    from: "2026-10-14", to: "2026-11-12", title_counts: { readings: 1, deviations: 1, deviations_open: 0 },
    summary: { readings: 1, deviations: 1 }, days: [], late: [], missed: [], undone: [],
    deviations: [{
      id: "d1", check_name: "Køl 1", recorded_local: "08:05", recorded_local_date: "2026-11-12", value_c: 7, limit_c: 5, limit_direction: "max",
      action_code: "thermostat_adjusted", fate_code: "moved", deviation_state: "closed", state: "closed", chain: [], followups: [], photo,
    }],
  });

  it("kitchen (read-only): a thumbnail through the loader, no 'Fjern'", async () => {
    const loadPhoto = vi.fn(async () => new Blob(["x"], { type: "image/jpeg" }));
    render(<FolderView folder={folder(PHOTO)} t={t} lang="da" loaders={{ loadPhoto }} />);
    await settle(3);
    const photo = screen.getByTestId("ek-entry-photo");
    expect(within(photo).getByRole("button", { name: da.ekPhotoAttached })).toBeInTheDocument();
    expect(loadPhoto).toHaveBeenCalledWith("p-1");
    expect(screen.queryByTestId("ek-photo-remove")).toBeNull();
  });

  it("owner: 'Fjern fotoet' calls the page's handler with the photo", async () => {
    const onRemovePhoto = vi.fn();
    render(
      <FolderView
        folder={folder(PHOTO)}
        t={t}
        lang="da"
        loaders={{ loadPhoto: async () => new Blob(["x"]) }}
        permissions={{ canRemovePhoto: true }}
        handlers={{ onRemovePhoto }}
      />,
    );
    await settle(3);
    fireEvent.click(screen.getByTestId("ek-photo-remove"));
    expect(onRemovePhoto).toHaveBeenCalledWith(expect.objectContaining({ id: "p-1" }));
  });

  it("a photo added more than 10 min after the reading says when (the PDF's rule): 'Foto vedlagt (tilføjet … kl. 15:00)'", async () => {
    const late = { ...PHOTO, uploaded_at: "2026-11-12T14:00:00Z", uploaded_local: "15:00", uploaded_local_date: "2026-11-12" };
    const f = folder(late);
    f.deviations[0].recorded_at = "2026-11-12T07:00:00Z";
    render(<FolderView folder={f} t={t} lang="da" loaders={{ loadPhoto: async () => new Blob(["x"]) }} />);
    await settle(3);
    expect(screen.getByTestId("ek-photo-label")).toHaveTextContent(/^Foto vedlagt \(tilføjet .*12.* kl\. 15:00\)$/);
  });

  it("within 10 min (and exactly 10) it is plain 'Foto vedlagt'", async () => {
    for (const [at, local] of [["2026-11-12T07:05:00Z", "08:05"], ["2026-11-12T07:10:00Z", "08:10"]]) {
      const f = folder({ ...PHOTO, uploaded_at: at, uploaded_local: local });
      f.deviations[0].recorded_at = "2026-11-12T07:00:00Z";
      const { unmount } = render(<FolderView folder={f} t={t} lang="da" loaders={{ loadPhoto: async () => new Blob(["x"]) }} />);
      await settle(3);
      expect(screen.getByTestId("ek-photo-label")).toHaveTextContent(/^Foto vedlagt$/);
      unmount();
    }
    expect(photoAddedLater({ uploaded_at: "2026-11-12T07:10:01Z" }, { recorded_at: "2026-11-12T07:00:00Z" })).toBe(true);
    expect(photoAddedLater({ uploaded_at: "2026-11-12T07:10:00Z" }, { recorded_at: "2026-11-12T07:00:00Z" })).toBe(false);
    expect(photoAddedLater({ uploaded_at: "x" }, { recorded_at: "2026-11-12T07:00:00Z" })).toBe(false);
  });

  it("a removed photo: 'Foto fjernet af ejeren …' — from the row, or after a 410", async () => {
    const { unmount } = render(<FolderView folder={folder({ ...PHOTO, removed_at: "2026-11-12T10:00:00Z" })} t={t} lang="da" loaders={{ loadPhoto: vi.fn() }} />);
    expect(screen.getByTestId("ek-photo-removed")).toHaveTextContent(/^Foto fjernet af ejeren 12\. nov\.? 2026$/);
    unmount();
    render(<FolderView folder={folder(PHOTO)} t={t} lang="da" loaders={{ loadPhoto: async () => { throw { response: { status: 410 } }; } }} />);
    await settle(3);
    expect(screen.getByTestId("ek-photo-removed")).toHaveTextContent("Foto fjernet af ejeren");
  });
});
