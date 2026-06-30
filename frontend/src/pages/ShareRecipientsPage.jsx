import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { FadeIn } from "../components/AnimationKit";
import { errText } from "../utils/errText";

/**
 * Share recipients settings — owners configure where their daily-close
 * reports go after each close. Manoj's "not everyone will work like
 * this" insight made operational: small bakery emails one address,
 * Silberbauer posts to a Messenger group, wine bar emails 3 investors.
 *
 * Each row = one channel. Channel types:
 *   email             → comma-separated emails
 *   whatsapp          → phone or group ID
 *   messenger         → handle or group ID
 *   sms               → phone
 *   slack             → webhook URL or channel
 *   pdf_only          → null target — just generate, no auto-send
 *   csv_to_accountant → email of revisor
 *
 * The tjener never sees this page. Owner configures once, closer
 * just hits "Send" after a close and the right channels surface as
 * quick-tap buttons.
 *
 * For v1 we don't AUTO-SEND. The native share sheet still opens for
 * the closer to tap through — but it preselects the right channel.
 */

const _CHANNEL_TYPES = [
  { value: "email",             icon: "📧", labelKey: "channelEmail",      placeholderKey: "channelEmailPlaceholder" },
  { value: "whatsapp",          icon: "📱", labelKey: "channelWhatsApp",   placeholderKey: "channelPhonePlaceholder" },
  { value: "messenger",         icon: "💬", labelKey: "channelMessenger",  placeholderKey: "channelHandlePlaceholder" },
  { value: "sms",               icon: "💌", labelKey: "channelSMS",        placeholderKey: "channelPhonePlaceholder" },
  { value: "slack",             icon: "💻", labelKey: "channelSlack",      placeholderKey: "channelSlackPlaceholder" },
  { value: "csv_to_accountant", icon: "📊", labelKey: "channelCSVAccountant", placeholderKey: "channelEmailPlaceholder" },
  { value: "pdf_only",          icon: "📄", labelKey: "channelPDFOnly",    placeholderKey: null },
];

const _DEFAULT_FORM = {
  channel_type: "email",
  target: "",
  label: "",
  display_order: 0,
};


