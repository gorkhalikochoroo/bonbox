/**
 * Egenkontrol R1b — Kontrolmappe → Dokumenter (the venue's own papers):
 *   • each row: type · title · "Uploadet … · gennemgås igen senest …"; a due
 *     or overdue review → "Gennemgå igen"; NEVER "Aktuel" / "Current"
 *     anywhere on screen;
 *   • a hygiejnebevis (founder, 13 Nov 2026: it does not expire — the server
 *     sends review_due null): only "Uploadet …", no review date, no
 *     "Gennemgå igen", no "Markér som gennemgået";
 *   • the honest line: BonBox stores them, does not read or approve them;
 *   • owner: "Tilføj dokument" (type chips, title prefilled and editable,
 *     PDF / JPEG / PNG, no capture attribute) → multipart POST; "Markér som
 *     gennemgået" → POST …/reviewed; "Slet" asks through useConfirm first →
 *     DELETE; a manager gets no buttons; the kitchen iPad views only;
 *   • open: a PDF goes to saveFile (`<title>.pdf`, share sheet allowed) and
 *     the row says what really happened; an image opens in an overlay.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.documents
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), del: vi.fn(), toast: vi.fn(), confirm: vi.fn(), saveFile: vi.fn(),
  user: { id: "u1", role: "owner" },
}));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: (...a) => h.del(...a),
    defaults: { baseURL: "http://test/api" },
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
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: (...a) => h.saveFile(...a) }));

const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const DocumentsSection = (await import("../components/egenkontrol/DocumentsSection")).default;
const FolderView = (await import("../components/egenkontrol/FolderView")).default;
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const DOCS = [
  { id: "d1", doc_type: "programme", title: "Egenkontrolprogram <b>& co</b>", content_type: "application/pdf", size_bytes: 1000,
    uploaded_at: "2026-11-01T09:00:00Z", uploaded_local_date: "2026-11-01", reviewed_at: null, reviewed_local_date: null,
    review_due: "2027-11-01", review_state: "ok", branch_id: null },
  { id: "d2", doc_type: "risk_analysis", title: "Risikoanalyse 2025", content_type: "image/jpeg", size_bytes: 2000,
    uploaded_at: "2025-11-20T09:00:00Z", uploaded_local_date: "2025-11-20", reviewed_at: null, reviewed_local_date: null,
    review_due: "2026-11-20", review_state: "soon", branch_id: null },
  { id: "d3", doc_type: "hygiene_cert", title: "Hygiejnebevis Ali", content_type: "image/jpeg", size_bytes: 2000,
    uploaded_at: "2024-03-05T09:00:00Z", uploaded_local_date: "2024-03-05", reviewed_at: null, reviewed_local_date: null,
    review_due: null, review_state: null, branch_id: null },
];
const FOLDER = {
  from: "2026-10-14", to: "2026-11-12", title_counts: { readings: 0 }, summary: {}, days: [], deviations: [], late: [], missed: [], undone: [],
  documents: DOCS, reviews: [],
};
let routes;
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const openFolder = async () => {
  render(<MemoryRouter initialEntries={["/egenkontrol?tab=folder"]}><EgenkontrolPage /></MemoryRouter>);
  await settle();
};

beforeEach(() => {
  for (const f of [h.get, h.post, h.del, h.toast, h.confirm, h.saveFile]) f.mockReset();
  h.user = { id: "u1", role: "owner" };
  h.confirm.mockResolvedValue(true);
  routes = {
    "/egenkontrol/today": { business_date: "2026-11-12", cutoff_hour: 6, checks: [], summary: {} },
    "/egenkontrol/checks": { checks: [], archived: [] },
    "/egenkontrol/templates": { templates: [] },
    "/egenkontrol/staff": { staff: [] },
    "/egenkontrol/folder": FOLDER,
  };
  h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
  __resetEgenkontrolStatus();
});

describe("the list says when, never that a paper is 'current'", () => {
  it("type · title · 'Uploadet … · gennemgås igen senest …'; due soon → 'Gennemgå igen'; no 'Aktuel'", () => {
    render(<DocumentsSection documents={DOCS} t={t} />);
    const d1 = screen.getByTestId("ek-doc-d1");
    expect(d1).toHaveTextContent(da.ekDocTypeProgramme);
    expect(d1).toHaveTextContent("Egenkontrolprogram <b>& co</b>"); // typed title, verbatim and escaped
    expect(d1).toHaveTextContent(/Uploadet 1\.? [Nn]ov\.? 26 · gennemgås igen senest 1\.? [Nn]ov\.? 27/);
    expect(within(d1).queryByText(da.ekDocReviewAgain)).toBeNull();
    expect(screen.getByTestId("ek-doc-d2")).toHaveTextContent(da.ekDocReviewAgain);
    expect(screen.getByTestId("ek-docs-honest")).toHaveTextContent(da.ekDocsHonest);
    expect(document.body.textContent).not.toMatch(/Aktuel|Current/);
    // No manage buttons without the permission.
    expect(screen.queryByTestId("ek-doc-add")).toBeNull();
    expect(screen.queryByTestId("ek-doc-delete")).toBeNull();
  });

  it("a hygiejnebevis: 'Uploadet …' only — no review date, no 'Gennemgå igen'", () => {
    render(<DocumentsSection documents={DOCS} t={t} />);
    const d3 = screen.getByTestId("ek-doc-d3");
    expect(d3).toHaveTextContent(da.ekDocTypeHygiene);
    expect(within(d3).getByTestId("ek-doc-dates")).toHaveTextContent(/^Uploadet 5\.? [Mm]ar\.? 24$/);
    expect(d3.textContent).not.toMatch(/gennemgås|senest|Gennemgå igen/);
    expect(within(d3).queryByText(da.ekDocReviewAgain)).toBeNull();
    // the yearly types keep their date
    expect(within(screen.getByTestId("ek-doc-d2")).getByTestId("ek-doc-dates")).toHaveTextContent(/gennemgås igen senest 20\.? [Nn]ov\.? 26/);
  });

  it("empty: the invitation, not a blank", () => {
    render(<DocumentsSection documents={[]} t={t} />);
    expect(screen.getByTestId("ek-docs-empty")).toHaveTextContent(da.ekDocsEmpty);
  });

  it("no egenkontrol word ever says 'Aktuel' / 'Current'", () => {
    for (const [k, v] of Object.entries(da)) if (k.startsWith("ekDoc")) expect(v, k).not.toMatch(/Aktuel/i);
    for (const [k, v] of Object.entries(en)) if (k.startsWith("ekDoc")) expect(v, k).not.toMatch(/Current/i);
  });
});

describe("opening a document", () => {
  it("a PDF → saveFile('<title>.pdf', share allowed) and the real outcome", async () => {
    const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    const loadDocument = vi.fn(async () => blob);
    h.saveFile.mockResolvedValueOnce({ ok: false, reason: "no_download_manager" }).mockResolvedValueOnce({ ok: true, channel: "download" });
    render(<DocumentsSection documents={DOCS} t={t} loadDocument={loadDocument} />);
    const row = screen.getByTestId("ek-doc-d1");
    await act(async () => { fireEvent.click(within(row).getByTestId("ek-doc-open")); });
    expect(loadDocument).toHaveBeenCalledWith(DOCS[0]);
    expect(h.saveFile).toHaveBeenCalledWith(blob, "Egenkontrolprogram b& cob.pdf", expect.objectContaining({ type: "application/pdf", preferShare: true }));
    expect(within(row).getByRole("status")).toHaveTextContent(da.ekDocOpenFailed);
    await act(async () => { fireEvent.click(within(row).getByTestId("ek-doc-open")); });
    expect(within(row).getByRole("status")).toHaveTextContent(da.ekDocDownloaded);
  });

  it("an image → an overlay (no file save)", async () => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    try {
      render(<DocumentsSection documents={DOCS} t={t} loadDocument={async () => new Blob(["x"], { type: "image/jpeg" })} />);
      await act(async () => { fireEvent.click(within(screen.getByTestId("ek-doc-d2")).getByTestId("ek-doc-open")); });
      expect(screen.getByTestId("ek-doc-overlay")).toHaveAttribute("data-back-close");
      expect(h.saveFile).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("ek-doc-overlay"));
      expect(screen.queryByTestId("ek-doc-overlay")).toBeNull();
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it("the kitchen iPad: view only — a loader, no buttons", () => {
    render(<FolderView folder={FOLDER} t={t} lang="da" loaders={{ loadDocument: vi.fn() }} />);
    expect(screen.getByTestId("ek-folder-documents")).toBeInTheDocument();
    expect(screen.getAllByTestId("ek-doc-open")[0]).not.toBeDisabled();
    expect(screen.queryByTestId("ek-doc-add")).toBeNull();
    expect(screen.queryByTestId("ek-doc-reviewed")).toBeNull();
    expect(screen.queryByTestId("ek-doc-delete")).toBeNull();
  });
});

describe("the owner manages them on the Kontrolmappe", () => {
  it("Tilføj dokument → type chips, title prefilled, PDF/JPEG/PNG, no capture → multipart POST", async () => {
    h.post.mockResolvedValue({ data: { id: "d3" } });
    await openFolder();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-doc-add")); });
    const sheet = screen.getByTestId("ek-doc-upload");
    const title = within(sheet).getByLabelText(da.ekDocTitleLabel);
    expect(title).toHaveValue(da.ekDocTypeProgramme);
    fireEvent.click(within(sheet).getByRole("button", { name: da.ekDocTypeRisk }));
    expect(title).toHaveValue(da.ekDocTypeRisk); // follows the type until typed in
    fireEvent.change(title, { target: { value: "Risikoanalyse 2026 <i>" } });
    fireEvent.click(within(sheet).getByRole("button", { name: da.ekDocTypeCleaning }));
    expect(title).toHaveValue("Risikoanalyse 2026 <i>"); // typed text is kept
    const file = within(sheet).getByTestId("ek-doc-file");
    expect(file).toHaveAttribute("accept", "application/pdf,image/jpeg,image/png");
    expect(file).not.toHaveAttribute("capture");
    expect(screen.getByTestId("ek-doc-save")).toBeDisabled();
    fireEvent.change(file, { target: { files: [new File(["%PDF-1.4"], "plan.pdf", { type: "application/pdf" })] } });
    await act(async () => { fireEvent.click(screen.getByTestId("ek-doc-save")); });
    await settle(2);
    const [url, form] = h.post.mock.calls[0];
    expect(url).toBe("/egenkontrol/documents");
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("title")).toBe("Risikoanalyse 2026 <i>");
    expect(form.get("doc_type")).toBe("cleaning_plan");
    expect(form.get("file")).toBeInstanceOf(File);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.ekDocSavedToast }));
  });

  it("the server's refusals in words (413 → too large; 409 too_many_documents)", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 413, data: { detail: { code: "too_large" } } } })
      .mockRejectedValueOnce({ response: { status: 409, data: { detail: { code: "too_many_documents" } } } });
    await openFolder();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-doc-add")); });
    fireEvent.change(screen.getByTestId("ek-doc-file"), { target: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] } });
    await act(async () => { fireEvent.click(screen.getByTestId("ek-doc-save")); });
    expect(within(screen.getByTestId("ek-doc-upload").parentElement).getByRole("alert")).toHaveTextContent(da.ekErrDocTooLarge);
    await act(async () => { fireEvent.click(screen.getByTestId("ek-doc-save")); });
    expect(within(screen.getByTestId("ek-doc-upload").parentElement).getByRole("alert")).toHaveTextContent(da.ekErrDocsFull);
  });

  it("'Markér som gennemgået' → POST …/reviewed; 'Slet' asks first → DELETE", async () => {
    h.post.mockResolvedValue({ data: {} });
    h.del.mockResolvedValue({ data: { ok: true } });
    await openFolder();
    const row = screen.getByTestId("ek-doc-d2");
    await act(async () => { fireEvent.click(within(row).getByTestId("ek-doc-reviewed")); });
    expect(h.post).toHaveBeenCalledWith("/egenkontrol/documents/d2/reviewed", {});
    h.confirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(within(screen.getByTestId("ek-doc-d2")).getByTestId("ek-doc-delete")); });
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: da.ekDocDeleteConfirmTitle, message: da.ekDocDeleteConfirmBody }));
    expect(h.del).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(screen.getByTestId("ek-doc-d2")).getByTestId("ek-doc-delete")); });
    expect(h.del).toHaveBeenCalledWith("/egenkontrol/documents/d2");
  });

  it("the owner: no 'Markér som gennemgået' on a hygiejnebevis (it has no review date); 'Slet' stays", async () => {
    await openFolder();
    const d3 = screen.getByTestId("ek-doc-d3");
    expect(within(d3).queryByTestId("ek-doc-reviewed")).toBeNull();
    expect(within(d3).getByTestId("ek-doc-delete")).toBeInTheDocument();
    expect(within(screen.getByTestId("ek-doc-d1")).getByTestId("ek-doc-reviewed")).toBeInTheDocument();
    expect(within(screen.getByTestId("ek-doc-d2")).getByTestId("ek-doc-reviewed")).toBeInTheDocument();
  });

  it("a manager: the list, no buttons", async () => {
    h.user = { id: "m1", role: "manager" };
    await openFolder();
    expect(screen.getByTestId("ek-doc-d1")).toBeInTheDocument();
    expect(screen.queryByTestId("ek-doc-add")).toBeNull();
    expect(screen.queryByTestId("ek-doc-reviewed")).toBeNull();
    expect(screen.queryByTestId("ek-doc-delete")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Aktuel/);
  });
});
