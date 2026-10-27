// One service on the Behandlinger tab (R6, 27 Oct 2026). Read it, switch it
// on or off, delete it — or edit it in place: Rediger, change the name, the
// length or the price, Gem. Three taps (rubric S2). It used to be delete and
// add again to turn 30 minutes into 45.
//
// The server owns the bounds (PATCH /reservations/behandlinger/{id}: a name,
// 15–600 minutes, a price of 0 or more, an explicit null clears the price).
// Only the fields that changed are sent. Appointments already booked keep the
// length they were booked with — the sheet says so.
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, Pencil, Trash2 } from "lucide-react";
import api from "../../services/api";
import Button from "../ui/Button";
import { formatKr } from "../../utils/currency";

// Phone: 40 px icon squares (the compact-controls rule); 44 px from sm: up.
const ICON_BTN =
  "w-11 h-11 max-sm:w-10 max-sm:h-10 max-sm:min-h-0! inline-flex items-center justify-center " +
  "rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 " +
  "hover:text-gray-900 dark:hover:text-gray-100";
// Text inputs stay 16 px on a phone (smaller text zooms iOS on focus).
const FIELD =
  "w-full h-11 max-sm:h-10 max-sm:min-h-0! px-3 rounded-lg border border-gray-200 dark:border-gray-700 " +
  "bg-white dark:bg-gray-800 text-base sm:text-sm text-gray-900 dark:text-gray-100 " +
  "focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent";

export const DURATION_MIN = 15;
export const DURATION_MAX = 600;

/** What an edit changes, as the PATCH body — or why it can't be saved.
 *  `draft` holds the form's strings: {name, duration, price}.
 *  → {changes: {...}} (possibly empty) or {error: "name" | "duration"}. */
export function behandlingChanges(item, draft) {
  const name = String(draft.name ?? "").trim();
  if (!name) return { error: "name" };
  const duration = parseInt(String(draft.duration ?? ""), 10);
  if (!Number.isFinite(duration) || duration < DURATION_MIN || duration > DURATION_MAX) {
    return { error: "duration" };
  }
  const priceRaw = String(draft.price ?? "").trim();
  const price = priceRaw === "" ? null : Math.max(0, parseInt(priceRaw, 10) || 0);
  const changes = {};
  if (name !== (item.name || "")) changes.name = name;
  if (duration !== Number(item.duration_min)) changes.duration_min = duration;
  const was = item.price_kr == null ? null : Number(item.price_kr);
  if (price !== was) changes.price_kr = price;
  return { changes };
}

function draftOf(b) {
  return {
    name: b.name || "",
    duration: String(b.duration_min ?? ""),
    price: b.price_kr == null ? "" : String(b.price_kr),
  };
}

export default function BehandlingRow({ b, t, onToggle, onRemove, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(b));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef(null);

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  const start = () => {
    setDraft(draftOf(b));
    setError("");
    setEditing(true);
  };
  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setError("");
  };

  const save = async () => {
    const { changes, error: why } = behandlingChanges(b, draft);
    if (why === "name") {
      setError(t("rsvpBehandlingNameRequired", "Give the service a name."));
      return;
    }
    if (why === "duration") {
      setError(t("rsvpBehandlingDurationRange", "The length must be 15–600 minutes."));
      return;
    }
    if (!Object.keys(changes).length) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await api.patch(`/reservations/behandlinger/${b.id}`, changes);
      onSaved?.(res?.data && res.data.id ? res.data : { ...b, ...changes });
      setEditing(false);
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      setError(
        code === "name_required"
          ? t("rsvpBehandlingNameRequired", "Give the service a name.")
          : e?.response?.status === 422
            ? t("rsvpBehandlingDurationRange", "The length must be 15–600 minutes.")
            : t("rsvpBehandlingSaveError", "Couldn't save the service."),
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
      <li data-testid="behandling-row" className={shell}>
        <form
          aria-label={t("rsvpBehandlingEditTitle", "Edit service")}
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
          className="space-y-2.5"
        >
          <div className="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem] gap-2">
            <input
              ref={nameRef}
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              maxLength={120}
              aria-label={t("rsvpBehandlingNameLabel", "Service name")}
              className={FIELD + " col-span-2 sm:col-span-1"}
            />
            <div className="relative">
              <input
                type="text"
                inputMode="numeric"
                value={draft.duration}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, duration: e.target.value.replace(/[^\d]/g, "").slice(0, 3) }))
                }
                aria-label={t("rsvpBehandlingDurationLabel", "Duration")}
                className={FIELD + " pr-12 tabular-nums"}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400" aria-hidden>
                {t("rsvpBehandlingMinSuffix", "min")}
              </span>
            </div>
            <div className="relative">
              <input
                type="text"
                inputMode="numeric"
                value={draft.price}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, price: e.target.value.replace(/[^\d]/g, "").slice(0, 6) }))
                }
                placeholder={t("rsvpBehandlingPriceLabel", "Price (optional)")}
                aria-label={t("rsvpBehandlingPriceLabel", "Price (optional)")}
                className={FIELD + " pr-10 tabular-nums"}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400" aria-hidden>
                kr.
              </span>
            </div>
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            {t("rsvpBehandlingEditKeepsBooked", "Appointments already booked keep their length.")}
          </p>
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

  return (
    <li data-testid="behandling-row" className={shell + " flex items-center justify-between gap-3 " + (b.active ? "" : "opacity-60")}>
      <div className="min-w-0 flex items-center gap-2">
        <Clock className="w-4 h-4 text-gray-400 shrink-0" aria-hidden />
        {/* Phone: the name on its own line, length and price under it — at
            390 px three buttons left the name a few letters wide. */}
        <div className="min-w-0 flex flex-col sm:flex-row sm:items-center sm:gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
            {b.name}
          </span>
          <span className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            <span>{t("rsvpBehandlingDurationValue", "{n} min", { n: b.duration_min })}</span>
            <span>{b.price_kr != null ? formatKr(b.price_kr, { decimals: 0 }) : "—"}</span>
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onToggle?.(b)}
          aria-pressed={!!b.active}
          aria-label={t("rsvpBehandlingActiveLabel", "Active")}
          title={t("rsvpBehandlingActiveLabel", "Active")}
          className={
            "h-11 max-sm:h-10 max-sm:min-h-0! px-3 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-colors " +
            (b.active
              ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900 " +
                // Phone, dark: a raised grey, never the inverted white slab.
                "max-sm:dark:border-gray-600 max-sm:dark:bg-gray-600 max-sm:dark:text-white"
              : "border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200")
          }
        >
          <CheckCircle2 className="w-4 h-4" aria-hidden />
          <span className="hidden sm:inline">{t("rsvpBehandlingActiveLabel", "Active")}</span>
        </button>
        <button
          type="button"
          data-testid="behandling-edit"
          onClick={start}
          aria-label={t("rsvpBehandlingEditAria", "Edit {name}", { name: b.name || "" })}
          title={t("rsvpBehandlingEdit", "Edit")}
          className={ICON_BTN}
        >
          <Pencil className="w-4 h-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onRemove?.(b)}
          aria-label={t("delete", "Delete")}
          className={ICON_BTN + " hover:text-red-600! hover:border-red-300"}
        >
          <Trash2 className="w-5 h-5 max-sm:w-4 max-sm:h-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}
