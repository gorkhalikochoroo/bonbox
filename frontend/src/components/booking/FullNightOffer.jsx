// A full night on the guest booking page (booking R12, rubric G5).
//
// A full evening used to be a dead end: the day said "fuldt" and the page
// jumped to the next open day. Now, when the server says the night is full
// (backend services/public_waitlist.py), this block offers:
//   • the NEAREST FREE TIMES — earlier the same day, the day before, the days
//     after — nearest the evening the guest wanted; one tap picks the day and
//     the time and the page carries on as if the guest had picked them;
//   • "Skriv mig på ventelisten" for that night (when the owner has the list
//     on and it still takes names): a name, a phone and an optional time,
//     inline (it works the same inside the embed, where a sheet would sit
//     below the frame's fold). Not a booking — every line says so;
//   • the venue's phone.
// A full EVENING on a day with lunch tables: the lunch times stay in the grid
// above, and this block says the evening is full under them.
//
// The join carries the guest-invisible spam signals a booking carries (the
// trap field, and how long the page has been open), and every answer keeps
// what the guest typed. The receipt says "not a booking yet", names the number
// the venue may use, and — with the link the server signed — lets the guest
// leave the list, which erases the name and number at once. The link goes into
// the address bar (?wl=&wt=), so a reload or a bookmark brings it back
// (the return card at the top of the page).
//
// Its own chunk: ReservationPublicPage loads it only on a full night (fetched
// ahead when the day strip shows one), so the booking page's first paint does
// not grow. It IMPORTS NOTHING of the page's: the page hands over its helpers
// and the shared pieces through `host.kit` (ReservationPublicPage
// FULL_NIGHT_KIT) and its confirm dialog as `host.confirm`. Imported here, the
// page's own helpers would be moved out of its chunk into small shared files,
// and every import's file list would sit inside the page's chunk (the 30 kB
// budget, rubric G14). Its own plain helpers (the receipts kept for the visit,
// the phone check, form_ms, the error codes) are in ./fullNightKit.js, which
// only this file imports. Every t() passes the en.js text.
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { formMs, joinErrorOf, joinedHere, keepReceipt, phoneOk, receiptFor } from "./fullNightKit";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900";
// The page's quiet call button (40 px / 13 px; min-h-0! releases the coarse
// pointer's 44 px floor in index.css).
const TEL_ACTION =
  "inline-flex items-center justify-center gap-2 h-10 min-h-0! px-4 rounded-lg text-[13px] font-medium " +
  "border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 " +
  "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-200 " + FOCUS;
const LABEL = "block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1.5";
const QUIET = "text-[13px] leading-snug text-gray-500 dark:text-gray-400";
const CARD = "rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4";

function telHref(phone) {
  if (!phone) return null;
  const s = String(phone).replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return s ? `tel:${encodeURIComponent(s)}` : null;
}

function partyText(n, t) {
  return Number(n) === 1 ? t("rsvpPartyOne", "1 guest") : t("rsvpPartyN", "{n} guests", { n });
}

// The waitlist link in the address bar: kept while the guest is waiting.
function useLinkKeeper() {
  const [, setSearchParams] = useSearchParams();
  return (r) =>
    setSearchParams((prev) => {
      const n = new URLSearchParams(prev);
      if (r?.token && r.status === "waiting") {
        n.set("wl", r.id);
        n.set("wt", r.token);
      } else {
        n.delete("wl");
        n.delete("wt");
      }
      return n;
    }, { replace: true });
}

