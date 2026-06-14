import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn } from "../components/AnimationKit";

/**
 * Order Channel Settings — per-owner catalogue of order channels.
 *
 * Why this page exists:
 *   Order channels (Wolt / Uber Eats / Foodora / dine_in / takeaway etc.)
 *   used to be hardcoded in 9 files across the codebase. A small Danish
 *   café might only need 3 — a multi-aggregator chain might use 6+. New
 *   players (Foodpanda, Hungry.dk, regional aggregators in Sweden /
 *   Norway / Spain) appeared regularly and required a code change.
 *
 *   This page lets the owner add/edit channels without a deploy.
 *
 * Two row types render side-by-side:
 *   • SYSTEM rows  — out-of-the-box defaults. Owner can override the
 *                    label / emoji / color but can't archive them.
 *   • CUSTOM rows  — owner-added. Full edit + archive.
 *
 * Archived rows stay in the list with a muted style — they're hidden
 * from new-sale dropdowns but still resolve to a label for historical
 * sales reports.
 */

// Tailwind v4 with @import "tailwindcss" uses a JIT scanner that only
// finds classes literally present in source files. We can't build
// classnames like `bg-${color}` — those never reach the CSS output.
//
// Instead, every preset color has its full Tailwind class strings
// pre-spelled here. The COLOR_PRESETS array drives the picker; the
// SWATCH / DOT lookup drives rendering. Adding a new preset means
// adding one line in BOTH maps.
const COLOR_PRESETS = [
  "emerald-500", "orange-500", "cyan-500", "stone-900", "pink-500",
  "blue-500", "violet-500", "amber-500", "rose-500", "teal-500",
  "indigo-500", "lime-500", "slate-500", "gray-500", "stone-400",
];

const COLOR_SWATCH = {
  "emerald-500": "bg-emerald-500",
  "orange-500":  "bg-orange-500",
  "cyan-500":    "bg-cyan-500",
  "stone-900":   "bg-gray-900",
  "pink-500":    "bg-pink-500",
  "blue-500":    "bg-blue-500",
  "violet-500":  "bg-violet-500",
  "amber-500":   "bg-amber-500",
  "rose-500":    "bg-rose-500",
  "teal-500":    "bg-teal-500",
  "indigo-500":  "bg-indigo-500",
  "lime-500":    "bg-lime-500",
  "slate-500":   "bg-slate-500",
  "gray-500":    "bg-gray-500",
  "stone-400":   "bg-gray-400",
};

function swatchClass(c) {
  return COLOR_SWATCH[c] || COLOR_SWATCH["gray-500"];
}

const _DEFAULT_FORM = {
  slug: "",
  label: "",
  emoji: "",
  color: "gray-500",
  sort_order: 100,
};


