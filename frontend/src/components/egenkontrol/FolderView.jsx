/**
 * Kontrolmappe — the read-only view of a period, for the owner, a manager and
 * the paired kitchen iPad (no PDF there). Every count is the server's
 * (FolderOut); nothing here computes an "all done": no readings → "Ingen
 * målinger i perioden endnu.", never "100 % til tiden".
 *
 * The day strip is worst-of per day (deviation > missed > late > ok), so a
 * deviation is never hidden by a good re-check — nor by a correction. Typed
 * text (names, notes, "Andet" texts, reasons, titles) is shown as React text
 * — escaped, verbatim.
 *
 * R1b, all from the folder JSON (one code path with the PDF):
 *   • Dokumenter — the venue's own papers (DocumentsSection), listed with
 *     their upload and review-by dates; never "current";
 *   • Afvigelser — one item per deviation EVENT: a corrected one stays, with
 *     "Rettet: <grund> · <før> → <efter> · <dato kl.>", and "Rettet — ikke en
 *     afvigelse" when the corrected value is in limit;
 *   • Rettelser, Fra papir (both dates), Ugentlig gennemgang, the repeat
 *     hints, and — owner only, fetched on first open — "Alle målinger";
 *   • photos: a thumbnail on deviation and receiving rows (EntryPhoto, bytes
 *     through the caller's loader), "Foto vedlagt" elsewhere;
 *   • the venue's own findsmiley.dk link as a plain text link — never the
 *     smiley image, never an authority's logo.
 * Actions are the caller's: `permissions` says what this seat may do
 * (canCorrect, canManageDocs, canRemovePhoto — all false on the kitchen
 * iPad), `handlers` does it. This file imports none of the owner's sheets.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Pencil } from "lucide-react";
import CheckStatusPill from "../ui/CheckStatusPill";
import { formatDateClear } from "../../utils/dateFormat";
import DocumentsSection from "./DocumentsSection";
import EntryPhoto from "./EntryPhoto";
import {
  DAY_TONE,
  EK_ACTION_KEYS,
  EK_CORRECTION_REASON_KEYS,
  EK_DAY_KEYS,
  EK_FATE_KEYS,
  EK_PRODUCT_KEYS,
  FINDSMILEY_PREFIX,
  correctable,
  formatTemp,
  nameNoteKey,
  paperLine,
  photoAddedLater,
  valueText,
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
  // "(fra papir)" before how the name was given (the PDF's wording).
  const paper = e.source === "paper" ? ` ${t("ekNamePaper")}` : "";
  return `${e.staff_name}${paper} (${t(nameNoteKey(e.name_source, e.via))})`;
}

/** The official time of a reading: when it was measured (paper) or received. */
function when(e) {
  const paper = e?.source === "paper" && e.paper_measured_local_date;
  const date = paper ? e.paper_measured_local_date : e?.recorded_local_date;
  const time = paper ? e.paper_measured_local : e?.recorded_local;
  const d = date ? formatDateClear(date) : "";
  return [d, time].filter(Boolean).join(" · ");
}

const ROW = "px-4 py-3 text-[15px] text-gray-800 dark:text-gray-200";
const LIST = "rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800";
const RET_BTN =
  "h-10 px-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-[14px] font-semibold " +
  "text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800";

/** "Tastefejl" / "Forkert kontrolpunkt valgt" / "Andet: <typed>". */
function reasonText(code, text, t) {
  const label = t(EK_CORRECTION_REASON_KEYS[code] || "ekCorrectReasonOther");
  if (code === "other" && text) return `${label}: ${text}`;
  return text && code !== "other" ? `${label} (${text})` : label;
}

/** The chain of a deviation event, oldest first, head included once. */
function chainOf(item) {
  const chain = Array.isArray(item?.chain) ? item.chain : [];
  if (!chain.length) return [item];
  return chain[0]?.id === item.id ? chain : [item, ...chain.filter((c) => c.id !== item.id)];
}

const isReceiving = (e) => !!e?.product_type || e?.kind === "receiving";

