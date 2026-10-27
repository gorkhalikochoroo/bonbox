// One chair on the Behandlere tab (R7, 27 Oct 2026 — rubric S12).
//
// Read it, rename it, switch how she is booked, or remove it. The name is
// the one customers see in "Vælg behandler":
//   • the owner's own chair ("Det er mig") renames its label — it used to be
//     the business name, so the guest page listed "Salon Saks" beside "Mia";
//   • a stylist's chair renames the stylist herself — the same name Vagtplan
//     shows (PATCH /reservations/salon/stylists/{id} does both sides).
// A stylist is booked either whenever the salon is open (like the owner's
// own chair; Ferie / Syg still close her day) or on her Vagtplan shifts.
// The owner's own chair always follows the opening hours.
import { useEffect, useRef, useState } from "react";
import { CalendarClock, Clock, Pencil, Scissors, Trash2 } from "lucide-react";
import api from "../../services/api";
import Button from "../ui/Button";

export const STYLIST_NAME_MAX = 80;

// Phone: 40 px icon squares (the compact-controls rule); 44 px from sm: up.
const ICON_BTN =
  "w-11 h-11 max-sm:w-10 max-sm:h-10 max-sm:min-h-0! inline-flex items-center justify-center " +
  "rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 " +
  "hover:text-gray-900 dark:hover:text-gray-100";
// Text inputs stay 16 px on a phone (smaller text zooms iOS on focus).
export const FIELD =
  "w-full h-11 max-sm:h-10 max-sm:min-h-0! px-3 rounded-lg border border-gray-200 dark:border-gray-700 " +
  "bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 " +
  "focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent";
const BADGE =
  "shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md " +
  "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";

/** The owner's own chair: on the opening hours, no staff member. */
export function isOwnChair(r) {
  return !!r && r.kind === "provider" && !!r.follows_opening_hours && !r.staff_id;
}

/** Is the owner's own chair still called after the business? */
export function namedAfterBusiness(r, businessName) {
  const a = String(r?.label || "").trim().toLowerCase();
  const b = String(businessName || "").trim().toLowerCase();
  return isOwnChair(r) && !!a && a === b;
}

/** "  Mia   Holm " → "Mia Holm" (the server tidies the same way). */
export function tidyName(s) {
  return String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
}

/** What an edit changes, as the PATCH body — or why it can't be saved.
 *  `shown` is the name on the row; `draft` = {name, follows}.
 *  → {changes: {...}} (possibly empty) or {error: "name" | "too_long"}. */
export function stylistChanges(r, shown, draft) {
  const name = tidyName(draft.name);
  if (!name) return { error: "name" };
  if (name.length > STYLIST_NAME_MAX) return { error: "too_long" };
  const changes = {};
  if (name !== tidyName(shown)) changes.name = name;
  if (r.staff_id && draft.follows !== undefined && !!draft.follows !== !!r.follows_opening_hours) {
    changes.follows_opening_hours = !!draft.follows;
  }
  return { changes };
}

