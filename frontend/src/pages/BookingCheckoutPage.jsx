// BookingCheckoutPage — the 3-step funnel at /e/{slug}/checkout.
//
// Wizard pattern (one step at a time, no tabs). Receives the visitor's
// ticket selection from EventPublicPage via location.state.
//
//   Step 1 — Review:   read-only summary of tickets + addons + total
//   Step 2 — Contact:  name (required), email (required), phone (opt),
//                      marketing-consent chip (default OFF — GDPR)
//   Step 3 — Confirm:  full summary + refund policy + honest claim,
//                      "Bekræft reservation →" button
//
// On submit (Step 3):
//   • Generate idempotency_key = crypto.randomUUID()
//   • POST /api/public/bookings with payload per spec §4.5
//   • 200 → navigate to /e/{slug}/success with the response body
//   • 409 → capacity error UI with "Refresh" CTA
//   • 5xx → generic retry UI
//
// Doctrine compliance:
//   • Cover photo is the only color moment — checkout doesn't have one,
//     so the page is ALL gray + content. No accent strips, no banners.
//   • Sticky bottom CTA on mobile (the primary action lives there).
//   • All buttons via <Button>, all inputs via <Input>, all chips via
//     <Chip>. Status pills are gray-100 bg + colored dot.
//
// DK terminology lock applies: MOMS / revisor / faktura / kreditnota
// stay Danish in all locales.
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, AlertCircle, Check } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import Button from "../components/ui/Button";
import Chip from "../components/ui/Chip";
import Input from "../components/ui/Input";

function fmtKr(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "0";
  try {
    return amount.toLocaleString("da-DK");
  } catch {
    return String(amount);
  }
}

