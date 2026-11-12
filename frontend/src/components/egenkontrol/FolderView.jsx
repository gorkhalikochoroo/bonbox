/**
 * Kontrolmappe — the read-only view of the last 30 days, for the owner, a
 * manager and the paired kitchen iPad (no PDF there). Every count is the
 * server's (FolderOut); nothing here computes an "all done": no readings →
 * "Ingen målinger i perioden endnu.", never "100 % til tiden".
 *
 * The 30-day strip is worst-of per day (deviation > missed > late > ok), so a
 * deviation is never hidden by a good re-check. Typed text (names, notes,
 * "Andet" texts) is shown as React text — escaped, verbatim.
 */
import CheckStatusPill from "../ui/CheckStatusPill";
import { formatDateClear } from "../../utils/dateFormat";
import {
  DAY_TONE,
  EK_ACTION_KEYS,
  EK_DAY_KEYS,
  EK_FATE_KEYS,
  EK_PRODUCT_KEYS,
  formatTemp,
  nameNoteKey,
} from "./ekLogic";

function Section({ title, children, testId }) {
  return (
    <section className="mt-6" data-testid={testId}>
      <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 mb-2">{title}</h3>
      {children}
    </section>
  );
}

function limitText(e, t, lang) {
  if (e?.limit_c == null) return "";
  return t(e.limit_direction === "min" ? "ekLimitMin" : "ekLimitMax", { value: formatTemp(e.limit_c, lang) });
}

function who(e, t) {
  if (!e?.staff_name) return "";
  return `${e.staff_name} (${t(nameNoteKey(e.name_source, e.via))})`;
}

function when(e) {
  const d = e?.recorded_local_date ? formatDateClear(e.recorded_local_date) : "";
  return [d, e?.recorded_local].filter(Boolean).join(" · ");
}

const ROW = "px-4 py-3 text-[15px] text-gray-800 dark:text-gray-200";
const LIST = "rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800";

