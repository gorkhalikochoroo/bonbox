// TicketPage — the visitor's web ticket at /t/{ticket_id}?sig=...
//
// The `sig` query param is the HMAC signature that authorizes the
// ticket lookup. Anyone with this URL can view the ticket; nobody else
// can. The backend route GET /api/public/tickets/{id}?sig=... validates
// the signature and returns the ticket + booking + event.
//
// Layout:
//   • Hero: event cover image
//   • H1: event.name
//   • H2: tier_label
//   • Big QR code: <img src="/api/public/tickets/{id}/qr.png?sig=..."/>
//     The image is server-rendered (the spec calls this out by name).
//   • Metadata: date · time · venue · reservation #
//   • Status pill:
//       paid       → ● Betalt (emerald dot)
//       pending    → ● Reservation modtaget — afventer betaling (amber)
//       refunded   → ● Refunderet — denne billet er ugyldig (red),
//                    QR replaced with a void overlay
//   • Footer:
//       - Add to calendar (.ics download — generated client-side)
//       - Other tickets in same booking
//
// Doctrine: cover photo is the only color moment. Status colors live
// in dots only (gray-100 pill + colored dot per the doctrine §status
// pills rule). The "void" overlay on a refunded ticket uses gray-900/80
// — no red wash, the message is the carrier.
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Calendar, MapPin, AlertCircle } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

// ── Calendar (.ics) export ────────────────────────────────────────
// Generate an .ics file as a Blob URL the visitor can download. Pure
// client-side — no backend round-trip. Spec mentions this as optional
// "v2 punt" candidate but it's a 15-line helper, easier to ship now.
//
// The .ics format is RFC 5545. We embed a single VEVENT inside a
// VCALENDAR. UID is the ticket id so re-downloading replaces the
// existing entry instead of duplicating it.
function buildIcs({ ticketId, eventName, venue, startsAt, endsAt, notes }) {
  if (!startsAt) return null;
  const fmt = (iso) => {
    try {
      const d = new Date(iso);
      // UTC ISO with no separators — RFC 5545 wants YYYYMMDDTHHMMSSZ.
      return d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    } catch {
      return "";
    }
  };
  const esc = (s) =>
    String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;")
      .replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BonBox//Event Ticket//EN",
    "BEGIN:VEVENT",
    `UID:ticket-${ticketId}@bonbox.dk`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(startsAt)}`,
    endsAt ? `DTEND:${fmt(endsAt)}` : null,
    `SUMMARY:${esc(eventName)}`,
    venue ? `LOCATION:${esc(venue)}` : null,
    notes ? `DESCRIPTION:${esc(notes)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.join("\r\n");
}

function downloadIcs(content, filename) {
  if (!content || typeof document === "undefined") return;
  try {
    const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* swallow — calendar export is optional */
  }
}

// Status pill — gray-100 bg + colored dot prefix per the doctrine.
// One component, three statuses. Re-renders cleanly when the booking
// transitions pending → paid → attended → refunded.
function StatusPill({ status, t }) {
  if (status === "paid" || status === "attended") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400"
          aria-hidden="true"
        />
        {t("ticketPaid", "Betalt")}
      </span>
    );
  }
  if (status === "refunded") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full bg-red-600 dark:bg-red-400"
          aria-hidden="true"
        />
        {t("ticketRefunded", "Refunderet — denne billet er ugyldig")}
      </span>
    );
  }
  // pending / cancelled / expired — show the amber pending state.
  // (cancelled & expired are functionally void; pending is "still
  // waiting on payment". The visitor sees the same "you haven't paid
  // yet" message in all three cases, which is what matters at the
  // door.)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400"
        aria-hidden="true"
      />
      {t("ticketPending", "Reservation modtaget — afventer betaling")}
    </span>
  );
}