// Email regex — strict enough to reject obvious garbage, permissive
// enough to let real DK customers through (æøå and unicode TLDs).
// The backend re-validates (L3 input bounds) so this is just for the
// inline error message.
function isEmailValid(v) {
  if (!v || typeof v !== "string") return false;
  const trimmed = v.trim();
  if (trimmed.length < 5 || trimmed.length > 255) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

// Map refund_policy string to the visitor-facing copy key. Default
// 'organizer' matches the backend default per spec §12.5.
function refundPolicyKey(policy) {
  if (policy === "no_refund") return "bookingRefundNo";
  if (policy === "7day") return "bookingRefund7day";
  return "bookingRefundOrganizer";
}

// Build a flat array of {label, qty, price} rows from the selection +
// event snapshot. Used for the summary card. Skips zero-qty lines —
// the summary should only show what the visitor actually selected.
function buildSummaryLines(event, ticketQtys, addonQtys) {
  const rows = [];
  if (Array.isArray(event?.ticket_tiers)) {
    for (const tier of event.ticket_tiers) {
      const qty = ticketQtys?.[tier.label] || 0;
      if (qty > 0) {
        rows.push({
          kind: "ticket",
          label: tier.label,
          qty,
          unit: Number(tier.price_dkk) || 0,
        });
      }
    }
  }
  if (Array.isArray(event?.addons)) {
    for (const addon of event.addons) {
      const qty = addonQtys?.[addon.label] || 0;
      if (qty > 0) {
        rows.push({
          kind: "addon",
          label: addon.label,
          qty,
          unit: Number(addon.price_dkk) || 0,
        });
      }
    }
  }
  return rows;
}

export default function BookingCheckoutPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();

  // ── Read incoming selection from EventPublicPage location.state ─────
  // Memoize the {} fallbacks so we don't return a fresh empty object on
  // every render — that would invalidate downstream useMemo deps and
  // re-derive `lines` / `total` on every keystroke.
  const ticketQtys = useMemo(
    () => location.state?.ticketQtys || {},
    [location.state],
  );
  const addonQtys = useMemo(
    () => location.state?.addonQtys || {},
    [location.state],
  );
  const passedEvent = location.state?.eventSnapshot || null;

  const [event, setEvent] = useState(passedEvent);
  const [loadingEvent, setLoadingEvent] = useState(!passedEvent);
  const [step, setStep] = useState(1);

  // Contact-info state (Step 2)
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [contactTouched, setContactTouched] = useState(false);

  // Submit state (Step 3)
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(""); // "" | "capacity" | "generic"

  // If we landed without a selection (e.g. direct URL load), redirect
  // back to the event page. The funnel only makes sense when the
  // visitor has already picked tickets.
  useEffect(() => {
    const hasSelection =
      Object.values(ticketQtys || {}).some((v) => Number(v) > 0) ||
      Object.values(addonQtys || {}).some((v) => Number(v) > 0);
    if (!hasSelection) {
      navigate(`/e/${slug}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch event if we didn't get a snapshot. Defensive against
  // direct-link reloads on this URL.
  useEffect(() => {
    if (passedEvent) return;
    let alive = true;
    // No synchronous setLoadingEvent(true) — initial useState
    // (!passedEvent) covers first mount; .finally flips it below.
    api
      .get(`/public/events/${slug}`)
      .then((r) => {
        if (!alive) return;
        setEvent(r?.data || null);
      })
      .catch(() => {
        if (!alive) return;
        // Redirect home — the event link is dead, nothing we can do
        // from inside checkout.
        navigate(`/e/${slug}`, { replace: true });
      })
      .finally(() => {
        if (alive) setLoadingEvent(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, passedEvent, navigate]);

  // ── Derive summary lines + total ──────────────────────────────────
  const lines = useMemo(
    () => buildSummaryLines(event, ticketQtys, addonQtys),
    [event, ticketQtys, addonQtys],
  );
  const total = useMemo(
    () => lines.reduce((sum, l) => sum + l.qty * l.unit, 0),
    [lines],
  );

  // ── Step 2 validation ─────────────────────────────────────────────
  const nameValid = name.trim().length >= 1 && name.trim().length <= 160;
  const emailValid = isEmailValid(email);
  const canAdvanceToStep3 = nameValid && emailValid;

  // ── Submit handler ────────────────────────────────────────────────
  const onSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError("");

    // Generate idempotency_key on every submit attempt. If the user
    // retries after a 409 we WANT a fresh key (the conflict was on
    // capacity, not on the booking key). Spec §4.5 has the wire shape.
    const idempotency_key =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const payload = {
      event_slug: slug,
      idempotency_key,
      customer_name: name.trim(),
      customer_email: email.trim(),
      customer_phone: phone.trim() || null,
      customer_consent_marketing: !!marketingConsent,
      ticket_lines: lines
        .filter((l) => l.kind === "ticket")
        .map((l) => ({ label: l.label, qty: l.qty, unit_price_dkk: l.unit })),
      addon_lines: lines
        .filter((l) => l.kind === "addon")
        .map((l) => ({ label: l.label, qty: l.qty, unit_price_dkk: l.unit })),
    };

    try {
      const res = await api.post("/public/bookings", payload);
      const data = res?.data || null;
      // Navigate to success page with the booking response. The
      // success page reads location.state to render the MobilePay
      // payment-instructions card without an extra fetch.
      navigate(`/e/${slug}/success`, {
        state: { booking: data, event },
      });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        setSubmitError("capacity");
      } else {
        setSubmitError("generic");
      }
      setSubmitting(false);
    }
  };

  // ── Renders ───────────────────────────────────────────────────────
  if (loadingEvent || !event) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-12">
        <div className="max-w-md mx-auto space-y-4">
          <div className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800 h-6 w-1/2" />
          <div className="animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800 h-32" />
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center pt-4">
            {t("bookingLoading", "Henter arrangement…")}
          </p>
        </div>
      </div>
    );
  }

  // Render the booking summary as a reusable component. Used on both
  // Step 1 (review) and Step 3 (confirm). Inline so it stays close to
  // the consuming JSX — no need for a separate file.
  const SummaryCard = () => (
    <div
      className={
        "rounded-xl border border-gray-200 dark:border-gray-700 " +
        "bg-white dark:bg-gray-900 p-4 sm:p-5 space-y-3"
      }
    >
      <div>
        <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
          {event.name}
        </p>
        {event.starts_at && (
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {new Date(event.starts_at).toLocaleString("da-DK", {
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {lines.map((line, i) => (
          <div
            key={`${line.kind}-${line.label}-${i}`}
            className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {line.label}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {line.qty} × {fmtKr(line.unit)} kr
              </p>
            </div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 shrink-0">
              {fmtKr(line.qty * line.unit)} kr
            </p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-gray-200 dark:border-gray-700">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t("bookingTotal", "I alt")}
        </p>
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {fmtKr(total)} kr
        </p>
      </div>
    </div>
  );

  // Tiny step-indicator strip — 3 dots, the current one filled. Stays
  // monochrome per the doctrine.
  const StepIndicator = () => (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={3}
      aria-valuenow={step}
      aria-label={t("bookingStepAria", "Checkout step")}
    >
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={
            "inline-block rounded-full transition-all " +
            (n === step
              ? "bg-gray-900 dark:bg-gray-100 h-2 w-6"
              : n < step
                ? "bg-gray-400 dark:bg-gray-500 h-2 w-2"
                : "bg-gray-200 dark:bg-gray-700 h-2 w-2")
          }
        />
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 pb-32">
      <div className="max-w-md mx-auto px-4 sm:px-6 pt-6 sm:pt-10 space-y-6">
        {/* ── Header: back button + step indicator ─────────────────── */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              if (step === 1) {
                navigate(`/e/${slug}`);
              } else {
                setStep((s) => Math.max(1, s - 1));
                setSubmitError("");
              }
            }}
            className={
              "inline-flex items-center gap-1.5 text-sm text-gray-700 " +
              "dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
            }
            aria-label={t("bookingBackToEvent", "Tilbage til arrangement")}
          >
            <ArrowLeft size={16} strokeWidth={1.75} />
            <span>{t("bookingBackToEvent", "Tilbage til arrangement")}</span>
          </button>
          <StepIndicator />
        </div>

        {/* ── Step 1 — Review ──────────────────────────────────────── */}
        {step === 1 && (
          <section className="space-y-4">
            <h1 className="text-[28px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
              {t("bookingStepReview", "Tjek dit valg")}
            </h1>
            <SummaryCard />
          </section>
        )}

        {/* ── Step 2 — Contact info ────────────────────────────────── */}
        {step === 2 && (
          <section className="space-y-4">
            <h1 className="text-[28px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
              {t("bookingStepContact", "Dine oplysninger")}
            </h1>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t("bookingContactName", "Fulde navn")}
                </label>
                <Input
                  type="text"
                  size="lg"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setContactTouched(true)}
                  placeholder={t("bookingContactNamePh", "Anna Hansen")}
                  invalid={contactTouched && !nameValid}
                  error={
                    contactTouched && !nameValid
                      ? t("bookingNameRequired", "Indtast dit navn.")
                      : null
                  }
                  autoComplete="name"
                  maxLength={160}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t("bookingContactEmail", "Email")}
                </label>
                <Input
                  type="email"
                  size="lg"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setContactTouched(true)}
                  placeholder={t("bookingContactEmailPh", "anna@eksempel.dk")}
                  invalid={contactTouched && !emailValid}
                  error={
                    contactTouched && !emailValid
                      ? t("bookingEmailRequired", "Indtast en gyldig email.")
                      : null
                  }
                  autoComplete="email"
                  inputMode="email"
                  maxLength={255}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t("bookingContactPhone", "Telefon (valgfrit)")}
                </label>
                <Input
                  type="tel"
                  size="lg"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={t("bookingContactPhonePh", "+45 12 34 56 78")}
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={40}
                />
              </div>
              <div className="pt-2 space-y-1.5">
                <Chip
                  selected={marketingConsent}
                  onClick={() => setMarketingConsent((v) => !v)}
                  size="md"
                  iconLeft={
                    marketingConsent ? <Check size={14} strokeWidth={2} /> : null
                  }
                >
                  {t(
                    "bookingMarketingConsent",
                    "Send mig nyheder om fremtidige arrangementer",
                  )}
                </Chip>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  {t(
                    "bookingMarketingHint",
                    "Valgfrit. Du modtager altid dine billetdetaljer; dette dækker kun nyhedsbreve om fremtidige arrangementer.",
                  )}
                </p>
              </div>
            </div>
          </section>
        )}

        {/* ── Step 3 — Confirm ─────────────────────────────────────── */}
        {step === 3 && (
          <section className="space-y-4">
            <h1 className="text-[28px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
              {t("bookingStepConfirm", "Bekræft reservation")}
            </h1>
            <SummaryCard />
            {/* Contact summary card */}
            <div
              className={
                "rounded-xl border border-gray-200 dark:border-gray-700 " +
                "bg-white dark:bg-gray-900 p-4 sm:p-5 space-y-1"
              }
            >
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {name}
              </p>
              <p className="text-sm text-gray-700 dark:text-gray-300">{email}</p>
              {phone && (
                <p className="text-sm text-gray-700 dark:text-gray-300">{phone}</p>
              )}
            </div>
            {/* Refund policy + honest claim — both stay in calm gray
                cards. No accent banners (doctrine: no color callouts). */}
            <div
              className={
                "rounded-xl bg-gray-50 dark:bg-gray-900/60 " +
                "border border-gray-100 dark:border-gray-800 p-4 space-y-2"
              }
            >
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                {t(
                  refundPolicyKey(event.refund_policy),
                  "Refundering håndteres af arrangøren — kontakt dem direkte hvis du har brug for at annullere.",
                )}
              </p>
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                {t(
                  "bookingHonestClaim",
                  "Når du reserverer, sendes dine billet-detaljer til din email. Du betaler arrangøren direkte via MobilePay, Dankort, eller kontant.",
                )}
              </p>
            </div>
            {/* Error surfaces, only on submit failure */}
            {submitError === "capacity" && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
                <div className="flex items-start gap-2 mb-3">
                  <AlertCircle
                    size={16}
                    strokeWidth={1.75}
                    className="text-red-600 dark:text-red-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t(
                      "bookingErrorCapacity",
                      "Beklager — arrangementet er fyldt op imens du booked. Reservationen blev ikke gennemført.",
                    )}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => navigate(`/e/${slug}`)}
                  className="w-full"
                >
                  {t("bookingErrorRefresh", "Genindlæs og prøv igen")}
                </Button>
              </div>
            )}
            {submitError === "generic" && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
                <div className="flex items-start gap-2 mb-3">
                  <AlertCircle
                    size={16}
                    strokeWidth={1.75}
                    className="text-amber-500 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t(
                      "bookingErrorGeneric",
                      "Noget gik galt. Prøv igen om et øjeblik.",
                    )}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => setSubmitError("")}
                  className="w-full"
                >
                  {t("bookingErrorRetry", "Prøv igen")}
                </Button>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Sticky bottom CTA ──────────────────────────────────────── */}
      <div
        className={
          "fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-gray-950 " +
          "border-t border-gray-200 dark:border-gray-800"
        }
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)" }}
      >
        <div className="max-w-md mx-auto px-4 sm:px-6 py-3">
          {step === 1 && (
            <Button
              variant="primary"
              size="lg"
              onClick={() => setStep(2)}
              className="w-full"
            >
              {t("bookingNext", "Næste →")}
            </Button>
          )}
          {step === 2 && (
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                setContactTouched(true);
                if (canAdvanceToStep3) setStep(3);
              }}
              disabled={!canAdvanceToStep3}
              className="w-full"
            >
              {t("bookingNext", "Næste →")}
            </Button>
          )}
          {step === 3 && (
            <Button
              variant="primary"
              size="lg"
              onClick={onSubmit}
              busy={submitting}
              disabled={submitting || !!submitError}
              className="w-full"
            >
              {t("bookingConfirm", "Bekræft reservation →")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
