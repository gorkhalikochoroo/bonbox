// Under the Profile hours: what the booking page does with them (R9, 27 Oct
// 2026). Three editors hold hours — Profile ("Sådan kører din forretning"
// and its advanced editor), Reservationer → Indstillinger → Åbningstider,
// and the salon's first-run card — and none said which one decides online
// times. The rule, said the same way everywhere:
//   • the booking hours (Indstillinger) decide online times;
//   • a table venue's weekday with no booking hours is booked on these;
//   • a salon's chairs never read these.
// `status` is GET /business/operating-profile's `booking_hours`
// ({days, chairs_only}, or null = no booking page: nothing to say). With
// `load`, the note asks for it itself.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { speaksAppointments } from "../config/venueProfiles";
import { profileHoursNote } from "../utils/settingsTruth";

export const BOOKING_HOURS_HREF = "/reservations?tab=settings&show=hours";

export default function BookingHoursSourceNote({ status: given = undefined, load = false }) {
  const { t } = useLanguage();
  // A shop or a workshop speaks of customers and "Tidsbestilling" (its
  // menu). The note never breaks its card: no session context = the
  // restaurant's words.
  let user = null;
  try {
    user = useAuth()?.user || null;
  } catch {
    user = null;
  }
  const appt = speaksAppointments(user?.business_type);
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (!load) return undefined;
    let alive = true;
    api.get("/business/operating-profile")
      .then((r) => { if (alive) setFetched(r?.data?.booking_hours ?? null); })
      .catch(() => { if (alive) setFetched(null); });
    return () => { alive = false; };
  }, [load]);
  const note = profileHoursNote(given !== undefined ? given : fetched);
  if (!note) return null;
  const text = appt && note !== "chairs"
    ? {
        booking: t("profileHoursNoteBookingAppt", "Your booking page doesn't use these hours: customers book in the hours saved under Appointments → Settings → Opening hours."),
        profile: t("profileHoursNoteProfileAppt", "Your booking page uses these hours until you save booking hours under Appointments → Settings."),
        mixed: t("profileHoursNoteMixedAppt", "Your booking page uses the booking hours under Appointments → Settings, and these hours on the days that have none there."),
      }[note]
    : {
        booking: t("profileHoursNoteBooking", "Your booking page doesn't use these hours: guests book in the hours saved under Reservations → Settings → Opening hours."),
        profile: t("profileHoursNoteProfile", "Your booking page uses these hours until you save booking hours under Reservations → Settings."),
        mixed: t("profileHoursNoteMixed", "Your booking page uses the booking hours under Reservations → Settings, and these hours on the days that have none there."),
        chairs: t("profileHoursNoteChairs", "Customers book your chair in the hours under Appointments → Settings → Opening hours, not in these."),
      }[note];
  return (
    <p data-testid="profile-hours-note" data-note={note} className="flex items-start gap-1.5 text-[12px] leading-snug text-gray-600 dark:text-gray-300">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400" aria-hidden />
      <span>
        {text}{" "}
        <Link to={BOOKING_HOURS_HREF} className="font-medium underline underline-offset-2 text-gray-800 dark:text-gray-100">
          {t("profileHoursNoteLink", "Booking hours")}
        </Link>
      </span>
    </p>
  );
}
