// The name on the booking page, shown and editable where the owner manages
// booking (Reservationer → Indstillinger), R1 C, 24 Oct 2026.
//
// Guests see this name at the top of the booking page, in their
// confirmation and on the website button. It is users.business_name — the
// same field as Profile → Virksomhedsnavn (PATCH /auth/profile), so there is
// one name, edited in two places. The row renders whether or not the page is
// live: "Din bookingside" only shows once it is, and the name matters before.
//
// Two taps and one field: Ret → type → Gem.
import { useEffect, useRef, useState } from "react";
import { Check, Pencil } from "lucide-react";
import api from "../../services/api";
import Button from "../ui/Button";
import Input from "../ui/Input";

const NAME_MAX = 120;
// Phone: 40 px controls with 13 px text (the compact-controls rule).
const PHONE_CTRL = "max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]";

// `apptWords`: a salon, a shop, a workshop — its people are customers.
export default function BookingNameRow({ t, publicName = null, tradingName = "", onSaved, apptWords = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tradingName || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!editing) setDraft(tradingName || "");
  }, [tradingName, editing]);
  useEffect(() => {
    if (editing) inputRef.current?.focus?.();
  }, [editing]);

  const trimmed = draft.trim();
  const unchanged = trimmed === (tradingName || "").trim();
  const canSave = !saving && trimmed.length > 0 && !unchanged;

  const startEdit = () => {
    setDraft(tradingName || publicName || "");
    setSaved(false);
    setError("");
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError("");
  };
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      await api.patch("/auth/profile", { business_name: trimmed.slice(0, NAME_MAX) });
      setEditing(false);
      setSaved(true);
      if (onSaved) await onSaved();
    } catch {
      // The owner's language, never a server or network string.
      setError(t("rsvpSettingsSaveError", "Couldn't save settings."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="rsvp-booking-name"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xs font-medium text-gray-500 dark:text-gray-400">
            {t("rsvpBookingNameLabel", "Name on your booking page")}
          </h2>
          {!editing && (
            publicName ? (
              <p data-testid="rsvp-booking-name-value" className="mt-0.5 text-[15px] font-semibold text-gray-900 dark:text-gray-100 break-words">
                {publicName}
              </p>
            ) : (
              <p data-testid="rsvp-booking-name-empty" className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                {apptWords
                  ? t("rsvpBookingNameEmptyAppt", "No name yet: customers see no business name.")
                  : t("rsvpBookingNameEmpty", "No name yet: guests see no venue name.")}
              </p>
            )
          )}
        </div>
        {!editing && (
          <Button
            type="button"
            variant="secondary"
            size="md"
            className={"shrink-0 " + PHONE_CTRL}
            iconLeft={<Pencil className="w-3.5 h-3.5" aria-hidden />}
            onClick={startEdit}
          >
            {t("rsvpBookingNameEdit", "Edit")}
          </Button>
        )}
      </div>

      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="flex flex-col sm:flex-row sm:items-center gap-2"
        >
          <Input
            ref={inputRef}
            id="rsvp-booking-name-input"
            aria-label={t("rsvpBookingNameLabel", "Name on your booking page")}
            value={draft}
            maxLength={NAME_MAX}
            onChange={(e) => setDraft(e.target.value)}
            className={"flex-1 min-w-0 " + PHONE_CTRL}
            error={error || null}
          />
          <div className="grid grid-flow-col auto-cols-fr sm:flex gap-2">
            <Button type="submit" variant="primary" size="md" busy={saving} disabled={!canSave} className={PHONE_CTRL}>
              {t("save", "Save")}
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={cancel} className={PHONE_CTRL}>
              {t("cancel", "Cancel")}
            </Button>
          </div>
        </form>
      )}

      {saved && !editing && (
        <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
          <Check className="w-3.5 h-3.5" aria-hidden /> {t("rsvpBookingNameSaved", "Saved. Your booking page shows the new name now.")}
        </p>
      )}
      <p className="text-[12px] leading-snug text-gray-500 dark:text-gray-400">
        {apptWords
          ? t("rsvpBookingNameHintAppt", "Customers see this name at the top of your booking page, in their confirmation and on your website button. It's the same as Profile → Business name.")
          : t("rsvpBookingNameHint", "Guests see this name at the top of your booking page, in their confirmation and on your website button. It's the same as Profile → Business name.")}
      </p>
    </div>
  );
}
