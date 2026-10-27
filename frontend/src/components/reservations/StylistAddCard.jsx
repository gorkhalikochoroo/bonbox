// "Tilføj en behandler" — a stylist by name, from Behandlere (R7, 27 Oct
// 2026 — rubric S11).
//
// It used to take 23–25 taps in four places: make the person in Vagtplan
// (the payroll page), give her shifts, publish the week, come back here and
// bind a station. Now: type "Mia", choose how she is booked, Tilføj — one
// POST /reservations/salon/stylists makes the staff member and her chair
// together. The server holds the Free plan's 3-staff lock (the same count
// Vagtplan's own add uses) and refuses before it writes anything; a name
// already on the roster is that person (no second Mia, no seat).
//
// "Kan bookes": when the salon is open (like the owner's own chair, no
// shifts needed — Ferie / Syg in Vagtplan still close her day), or on her
// published shifts. The default follows the salon: on shifts when it already
// runs a stylist on shifts, else the opening hours. The owner sees the
// choice before she taps.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Lock, Plus } from "lucide-react";
import api from "../../services/api";
import Button from "../ui/Button";
import UpgradeNudge from "../ui/UpgradeNudge";
import { BookableChoice, FIELD, STYLIST_NAME_MAX, tidyName } from "./StylistRow";

/** The words for a refused add — or null when the answer was not a refusal
 *  the owner can act on. `res` is the axios error's response. */
export function addRefusal(res, name, t) {
  const d = res?.data?.detail || {};
  if (res?.status === 402) {
    return d.cap === "staff_members"
      ? { cap: "staff_members", text: t("rsvpStylistStaffCap", "Your plan has room for {limit} staff, and all are in use. Upgrade to add someone new.", { limit: d.limit ?? "" }), upgradeTo: d.upgrade_to }
      : { cap: d.cap || "bookable_resources_max", text: t("rsvpStylistChairCap", "Your plan has room for {limit} chairs, and all are in use. Upgrade to add more.", { limit: d.limit ?? "" }), upgradeTo: d.upgrade_to };
  }
  if (res?.status === 409 && d.error === "stylist_exists") {
    return { text: t("rsvpStylistExists", "{name} is already a stylist.", { name: d.name || name }) };
  }
  if (d.error === "name_required") return { text: t("rsvpStylistNameRequired", "Write a name.") };
  if (d.error === "name_too_long") return { text: t("rsvpStylistNameTooLong", "The name can be at most 80 characters.") };
  return null;
}

export default function StylistAddCard({
  t,
  defaultFollows = true,
  // Free plan with every staff seat in use (useEntitlements — the same count
  // the server gates on). The form gives way to the plan's words.
  staffCap = null, // {limit, upgradeTo} | null
  onAdded,
}) {
  const [name, setName] = useState("");
  const [follows, setFollows] = useState(defaultFollows);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // {text, cap?, upgradeTo?}
  const [done, setDone] = useState(null); // {name, follows}

  // The default arrives with the chairs list; never over the owner's pick.
  useEffect(() => {
    if (!touched) setFollows(defaultFollows);
  }, [defaultFollows, touched]);

  const submit = async () => {
    const clean = tidyName(name);
    if (!clean) {
      setError({ text: t("rsvpStylistNameRequired", "Write a name.") });
      return;
    }
    if (clean.length > STYLIST_NAME_MAX) {
      setError({ text: t("rsvpStylistNameTooLong", "The name can be at most 80 characters.") });
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.post("/reservations/salon/stylists", {
        name: clean,
        follows_opening_hours: !!follows,
      });
      const added = res?.data || {};
      const shownName = added?.staff?.name || clean;
      setDone({ name: shownName, follows: !!added?.resource?.follows_opening_hours });
      setName("");
      onAdded?.(added);
    } catch (e) {
      setError(addRefusal(e?.response, clean, t) || { text: t("rsvpStylistAddError", "Couldn't add the stylist. Try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="stylist-add-card"
      aria-labelledby="stylist-add-title"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 max-sm:p-3 space-y-3"
    >
      <h2 id="stylist-add-title" className="text-sm font-semibold text-gray-800 dark:text-gray-200">
        {t("rsvpStylistAddTitle", "Add a stylist")}
      </h2>

      {staffCap ? (
        <div data-testid="stylist-staff-cap" className="space-y-3">
          <p className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
            <Lock className="w-4 h-4 mt-0.5 shrink-0 text-gray-400" aria-hidden />
            <span>
              {t("rsvpStylistStaffCap", "Your plan has room for {limit} staff, and all are in use. Upgrade to add someone new.", { limit: staffCap.limit ?? "" })}
            </span>
          </p>
          {staffCap.upgradeTo && (
            <UpgradeNudge
              intent="inline"
              tier={staffCap.upgradeTo === "pro" ? "pro" : "starter"}
              benefit={t("rsvpStylistStaffCapBenefit", "More staff and stylists")}
            />
          )}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) submit();
          }}
          className="space-y-3"
        >
          <div>
            <label htmlFor="stylist-add-name" className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">
              {t("rsvpStylistNameLabel", "Name")}
            </label>
            <input
              id="stylist-add-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (done) setDone(null);
              }}
              placeholder={t("rsvpStylistNamePh", "e.g. Mia")}
              maxLength={STYLIST_NAME_MAX}
              autoComplete="off"
              className={FIELD}
            />
          </div>
          <BookableChoice
            t={t}
            name="stylist-add-bookable"
            value={!!follows}
            onChange={(v) => {
              setTouched(true);
              setFollows(v);
            }}
          />
          {error && (
            <div role="alert" className="space-y-2">
              <p className="text-xs text-red-600 dark:text-red-400">{error.text}</p>
              {error.cap && error.upgradeTo && (
                <UpgradeNudge
                  intent="inline"
                  tier={error.upgradeTo === "pro" ? "pro" : "starter"}
                  benefit={t("rsvpStylistStaffCapBenefit", "More staff and stylists")}
                />
              )}
            </div>
          )}
          {done && (
            <p role="status" data-testid="stylist-added" className="text-[13px] text-emerald-700 dark:text-emerald-400">
              {done.follows
                ? t("rsvpStylistAddedHours", "{name} is added and can be booked whenever the salon is open.", { name: done.name })
                : t("rsvpStylistAddedShifts", "{name} is added and can be booked on published shifts.", { name: done.name })}
              {!done.follows && (
                <Link
                  to="/staff/schedule"
                  className="ml-1 inline-flex items-center gap-0.5 font-semibold underline underline-offset-2"
                >
                  {t("rsvpWeekPlanCta", "Plan shifts in Schedule")}
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden />
                </Link>
              )}
            </p>
          )}
          <div className="flex sm:justify-end">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              busy={busy}
              iconLeft={<Plus className="w-4 h-4" aria-hidden />}
              className="max-sm:w-full max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px] justify-center"
            >
              {t("rsvpStylistAddBtn", "Add stylist")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