/** "Foto vedlagt", or — added more than 10 min after the reading — "Foto
 *  vedlagt (tilføjet {dato} kl. {tid})": the PDF's rule, so a photo taken
 *  hours later is never shown as evidence of the reading's own time. */
function photoLabel(e, t) {
  const p = e?.photo;
  if (!p || !photoAddedLater(p, e)) return t("ekPhotoAttached");
  const date = p.uploaded_local_date ? formatDateClear(p.uploaded_local_date) : "";
  const time = p.uploaded_local || "";
  return date && time ? t("ekPhotoAttachedLater", { date, time }) : t("ekPhotoAttached");
}

function PhotoOrNote({ e, loaders, permissions, handlers, t, lang, thumb = true }) {
  if (!e?.photo) return null;
  if (thumb && loaders?.loadPhoto) {
    return (
      <div className="mt-1.5">
        <EntryPhoto
          photo={e.photo}
          load={loaders.loadPhoto}
          t={t}
          lang={lang}
          canRemove={!!permissions?.canRemovePhoto && !!handlers?.onRemovePhoto}
          onRemove={handlers?.onRemovePhoto}
          label={photoLabel(e, t)}
        />
      </div>
    );
  }
  if (e.photo.removed_at) return null;
  return <span className="text-gray-600 dark:text-gray-400" data-testid="ek-photo-note"> · {photoLabel(e, t)}</span>;
}

