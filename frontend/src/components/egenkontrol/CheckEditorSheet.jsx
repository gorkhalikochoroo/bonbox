/**
 * Redigér / tilføj et kontrolpunkt (owner only — the server 403s every other
 * seat, and a curtained shared device needs the reveal PIN).
 *
 * Every change except the order writes a NEW revision on the server, so last
 * month's Kontrolmappe keeps the rule that was in force then. A limit that
 * differs from the start value is shown as "jeres egen grænse" — never as the
 * law. A due time before the venue's day starts is caught here with the
 * server's own cutoff, and the server's 422 stays the truth.
 *
 * "Fjern fra listen" archives (one-way in R1a): the readings stay in the
 * Kontrolmappe and a check with readings is never deleted.
 *
 * R1b: a tick (Rengøring, Termometertjek) has no limit, no schedule (always
 * "når det sker") and no re-check — the sheet shows only its name and note.
 * Adding a check or switching one back on over the plan's limit is a 402:
 * the upgrade sheet on the web, the plain words in the app; every existing
 * check keeps recording.
 */
import { useState } from "react";
import { X } from "lucide-react";
import Sheet from "../ui/Sheet";
import Button from "../ui/Button";
import Chip from "../ui/Chip";
import api from "../../services/api";
import { useConfirm } from "../../hooks/useConfirm";
import CapPrompt, { capUpgradeTo } from "./CapPrompt";
import {
  CHECK_NAME_MAX,
  CHECK_NOTE_MAX,
  EK_PRODUCT_KEYS,
  EK_SOURCE_KEYS,
  EK_TEMPLATE_KEYS,
  PRODUCT_TYPES,
  RECHECK_MIN_RANGE,
  cutoffLabel,
  dueBeforeDayStart,
  errorCode,
  formatTemp,
  isHhmm,
  parseLimitInput,
  weekdayName,
} from "./ekLogic";

const FIELD =
  "w-full h-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 text-[15px] " +
  "text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400";
const LABEL = "block text-[13.5px] font-semibold text-gray-800 dark:text-gray-200 mb-1";

const asInput = (v, lang) => {
  if (v == null || v === "") return "";
  const s = Number(v).toFixed(1);
  return lang === "da" ? s.replace(".", ",") : s;
};