// The guest's receipt: on the full night after joining, and at the top of the
// page when the guest comes back through the link.
function Receipt({ t, lang, kit, receipt, venue, phone, typedPhone, onLeave, leaving, leaveError }) {
  const { Button, Clock } = kit;
  const status = receipt?.status || "waiting";
  const day = receipt?.waitlist_date;
  const dayText = day ? kit.fmtDayLabel(day, lang) : "";
  const venueName = venue || t("rsvpWlVenueGeneric", "the venue");
  const canLeave = status === "waiting" && !!receipt?.token;
  return (
    <div className={CARD} data-testid="rsvp-wl-receipt" data-status={status}>
      <div role="status" className="space-y-1.5">
        {status === "waiting" && (
          <>
            <p className="flex items-center gap-2 text-[15px] font-semibold text-gray-900 dark:text-gray-100">
              <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
              {t("rsvpWlDoneTitle", "You're on the waitlist")}
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-300 first-letter:uppercase">
              {[dayText, partyText(receipt?.party_size, t),
                receipt?.preferred_time ? t("rsvpWlAround", "around {time}", { time: receipt.preferred_time }) : null]
                .filter(Boolean).join(" · ")}
            </p>
            <p className={QUIET}>
              {typedPhone
                ? t("rsvpWlDone", "It isn't a booking yet. If a table frees up, {venue} may contact you on {phone}.", { venue: venueName, phone: typedPhone })
                : t("rsvpWlDoneNoPhone", "It isn't a booking yet. If a table frees up, {venue} may contact you by phone.", { venue: venueName })}
            </p>
          </>
        )}
        {status === "booked" && (
          <p className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
            {t("rsvpWlBooked", "{venue} has booked a table for you on {day} at {time}.", {
              venue: venueName, day: kit.fmtDayLabel(receipt.booked_day || day, lang), time: receipt.booked_time || "",
            })}
          </p>
        )}
        {status === "left" && (
          <p className="text-sm text-gray-700 dark:text-gray-300">{t("rsvpWlLeft", "You're no longer on the waitlist.")}</p>
        )}
        {status === "closed" && (
          <p className="text-sm text-gray-700 dark:text-gray-300">{t("rsvpWlOver", "The waitlist for {day} has closed.", { day: dayText })}</p>
        )}
        {receipt?.erased && status !== "waiting" && (
          <p className={QUIET}>{t("rsvpWlErased", "Your name and number have been deleted.")}</p>
        )}
      </div>
      {status === "waiting" && (
        <div className="mt-3 space-y-2">
          {canLeave ? (
            <>
              <p className={QUIET}>{t("rsvpWlKeepPage", "Keep this page — you can also leave the list here.")}</p>
              <Button variant="ghost" size="md" className="h-10 min-h-0! -ml-3.5" busy={leaving} onClick={onLeave}>
                {t("rsvpWlLeave", "Take me off the waitlist")}
              </Button>
            </>
          ) : telHref(phone) ? (
            <p className={QUIET}>{t("rsvpWlLeaveCall", "To come off the list, call {phone}.", { phone })}</p>
          ) : null}
          {leaveError && (
            <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
              {t("rsvpWlErrLeave", "We couldn't take you off the list just now — try again.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Leaving the list: one confirm (it erases the name and number), then the
// signed POST. Shared by the full night and the return card.
function useLeave({ t, kit, confirm }, receipt, setReceipt) {
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState(false);
  const leave = async () => {
    if (!receipt?.id || !receipt?.token || leaving) return;
    const sure = await confirm({
      title: t("rsvpWlLeaveConfirmTitle", "Leave the waitlist?"),
      message: t("rsvpWlLeaveConfirmBody", "You'll be taken off the list and your name and number deleted."),
      confirmLabel: t("rsvpWlLeaveConfirmYes", "Yes, take me off"),
      cancelLabel: t("rsvpWlLeaveConfirmNo", "Stay on the list"),
      destructive: true,
    });
    if (!sure) return;
    setLeaving(true);
    setLeaveError(false);
    try {
      const res = await kit.api.post(`/public/reservations/booking/waitlist/${receipt.id}/cancel`, null, {
        params: { token: receipt.token },
      });
      setReceipt({ ...receipt, ...(res?.data || {}), token: "" });
    } catch {
      setLeaveError(true);
    } finally {
      setLeaving(false);
    }
  };
  return { leave, leaving, leaveError };
}

function WaitlistForm({ t, lang, kit, slug, day, party, offer, venue, phone, onJoined, onTableOpened, onCancel }) {
  const { Button, Input } = kit;
  const [name, setName] = useState("");
  const [tel, setTel] = useState("");
  const [time, setTime] = useState("");
  const [trap, setTrap] = useState("");
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef(null);
  useEffect(() => {
    try {
      nameRef.current?.focus({ preventScroll: true });
    } catch {
      /* noop */
    }
  }, []);

  const nameOk = name.trim().length >= 1;
  const telOk = phoneOk(tel);
  const venueName = venue || t("rsvpWlVenueGeneric", "the venue");
  const times = Array.isArray(offer?.waitlist_times) ? offer.waitlist_times : [];

  const submit = async (e) => {
    e?.preventDefault?.();
    setTouched(true);
    setError("");
    if (!nameOk || !telOk || sending) return;
    setSending(true);
    const typed = tel.split(/\s+/).filter(Boolean).join(" ");
    try {
      const res = await kit.api.post(`/public/reservations/${slug}/waitlist`, {
        day,
        party_size: party,
        guest_name: name.trim(),
        guest_phone: typed,
        preferred_time: time || null,
        lang: lang === "da" || lang === "en" ? lang : null,
        website: trap,
        form_ms: formMs(),
      });
      const data = res?.data || {};
      onJoined({ ...data, token: data.waitlist_token || "", phone: typed });
    } catch (err) {
      const why = joinErrorOf(err);
      setError(why);
      if (why === "not_full") onTableOpened?.();
    } finally {
      setSending(false);
    }
  };

  const nameError = (touched && !nameOk) || error === "name" ? t("rsvpNameRequired", "Enter your name.") : null;
  const phoneError =
    touched && !tel.trim()
      ? t("rsvpWlPhoneNeeded", "Add your phone number — it's how the venue reaches you.")
      : (touched && !telOk) || error === "phone"
        ? t("rsvpPhoneCheck", "Check your phone number — e.g. +45 12 34 56 78")
        : null;

  return (
    <form onSubmit={submit} noValidate className={CARD + " space-y-4"} data-testid="rsvp-wl-form">
      <p className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 first-letter:uppercase">
        {t("rsvpWlFormTitle", "Waitlist · {day}", { day: kit.fmtDayShort(day, lang) })}
      </p>
      <p className={QUIET}>
        {t("rsvpWlNotBooking", "This isn't a booking. If a table frees up, {venue} may contact you by phone — otherwise you won't hear more.", { venue: venueName })}
      </p>
      <div>
        <label htmlFor="rsvp-wl-name" className={LABEL}>{t("rsvpName", "Name")}</label>
        <Input
          id="rsvp-wl-name"
          ref={nameRef}
          size="lg"
          className="rounded-xl!"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          maxLength={80}
          error={nameError}
          enterKeyHint="next"
        />
      </div>
      <div>
        <label htmlFor="rsvp-wl-phone" className={LABEL}>{t("rsvpWlPhone", "Phone")}</label>
        <Input
          id="rsvp-wl-phone"
          size="lg"
          className="rounded-xl!"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={tel}
          onChange={(e) => setTel(e.target.value)}
          placeholder={t("rsvpPhonePh", "+45 12 34 56 78")}
          maxLength={40}
          error={phoneError}
          hint={phoneError ? null : t("rsvpWlPhoneWhy", "The venue only uses your number to tell you about a free table.")}
        />
      </div>
      {times.length > 0 && (
        <div>
          <label htmlFor="rsvp-wl-time" className={LABEL}>{t("rsvpWlPreferredTime", "When would suit you? (optional)")}</label>
          <select
            id="rsvp-wl-time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={"w-full h-12 px-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-base text-gray-900 dark:text-gray-100 tabular-nums " + FOCUS}
          >
            <option value="">
              {offer?.evening_full ? t("rsvpWlAnyTimeEvening", "Any time in the evening") : t("rsvpWlAnyTime", "Any time")}
            </option>
            {times.map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </div>
      )}
      {/* The trap field, as on the booking form: off-screen, out of the tab
          order, hidden from screen readers and from password managers. A
          person never fills it; the server reads a filled one as a robot. */}
      <div aria-hidden="true" data-testid="rsvp-wl-hp" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="rsvp-wl-bbt">{t("rsvpHpLabel", "Leave this field empty")}</label>
        <input
          id="rsvp-wl-bbt"
          type="text"
          name="bb_trap_7"
          value={trap}
          onChange={(e) => setTrap(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
        />
      </div>
      <p className={QUIET}>{t("rsvpWlPrivacy", "Your name and number are used only for the waitlist at {venue}.", { venue: venueName })}</p>
      {error && error !== "name" && error !== "phone" && (
        <p role="alert" className="text-sm text-amber-900 dark:text-amber-200">
          {error === "not_full"
            ? t("rsvpWlErrNotFull", "A table just opened up — pick a time.")
            : error === "unavailable"
              ? telHref(phone)
                ? t("rsvpWlErrUnavailable", "We can't add you to the waitlist right now. Call us: {phone}", { phone })
                : t("rsvpWlErrUnavailableNoPhone", "We can't add you to the waitlist right now.")
              : error === "too_many"
                ? t("rsvpWlErrTooMany", "Too many tries — try again later.")
                : t("rsvpErrGeneric", "Something went wrong. Please try again in a moment.")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="main" size="lg" className="h-11 min-h-0! rounded-xl!" busy={sending}>
          {t("rsvpWlOfferCta", "Put me on the waitlist")}
        </Button>
        <Button type="button" variant="ghost" size="lg" className="h-11 min-h-0!" onClick={onCancel}>
          {t("cancel", "Cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The full night (or the full evening on a day with earlier times).
 *   offer   the server's answer for the night (/availability): evening_full,
 *           nearest [{date, times}], waitlist_open, waitlist_times
 *   reason  the sentence above it
 *   onPickTime(date, time)  a nearest time was tapped
 *   onJoined(receipt)       a join (or a leave) changed the receipt
 */
export function FullNight({
  t, lang, kit, confirm, slug, day, party, offer, reason, venue = null, phone = null, slot = "",
  initialReceipt = null, onJoined, onPickTime, onTableOpened,
}) {
  const { BookingTile, Button, Phone } = kit;
  const [mode, setMode] = useState("offer"); // offer | form
  const [receipt, setReceiptState] = useState(initialReceipt);
  const setReceipt = (r) => {
    setReceiptState(r);
    onJoined?.(r);
  };
  const { leave, leaving, leaveError } = useLeave({ t, kit, confirm }, receipt, setReceipt);
  // A full evening: the day's own earlier times are in the grid above.
  const nearest = (Array.isArray(offer?.nearest) ? offer.nearest : [])
    .filter((d) => Array.isArray(d?.times) && d.times.length && !(offer?.evening_full && d.date === day));
  const listOpen = offer?.waitlist_open === true;
  const venueName = venue || t("rsvpWlVenueGeneric", "the venue");

  return (
    <div className="space-y-4" data-testid="rsvp-full-night">
      {reason && <p className="text-sm text-gray-600 dark:text-gray-300">{reason}</p>}
      {nearest.length > 0 && (
        <div data-testid="rsvp-nearest">
          <p className="mb-2 text-[13px] font-medium text-gray-500 dark:text-gray-400">
            {t("rsvpNearestTitle", "Nearest free times")}
          </p>
          <ul className="space-y-2">
            {nearest.map((d) => (
              <li key={d.date} className="flex items-center gap-3">
                <span className="w-[6.5rem] shrink-0 text-[13px] font-medium text-gray-700 dark:text-gray-300 first-letter:uppercase">
                  {d.date === day ? t("rsvpNearestSameDay", "Earlier that day") : kit.fmtDayShort(d.date, lang)}
                </span>
                {/* Up to three times a day (the server's NEAREST_TIMES): three
                    columns that fill the row to the card's edge (G10 item 3:
                    they stopped 16 px short) and line up from day to day. */}
                <div className="flex-1 min-w-0 grid grid-cols-3 gap-2">
                  {d.times.map((x) => (
                    <BookingTile
                      key={x}
                      selected={d.date === day && slot === x}
                      onClick={() => onPickTime?.(d.date, x)}
                      aria-label={t("rsvpNearestPick", "Book {day} at {time}", { day: kit.fmtDayLabel(d.date, lang), time: x })}
                      className={"w-full h-10 min-h-0! px-0 tabular-nums text-[14px] " + FOCUS}
                    >
                      {x}
                    </BookingTile>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {receipt ? (
        <Receipt
          t={t}
          lang={lang}
          kit={kit}
          receipt={receipt}
          venue={venue}
          phone={phone}
          typedPhone={receipt.phone || null}
          onLeave={leave}
          leaving={leaving}
          leaveError={leaveError}
        />
      ) : listOpen && mode === "form" ? (
        <WaitlistForm
          t={t}
          lang={lang}
          kit={kit}
          slug={slug}
          day={day}
          party={party}
          offer={offer}
          venue={venue}
          phone={phone}
          onJoined={setReceipt}
          onTableOpened={onTableOpened}
          onCancel={() => setMode("offer")}
        />
      ) : listOpen ? (
        <div className="space-y-2.5" data-testid="rsvp-wl-offer">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t("rsvpWlOfferBody", "Want to join the waitlist? It isn't a booking — if a table frees up, {venue} may contact you by phone.", { venue: venueName })}
          </p>
          <Button variant="secondary" size="lg" className="h-11 min-h-0! rounded-xl!" onClick={() => setMode("form")}>
            {t("rsvpWlOfferCta", "Put me on the waitlist")}
          </Button>
        </div>
      ) : null}
      {telHref(phone) && !(receipt && receipt.status === "waiting") && (
        <a href={telHref(phone)} className={TEL_ACTION}>
          <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{t("rsvpNoSlotsCall", "Call us: {phone}", { phone })}</span>
        </a>
      )}
    </div>
  );
}

/**
 * The guest's place on the list, read back through the signed link (no name
 * and no phone ever come back), with "leave" while it is waiting.
 */
export function WaitlistPlace({ t, lang, kit, confirm, id, token, venue = null, phone = null }) {
  const [receipt, setReceipt] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    kit.api
      .get(`/public/reservations/booking/waitlist/${id}`, { params: { token } })
      .then((res) => {
        if (alive) setReceipt({ ...(res?.data || {}), token });
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [kit, id, token]);
  const { leave, leaving, leaveError } = useLeave({ t, kit, confirm }, receipt, setReceipt);
  if (failed) {
    return (
      <div className={CARD} role="status" data-testid="rsvp-wl-return-failed">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t("rsvpWlLinkFailed", "We couldn't open your place on the waitlist. The link may have expired.")}
        </p>
      </div>
    );
  }
  if (!receipt) return null;
  return (
    <div data-testid="rsvp-wl-return">
      <Receipt
        t={t}
        lang={lang}
        kit={kit}
        receipt={receipt}
        venue={venue}
        phone={phone}
        typedPhone={null}
        onLeave={leave}
        leaving={leaving}
        leaveError={leaveError}
      />
    </div>
  );
}

/**
 * The page's side (ReservationPublicPage hands over `host`: its state, its
 * setters, its helpers). `back` = the return card at the top of step 1, shown
 * when the address bar carries a waitlist link this visit did not just make.
 *   • a receipt is kept per night for the visit and its link goes into the
 *     address bar while the guest is waiting;
 *   • a nearest time picks that day and time (host.pick: the page keeps the
 *     time once that day's times are in);
 *   • "a table just opened up" asks the strip and the times again
 *     (host.refresh).
 */
export default function FullNightOffer({ host: h, back = false }) {
  const [params] = useSearchParams();
  const keep = useLinkKeeper();
  const pageInfo = { venue: h.page?.business_name || null, phone: h.page?.phone || null };
  if (back) {
    const id = params.get("wl");
    const token = params.get("wt");
    return id && token && !joinedHere(id) ? (
      <WaitlistPlace t={h.t} lang={h.lang} kit={h.kit} confirm={h.confirm} id={id} token={token} {...pageInfo} />
    ) : null;
  }
  const key = `${h.slug}|${h.day}|${h.party}`;
  const reason = h.offer?.evening_full
    ? h.t("rsvpEveningFull", "The evening is fully booked for {party}.", { party: partyText(h.party, h.t) })
    : h.t("rsvpReasonFull", "Fully booked for {party} this day.", { party: partyText(h.party, h.t) });
  return (
    <FullNight
      key={key}
      t={h.t}
      lang={h.lang}
      kit={h.kit}
      confirm={h.confirm}
      slug={h.slug}
      day={h.day}
      party={h.party}
      offer={h.offer}
      reason={reason}
      slot={h.slot}
      {...pageInfo}
      initialReceipt={receiptFor(key)}
      onJoined={(r) => {
        keepReceipt(key, r);
        keep(r);
      }}
      onPickTime={h.pick}
      onTableOpened={h.refresh}
    />
  );
}