export default function ShareRecipientsPage() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | id
  const [form, setForm] = useState(_DEFAULT_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => { void fetchChannels(); }, []);

  async function fetchChannels() {
    setLoading(true);
    try {
      const res = await api.get("/output-channels");
      setChannels(Array.isArray(res.data) ? res.data : []);
      setError("");
    } catch (e) {
      setError(errText(e, t("recipientsLoadFailed") || "Could not load recipients"));
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing("new");
    setForm({ ..._DEFAULT_FORM, display_order: channels.length });
  }

  function startEdit(c) {
    setEditing(c.id);
    setForm({
      channel_type: c.channel_type,
      target: c.target || "",
      label: c.label || "",
      display_order: c.display_order ?? 0,
    });
  }

  function cancel() {
    setEditing(null);
    setForm(_DEFAULT_FORM);
    setError("");
  }

  async function save() {
    if (!form.label.trim()) {
      setError(t("recipientLabelRequired") || "Label is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        channel_type: form.channel_type,
        target: (form.target || "").trim() || null,
        label: form.label.trim(),
        display_order: Number(form.display_order) || 0,
      };
      if (editing === "new") {
        await api.post("/output-channels", payload);
      } else {
        await api.put(`/output-channels/${editing}`, payload);
      }
      await fetchChannels();
      cancel();
    } catch (e) {
      setError(errText(e, t("recipientSaveFailed") || "Could not save"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(c) {
    if (!(await confirm({
      message: (t("recipientConfirmDelete") || "Delete recipient {label}?").replace("{label}", c.label),
      destructive: true,
    }))) return;
    try {
      await api.delete(`/output-channels/${c.id}`);
      await fetchChannels();
    } catch (e) {
      setError(errText(e, t("recipientDeleteFailed") || "Could not delete"));
    }
  }

  const typeMeta = useMemo(
    () => Object.fromEntries(_CHANNEL_TYPES.map((c) => [c.value, c])),
    [],
  );
  const currentTypeMeta = typeMeta[form.channel_type] || _CHANNEL_TYPES[0];

  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto">
      <FadeIn>
        <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              📨 {t("shareRecipientsTitle") || "Share recipients"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xl">
              {t("shareRecipientsSubtitle") ||
                "Where your daily-close reports go. Configure once; tjener just taps Send. Email, WhatsApp, Messenger, Slack — your existing channels, your choice."}
            </p>
          </div>
          {!editing && (
            <button
              onClick={startNew}
              className="px-4 py-2 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition shrink-0"
            >
              + {t("addRecipient") || "Add recipient"}
            </button>
          )}
        </div>
      </FadeIn>

      {editing && (
        <FadeIn>
          <div className="mt-5 mb-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 sm:p-6 shadow-sm">
            <h2 className="text-base font-bold text-gray-900 dark:text-white mb-4">
              {editing === "new"
                ? (t("addRecipient") || "Add recipient")
                : (t("editRecipient") || "Edit recipient")}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                  {t("channelType") || "Channel"}
                </label>
                <select
                  value={form.channel_type}
                  onChange={(e) => setForm({ ...form, channel_type: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                >
                  {_CHANNEL_TYPES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.icon} {t(c.labelKey) || c.value}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                  {t("recipientLabel") || "Label"}
                </label>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder={t("recipientLabelExample") || "e.g. Lars (owner), Revisor, Investor group"}
                  maxLength={120}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                />
              </div>

              {currentTypeMeta.placeholderKey && (
                <div>
                  <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1.5 block">
                    {t("recipientTarget") || "Target"}
                  </label>
                  <input
                    type="text"
                    value={form.target}
                    onChange={(e) => setForm({ ...form, target: e.target.value })}
                    placeholder={t(currentTypeMeta.placeholderKey) || ""}
                    maxLength={500}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm font-mono"
                  />
                  <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
                    {t("recipientTargetHint") ||
                      "For email channels, comma-separate multiple addresses."}
                  </p>
                </div>
              )}

              {error && (
                <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={save}
                  disabled={saving || !form.label.trim()}
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

      <FadeIn delay={0.05}>
        {loading ? (
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-6">
            {t("loading") || "Loading…"}
          </div>
        ) : !editing && error ? (
          <div className="mt-6 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3">
            {error}
          </div>
        ) : channels.length === 0 ? (
          <div className="mt-6 bg-white dark:bg-gray-800 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-8 text-center">
            <div className="text-4xl mb-2">📨</div>
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">
              {t("noRecipientsYet") || "No recipients yet"}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 max-w-sm mx-auto">
              {t("noRecipientsHelp") ||
                "Add the people who should get tonight's close — by email, WhatsApp, Messenger, Slack, or wherever you already share."}
            </p>
            {!editing && (
              <button
                onClick={startNew}
                className="px-5 py-2 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition"
              >
                + {t("addFirstRecipient") || "Add your first recipient"}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {channels.map((c) => {
              const meta = typeMeta[c.channel_type];
              return (
                <div
                  key={c.id}
                  className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 px-4 sm:px-5 py-3 flex items-center justify-between gap-3 hover:border-gray-200 dark:hover:border-gray-600 transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base">{meta?.icon || "📨"}</span>
                      <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                        {c.label}
                      </p>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                        {meta ? (t(meta.labelKey) || c.channel_type) : c.channel_type}
                      </span>
                    </div>
                    {c.target && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono truncate">
                        {c.target}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(c)}
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                    >
                      {t("edit") || "Edit"}
                    </button>
                    <button
                      onClick={() => remove(c)}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                    >
                      {t("delete") || "Delete"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </FadeIn>
    </div>
  );
}
