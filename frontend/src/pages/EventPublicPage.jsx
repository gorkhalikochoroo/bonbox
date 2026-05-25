// EventPublicPage — the bookable event landing page at /e/{slug}.
//
// Mobile-first (390px reference). Doctrine-compliant: cover photo is the
// only color moment. Page chrome stays on the 13-token gray palette per
// docs/design-system-doctrine.md. DK terminology lock applies — MOMS /
// revisor / faktura / bilagsnummer / kreditnota stay Danish in every
// locale on this surface.
//
// This is a PUBLIC route. No auth required. The visitor lands here from a
// Facebook click on their phone. The page has 3.4 seconds to convince
// them to tap "Reservér" — see spec §4 for the "premium-feel" doctrine.
//
// Layout (mobile-first, 390px viewport):
//
//   [hero cover photo — 16:9 full-bleed]
//   H1: event name
//   H2 subtitle (optional)
//   metadata strip (date · time · venue · capacity-if-≥25%-sold)
//
//   H2: Om arrangementet
//   notes body
//
//   H2: Vælg billet
//   per ticket_tier: [chip-row label · price · qty stepper]
//   H3: Tilføj (valgfrit) — only if event.addons exists
//   per addon: [chip-row label · +price · qty stepper]
//
//   Sticky bottom CTA:
//     I alt: {total} kr
//     [Reservér →]
//
// Submit → React Router navigate to /e/{slug}/checkout with
// location.state.{ticketQtys, addonQtys}. The checkout page reads this
// state and continues the funnel.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Calendar, MapPin, Users, Minus, Plus, AlertCircle } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import Button from "../components/ui/Button";
import Chip from "../components/ui/Chip";

// ── Helpers ──────────────────────────────────────────────────────────
// Format a kroner amount as plain integer with thousand separators.
// The public page intentionally hides decimals — DK ticket prices are
// integer kroner in 99 % of cases, and "150 kr" reads cleaner than
// "150,00 kr" on a 390 px viewport.
function fmtKr(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "0";
  try {
    return amount.toLocaleString("da-DK");
  } catch {
    return String(amount);
  }
}

// Format the date metadata strip. Returns "Lørdag 13. juni · 18:00–21:00".
// Robust against missing fields — if starts_at is missing we render the
// raw event.date instead. Locale-aware via the user's lang on da-DK by
// default (public surface defaults to DK).
function fmtDateRange(startsAt, endsAt, fallbackDate) {
  try {
    if (startsAt) {
      const start = new Date(startsAt);
      const opts = { weekday: "long", day: "numeric", month: "long" };
      const day = start.toLocaleDateString("da-DK", opts);
      const tStart = start.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
      if (endsAt) {
        const end = new Date(endsAt);
        const tEnd = end.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
        return `${day} · ${tStart}–${tEnd}`;
      }
      return `${day} · ${tStart}`;
    }
  } catch {
    /* fall through */
  }
  return fallbackDate || "";
}

// QtyStepper — tiny reusable [- qty +] row used for both ticket tiers
// and add-on lines. Locked to gray-900 borders, no color drift. Aria
// labels come from the parent so we get DK/EN translations.
function QtyStepper({ value, onChange, decAria, incAria, min = 0, max = 50 }) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={dec}
        disabled={value <= min}
        aria-label={decAria}
        className={
          "inline-flex items-center justify-center w-9 h-9 rounded-lg " +
          "border border-gray-200 text-gray-700 " +
          "hover:bg-gray-50 hover:border-gray-300 " +
          "disabled:opacity-40 disabled:cursor-not-allowed " +
          "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/60"
        }
      >
        <Minus size={16} strokeWidth={2} />
      </button>
      <span
        className="min-w-[1.5rem] text-center text-sm font-medium text-gray-900 dark:text-gray-100"
        aria-live="polite"
      >
        {value}
      </span>
      <button
        type="button"
        onClick={inc}
        disabled={value >= max}
        aria-label={incAria}
        className={
          "inline-flex items-center justify-center w-9 h-9 rounded-lg " +
          "border border-gray-200 text-gray-700 " +
          "hover:bg-gray-50 hover:border-gray-300 " +
          "disabled:opacity-40 disabled:cursor-not-allowed " +
          "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/60"
        }
      >
        <Plus size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