export default function TicketPage() {
  const { ticket_id } = useParams();
  const [searchParams] = useSearchParams();
  const sig = searchParams.get("sig") || "";
  const { t } = useLanguage();

  // Whether the URL has the two pieces required for a backend lookup —
  // derived, NOT held in state. Keeps the missing-credentials path out
  // of useEffect (the React purity rule rejects setState inside effects
  // for derivable values).
  const urlValid = !!(ticket_id && sig);

  // `loading` starts true only when the URL is valid (we'll actually
  // fetch). When the URL is malformed we never enter the loading
  // state — we go straight to the "invalid" error render.
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(urlValid);
  const [error, setError] = useState(urlValid ? "" : "invalid");

  useEffect(() => {
    if (!urlValid) return; // already in error state from initial render
    let alive = true;
    // No synchronous setLoading(true) here — initial useState(urlValid)
    // covers first mount, callbacks flip the flag below. Satisfies the
    // react-hooks/set-state-in-effect lint rule.
    api
      .get(`/public/tickets/${ticket_id}`, { params: { sig } })
      .then((r) => {
        if (!alive) return;
        setTicket(r?.data || null);
      })
      .catch((err) => {
        if (!alive) return;
        if (err?.response?.status === 404 || err?.response?.status === 410) {
          setError("not_found");
        } else if (err?.response?.status === 401 || err?.response?.status === 403) {
          setError("invalid");
        } else {
          setError("generic");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ticket_id, sig, urlValid]);

  // Derived data.
  const event = ticket?.event || null;
  const booking = ticket?.booking || null;
  const status = booking?.status || ticket?.status || "pending";
  const isRefunded = status === "refunded" || ticket?.is_void;
  const otherTickets =
    Array.isArray(booking?.tickets)
      ? booking.tickets.filter((tt) => tt.id !== ticket_id)
      : [];

  // Server-side QR endpoint per the spec. We don't even attempt a
  // client-side QR encoder — the backend already signs the payload,
  // it's both cheaper and more secure to let it render the PNG.
  const qrSrc = useMemo(() => {
    if (!ticket_id || !sig) return null;
    return `${api.defaults.baseURL || ""}/public/tickets/${ticket_id}/qr.png?sig=${encodeURIComponent(sig)}`;
  }, [ticket_id, sig]);

  const onAddToCalendar = () => {
    if (!event?.starts_at) return;
    const ics = buildIcs({
      ticketId: ticket_id,
      eventName: event.name,
      venue: event.venue,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      notes: event.notes,
    });
    if (ics) {
      // Sanitise the filename — DK chars and spaces in the event name
      // breakage on older Android downloaders.
      const safeName = (event.name || "event")
        .replace(/[^a-z0-9-_]+/gi, "-")
        .toLowerCase()
        .slice(0, 60);
      downloadIcs(ics, `${safeName || "event"}.ics`);
    }
  };

  // ── Renders ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-12">
        <div className="max-w-md mx-auto space-y-4">
          <div className="animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800 aspect-[16/9]" />
          <div className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800 h-8 w-3/4" />
          <div className="animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800 aspect-square max-w-xs mx-auto" />
        </div>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-16">
        <div className="max-w-md mx-auto text-center space-y-3">
          <AlertCircle
            size={40}
            strokeWidth={1.5}
            className="text-gray-400 mx-auto"
            aria-hidden="true"
          />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t("bookingNotFound", "Arrangementet blev ikke fundet")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            {t(
              "bookingNotFoundHint",
              "Linket kan være forkert, eller arrangøren har afpubliceret arrangementet.",
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      {/* ── Hero cover photo ─────────────────────────────────────── */}
      {event?.cover_image_url ? (
        <div className="w-full aspect-[16/9] bg-gray-100 dark:bg-gray-800 overflow-hidden">
          <img
            src={event.cover_image_url}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        <div className="w-full aspect-[16/9] bg-gray-100 dark:bg-gray-800" />
      )}

      <div className="max-w-md mx-auto px-4 sm:px-6 pt-6 pb-12 space-y-6">
        {/* ── Title + tier ──────────────────────────────────────── */}
        <header className="space-y-1.5">
          <h1 className="text-[28px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 leading-tight">
            {event?.name}
          </h1>
          {ticket.tier_label && (
            <p className="text-base text-gray-700 dark:text-gray-300">
              {ticket.tier_label}
            </p>
          )}
          <div className="pt-1">
            <StatusPill status={status} t={t} />
          </div>
        </header>

        {/* ── QR code ──────────────────────────────────────────── */}
        <div className="relative mx-auto w-full max-w-xs">
          {qrSrc && !isRefunded ? (
            <img
              src={qrSrc}
              alt=""
              width={320}
              height={320}
              className={
                "block w-full aspect-square rounded-xl border " +
                "border-gray-200 dark:border-gray-700 bg-white p-3"
              }
            />
          ) : (
            // Either we don't have a sig (placeholder neutral square) or
            // the ticket is void — same neutral placeholder. The void
            // overlay below paints the message on top.
            <div className="block w-full aspect-square rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900" />
          )}
          {isRefunded && (
            // Void overlay — gray-900/80 wash, white "Ugyldig" text.
            // Doctrine: this is the ONE moment where we cover the QR
            // because the QR would otherwise be scannable. The wash is
            // neutral (gray, not red) — the textual "Refunderet" pill
            // already carries the color signal.
            <div
              className={
                "absolute inset-0 rounded-xl flex items-center justify-center " +
                "bg-gray-900/80 dark:bg-gray-950/80 text-white text-lg font-semibold tracking-wide"
              }
              role="status"
              aria-label={t("ticketVoid", "Ugyldig")}
            >
              {t("ticketVoid", "Ugyldig")}
            </div>
          )}
        </div>
        {!isRefunded && (
          <p className="text-center text-xs text-gray-500 dark:text-gray-400">
            {t("ticketShowAtDoor", "Vis denne kode ved døren")}
          </p>
        )}

        {/* ── Metadata ──────────────────────────────────────────── */}
        <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
          {event?.starts_at && (
            <div className="flex items-center gap-2">
              <Calendar size={16} strokeWidth={1.75} className="text-gray-500 shrink-0" />
              <span>
                {new Date(event.starts_at).toLocaleString("da-DK", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          )}
          {event?.venue && (
            <div className="flex items-center gap-2">
              <MapPin size={16} strokeWidth={1.75} className="text-gray-500 shrink-0" />
              <span>{event.venue}</span>
            </div>
          )}
          {(booking?.short_ref || booking?.reference) && (
            <div className="text-xs text-gray-500 dark:text-gray-400 pt-1">
              {t("ticketReservationRef", "Reservation")} #
              {booking.short_ref || booking.reference}
            </div>
          )}
        </div>

        {/* ── Footer actions: calendar + other tickets ──────────── */}
        <div className="pt-2 space-y-3 border-t border-gray-100 dark:border-gray-800">
          {event?.starts_at && !isRefunded && (
            <div className="pt-3">
              <button
                type="button"
                onClick={onAddToCalendar}
                className={
                  "inline-flex items-center text-sm font-medium " +
                  "text-gray-900 dark:text-gray-100 underline-offset-4 hover:underline"
                }
              >
                {t("ticketAddToCalendar", "Tilføj til kalender")}
              </button>
            </div>
          )}
          {otherTickets.length > 0 && (
            <div className="pt-3 space-y-2">
              <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t("ticketOtherInBooking", "Andre billetter i denne reservation")}
              </p>
              <ul className="space-y-1.5">
                {otherTickets.map((tt) => {
                  // Each entry needs its own sig — only follow if both
                  // are present. Otherwise we render the row without
                  // a link (still useful as a count display).
                  const url =
                    tt.id && tt.sig
                      ? `/t/${tt.id}?sig=${encodeURIComponent(tt.sig)}`
                      : null;
                  return (
                    <li key={tt.id}>
                      {url ? (
                        <a
                          href={url}
                          className={
                            "block rounded-lg border border-gray-200 dark:border-gray-700 " +
                            "px-3 py-2 text-sm text-gray-900 dark:text-gray-100 " +
                            "hover:bg-gray-50 dark:hover:bg-gray-900/60"
                          }
                        >
                          {tt.tier_label || t("ticketTier", "Billettype")}
                        </a>
                      ) : (
                        <span className="block rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                          {tt.tier_label || t("ticketTier", "Billettype")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