function AllReadings({ load, t, lang, permissions, handlers, loaders }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ phase: "idle", rows: [] });
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || state.phase === "ready" || state.phase === "loading") return;
    setState({ phase: "loading", rows: [] });
    try {
      const rows = await load();
      setState({ phase: "ready", rows: Array.isArray(rows) ? rows : [] });
    } catch {
      setState({ phase: "error", rows: [] });
    }
  };
  const byDay = new Map();
  for (const e of state.rows) {
    const day = (e.source === "paper" && e.paper_measured_local_date) || e.recorded_local_date || "";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  return (
    <section className="mt-6" data-testid="ek-folder-all">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="min-h-10 inline-flex items-center gap-1.5 text-[15px] font-semibold text-gray-900 dark:text-gray-100"
        data-testid="ek-folder-all-toggle"
      >
        {open ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
        {t("ekAllReadings")}
      </button>
      {open ? (
        <div className="mt-2">
          {state.phase === "loading" ? (
            <p role="status" className="text-[14px] text-gray-600 dark:text-gray-400">{t("loading")}</p>
          ) : state.phase === "error" ? (
            <p role="alert" className="text-[14px] text-red-700 dark:text-red-400">{t("ekLoadFailed")}</p>
          ) : state.rows.length === 0 ? (
            <p className="text-[14px] text-gray-600 dark:text-gray-400">{t("ekFolderNoReadings")}</p>
          ) : (
            [...byDay.entries()].map(([day, rows]) => (
              <div key={day} className="mt-3">
                <p className="text-[13px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">{formatDateClear(day)}</p>
                <ul className={LIST}>
                  {rows.map((e) => (
                    <li key={e.id} className={ROW} data-testid="ek-folder-reading">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-semibold">{e.check_name}</span>
                        <span className="text-gray-600 dark:text-gray-400 font-display tabular-nums">
                          {(e.source === "paper" && e.paper_measured_local) || e.recorded_local}
                        </span>
                        <span className="font-display tabular-nums font-semibold">{valueText(e, t, lang)}</span>
                        {e.staff_name ? <span className="text-gray-600 dark:text-gray-400">· {who(e, t)}</span> : null}
                        {e.supersedes_id ? <span className="text-gray-600 dark:text-gray-400">· {t("ekCorrectedShort")}</span> : null}
                        {!isReceiving(e) ? <PhotoOrNote e={e} t={t} lang={lang} thumb={false} /> : null}
                        {permissions?.canCorrect && handlers?.onCorrect && correctable(e) ? (
                          <button type="button" className={RET_BTN + " ml-auto"} onClick={() => handlers.onCorrect(e)} data-testid="ek-ret">
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                            {t("ekRet")}
                          </button>
                        ) : null}
                      </div>
                      {e.source === "paper" ? <p className="text-[14px] text-gray-600 dark:text-gray-400">{paperLine(e, t, lang)}</p> : null}
                      {isReceiving(e) ? <PhotoOrNote e={e} t={t} lang={lang} loaders={loaders} permissions={permissions} handlers={handlers} /> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

export default function FolderView({
  folder,
  t,
  lang = "da",
  actions = null,
  permissions = { canCorrect: false, canManageDocs: false, canRemovePhoto: false },
  loaders = {},
  handlers = {},
  docBusyId = null,
}) {
  if (!folder) return null;
  const s = folder.summary || {};
  const tc = folder.title_counts || { readings: s.readings, deviations: s.deviations, deviations_open: s.deviations_open };
  const days = Array.isArray(folder.days) ? folder.days : [];
  const devs = Array.isArray(folder.deviations) ? folder.deviations : [];
  const late = Array.isArray(folder.late) ? folder.late : [];
  const missed = Array.isArray(folder.missed) ? folder.missed : [];
  const undone = Array.isArray(folder.undone) ? folder.undone : [];
  const corrections = Array.isArray(folder.corrections) ? folder.corrections : [];
  const paper = Array.isArray(folder.paper) ? folder.paper : [];
  const reviews = Array.isArray(folder.reviews) ? folder.reviews : [];
  const hints = Array.isArray(folder.repeat_hints) ? folder.repeat_hints : [];
  const hasDocs = Array.isArray(folder.documents);
  const smiley =
    typeof folder.findsmiley_url === "string" && folder.findsmiley_url.startsWith(FINDSMILEY_PREFIX) ? folder.findsmiley_url : null;
  const action = (e) => (e.action_code === "other" ? e.action_other : e.action_code ? t(EK_ACTION_KEYS[e.action_code] || "ekActOther") : "");
  const fate = (e) => (e.fate_code === "other" ? e.fate_other : e.fate_code ? t(EK_FATE_KEYS[e.fate_code] || "ekFateOther") : "");
  const product = (e) => (e.product_type ? t(EK_PRODUCT_KEYS[e.product_type] || "ekProductChilled") : "");
  const correctedAt = (e) => [e?.created_local_date ? formatDateClear(e.created_local_date) : "", e?.created_local].filter(Boolean).join(" · ");

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
          {smiley ? (
            <p className="mt-1 text-[14px]">
              <a
                href={smiley}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2 text-gray-800 dark:text-gray-200"
                data-testid="ek-smiley-link"
              >
                {t("ekSmileyLink")}
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            </p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      {hasDocs ? (
        <DocumentsSection
          documents={folder.documents}
          t={t}
          canManage={!!permissions?.canManageDocs}
          loadDocument={loaders?.loadDocument || null}
          onAdd={handlers?.onAddDocument}
          onReviewed={handlers?.onDocumentReviewed}
          onDelete={handlers?.onDeleteDocument}
          busyId={docBusyId}
        />
      ) : null}

      <ul className="mt-4 flex flex-wrap gap-2 text-[14px]" data-testid="ek-folder-counts">
        <li><CheckStatusPill tone="ok">{t("ekFolderOnTime", { count: s.slots_on_time || 0 })}</CheckStatusPill></li>
        <li><CheckStatusPill tone="warn">{t("ekFolderLate", { count: s.slots_late || 0 })}</CheckStatusPill></li>
        <li><CheckStatusPill tone="bad">{t("ekFolderMissed", { count: s.slots_missed || 0 })}</CheckStatusPill></li>
        <li><CheckStatusPill tone="muted">{t("ekFolderUndoneCount", { count: s.undone || 0 })}</CheckStatusPill></li>
        {Number(s.paper || 0) > 0 ? <li><CheckStatusPill tone="muted">{t("ekFolderPaperCount", { count: s.paper })}</CheckStatusPill></li> : null}
        {Number(s.corrections || 0) > 0 ? (
          <li><CheckStatusPill tone="muted">{t("ekFolderCorrectionsCount", { count: s.corrections })}</CheckStatusPill></li>
        ) : null}
      </ul>

      {days.length ? (
        <div className="mt-4">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(days.length, 31)}, minmax(0, 1fr))` }} data-testid="ek-folder-strip">
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

      {hints.length ? (
        <ul className="mt-4 space-y-1" data-testid="ek-folder-repeat-hints">
          {hints.map((h) => (
            <li key={h.check_id}>
              <CheckStatusPill tone="warn" variant="text">
                {t("ekRepeatHint", { check: h.check_name || "", count: h.count, days: h.days || 30 })}
              </CheckStatusPill>
            </li>
          ))}
        </ul>
      ) : null}

      <Section title={t("ekFolderDeviations")} testId="ek-folder-deviations">
        {devs.length === 0 ? (
          <p className="text-[15px] text-gray-600 dark:text-gray-400">{t("ekFolderNoDeviations")}</p>
        ) : (
          <ul className={LIST}>
            {devs.map((item) => {
              const chain = chainOf(item);
              const tail = chain[chain.length - 1] || item;
              // The deviation's answers: from the live reading when it is still
              // out of limit, else from the reading that was the deviation.
              const shown = tail.in_limit === false && (tail.action_code || tail.fate_code) ? tail : item;
              const state = item.state || (item.deviation_state === "open" ? "open" : "closed");
              const photoHolder = item.photo ? { ...shown, photo: item.photo } : chain.find((c) => c.photo) || null;
              return (
                <li key={item.id} className={ROW} data-testid="ek-folder-deviation">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">{item.check_name}</span>
                    <span className="text-gray-600 dark:text-gray-400">{when(item)}</span>
                    <span className="font-display tabular-nums font-semibold">{formatTemp(item.value_c, lang)}</span>
                    <span className="text-gray-600 dark:text-gray-400">({limitText(item, t, lang)})</span>
                    {product(item) ? <span className="text-gray-600 dark:text-gray-400">· {product(item)}</span> : null}
                  </div>
                  {item.source === "paper" ? (
                    <p className="text-[14px] text-gray-600 dark:text-gray-400" data-testid="ek-paper-line">{paperLine(item, t, lang)}</p>
                  ) : null}
                  {chain.slice(1).map((c, i) => {
                    const prev = chain[i];
                    const moved = prev.check_id && c.check_id && prev.check_id !== c.check_id;
                    return (
                      <p key={c.id} className="mt-1 text-[14px]" data-testid="ek-corrected-line">
                        {t("ekCorrectedLine", {
                          reason: reasonText(c.correction_reason, c.correction_text, t),
                          before: valueText(prev, t, lang) + (moved && prev.check_name ? ` (${prev.check_name})` : ""),
                          after: valueText(c, t, lang) + (moved && c.check_name ? ` (${c.check_name})` : ""),
                          date: c.created_local_date ? formatDateClear(c.created_local_date) : "",
                          time: c.created_local || "",
                        })}
                      </p>
                    );
                  })}
                  <dl className="mt-1 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[14px]">
                    <dt className="text-gray-500 dark:text-gray-400">{t("ekWhatDidYouDo")}</dt>
                    <dd>{action(shown)}</dd>
                    <dt className="text-gray-500 dark:text-gray-400">{t("ekWhatHappenedFood")}</dt>
                    <dd>{fate(shown)}</dd>
                    {shown.action_note ? (
                      <>
                        <dt className="text-gray-500 dark:text-gray-400">{t("ekNoteLabel")}</dt>
                        <dd className="whitespace-pre-wrap break-words">{shown.action_note}</dd>
                      </>
                    ) : null}
                    <dt className="text-gray-500 dark:text-gray-400">{t("ekWhoMeasured")}</dt>
                    <dd>{who(item, t)}</dd>
                  </dl>
                  {(item.followups || []).map((f) => (
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
                  {photoHolder ? (
                    <PhotoOrNote e={photoHolder} loaders={loaders} permissions={permissions} handlers={handlers} t={t} lang={lang} />
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <CheckStatusPill tone={state === "open" ? "bad" : state === "corrected" ? "muted" : "warn"}>
                      {t(state === "open" ? "ekStatusDeviationOpen" : state === "corrected" ? "ekCorrectedNotDeviation" : "ekStatusDeviationClosed")}
                    </CheckStatusPill>
                    {permissions?.canCorrect && handlers?.onCorrect && correctable(tail) ? (
                      <button type="button" className={RET_BTN} onClick={() => handlers.onCorrect(tail, item)} data-testid="ek-ret">
                        <Pencil className="w-4 h-4" aria-hidden="true" />
                        {t("ekRet")}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
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

      {corrections.length ? (
        <Section title={t("ekSectionCorrections")} testId="ek-folder-corrections">
          <ul className={LIST}>
            {corrections.map((c) => {
              const o = c.original || {};
              const n = c.corrected || {};
              return (
                <li key={n.id || o.id} className={ROW}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">
                      {c.check_changed && c.original_check_name ? `${c.original_check_name} → ${c.check_name}` : c.check_name || c.original_check_name}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">{when(o)}</span>
                  </div>
                  <p className="text-[14px]">
                    <span className="font-display tabular-nums line-through decoration-1">{valueText(o, t, lang)}</span>
                    {" → "}
                    <span className="font-display tabular-nums font-semibold">{valueText(n, t, lang)}</span>
                    {" · "}
                    {reasonText(c.reason_code, c.reason_text, t)}
                  </p>
                  <p className="text-[14px] text-gray-600 dark:text-gray-400">
                    {t("ekCorrectedAt", { when: [c.corrected_local_date ? formatDateClear(c.corrected_local_date) : "", c.corrected_local].filter(Boolean).join(" · ") || correctedAt(n) })}
                  </p>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      {paper.length ? (
        <Section title={t("ekSectionPaper")} testId="ek-folder-paper">
          <ul className={LIST}>
            {paper.map((e) => (
              <li key={e.id} className={ROW}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{e.check_name}</span>
                  <span className="font-display tabular-nums font-semibold">{valueText(e, t, lang)}</span>
                  {e.staff_name ? <span className="text-gray-600 dark:text-gray-400">· {who(e, t)}</span> : null}
                </div>
                <p className="text-[14px] text-gray-600 dark:text-gray-400" data-testid="ek-paper-line">{paperLine(e, t, lang)}</p>
                {e.reason_text ? (
                  <p className="text-[14px] whitespace-pre-wrap break-words">
                    <span className="text-gray-500 dark:text-gray-400">{t("ekPaperReason")}:</span> {e.reason_text}
                  </p>
                ) : null}
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
                <span className="font-display tabular-nums line-through decoration-1">{valueText(e, t, lang)}</span>
                {e.staff_name ? <span className="text-gray-600 dark:text-gray-400"> · {who(e, t)}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {Array.isArray(folder.reviews) ? (
        <Section title={t("ekSectionReviews")} testId="ek-folder-reviews">
          {reviews.length === 0 ? (
            <p className="text-[15px] text-gray-600 dark:text-gray-400">{t("ekReviewsNone")}</p>
          ) : (
            <ul className={LIST}>
              {reviews.map((r) => (
                <li key={r.iso_week} className={ROW}>
                  <p>
                    {t("ekReviewRow", {
                      week: String(r.iso_week || "").split("-W")[1] ? Number(String(r.iso_week).split("-W")[1]) : "",
                      from: formatDateClear(r.week_start || ""),
                      to: formatDateClear(r.week_end || ""),
                    })}
                  </p>
                  <p className="text-[14px] text-gray-700 dark:text-gray-300">
                    {t("ekWeekReviewedLine", {
                      date: r.reviewed_local_date ? formatDateClear(r.reviewed_local_date) : "",
                      time: r.reviewed_local || "",
                      name: r.actor_name ? ` · ${r.actor_name}` : "",
                    })}
                  </p>
                  {r.note ? <p className="text-[14px] whitespace-pre-wrap break-words">{r.note}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {loaders?.loadReadings ? (
        <AllReadings load={loaders.loadReadings} t={t} lang={lang} permissions={permissions} handlers={handlers} loaders={loaders} />
      ) : null}

      <div className="mt-6 space-y-1 text-[14px] text-gray-600 dark:text-gray-400">
        <p>{t("ekFolderCovers")}</p>
        <p>{t("ekFolderNamesNote")}</p>
      </div>
    </div>
  );
}
