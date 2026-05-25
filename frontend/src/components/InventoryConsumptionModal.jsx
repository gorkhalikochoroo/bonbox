/**
 * InventoryConsumptionModal — Smart Inventory editor for an item's
 * consumption metadata (pattern + serving size + usage keywords).
 *
 * This is the UI for the "smart inventory able to detect items and
 * how they will be using" requirement: every item's consumption shape
 * differs (per dish, per service, per pour), so the owner configures
 * each one and the AI uses that config to:
 *   • Auto-decrement stock when matching sales fire (Phase 3)
 *   • Predict reorder timing accurately
 *   • Spot waste (actual vs predicted depletion)
 *
 * Multi-layer security inherited from the backend:
 *   • Auth-gated endpoints (Depends(get_current_user))
 *   • Tenant-scoped service queries
 *   • All inputs revalidated server-side; UI is convenience, not gate
 *
 * UX shape:
 *   • Pattern picker (per_unit / per_serving / per_pour / per_dish /
 *     per_service / per_use)
 *   • Serving-size input + consumption-unit input (paired: "20 g")
 *   • Usage-keywords textarea (comma-separated)
 *   • Live preview: "your keywords would catch THESE sales" — calls
 *     /inventory/match-sale on a sample input the owner types
 *   • Live depletion estimate: "at current sales velocity, ~12 days
 *     of stock left"
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useSmartTelemetry } from "../hooks/useSmartTelemetry";
import { useUndoToast } from "../hooks/useUndoToast";


const PATTERNS = [
  { id: "per_unit",    label: { en: "Per unit (default)",      da: "Per enhed (standard)" } },
  { id: "per_serving", label: { en: "Per serving",             da: "Per servering" } },
  { id: "per_pour",    label: { en: "Per pour (drinks)",       da: "Per skænk (drikke)" } },
  { id: "per_dish",    label: { en: "Per dish (ingredient)",   da: "Per ret (ingrediens)" } },
  { id: "per_service", label: { en: "Per service (salon/shop)",da: "Per service (salon/værksted)" } },
  { id: "per_use",     label: { en: "Per use (consumable)",    da: "Per brug (forbrugsvare)" } },
];


export default function InventoryConsumptionModal({ open, onClose, itemId, itemName }) {
  const { t, lang } = useLanguage();
  const { track } = useSmartTelemetry();
  const { show: showUndo, ToastUI } = useUndoToast();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pattern, setPattern] = useState("");
  const [unit, setUnit] = useState("");
  const [servingSize, setServingSize] = useState("");
  const [keywords, setKeywords] = useState("");
  const [daysLeft, setDaysLeft] = useState(null);
  const [previewQuery, setPreviewQuery] = useState("");
  const [previewMatches, setPreviewMatches] = useState([]);
  // Snapshot of the item's prior config — captured on modal open so a
  // post-save undo toast can revert without a stale-data race.
  const [priorConfig, setPriorConfig] = useState(null);
  // Suggestion-first state. When `suggestion` is non-null AND the
  // item has no existing config, we render the simple "looks right?"
  // view. Owner can switch to the form via "Edit details".
  const [suggestion, setSuggestion] = useState(null);
  const [showForm, setShowForm] = useState(false);

  // Load existing config + suggestion when modal opens.
  useEffect(() => {
    if (!open || !itemId) return;
    let alive = true;
    setLoading(true);
    setError("");
    Promise.all([
      api.get(`/inventory/${itemId}/consumption`).catch(() => ({ data: {} })),
      api.get(`/inventory/${itemId}/usage-suggestion`).catch(() => ({ data: null })),
    ]).then(([cfgRes, sugRes]) => {
      if (!alive) return;
      const d = cfgRes.data || {};
      setPattern(d.consumption_pattern || "");
      setUnit(d.consumption_unit || "");
      setServingSize(d.serving_size != null ? String(d.serving_size) : "");
      setKeywords(d.usage_keywords || "");
      setDaysLeft(d.days_until_depletion);
      // Snapshot the prior config so undo can revert it cleanly even
      // after the user typed in the form.
      setPriorConfig({
        consumption_pattern: d.consumption_pattern || "",
        consumption_unit: d.consumption_unit || "",
        serving_size: d.serving_size != null ? Number(d.serving_size) : null,
        usage_keywords: d.usage_keywords || "",
      });
      setSuggestion(sugRes.data);
      track("smart_proposal_viewed", "smart_inventory", {
        confidence: sugRes.data?.confidence,
        had_existing: !!d.consumption_pattern,
      });
      // If there's no existing config, default to the suggestion view.
      // Otherwise jump straight to the form so power users can edit.
      const hasExisting = !!d.consumption_pattern;
      setShowForm(hasExisting);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  // ESC closes (mirrors ReceiptViewer pattern).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const labelFor = (label) => (label && (label[lang] || label.en)) || "";

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await api.patch(`/inventory/${itemId}/consumption`, {
        consumption_pattern: pattern || "",
        consumption_unit: unit || "",
        serving_size: servingSize === "" ? null : Number(servingSize),
        usage_keywords: keywords,
      });
      setDaysLeft(res.data.days_until_depletion);
      track("smart_proposal_edited", "smart_inventory", {
        confidence: suggestion?.confidence,
      });
      // Undo: re-PATCH with the snapshot we took on modal open.
      const onUndo = priorConfig
        ? async () => { await api.patch(`/inventory/${itemId}/consumption`, priorConfig); }
        : null;
      showUndo({
        message: t("inventoryConsumptionSavedToast") || "Updated this item's usage",
        onUndo,
      });
      onClose?.();
    } catch (err) {
      setError(err.response?.data?.detail || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    if (!previewQuery.trim()) {
      setPreviewMatches([]);
      return;
    }
    try {
      const res = await api.get("/inventory/match-sale", {
        params: { sale_item_name: previewQuery },
      });
      setPreviewMatches(res.data || []);
    } catch {
      setPreviewMatches([]);
    }
  };

  if (!open) return null;

  return (
    <>
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-lg w-full max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700/60 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t("inventoryConsumptionTitle") || "Smart usage"}
            </h2>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {itemName}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t("close") || "Close"}
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 w-8 h-8 inline-flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <div className="text-sm text-gray-500">{t("loading") || "Loading…"}</div>
          ) : (
            <>
              {/* Suggestion-first view — when we recognise the item +
                  the owner hasn't configured it yet, show a clean
                  "looks right ✓" card. The form is collapsed below
                  as 'edit details'. */}
              {!showForm && suggestion && (
                <div className="space-y-3">
                  <div className={`rounded-lg p-3 text-sm ${
                    suggestion.confidence === "high"
                      ? "bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/50"
                      : suggestion.confidence === "medium"
                        ? "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50"
                        : "bg-gray-50 dark:bg-gray-700/30 border border-gray-200 dark:border-gray-600"
                  }`}>
                    <div className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
                      {suggestion.confidence === "low"
                        ? (t("inventoryConsumptionUnrecognisedTitle") || "Not in our recipe library yet")
                        : (t("inventoryConsumptionRecognised") || "We recognise this item")}
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 mt-1 leading-snug">
                      {suggestion.reasoning}
                    </div>
                  </div>

                  <div className="text-[13px] text-gray-700 dark:text-gray-200 leading-relaxed">
                    <div className="flex items-start gap-2">
                      <span className="text-gray-400 shrink-0 w-20">{t("inventoryConsumptionShape") || "Shape"}:</span>
                      <span className="font-medium">
                        {Number(suggestion.serving_size)} {suggestion.consumption_unit}
                        {" "}{(t("inventoryConsumptionPerEach") || "per each").replace("{kind}", suggestion.consumption_pattern.replace("per_", ""))}
                      </span>
                    </div>
                    {suggestion.usage_keywords && (
                      <div className="flex items-start gap-2 mt-1">
                        <span className="text-gray-400 shrink-0 w-20">{t("inventoryConsumptionMatches") || "Matches"}:</span>
                        <span>{suggestion.usage_keywords.split(",").join(" · ")}</span>
                      </div>
                    )}
                    {suggestion.matching_sales_preview?.length > 0 && (
                      <div className="flex items-start gap-2 mt-1">
                        <span className="text-gray-400 shrink-0 w-20">{t("inventoryConsumptionWouldCatch") || "Would catch"}:</span>
                        <span className="text-gray-700 dark:text-gray-300">
                          {suggestion.matching_sales_preview.join(", ")}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={async () => {
                        setSaving(true);
                        setError("");
                        try {
                          await api.patch(`/inventory/${itemId}/consumption`, {
                            consumption_pattern: suggestion.consumption_pattern,
                            consumption_unit: suggestion.consumption_unit,
                            serving_size: suggestion.serving_size,
                            usage_keywords: suggestion.usage_keywords,
                          });
                          track("smart_proposal_accepted", "smart_inventory", {
                            confidence: suggestion?.confidence,
                          });
                          // Undo: re-PATCH the prior config snapshot.
                          const onUndo = priorConfig
                            ? async () => { await api.patch(`/inventory/${itemId}/consumption`, priorConfig); }
                            : null;
                          showUndo({
                            message: t("inventoryConsumptionSavedToast") || "Updated this item's usage",
                            onUndo,
                          });
                          onClose?.();
                        } catch (err) {
                          setError(err.response?.data?.detail || "Couldn't save.");
                        } finally {
                          setSaving(false);
                        }
                      }}
                      disabled={saving || suggestion.confidence === "low"}
                      className="px-4 py-2 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold disabled:opacity-50 transition flex-1"
                    >
                      {suggestion.confidence === "low"
                        ? (t("inventoryConsumptionUnknownItem") || "We don't recognise this — edit details")
                        : (saving
                            ? (t("saving") || "Saving…")
                            : (t("inventoryConsumptionSaveAction") || "Save · {kind}").replace(
                                "{kind}",
                                `${Number(suggestion.serving_size)} ${suggestion.consumption_unit} per ${suggestion.consumption_pattern.replace("per_", "")}`,
                              ))}
                    </button>
                    <button
                      onClick={() => setShowForm(true)}
                      className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                    >
                      {t("smartStaffingEdit") || "Edit details"}
                    </button>
                  </div>

                  {error && (
                    <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
                  )}
                </div>
              )}

              {/* Form view — shown when owner clicked "Edit details" OR
                  when an existing config exists (so they can revise). */}
              {showForm && (
              <>
              {/* Pattern picker */}
              <div>
                <label className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                  {t("inventoryConsumptionPattern") || "How is this used?"}
                </label>
                <select
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-gray-900"
                >
                  <option value="">— {t("inventoryConsumptionPick") || "pick one"} —</option>
                  {PATTERNS.map((p) => (
                    <option key={p.id} value={p.id}>{labelFor(p.label)}</option>
                  ))}
                </select>
              </div>

              {/* Serving size + unit (paired) */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                    {t("inventoryConsumptionServingSize") || "Serving size"}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={servingSize}
                    onChange={(e) => setServingSize(e.target.value)}
                    placeholder="20"
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-gray-900"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                    {t("inventoryConsumptionUnit") || "Unit"}
                  </label>
                  <input
                    type="text"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value.toLowerCase())}
                    placeholder="g"
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-gray-900"
                  />
                </div>
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 -mt-2">
                {t("inventoryConsumptionExample") ||
                  "Example: 20 g of coffee beans per espresso → serving size 20, unit g"}
              </div>

              {/* Usage keywords */}
              <div>
                <label className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                  {t("inventoryConsumptionKeywords") || "Sale keywords (comma-separated)"}
                </label>
                <textarea
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value.slice(0, 500))}
                  rows={2}
                  placeholder="espresso, cappuccino, latte, americano"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-gray-900 resize-none"
                />
                <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-snug">
                  {t("inventoryConsumptionKeywordsHelp") ||
                    "When a sale's name contains any of these, this item's stock auto-decrements. Min 2 chars per keyword."}
                </div>
              </div>

              {/* Live preview */}
              <div className="border-t border-gray-100 dark:border-gray-700/60 pt-3">
                <label className="block text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">
                  {t("inventoryConsumptionPreviewLabel") || "Test against a sale name"}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={previewQuery}
                    onChange={(e) => setPreviewQuery(e.target.value)}
                    placeholder="e.g. Espresso doppio"
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-gray-900"
                  />
                  <button
                    type="button"
                    onClick={runPreview}
                    className="px-3 py-2 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
                  >
                    {t("inventoryConsumptionTest") || "Test"}
                  </button>
                </div>
                {previewMatches.length > 0 && (
                  <div className="mt-2 text-[11px] text-gray-700 dark:text-gray-300">
                    ✓ {(t("inventoryConsumptionMatchHint") || "Would match: {names}")
                      .replace("{names}", previewMatches.map((m) => m.name).join(", "))}
                  </div>
                )}
              </div>

              {/* Depletion estimate */}
              {daysLeft != null && (
                <div className="rounded-lg bg-blue-50 dark:bg-blue-900/30 px-3 py-2 text-xs text-blue-800 dark:text-blue-200">
                  {(t("inventoryConsumptionDaysLeft") || "~{n} days of stock at current pace")
                    .replace("{n}", String(daysLeft))}
                </div>
              )}

              {error && (
                <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
              )}
              </>
              )}
            </>
          )}
        </div>

        {/* Footer — only when in form mode (suggestion view has its
            own action buttons inline so the modal feels lighter). */}
        {showForm && (
          <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
            >
              {t("cancel") || "Cancel"}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="px-4 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold disabled:opacity-50 transition"
            >
              {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
            </button>
          </div>
        )}
      </div>
    </div>
    {ToastUI}
    </>
  );
}
