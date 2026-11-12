/**
 * "Hvem målte?" — chips of the venue's staff (first name + last initial,
 * on-shift first, "På vagt" marker) plus "Andet navn" (a typed name, max 40).
 * Nothing is pre-selected: the value comes from the parent, which starts at
 * none (useNameRound). The line under it says the name is saved with the
 * reading — it is a record, not a login.
 */
import { useState } from "react";
import Chip from "../ui/Chip";
import { TYPED_NAME_MAX } from "./ekLogic";
import { whoLabel } from "./useNameRound";

const BIG = "min-h-14! px-4 text-base";

export default function NamePicker({ staff = [], value = null, onChange, t, disabled = false, highlight = false, idPrefix = "ek" }) {
  const [localOpen, setLocalOpen] = useState(false);
  const [localText, setLocalText] = useState("");
  const typed = value?.kind === "typed";
  const otherOpen = localOpen || typed;
  const text = typed ? value.name : localText;
  const inputId = `${idPrefix}-other-name`;

  return (
    <fieldset className="min-w-0" data-testid="ek-name-picker">
      <legend className={`text-[15px] font-semibold mb-2 ${highlight ? "text-red-700 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>
        {t("ekWhoMeasured")}
      </legend>
      <div className="flex flex-wrap gap-2">
        {staff.map((s) => {
          const selected = value?.kind === "staff" && value.id === s.id;
          return (
            <Chip
              key={s.id}
              className={BIG}
              selected={selected}
              disabled={disabled}
              onClick={() => {
                setLocalOpen(false);
                onChange(selected ? null : { kind: "staff", id: s.id, label: s.name });
              }}
            >
              <span>{s.name}</span>
              {s.on_shift ? (
                <span className={`ml-1.5 text-[12px] font-normal ${selected ? "opacity-80" : "text-gray-500 dark:text-gray-400"}`}>
                  · {t("ekOnShift")}
                </span>
              ) : null}
            </Chip>
          );
        })}
        <Chip
          className={BIG}
          selected={otherOpen}
          disabled={disabled}
          onClick={() => {
            if (otherOpen) {
              setLocalOpen(false);
              setLocalText("");
              if (typed) onChange(null);
            } else {
              setLocalOpen(true);
              if (value) onChange(null);
            }
          }}
        >
          {t("ekOtherName")}
        </Chip>
      </div>
      {otherOpen ? (
        <div className="mt-2">
          <label htmlFor={inputId} className="sr-only">{t("ekOtherName")}</label>
          <input
            id={inputId}
            type="text"
            value={text}
            maxLength={TYPED_NAME_MAX}
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            placeholder={t("ekOtherNamePlaceholder")}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value.slice(0, TYPED_NAME_MAX);
              setLocalText(v);
              onChange(v.trim() ? { kind: "typed", name: v } : null);
            }}
            className="w-full min-h-14! rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-4 text-base text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>
      ) : null}
      <p className="mt-2 text-[13px] text-gray-500 dark:text-gray-400">{t("ekNameSavedNote")}</p>
    </fieldset>
  );
}

/** "Måler: Ali K. · Skift" while a name is held in the 2-minute round. */
export function MeasurerBar({ held, onClear, t }) {
  if (!held) return null;
  return (
    <div className="inline-flex items-center gap-2 text-[15px] text-gray-700 dark:text-gray-200" data-testid="ek-measurer">
      <span className="truncate">{t("ekKitchenMeasurer", { name: whoLabel(held) })}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onClear}
        className="min-h-14! px-3 -my-3 rounded-lg font-semibold underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        {t("ekKitchenSwitch")}
      </button>
    </div>
  );
}
