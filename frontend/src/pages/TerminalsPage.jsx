import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn } from "../components/AnimationKit";

/**
 * Terminals settings — owners configure their physical POS stations here.
 *
 * For Mirabelle-type restaurants with 4 terminals (front bar, back bar,
 * terrace, takeaway), each one needs to exist as a row before the
 * multi-terminal daily-close flow can use it. The closer scans 4
 * kasserapports — one per terminal — and the aggregator sums them.
 *
 * Capability flags determine which payment-method scan slots appear on
 * each terminal's portion of the close screen. Mirabelle's Excel had
 * Amex rows full of zeros for 3 of 4 terminals — we hide those upfront
 * so the closer doesn't see irrelevant fields.
 *
 * receipt_label is the future auto-routing key: when the OCR detects
 * "Term 2" on a kasserapport image, it can match to the terminal whose
 * receipt_label="Term 2" automatically, saving the closer a tap.
 */

const _DEFAULT_FORM = {
  name: "",
  branch_id: null,
  display_order: 0,
  accepts_dankort: true,
  accepts_mobilepay: true,
  accepts_amex: false,
  receipt_label: "",
};


export default function TerminalsPage() {
  const { t } = useLanguage();
  const [terminals, setTerminals] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | terminal_id
  const [form, setForm] = useState(_DEFAULT_FORM);
  const [saving, setSaving] = useState(false);

  const isMultiBranch = branches.length > 1;

  useEffect(() => {
    void Promise.all([fetchTerminals(), fetchBranches()]);
  }, []);

  async function fetchTerminals() {
    setLoading(true);
    try {
      const res = await api.get("/terminals");
      setTerminals(Array.isArray(res.data) ? res.data : []);
      setError("");
    } catch (err) {
      setError(errText(err, t("terminalsLoadFailed") || "Could not load terminals"));
    } finally {
      setLoading(false);
    }
  }

  async function fetchBranches() {
    try {
      const res = await api.get("/branches");
      setBranches(Array.isArray(res.data) ? res.data : []);
    } catch {
      // Single-branch users may not have the branches endpoint populated
      setBranches([]);
    }
  }

  function startNew() {
    setEditing("new");
    setForm({ ..._DEFAULT_FORM, display_order: terminals.length });
  }

  function startEdit(term) {
    setEditing(term.id);
    setForm({
      name: term.name,
      branch_id: term.branch_id || null,
      display_order: term.display_order ?? 0,
      accepts_dankort: !!term.accepts_dankort,
      accepts_mobilepay: !!term.accepts_mobilepay,
      accepts_amex: !!term.accepts_amex,
      receipt_label: term.receipt_label || "",
    });
  }

  function cancel() {
    setEditing(null);
    setForm(_DEFAULT_FORM);
    setError("");
  }

  async function save() {
    if (!form.name.trim()) {
      setError(t("terminalNameRequired") || "Name is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: form.name.trim(),
        branch_id: form.branch_id || null,
        display_order: Number(form.display_order) || 0,
        accepts_dankort: form.accepts_dankort,
        accepts_mobilepay: form.accepts_mobilepay,
        accepts_amex: form.accepts_amex,
        receipt_label: form.receipt_label?.trim() || null,
      };
      if (editing === "new") {
        await api.post("/terminals", payload);
      } else {
        await api.put(`/terminals/${editing}`, payload);
      }
      await fetchTerminals();
      cancel();
    } catch (err) {
      // P5 — Free tier is capped at 1 terminal; backend returns a
      // structured 402 with upgrade_to. Surface a calm "upgrade for
      // multi-POS" message instead of [object Object].
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      if (status === 402 && detail && typeof detail === "object") {
        const upgradeTo = detail.upgrade_to || "pro";
        const planLabel = upgradeTo === "pro" ? "Pro" : "Starter";
        setError(t("terminalsFreeOneCap", { planLabel }));
      } else {
        const detailMsg = typeof detail === "string" ? detail : null;
        setError(detailMsg || t("terminalSaveFailed") || "Could not save terminal");
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(term) {
    if (!window.confirm(
      (t("terminalConfirmDelete") || "Delete terminal {name}? Past closes are preserved.")
        .replace("{name}", term.name),
    )) {
      return;
    }
    try {
      await api.delete(`/terminals/${term.id}`);
      await fetchTerminals();
    } catch (err) {
      setError(errText(err, t("terminalDeleteFailed") || "Could not delete"));
    }
  }

  const branchName = useMemo(
    () => Object.fromEntries((branches || []).map((b) => [b.id, b.name])),
    [branches],
  );

  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto">
      <FadeIn>
        <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              💳 {t("terminalsPageTitle") || "POS Terminals"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xl">
              {t("terminalsPageSubtitle") ||
                "Each physical till station you close out at end of night. Takes 30 seconds to set up — once."}
            </p>
          </div>
          {!editing && (
            <button
              onClick={startNew}
              className="px-4 py-2 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition shrink-0"
            >
              + {t("addTerminal") || "Add terminal"}
            </button>
          )}
        </div>
      </FadeIn>

      {/* "How this works" 3-step explainer — only shows while the
          owner is still figuring it out (≤1 terminal configured).
          Once they have ≥2 terminals they've clearly got the model,
          and the panel just clutters the page so we hide it. */}
      {!loading && terminals.length <= 1 && !editing && (
        <FadeIn delay={0.02}>
          <details
            open={terminals.length === 0}
            className="mt-4 mb-2 bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl group"
          >
            <summary className="cursor-pointer px-5 py-3 text-[13px] font-semibold text-gray-800 dark:text-gray-200 flex items-center justify-between list-none">
              <span className="flex items-center gap-2">
                <span className="text-base">💡</span>
                {t("terminalsHowTitle") || "How this works"}
              </span>
              <span className="text-gray-400 transition-transform group-open:rotate-180">▾</span>
            </summary>
            <div className="px-5 pb-5 grid sm:grid-cols-3 gap-4 sm:gap-5 border-t border-gray-100 dark:border-gray-700/60 pt-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                  {t("terminalsHowStep1Tag") || "Step 1 (one-time)"}
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1">
                  {t("terminalsHowStep1Title") || "List your terminals here"}
                </div>
                <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                  {t("terminalsHowStep1Body") ||
                    "One row per physical till — front bar, terrace, takeaway window, etc. Set the payment methods each one takes."}
                </div>
              </div>
              <div className="sm:border-l sm:border-gray-200 sm:dark:border-gray-700 sm:pl-5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                  {t("terminalsHowStep2Tag") || "Step 2 (every night)"}
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1">
                  {t("terminalsHowStep2Title") || "Snap each kasserapport"}
                </div>
                <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                  {t("terminalsHowStep2Body") ||
                    "Open the daily close, photograph each terminal's printed totals receipt. AI reads Dankort, MobilePay, cash, and the rest in ~6 seconds."}
                </div>
              </div>
              <div className="sm:border-l sm:border-gray-200 sm:dark:border-gray-700 sm:pl-5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-gray-300">
                  {t("terminalsHowStep3Tag") || "Step 3 (automatic)"}
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1">
                  {t("terminalsHowStep3Title") || "BonBox merges them into one close"}
                </div>
                <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                  {t("terminalsHowStep3Body") ||
                    "All terminals roll up to a single daily total. Cash difference flagged. Send the consolidated PDF to owner or revisor in one tap."}
                </div>
              </div>
            </div>
          </details>
        </FadeIn>
      )}

      {/* Inline editor — sits above the list when active so the user
          sees their changes appear in context */}
      {editing && (
        <FadeIn>
          <div className="mt-5 mb-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6 shadow-sm">
            <h2 className="text-base font-bold text-gray-900 dark:text-white mb-4">
              {editing === "new"
                ? (t("addTerminal") || "Add terminal")
                : (t("editTerminal") || "Edit terminal")}
            </h2>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                  {t("terminalName") || "Name"}
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t("terminalNameExample") || "e.g. Front bar, Terrace, Takeaway"}
                  maxLength={80}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 focus:ring-2 focus:ring-gray-200 dark:focus:ring-green-700 outline-none"
                />
              </div>

              {/* Branch (only when multi-branch) */}
              {isMultiBranch && (
                <div>
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                    {t("branch") || "Branch"}
                  </label>
                  <select
                    value={form.branch_id || ""}
                    onChange={(e) => setForm({ ...form, branch_id: e.target.value || null })}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                  >
                    <option value="">— {t("notLinkedToBranch") || "not linked to a branch"} —</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Capability flags */}
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2 block">
                  {t("paymentMethodsAccepted") || "Payment methods this terminal accepts"}
                </label>
                <div className="flex flex-wrap gap-3">
                  <CapabilityToggle
                    label="Dankort"
                    checked={form.accepts_dankort}
                    onChange={(v) => setForm({ ...form, accepts_dankort: v })}
                  />
                  <CapabilityToggle
                    label="MobilePay"
                    checked={form.accepts_mobilepay}
                    onChange={(v) => setForm({ ...form, accepts_mobilepay: v })}
                  />
                  <CapabilityToggle
                    label="Amex"
                    checked={form.accepts_amex}
                    onChange={(v) => setForm({ ...form, accepts_amex: v })}
                  />
                </div>
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
                  {t("paymentMethodsHint") ||
                    "Hidden methods won't appear as scan slots in the daily close — keeps the form clean."}
                </p>
              </div>

              {/* Receipt label — advanced */}
              <details className="rounded-lg border border-gray-100 dark:border-gray-700/40 px-3 py-2">
                <summary className="text-xs font-semibold text-gray-600 dark:text-gray-400 cursor-pointer">
                  {t("advancedSettings") || "Advanced"}
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">
                      {t("receiptLabel") || "Receipt label (auto-routing)"}
                    </label>
                    <input
                      type="text"
                      value={form.receipt_label}
                      onChange={(e) => setForm({ ...form, receipt_label: e.target.value })}
                      placeholder={t("receiptLabelExample") || "e.g. Term 2, Terminal A"}
                      maxLength={40}
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                    />
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
                      {t("receiptLabelHint") ||
                        "Optional. If the OCR sees this exact text on a kasserapport, BonBox auto-tags the scan to this terminal."}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">
                      {t("displayOrder") || "Display order (0 = first)"}
                    </label>
                    <input
                      type="number"
                      value={form.display_order}
                      onChange={(e) => setForm({ ...form, display_order: e.target.value })}
                      min="0"
                      max="99"
                      className="w-24 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                    />
                  </div>
                </div>
              </details>

              {error && (
                <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={save}
                  disabled={saving || !form.name.trim()}
                  className="flex-1 sm:flex-none px-5 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition"
                >
                  {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
                </button>
                <button
                  onClick={cancel}
                  className="px-5 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                >
                  {t("cancel") || "Cancel"}
                </button>
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Terminal list */}
      <FadeIn delay={0.05}>
        {loading ? (
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-6">
            {t("loading") || "Loading…"}
          </div>
        ) : !editing && error ? (
          <div className="mt-6 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3">
            {error}
          </div>
        ) : terminals.length === 0 ? (
          <div className="mt-6 bg-white dark:bg-gray-800 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-8 text-center">
            <div className="text-4xl mb-2">💳</div>
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">
              {t("noTerminalsYet") || "No terminals yet"}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 max-w-sm mx-auto">
              {t("noTerminalsHelp") ||
                "Add one terminal per physical POS station you have. Café with one cash drawer = 1 terminal. Restaurant with bar + terrace = 2."}
            </p>
            {!editing && (
              <button
                onClick={startNew}
                className="px-5 py-2 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition"
              >
                + {t("addFirstTerminal") || "Add your first terminal"}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {terminals.map((term) => (
              <div
                key={term.id}
                className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 px-4 sm:px-5 py-3 flex items-center justify-between gap-3 hover:border-gray-200 dark:hover:border-gray-600 transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                      {term.name}
                    </p>
                    {term.branch_id && branchName[term.branch_id] && (
                      <span className="text-[11px] text-gray-400 dark:text-gray-500">
                        · {branchName[term.branch_id]}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap mt-1">
                    {term.accepts_dankort && <CapabilityBadge label="Dankort" />}
                    {term.accepts_mobilepay && <CapabilityBadge label="MobilePay" />}
                    {term.accepts_amex && <CapabilityBadge label="Amex" />}
                    {term.receipt_label && (
                      <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500 ml-1">
                        ({term.receipt_label})
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => startEdit(term)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                  >
                    {t("edit") || "Edit"}
                  </button>
                  <button
                    onClick={() => remove(term)}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                  >
                    {t("delete") || "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </FadeIn>
    </div>
  );
}


/* ─── Small UI atoms ─────────────────────────────────────────────────── */

function CapabilityToggle({ label, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
        checked
          ? "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
          : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400"
      }`}
    >
      {checked ? "✓ " : ""}
      {label}
    </button>
  );
}

function CapabilityBadge({ label }) {
  return (
    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-gray-100 dark:bg-gray-700/50 text-gray-600 dark:text-gray-400">
      {label}
    </span>
  );
}
