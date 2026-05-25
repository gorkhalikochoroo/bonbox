// BookingSuccessPage — post-booking "pay the organizer" page.
//
// Route: /e/{slug}/success.
//
// In this v1 ledger-only payment model (spec §0), BonBox NEVER touches
// money. The visitor reserves a booking → BonBox emails them ticket
// details → they pay the organizer directly via MobilePay, Dankort, or
// cash. This page is the "now go pay" step.
//
// Receives the booking response from the previous page via
// location.state. If we land here cold (direct URL), we fall back to
// fetching /api/public/bookings/{id}?token=... — which the spec calls
// out as the polling shape.
//
// Layout:
//   • ✓ icon + H1 "Reservation modtaget" + booking ref
//   • Card with payment instructions:
//       "Betal {total} kr"
//       "Send {total} kr på MobilePay til {number} med beskeden: {ref}"
//       [Åbn MobilePay] button — deep links to mobilepay://send?...
//       QR code for the same mobilepay:// URL
//       Honest claim caption
//   • "Vis mine billetter →" link to /t/{first_ticket.id}?sig=...
//
// If event.organizer has no MobilePay number on file:
//   Text-only fallback "Kontakt arrangøren for betaling: {email}"
//
// Doctrine: only color moment on this page is the emerald ✓ icon
// (per --bb-success token: emerald-600 for paid / success signals).
// Everything else stays on the gray hierarchy.
import { useLocation, useParams } from "react-router-dom";
import { Check, AlertCircle } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import Button from "../components/ui/Button";

function fmtKr(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "0";
  try {
    return amount.toLocaleString("da-DK");
  } catch {
    return String(amount);
  }
}

// Build the MobilePay deep-link URL per the documented scheme. This is
// the same scheme used by every DK-built fintech app since Vipps merged
// with MobilePay (2024). Works on iOS Safari + Android Chrome. If the
// MobilePay app isn't installed, iOS will silently swallow the link
// (no error, no redirect). Android shows a "no app handles this" dialog
// on Chrome — we accept that as a graceful failure; the visitor sees
// the QR alternative right below.
//
// Scheme reference (validated against MobilePay Erhverv merchant docs
// 2026-02): mobilepay://send?phone=...&amount=...&comment=...
function buildMobilePayUrl({ number, amount, ref }) {
  if (!number) return null;
  const cleanNumber = String(number).replace(/[^\d+]/g, "");
  const params = new URLSearchParams();
  params.set("phone", cleanNumber);
  if (Number.isFinite(Number(amount))) {
    params.set("amount", String(Number(amount)));
  }
  if (ref) params.set("comment", String(ref));
  return `mobilepay://send?${params.toString()}`;
}