export default function ChannelSettingsPage() {
  const { t } = useLanguage();
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);   // null | "new" | row.id
  const [form, setForm] = useState(_DEFAULT_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetchChannels();
  }, []);

  async function fetchChannels() {
    setLoading(true);
    try {
      const res = await api.get("/order-channels");
      setChannels(Array.isArray(res.data) ? res.data : []);
      setError("");
    } catch (err) {
      setError(errText(err, t("channelsLoadFailed") || "Could not load channels"));
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing("new");
    setForm({ ..._DEFAULT_FORM, sort_order: (channels.length + 1) * 10 });
  }

  function startEdit(ch) {
    setEditing(ch.id || `system:${ch.slug}`);
    setForm({
      slug: ch.slug,
      label: ch.label || "",
      emoji: ch.emoji || "",
      color: ch.color || "gray-500",
      sort_order: ch.sort_order ?? 100,
    });
  }

  function cancel() {
    setEditing(null);
    setForm(_DEFAULT_FORM);
    setError("");
  }

  async function save() {
    setError("");
    const slug = (form.slug || "").trim().toLowerCase();
    const label = (form.label || "").trim();
    if (!label) {
      setError(t("channelLabelRequired") || "Label is required");
      return;
    }
    if (editing === "new" && !slug) {
      setError(t("channelSlugRequired") || "Slug is required");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        label,
        emoji: form.emoji?.trim() || null,
        color: form.color || "gray-500",
        sort_order: Number(form.sort_order) || 0,
      };
      if (editing === "new") {
        await api.post("/order-channels", { ...payload, slug });
      } else if (typeof editing === "string" && editing.startsWith("system:")) {
        // System row being customised → create a new override row.
        // RESERVED system slugs (dine_in, takeaway, web, phone, catering,
        // other) can't be overridden via this flow — the backend
        // rejects them. The "Edit" button is hidden for those above.
        await api.post("/order-channels", { ...payload, slug });
      } else {
        await api.put(`/order-channels/${editing}`, payload);
      }
      await fetchChannels();
      cancel();
    } catch (err) {
      const detail = errText(err, t("channelSaveFailed") || "Could not save channel");
      setError(detail);
    } finally {
      setSaving(false);
    }
  }

  async function archive(ch) {
    if (!ch?.id) return; // system rows can't be archived directly
    const ok = window.confirm(
      (t("channelConfirmArchive") || "Archive channel “{label}”? Historical sales keep this label, but it disappears from new-sale dropdowns.")
        .replace("{label}", ch.label),
    );
    if (!ok) return;
    try {
      await api.delete(`/order-channels/${ch.id}`);
      await fetchChannels();
    } catch (err) {
      setError(errText(err, t("channelArchiveFailed") || "Could not archive"));
    }
  }

  async function unarchive(ch) {
    if (!ch?.id) return;
    try {
      await api.put(`/order-channels/${ch.id}`, { is_archived: false });
      await fetchChannels();
    } catch (err) {
      setError(errText(err, t("channelUnarchiveFailed") || "Could not restore"));
    }
  }

  // Group rows for rendering. System (non-legacy) first, then custom, then
  // archived + legacy at the bottom with a muted style.
  const grouped = useMemo(() => {
    const active = [];
    const archived = [];
    for (const ch of channels) {
      if (ch.is_archived || ch.is_legacy) archived.push(ch);
      else active.push(ch);
    }
    return { active, archived };
  }, [channels]);

  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto pb-32 md:pb-8">
      <FadeIn>
        <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              {"🛵"} {t("channelsPageTitle") || "Order Channels"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xl">
              {t("channelsPageSubtitle") ||
                "Which apps and counters do orders come through? Add new aggregators yourself — no deploy needed."}
            </p>
          </div>
          {!editing && (
            <button
              onClick={startNew}
              className="px-4 py-2 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition shrink-0"
            >
              + {t("addChannel") || "Add channel"}
            </button>
          )}
        </div>
      </FadeIn>

      {/* Inline editor */}
      {editing && (
        <FadeIn>
          <div className="mt-5 mb-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6 shadow-sm">
            <h2 className="text-base font-bold text-gray-900 dark:text-white mb-4">
              {editing === "new"
                ? (t("addChannel") || "Add channel")
                : (t("editChannel") || "Edit channel")}
            </h2>

            <div className="space-y-4">
              {/* Slug — only editable when adding new */}
              {editing === "new" ? (
                <div>
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                    {t("channelSlug") || "Slug"}
                  </label>
                  <input
                    type="text"
                    value={form.slug}
                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                    placeholder={t("channelSlugExample") || "e.g. foodpanda, hungry_dk"}
                    maxLength={50}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 font-mono focus:ring-2 focus:ring-gray-200 dark:focus:ring-green-700 outline-none"
                  />
                  <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
                    {t("channelSlugHint") ||
                      "Lowercase, letters/digits/underscore only. Cannot be changed later — historical sales reference it by this slug."}
                  </p>
                </div>
              ) : (
                <div className="text-xs text-gray-500 dark:text-gray-400 -mb-1">
                  <span className="font-semibold">{t("channelSlug") || "Slug"}:</span>{" "}
                  <span className="font-mono">{form.slug}</span>
                </div>
              )}

              {/* Label */}
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                  {t("channelLabel") || "Display name"}
                </label>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder={t("channelLabelExample") || "e.g. Foodpanda, Take-Away Pickup"}
                  maxLength={100}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 focus:ring-2 focus:ring-gray-200 dark:focus:ring-green-700 outline-none"
                />
              </div>

              {/* Emoji */}
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                  {t("channelEmoji") || "Emoji (optional)"}
                </label>
                <input
                  type="text"
                  value={form.emoji}
                  onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                  placeholder={"🛵"}
                  maxLength={4}
                  className="w-20 text-center text-xl px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                />
              </div>

              {/* Color */}
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2 block">
                  {t("channelColor") || "Bar color"}
                </label>
                <div className="flex flex-wrap gap-2">
                  {COLOR_PRESETS.map((c) => (
                    <button
                      type="button"
                      key={c}
                      onClick={() => setForm({ ...form, color: c })}
                      title={c}
                      className={`w-8 h-8 rounded-full ${swatchClass(c)} border-2 transition ${
                        form.color === c
                          ? "border-gray-900 dark:border-white scale-110"
                          : "border-transparent hover:scale-105"
                      }`}
                    />
                  ))}
                </div>
              </div>

              {/* Sort order — advanced */}
              <details className="rounded-lg border border-gray-100 dark:border-gray-700/40 px-3 py-2">
                <summary className="text-xs font-semibold text-gray-600 dark:text-gray-400 cursor-pointer">
                  {t("advancedSettings") || "Advanced"}
                </summary>
                <div className="mt-3">
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">
                    {t("channelSortOrder") || "Sort order (lower = first)"}
                  </label>
                  <input
                    type="number"
                    value={form.sort_order}
                    onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
                    min="0"
                    max="999"
                    className="w-24 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                  />
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
                  disabled={saving || !form.label.trim() || (editing === "new" && !form.slug.trim())}
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

      {/* Active list */}
      <FadeIn delay={0.05}>
        {loading ? (
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-6">
            {t("loading") || "Loading…"}
          </div>
        ) : !editing && error ? (
          <div className="mt-6 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3">
            {error}
          </div>
        ) : (
          <>
            <div className="mt-2 space-y-2">
              {grouped.active.map((ch) => (
                <ChannelRow
                  key={ch.id || `sys-${ch.slug}`}
                  ch={ch}
                  onEdit={() => startEdit(ch)}
                  onArchive={() => archive(ch)}
                  t={t}
                />
              ))}
            </div>

            {grouped.archived.length > 0 && (
              <div className="mt-8">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                  {t("channelsArchived") || "Archived / legacy"}
                </h2>
                <div className="space-y-2 opacity-60">
                  {grouped.archived.map((ch) => (
                    <ChannelRow
                      key={ch.id || `sys-${ch.slug}`}
                      ch={ch}
                      onEdit={() => startEdit(ch)}
                      onUnarchive={ch.id ? () => unarchive(ch) : undefined}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </FadeIn>
    </div>
  );
}


/* ─── Row ─────────────────────────────────────────────────────────── */

function ChannelRow({ ch, onEdit, onArchive, onUnarchive, t }) {
  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 px-4 sm:px-5 py-3 flex items-center justify-between gap-3"
    >
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <span
          className={`inline-block w-3 h-3 rounded-full ${swatchClass(ch.color)} shrink-0`}
        />
        <span className="text-lg shrink-0">{ch.emoji || "•"}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
            {ch.label}
            {ch.is_system && (
              <span className="ml-2 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-gray-100 dark:bg-gray-700/50 text-gray-600 dark:text-gray-400 uppercase tracking-wider">
                {ch.is_legacy ? (t("channelLegacyTag") || "legacy") : (t("channelSystemTag") || "system")}
              </span>
            )}
            {ch.is_archived && (
              <span className="ml-2 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 uppercase tracking-wider">
                {t("channelArchivedTag") || "archived"}
              </span>
            )}
          </p>
          <p className="text-[11px] font-mono text-gray-400 dark:text-gray-500 truncate">
            {ch.slug}
          </p>
        </div>
      </div>
      <div className="flex gap-1 shrink-0">
        {/* System rows with reserved slugs can't be edited via this UI
            (the backend rejects override creation for them). Only the
            delivery aggregators (wolt / uber_eats / foodora / just_eat)
            and any custom rows can be edited. */}
        {(!ch.is_system || _CAN_OVERRIDE_SYSTEM(ch.slug)) && (
          <button
            onClick={onEdit}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
          >
            {t("edit") || "Edit"}
          </button>
        )}
        {onArchive && !ch.is_system && (
          <button
            onClick={onArchive}
            className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
          >
            {t("archive") || "Archive"}
          </button>
        )}
        {onUnarchive && (
          <button
            onClick={onUnarchive}
            className="px-3 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-lg transition"
          >
            {t("restore") || "Restore"}
          </button>
        )}
      </div>
    </div>
  );
}


// Reserved system slugs the owner can't override via the POST flow.
// Mirrors backend services/channel_defaults.RESERVED_SLUGS so the UI
// never offers an action the server would reject.
const _RESERVED_SYSTEM_SLUGS = new Set([
  "dine_in", "takeaway", "web", "phone", "catering", "other",
]);
function _CAN_OVERRIDE_SYSTEM(slug) {
  return !_RESERVED_SYSTEM_SLUGS.has(slug);
}
