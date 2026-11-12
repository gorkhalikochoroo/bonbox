/**
 * "Registrér" — one reading for one check. Shared by the kitchen iPad (right
 * column in landscape, a Sheet in portrait) and the owner's Målinger tab.
 * API-agnostic: the parent passes onSave(body, draft) → { ok, entry } |
 * { ok: false, kind, code, missing }, so the same panel saves through the
 * kitchen token or the owner session.
 *
 * Order on screen: (receiving) product type, product + supplier, label check
 * → keypad → (out of limit) "Hvad gjorde I?" + "Hvad skete der med maden?" +
 * note → (follow-up on an open deviation) closing fates only → "Hvem målte?"
 * → ONE button whose words say what is still missing (ekLogic.ctaFor).
 *
 * The in/out-of-limit colour while typing is a hint; the server decides.
 * A value that is unusual for the check ("51" on a fridge) is asked about
 * once, through useConfirm — never window.confirm.
 */
import { useState } from "react";
import { X } from "lucide-react";
import Button from "../ui/Button";
import Chip from "../ui/Chip";
import CheckStatusPill from "../ui/CheckStatusPill";
import { useConfirm } from "../../hooks/useConfirm";
import Keypad from "./Keypad";
import NamePicker from "./NamePicker";
import {
  ACTION_NOTE_MAX,
  EK_ACTION_KEYS,
  EK_ERROR_KEYS,
  EK_FATE_KEYS,
  EK_PRODUCT_KEYS,
  OTHER_TEXT_MAX,
  PRODUCT_NOTE_MAX,
  buildEntryBody,
  closingFates,
  ctaFor,
  followupNeedsFate,
  formatTemp,
  inRange,
  isPlausible,
  limitFor,
  limitLine,
  newClientId,
  nextEntry,
  parseEntry,
  receivingSourceLine,
  sourceLine,
  withinLimit,
} from "./ekLogic";

const BIG = "min-h-14! px-4 text-base";
const INPUT =
  "w-full min-h-14! rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-4 text-base " +
  "text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400";

