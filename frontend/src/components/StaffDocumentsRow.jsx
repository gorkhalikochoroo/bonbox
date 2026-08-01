/**
 * StaffDocumentsRow — the owner shares employment documents with one staffer.
 *
 * The other half of the portal's DocumentsSection. The owner uploads a
 * contract/addendum/certificate; the staffer reads it in their portal behind
 * the PIN.
 *
 * Notes that shaped it:
 *  • The label is REQUIRED and asked for up front. A list of "scan_0012.pdf"
 *    is useless to the person receiving it, and the server refuses a blank one.
 *  • Type and size are validated server-side from magic bytes — the accept=""
 *    below is a convenience for the file picker, never the check.
 *  • Removal confirms, because the staffer loses access the moment it happens
 *    and they are not the one clicking.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";

import api from "../services/api";
import { useConfirm } from "../hooks/useConfirm";
import { useLanguage } from "../hooks/useLanguage";

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export default function StaffDocumentsRow({ memberId, labelCls }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const [docs, setDocs] = useState([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    api.get(`/staff/members/${memberId}/documents`)
      .then((r) => setDocs(r.data || []))
      .catch(() => setDocs([]));
  }, [memberId]);

  useEffect(() => { load(); }, [load]);

  const messageFor = (e) => {
    const code = e?.response?.data?.detail?.code;
    const map = {
      empty: t("staffDocsErrEmpty", "That file is empty."),
      too_large: t("staffDocsErrTooLarge", "File must be under 10 MB."),
      unsupported_type: t("staffDocsErrType", "Only PDF, JPEG and PNG files are accepted."),
      label_missing: t("staffDocsErrLabel", "Give the document a name first."),
    };
    return map[code] || t("staffDocsErrGeneric", "Couldn't upload that document.");
  };

  const pick = () => {
    if (!label.trim()) {
      setErr(t("staffDocsErrLabel", "Give the document a name first."));
      return;
    }
    setErr("");
    fileRef.current?.click();
  };

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";                    // allow re-picking the same file
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const fd = new FormData();
      fd.append("label", label.trim());
      fd.append("file", file);
      await api.post(`/staff/members/${memberId}/documents`, fd);
      setLabel("");
      load();
    } catch (e2) {
      setErr(messageFor(e2));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (doc) => {
    const yes = await confirm({
      title: t("staffDocsRemoveTitle", "Remove document?"),
      message: t("staffDocsRemoveBody", "“{label}” will no longer be visible to them.", { label: doc.label }),
      confirmLabel: t("remove", "Remove"),
      destructive: true,
    });
    if (!yes) return;
    setBusy(true); setErr("");
    try {
      await api.delete(`/staff/documents/${doc.id}`);
      load();
    } catch {
      setErr(t("staffDocsRemoveFailed", "Couldn't remove that document."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sm:col-span-2">
      <span className={labelCls}>
        <span className="inline-flex items-center gap-1.5">
          <FileText className="w-3 h-3" /> {t("staffDocsLabel", "Contract & documents")}
        </span>
      </span>

      {docs.length > 0 && (
        <div className="mt-1 space-y-1">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800">
              <FileText className="w-3.5 h-3.5 shrink-0 text-gray-400" />
              <span className="flex-1 min-w-0 text-[13px] text-gray-900 dark:text-gray-100 truncate">{d.label}</span>
              <span className="shrink-0 text-[11px] text-gray-400 tabular-nums">{fmtSize(d.size_bytes)}</span>
              <button
                type="button"
                onClick={() => remove(d)}
                disabled={busy}
                aria-label={`${t("remove", "Remove")} — ${d.label}`}
                className="shrink-0 p-1 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("staffDocsNamePlaceholder", "e.g. Ansættelseskontrakt 2026")}
          className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-[13px] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-900/30"
        />
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 transition disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {t("staffDocsUpload", "Upload")}
        </button>
        {/* accept= is a picker convenience only — the real check is magic-bytes
            sniffing server-side, because a renamed file passes any accept list. */}
        <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={upload} className="hidden" />
      </div>

      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
      <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
        {t("staffDocsHint", "They can download these in their portal. PDF, JPEG or PNG, up to 10 MB.")}
      </p>
    </div>
  );
}
