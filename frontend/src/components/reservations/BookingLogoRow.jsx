// The logo on the booking page, shown where the owner manages booking
// (Reservationer → Indstillinger), right under "Navn på bookingsiden"
// (booking R13, Manoj 27 Oct 2026).
//
// The same logo the booking page shows: business_profile.logo_url, read
// through GET /business/brand (a signed link, never the storage key) — or,
// with none, the same monogram the page draws from the venue's name
// (utils/venueMonogram). The logo itself is uploaded in one place only,
// Profil → Brand (/profile#brand); this row links there: "Skift logo" with
// a logo, "Tilføj logo" without. A failed read (or a plan without brand
// access, 402) shows the monogram and "Tilføj logo" — never an error the
// owner can do nothing about here.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ImagePlus } from "lucide-react";
import api from "../../services/api";
import { venueMonogram } from "../../utils/venueMonogram";

// Phone: 40 px controls with 13 px text (the compact-controls rule); 36 px
// from sm, like the rows around it.
const LINK =
  "inline-flex items-center justify-center gap-1.5 shrink-0 h-10 sm:h-9 min-h-0! px-3 rounded-lg text-[13px] sm:text-sm font-medium " +
  "bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 " +
  "dark:shadow-[inset_0_0_0_1px_var(--color-gray-700)] transition-colors focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[rgb(var(--brand-green-accent))] focus-visible:ring-offset-2";

export default function BookingLogoRow({ t, publicName = null }) {
  // loading | ready (logoUrl may be null)
  const [status, setStatus] = useState("loading");
  const [logoUrl, setLogoUrl] = useState(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.get("/business/brand"))
      .then((r) => {
        if (!alive) return;
        const url = r?.data?.logo_url;
        setLogoUrl(typeof url === "string" && url ? url : null);
        setStatus("ready");
      })
      .catch(() => {
        if (alive) setStatus("ready");
      });
    return () => {
      alive = false;
    };
  }, []);

  const hasLogo = status === "ready" && !!logoUrl && !broken;
  return (
    <div
      data-testid="rsvp-booking-logo"
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 flex items-center gap-3"
    >
      {status === "loading" ? (
        <span aria-hidden="true" className="shrink-0 w-11 h-11 rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : hasLogo ? (
        <img
          data-testid="rsvp-booking-logo-img"
          src={logoUrl}
          alt=""
          onError={() => setBroken(true)}
          className="shrink-0 w-11 h-11 rounded-lg object-contain bg-white ring-1 ring-gray-200 dark:ring-gray-700 p-1"
        />
      ) : (
        <span
          data-testid="rsvp-booking-logo-monogram"
          aria-hidden="true"
          className="shrink-0 w-11 h-11 rounded-lg bg-gray-100 text-gray-800 ring-1 ring-inset ring-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 flex items-center justify-center text-[15px] font-semibold tracking-tight select-none"
        >
          {venueMonogram(publicName)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("rsvpLogoLabel")}</h2>
        {status === "ready" && !hasLogo && (
          <p className="mt-0.5 text-[13px] text-gray-600 dark:text-gray-300 leading-snug">{t("rsvpLogoNone")}</p>
        )}
      </div>
      <Link to="/profile#brand" data-testid="rsvp-booking-logo-link" className={LINK}>
        <ImagePlus className="w-3.5 h-3.5" aria-hidden />
        {hasLogo ? t("rsvpLogoChange") : t("rsvpLogoAdd")}
      </Link>
    </div>
  );
}