function ChoiceRow({ legend, codes, keys, value, onChange, other, onOther, otherPlaceholder, highlight, t, idPrefix, name }) {
  const otherId = `${idPrefix}-${name}-other`;
  return (
    <fieldset className="min-w-0" data-testid={`ek-${name}-row`}>
      <legend className={`text-[15px] font-semibold mb-2 ${highlight ? "text-red-700 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>
        {legend}
      </legend>
      <div className="flex flex-wrap gap-2">
        {codes.map((code) => (
          <Chip key={code} className={BIG} selected={value === code} onClick={() => onChange(value === code ? null : code)}>
            {t(keys[code] || keys.other)}
          </Chip>
        ))}
      </div>
      {value === "other" ? (
        <div className="mt-2">
          <label htmlFor={otherId} className="sr-only">{otherPlaceholder}</label>
          <input
            id={otherId}
            type="text"
            className={INPUT}
            value={other}
            maxLength={OTHER_TEXT_MAX}
            placeholder={otherPlaceholder}
            onChange={(e) => onOther(e.target.value.slice(0, OTHER_TEXT_MAX))}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

export default function RecordPanel({
  check,
  staff = [],
  heldWho = null,
  onSave,
  onClose = null,
  draft = null,
  t,
  lang = "da",
  idPrefix = "ek",
}) {
  const confirm = useConfirm();
  const d = draft?.state || {};
  const [entry, setEntry] = useState(d.entry || "");
  const [productType, setProductType] = useState(d.productType || null);
  const [productNote, setProductNote] = useState(d.productNote || "");
  const [labelOk, setLabelOk] = useState(typeof d.labelOk === "boolean" ? d.labelOk : null);
  const [action, setAction] = useState(d.action || null);
  const [actionOther, setActionOther] = useState(d.actionOther || "");
  const [fate, setFate] = useState(d.fate || null);
  const [fateOther, setFateOther] = useState(d.fateOther || "");
  const [note, setNote] = useState(d.note || "");
  // staff_gone: the name this reading was saved with is no longer on the list,
  // so the person has to choose again — never the stale name, never the held one.
  const staffGone = draft?.code === "staff_gone";
  const [localWho, setLocalWho] = useState(staffGone ? null : d.who || null);
  // Once the person deselects a name or opens "Andet navn", the held name of
  // the 2-minute round no longer applies inside this panel.
  const [whoCleared, setWhoCleared] = useState(staffGone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(draft?.code ? { code: draft.code, missing: draft.missing || [] } : null);
  const [retryClientId, setRetryClientId] = useState(draft?.clientId || null);
  const [confirmedValue, setConfirmedValue] = useState(null);
  const [pickerKey, setPickerKey] = useState(0);

  const receiving = check?.kind === "receiving" || check?.template_key === "receiving";
  const value = parseEntry(entry);
  const limit = limitFor(check, productType);
  const out = typeof value === "number" && inRange(value) && !!limit && !withinLimit(value, limit);
  const followup = typeof value === "number" && inRange(value) && followupNeedsFate(check, value, limit);
  const who = localWho || (whoCleared ? null : heldWho) || null;
  const pickWho = (v) => {
    setLocalWho(v);
    if (!v) setWhoCleared(true);
  };
  const actions = Array.isArray(check?.action_codes) ? check.action_codes : [];
  const allFates = Array.isArray(check?.fate_codes) ? check.fate_codes : [];
  const fates = followup && !out ? closingFates(allFates) : allFates;

  const cta = ctaFor({
    kind: receiving ? "receiving" : check?.kind,
    productType,
    value,
    limit,
    action,
    actionOther,
    fate: fates.includes(fate) ? fate : null,
    fateOther,
    followup,
    who,
    saving,
    lang,
  });

  const missing = new Set(error?.missing || []);
  if (error?.code === "followup_fate_required") missing.add("fate");
  if (error?.code === "name_required" || error?.code === "name_invalid" || error?.code === "staff_gone") missing.add("name");

  const reset = () => {
    setEntry("");
    setProductType(null);
    setProductNote("");
    setLabelOk(null);
    setAction(null);
    setActionOther("");
    setFate(null);
    setFateOther("");
    setNote("");
    setLocalWho(null);
    setWhoCleared(false);
    setError(null);
    setRetryClientId(null);
    setConfirmedValue(null);
    setPickerKey((k) => k + 1);
  };

  const submit = async () => {
    if (cta.disabled || saving || !check) return;
    if (!isPlausible(value, check.template_key, productType) && confirmedValue !== value) {
      const shown = formatTemp(value, lang);
      const ok = await confirm({
        title: t("ekPlausibleTitle", { value: shown }),
        message: t("ekPlausibleBody", { check: check.name }),
        confirmLabel: t("ekPlausibleConfirm", { value: shown }),
        cancelLabel: t("ekPlausibleCancel"),
      });
      if (ok !== true) return;
      setConfirmedValue(value);
    }
    const clientId = retryClientId || newClientId();
    const body = buildEntryBody({
      clientId,
      check,
      value,
      productType,
      productNote,
      labelOk,
      action,
      actionOther,
      fate: fates.includes(fate) ? fate : null,
      fateOther,
      note,
      who,
      out,
      followup: followup && !out,
      typedAt: new Date().toISOString(),
    });
    const state = { entry, productType, productNote, labelOk, action, actionOther, fate, fateOther, note, who };
    setSaving(true);
    setError(null);
    let res;
    try {
      res = await onSave(body, { clientId, checkId: check.id, state });
    } catch {
      res = { ok: false, kind: "failed" };
    }
    setSaving(false);
    if (res?.ok || res?.kind === "failed" || res?.kind === "revoked" || res?.kind === "closed") {
      // Saved — or kept on the row as "Ikke gemt endnu" with its client_id.
      reset();
      return;
    }
    setRetryClientId(clientId);
    if (res?.code === "staff_gone") {
      setLocalWho(null);
      setWhoCleared(true);
      setPickerKey((k) => k + 1);
    }
    setError({ code: res?.code || null, missing: res?.missing || [] });
  };

  if (!check) return null;
  const errorKey = error ? EK_ERROR_KEYS[error.code] || "ekErrSaveFailed" : null;

  let hint = null;
  if (typeof value === "number") {
    if (!inRange(value)) {
      hint = <CheckStatusPill tone="bad" variant="text">{t("ekOutOfRange")}</CheckStatusPill>;
    } else if (limit) {
      hint = out ? (
        <CheckStatusPill tone="bad" variant="text">
          <strong>{t(limit.direction === "min" ? "ekTooCold" : "ekTooWarm")}</strong>
        </CheckStatusPill>
      ) : (
        <CheckStatusPill tone="ok" variant="text">{t("ekInLimit")}</CheckStatusPill>
      );
    }
  }

  const od = check.open_deviation;
  // Every limit shows its source; receiving before a type is chosen lists all three.
  const source = receiving ? (limit ? sourceLine(limit, t) : receivingSourceLine(check, t)) : sourceLine(check.limit, t);

  return (
    <div className="flex flex-col min-h-0" data-testid="ek-record-panel">
      <div className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-gray-100 dark:border-gray-800">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("ekRecord")}</p>
          <h2 className="text-[20px] font-semibold text-gray-900 dark:text-gray-50 truncate">
            {check.name}
            {check.note ? <span className="ml-2 text-[15px] font-normal text-gray-500 dark:text-gray-400">{check.note}</span> : null}
          </h2>
          <p className="text-[14px] text-gray-600 dark:text-gray-400">
            <span className="font-display tabular-nums">{receiving && limit ? limitLine({ ...check, product_limits: [limit] }, t, lang) : limitLine(check, t, lang)}</span>
            {source ? <span> · {source}</span> : null}
          </p>
          {od ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <CheckStatusPill tone="bad">{t("ekStatusDeviationOpen")}</CheckStatusPill>
              {od.recheck_due_local ? (
                <span className="text-[14px] text-gray-700 dark:text-gray-300 font-display tabular-nums">{t("ekRecheckBy", { time: od.recheck_due_local })}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="shrink-0 w-14 h-14 -mr-2 -mt-1 inline-flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="w-6 h-6" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4 space-y-5">
        {receiving ? (
          <div className="space-y-3">
            <fieldset className="min-w-0">
              <legend className="text-[15px] font-semibold mb-2 text-gray-900 dark:text-gray-100">{t("ekChooseProduct")}</legend>
              <div className="flex flex-wrap gap-2">
                {(check.product_limits || []).map((p) => (
                  <Chip
                    key={p.product_type}
                    className={BIG}
                    selected={productType === p.product_type}
                    onClick={() => setProductType(productType === p.product_type ? null : p.product_type)}
                  >
                    {t(EK_PRODUCT_KEYS[p.product_type] || "ekProductChilled")}
                    <span className="font-display tabular-nums"> ≤ {formatTemp(p.limit_c, lang)}</span>
                  </Chip>
                ))}
              </div>
            </fieldset>
            <div>
              <label htmlFor={`${idPrefix}-product-note`} className="block text-[15px] font-semibold mb-2 text-gray-900 dark:text-gray-100">
                {t("ekProductNoteLabel")}
              </label>
              <input
                id={`${idPrefix}-product-note`}
                type="text"
                className={INPUT}
                value={productNote}
                maxLength={PRODUCT_NOTE_MAX}
                onChange={(e) => setProductNote(e.target.value.slice(0, PRODUCT_NOTE_MAX))}
              />
            </div>
            <Chip className={BIG} selected={labelOk === true} onClick={() => setLabelOk(labelOk === true ? null : true)}>
              {t("ekLabelOk")}
            </Chip>
          </div>
        ) : null}

        <Keypad
          entry={entry}
          onKey={(k) => {
            setEntry((e) => nextEntry(e, k));
            if (error?.code === "value_out_of_range" || error?.code === "too_many_decimals") setError(null);
          }}
          lang={lang}
          t={t}
          hint={hint}
          idPrefix={idPrefix}
        />

        {out ? (
          <>
            <ChoiceRow
              name="action"
              legend={t("ekWhatDidYouDo")}
              codes={actions}
              keys={EK_ACTION_KEYS}
              value={action}
              onChange={setAction}
              other={actionOther}
              onOther={setActionOther}
              otherPlaceholder={t("ekOtherActionPlaceholder")}
              highlight={missing.has("action")}
              t={t}
              idPrefix={idPrefix}
            />
            <ChoiceRow
              name="fate"
              legend={t("ekWhatHappenedFood")}
              codes={fates}
              keys={EK_FATE_KEYS}
              value={fate}
              onChange={setFate}
              other={fateOther}
              onOther={setFateOther}
              otherPlaceholder={t("ekOtherFatePlaceholder")}
              highlight={missing.has("fate")}
              t={t}
              idPrefix={idPrefix}
            />
            <div>
              <label htmlFor={`${idPrefix}-note`} className="block text-[15px] font-semibold mb-2 text-gray-900 dark:text-gray-100">
                {t("ekNoteLabel")}
              </label>
              <textarea
                id={`${idPrefix}-note`}
                rows={2}
                className={INPUT + " py-3"}
                value={note}
                maxLength={ACTION_NOTE_MAX}
                onChange={(e) => setNote(e.target.value.slice(0, ACTION_NOTE_MAX))}
              />
            </div>
          </>
        ) : followup ? (
          <ChoiceRow
            name="fate"
            legend={t("ekWhatHappenedFood")}
            codes={fates}
            keys={EK_FATE_KEYS}
            value={fate}
            onChange={setFate}
            other={fateOther}
            onOther={setFateOther}
            otherPlaceholder={t("ekOtherFatePlaceholder")}
            highlight={missing.has("fate")}
            t={t}
            idPrefix={idPrefix}
          />
        ) : null}

        <NamePicker
          key={pickerKey}
          staff={staff}
          value={who}
          onChange={pickWho}
          t={t}
          highlight={missing.has("name")}
          idPrefix={idPrefix}
        />
      </div>

      <div className="px-4 sm:px-5 pt-3 pb-4 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))" }}>
        {errorKey ? (
          <p role="alert" className="mb-2 text-[15px] leading-snug text-red-700 dark:text-red-400" data-testid="ek-panel-error">
            {t(errorKey)}
          </p>
        ) : null}
        <Button
          variant="main"
          className="w-full min-h-14! text-[17px]"
          disabled={cta.disabled}
          aria-busy={saving || undefined}
          onClick={submit}
          data-testid="ek-save"
        >
          {t(cta.key, cta.vars || undefined)}
        </Button>
      </div>
    </div>
  );
}
