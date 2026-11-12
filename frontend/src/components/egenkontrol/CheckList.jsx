/**
 * The day's checks, grouped Temperaturer / Genopvarmning / Varemodtagelse.
 * One row per check: name + note, the limit and where it comes from, and the
 * status in words (colour through CheckStatusPill only). Shared by the kitchen
 * iPad and the owner's Målinger tab.
 *
 * A reading that has not been saved yet stays ON the row ("Ikke gemt endnu ·
 * prøv igen" + "Prøv igen") until the server has it — never lost in silence.
 * A reading saved from this screen keeps "Fortryd" until its 2-minute window
 * closes (the deadline is set when the save came back, from the server's own
 * recorded_at → undo_until span, so a wrong device clock cannot stretch it).
 */
import { ChevronRight, RotateCcw } from "lucide-react";
import CheckStatusPill from "../ui/CheckStatusPill";
import {
  EK_GROUP_KEYS,
  STATUS_TONE,
  formatTemp,
  groupChecks,
  limitLine,
  receivingSourceLine,
  sourceLine,
  statusLines,
  weekdayName,
} from "./ekLogic";

function PendingLine({ item, onRetry, onOpen, t, lang }) {
  const value = formatTemp(item.body?.value_c, lang);
  if (item.state === "needs_action") {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="ek-pending-needs-action">
        <CheckStatusPill tone="bad">{t("ekNeedsAction")} · {value}</CheckStatusPill>
        <button
          type="button"
          onClick={() => onOpen?.(item)}
          className="min-h-14! px-4 rounded-lg border border-gray-300 dark:border-gray-600 text-[15px] font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          {t("ekRecord")}
        </button>
      </div>
    );
  }
  if (item.state === "sending") {
    return (
      <div role="status">
        <CheckStatusPill tone="muted">{t("ekCtaSaving")} · {value}</CheckStatusPill>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="ek-pending-failed">
      <CheckStatusPill tone="bad">{t("ekNotSavedYet")} · {value}</CheckStatusPill>
      <button
        type="button"
        onClick={() => onRetry?.(item.clientId)}
        className="min-h-14! px-4 inline-flex items-center gap-2 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-[15px] font-semibold"
      >
        <RotateCcw className="w-4 h-4" aria-hidden="true" />
        {t("ekRetry")}
      </button>
    </div>
  );
}

export default function CheckList({
  checks = [],
  selectedId = null,
  onSelect = null,
  pending = [],
  onRetry,
  onOpenPending,
  recent = {},
  now = null,
  onUndo = null,
  undoBusy = null,
  t,
  lang = "da",
}) {
  const groups = groupChecks(checks);
  const wd = (i) => weekdayName(i, lang);
  return (
    <div className="space-y-5" data-testid="ek-check-list">
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`ek-group-${g.key}`}>
          <h2 id={`ek-group-${g.key}`} className="text-[13px] font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-2">
            {t(EK_GROUP_KEYS[g.key])}
          </h2>
          <ul className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
            {g.checks.map((c) => {
              const lines = statusLines(c, lang, wd);
              const tone = STATUS_TONE[c.status] || "muted";
              const mine = pending.filter((p) => p.checkId === c.id);
              const saved = recent[c.id];
              const canUndo =
                onUndo && saved && !saved.entry?.voided_at && (now == null || now < saved.deadline);
              const selected = selectedId === c.id;
              const receiving = c.kind === "receiving" || c.template_key === "receiving";
              const limit = receiving ? null : c.limit || null;
              const recvSource = receiving ? receivingSourceLine(c, t) : "";
              const body = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-[17px] font-semibold text-gray-900 dark:text-gray-50 truncate">{c.name}</span>
                      {c.note ? <span className="text-[14px] text-gray-500 dark:text-gray-400 truncate">{c.note}</span> : null}
                    </div>
                    <div className="mt-0.5 text-[14px] text-gray-600 dark:text-gray-400">
                      <span className="font-display tabular-nums">{limitLine(c, t, lang)}</span>
                      {!receiving && sourceLine(limit, t) ? <span> · {sourceLine(limit, t)}</span> : null}
                    </div>
                    {recvSource ? (
                      <div className="text-[13px] text-gray-500 dark:text-gray-400" data-testid="ek-receiving-source">{recvSource}</div>
                    ) : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <CheckStatusPill tone={tone}>{t(lines[0][0], lines[0][1] || undefined)}</CheckStatusPill>
                      {lines[1] ? (
                        <span className="text-[14px] text-gray-700 dark:text-gray-300 font-display tabular-nums">
                          {t(lines[1][0], lines[1][1] || undefined)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {onSelect ? <ChevronRight className="w-5 h-5 shrink-0 text-gray-400" aria-hidden="true" /> : null}
                </>
              );
              return (
                <li key={c.id} data-testid={`ek-row-${c.id}`} className={selected ? "bg-gray-50 dark:bg-gray-800/60" : ""}>
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(c)}
                      aria-current={selected ? "true" : undefined}
                      className="w-full min-h-14! px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-400"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="w-full min-h-14! px-4 py-3 flex items-center gap-3">{body}</div>
                  )}
                  {mine.length || canUndo ? (
                    <div className="px-4 pb-3 -mt-1 space-y-2">
                      {mine.map((p) => (
                        <PendingLine key={p.clientId} item={p} onRetry={onRetry} onOpen={onOpenPending} t={t} lang={lang} />
                      ))}
                      {canUndo ? (
                        <button
                          type="button"
                          onClick={() => onUndo(saved.entry)}
                          disabled={undoBusy === saved.entry?.id}
                          className="min-h-14! px-4 inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 text-[15px] font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                          data-testid="ek-undo"
                        >
                          <RotateCcw className="w-4 h-4" aria-hidden="true" />
                          {t("ekUndo")} · <span className="font-display tabular-nums">{formatTemp(saved.entry?.value_c, lang)}</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