/** "Kan bookes": the opening hours or her shifts — a two-way radio group. */
export function BookableChoice({ t, value, onChange, name = "stylist-bookable" }) {
  const opts = [
    { v: true, label: t("rsvpStylistModeHours", "When the salon is open"), Icon: Clock },
    { v: false, label: t("rsvpStylistModeShifts", "On their shifts"), Icon: CalendarClock },
  ];
  return (
    <div>
      <p id={`${name}-label`} className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">
        {t("rsvpStylistBookableLabel", "Can be booked")}
      </p>
      <div role="radiogroup" aria-labelledby={`${name}-label`} className="grid grid-cols-2 gap-2">
        {opts.map(({ v, label, Icon }) => {
          const on = value === v;
          return (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange?.(v)}
              className={
                "h-11 max-sm:h-10 max-sm:min-h-0! px-2.5 inline-flex items-center justify-center gap-1.5 rounded-lg border " +
                "text-[13px] font-medium transition-colors min-w-0 " +
                (on
                  ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900 " +
                    // Phone, dark: a raised grey, never the inverted white slab.
                    "max-sm:dark:border-gray-600 max-sm:dark:bg-gray-600 max-sm:dark:text-white"
                  : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100")
              }
            >
              <Icon className="w-4 h-4 shrink-0" strokeWidth={1.75} aria-hidden />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
        {value
          ? t("rsvpStylistModeHoursHint", "Bookable in all your opening hours. A holiday or sick day in the Schedule closes that day.")
          : t("rsvpStylistModeShiftsHint", "Bookable only on published shifts in the Schedule.")}
      </p>
    </div>
  );
}

export default function StylistRow({ r, t, staffName = "", businessName = "", onSaved, onRemove }) {
  const own = isOwnChair(r);
  const shown = (r.staff_id ? staffName : "") || r.label || "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: shown, follows: !!r.follows_opening_hours });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef(null);

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  const start = () => {
    setDraft({ name: shown, follows: !!r.follows_opening_hours });
    setError("");
    setEditing(true);
  };
  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setError("");
  };

  const save = async () => {
    const { changes, error: why } = stylistChanges(r, shown, draft);
    if (why === "name") {
      setError(t("rsvpStylistNameRequired", "Write a name."));
      return;
    }
    if (why === "too_long") {
      setError(t("rsvpStylistNameTooLong", "The name can be at most 80 characters."));
      return;
    }
    if (!Object.keys(changes).length) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await api.patch(`/reservations/salon/stylists/${r.id}`, changes);
      const next = res?.data && res.data.id ? res.data : {
        ...r,
        ...(changes.follows_opening_hours !== undefined ? { follows_opening_hours: changes.follows_opening_hours } : {}),
        ...(changes.name && !r.staff_id ? { label: changes.name } : {}),
        staff_name: changes.name && r.staff_id ? changes.name : staffName || null,
      };
      onSaved?.(next);
      setEditing(false);
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      setError(
        code === "name_required"
          ? t("rsvpStylistNameRequired", "Write a name.")
          : code === "name_too_long"
            ? t("rsvpStylistNameTooLong", "The name can be at most 80 characters.")
            : t("rsvpStylistSaveError", "Couldn't save. Try again."),
      );
    } finally {
      setSaving(false);
    }
  };

  const shell =
    "rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white " +
    "dark:bg-[rgb(var(--surface-card))] px-4 py-3 max-sm:px-3";

  if (editing) {
    return (
      <li data-testid="stylist-row" className={shell}>
        <form
          aria-label={t("rsvpStylistEditTitle", "Edit stylist")}
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              cancel();
            }
          }}
          className="space-y-3"
        >
          <div>
            <label htmlFor={`stylist-name-${r.id}`} className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">
              {t("rsvpStylistNameLabel", "Name")}
            </label>
            <input
              id={`stylist-name-${r.id}`}
              ref={nameRef}
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              maxLength={STYLIST_NAME_MAX}
              autoComplete="off"
              className={FIELD}
            />
            {r.staff_id && (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                {t("rsvpStylistRenameHint", "The name changes in the Schedule too.")}
              </p>
            )}
          </div>
          {r.staff_id && (
            <BookableChoice
              t={t}
              name={`stylist-bookable-${r.id}`}
              value={!!draft.follows}
              onChange={(v) => setDraft((d) => ({ ...d, follows: v }))}
            />
          )}
          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          {/* Phone: the pair as equal halves; from sm: up, right-aligned. */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button type="button" variant="secondary" size="lg" onClick={cancel} disabled={saving}
              className="max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]">
              {t("cancel", "Cancel")}
            </Button>
            <Button type="submit" variant="primary" size="lg" busy={saving}
              className="max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]">
              {t("save", "Save")}
            </Button>
          </div>
        </form>
      </li>
    );
  }

  const station = r.staff_id && staffName && r.label && r.label !== staffName ? r.label : "";
  const badge = own || (r.staff_id && r.follows_opening_hours)
    ? t("rsvpProviderFollowsHours", "Follows opening hours")
    : r.staff_id
      ? t("rsvpStylistByShifts", "On shifts")
      : t("rsvpProviderNoStaff", "No stylist");
  return (
    <li data-testid="stylist-row" className={shell + " " + (r.is_active === false ? "opacity-60" : "")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <Scissors className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.75} aria-hidden />
          {/* Phone: the name on its own line, the badge under it. */}
          <div className="min-w-0 flex flex-col sm:flex-row sm:items-center sm:gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
              {shown}
              {own && (
                <span className="ml-1.5 font-normal text-gray-500 dark:text-gray-400">
                  ({t("rsvpCapacityYou", "you")})
                </span>
              )}
              {station && (
                <span className="ml-1.5 font-normal text-xs text-gray-500 dark:text-gray-400">· {station}</span>
              )}
            </span>
            <span className="flex"><span className={BADGE}>{badge}</span></span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="stylist-edit"
            onClick={start}
            aria-label={t("rsvpStylistEditAria", "Edit {name}", { name: shown })}
            title={t("rsvpStylistEditTitle", "Edit stylist")}
            className={ICON_BTN}
          >
            <Pencil className="w-4 h-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onRemove?.(r)}
            aria-label={t("delete", "Delete")}
            className={ICON_BTN + " hover:text-red-600! hover:border-red-300"}
          >
            <Trash2 className="w-5 h-5 max-sm:w-4 max-sm:h-4" aria-hidden />
          </button>
        </div>
      </div>
      {namedAfterBusiness(r, businessName) && (
        <p data-testid="self-chair-business-name" className="mt-2 text-[12px] text-amber-700 dark:text-amber-400">
          {t("rsvpSelfChairNamedAfterBusiness", "Customers see the salon's name as a stylist. Change it to your own name.")}
        </p>
      )}
    </li>
  );
}
