import { useState, useRef, useEffect } from "react";
import { Camera, PackageCheck } from "lucide-react";
import api from "../services/api";
import { useEntitlements } from "../hooks/useEntitlements";
import { useLanguage } from "../hooks/useLanguage";
import { resizeImageIfLarge } from "../utils/resizeImage";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";

/**
 * Smart Inventory Import — frontend for the backend pipeline shipped
 * in commits 8e82197 + 9e0aa07 + 488b494.
 *
 * Three input modes:
 *   • Paste text (free-form list, owner types or speaks)
 *   • Upload CSV / Excel
 *   • Upload photo (paper list / supplier slip / phone camera)
 *
 * Flow:
 *   1. Owner picks mode + provides input → POST to backend, get a draft
 *   2. Review table — categories auto-filled, perishables auto-flagged
 *      with use-by dates, owner can edit names / qty / category inline
 *   3. Commit → POST /commit, real InventoryItem rows are created
 *
 * Defense-relevant UX notes:
 *   • Per-tier daily import cap (free=2, pro=50) is enforced server-side;
 *     UI shows the 429 message in a toast.
 *   • The image is persisted to durable Supabase Storage (the storage
 *     work shipped today); the review screen has an optional "View
 *     original" link that hits /api/inventory/smart-import/{id}/image.
 *   • All bounds (200-item cap, 200-char name max, 12MB image cap, etc.)
 *     come back as 422 from Pydantic — toasted clearly.
 */