export default function CheckEditorSheet({
  check = null,
  templateKey = null,
  templates = [],
  cutoffHour = 6,
  branchId = null,
  defaultName = "",
  onSaved,
  onClose,
  t,
  lang = "da",
}) {
  const confirm = useConfirm();
  const isNew = !check;
  const key = check?.template_key || templateKey;
  const tpl = (templates || []).find((x) => x.key === key) || null;
  const receiving = key === "receiving";
  const tick = check?.kind === "tick" || tpl?.kind === "tick" || key === "cleaning" || key === "thermometer";
  const options = check?.schedule_options || tpl?.schedule_options || ["on_event"];
  const startSchedule = check?.schedule || tpl?.schedule_default || { type: options[0] || "on_event" };
  const productStart = Object.fromEntries(
    PRODUCT_TYPES.map((p) => {
      const cur = (check?.product_limits || tpl?.product_limits || []).find((x) => x.product_type === p);
      return [p, asInput(cur?.limit_c, lang)];
    }),
  );

  const [name, setName] = useState(check?.name || defaultName || "");
  const [note, setNote] = useState(check?.note || "");
  const [limit, setLimit] = useState(asInput((check?.limit || tpl?.limit)?.limit_c, lang));
  const [products, setProducts] = useState(productStart);
  const [type, setType] = useState(startSchedule.type || "on_event");
  const [due, setDue] = useState(startSchedule.due || tpl?.schedule_default?.due || "08:00");
  const [weekday, setWeekday] = useState(Number.isInteger(startSchedule.weekday) ? startSchedule.weekday : 0);
  const [recheck, setRecheck] = useState(String(check?.recheck_min ?? tpl?.recheck_min ?? 30));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [capOpen, setCapOpen] = useState(false);
  const [capTo, setCapTo] = useState(null);

  const tplLimit = tpl?.limit?.limit_c;
  const limitNum = parseLimitInput(limit);
  const ownLimit = !receiving && limitNum != null && tplLimit != null && Number(limitNum) !== Number(tplLimit);
  const curSource = check?.limit?.source || tpl?.limit?.source;
  const dueEarly = type !== "on_event" && dueBeforeDayStart(due, cutoffHour);

  const productNums = Object.fromEntries(PRODUCT_TYPES.map((p) => [p, parseLimitInput(products[p])]));
  const recheckNum = Number(recheck);
  const valid =
    name.trim().length > 0 &&
    name.length <= CHECK_NAME_MAX &&
    note.length <= CHECK_NOTE_MAX &&
    (receiving ? PRODUCT_TYPES.every((p) => productNums[p] != null) : limitNum != null || tplLimit == null) &&
    (type === "on_event" || (isHhmm(due) && !dueEarly)) &&
    Number.isInteger(recheckNum) &&
    recheckNum >= RECHECK_MIN_RANGE[0] &&
    recheckNum <= RECHECK_MIN_RANGE[1];

  const schedule = type === "weekly" ? { type, weekday, due } : type === "daily" ? { type, due } : { type: "on_event" };

  const fail = (err) => {
    const code = errorCode(err);
    if (err?.response?.status === 402) {
      setError(t("ekCapReached"));
      setCapTo(capUpgradeTo(err));
      setCapOpen(true);
    } else if (code === "due_before_day_start") setError(t("ekDueBeforeDayStart", { cutoff: cutoffLabel(err?.response?.data?.detail?.cutoff_hour ?? cutoffHour) }));
    // An open deviation must be finished before the check is switched off.
    else if (code === "open_deviation") setError(t("ekErrOpenDeviation"));
    // Ticks never hit the plan's limit (no 402); only the flat abuse ceiling.
    else if (code === "too_many_ticks") setError(t("ekErrTooManyTicks"));
    else setError(t("ekErrSaveFailed"));
  };

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      let res;
      if (isNew) {
        const body = {
          template_key: key,
          name,
          ...(note.trim() ? { note } : {}),
          ...(receiving ? { product_limits: productNums } : limitNum != null ? { limit_c: limitNum } : {}),
          schedule,
          recheck_min: recheckNum,
          ...(branchId ? { branch_id: branchId } : {}),
        };
        res = await api.post("/egenkontrol/checks", body);
      } else {
        // Only what changed: an unchanged field must not mint a revision.
        const body = {};
        if (name !== check.name) body.name = name;
        if ((note || "") !== (check.note || "")) body.note = note;
        if (!receiving && limitNum != null && Number(limitNum) !== Number(check.limit?.limit_c)) body.limit_c = limitNum;
        if (receiving) {
          const changed = PRODUCT_TYPES.some((p) => {
            const cur = (check.product_limits || []).find((x) => x.product_type === p);
            return Number(productNums[p]) !== Number(cur?.limit_c);
          });
          if (changed) body.product_limits = productNums;
        }
        const s0 = check.schedule || {};
        if (s0.type !== schedule.type || (s0.due || null) !== (schedule.due || null) || (s0.weekday ?? null) !== (schedule.weekday ?? null)) {
          body.schedule = schedule;
        }
        if (recheckNum !== Number(check.recheck_min)) body.recheck_min = recheckNum;
        if (!Object.keys(body).length) {
          onClose?.();
          return;
        }
        res = await api.patch(`/egenkontrol/checks/${encodeURIComponent(check.id)}`, body);
      }
      onSaved?.(res?.data);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    if (!check || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.patch(`/egenkontrol/checks/${encodeURIComponent(check.id)}`, { active: !check.active });
      onSaved?.(res?.data);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!check || busy) return;
    const ok = await confirm({
      title: t("ekArchiveConfirmTitle", { name: check.name }),
      message: t("ekArchiveConfirmBody"),
      confirmLabel: t("ekArchive"),
      cancelLabel: t("cancel"),
      destructive: true,
    });
    if (ok !== true) return;
    setBusy(true);
    try {
      const res = await api.post(`/egenkontrol/checks/${encodeURIComponent(check.id)}/archive`, {});
      onSaved?.(res?.data);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Sheet
      onClose={onClose}
      ariaLabel={isNew ? t("ekAddCheck") : t("ekEditCheck")}
      panelClassName="bg-white dark:bg-gray-900 border-t sm:border border-gray-200 dark:border-gray-700"
    >
      <div className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-gray-100 dark:border-gray-800">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t(EK_TEMPLATE_KEYS[key] || "ekTplFridge")}
          </p>
          <h2 className="text-[17px] font-semibold text-gray-900 dark:text-gray-50">{isNew ? t("ekAddCheck") : t("ekEditCheck")}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          className="shrink-0 w-10 h-10 -mr-2 inline-flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4" data-testid="ek-editor">
        <div>
          <label htmlFor="ek-ed-name" className={LABEL}>{t("ekFieldName")}</label>
          <input id="ek-ed-name" className={FIELD} value={name} maxLength={CHECK_NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ek-ed-note" className={LABEL}>{t("ekFieldNote")}</label>
          <input id="ek-ed-note" className={FIELD} value={note} maxLength={CHECK_NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
        </div>

        {tick ? null : receiving ? (
          <fieldset>
            <legend className={LABEL}>{t("ekFieldLimit")}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {PRODUCT_TYPES.map((p) => {
                const tp = (tpl?.product_limits || []).find((x) => x.product_type === p);
                const own = productNums[p] != null && tp && Number(productNums[p]) !== Number(tp.limit_c);
                return (
                  <div key={p}>
                    <label htmlFor={`ek-ed-p-${p}`} className="block text-[13px] text-gray-700 dark:text-gray-300 mb-1">{t(EK_PRODUCT_KEYS[p])}</label>
                    <input
                      id={`ek-ed-p-${p}`}
                      className={FIELD + " font-display tabular-nums"}
                      inputMode="decimal"
                      value={products[p]}
                      onChange={(e) => setProducts((x) => ({ ...x, [p]: e.target.value }))}
                    />
                    <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
                      {t(own ? "ekSourceOwner" : EK_SOURCE_KEYS[tp?.source] || "ekSourceOwner")}
                    </p>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ) : tplLimit != null || check?.limit ? (
          <div>
            <label htmlFor="ek-ed-limit" className={LABEL}>{t("ekFieldLimit")}</label>
            <input
              id="ek-ed-limit"
              className={FIELD + " font-display tabular-nums"}
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              aria-invalid={limitNum == null}
            />
            <p className="mt-1 text-[12.5px] text-gray-600 dark:text-gray-400">
              {limitNum == null
                ? t("ekOutOfRange")
                : ownLimit
                  ? t("ekOwnLimitNote")
                  : `${t((check?.limit || tpl?.limit)?.direction === "min" ? "ekLimitMin" : "ekLimitMax", { value: formatTemp(limitNum, lang) })} · ${t(EK_SOURCE_KEYS[curSource] || "ekSourceOwner")}`}
            </p>
          </div>
        ) : null}

        {tick ? (
          <p className="text-[13.5px] text-gray-600 dark:text-gray-400">{t("ekTickEditorNote")}</p>
        ) : (
        <fieldset>
          <legend className={LABEL}>{t("ekFieldSchedule")}</legend>
          <div className="flex flex-wrap gap-2">
            {options.includes("daily") ? (
              <Chip className="h-10" selected={type === "daily"} onClick={() => setType("daily")}>
                {t("ekFreqDaily", { time: due })}
              </Chip>
            ) : null}
            {options.includes("weekly") ? (
              <Chip className="h-10" selected={type === "weekly"} onClick={() => setType("weekly")}>
                {t("ekFreqWeekly")}
              </Chip>
            ) : null}
            {options.includes("on_event") ? (
              <Chip className="h-10" selected={type === "on_event"} onClick={() => setType("on_event")}>
                {t(key === "receiving" ? "ekFreqOnEventReceiving" : key === "reheating" ? "ekFreqOnEventReheating" : "ekFreqOnEvent")}
              </Chip>
            ) : null}
          </div>
          {type !== "on_event" ? (
            <div className="mt-3 flex flex-wrap gap-3">
              {type === "weekly" ? (
                <div>
                  <label htmlFor="ek-ed-weekday" className="block text-[13px] text-gray-700 dark:text-gray-300 mb-1">{t("ekFreqWeekly")}</label>
                  <select id="ek-ed-weekday" className={FIELD + " w-44"} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                    {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                      <option key={d} value={d}>{weekdayName(d, lang)}</option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label htmlFor="ek-ed-due" className="block text-[13px] text-gray-700 dark:text-gray-300 mb-1">{t("ekFieldSchedule")}</label>
                <input id="ek-ed-due" type="time" className={FIELD + " w-32 font-display tabular-nums"} value={due} onChange={(e) => setDue(e.target.value)} aria-invalid={dueEarly} />
              </div>
            </div>
          ) : null}
          {type !== "on_event" ? (
            <p className="mt-1 text-[12.5px] text-gray-600 dark:text-gray-400">
              {type === "weekly"
                ? t("ekFreqWeeklyOn", { weekday: weekdayName(weekday, lang), time: due })
                : t("ekFreqDaily", { time: due })}
            </p>
          ) : null}
          {dueEarly ? (
            <p role="alert" className="mt-1 text-[13px] text-red-700 dark:text-red-400">
              {t("ekDueBeforeDayStart", { cutoff: cutoffLabel(cutoffHour) })}
            </p>
          ) : null}
        </fieldset>
        )}

        <div className={tick ? "hidden" : ""}>
          <label htmlFor="ek-ed-recheck" className={LABEL}>{t("ekFieldRecheck")}</label>
          <input
            id="ek-ed-recheck"
            className={FIELD + " w-28 font-display tabular-nums"}
            inputMode="numeric"
            value={recheck}
            onChange={(e) => setRecheck(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          />
        </div>
      </div>

      <div className="px-4 sm:px-5 pt-3 pb-4 border-t border-gray-100 dark:border-gray-800" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))" }}>
        {error ? <p role="alert" className="mb-2 text-[13.5px] text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" className="h-10" busy={busy} disabled={!valid || busy} onClick={save}>
            {t("ekSave")}
          </Button>
          {!isNew ? (
            <>
              <Button variant="secondary" className="h-10" disabled={busy} onClick={toggleActive}>
                {check.active ? t("ekSwitchOff") : t("ekSwitchOn")}
              </Button>
              <Button variant="ghost" className="h-10 text-red-700 dark:text-red-400" disabled={busy} onClick={archive}>
                {t("ekArchive")}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </Sheet>
    <CapPrompt open={capOpen} upgradeTo={capTo} onClose={() => setCapOpen(false)} />
    </>
  );
}