export default function EventPublicPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Per-tier quantities, keyed by tier.label. We DON'T initialise this
  // until the event arrives — `event` shape is the source of truth.
  const [ticketQtys, setTicketQtys] = useState({});
  const [addonQtys, setAddonQtys] = useState({});

  useEffect(() => {
    let alive = true;
    // We don't synchronously call setLoading(true) here — the initial
    // useState(true) covers first mount, and downstream callbacks
    // (.then/.catch/.finally below) flip the flag asynchronously. This
    // keeps the effect free of the react-hooks/set-state-in-effect lint
    // rule (React 19 rejects effects whose body does setState directly).
    api
      .get(`/public/events/${slug}`)
      .then((r) => {
        if (!alive) return;
        setEvent(r?.data || null);
        setError("");
      })
      .catch((err) => {
        if (!alive) return;
        if (err?.response?.status === 404) {
          setError("not_found");
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
  }, [slug]);

  // Derive total whenever quantities change. Pure derivation — no
  // useEffect-with-setState ladder needed.
  const total = useMemo(() => {
    let sum = 0;
    if (event?.ticket_tiers) {
      for (const tier of event.ticket_tiers) {
        const qty = ticketQtys[tier.label] || 0;
        const price = Number(tier.price_dkk) || 0;
        sum += qty * price;
      }
    }
    if (event?.addons) {
      for (const addon of event.addons) {
        const qty = addonQtys[addon.label] || 0;
        const price = Number(addon.price_dkk) || 0;
        sum += qty * price;
      }
    }
    return sum;
  }, [event, ticketQtys, addonQtys]);

  // Booking-window check. Mirrors the backend L7 fail-closed rule:
  // visitor sees "Booking lukket" if event.published is false OR
  // bookings_close_at is in the past. The backend will also reject the
  // POST — this is a courtesy gate, not the source of truth.
  //
  // We compute "now" once on mount instead of calling Date.now() inside
  // the memo (React's purity rule rejects time/random calls during
  // render — they make the same component re-render with different
  // results). On a static page like this the slight staleness (≤ the
  // visitor's session length) is fine; the backend re-validates on POST.
  const [nowMs] = useState(() => Date.now());
  const bookingClosed = useMemo(() => {
    if (!event) return false;
    if (event.published === false) return true;
    if (event.bookings_close_at) {
      try {
        if (new Date(event.bookings_close_at).getTime() < nowMs) return true;
      } catch {
        /* tolerate parse fail — let backend decide */
      }
    }
    return false;
  }, [event, nowMs]);

  // Capacity progress is rendered ONLY when sold ≥ 25 % (per spec §4 +
  // L10 honest-claims doctrine). Below 25 % we never invent urgency.
  const capacityPill = useMemo(() => {
    if (!event || !event.capacity_total) return null;
    const sold = Number(event.capacity_sold) || 0;
    const total = Number(event.capacity_total) || 0;
    if (total <= 0 || sold <= 0) return null;
    if (sold / total < 0.25) return null;
    return { sold, total };
  }, [event]);

  const onReserve = () => {
    if (bookingClosed || total < 1) return;
    navigate(`/e/${slug}/checkout`, {
      state: {
        ticketQtys,
        addonQtys,
        // Echo a snapshot so the checkout page can render the summary
        // without re-fetching. The checkout page DOES re-fetch the
        // event before POSTing the booking — this state is just for
        // the immediate render (so the visitor doesn't see a skeleton
        // flash between page transitions).
        eventSnapshot: event,
      },
    });
  };

  // ── Render ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-12">
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800 aspect-[16/9]" />
          <div className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800 h-8 w-3/4" />
          <div className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800 h-4 w-1/2" />
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center pt-4">
            {t("bookingLoading", "Henter arrangement…")}
          </p>
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-16">
        <div className="max-w-md mx-auto text-center">
          <AlertCircle
            size={40}
            strokeWidth={1.5}
            className="text-gray-400 mx-auto mb-3"
            aria-hidden="true"
          />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {t("bookingNotFound", "Arrangementet blev ikke fundet")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
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
    <div className="min-h-screen bg-white dark:bg-gray-950 pb-32">
      {/* ── Hero cover photo (16:9 full-bleed) ─────────────────────── */}
      {event.cover_image_url ? (
        <div className="w-full aspect-[16/9] bg-gray-100 dark:bg-gray-800 overflow-hidden">
          <img
            src={event.cover_image_url}
            alt=""
            className="w-full h-full object-cover"
            // Cover photo IS the page's only decoration — but it's
            // signal, not chrome. We don't lazy-load (above-the-fold)
            // and we don't add fancy framing (border / shadow) — let
            // the photo carry the drama.
          />
        </div>
      ) : (
        // No cover — render a neutral gray placeholder so the layout
        // doesn't jump and we never display a broken image icon.
        <div className="w-full aspect-[16/9] bg-gray-100 dark:bg-gray-800" />
      )}

      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 space-y-6">
        {/* ── Title + subtitle ─────────────────────────────────────── */}
        <header className="space-y-1">
          <h1 className="text-[28px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 leading-tight">
            {event.name}
          </h1>
          {event.subtitle && (
            <p className="text-base text-gray-700 dark:text-gray-300">
              {event.subtitle}
            </p>
          )}
        </header>

        {/* ── Metadata strip ───────────────────────────────────────── */}
        <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <div className="flex items-center gap-2">
            <Calendar size={16} strokeWidth={1.75} className="text-gray-500 shrink-0" />
            <span>{fmtDateRange(event.starts_at, event.ends_at, event.date)}</span>
          </div>
          {event.venue && (
            <div className="flex items-center gap-2">
              <MapPin size={16} strokeWidth={1.75} className="text-gray-500 shrink-0" />
              <span>{event.venue}</span>
            </div>
          )}
          {capacityPill && (
            <div className="flex items-center gap-2">
              <Users size={16} strokeWidth={1.75} className="text-gray-500 shrink-0" />
              <span>
                {t("bookingCapacitySold", "{sold} af {total} pladser booket", {
                  sold: capacityPill.sold,
                  total: capacityPill.total,
                })}
              </span>
            </div>
          )}
        </div>

        {/* ── About the event ──────────────────────────────────────── */}
        {event.notes && (
          <section className="space-y-2">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {t("bookingAboutEvent", "Om arrangementet")}
            </h2>
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
              {event.notes}
            </p>
          </section>
        )}

        {/* ── Pick a ticket ────────────────────────────────────────── */}
        {Array.isArray(event.ticket_tiers) && event.ticket_tiers.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {t("bookingChooseTicket", "Vælg billet")}
            </h2>
            <div className="space-y-2">
              {event.ticket_tiers.map((tier) => {
                const qty = ticketQtys[tier.label] || 0;
                return (
                  <div
                    key={tier.label}
                    className={
                      "flex items-center justify-between gap-3 " +
                      "rounded-xl border border-gray-200 dark:border-gray-700 " +
                      "bg-white dark:bg-gray-900 px-4 py-3"
                    }
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {tier.label}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {fmtKr(Number(tier.price_dkk) || 0)} kr
                      </p>
                    </div>
                    <QtyStepper
                      value={qty}
                      onChange={(v) =>
                        setTicketQtys((s) => ({ ...s, [tier.label]: v }))
                      }
                      decAria={t("bookingDecreaseQty", "Færre")}
                      incAria={t("bookingIncreaseQty", "Flere")}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Optional add-ons ─────────────────────────────────────── */}
        {Array.isArray(event.addons) && event.addons.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("bookingAddonOptional", "Tilføj (valgfrit)")}
            </h3>
            <div className="space-y-2">
              {event.addons.map((addon) => {
                const qty = addonQtys[addon.label] || 0;
                return (
                  <div
                    key={addon.label}
                    className={
                      "flex items-center justify-between gap-3 " +
                      "rounded-xl border border-gray-200 dark:border-gray-700 " +
                      "bg-white dark:bg-gray-900 px-4 py-3"
                    }
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {addon.label}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        +{fmtKr(Number(addon.price_dkk) || 0)} kr
                      </p>
                    </div>
                    <QtyStepper
                      value={qty}
                      onChange={(v) =>
                        setAddonQtys((s) => ({ ...s, [addon.label]: v }))
                      }
                      decAria={t("bookingDecreaseQty", "Færre")}
                      incAria={t("bookingIncreaseQty", "Flere")}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Inline closed-banner — when the booking window has elapsed or
            the organizer has un-published. Sits above the (disabled)
            sticky CTA so the visitor isn't surprised. */}
        {bookingClosed && (
          <div
            className="rounded-xl bg-gray-50 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700 px-4 py-3 flex items-start gap-2"
            role="status"
          >
            <AlertCircle
              size={16}
              strokeWidth={1.75}
              className="text-amber-500 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t("bookingClosed", "Booking lukket")}
            </p>
          </div>
        )}

        {/* Bottom spacer — accounts for the sticky CTA height + iOS
            home-indicator zone so the last addon row isn't covered. */}
        <div className="h-2" aria-hidden="true" />
      </div>

      {/* ── Sticky bottom CTA ──────────────────────────────────────
          Position: fixed bottom on every viewport (mobile-first; the
          desktop case isn't a priority, the public page is overwhelm-
          ingly opened from a Facebook mobile click). Wraps in a
          max-width centered container so on desktop it doesn't span
          the full window. */}
      <div
        className={
          "fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-gray-950 " +
          "border-t border-gray-200 dark:border-gray-800"
        }
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)" }}
      >
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t("bookingTotal", "I alt")}
            </p>
            <p className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {fmtKr(total)} kr
            </p>
          </div>
          <Button
            variant="primary"
            size="lg"
            onClick={onReserve}
            disabled={bookingClosed || total < 1}
            className="flex-1 sm:flex-initial"
          >
            {bookingClosed
              ? t("bookingClosed", "Booking lukket")
              : t("bookingReservere", "Reservér →")}
          </Button>
        </div>
      </div>
    </div>
  );
}