export default function BookingSuccessPage() {
  const { slug } = useParams();
  const location = useLocation();
  const { t } = useLanguage();

  // Prefer state from the checkout submit. If absent (page reloaded),
  // we'd ideally fetch via /api/public/bookings/{id}?token=... but the
  // token lives in the visitor's email + we don't have an id from URL,
  // so the realistic recovery is: ask the visitor to use their email
  // link. Hence the cold-render fallback below.
  //
  // Using location.state directly (no useState mirror) — these never
  // change for the lifetime of the page (the visitor either has them
  // from the previous step, or they don't; no re-fetch path exists for
  // this URL because we lack id + token from the URL alone).
  const booking = location.state?.booking || null;
  const event = location.state?.event || null;

  // Cold-render detection: derived value, not a useEffect-with-setState
  // ladder. If there's no booking AND no fetchable id+token in the URL,
  // we render the "use your email link" recovery surface.
  const loadFailed = !booking;

  // Derive payment numbers from the booking row + event.organizer.
  const organizer = booking?.organizer || event?.organizer || {};
  const mobilepayNumber = organizer.mobilepay_number || null;
  const organizerName = organizer.name || organizer.business_name || "";
  const organizerEmail = organizer.email || "";

  const total = Number(booking?.total_amount_dkk || 0);
  // Reference shown in the MobilePay comment. Two formats land here:
  //   booking.reference  — long form like B-2026-0451-7K4Q
  //   booking.short_ref  — short 6-digit code shown also at door
  // We use short_ref when present (easier for the visitor to read in
  // the MobilePay confirmation screen), falling back to the reference.
  const paymentRef =
    booking?.short_ref || booking?.reference || (booking?.id ? `B-${booking.id.slice(0, 8)}` : "");

  // Deep-link URL — null if we have no MobilePay number to send to.
  // Computed inline (no useMemo) — the React compiler memoizes the
  // body of a render automatically and useMemo here triggers a
  // "manual memoization could not be preserved" warning because the
  // deps array references object fields that the compiler can't prove
  // immutable.
  const mobilePayUrl = buildMobilePayUrl({
    number: mobilepayNumber,
    amount: total,
    ref: paymentRef,
  });

  // Backend renders the QR for the mobilepay:// URL at:
  //   GET /api/public/bookings/{id}/mobilepay-qr.png?token=...
  // We render an <img> when we have both id + token. If anything is
  // missing the QR slot is omitted and the MobilePay button still
  // works on its own.
  const qrSrc =
    booking?.id && booking?.token
      ? `${api.defaults.baseURL || ""}/public/bookings/${booking.id}/mobilepay-qr.png?token=${encodeURIComponent(booking.token)}`
      : null;

  // First ticket — the "Vis mine billetter →" link. The visitor's
  // primary ticket page is /t/{id}?sig=... per the spec. Sig comes from
  // the backend on booking-create (HMAC-signed JWT-like). We tolerate
  // it being undefined — the link is hidden if so.
  const firstTicket = Array.isArray(booking?.tickets) ? booking.tickets[0] : null;
  const firstTicketUrl =
    firstTicket?.id && firstTicket?.sig
      ? `/t/${firstTicket.id}?sig=${encodeURIComponent(firstTicket.sig)}`
      : null;

  // ── Renders ───────────────────────────────────────────────────────
  if (loadFailed && !booking) {
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
            {t("bookingErrorGeneric", "Noget gik galt. Prøv igen om et øjeblik.")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            {t("bookingSuccessEmailHint", "Eller find linket i din email.")}
          </p>
          <Button
            variant="secondary"
            size="md"
            onClick={() => window.location.assign(`/e/${slug}`)}
          >
            {t("bookingBackToEvent", "Tilbage til arrangement")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-10 sm:py-14">
      <div className="max-w-md mx-auto space-y-6">
        {/* ── Header: ✓ icon + title + ref ─────────────────────────── */}
        <header className="text-center space-y-2">
          <div
            className={
              "inline-flex items-center justify-center w-12 h-12 rounded-full " +
              "bg-gray-50 dark:bg-gray-900/60 " +
              "border border-gray-100 dark:border-gray-800"
            }
            aria-hidden="true"
          >
            <Check
              size={24}
              strokeWidth={2}
              className="text-emerald-600 dark:text-emerald-400"
            />
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
            {t("bookingSuccessTitle", "Reservation modtaget")}
          </h1>
          {paymentRef && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("bookingSuccessRef", "Reservation")} #{paymentRef}
            </p>
          )}
        </header>

        {/* ── Payment instructions card ─────────────────────────────── */}
        {mobilepayNumber && total > 0 ? (
          <div
            className={
              "rounded-xl border border-gray-200 dark:border-gray-700 " +
              "bg-white dark:bg-gray-900 p-5 sm:p-6 space-y-4"
            }
          >
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {t("bookingSuccessPayHeading", "Betal {amount} kr", {
                amount: fmtKr(total),
              })}
            </h2>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
              {t(
                "bookingSuccessMobilePayInstr",
                "Send {amount} kr på MobilePay til {number} med beskeden: {ref}",
                {
                  amount: fmtKr(total),
                  number: mobilepayNumber,
                  ref: paymentRef,
                },
              )}
            </p>
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                if (mobilePayUrl && typeof window !== "undefined") {
                  // window.location.assign is the most cross-platform
                  // way to invoke a custom scheme. On iOS Safari, this
                  // pops the MobilePay app instantly; on Android Chrome,
                  // a dialog asks. window.open(url, "_self") would also
                  // work but assign is slightly more reliable on iOS.
                  window.location.assign(mobilePayUrl);
                }
              }}
              className="w-full"
            >
              {t("bookingSuccessMobilePayBtn", "Åbn MobilePay")}
            </Button>
            {qrSrc && (
              <div className="pt-2 text-center space-y-2">
                <img
                  src={qrSrc}
                  alt=""
                  width={200}
                  height={200}
                  className="mx-auto rounded-lg bg-white"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    "bookingSuccessScanQr",
                    "Eller scan denne QR kode i din MobilePay app",
                  )}
                </p>
              </div>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed border-t border-gray-100 dark:border-gray-800 pt-3">
              {t(
                "bookingSuccessNeverCard",
                "BonBox modtager aldrig dine kortdata. Betalingen går direkte til {organizer}.",
                { organizer: organizerName || "arrangøren" },
              )}
            </p>
          </div>
        ) : (
          // No MobilePay number on file → text-only fallback. We keep
          // the same gray card chrome so the page reads as "intentional
          // path", not "broken state".
          <div
            className={
              "rounded-xl border border-gray-200 dark:border-gray-700 " +
              "bg-white dark:bg-gray-900 p-5 sm:p-6 space-y-3"
            }
          >
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("bookingSuccessPayHeading", "Betal {amount} kr", {
                amount: fmtKr(total),
              })}
            </h2>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
              {t(
                "bookingSuccessNoMobilePay",
                "Kontakt arrangøren for betaling: {email}",
                { email: organizerEmail || "—" },
              )}
            </p>
          </div>
        )}

        {/* ── View tickets + email hint ────────────────────────────── */}
        <div className="text-center space-y-1.5">
          {firstTicketUrl ? (
            <a
              href={firstTicketUrl}
              className={
                "inline-flex items-center text-sm font-medium " +
                "text-gray-900 dark:text-gray-100 underline-offset-4 hover:underline"
              }
            >
              {t("bookingSuccessViewTicket", "Vis mine billetter →")}
            </a>
          ) : null}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("bookingSuccessEmailHint", "Eller find linket i din email.")}
          </p>
        </div>
      </div>
    </div>
  );
}