export default function FolderView({ folder, t, lang = "da", actions = null }) {
  if (!folder) return null;
  const s = folder.summary || {};
  const tc = folder.title_counts || { readings: s.readings, deviations: s.deviations, deviations_open: s.deviations_open };
  const days = Array.isArray(folder.days) ? folder.days : [];
  const devs = Array.isArray(folder.deviations) ? folder.deviations : [];
  const late = Array.isArray(folder.late) ? folder.late : [];
  const missed = Array.isArray(folder.missed) ? folder.missed : [];
  const undone = Array.isArray(folder.undone) ? folder.undone : [];
  const action = (e) => (e.action_code === "other" ? e.action_other : e.action_code ? t(EK_ACTION_KEYS[e.action_code] || "ekActOther") : "");
  const fate = (e) => (e.fate_code === "other" ? e.fate_other : e.fate_code ? t(EK_FATE_KEYS[e.fate_code] || "ekFateOther") : "");
  const product = (e) => (e.product_type ? t(EK_PRODUCT_KEYS[e.product_type] || "ekProductChilled") : "");

  return (
    <div data-testid="ek-folder">
      <p className="text-[12px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("ekFolderEyebrow")}</p>
      <div className="mt-1 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div className="min-w-0">
          {Number(tc.readings || 0) === 0 ? (
            <h2 className="text-[20px] font-semibold text-gray-900 dark:text-gray-50">{t("ekFolderNoReadings")}</h2>
          ) : (
            <h2 className="text-[20px] font-semibold text-gray-900 dark:text-gray-50">
              <span className="font-display tabular-nums">{t("ekFolderSummary", { readings: tc.readings, deviations: tc.deviations || 0 })}</span>
              {Number(tc.deviations || 0) > 0 ? (
                <>
                  {" · "}
                  {Number(tc.deviations_open || 0) > 0 ? (
                    <CheckStatusPill tone="bad" variant="text">{t("ekFolderOpenCount", { count: tc.deviations_open })}</CheckStatusPill>
                  ) : (
                    <span>{t("ekFolderAllClosed")}</span>
                  )}
                </>
              ) : null}
            </h2>
          )}
          <p className="mt-1 text-[14px] text-gray-600 dark:text-gray-400">
            {formatDateClear(folder.from)} – {formatDateClear(folder.to)}
            {folder.branch_name ? ` · ${folder.branch_name}` : ""}
          </p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      <ul className="mt-3 flex flex-wrap gap-2 text-[14px]" data-testid="ek-folder-counts">
        <li><CheckStatusPill tone="ok">{t("ekFolderOnTime", { count: s.slots_on_time || 0 })}</CheckStatusPill></li>
        <li><CheckStatusPill tone="warn">{t("ekFolderLate", { count: s.slots_late || 0 })}</CheckStatusPill></li>
        <li><CheckStatusPill tone="bad">{t("ekFolderMissed", { count: s.slots_missed || 0 })}</CheckStatusPill></li>
        <li><CheckStatusPill tone="muted">{t("ekFolderUndoneCount", { count: s.undone || 0 })}</CheckStatusPill></li>
      </ul>

      {days.length ? (
        <div className="mt-4">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }} data-testid="ek-folder-strip">
            {days.map((d) => (
              <CheckStatusPill
                key={d.date}
                variant="cell"
                tone={DAY_TONE[d.state] || "muted"}
                className="h-7"
                title={`${formatDateClear(d.date)} · ${t(EK_DAY_KEYS[d.state] || "ekDayNone")}`}
              >
                {`${formatDateClear(d.date)}: ${t(EK_DAY_KEYS[d.state] || "ekDayNone")}`}
              </CheckStatusPill>
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-gray-600 dark:text-gray-400">
            {["ok", "late", "missed", "deviation", "none"].map((k) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <CheckStatusPill variant="dot" tone={DAY_TONE[k]} />
                {t(EK_DAY_KEYS[k])}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Section title={t("ekFolderDeviations")} testId="ek-folder-deviations">
        {devs.length === 0 ? (
          <p className="text-[15px] text-gray-600 dark:text-gray-400">{t("ekFolderNoDeviations")}</p>
        ) : (
          <ul className={LIST}>
            {devs.map((e) => (
              <li key={e.id} className={ROW}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{e.check_name}</span>
                  <span className="text-gray-600 dark:text-gray-400">{when(e)}</span>
                  <span className="font-display tabular-nums font-semibold">{formatTemp(e.value_c, lang)}</span>
                  <span className="text-gray-600 dark:text-gray-400">({limitText(e, t, lang)})</span>
                  {product(e) ? <span className="text-gray-600 dark:text-gray-400">· {product(e)}</span> : null}
                </div>
                <dl className="mt-1 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[14px]">
                  <dt className="text-gray-500 dark:text-gray-400">{t("ekWhatDidYouDo")}</dt>
                  <dd>{action(e)}</dd>
                  <dt className="text-gray-500 dark:text-gray-400">{t("ekWhatHappenedFood")}</dt>
                  <dd>{fate(e)}</dd>
                  {e.action_note ? (
                    <>
                      <dt className="text-gray-500 dark:text-gray-400">{t("ekNoteLabel")}</dt>
                      <dd className="whitespace-pre-wrap break-words">{e.action_note}</dd>
                    </>
                  ) : null}
                  <dt className="text-gray-500 dark:text-gray-400">{t("ekWhoMeasured")}</dt>
                  <dd>{who(e, t)}</dd>
                </dl>
                {(e.followups || []).map((f) => (
                  <div key={f.id} className="mt-1 text-[14px]" data-testid="ek-folder-followup">
                    <p className="font-display tabular-nums">
                      {t("ekFolderFollowup", { value: formatTemp(f.value_c, lang), time: f.recorded_local || "" })}
                      {f.staff_name ? <span className="font-text"> · {who(f, t)}</span> : null}
                    </p>
                    {/* What finally happened to the food, and the follow-up's own note
                        (typed text as React text: escaped, verbatim). */}
                    {fate(f) ? (
                      <p>
                        <span className="text-gray-500 dark:text-gray-400">{t("ekFolderFollowupFate")}</span> {fate(f)}
                      </p>
                    ) : null}
                    {f.action_note ? (
                      <p className="whitespace-pre-wrap break-words">
                        <span className="text-gray-500 dark:text-gray-400">{t("ekFolderFollowupNote")}</span> {f.action_note}
                      </p>
                    ) : null}
                  </div>
                ))}
                <div className="mt-1.5">
                  <CheckStatusPill tone={e.deviation_state === "open" ? "bad" : "warn"}>
                    {t(e.deviation_state === "open" ? "ekStatusDeviationOpen" : "ekStatusDeviationClosed")}
                  </CheckStatusPill>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {late.length ? (
        <Section title={t("ekFolderLateH")} testId="ek-folder-late">
          <ul className={LIST}>
            {late.map((e) => (
              <li key={e.id} className={ROW}>
                <span className="font-semibold">{e.check_name}</span>{" "}
                <span className="text-gray-600 dark:text-gray-400">{e.recorded_local_date ? formatDateClear(e.recorded_local_date) : ""}</span>{" · "}
                <span className="font-display tabular-nums">{formatTemp(e.value_c, lang)}</span>{" · "}
                <span>{t("ekStatusDoneLate", { time: e.recorded_local || "", due: e.slot_due_local || "" })}</span>
                {e.staff_name ? <span className="text-gray-600 dark:text-gray-400"> · {who(e, t)}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {missed.length ? (
        <Section title={t("ekFolderMissedH")} testId="ek-folder-missed">
          <ul className={LIST}>
            {missed.map((m) => (
              <li key={`${m.check_id}-${m.date}-${m.due_local}`} className={ROW}>
                <span className="font-semibold">{m.check_name}</span>{" "}
                <span className="text-gray-600 dark:text-gray-400">{formatDateClear(m.date)}</span>
                {m.due_local ? <span> · {t("ekStatusLater", { time: m.due_local })}</span> : null}
                {" · "}
                <CheckStatusPill tone="bad" variant="text">{t("ekStatusMissed")}</CheckStatusPill>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {undone.length ? (
        <Section title={t("ekFolderUndoneH")} testId="ek-folder-undone">
          <ul className={LIST}>
            {undone.map((e) => (
              <li key={e.id} className={ROW}>
                <span className="font-semibold">{e.check_name}</span>{" "}
                <span className="text-gray-600 dark:text-gray-400">{when(e)}</span>{" · "}
                <span className="font-display tabular-nums line-through decoration-1">{formatTemp(e.value_c, lang)}</span>
                {e.staff_name ? <span className="text-gray-600 dark:text-gray-400"> · {who(e, t)}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="mt-6 space-y-1 text-[14px] text-gray-600 dark:text-gray-400">
        <p>{t("ekFolderCovers")}</p>
        <p>{t("ekFolderNamesNote")}</p>
      </div>
    </div>
  );
}