export default function SmartImportModal({
  open, onClose, onCommitted, smartScanPrefill = null, draftId = null,
}) {
  // Smart Scan handoff — two flavors:
  //
  //   1. Direct handoff (Q2, May 2026) — `draftId` is set. The backend
  //      already promoted the smart-scan extraction into a real draft;
  //      we skip the entire file-pick step and load directly into the
  //      review step via GET /inventory/smart-import/{id}.
  //
  //   2. Legacy fallback — only `smartScanPrefill` is set. The handoff
  //      endpoint failed (or wasn't available); we surface a banner
  //      explaining why we asked the owner to re-upload.
  //
  // The two paths share the review UI; they only differ in WHERE the
  // draft came from. This keeps the SmartImportModal a single source
  // of truth for the review experience.
  const [mode, setMode] = useState(
    draftId || smartScanPrefill ? "image" : "text",
  ); // text | csv | excel | image | history
  const [textInput, setTextInput] = useState("");
  const [fileInput, setFileInput] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [committing, setCommitting] = useState(false);
  const [history, setHistory] = useState(null); // null = unloaded, [] = empty
  const fileRef = useRef(null);
  // L1 / L2 — tier-aware UI. The backend (L3 router) already short-
  // circuits the supplier dictionary match for Free, so the pre-flight
  // here uses the same flag from the entitlements payload — no second
  // round-trip needed. hasFeature() fails closed if entitlements
  // haven't loaded yet, so Free users never accidentally see the
  // Starter+ pill / banner during the bootstrap window.
  const { hasFeature } = useEntitlements();
  const { t } = useLanguage();
  const supplierDetectionUnlocked = hasFeature("supplier_auto_detection");

  useEffect(() => {
    if (!open) {
      // Reset on close so the next open is fresh.
      setMode("text");
      setTextInput("");
      setFileInput(null);
      setDraft(null);
      setError("");
      setHistory(null);
    } else if (smartScanPrefill || draftId) {
      // Re-opened with a Smart Scan handoff — force image mode so the
      // owner sees the right picker immediately. (For draftId we go
      // straight to the review step below; the mode is just defensive
      // in case the load fails and we fall back to the picker.)
      setMode("image");
    }
  }, [open, smartScanPrefill, draftId]);

  // Direct handoff (Q2) — when a draftId is provided, load the
  // existing draft and jump to the review step. This skips the entire
  // file-picker flow.
  useEffect(() => {
    if (!open || !draftId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.get(`/inventory/smart-import/${draftId}`)
      .then((r) => {
        if (cancelled) return;
        setDraft(r.data);
      })
      .catch((e) => {
        if (cancelled) return;
        // L9 graceful — if the draft fetch fails (e.g. race with a
        // cleanup job), drop the owner back into the regular file
        // picker rather than blanking the modal.
        const detail = e?.response?.data?.detail;
        setError(
          typeof detail === "string"
            ? detail
            : t(
                "smartScan.invoiceLoadFailed",
                "Kunne ikke åbne tidligere registreret faktura — vælg billede igen.",
              ),
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, draftId, t]);

  // Lazy-load history when the user picks the History tab. Re-fetches on
  // re-entry so the list reflects any imports just committed during this
  // modal session.
  useEffect(() => {
    if (mode !== "history" || !open) return;
    let cancelled = false;
    api.get("/inventory/smart-import")
      .then(r => { if (!cancelled) setHistory(r.data || []); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [mode, open]);

  if (!open) return null;

  /* ─── Extract step ──────────────────────────────────────────────── */
  async function runExtract() {
    setError("");
    setLoading(true);
    try {
      let resp;
      if (mode === "text") {
        if (!textInput.trim()) {
          setError(t("siErrPasteFirst", "Paste or type your inventory list first."));
          setLoading(false);
          return;
        }
        resp = await api.post("/inventory/smart-import/text", {
          text: textInput,
        });
      } else {
        if (!fileInput) {
          setError(t("siErrPickFile", "Pick a file first."));
          setLoading(false);
          return;
        }
        // Auto-resize iPhone-sized photos so they fit under our 12 MB
        // backend cap and upload faster on 4G in restaurant kitchens.
        // CSV / Excel files pass through unchanged.
        const toUpload = mode === "image"
          ? await resizeImageIfLarge(fileInput)
          : fileInput;
        const fd = new FormData();
        fd.append("file", toUpload);
        fd.append("source_kind", mode);
        resp = await api.post("/inventory/smart-import/file", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      setDraft(resp.data);
    } catch (e) {
      const detail = e?.response?.data?.detail;
      setError(
        typeof detail === "string"
          ? detail
          : t("siErrExtract", "Couldn't extract — check the file or paste, then retry."),
      );
    } finally {
      setLoading(false);
    }
  }

  /* ─── Inline editing in the review table ────────────────────────── */
  function updateRow(idx, field, value) {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, items: d.items.map((it, i) =>
        i === idx ? { ...it, [field]: value } : it,
      ) };
      return next;
    });
  }
  function removeRow(idx) {
    setDraft((d) =>
      d ? { ...d, items: d.items.filter((_, i) => i !== idx) } : d,
    );
  }

  /* ─── Commit step ───────────────────────────────────────────────── */
  async function runCommit() {
    if (!draft) return;
    setError("");
    setCommitting(true);
    try {
      // Coerce qty to numbers; backend enforces ge=0/le=1M via Pydantic.
      // Inventory spend loop: cost_per_unit + expiry_date are now carried
      // through (previously dropped) so a received vare keeps its price +
      // best-before. Every reviewed line is "modtaget på lager" — the owner
      // removes a non-stock line (a delivery fee) with the ✕ instead.
      const items = draft.items.map((it) => ({
        name: (it.name || "").trim(),
        qty: it.qty == null || it.qty === "" ? null : Number(it.qty),
        unit: it.unit || null,
        category: it.category || null,
        cost_per_unit:
          it.cost_per_unit == null || it.cost_per_unit === ""
            ? null
            : Number(it.cost_per_unit),
        expiry_date: it.expiry_date || null,
      })).filter((it) => it.name);

      if (items.length === 0) {
        setError(t("siErrAllEmpty", "All rows are empty — nothing to save."));
        setCommitting(false);
        return;
      }

      const resp = await api.post(
        `/inventory/smart-import/${draft.id}/commit`,
        { items },
      );
      onCommitted?.(resp.data);
      onClose?.();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      setError(
        typeof detail === "string"
          ? detail
          : t("siErrSaveFailed", "Save failed — please review the items and retry."),
      );
    } finally {
      setCommitting(false);
    }
  }

  /* ─── Render ────────────────────────────────────────────────────── */
  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              ✨ {t("siTitle", "Smart Inventory Import")}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {t("siSubtitle", "Paste, upload, or photograph your stock list — AI fills in the rest.")}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-2xl leading-none"
            aria-label={t("close", "Close")}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {/* Smart Scan handoff banner — fires when InventoryPage opened
              us with a smart-scan invoice prefill BUT no live draft was
              available (handoff endpoint failed). Honest copy: the
              classifier already extracted the data once, but we need
              to re-upload to create a committable draft. */}
          {smartScanPrefill && !draftId && !draft && (
            <div className="mb-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/40 p-3 text-sm text-gray-900 dark:text-gray-100">
              <div className="font-medium flex items-center gap-2 mb-0.5">
                <span aria-hidden="true">✨</span>
                {t("smartScan.invoiceHandoff", "Faktura registreret af Smart skan")}
              </div>
              <div className="text-xs opacity-90">
                {t(
                  "smartScan.invoiceHandoffBody",
                  "Vælg det samme billede igen for at importere varerne. Vi gennemgår dem inden de gemmes.",
                )}
              </div>
            </div>
          )}
          {/* Direct-handoff loading state — only fires when InventoryPage
              opened us with a draftId and we're fetching the row. The
              file-pick step is skipped entirely. */}
          {draftId && loading && !draft ? (
            <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
              <div className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-2"></div>
              <p>{t("smartScan.invoiceLoadingDraft", "Åbner faktura…")}</p>
              {error && (
                <p className="mt-2 text-red-600 dark:text-red-400 text-xs">
                  {error}
                </p>
              )}
            </div>
          ) : !draft ? (
            <ExtractStep
              mode={mode}
              setMode={setMode}
              textInput={textInput}
              setTextInput={setTextInput}
              fileInput={fileInput}
              setFileInput={setFileInput}
              fileRef={fileRef}
              error={error}
              loading={loading}
              onRun={runExtract}
              history={history}
              t={t}
            />
          ) : (
            <ReviewStep
              draft={draft}
              updateRow={updateRow}
              removeRow={removeRow}
              error={error}
              committing={committing}
              onBack={() => setDraft(null)}
              onCommit={runCommit}
              supplierDetectionUnlocked={supplierDetectionUnlocked}
              t={t}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Extract step UI ─────────────────────────────────────────────── */
function ExtractStep({
  mode, setMode, textInput, setTextInput, fileInput, setFileInput,
  fileRef, error, loading, onRun, history, t,
}) {
  const isInputMode = mode !== "history";
  return (
    <div className="space-y-4">
      {/* Mode tabs */}
      <div className="flex gap-2 flex-wrap">
        {[
          { id: "text",    label: `📝 ${t("siTabPasteText", "Paste text")}` },
          { id: "csv",     label: "📄 CSV" },
          { id: "excel",   label: "📊 Excel" },
          { id: "image",   label: t("siTabPhoto", "Photo"), iconKey: "camera" },
          { id: "history", label: `📜 ${t("siTabRecent", "Recent")}` },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              mode === m.id
                ? "bg-blue-600 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* History list */}
      {mode === "history" && (
        <HistoryList history={history} t={t} />
      )}

      {/* Body — one input per mode (input modes only) */}
      {isInputMode && mode === "text" && (
        <div>
          <textarea
            className="w-full h-48 px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            placeholder={
              "Tuborg 24 bottles\nVodka 5 liter\nLemons 30\nTomater 5 kg"
            }
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
          />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t("siTextHint", "One item per line. Quantity and unit are auto-detected.")}
          </p>
        </div>
      )}

      {isInputMode && (mode === "csv" || mode === "excel") && (
        <div>
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center hover:border-blue-400 transition"
          >
            <div className="text-4xl mb-2">
              {mode === "csv" ? "📄" : "📊"}
            </div>
            <p className="text-gray-700 dark:text-gray-300 font-medium">
              {fileInput ? fileInput.name : t("siChooseFile", "Click to choose a {kind}", { kind: mode.toUpperCase() })}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {mode === "csv" && t("siCsvMax", "Up to 1 MB")}
              {mode === "excel" && t("siExcelMax", "Up to 5 MB")}
            </p>
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept={
              mode === "csv"
                ? ".csv,text/csv"
                : ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            }
            onChange={(e) => setFileInput(e.target.files?.[0] || null)}
          />
        </div>
      )}

      {isInputMode && mode === "image" && (
        <div>
          {fileInput ? (
            <div className="border-2 border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
              <Camera className="w-6 h-6 text-gray-500 dark:text-gray-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {fileInput.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {(fileInput.size / 1024).toFixed(0)} KB
                  {fileInput.size > 1.5 * 1024 * 1024 && (
                    <span className="ml-1 text-blue-600 dark:text-blue-400">
                      · {t("siWillResize", "will be auto-resized")}
                    </span>
                  )}
                </p>
              </div>
              <button
                onClick={() => setFileInput(null)}
                className="text-xs px-2 py-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-600">
                {t("siChange", "Change")}
              </button>
            </div>
          ) : (
            <>
              {/* Two buttons on iOS: 'Take Photo' opens the rear camera
                  directly (capture="environment"); 'Choose Photo' opens
                  the photo library / files picker. Same split as the
                  daily-close scan UI for consistency. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    if (fileRef.current) {
                      fileRef.current.setAttribute("capture", "environment");
                      fileRef.current.click();
                    }
                  }}
                  className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center hover:border-blue-400 hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition group"
                >
                  <div className="text-4xl mb-2 group-hover:scale-110 transition">📸</div>
                  <p className="text-gray-700 dark:text-gray-300 font-semibold">
                    {t("siTakePhoto", "Take Photo")}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t("siTakePhotoHint", "Opens camera on iPhone / iPad")}
                  </p>
                </button>
                <button
                  onClick={() => {
                    if (fileRef.current) {
                      fileRef.current.removeAttribute("capture");
                      fileRef.current.click();
                    }
                  }}
                  className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center hover:border-blue-400 hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition group"
                >
                  <div className="text-4xl mb-2 group-hover:scale-110 transition">🖼️</div>
                  <p className="text-gray-700 dark:text-gray-300 font-semibold">
                    {t("siChoosePhoto", "Choose Photo")}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t("siChoosePhotoHint", "From photo library or files")}
                  </p>
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                {t("siImageFormats", "JPG, PNG, HEIC, WebP up to 12 MB · iPhone HEIC + big photos auto-resize on upload")}
              </p>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/*"
            onChange={(e) => setFileInput(e.target.files?.[0] || null)}
          />
        </div>
      )}

      {isInputMode && error && (
        <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {isInputMode && (
        <div className="flex justify-end">
          <button
            onClick={onRun}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition"
          >
            {loading ? t("siExtracting", "Extracting…") : t("siExtractItems", "Extract items →")}
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── History list UI ─────────────────────────────────────────────── */
function HistoryList({ history, t }) {
  if (history === null) {
    return (
      <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        {t("loading", "Loading…")}
      </div>
    );
  }
  if (history.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>{t("siHistEmpty", "No imports yet.")}</p>
        <p className="text-xs mt-1 opacity-80">
          {t("siHistEmptyHint", "Switch to Paste text, CSV, Excel or Photo to start your first one.")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 max-h-[480px] overflow-y-auto">
      {history.map((h) => {
        const fmt = (iso) =>
          iso
            ? new Date(iso).toLocaleString(undefined, {
                weekday: "short", day: "numeric", month: "short",
                hour: "2-digit", minute: "2-digit",
              })
            : "—";
        const statusStyle = {
          committed: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
          created:   "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
          abandoned: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400",
          failed:    "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300",
        }[h.status] || "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400";
        const kindIcon = {
          text:  "📝",
          csv:   "📄",
          excel: "📊",
          image: "📷",
        }[h.source_kind] || "📦";
        const openPhoto = async () => {
          try {
            const res = await api.get(
              `/inventory/smart-import/${h.id}/image`,
              { responseType: "blob" },
            );
            const url = URL.createObjectURL(res.data);
            window.open(url, "_blank", "noopener,noreferrer");
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          } catch (e) {
            console.error("Failed to load original photo", e);
          }
        };
        return (
          <div key={h.id}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span className="text-lg shrink-0">{kindIcon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {h.source_filename || t("siKindImport", "{kind} import", { kind: h.source_kind })}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {fmt(h.created_at)}
                  {" · "}
                  {h.status === "committed"
                    ? t("siSavedOf", "{saved} of {total} saved", { saved: h.committed_count, total: h.item_count })
                    : t("siItemsExtracted", "{count} item(s) extracted", { count: h.item_count })}
                  {h.user_corrected && (
                    <span className="ml-1 text-purple-600 dark:text-purple-400" title={t("siTrainedAiTitle", "AI learned from your corrections on this import")}>
                      · ✨ {t("siTrainedAi", "trained AI")}
                    </span>
                  )}
                  {h.error && (
                    <span className="ml-1 text-red-500" title={h.error}>
                      · {t("siErrorLabel", "error")}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Photo button — same pattern as daily close history rows.
                  Only shows for image-kind imports; the storage_key on
                  the row guarantees a backing blob in Supabase. */}
              {h.source_kind === "image" && (
                <button
                  onClick={openPhoto}
                  title={t("siViewOriginalTitle", "View the original uploaded photo")}
                  aria-label={t("siViewOriginalAria", "View original photo")}
                  className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-700 font-medium inline-flex items-center justify-center">
                  <Camera className="w-3.5 h-3.5" />
                </button>
              )}
              <span className={`text-[10px] uppercase font-bold px-2 py-1 rounded ${statusStyle}`}>
                {h.status}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Supplier auto-detection upgrade nudge — Free-tier UI ──────────── */
/*
 * Renders L1 / L9 of the supplier-detection tier gate: when the owner is
 * on Free we replace the green-check SupplierBanner with a one-tap
 * upgrade pitch. Same visual footprint so the layout doesn't shift.
 *
 * Defensive UX: the OCR itself ran (we still got line items) — this
 * banner is purely about the dictionary-match + auto-category layer.
 */
function SupplierUpgradeNudge({ t }) {
  // App Store compliance (Apple 3.1.1): this is a pure upsell ("Supplier auto-
  // detection — Starter+ · Upgrade to…"). Hide it entirely on native — no
  // banner, tier name, or upgrade pitch. Web unchanged.
  if (isNativeApp()) return null;
  return (
    <div className="rounded-lg border px-3 py-2 text-sm bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
      <div className="flex items-start gap-2">
        <span className="text-base leading-none text-amber-600 dark:text-amber-400 mt-0.5">
          🔒
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 dark:text-gray-100">
            {t(
              "smartImportSupplierGateTitle",
              "Supplier auto-detection — Starter+",
            ) || "Supplier auto-detection — Starter+"}
          </p>
          <p className="mt-0.5 text-xs text-gray-700 dark:text-gray-300">
            {t(
              "smartImportSupplierGateBody",
              "Upgrade to identify Hørkram / BC Catering / AB Catering and auto-categorize up to 30 items at once.",
            ) ||
              "Upgrade to identify Hørkram / BC Catering / AB Catering and auto-categorize up to 30 items at once."}
          </p>
        </div>
        {canPurchaseInApp() && (
          <a
            href="/subscription"
            className="shrink-0 text-xs font-semibold px-2 py-1 rounded bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90"
          >
            {t("smartImportSupplierGateCta", "Upgrade") || "Upgrade"}
          </a>
        )}
      </div>
    </div>
  );
}

/* ─── Supplier banner — only renders for image-kind invoice OCR ─────── */
/*
 * Three states:
 *   • Known supplier — green check + canonical name + CVR + industry chip
 *   • Unknown supplier (name extracted, no dict hit) — amber chip + raw name
 *   • No supplier (text/CSV/Excel OR OCR didn't find one) — null
 *
 * Colors follow DNA: black text on tinted background, no shouty fills.
 */
function SupplierBanner({ supplier, supplierMatch, invoiceTotals, ocrProvider, t }) {
  if (!supplier && !supplierMatch) return null;
  const rawName = supplier?.name || null;
  const cvr = supplier?.cvr || null;
  const invoiceNo = supplier?.invoice_number || null;
  const invoiceDate = supplier?.invoice_date || null;
  const matched = !!supplierMatch?.canonical;
  const canonical = supplierMatch?.canonical || rawName;
  const industry = supplierMatch?.industry || null;

  const totals = invoiceTotals || {};
  const hasTotals = totals.grand_total != null || totals.subtotal != null;

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${
      matched
        ? "bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-800"
        : "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800"
    }`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-base leading-none ${
          matched ? "text-emerald-600 dark:text-gray-300" : "text-amber-600 dark:text-amber-400"
        }`}>
          {matched ? "✓" : "?"}
        </span>
        <span className="font-semibold text-gray-900 dark:text-gray-100">
          {matched
            ? <>{t("siDetected", "Detected:")} <span className="capitalize">{canonical}</span></>
            : (rawName ? <>{t("siDetectedSupplier", "Detected supplier:")} {rawName}</> : <>{t("siUnknownSupplier", "Unknown supplier")}</>)}
        </span>
        {cvr && (
          <span className="text-xs text-gray-600 dark:text-gray-300">
            CVR {cvr}
          </span>
        )}
        {industry && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
            {industry.replace(/_/g, " ")}
          </span>
        )}
        {ocrProvider === "claude_inventory" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
            {t("siInvoiceOcr", "Faktura OCR")}
          </span>
        )}
      </div>
      {(invoiceNo || invoiceDate || hasTotals) && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
          {invoiceNo && <span>{t("siInvoiceNo", "Faktura #")}{invoiceNo}</span>}
          {invoiceDate && <span>{t("siDateLabel", "Date:")} {invoiceDate}</span>}
          {totals.grand_total != null && (
            <span>
              {t("siTotalLabel", "Total:")} <span className="font-medium text-gray-800 dark:text-gray-200">
                {Number(totals.grand_total).toLocaleString(undefined, {
                  minimumFractionDigits: 2, maximumFractionDigits: 2,
                })} {totals.currency || "DKK"}
              </span>
            </span>
          )}
          {totals.vat_total != null && (
            <span>MOMS: {Number(totals.vat_total).toLocaleString(undefined, {
              minimumFractionDigits: 2, maximumFractionDigits: 2,
            })}</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Per-item category pill — DNA-compliant confidence colors ──────── */
/*
 * High confidence (>0.85) → neutral gray pill, no extra hint
 * Medium (0.6 - 0.85)     → gray pill + small "verify" muted hint
 * Low (<0.6)              → amber pill + "category needed" hint
 * Always black text per DNA — color signals only via background tint.
 */
function CategoryPill({ category, confidence, t }) {
  if (!category) return null;
  const c = typeof confidence === "number" ? confidence : null;
  let bg = "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200";
  let hint = null;
  if (c != null) {
    if (c < 0.6) {
      bg = "bg-amber-100 dark:bg-amber-900/40 text-gray-900 dark:text-amber-100";
      hint = t("siCategoryNeeded", "category needed");
    } else if (c < 0.85) {
      hint = t("siVerify", "verify");
    }
  }
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium truncate ${bg}`}>
        {category}
      </span>
      {hint && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
          {hint}
        </span>
      )}
    </span>
  );
}

/* ─── Review step UI ──────────────────────────────────────────────── */
function ReviewStep({
  draft, updateRow, removeRow, error, committing, onBack, onCommit,
  supplierDetectionUnlocked, t,
}) {
  const items = draft.items || [];
  const ruleCount = items.filter((it) => it.category_source === "rule").length;
  const aiCount = items.filter((it) => it.category_source === "ai").length;
  const fallbackCount = items.filter((it) => it.category_source === "fallback").length;

  // L1 / L2 — pre-flight tier gate.  When the owner is on Free, the
  // backend never enriches the response with supplier_match / per-line
  // categories (L3 router gate).  Render the upgrade nudge in the same
  // slot so the layout doesn't shift and the user knows WHY the
  // SupplierBanner is missing.  We only show the nudge on image
  // imports where the supplier-detection feature would have applied —
  // text / CSV / Excel have no header to detect.
  const wouldShowSupplierBanner = draft.source_kind === "image";
  const showSupplierGate =
    wouldShowSupplierBanner && !supplierDetectionUnlocked;

  return (
    <div className="space-y-4">
      {/* Supplier banner OR upgrade nudge — only present on image imports.
          For Starter+ users we render the real green-check banner with
          dictionary match. For Free users we replace it with the
          UpgradeNudge so the slot is never silently empty (L9 graceful
          degradation). */}
      {showSupplierGate ? (
        <SupplierUpgradeNudge t={t} />
      ) : (
        <SupplierBanner
          supplier={draft.supplier}
          supplierMatch={draft.supplier_match}
          invoiceTotals={draft.invoice_totals}
          ocrProvider={draft.ocr_provider}
          t={t}
        />
      )}

      {/* Stats banner */}
      <div className="flex flex-wrap gap-3 text-sm items-center">
        <Stat label={t("siStatItems", "Items")} value={items.length} color="blue" />
        <Stat label={t("siStatRuleMatched", "Rule-matched")} value={ruleCount} color="green" />
        {aiCount > 0 && <Stat label={t("siStatAiClassified", "AI-classified")} value={aiCount} color="purple" />}
        {fallbackCount > 0 && <Stat label={t("siStatNeedsReview", "Needs review")} value={fallbackCount} color="amber" />}
        {/* Original-photo link — only image-kind imports have a stored
            blob. Backend's GET /smart-import/{id}/image is auth-required,
            so a plain <a href> in a new tab won't carry the bearer
            token. We fetch via the api client (which has the cookie /
            bearer attached) and create a blob URL that the browser can
            display inline. Same UX pattern as the kasserapport /
            daily-close receipt button. */}
        {draft.source_kind === "image" && (
          <button
            onClick={async () => {
              try {
                const res = await api.get(
                  `/inventory/smart-import/${draft.id}/image`,
                  { responseType: "blob" },
                );
                const url = URL.createObjectURL(res.data);
                window.open(url, "_blank", "noopener,noreferrer");
                // Revoke after a minute so memory doesn't leak; the new
                // tab keeps its own reference until the user closes it.
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
              } catch (e) {
                console.error("Failed to load original photo", e);
              }
            }}
            className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 text-xs font-medium inline-flex items-center gap-1"
            title={t("siViewOriginalTitle", "View the original uploaded photo")}
          >
            <Camera className="w-3.5 h-3.5" /> {t("siViewOriginalPhoto", "View original photo")}
          </button>
        )}
        {draft.duplicate_of && (
          <span className="px-2 py-1 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 text-xs">
            {t("siDuplicate", "Duplicate of an earlier upload — same draft returned")}
          </span>
        )}
      </div>

      {/* Capture-confirm beat — one calm fade+rise ("I read it; it lands on
          your lager when you save"), then stillness. animate-fadeIn is the
          shared design-system beat (opacity + 8px rise, prefers-reduced-motion
          safe). */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 animate-fadeIn">
        <span className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900">
          <PackageCheck className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {t("siReadTitle", "Read")} · {items.length} {t("siItemsShort", "items")}
            {draft.invoice_totals?.grand_total
              ? ` · ${Math.round(draft.invoice_totals.grand_total).toLocaleString("da-DK")} kr`
              : ""}
            {draft.supplier?.name ? ` · ${draft.supplier.name}` : ""}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {t("siReadGoesToLager", "Goes on your lager when you save")}
          </div>
        </div>
      </div>

      {/* Review table */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-900 text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 font-medium">
          <div className="col-span-5">{t("siColName", "Name")}</div>
          <div className="col-span-2">{t("siColQty", "Qty")}</div>
          <div className="col-span-2">{t("siColUnit", "Unit")}</div>
          <div className="col-span-2">{t("siColCategory", "Category")}</div>
          <div className="col-span-1"></div>
        </div>
        <div className="max-h-[380px] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 stagger-cards">
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 px-3 py-2 items-center">
              <input
                value={it.name || ""}
                onChange={(e) => updateRow(idx, "name", e.target.value)}
                className="col-span-5 px-2 py-1 bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-600 focus:border-gray-900 focus:outline-none rounded text-sm"
                maxLength={200}
              />
              <input
                value={it.qty ?? ""}
                onChange={(e) => updateRow(idx, "qty", e.target.value)}
                className="col-span-2 px-2 py-1 bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-600 focus:border-gray-900 focus:outline-none rounded text-sm"
                placeholder="—"
                inputMode="decimal"
              />
              <input
                value={it.unit || ""}
                onChange={(e) => updateRow(idx, "unit", e.target.value)}
                className="col-span-2 px-2 py-1 bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-600 focus:border-gray-900 focus:outline-none rounded text-sm"
                placeholder="—"
                maxLength={20}
              />
              <div className="col-span-2 min-w-0">
                <input
                  value={it.category || ""}
                  onChange={(e) => updateRow(idx, "category", e.target.value)}
                  className="w-full px-2 py-1 bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-600 focus:border-gray-900 focus:outline-none rounded text-sm"
                  placeholder="—"
                  maxLength={60}
                />
                {/* Auto-detected pill shows beneath the editable input
                    when the supplier match attached a category. The
                    pill color encodes confidence; black text always.
                    L1 — gated to Starter+: Free users either don't get
                    a category_confidence at all (backend strips it) OR
                    we belt-and-braces hide the pill here so the layout
                    matches the upgrade nudge above. */}
                {supplierDetectionUnlocked &&
                  typeof it.category_confidence === "number" &&
                  it.category && (
                  <div className="px-2 -mt-0.5">
                    <CategoryPill
                      category={it.category}
                      confidence={it.category_confidence}
                      t={t}
                    />
                  </div>
                )}
              </div>
              <button
                onClick={() => removeRow(idx)}
                className="col-span-1 text-gray-400 hover:text-red-500 text-sm"
                aria-label={t("siRemoveRow", "Remove row")}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex justify-between items-center">
        <button
          onClick={onBack}
          disabled={committing}
          className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
        >
          ← {t("back", "Back")}
        </button>
        <button
          onClick={onCommit}
          disabled={committing || items.length === 0}
          className="px-4 py-2 bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition"
        >
          {committing ? t("siSaving", "Saving…") : t("siSaveItems", "Save {count} item(s)", { count: items.length })}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  const palette = {
    blue:   "bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200",
    green:  "bg-gray-50 dark:bg-gray-800/50 text-gray-800 dark:text-gray-200",
    purple: "bg-purple-50 dark:bg-purple-900/20 text-purple-800 dark:text-purple-200",
    amber:  "bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200",
  }[color] || "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300";
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${palette}`}>
      {label}: {value}
    </span>
  );
}
