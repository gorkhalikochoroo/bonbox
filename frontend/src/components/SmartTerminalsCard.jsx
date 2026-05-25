/**
 * SmartTerminalsCard — inference-first POS terminal setup.
 *
 * Why this replaced the empty-state "go to Settings → Terminals":
 *   The old flow was 3 screens: Multi-close → "set up terminals first"
 *   → Settings → fill out N rows manually → back to Multi-close → scan.
 *   Mirabelle has 4 terminals; that's 4 forms × ~6 fields = homework.
 *
 *   Per the founder: "our goal should be simple. how can we help them.
 *   no complicated stuff." So this card flips it: the closer takes the
 *   photos they were going to take anyway, and we read the terminal
 *   labels off the slips themselves.
 *
 * Pre-launch refinements (May 2026):
 *   • Honest empty state — we don't pretend "we found something" when
 *     we found nothing. Different copy in that path.
 *   • Multi-branch dropdown — restaurants with 2+ branches pick which
 *     branch the new terminals belong to. Single-branch owners skip it.
 *   • No confidence pill — concrete "found N labels across M slips" beats
 *     an abstract badge for a surface where the closer can SEE the data.
 *   • High-confidence skip — if every label was seen on ≥2 slips and
 *     no proposal collides with an existing terminal, save without the
 *     confirm step (still with undo toast). One tap → done.
 *   • Reassurance copy — "scan what you have, add more later" so a
 *     panicked closer at midnight doesn't think they need every slip
 *     up front.
 *   • Telemetry — log accept/edit/cancelled so we can tune.
 *   • Undo toast — 8s window to back out a slipped tap.
 *
 * Multi-layer security:
 *   • All endpoints auth-gated server-side, tenant-scoped server-side.
 *   • Inference is read-only — confirm step writes via /bulk-create.
 *   • Service layer pre-validates every proposal atomically — UI is
 *     convenience.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useSmartTelemetry } from "../hooks/useSmartTelemetry";
import { useUndoToast } from "../hooks/useUndoToast";


export default function SmartTerminalsCard({ onComplete }) {
  const { t } = useLanguage();
  const { track } = useSmartTelemetry();
  const { show: showUndo, ToastUI } = useUndoToast();
  const fileInputRef = useRef(null);

  const [phase, setPhase] = useState("scan");          // scan | confirm | saving | done
  const [scans, setScans] = useState([]);              // [{ extraction_id, data, ... }]
  const [scanning, setScanning] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [editingIdx, setEditingIdx] = useState(null);
  const [editedAny, setEditedAny] = useState(false);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState("");

  // Fetch branches once so we can show a dropdown if the owner has ≥2.
  // The branches router exposes /list (not /); it returns
  // {branches: [{id, name, ...}, ...]} for active branches owned by
  // the current user.
  useEffect(() => {
    let alive = true;
    api.get("/branches/list")
      .then((res) => {
        if (!alive) return;
        const list = res?.data?.branches || [];
        setBranches(Array.isArray(list) ? list : []);
      })
      .catch(() => { /* single-branch path — silently fall back */ });
    return () => { alive = false; };
  }, []);

  const isMultiBranch = branches.length >= 2;
  const noLabelsFound = useMemo(
    () =>
      proposal?.proposals?.length === 1 &&
      proposal.proposals[0].receipt_label === null &&
      proposal.proposals[0].source_count === 0,
    [proposal],
  );

  // ── Step 1: scan kasserapport photos ────────────────────────────────

  async function onPickFiles(files) {
    setError("");
    if (!files || !files.length) return;
    setScanning(true);
    const newScans = [];
    for (const file of files) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await api.post("/kasserapport/extract", fd, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 60000,
        });
        newScans.push(res.data);
      } catch (err) {
        const msg = err?.response?.data?.detail || err?.message || "Unknown error";
        setError(`${file.name}: ${msg}`);
      }
    }
    setScans((prev) => [...prev, ...newScans]);
    setScanning(false);
  }

  async function startInference() {
    if (scans.length === 0) {
      setError(t("smartTerminalsNoScans") || "Add at least one kasserapport photo first.");
      return;
    }
    setError("");
    try {
      const extraction_ids = scans.map((s) => s.extraction_id).filter(Boolean);
      const res = await api.post("/terminals/infer", { extraction_ids });
      setProposal(res.data);
      track("smart_proposal_viewed", "smart_terminals", {
        confidence: res.data?.confidence,
        proposal_count: res.data?.proposals?.length || 0,
        scan_count: scans.length,
      });

      // High-confidence skip-confirm: if every label was seen on ≥2 slips
      // AND no proposals collide with existing terminals AND single-branch,
      // save without making them tap "confirm" again. Still undoable.
      const canAutoSave =
        res.data?.confidence === "high" &&
        !isMultiBranch &&
        !res.data.proposals.some((p) => p.matches_existing_id);
      if (canAutoSave) {
        await acceptProposal(res.data, /* autoSaved */ true);
        return;
      }
      setPhase("confirm");
    } catch (err) {
      // 401 redirects via global interceptor — suppress the error flash
      if (err?.response?.status === 401) return;
      setError(err?.response?.data?.detail || (t("smartTerminalsInferFailed") || "Couldn't propose terminals."));
    }
  }

  function clearScan(idx) {
    setScans((prev) => prev.filter((_, i) => i !== idx));
  }

  // ── Step 2: confirm or edit proposal ────────────────────────────────

  function patchProposal(idx, patch) {
    setEditedAny(true);
    setProposal((prev) => ({
      ...prev,
      proposals: prev.proposals.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    }));
  }

  async function acceptProposal(proposalArg = null, autoSaved = false) {
    const useProposal = proposalArg || proposal;
    if (!useProposal?.proposals?.length) return;
    setPhase("saving");
    setError("");

    // Strip server-only fields and empty-default rows.
    const terminalsToCreate = useProposal.proposals
      .filter((p) => !p.matches_existing_id)
      .map((p) => ({
        name: p.name,
        receipt_label: p.receipt_label || null,
        display_order: p.display_order,
        accepts_dankort: p.accepts_dankort,
        accepts_mobilepay: p.accepts_mobilepay,
        accepts_amex: p.accepts_amex,
      }));

    try {
      let createdTerminals = [];
      if (terminalsToCreate.length > 0) {
        const body = {
          terminals: terminalsToCreate,
          ...(branchId ? { branch_id: branchId } : {}),
        };
        const res = await api.post("/terminals/bulk-create", body);
        createdTerminals = res.data || [];
      }

      // Refetch full active list (existing + newly-created)
      const all = await api.get("/terminals");
      const activeTerminals = (all.data || []).filter((x) => x.is_active !== false);

      // Telemetry — accept (with edit count if any)
      track(autoSaved ? "smart_proposal_accepted" : (editedAny ? "smart_proposal_edited" : "smart_proposal_accepted"), "smart_terminals", {
        confidence: useProposal.confidence,
        proposal_count: useProposal.proposals.length,
        edited_count: editedAny ? 1 : 0,
        auto_saved: autoSaved,
        had_existing: useProposal.existing_terminals?.length > 0,
      });

      // Undo: soft-delete each terminal we just created. Existing rows
      // we matched/skipped are untouched.
      const undoIds = createdTerminals.map((t) => t.id);
      showUndo({
        message: t("smartTerminalsSavedToast") || "Terminals saved",
        onUndo: async () => {
          for (const id of undoIds) {
            try { await api.delete(`/terminals/${id}`); } catch { /* best-effort */ }
          }
          // Tell the parent — they should re-fetch.
          onComplete?.({ terminals: [], scans, undone: true });
        },
      });

      setPhase("done");
      onComplete?.({ terminals: activeTerminals, scans });
    } catch (err) {
      setError(err?.response?.data?.detail || (t("smartTerminalsSaveFailed") || "Couldn't save terminals."));
      setPhase("confirm");
    }
  }

  function cancelProposal() {
    track("smart_proposal_cancelled", "smart_terminals", {
      confidence: proposal?.confidence,
      proposal_count: proposal?.proposals?.length || 0,
    });
    setPhase("scan");
    setProposal(null);
    setEditingIdx(null);
    setEditedAny(false);
  }

  // ── Render ──────────────────────────────────────────────────────────

  if (phase === "scan") {
    return (
      <>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("smartTerminalsTitle") || "Set up your terminals — the easy way"}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t("smartTerminalsScanIntro") ||
                "Snap one kasserapport from each terminal you have. We'll read the labels and propose your setup."}
            </p>
            <p className="text-[12px] text-gray-400 dark:text-gray-500 mt-1">
              {t("smartTerminalsReassure") ||
                "Don't have all of them tonight? Scan what you have — you can add more later."}
            </p>
          </div>

          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-5 text-center">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={scanning}
              className="px-4 py-2 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold disabled:opacity-50 transition"
            >
              {scanning
                ? (t("scanning") || "Scanning…")
                : (t("smartTerminalsPickPhotos") || "Pick kasserapport photos")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              multiple
              onChange={(e) => onPickFiles(e.target.files)}
              className="hidden"
            />
            <p className="text-[11px] text-gray-400 mt-2">
              {t("smartTerminalsPickHint") || "JPEG, PNG, HEIC. Up to 12 MB each."}
            </p>
          </div>

          {scans.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">
                {t("smartTerminalsScanned") || "Scanned"} ({scans.length})
              </div>
              <ul className="space-y-1.5">
                {scans.map((s, i) => {
                  const label = s?.data?.session?.terminal || (t("smartTerminalsLabelMissing") || "(no label found)");
                  return (
                    <li
                      key={s.extraction_id || i}
                      className="flex items-center justify-between px-3 py-1.5 rounded-md bg-gray-50 dark:bg-gray-700/30 text-sm"
                    >
                      <span className="text-gray-700 dark:text-gray-200">
                        ✓ {label}
                      </span>
                      <button
                        type="button"
                        onClick={() => clearScan(i)}
                        className="text-xs text-gray-400 hover:text-red-500"
                        aria-label={t("remove") || "Remove"}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={startInference}
              disabled={scans.length === 0 || scanning}
              className="px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-900 hover:bg-gray-800 dark:hover:bg-gray-700 text-white text-sm font-semibold disabled:opacity-40 transition"
            >
              {t("smartTerminalsContinue") || "Continue"}
            </button>
          </div>
        </div>
        {ToastUI}
      </>
    );
  }

  if (phase === "confirm" && proposal) {
    const slipCountText = (t("smartTerminalsFoundN") ||
      "Found {labels} label{labelPlural} across {slips} slip{slipPlural}")
      .replace("{labels}", proposal.data_quality?.distinct_labels ?? proposal.proposals.length)
      .replace("{labelPlural}", (proposal.data_quality?.distinct_labels ?? proposal.proposals.length) === 1 ? "" : "s")
      .replace("{slips}", proposal.data_quality?.extractions_observed ?? scans.length)
      .replace("{slipPlural}", (proposal.data_quality?.extractions_observed ?? scans.length) === 1 ? "" : "s");

    const newCount = proposal.proposals.filter((p) => !p.matches_existing_id).length;

    return (
      <>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {noLabelsFound
                ? (t("smartTerminalsEmptyTitle") || "We couldn't read terminal labels")
                : (t("smartTerminalsConfirmTitle") || "Here's what we found")}
            </h2>
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1">
              {noLabelsFound
                ? (t("smartTerminalsEmptyBody") ||
                    "The slips didn't have a clear terminal name. Want one default terminal to start with — you can rename it later.")
                : slipCountText}
            </p>
          </div>

          {/* Multi-branch picker */}
          {isMultiBranch && (
            <div className="space-y-1">
              <label htmlFor="smart-terminals-branch" className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">
                {t("smartTerminalsBranch") || "Branch"}
              </label>
              <select
                id="smart-terminals-branch"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
              >
                <option value="">
                  {t("smartTerminalsBranchPick") || "Pick a branch…"}
                </option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Proposal rows */}
          <ul className="space-y-2">
            {proposal.proposals.map((p, i) => {
              const isEditing = editingIdx === i;
              const isExisting = !!p.matches_existing_id;
              return (
                <li
                  key={i}
                  className={`rounded-xl border p-3 ${
                    isExisting
                      ? "border-amber-200 bg-amber-50/40 dark:bg-amber-900/10 dark:border-amber-800/40"
                      : "border-gray-200 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-700/20"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <input
                          type="text"
                          value={p.name}
                          onChange={(e) => patchProposal(i, { name: e.target.value })}
                          maxLength={80}
                          className="w-full px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
                        />
                      ) : (
                        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                          {p.name}
                        </div>
                      )}
                      <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                        {p.receipt_label && (
                          <span className="font-mono">↳ {p.receipt_label}</span>
                        )}
                        {p.source_count > 0 && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{p.source_count} {p.source_count === 1
                              ? (t("smartTerminalsSlipSeen") || "slip seen")
                              : (t("smartTerminalsSlipsSeen") || "slips seen")}</span>
                          </>
                        )}
                        {isExisting && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-semibold">
                            {t("smartTerminalsAlreadySetUp") || "already set up"}
                          </span>
                        )}
                      </div>
                    </div>

                    {!isExisting && (
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <CapPill
                          on={p.accepts_dankort}
                          onClick={() => isEditing && patchProposal(i, { accepts_dankort: !p.accepts_dankort })}
                          clickable={isEditing}
                          label="Dankort"
                        />
                        <CapPill
                          on={p.accepts_mobilepay}
                          onClick={() => isEditing && patchProposal(i, { accepts_mobilepay: !p.accepts_mobilepay })}
                          clickable={isEditing}
                          label="MobilePay"
                        />
                        <CapPill
                          on={p.accepts_amex}
                          onClick={() => isEditing && patchProposal(i, { accepts_amex: !p.accepts_amex })}
                          clickable={isEditing}
                          label="Amex"
                        />
                      </div>
                    )}

                    {!isExisting && (
                      <button
                        type="button"
                        onClick={() => setEditingIdx(isEditing ? null : i)}
                        className="px-2 py-1 text-[11px] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 rounded"
                      >
                        {isEditing
                          ? (t("done") || "Done")
                          : (t("smartTerminalsEditRow") || "Edit")}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {error && (
            <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={cancelProposal}
              className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
            >
              {t("back") || "Back"}
            </button>
            <button
              type="button"
              onClick={() => acceptProposal()}
              disabled={phase === "saving" || (isMultiBranch && !branchId)}
              className="px-4 py-2 rounded-lg bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold disabled:opacity-50 transition"
            >
              {phase === "saving"
                ? (t("saving") || "Saving…")
                : (t("smartTerminalsSaveN") || "Save {n} terminal{plural}")
                    .replace("{n}", String(newCount))
                    .replace("{plural}", newCount === 1 ? "" : "s")}
            </button>
          </div>
        </div>
        {ToastUI}
      </>
    );
  }

  if (phase === "saving" || phase === "done") {
    return (
      <>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700/60 p-5 text-center text-sm text-gray-500">
          {phase === "saving" ? (t("saving") || "Saving…") : (t("smartTerminalsSaved") || "Saved.")}
        </div>
        {ToastUI}
      </>
    );
  }

  return ToastUI;
}


function CapPill({ on, onClick, clickable, label }) {
  const cls = on
    ? "bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200"
    : "bg-gray-100 dark:bg-gray-700 text-gray-400 line-through";
  return (
    <button
      type="button"
      tabIndex={clickable ? 0 : -1}
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      aria-pressed={on}
      className={`px-1.5 py-0.5 rounded font-medium ${cls} ${
        clickable ? "cursor-pointer hover:ring-1 hover:ring-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400" : "cursor-default"
      }`}
    >
      {label}
    </button>
  );
}
