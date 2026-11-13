/**
 * "Ret" — the owner corrects a reading (R1b, owner only, readings at most 14
 * days old; the server is the judge of every rule).
 *
 * A correction is saved NEXT TO the original: the original stays in the
 * Kontrolmappe and the PDF (marked corrected), the time of the reading does
 * not change, and a deviation never disappears — a typo that turns "71" into
 * "7,1" leaves the event listed as "Rettet — ikke en afvigelse".
 *
 * Reasons: Tastefejl (a new value on the keypad), Forkert kontrolpunkt valgt
 * (move the reading to another check of the same kind), Andet (a typed
 * reason, and a new value). If the corrected value is out of limit the usual
 * two questions come back. One fresh client_id per sheet, kept across retries
 * (a lost answer comes back as the stored correction, never a second one).
 */
import { useState } from "react";
import { X } from "lucide-react";
import Sheet from "../ui/Sheet";
import Button from "../ui/Button";
import Chip from "../ui/Chip";
import CheckStatusPill from "../ui/CheckStatusPill";
import api from "../../services/api";
import Keypad from "./Keypad";
import {
  ACTION_NOTE_MAX,
  CORRECTION_REASON_MAX,
  EK_ACTION_KEYS,
  EK_CORRECTION_REASON_KEYS,
  EK_ERROR_KEYS,
  EK_FATE_KEYS,
  EK_PRODUCT_KEYS,
  OTHER_TEXT_MAX,
  errorCode,
  formatTemp,
  inRange,
  isTick,
  limitFor,
  nameNoteKey,
  newClientId,
  nextEntry,
  parseEntry,
  valueText,
  withinLimit,
} from "./ekLogic";

const FIELD =
  "w-full min-h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 text-[15px] " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400";
const LEGEND = "text-[14px] font-semibold text-gray-900 dark:text-gray-100 mb-2";

function Choice({ legend, codes, keys, value, onChange, other, onOther, placeholder, t, testId }) {
  return (
    <fieldset className="min-w-0" data-testid={testId}>
      <legend className={LEGEND}>{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {codes.map((code) => (
          <Chip key={code} className="h-10" selected={value === code} onClick={() => onChange(value === code ? null : code)}>
            {t(keys[code] || keys.other)}
          </Chip>
        ))}
      </div>
      {value === "other" ? (
        <input
          type="text"
          className={FIELD + " mt-2"}
          value={other}
          maxLength={OTHER_TEXT_MAX}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onOther(e.target.value)}
        />
      ) : null}
    </fieldset>
  );
}

