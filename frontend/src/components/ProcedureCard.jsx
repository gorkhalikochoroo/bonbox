// ProcedureCard — Bogføringslovens § 6 procedurebeskrivelse (Audit-Tryg S2).
//
// REVIEW, not a form: BonBox pre-fills each skabelon point from the owner's
// OBSERVED data (backend GET /reports/procedure tags each point observed vs
// declare). The owner reads the document essentially as it will print, taps
// the pencil on any line to edit, then ONE primary action approves + saves.
// The PDF only ever builds from SAVED answers (backend enforces 404 on
// prefill-only), so the download button unlocks after godkendelse.
//
// Content is deliberately DANISH-ONLY (jurisdiction-language lock) — the
// answers ARE the legal document. Only UI chrome goes through t().
// Not tier-gated: a legal-duty document is the same for every tier
// (accountant-grade artifacts rule).

import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useLanguage } from "../hooks/useLanguage";
import { Button, SectionBanner, Icon } from "./ui";

export default function ProcedureCard() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null); // {points, sections, prefill, answers, saved_at}
  const [texts, setTexts] = useState({});
  const [editingKey, setEditingKey] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState("");
  const [savedAt, setSavedAt] = useState(null);

  const load = () => {
    setLoading(true);
    api
      .get("/reports/procedure")
      .then((res) => {
        const d = res.data || {};
        setData(d);
        setSavedAt(d.saved_at || null);
        const initial = {};
        for (const p of d.points || []) {
          initial[p.key] =
            (d.answers && d.answers[p.key]) ??
            (d.prefill?.[p.key]?.suggested || "");
        }
        setTexts(initial);
        setDirty(false);
      })
      .catch((e) => setErr(errText(e, t("prcLoadFailed", "Couldn't load the description"))))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open && !data) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sectionsInOrder = useMemo(() => {
    if (!data) return [];
    const bySection = {};
    for (const p of data.points || []) {
      (bySection[p.section] = bySection[p.section] || []).push(p);
    }
    return Object.keys(bySection)
      .sort()
      .map((id) => ({ id, title: data.sections?.[id] || id, points: bySection[id] }));
  }, [data]);

  const handleSave = async () => {
    setSaving(true);
    setErr("");
    try {
      const answers = {};
      for (const [k, v] of Object.entries(texts)) {
        if ((v || "").trim()) answers[k] = v.trim();
      }
      const res = await api.put("/reports/procedure", { answers });
      setSavedAt(res.data?.saved_at || new Date().toISOString());
      setDirty(false);
      setEditingKey(null);
    } catch (e) {
      setErr(errText(e, t("prcSaveFailed", "Couldn't save — try again")));
    }
    setSaving(false);
  };

  const handleDownload = async () => {
    setDownloading(true);
    setErr("");
    try {
      const res = await api.get("/reports/procedure/pdf", { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "procedurebeskrivelse-bonbox.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(errText(e, t("prcPdfFailed", "Couldn't generate the PDF")));
    }
    setDownloading(false);
  };

  const savedDateLabel = savedAt ? String(savedAt).slice(0, 10).split("-").reverse().join("-") : null;

  return (
    <div className="mt-8 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl">
      {/* Header row — always visible; the card collapses to one calm line. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-5 py-4 text-left"
      >
        <Icon name="ShieldCheck" size={18} className="text-gray-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t("prcTitle", "Procedurebeskrivelse")}
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {t("prcLegalChip", "Bogføringsloven § 6")}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
            {savedAt
              ? t("prcSubSaved", "Approved {date} — download anytime; update when your procedures change.").replace("{date}", savedDateLabel || "")
              : t("prcSubNew", "The written procedure description the law requires — BonBox pre-fills most of it from your own data.")}
          </p>
        </div>
        {savedAt && <Icon name="CheckCircle2" size={16} className="text-emerald-600 shrink-0" />}
        <Icon
          name="ChevronDown"
          size={16}
          className={`text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 dark:border-gray-700">
          {loading && (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4">{t("loading", "Loading…")}</p>
          )}

          {!loading && data && (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 leading-relaxed">
                {t(
                  "prcReviewHint",
                  "Review each point — lines marked “from your data” are read from how you actually use BonBox. Tap the pencil to adjust, then approve. The document is stored with your accounting material; it is your description, not legal advice."
                )}
              </p>

              {sectionsInOrder.map((sec) => (
                <div key={sec.id} className="mt-4">
                  <h3 className="text-[13px] font-semibold text-gray-900 dark:text-gray-100 mb-1">
                    {sec.title}
                  </h3>
                  <div className="space-y-2.5">
                    {sec.points.map((p) => {
                      const basis = data.prefill?.[p.key]?.basis;
                      const isEditing = editingKey === p.key;
                      return (
                        <div key={p.key} className="rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700/60 px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400 flex-1">
                              {p.label}
                            </span>
                            <span
                              className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                basis === "observed"
                                  ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                  : "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400"
                              }`}
                            >
                              {basis === "observed"
                                ? t("prcObservedBadge", "from your data")
                                : t("prcDeclareBadge", "fill in yourself")}
                            </span>
                            <button
                              type="button"
                              onClick={() => setEditingKey(isEditing ? null : p.key)}
                              aria-label={t("prcEditPoint", "Edit this point")}
                              className="p-2 -m-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                            >
                              <Icon name={isEditing ? "Check" : "Pencil"} size={13} />
                            </button>
                          </div>
                          {isEditing ? (
                            <textarea
                              value={texts[p.key] || ""}
                              onChange={(e) => {
                                setTexts((prev) => ({ ...prev, [p.key]: e.target.value }));
                                setDirty(true);
                              }}
                              rows={3}
                              maxLength={4000}
                              className="mt-1.5 w-full px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-200 leading-relaxed"
                              autoFocus
                            />
                          ) : (
                            <p className="mt-1 text-sm text-gray-800 dark:text-gray-200 leading-relaxed whitespace-pre-wrap">
                              {texts[p.key] || (
                                <span className="text-gray-400 italic">{t("prcEmptyPoint", "Left out of the document")}</span>
                              )}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="mt-5 flex flex-col sm:flex-row gap-2 sm:items-center">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={saving || (!dirty && !!savedAt)}
                  busy={saving}
                >
                  {saving
                    ? t("saving", "Saving…")
                    : savedAt && !dirty
                      ? t("prcApproved", "Approved")
                      : t("prcApproveSave", "Approve & save")}
                </Button>
                <Button
                  variant="accent"
                  onClick={handleDownload}
                  disabled={downloading || !savedAt || dirty}
                  busy={downloading}
                  iconLeft={!downloading && <Icon name="FileText" size={14} />}
                  title={
                    !savedAt || dirty
                      ? t("prcDownloadNeedsSave", "Approve & save first — the PDF is built from your approved text")
                      : ""
                  }
                >
                  {downloading ? t("generating", "Generating…") : t("prcDownloadPdf", "Download PDF")}
                </Button>
              </div>

              {err && (
                <div className="mt-3">
                  <SectionBanner severity="critical" title={err} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
