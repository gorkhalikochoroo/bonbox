/**
 * Kontrolmappe → Dokumenter (R1b): the venue's OWN papers — the
 * egenkontrolprogram, the risikoanalyse, the rengøringsplan, a hygiejnebevis
 * — kept in BonBox's private EU storage so they lie in the same place as the
 * readings. Shared by the owner (upload, mark reviewed, delete), a manager
 * (open only) and the paired kitchen iPad (open only).
 *
 * Honest: BonBox stores them; it does not read or approve them. Each row says
 * when it was uploaded and when it should be looked at again ("gennemgås
 * igen senest" = a year after the upload or the last review) — and NEVER
 * that a document is current or valid. A due or overdue review gets the amber
 * "Gennemgå igen". A hygiejnebevis does not expire (founder, 13 Nov 2026):
 * the server sends no review date for it (review_due null), so its row says
 * only "Uploadet …" and offers no "Markér som gennemgået".
 *
 * Opening: the bytes come through the tenant-checked proxy (owner session or
 * kitchen token, via the caller's loadDocument). An image opens in an overlay
 * from a blob URL; a PDF goes to utils/download.saveFile (the share sheet in
 * the app, a download on the web), and the row says what really happened.
 * Titles are typed text: shown as React text (escaped, verbatim).
 */
import { useEffect, useState } from "react";
import { CheckCircle2, FileText, Plus, Trash2 } from "lucide-react";
import Button from "../ui/Button";
import CheckStatusPill from "../ui/CheckStatusPill";
import { formatDateClear } from "../../utils/dateFormat";
import { saveFile } from "../../utils/download";
import { DOCUMENTS_MAX, docTypeLabel, safeFileTitle } from "./ekLogic";

const ROW_BTN =
  "min-h-14! px-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-[15px] font-semibold " +
  "text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50";

function ImageOverlay({ url, label, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-back-close=""
      data-testid="ek-doc-overlay"
    >
      <img src={url} alt={label} className="max-w-full max-h-full rounded-lg" />
    </div>
  );
}

export default function DocumentsSection({
  documents = [],
  max = DOCUMENTS_MAX,
  t,
  canManage = false,
  loadDocument = null,
  onAdd = null,
  onReviewed = null,
  onDelete = null,
  busyId = null,
}) {
  const docs = Array.isArray(documents) ? documents : [];
  const [outcome, setOutcome] = useState({}); // id → i18n key
  const [opening, setOpening] = useState(null);
  const [image, setImage] = useState(null); // { url, label }

  useEffect(
    () => () => {
      if (image?.url) {
        try { URL.revokeObjectURL(image.url); } catch { /* noop */ }
      }
    },
    [image],
  );

  const open = async (doc) => {
    if (!loadDocument || opening) return;
    setOpening(doc.id);
    setOutcome((o) => ({ ...o, [doc.id]: null }));
    let blob;
    try {
      blob = await loadDocument(doc);
    } catch {
      setOutcome((o) => ({ ...o, [doc.id]: "ekDocOpenFailed" }));
      setOpening(null);
      return;
    }
    const type = doc.content_type || blob?.type || "";
    if (type.startsWith("image/") && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && blob) {
      setImage({ url: URL.createObjectURL(blob), label: doc.title });
      setOpening(null);
      return;
    }
    const ext = type.startsWith("image/") ? "jpg" : "pdf";
    const res = await saveFile(blob, `${safeFileTitle(doc.title)}.${ext}`, {
      type: type || "application/pdf",
      title: doc.title,
      preferShare: true,
    });
    setOutcome((o) => ({
      ...o,
      [doc.id]: res?.ok ? (res.channel === "share" ? "ekDocShared" : "ekDocDownloaded") : "ekDocOpenFailed",
    }));
    setOpening(null);
  };

  return (
    <section className="mt-5" data-testid="ek-folder-documents">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t("ekDocsTitle")}</h3>
        {canManage && onAdd ? (
          <Button
            variant="secondary"
            className="h-10"
            onClick={onAdd}
            disabled={docs.length >= max}
            iconLeft={<Plus className="w-4 h-4" aria-hidden="true" />}
            data-testid="ek-doc-add"
          >
            {t("ekDocAdd")}
          </Button>
        ) : null}
      </div>
      <p className="text-[14px] text-gray-600 dark:text-gray-400 mb-2" data-testid="ek-docs-honest">{t("ekDocsHonest")}</p>
      {docs.length === 0 ? (
        <p className="text-[15px] text-gray-600 dark:text-gray-400" data-testid="ek-docs-empty">{t("ekDocsEmpty")}</p>
      ) : (
        <ul className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800">
          {docs.map((d) => {
            const due = d.review_state === "soon" || d.review_state === "overdue";
            const hasReview = typeof d.review_due === "string" && d.review_due !== "";
            return (
              <li key={d.id} className="px-4 py-3 min-h-14" data-testid={`ek-doc-${d.id}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <button
                    type="button"
                    onClick={() => open(d)}
                    disabled={!loadDocument || opening === d.id}
                    className="min-h-14! min-w-0 flex-1 text-left inline-flex items-start gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-60"
                    data-testid="ek-doc-open"
                  >
                    <FileText className="w-5 h-5 mt-0.5 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        {docTypeLabel(d.doc_type, t)}
                      </span>
                      <span className="block text-[16px] font-semibold text-gray-900 dark:text-gray-100 break-words">{d.title}</span>
                      <span className="block text-[14px] text-gray-600 dark:text-gray-400" data-testid="ek-doc-dates">
                        {hasReview
                          ? t("ekDocUploadedReview", {
                              uploaded: formatDateClear(d.uploaded_local_date || ""),
                              due: formatDateClear(d.review_due),
                            })
                          : t("ekDocUploaded", { uploaded: formatDateClear(d.uploaded_local_date || "") })}
                      </span>
                    </span>
                  </button>
                  {due && hasReview ? (
                    <span className="shrink-0 self-center">
                      <CheckStatusPill tone="warn">{t("ekDocReviewAgain")}</CheckStatusPill>
                    </span>
                  ) : null}
                </div>
                {outcome[d.id] ? (
                  <p role="status" className="mt-1 text-[14px] text-gray-700 dark:text-gray-300">{t(outcome[d.id])}</p>
                ) : null}
                {canManage ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {onReviewed && hasReview ? (
                      <button type="button" className={ROW_BTN} onClick={() => onReviewed(d)} disabled={busyId === d.id} data-testid="ek-doc-reviewed">
                        <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                        {t("ekDocMarkReviewed")}
                      </button>
                    ) : null}
                    {onDelete ? (
                      <button
                        type="button"
                        className={ROW_BTN + " text-red-700! dark:text-red-400!"}
                        onClick={() => onDelete(d)}
                        disabled={busyId === d.id}
                        data-testid="ek-doc-delete"
                      >
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                        {t("ekDocDelete")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {image ? <ImageOverlay url={image.url} label={image.label} onClose={() => setImage(null)} /> : null}
    </section>
  );
}
