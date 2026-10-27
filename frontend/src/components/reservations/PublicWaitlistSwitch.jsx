// The owner's one switch for the guest waitlist on a full night (booking R12),
// in Reservationer → Indstillinger under the booking page's colour.
//
// On by default for every table venue (Manoj, 19 Oct): on a night with no
// free table, guests can put themselves on the Venteliste from the booking
// page. Not a booking — the owner contacts the guest if a table frees up. One
// tap off. It saves on the tap (PUT /reservations/settings, merged on the
// server), the same way as the owner e-mail switch, and keeps its own state so
// a tap here never resets anything typed in the form above.
//
// Shown only when the server's settings carry the key (a backend that knows
// the waitlist): a newer app over an older server shows no switch it cannot
// keep.
import { useEffect, useState } from "react";
import api from "../../services/api";

export default function PublicWaitlistSwitch({ t, settings }) {
  const loaded = settings?.public_waitlist !== false;
  const [on, setOn] = useState(loaded);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(""); // "" | "saved" | "error"
  // A fresh load of the settings (another save on the page) is the truth.
  useEffect(() => setOn(loaded), [loaded]);

  const toggle = async () => {
    if (saving) return;
    const next = !on;
    setOn(next); // one tap: the switch answers at once
    setSaving(true);
    setNote("");
    try {
      const res = await api.put("/reservations/settings", { settings: { public_waitlist: next } });
      setOn(res?.data?.settings?.public_waitlist !== false);
      setNote("saved");
    } catch {
      setOn(!next);
      setNote("error");
    } finally {
      setSaving(false);
    }
  };

  const label = t("rsvpPublicWaitlistSetting", "Guests can join the waitlist when you're fully booked");
  return (
    <div
      data-testid="rsvp-public-waitlist"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 flex items-start justify-between gap-4"
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{label}</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {t("rsvpPublicWaitlistSettingHint", "Only on nights with no free table, at most 15 a night. It isn't a booking — you contact the guest if a table frees up.")}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {t("rsvpPublicWaitlistSettingPrivacy", "Their name and number are deleted 30 days after the night at the latest.")}
        </p>
        {note && (
          <p role="status" className={"text-xs mt-1 " + (note === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
            {note === "error"
              ? t("rsvpSettingsSaveError", "Couldn't save settings.")
              : t("rsvpSaved", "Saved")}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={saving}
        onClick={toggle}
        className="shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 disabled:opacity-50"
      >
        <span className={"relative inline-flex h-6 w-11 items-center rounded-full transition-colors " + (on ? "bg-emerald-600" : "bg-gray-300 dark:bg-gray-600")}>
          <span className={"inline-block h-5 w-5 transform rounded-full bg-white transition-transform " + (on ? "translate-x-5" : "translate-x-0.5")} />
        </span>
      </button>
    </div>
  );
}