export default function CorrectionSheet({ entry, checks = [], onSaved, onClose, t, lang = "da" }) {
  const list = Array.isArray(checks) ? checks : [];
  const fallback = {
    id: entry?.check_id,
    name: entry?.check_name || "",
    kind: entry?.done === true ? "tick" : entry?.product_type ? "receiving" : entry?.limit_direction === "min" ? "temp_min" : "temp_max",
    limit: entry?.limit_c != null ? { limit_c: entry.limit_c, direction: entry.limit_direction || "max" } : null,
    action_codes: [],
    fate_codes: [],
  };
  const original = list.find((c) => c.id === entry?.check_id) || fallback;
  const tick = isTick(original) || entry?.done === true;
  const reasons = tick ? ["wrong_check", "other"] : ["typo", "wrong_check", "other"];
  const others = list.filter((c) => c.id !== original.id && c.kind === original.kind && !c.archived_at && c.active !== false);

  const [clientId] = useState(() => newClientId());
  const [reason, setReason] = useState(null);
  const [reasonText, setReasonText] = useState("");
  // The new value is typed from empty (the old one stays on screen above).
  const [value, setValue] = useState("");
  const [targetId, setTargetId] = useState(original.id);
  const [productType, setProductType] = useState(entry?.product_type || null);
  const [action, setAction] = useState(null);
  const [actionOther, setActionOther] = useState("");
  const [fate, setFate] = useState(null);
  const [fateOther, setFateOther] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const target = list.find((c) => c.id === targetId) || original;
  const receiving = target.kind === "receiving" || target.template_key === "receiving";
  const num = tick ? null : parseEntry(value);
  const limit = tick ? null : limitFor(target, productType) || (target === original ? fallback.limit : null);
  const out = typeof num === "number" && inRange(num) && !!limit && !withinLimit(num, limit);
  const sameCheck = target.id === original.id;
  // The server copies the answers from the original when it stays on its
  // check and had them; otherwise they are asked again.
  const hadAnswers = sameCheck && !!entry?.action_code && !!entry?.fate_code;
  const needsAnswers = out && !hadAnswers;
  const filled = (code, txt) => !!code && (code !== "other" || txt.trim().length > 0);
  const valueChanged = !tick && typeof num === "number" && num !== Number(entry?.value_c);
  const changed = valueChanged || !sameCheck || (receiving && productType !== (entry?.product_type || null));
  const reasonOk =
    !!reason && (reason !== "other" || reasonText.trim().length > 0) && reasonText.length <= CORRECTION_REASON_MAX;
  const ready =
    reasonOk &&
    changed &&
    (tick || (typeof num === "number" && inRange(num))) &&
    (!receiving || !!productType) &&
    (!needsAnswers || (filled(action, actionOther) && filled(fate, fateOther)));

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    const text = (v) => (typeof v === "string" && v.trim() ? v : null);
    const body = {
      client_id: clientId,
      entry_id: entry.id,
      reason_code: reason,
      reason_text: text(reasonText),
      ...(tick ? { done: true } : { value_c: num }),
      ...(!sameCheck ? { check_id: target.id } : {}),
      ...(receiving ? { product_type: productType } : {}),
      ...(out && action ? { action_code: action, action_other: action === "other" ? text(actionOther) : null } : {}),
      ...(out && fate ? { fate_code: fate, fate_other: fate === "other" ? text(fateOther) : null } : {}),
      ...(out && text(note) ? { action_note: note } : {}),
    };
    try {
      const res = await api.post("/egenkontrol/corrections", body);
      onSaved?.(res?.data || null);
    } catch (err) {
      const code = errorCode(err);
      setError(t(EK_ERROR_KEYS[code] || "ekErrSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const officialDate = entry?.source === "paper" ? entry.paper_measured_local_date : entry?.recorded_local_date;
  const officialTime = entry?.source === "paper" ? entry.paper_measured_local : entry?.recorded_local;

  return (
    <Sheet
      onClose={onClose}
      desktop="top"
      ariaLabel={t("ekCorrectTitle")}
      panelClassName="bg-white dark:bg-gray-900 border-t sm:border border-gray-200 dark:border-gray-700"
    >
      <div className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-gray-100 dark:border-gray-800">
        <h2 className="min-w-0 flex-1 text-[17px] font-semibold text-gray-900 dark:text-gray-50">{t("ekCorrectTitle")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          className="shrink-0 w-10 h-10 -mr-2 inline-flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4" data-testid="ek-correction">
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-[14px]" data-testid="ek-correction-original">
          <p className="font-semibold text-gray-900 dark:text-gray-100">{entry?.check_name || original.name}</p>
          <p className="text-gray-700 dark:text-gray-300">
            <span className="font-display tabular-nums font-semibold">{valueText(entry, t, lang)}</span>
            {" · "}
            {[officialDate, officialTime].filter(Boolean).join(" ")}
            {entry?.staff_name ? ` · ${entry.staff_name} (${t(nameNoteKey(entry.name_source, entry.via))})` : ""}
          </p>
        </div>
        <p className="text-[14px] text-gray-700 dark:text-gray-300" data-testid="ek-correct-intro">{t("ekCorrectIntro")}</p>

        <fieldset>
          <legend className={LEGEND}>{t("ekCorrectReasonQ")}</legend>
          <div className="flex flex-wrap gap-2">
            {reasons.map((code) => (
              <Chip key={code} className="h-10" selected={reason === code} onClick={() => setReason(code)}>
                {t(EK_CORRECTION_REASON_KEYS[code])}
              </Chip>
            ))}
          </div>
          {reason === "other" ? (
            <input
              type="text"
              className={FIELD + " mt-2"}
              value={reasonText}
              maxLength={CORRECTION_REASON_MAX}
              placeholder={t("ekCorrectReasonPlaceholder")}
              aria-label={t("ekCorrectReasonPlaceholder")}
              onChange={(e) => setReasonText(e.target.value)}
              data-testid="ek-correct-reason-text"
            />
          ) : null}
        </fieldset>

        {reason === "wrong_check" || (tick && reason === "other") ? (
          <div>
            <label htmlFor="ek-correct-check" className={LEGEND + " block"}>{t("ekCorrectCheck")}</label>
            <select id="ek-correct-check" className={FIELD} value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="ek-correct-check">
              <option value={original.id}>{original.name}</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {!tick && (reason === "typo" || reason === "other") ? (
          <>
            {receiving ? (
              <fieldset>
                <legend className={LEGEND}>{t("ekChooseProduct")}</legend>
                <div className="flex flex-wrap gap-2">
                  {(target.product_limits || []).map((p) => (
                    <Chip key={p.product_type} className="h-10" selected={productType === p.product_type} onClick={() => setProductType(p.product_type)}>
                      {t(EK_PRODUCT_KEYS[p.product_type] || "ekProductChilled")}
                    </Chip>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <Keypad
              entry={value}
              onKey={(k) => setValue((e) => nextEntry(e, k))}
              lang={lang}
              t={t}
              hint={
                typeof num === "number" && limit ? (
                  <CheckStatusPill tone={out ? "bad" : "ok"} variant="text">
                    {out ? t(limit.direction === "min" ? "ekTooCold" : "ekTooWarm") : t("ekInLimit")}
                  </CheckStatusPill>
                ) : null
              }
              idPrefix="ek-correct"
            />
          </>
        ) : null}

        {needsAnswers ? (
          <>
            <Choice
              legend={t("ekWhatDidYouDo")}
              codes={Array.isArray(target.action_codes) && target.action_codes.length ? target.action_codes : ["other"]}
              keys={EK_ACTION_KEYS}
              value={action}
              onChange={setAction}
              other={actionOther}
              onOther={setActionOther}
              placeholder={t("ekOtherActionPlaceholder")}
              t={t}
              testId="ek-correct-action"
            />
            <Choice
              legend={t("ekWhatHappenedFood")}
              codes={Array.isArray(target.fate_codes) && target.fate_codes.length ? target.fate_codes : ["other"]}
              keys={EK_FATE_KEYS}
              value={fate}
              onChange={setFate}
              other={fateOther}
              onOther={setFateOther}
              placeholder={t("ekOtherFatePlaceholder")}
              t={t}
              testId="ek-correct-fate"
            />
            <div>
              <label htmlFor="ek-correct-note" className={LEGEND + " block"}>{t("ekNoteLabel")}</label>
              <textarea id="ek-correct-note" rows={2} className={FIELD + " py-2"} value={note} maxLength={ACTION_NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
            </div>
          </>
        ) : null}
      </div>
      <div className="px-4 sm:px-5 pt-3 pb-4 border-t border-gray-100 dark:border-gray-800" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))" }}>
        {error ? <p role="alert" className="mb-2 text-[13.5px] text-red-700 dark:text-red-400">{error}</p> : null}
        {typeof num === "number" && valueChanged ? (
          <p className="mb-2 text-[14px] text-gray-700 dark:text-gray-300 font-display tabular-nums" data-testid="ek-correct-preview">
            {formatTemp(entry?.value_c, lang)} → {formatTemp(num, lang)}
          </p>
        ) : null}
        <Button variant="primary" className="h-10" busy={busy} disabled={!ready || busy} onClick={save} data-testid="ek-correct-save">
          {t("ekCorrectSave")}
        </Button>
      </div>
    </Sheet>
  );
}
