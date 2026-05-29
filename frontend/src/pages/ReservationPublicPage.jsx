// ReservationPublicPage — the public table-booking widget at /r/{slug}.
//
// Mobile-first (390px reference). PUBLIC route — no auth, no session
// cookie needed. The visitor lands here from the restaurant's link in
// their bio / Google profile / a QR on the table. Target flow is ~15
// seconds: pick a date + party size, tap a time slot, leave a name,
// done.
//
// Doctrine-compliant: gray-* palette only, emerald reserved for the one
// confirm "money moment". rounded-xl cards, 1px gray-200 borders,
// gray-900 text, Lucide outline icons, light-mode default. Matches the
// EventPublicPage / BookingCheckoutPage visitor surface exactly (same
// `api` client, same da-DK date formatting, same sticky-CTA pattern).
//
// Multi-step wizard (one step on screen at a time):
//   Step 1 — pick DATE (today … today+max_advance_days) + PARTY SIZE.
//             On change → GET availability → render time-slot chips.
//   Step 2 — guest details (name required; email/phone/occasion/notes
//             optional) + an OPTIONAL allergy block (invite, not require).
//   Success — "Confirmed" or "Request received" depending on status.
//
// Backend contract (app/routers/public_reservations.py):
//   GET  /public/reservations/{slug}                       → page data
//   GET  /public/reservations/{slug}/availability?day=&party= → slots
//   POST /public/reservations/{slug}  (+ X-Idempotency-Key) → create
//   GET  /public/reservations/booking/{id}?token=          → poll
//   410 → reservations off / feature gone → "not taking bookings".
//   409 → slot_unavailable | party_too_large | not_accepting.
//
// DK terminology lock applies: revisor / MOMS etc. stay Danish in all
// locales. The public copy here defaults to Danish (DK-first market).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Calendar,
  Users,
  MapPin,
  Clock,
  AlertCircle,
  CheckCircle2,
  Info,
} from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import Button from "../components/ui/Button";
import Chip from "../components/ui/Chip";
import Input from "../components/ui/Input";

// ── Severity ladder ────────────────────────────────────────────────
// Mirrors backend app/services/allergens.py SEVERITY_LEVELS. Stored as
// the stable key; the human label is resolved through the i18n layer.
const SEVERITY_KEYS = ["preference", "intolerance", "severe"];

// localStorage key prefix — we stash the signed booking_token per
// reservation id so a returning visitor on the same device can poll
// the live status without re-authenticating.
const TOKEN_STORE_PREFIX = "bonbox_rsvp_token_";

