import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn } from "../components/AnimationKit";

/**
 * Modules picker — owners enable the vertical modules they actually use.
 *
 * Single-page UI for the gating system shipped in cbde6db (backend
 * services/modules.py + routers/modules.py). Calls:
 *   GET  /api/modules         → catalog with per-user enabled flag + cap
 *   PUT  /api/modules/select  → save the selection
 *
 * Copenhagen pattern: calm card list, no aggressive colors, generous
 * whitespace. Pro/trial users see "Unlimited" badge + can multi-select;
 * Free/Starter see the cap explicitly ("1 enabled / 1 allowed") and a
 * gentle upgrade prompt when they try to enable a 2nd module.
 *
 * Why this matters strategically: the segment claim "Pro: ALL vertical
 * modules at once" is now SOMETHING THE USER ACTUALLY DOES — they pick
 * their modules, see the cap, decide to upgrade or not. Before this UI,
 * the gate existed in the API but was invisible.
 */
export default function ModulesPage() {
  const { t } = useLanguage();
  const [data, setData] = useState(null); // { plan, modules_cap, modules: [...] }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState(null); // null = synced; array = unsaved selection
  const [savedHint, setSavedHint] = useState("");

  useEffect(() => {
    fetchModules();
  }, []);

  async function fetchModules() {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/modules");
      setData(res.data);
      setPendingIds(null);
    } catch (err) {
      setError(err?.response?.data?.detail || t("modulesLoadFailed") || "Could not load modules");
    } finally {
      setLoading(false);
    }
  }

  // The actual selection the UI is showing — pendingIds when user has
  // unsaved changes, else the persisted enabled set from the API.
  const selectedIds = useMemo(() => {
    if (pendingIds !== null) return pendingIds;
    if (!data) return [];
    return data.modules.filter((m) => m.enabled).map((m) => m.id);
  }, [data, pendingIds]);

  const cap = data?.modules_cap ?? 1;
  const isUnlimited = cap < 0;
  const atCap = !isUnlimited && selectedIds.length >= cap;
  const dirty = pendingIds !== null;

  function toggle(moduleId) {
    setSavedHint("");
    setPendingIds((prev) => {
      const base = prev !== null ? prev : (data?.modules || []).filter(m => m.enabled).map(m => m.id);
      if (base.includes(moduleId)) {
        return base.filter((id) => id !== moduleId);
      }
      // Adding — refuse if at cap (unless unlimited)
      if (!isUnlimited && base.length >= cap) {
        return base; // no-op; UI shows upgrade hint
      }
      return [...base, moduleId];
    });
  }

  async function save() {
    if (selectedIds === null) return;
    setSaving(true);
    setError("");
    try {
      await api.put("/modules/select", { modules: selectedIds });
      setSavedHint(t("modulesSaved") || "Modules saved");
      setTimeout(() => setSavedHint(""), 3000);
      await fetchModules();
    } catch (err) {
      setError(err?.response?.data?.detail || t("modulesSaveFailed") || "Could not save");
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    setPendingIds(null);
    setError("");
  }

  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto">
      <FadeIn>
        <div className="mb-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            🧩 {t("modulesPageTitle") || "Vertical modules"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xl">
            {t("modulesPageSubtitle") ||
              "Pick the feature areas relevant to your business. Hidden modules don't appear in the sidebar — keeps the app focused on what you actually use."}
          </p>
        </div>
      </FadeIn>

      {/* Plan summary card — renders the cap honestly */}
      <FadeIn delay={0.02}>
        <div className="mt-4 mb-5 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("modulesYourPlan") || "Your plan"}
            </div>
            <div className="text-base font-semibold text-gray-900 dark:text-white mt-0.5">
              {data?.plan ? data.plan[0].toUpperCase() + data.plan.slice(1) : "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("modulesEnabledCap") || "Modules enabled"}
            </div>
            <div className="text-base font-semibold text-gray-900 dark:text-white mt-0.5">
              {selectedIds.length} / {isUnlimited ? (t("unlimited") || "Unlimited") : cap}
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Module cards */}
      {loading && !data && (
        <div className="text-sm text-gray-500 dark:text-gray-400 mt-4">
          {t("loading") || "Loading…"}
        </div>
      )}

      {data && (
        <FadeIn delay={0.04}>
          <div className="space-y-2">
            {data.modules.map((m) => {
              const selected = selectedIds.includes(m.id);
              const wouldBeBlocked = !selected && atCap;
              return (
                <button
                  key={m.id}
                  onClick={() => toggle(m.id)}
                  disabled={wouldBeBlocked}
                  className={`w-full text-left rounded-xl border px-5 py-4 transition flex items-start gap-4
                    ${selected
                      ? "border-green-300 dark:border-green-700 bg-green-50/60 dark:bg-green-900/10"
                      : wouldBeBlocked
                        ? "border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/30 opacity-60 cursor-not-allowed"
                        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 hover:border-gray-300 dark:hover:border-gray-600"
                    }`}
                >
                  <span
                    className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-md border flex items-center justify-center text-[12px] font-bold
                      ${selected
                        ? "bg-green-500 border-green-500 text-white"
                        : "border-gray-300 dark:border-gray-600 text-transparent"
                      }`}
                  >
                    ✓
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      {m.name}
                    </div>
                    <div className="text-[12.5px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                      {m.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </FadeIn>
      )}

      {/* Cap-hit hint — only shown when at cap AND there's an off module */}
      {data && atCap && data.modules.some((m) => !selectedIds.includes(m.id)) && (
        <div className="mt-4 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 text-[13px] text-amber-800 dark:text-amber-200">
          <span className="font-semibold">
            {(t("modulesCapHitTitle") || "{cap} module on this plan").replace("{cap}", cap)}
          </span>{" "}
          {t("modulesCapHitBody") ||
            "To enable more, upgrade to Pro for ALL modules at once."}
          {" "}
          <Link to="/subscription" className="font-semibold text-amber-900 dark:text-amber-100 underline">
            {t("modulesCapHitCta") || "See plans →"}
          </Link>
        </div>
      )}

      {/* Action row */}
      {data && (
        <div className="mt-5 flex items-center gap-3 flex-wrap">
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-5 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition"
          >
            {saving ? (t("saving") || "Saving…") : (t("save") || "Save")}
          </button>
          {dirty && (
            <button
              onClick={discardChanges}
              className="px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
            >
              {t("discardChanges") || "Discard changes"}
            </button>
          )}
          {savedHint && (
            <span className="text-[13px] text-green-700 dark:text-green-400 font-medium">
              ✓ {savedHint}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3">
          {error}
        </div>
      )}
    </div>
  );
}
