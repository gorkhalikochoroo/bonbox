import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatDateClear } from "../utils/dateFormat";
import { errText } from "../utils/errText";
import { UpgradeNudge } from "./ui";

/**
 * Settings → "Send revisorpakke".
 *
 *   Aldrig · Hver uge (mandag morgen, forrige uge) · Hver måned (den 3.,
 *   forrige måned)
 *
 * The revisor's address is the one saved on the business profile (the same
 * address the daily-close mail goes to); when there is none it can be saved
 * here. The card says plainly what would stop the next package — an
 * unconfirmed owner e-mail, a revisor who unsubscribed — and what went out,
 * what was skipped and why (GET /api/revisor-package/settings).
 */
const OPTIONS = [
  { value: "never", labelKey: "rpsNever", label: "Never" },
  { value: "weekly", labelKey: "rpsWeekly", label: "Every week", hintKey: "rpsWeeklyHint", hint: "Monday morning, the week before" },
  { value: "monthly", labelKey: "rpsMonthly", label: "Every month", hintKey: "rpsMonthlyHint", hint: "On the 3rd, the month before" },
];

const BLOCKER_FALLBACK = {
  no_revisor: "Nothing is sent until you save your revisor's e-mail.",
  email_unverified: "Nothing is sent until you confirm your own e-mail (Profile → Unverified).",
  claim_question_open: "Nothing is sent until you answer the question we e-mailed you.",
  opted_out: "Your revisor has unsubscribed from BonBox mail — nothing is sent.",
  demo_recipient: "The revisor is sample data — save your own revisor's e-mail.",
  demo_identity: "Your business is still the sample company — correct it on Profile.",
  demo_in_period: "The period holds sample data — clear it on Profile first.",
  plan: "Sending is on Starter.",
  daily_cap: "Today's limit for revisor mail is reached — it goes out tomorrow.",
};