// ── Date helpers ───────────────────────────────────────────────────
// YYYY-MM-DD for <input type="date"> + the API. We build the "today"
// string from local wall-clock (the public widget defaults to the
// restaurant's market = Europe/Copenhagen; the backend re-validates the
// window against its own local clock, so a small client skew is fine).
function isoDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(isoStr, n) {
  const d = new Date(`${isoStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

// Pretty DK date for the header / success screen: "lørdag 13. juni".
function fmtDayLabel(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(`${isoStr}T00:00:00`);
    return d.toLocaleDateString("da-DK", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  } catch {
    return isoStr;
  }
}

export default function ReservationPublicPage() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const { t } = useLanguage();

  // ── Page data (GET /public/reservations/{slug}) ──────────────────
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(""); // "" | "closed" | "generic"

  // ── Step state ───────────────────────────────────────────────────
  const [step, setStep] = useState(1); // 1 = date+party+slot, 2 = details

  // Step 1 selections. Pre-fill from ?d=YYYY-MM-DD&party=N if present.
  const today = useMemo(() => isoDay(new Date()), []);
  const [day, setDay] = useState("");
  const [party, setParty] = useState(2);
  const [slot, setSlot] = useState("");

  // Availability for the current day+party.
  const [slots, setSlots] = useState([]);
  const [groupRequest, setGroupRequest] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");

  // Step 2 — guest details.
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [occasion, setOccasion] = useState("");
  const [guestNotes, setGuestNotes] = useState("");
  const [nameTouched, setNameTouched] = useState(false);

  // Optional allergy block (invite, not require).
  const [allergyOpen, setAllergyOpen] = useState(false);
  const [allergenTags, setAllergenTags] = useState([]); // array of keys
  const [allergySeverity, setAllergySeverity] = useState("preference");
  const [allergyNote, setAllergyNote] = useState("");

  // GDPR — marketing consent default OFF.
  const [consentMarketing, setConsentMarketing] = useState(false);

  // Submit.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(""); // "" | error-key
  const [result, setResult] = useState(null); // {id, status, booking_token}

  // ── Load the page data ───────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    // No synchronous setLoading(true) — initial useState(true) covers
    // first mount; the .finally below flips it (keeps the effect free of
    // React 19's set-state-in-effect rule, matching EventPublicPage).
    api
      .get(`/public/reservations/${slug}`)
      .then((r) => {
        if (!alive) return;
        setPage(r?.data || null);
        setLoadError("");
      })
      .catch((err) => {
        if (!alive) return;
        if (err?.response?.status === 410) {
          setLoadError("closed");
        } else {
          setLoadError("generic");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  // ── Seed step-1 selections once the page + query params resolve ───
  useEffect(() => {
    if (!page) return;
    const qDay = searchParams.get("d");
    const qParty = parseInt(searchParams.get("party") || "", 10);
    const maxAdvance = Number(page.max_advance_days) || 60;
    const maxParty = Number(page.max_party_size) || 10;

    // Validate the query day is within [today, today+maxAdvance].
    let initialDay = today;
    if (qDay && /^\d{4}-\d{2}-\d{2}$/.test(qDay)) {
      const latest = addDays(today, maxAdvance);
      if (qDay >= today && qDay <= latest) initialDay = qDay;
    }
    setDay(initialDay);

    if (Number.isFinite(qParty) && qParty >= 1) {
      setParty(Math.min(qParty, maxParty));
    } else {
      setParty(Math.min(2, maxParty));
    }
    // Only seed once, when the page first loads. Subsequent user edits
    // own the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // ── Fetch availability whenever day or party changes ─────────────
  const fetchAvailability = useCallback(
    async (forDay, forParty) => {
      if (!forDay || !forParty) return;
      setSlotsLoading(true);
      setSlotsError("");
      setSlot("");
      try {
        const res = await api.get(`/public/reservations/${slug}/availability`, {
          params: { day: forDay, party: forParty },
        });
        setSlots(Array.isArray(res.data?.slots) ? res.data.slots : []);
        setGroupRequest(!!res.data?.group_request);
      } catch (err) {
        setSlots([]);
        setGroupRequest(false);
        setSlotsError(
          err?.response?.data?.detail?.error ||
            t("rsvpSlotsError", "Couldn't load times — please try again."),
        );
      } finally {
        setSlotsLoading(false);
      }
    },
    [slug, t],
  );

  useEffect(() => {
    if (!page || !day || !party) return;
    fetchAvailability(day, party);
  }, [page, day, party, fetchAvailability]);

  // ── Derived ──────────────────────────────────────────────────────
  const maxParty = Number(page?.max_party_size) || 10;
  const maxAdvance = Number(page?.max_advance_days) || 60;
  const latestDay = useMemo(() => addDays(today, maxAdvance), [today, maxAdvance]);
  const allergenSet = useMemo(
    () => (Array.isArray(page?.allergen_set) ? page.allergen_set : []),
    [page],
  );
  const nameValid = guestName.trim().length >= 1 && guestName.trim().length <= 160;
  // A group request doesn't need a chosen slot (the visitor sends a
  // request for the day; the restaurant confirms a time). A normal
  // booking requires a slot.
  const canSubmit = nameValid && (groupRequest || !!slot) && !submitting;

  const partyOptions = useMemo(() => {
    const list = [];
    for (let i = 1; i <= maxParty; i += 1) list.push(i);
    return list;
  }, [maxParty]);

  function toggleAllergen(key) {
    setAllergenTags((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  // ── Submit ───────────────────────────────────────────────────────
  // One idempotency key per attempt. After a 409 we generate a fresh
  // key (the conflict was on the slot, not the booking key) — mirrors
  // the BookingCheckoutPage pattern.
  function newIdempotencyKey() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const onSubmit = async () => {
    if (!canSubmit) {
      setNameTouched(true);
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    const hasAllergy =
      allergenTags.length > 0 || allergyNote.trim().length > 0;
    const payload = {
      day,
      // For a group request the backend ignores the exact time (it's a
      // day-level request) but the schema still wants HH:MM — send the
      // chosen slot if any, else a neutral opening-ish time.
      time: slot || "18:00",
      party_size: party,
      guest_name: guestName.trim(),
      guest_email: guestEmail.trim() || null,
      guest_phone: guestPhone.trim() || null,
      occasion: occasion.trim() || null,
      guest_notes: guestNotes.trim() || null,
      allergen_tags: hasAllergy ? allergenTags : [],
      allergy_note: hasAllergy ? allergyNote.trim() || null : null,
      allergy_severity: hasAllergy ? allergySeverity : null,
      consent_marketing: !!consentMarketing,
    };
    try {
      const res = await api.post(`/public/reservations/${slug}`, payload, {
        headers: { "X-Idempotency-Key": newIdempotencyKey() },
      });
      const data = res?.data || null;
      setResult(data);
      // Stash the booking token so a return visit can poll the status.
      if (data?.id && data?.booking_token) {
        try {
          localStorage.setItem(`${TOKEN_STORE_PREFIX}${data.id}`, data.booking_token);
        } catch {
          /* private mode / storage blocked — non-fatal */
        }
      }
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.detail?.error;
      if (status === 409 || status === 410) {
        // slot_unavailable | party_too_large | not_accepting
        setSubmitError(code || "slot_unavailable");
        // The slot is gone — refetch availability so the visitor sees a
        // fresh set without manually changing the date.
        if (code === "slot_unavailable") {
          fetchAvailability(day, party);
          setStep(1);
        }
      } else {
        setSubmitError("generic");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Renders ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-12">
        <div className="max-w-md mx-auto space-y-4">
          <div className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800 h-8 w-2/3" />
          <div className="animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800 h-32" />
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center pt-4">
            {t("rsvpLoading", "Henter…")}
          </p>
        </div>
      </div>
    );
  }

  if (loadError === "closed") {
    return (
      <ClosedScreen
        t={t}
        name={page?.business_name}
      />
    );
  }

  if (loadError || !page) {
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
            {t("rsvpNotFound", "Vi kunne ikke finde siden")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t(
              "rsvpNotFoundHint",
              "Linket kan være forkert, eller stedet tager ikke imod reservationer lige nu.",
            )}
          </p>
        </div>
      </div>
    );
  }

  // ── Success screen ─────────────────────────────────────────────────
  if (result) {
    const isRequest = result.status === "requested";
    return (
      <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-12">
        <div className="max-w-md mx-auto space-y-6 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-50 dark:bg-emerald-900/20 mx-auto">
            <CheckCircle2
              size={28}
              strokeWidth={1.75}
              className="text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-1">
            <h1 className="text-[26px] font-semibold tracking-tight text-gray-900 dark:text-gray-100">
              {isRequest
                ? t("rsvpRequestTitle", "Forespørgsel modtaget")
                : t("rsvpConfirmedTitle", "Reservation bekræftet")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {isRequest
                ? t(
                    "rsvpRequestBody",
                    "Vi har modtaget din forespørgsel — stedet vender tilbage for at bekræfte.",
                  )
                : t(
                    "rsvpConfirmedBody",
                    "Vi glæder os til at se dig. Du modtager en bekræftelse hvis du har angivet en email.",
                  )}
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 text-left space-y-2">
            <SummaryRow
              icon={<Calendar size={16} strokeWidth={1.75} />}
              label={t("rsvpDateLabel", "Dato")}
              value={fmtDayLabel(day)}
            />
            {!isRequest && slot && (
              <SummaryRow
                icon={<Clock size={16} strokeWidth={1.75} />}
                label={t("rsvpTimeLabel", "Tidspunkt")}
                value={slot}
              />
            )}
            <SummaryRow
              icon={<Users size={16} strokeWidth={1.75} />}
              label={t("rsvpPartyLabel", "Antal gæster")}
              value={String(party)}
            />
            <SummaryRow
              icon={<Info size={16} strokeWidth={1.75} />}
              label={t("rsvpGuestLabel", "Navn")}
              value={guestName.trim()}
            />
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500">
            {page.business_name}
            {page.city ? ` · ${page.city}` : ""}
          </p>
        </div>
      </div>
    );
  }

  // ── Main wizard ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 pb-32">
      <div className="max-w-md mx-auto px-4 sm:px-6 pt-8 sm:pt-10 space-y-6">
        {/* Header */}
        <header className="space-y-1">
          <p className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("rsvpEyebrow", "Reservation")}
          </p>
          <h1 className="text-[26px] font-semibold tracking-tight text-gray-900 dark:text-gray-100 leading-tight">
            {page.business_name}
          </h1>
          {(page.city || page.address) && (
            <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
              <MapPin size={14} strokeWidth={1.75} className="shrink-0" />
              <span>{page.address || page.city}</span>
            </div>
          )}
        </header>

        <StepDots step={step} t={t} />

        {/* ── Step 1 — date + party + slot ──────────────────────────── */}
        {step === 1 && (
          <section className="space-y-5">
            {/* Date */}
            <div>
              <label
                htmlFor="rsvp-day"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
              >
                {t("rsvpPickDate", "Vælg dato")}
              </label>
              <Input
                id="rsvp-day"
                type="date"
                size="lg"
                value={day}
                min={today}
                max={latestDay}
                onChange={(e) => setDay(e.target.value)}
                prefix={<Calendar size={16} strokeWidth={1.75} />}
              />
            </div>

            {/* Party size */}
            <div>
              <p className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t("rsvpPartySize", "Antal gæster")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {partyOptions.map((n) => (
                  <Chip
                    key={n}
                    size="md"
                    selected={party === n}
                    onClick={() => setParty(n)}
                    aria-label={t("rsvpPartyN", "{n} guests", { n })}
                  >
                    {n}
                  </Chip>
                ))}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                {t(
                  "rsvpPartyHint",
                  "Større selskab? Vælg det højeste antal — vi sender en forespørgsel.",
                )}
              </p>
            </div>

            {/* Group-request banner */}
            {groupRequest && (
              <div
                className="rounded-xl bg-gray-50 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700 px-4 py-3 flex items-start gap-2"
                role="status"
              >
                <Info
                  size={16}
                  strokeWidth={1.75}
                  className="text-gray-500 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t(
                    "rsvpGroupRequest",
                    "Selskaber på {n} eller flere sendes som en forespørgsel — stedet bekræfter.",
                    { n: party },
                  )}
                </p>
              </div>
            )}

            {/* Slots */}
            <div>
              <p className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t("rsvpPickTime", "Vælg tidspunkt")}
              </p>
              {slotsLoading ? (
                <div className="flex flex-wrap gap-1.5">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div
                      key={i}
                      className="animate-pulse h-9 w-16 rounded-lg bg-gray-100 dark:bg-gray-800"
                    />
                  ))}
                </div>
              ) : slotsError ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {slotsError}
                </p>
              ) : groupRequest ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    "rsvpGroupNoSlot",
                    "Du behøver ikke vælge et tidspunkt — skriv gerne dit ønske i noterne i næste trin.",
                  )}
                </p>
              ) : slots.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    "rsvpNoSlots",
                    "Ingen ledige tider — prøv en anden dato.",
                  )}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((s) => (
                    <Chip
                      key={s}
                      size="md"
                      selected={slot === s}
                      onClick={() => setSlot(s)}
                    >
                      {s}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Step 2 — guest details ────────────────────────────────── */}
        {step === 2 && (
          <section className="space-y-5">
            {/* Recap of the slot picked in step 1 */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-4 py-3 flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
              <Calendar size={16} strokeWidth={1.75} className="text-gray-500 shrink-0" />
              <span className="font-medium">{fmtDayLabel(day)}</span>
              {!groupRequest && slot && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{slot}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>
                {t("rsvpPartyN", "{n} guests", { n: party })}
              </span>
            </div>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="rsvp-name"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  {t("rsvpName", "Navn")}
                </label>
                <Input
                  id="rsvp-name"
                  size="lg"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  placeholder={t("rsvpNamePh", "Anna Hansen")}
                  invalid={nameTouched && !nameValid}
                  error={
                    nameTouched && !nameValid
                      ? t("rsvpNameRequired", "Indtast dit navn.")
                      : null
                  }
                  autoComplete="name"
                  maxLength={160}
                  required
                />
              </div>
              <div>
                <label
                  htmlFor="rsvp-email"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  {t("rsvpEmail", "Email (valgfrit)")}
                </label>
                <Input
                  id="rsvp-email"
                  type="email"
                  size="lg"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  placeholder={t("rsvpEmailPh", "anna@eksempel.dk")}
                  autoComplete="email"
                  inputMode="email"
                  maxLength={255}
                />
              </div>
              <div>
                <label
                  htmlFor="rsvp-phone"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  {t("rsvpPhone", "Telefon (valgfrit)")}
                </label>
                <Input
                  id="rsvp-phone"
                  type="tel"
                  size="lg"
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  placeholder={t("rsvpPhonePh", "+45 12 34 56 78")}
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={40}
                />
              </div>
              <div>
                <label
                  htmlFor="rsvp-occasion"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  {t("rsvpOccasion", "Anledning (valgfrit)")}
                </label>
                <Input
                  id="rsvp-occasion"
                  size="lg"
                  value={occasion}
                  onChange={(e) => setOccasion(e.target.value)}
                  placeholder={t("rsvpOccasionPh", "Fødselsdag, jubilæum…")}
                  maxLength={60}
                />
              </div>
              <div>
                <label
                  htmlFor="rsvp-notes"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  {t("rsvpNotes", "Besked til stedet (valgfrit)")}
                </label>
                <textarea
                  id="rsvp-notes"
                  value={guestNotes}
                  onChange={(e) => setGuestNotes(e.target.value)}
                  placeholder={t(
                    "rsvpNotesPh",
                    "Ønsker du et bestemt bord, en barnestol, eller andet?",
                  )}
                  rows={3}
                  maxLength={2000}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-3 py-2 text-sm focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400 dark:focus:border-gray-500 dark:focus:ring-gray-500"
                />
              </div>
            </div>

            {/* ── Optional allergy block (invite, not require) ───────── */}
            {allergenSet.length > 0 && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-3">
                {!allergyOpen ? (
                  <button
                    type="button"
                    onClick={() => setAllergyOpen(true)}
                    className="w-full text-left text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
                  >
                    <span className="font-medium">
                      {t("rsvpAllergyOpen", "Noget vi skal vide?")}
                    </span>{" "}
                    <span className="text-gray-500 dark:text-gray-400">
                      {t("rsvpAllergyOpenHint", "(allergier, kost) — valgfrit")}
                    </span>
                  </button>
                ) : (
                  <>
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {t("rsvpAllergyTitle", "Allergier eller kost (valgfrit)")}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {t(
                          "rsvpAllergyHint",
                          "Helt valgfrit — det hjælper køkkenet med at tage hensyn.",
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {allergenSet.map((a) => (
                        <Chip
                          key={a.key}
                          size="sm"
                          selected={allergenTags.includes(a.key)}
                          onClick={() => toggleAllergen(a.key)}
                        >
                          {t(`allergen_${a.key}`, a.en)}
                        </Chip>
                      ))}
                    </div>
                    <div>
                      <label
                        htmlFor="rsvp-severity"
                        className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                      >
                        {t("rsvpSeverity", "Hvor alvorligt?")}
                      </label>
                      <select
                        id="rsvp-severity"
                        value={allergySeverity}
                        onChange={(e) => setAllergySeverity(e.target.value)}
                        className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-3 h-10 text-sm focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400 dark:focus:border-gray-500 dark:focus:ring-gray-500"
                      >
                        {SEVERITY_KEYS.map((s) => (
                          <option key={s} value={s}>
                            {t(`rsvpSeverity_${s}`, severityFallback(s))}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="rsvp-allergy-note"
                        className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                      >
                        {t("rsvpAllergyNote", "Uddyb (valgfrit)")}
                      </label>
                      <textarea
                        id="rsvp-allergy-note"
                        value={allergyNote}
                        onChange={(e) => setAllergyNote(e.target.value)}
                        placeholder={t(
                          "rsvpAllergyNotePh",
                          "F.eks. svær nøddeallergi — ingen spor af nødder.",
                        )}
                        rows={2}
                        maxLength={2000}
                        className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 px-3 py-2 text-sm focus:outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400 dark:focus:border-gray-500 dark:focus:ring-gray-500"
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Marketing consent — default OFF (GDPR) */}
            <div className="space-y-1.5">
              <Chip
                selected={consentMarketing}
                onClick={() => setConsentMarketing((v) => !v)}
                size="md"
                iconLeft={
                  consentMarketing ? <CheckCircle2 size={14} strokeWidth={2} /> : null
                }
              >
                {t("rsvpMarketing", "Send mig nyheder og tilbud")}
              </Chip>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                {t(
                  "rsvpMarketingHint",
                  "Valgfrit. Du modtager altid din reservationsbekræftelse; dette dækker kun nyhedsbreve.",
                )}
              </p>
            </div>

            {/* Submit-error surfaces */}
            {submitError && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 flex items-start gap-2">
                <AlertCircle
                  size={16}
                  strokeWidth={1.75}
                  className="text-red-600 dark:text-red-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {submitErrorMessage(submitError, t)}
                </p>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Sticky bottom CTA ───────────────────────────────────────── */}
      <div
        className="fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)" }}
      >
        <div className="max-w-md mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          {step === 2 && (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                setStep(1);
                setSubmitError("");
              }}
            >
              {t("rsvpBack", "Tilbage")}
            </Button>
          )}
          {step === 1 ? (
            <Button
              variant="primary"
              size="lg"
              onClick={() => setStep(2)}
              disabled={!groupRequest && !slot}
              className="flex-1"
            >
              {t("rsvpNext", "Næste →")}
            </Button>
          ) : (
            <Button
              variant="accent"
              size="lg"
              onClick={onSubmit}
              busy={submitting}
              disabled={!canSubmit}
              className="flex-1"
            >
              {groupRequest
                ? t("rsvpSendRequest", "Send forespørgsel →")
                : t("rsvpConfirm", "Bekræft reservation →")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────

function StepDots({ step, t }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={2}
      aria-valuenow={step}
      aria-label={t("rsvpStepAria", "Reservation step")}
    >
      {[1, 2].map((n) => (
        <span
          key={n}
          className={
            "inline-block rounded-full transition-all h-2 " +
            (n === step
              ? "bg-gray-900 dark:bg-gray-100 w-6"
              : n < step
                ? "bg-gray-400 dark:bg-gray-500 w-2"
                : "bg-gray-200 dark:bg-gray-700 w-2")
          }
        />
      ))}
    </div>
  );
}

function SummaryRow({ icon, label, value }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-gray-400 dark:text-gray-500 shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 w-24 shrink-0">
        {label}
      </span>
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {value}
      </span>
    </div>
  );
}

function ClosedScreen({ t, name }) {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 px-4 py-16">
      <div className="max-w-md mx-auto text-center">
        <Calendar
          size={40}
          strokeWidth={1.5}
          className="text-gray-400 mx-auto mb-3"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {name
            ? t("rsvpClosedNamed", "{name} tager ikke imod reservationer", { name })
            : t("rsvpClosed", "Tager ikke imod reservationer")}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            "rsvpClosedHint",
            "Prøv igen senere, eller kontakt stedet direkte for at booke et bord.",
          )}
        </p>
      </div>
    </div>
  );
}

// English fallback for the severity <option> labels — keeps the select
// readable even before the i18n entries land (defence in depth; real
// keys live in useLanguage.jsx).
function severityFallback(key) {
  if (key === "preference") return "Preference";
  if (key === "intolerance") return "Intolerance";
  if (key === "severe") return "Severe";
  return key;
}

// Map a submit-error code to a friendly localized message.
function submitErrorMessage(code, t) {
  switch (code) {
    case "slot_unavailable":
      return t(
        "rsvpErrSlot",
        "Beklager — tidspunktet blev lige optaget. Vælg venligst en anden tid.",
      );
    case "party_too_large":
      return t(
        "rsvpErrParty",
        "Selskabet er større end vi kan booke online — kontakt stedet direkte.",
      );
    case "not_accepting":
      return t(
        "rsvpErrClosed",
        "Stedet tager ikke imod flere reservationer lige nu.",
      );
    default:
      return t("rsvpErrGeneric", "Noget gik galt. Prøv igen om et øjeblik.");
  }
}
