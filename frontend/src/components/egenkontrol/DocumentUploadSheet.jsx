/**
 * "Tilføj dokument" — the owner adds one of the venue's own papers to the
 * Kontrolmappe (R1b, owner only; the server 403s every other seat and a
 * curtained shared device needs the reveal PIN).
 *
 * Type chips (Egenkontrolprogram / Risikoanalyse / Rengøringsplan /
 * Hygiejnebevis / Andet dokument), a title prefilled with the type's name
 * (editable, at most 120 characters — refused by the server if longer, never
 * cut), and the file: a PDF or a photo (JPEG / PNG). No `capture` attribute:
 * the phone offers both the file picker and the camera. The server sniffs
 * the bytes (never the file name), strips a photo's EXIF / GPS and keeps the
 * file in BonBox's private EU storage; it is opened only through BonBox.
 */
import { useState } from "react";
import { X } from "lucide-react";
import Sheet from "../ui/Sheet";
import Button from "../ui/Button";
import Chip from "../ui/Chip";
import api from "../../services/api";
import { DOCUMENT_TITLE_MAX, DOC_TYPES, EK_ERROR_KEYS, docTypeLabel, errorCode } from "./ekLogic";

const FIELD =
  "w-full h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 text-[15px] " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400";
const LABEL = "block text-[13.5px] font-semibold text-gray-800 dark:text-gray-200 mb-1";

export default function DocumentUploadSheet({ onSaved, onClose, t }) {
  const [docType, setDocType] = useState("programme");
  const [title, setTitle] = useState(() => docTypeLabel("programme", t));
  const [touched, setTouched] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pickType = (code) => {
    setDocType(code);
    if (!touched) setTitle(docTypeLabel(code, t));
  };

  const valid = !!file && title.trim().length > 0 && title.length <= DOCUMENT_TITLE_MAX;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file, file.name || "dokument");
      // The title as typed (verbatim); the server refuses blank or > 120.
      form.append("title", title);
      form.append("doc_type", docType);
      const res = await api.post("/egenkontrol/documents", form, { timeout: 120000 });
      onSaved?.(res?.data || null);
    } catch (err) {
      const status = err?.response?.status;
      const code = errorCode(err);
      if (status === 413 || code === "too_large") setError(t("ekErrDocTooLarge"));
      else if (code && EK_ERROR_KEYS[code]) setError(t(EK_ERROR_KEYS[code]));
      else setError(t("ekErrSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} ariaLabel={t("ekDocAdd")} panelClassName="bg-white dark:bg-gray-900 border-t sm:border border-gray-200 dark:border-gray-700">
      <div className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-gray-100 dark:border-gray-800">
        <h2 className="min-w-0 flex-1 text-[17px] font-semibold text-gray-900 dark:text-gray-50">{t("ekDocAdd")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          className="shrink-0 w-10 h-10 -mr-2 inline-flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4" data-testid="ek-doc-upload">
        <p className="text-[13.5px] text-gray-600 dark:text-gray-400">{t("ekDocsHonest")}</p>
        <fieldset>
          <legend className={LABEL}>{t("ekDocTypeLabel")}</legend>
          <div className="flex flex-wrap gap-2">
            {DOC_TYPES.map((code) => (
              <Chip key={code} className="h-10" selected={docType === code} onClick={() => pickType(code)}>
                {docTypeLabel(code, t)}
              </Chip>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="ek-doc-title" className={LABEL}>{t("ekDocTitleLabel")}</label>
          <input
            id="ek-doc-title"
            className={FIELD}
            value={title}
            maxLength={DOCUMENT_TITLE_MAX}
            onChange={(e) => {
              setTouched(true);
              setTitle(e.target.value);
            }}
          />
          <p className="mt-1 text-[12.5px] text-gray-500 dark:text-gray-400 font-display tabular-nums" aria-live="polite">
            {title.length}/{DOCUMENT_TITLE_MAX}
          </p>
        </div>
        <div>
          <label htmlFor="ek-doc-file" className={LABEL}>{t("ekDocFileLabel")}</label>
          <input
            id="ek-doc-file"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            className="block w-full text-[14px] text-gray-800 dark:text-gray-200 file:mr-3 file:h-10 file:px-3 file:rounded-lg file:border file:border-gray-300 dark:file:border-gray-600 file:bg-white dark:file:bg-gray-900 file:text-[14px] file:font-semibold"
            onChange={(e) => setFile((e.target.files && e.target.files[0]) || null)}
            data-testid="ek-doc-file"
          />
          <p className="mt-1 text-[12.5px] text-gray-500 dark:text-gray-400">{t("ekDocFileHelp")}</p>
        </div>
      </div>
      <div className="px-4 sm:px-5 pt-3 pb-4 border-t border-gray-100 dark:border-gray-800" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))" }}>
        {error ? <p role="alert" className="mb-2 text-[13.5px] text-red-700 dark:text-red-400">{error}</p> : null}
        <Button variant="primary" className="h-10" busy={busy} disabled={!valid || busy} onClick={save} data-testid="ek-doc-save">
          {t("ekDocSave")}
        </Button>
      </div>
    </Sheet>
  );
}