export default function RevisorPackageSchedule() {
  const { t, lang } = useLanguage();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState(null); // {ok, text}

  const load = async () => {
    try {
      const res = await api.get("/revisor-package/settings");
      setData(res.data);
      setEmail(res.data?.revisor_email || "");
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => { load(); }, []);

  const serverText = (e, fallback) => {
    const d = e?.response?.data?.detail;
    if (d && typeof d === "object") {
      const m = lang === "da" ? (d.message_da || d.message) : (d.message || d.message_da);
      if (m) return m;
    }
    return errText(e, fallback);
  };

  const choose = async (value) => {
    if (!data || value === data.schedule) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.put("/revisor-package/settings", { schedule: value });
      setData(res.data);
      setMsg({ ok: true, text: t("rpsSaved", "Saved") });
    } catch (e) {
      setMsg({ ok: false, text: serverText(e, t("rpsSaveFailed", "Couldn't save — try again.")) });
    } finally {
      setSaving(false);
    }
  };

  const saveEmail = async () => {
    const addr = email.trim();
    if (!addr) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.put("/business", { accountant_email: addr });
      await load();
      setMsg({ ok: true, text: t("rpsSaved", "Saved") });
    } catch (e) {
      setMsg({ ok: false, text: serverText(e, t("rpsSaveFailed", "Couldn't save — try again.")) });
    } finally {
      setSaving(false);
    }
  };

  if (failed && !data) return null;
  const entitled = data?.entitled !== false;
  const schedule = data?.schedule || "never";
  const next = data?.next;
  const blocker = data?.blocker;
  // When the hourly job really sends it (run_at: the due hour + its :20),
  // in the business's own zone — not the browser's (minor 9).
  const whenText = (n) => {
    const iso = n?.run_at || n?.due_at;
    if (!iso) return "";
    const opts = { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" };
    try {
      return new Date(iso).toLocaleString(lang === "da" ? "da-DK" : "en-GB", { ...opts, timeZone: n?.tz || "Europe/Copenhagen" });
    } catch {
      return new Date(iso).toLocaleString(lang === "da" ? "da-DK" : "en-GB", { ...opts, timeZone: "Europe/Copenhagen" });
    }
  };

  return (
    <section id="revisorpakke" className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-5 scroll-mt-4" data-testid="revisor-package-schedule">
      <div className="flex items-start gap-3">
        <CalendarClock size={18} strokeWidth={1.75} className="mt-0.5 text-gray-500 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t("rpsTitle", "Send revisor package")}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
            {t("rpsSub", "BonBox e-mails your revisor the summary and a link to the full package with every receipt.")}
          </p>
        </div>
      </div>

      {!data ? (
        <div className="mt-4 h-24 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" aria-busy="true" />
      ) : !entitled ? (
        <div className="mt-4">
          <UpgradeNudge intent="inline" tier="starter" iconName="Send"
            benefit={t("rpsLockedBenefit", "Have BonBox send the revisor package every week or month.")}
            ctaLabel={t("seePlans", "See plans")} />
        </div>
      ) : (
        <>
          <fieldset className="mt-4" disabled={saving}>
            <legend className="sr-only">{t("rpsTitle", "Send revisor package")}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {OPTIONS.map((o) => {
                const active = schedule === o.value;
                return (
                  <label
                    key={o.value}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition ${active ? "border-gray-900 dark:border-gray-100 ring-1 ring-gray-900 dark:ring-gray-100" : "border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                  >
                    <input
                      type="radio"
                      name="revisor-package-schedule"
                      value={o.value}
                      checked={active}
                      onChange={() => choose(o.value)}
                      // Dark: the chosen dot is the light one and the others
                      // render dark — accent-gray-900 alone made the choice
                      // read backwards on the dark card (Push 8 gate r3).
                      className="mt-1 accent-gray-900 dark:accent-gray-100 dark:[color-scheme:dark]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t(o.labelKey, o.label)}</span>
                      {o.hintKey && <span className="block text-xs text-gray-500 dark:text-gray-400">{t(o.hintKey, o.hint)}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-4">
            <label htmlFor="rps-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t("rpsRevisorEmail", "Revisor's e-mail")}
            </label>
            <div className="flex gap-2">
              <input
                id="rps-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="revisor@firma.dk"
                className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100"
                autoComplete="email"
              />
              {email.trim().toLowerCase() !== (data.revisor_email || "") && (
                <button type="button" onClick={saveEmail} disabled={saving || !email.trim()}
                  className="shrink-0 px-3 py-2 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-sm font-medium disabled:opacity-40">
                  {t("rpsSaveEmail", "Save e-mail")}
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t("rpsEmailHint", "The same address the daily-close mail goes to.")}</p>
          </div>

          {schedule !== "never" && next && !blocker && (
            <p className="mt-4 text-sm text-gray-700 dark:text-gray-300" data-testid="rps-next">
              {t("rpsNext", "Next: {period} — sent {when}", { period: next.label, when: whenText(next) })}
            </p>
          )}
          {schedule !== "never" && blocker && (
            <p className="mt-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-200" role="status" data-testid="rps-blocker">
              {t(`rpsBlocked_${blocker}`, BLOCKER_FALLBACK[blocker] || blocker)}
            </p>
          )}
          {msg && (
            <p className={`mt-2 text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`} role="status">{msg.text}</p>
          )}

          {(data.last_sends || []).length > 0 && (
            <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">{t("rpsHistory", "Recent packages")}</p>
              <ul className="space-y-1 text-sm">
                {data.last_sends.map((s) => {
                  // A failure that may still have reached the revisor (a
                  // timeout after the mail service took it, a send that
                  // never finished) is not "Failed": nobody knows.
                  const st = s.status === "failed" && /^(mail_unclear|stale_claim)/.test(s.error || "") ? "unclear" : s.status;
                  return (
                  <li key={s.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-gray-700 dark:text-gray-300">
                      {s.label}
                      <span className="text-gray-400"> · {s.trigger === "scheduled" ? t("rpsTriggerScheduled", "automatic") : t("rpsTriggerManual", "by you")}</span>
                    </span>
                    <span className={`shrink-0 text-xs ${s.status === "sent" ? "text-gray-600 dark:text-gray-400" : "text-amber-800 dark:text-amber-300"}`}>
                      {t(`rpsStatus_${st}`, st)}
                      {s.status === "sent" && s.sent_at ? ` ${formatDateClear(s.sent_on || s.sent_at.slice(0, 10))}` : ""}
                      {s.status === "skipped" && s.skip_reason ? ` — ${t(`rpsBlocked_${s.skip_reason}`, BLOCKER_FALLBACK[s.skip_reason] || s.skip_reason)}` : ""}
                      {s.status === "failed" && /^too_large/.test(s.error || "") ? ` — ${t("rpsTooLarge", "too large for a link — download it on Month-end")}` : ""}
                    </span>
                  </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
      <p className="mt-4 text-xs">
        <Link to="/month-end" className="underline underline-offset-2 font-medium text-gray-700 dark:text-gray-300">
          {t("rpsOpenMonthEnd", "Open month-end")}
        </Link>
      </p>
    </section>
  );
}
