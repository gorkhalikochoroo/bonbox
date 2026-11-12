/**
 * The owner's empty state: "Tilføj jeres første køleskab" — the start list,
 * five items ticked (Køl 1, Frost 1, Varmholdelse, Genopvarmning,
 * Varemodtagelse), "+ Køl mere" for Køl 2…, and ONE frequency question for
 * fridges and freezers ("Hver dag kl. 08:00" / "1 gang om ugen", mandag).
 *
 * Every limit shows where it comes from (Decision 2): "Fra loven (BEK nr.
 * 1331/2025)", "Startværdi fra Fødevarestyrelsens eksempel" — never a claim
 * that the law sets a value it does not. The values come from the server's
 * start list (GET /egenkontrol/templates); nothing is hard-coded here.
 *
 * Never "Alt er klaret", never "100 %": a venue with no checks has not done
 * anything yet, and the page says how to start.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import Button from "../ui/Button";
import Chip from "../ui/Chip";
import api from "../../services/api";
import {
  EK_PRODUCT_KEYS,
  EK_SOURCE_KEYS,
  cutoffLabel,
  errorCode,
  formatTemp,
  startItemName,
  weekdayName,
} from "./ekLogic";

const START = [
  { template_key: "fridge", n: 1 },
  { template_key: "freezer", n: 1 },
  { template_key: "hot_holding", n: 1 },
  { template_key: "reheating", n: 1 },
  { template_key: "receiving", n: 1 },
];

export default function SetupFromStartList({ templates = [], cutoffHour = 6, branchId = null, onCreated, t, lang = "da" }) {
  const byKey = Object.fromEntries((templates || []).map((tp) => [tp.key, tp]));
  const [items, setItems] = useState(() => START.map((s, i) => ({ ...s, uid: `s${i}`, on: true })));
  const [freq, setFreq] = useState("daily");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fridgeDue = byKey.fridge?.schedule_default?.due || "08:00";
  const chosen = items.filter((i) => i.on && byKey[i.template_key]);

  const scheduleFor = (key) => {
    const tp = byKey[key];
    if (!tp) return null;
    if (key === "fridge" || key === "freezer") {
      const due = tp.schedule_default?.due || fridgeDue;
      return freq === "weekly" ? { type: "weekly", weekday: 0, due } : { type: "daily", due };
    }
    return null; // the server's own default (hot holding daily 12:00, the rest on_event)
  };

  const scheduleText = (key) => {
    const tp = byKey[key];
    if (key === "receiving") return t("ekFreqOnEventReceiving");
    if (key === "reheating") return t("ekFreqOnEventReheating");
    const s = scheduleFor(key) || tp?.schedule_default || {};
    if (s.type === "weekly") return t("ekFreqWeeklyOn", { weekday: weekdayName(s.weekday ?? 0, lang), time: s.due });
    if (s.type === "daily") return t("ekFreqDaily", { time: s.due });
    return t("ekFreqOnEvent");
  };

  const addFridge = () => {
    setItems((list) => {
      const n = Math.max(0, ...list.filter((i) => i.template_key === "fridge").map((i) => i.n)) + 1;
      let at = -1;
      list.forEach((i, idx) => {
        if (i.template_key === "fridge") at = idx;
      });
      const item = { template_key: "fridge", n, uid: `f${n}-${list.length}`, on: true };
      const next = [...list];
      next.splice(at >= 0 ? at + 1 : 0, 0, item);
      return next;
    });
  };

  const submit = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        items: chosen.map((i) => {
          const s = scheduleFor(i.template_key);
          return { template_key: i.template_key, name: startItemName(i, t), ...(s ? { schedule: s } : {}) };
        }),
        ...(branchId ? { branch_id: branchId } : {}),
      };
      const res = await api.post("/egenkontrol/setup", body);
      onCreated?.(res?.data?.checks || []);
    } catch (err) {
      const code = errorCode(err);
      if (code === "already_set_up") {
        onCreated?.([]);
        return;
      }
      if (err?.response?.status === 402) setError(t("ekCapReached"));
      else if (code === "due_before_day_start") setError(t("ekDueBeforeDayStart", { cutoff: cutoffLabel(cutoffHour) }));
      else setError(t("ekErrSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-6" data-testid="ek-setup">
      <h2 className="text-[20px] font-semibold text-gray-900 dark:text-gray-50">{t("ekEmptyTitle")}</h2>
      <p className="mt-1 text-[15px] text-gray-600 dark:text-gray-400">{t("ekEmptyBody")}</p>

      <h3 className="mt-5 text-[13px] font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">{t("ekSetupTitle")}</h3>
      <ul className="mt-2 rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
        {items.map((i) => {
          const tp = byKey[i.template_key];
          if (!tp) return null;
          const id = `ek-setup-${i.uid}`;
          return (
            <li key={i.uid} className="px-3 py-3 flex items-start gap-3">
              <input
                id={id}
                type="checkbox"
                checked={i.on}
                onChange={() => setItems((list) => list.map((x) => (x.uid === i.uid ? { ...x, on: !x.on } : x)))}
                className="mt-1 h-5 w-5 shrink-0 rounded border-gray-300 accent-gray-900 dark:accent-gray-100"
              />
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-[15px] font-semibold text-gray-900 dark:text-gray-100">{startItemName(i, t)}</span>
                {tp.limit ? (
                  <span className="block text-[13.5px] text-gray-600 dark:text-gray-400">
                    <span className="font-display tabular-nums">
                      {t(tp.limit.direction === "min" ? "ekLimitMin" : "ekLimitMax", { value: formatTemp(tp.limit.limit_c, lang) })}
                    </span>
                    {" · "}
                    {t(EK_SOURCE_KEYS[tp.limit.source] || "ekSourceOwner")}
                  </span>
                ) : null}
                {Array.isArray(tp.product_limits)
                  ? tp.product_limits.map((p) => (
                      <span key={p.product_type} className="block text-[13.5px] text-gray-600 dark:text-gray-400">
                        <span className="font-display tabular-nums">
                          {t(EK_PRODUCT_KEYS[p.product_type])} ≤ {formatTemp(p.limit_c, lang)}
                        </span>
                        {" · "}
                        {t(EK_SOURCE_KEYS[p.source] || "ekSourceOwner")}
                      </span>
                    ))
                  : null}
                <span className="block text-[13.5px] text-gray-500 dark:text-gray-400">{scheduleText(i.template_key)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={addFridge}
        className="mt-2 h-10 px-3 inline-flex items-center gap-1.5 rounded-lg text-[14px] font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <Plus className="w-4 h-4" aria-hidden="true" />
        {t("ekAddFridge")}
      </button>

      <fieldset className="mt-5">
        <legend className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 mb-2">{t("ekSetupFrequencyQ")}</legend>
        <div className="flex flex-wrap gap-2">
          <Chip className="h-10" selected={freq === "daily"} onClick={() => setFreq("daily")}>
            {t("ekFreqDaily", { time: fridgeDue })}
          </Chip>
          <Chip className="h-10" selected={freq === "weekly"} onClick={() => setFreq("weekly")}>
            {t("ekFreqWeekly")}
          </Chip>
        </div>
        <p className="mt-2 text-[13.5px] text-gray-600 dark:text-gray-400">{t("ekSetupMissedNote")}</p>
      </fieldset>

      <p className="mt-4 text-[13.5px] text-gray-600 dark:text-gray-400">{t("ekStartValuesNote")}</p>

      {error ? (
        <p role="alert" className="mt-3 text-[14px] text-red-700 dark:text-red-400">{error}</p>
      ) : null}
      <Button variant="main" className="mt-4 w-full sm:w-auto h-10" busy={busy} disabled={!chosen.length || busy} onClick={submit}>
        {t("ekSetupAdd", { count: chosen.length })}
      </Button>
    </div>
  );
}
