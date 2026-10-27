// R2 (27 Oct 2026) — spam clean-up on the owner's book.
//
// Booking needs no account. When junk gets into the book anyway, the owner
// cleans it up from the booking's drawer — and nothing ever reaches the
// address a stranger typed:
//   • SpamButton — "Spam" beside Ret / Afvis / Aflys: the booking is
//     cancelled (a request declined) with no message to the guest, it stops
//     counting towards the month's bookings, and its contact is marked — its
//     next online booking waits for the owner's OK. The confirm's quieter
//     third answer also BLOCKS the contact (refused online from then on).
//     The toast carries "Fortryd" (backend: POST …/spam/undo).
//   • SpamWaveBox — on an open online request that came in with many
//     others: "Afvis alle N fra denne bølge", one confirm, no mail to anyone.
//   • SpamMarkedLine — a booking already marked says so in its drawer.
// The server owns the rules (routers/reservation_spam.py); this only asks.
import { useEffect, useState } from "react";
import { ShieldAlert, Waves } from "lucide-react";
import api from "../../services/api";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import { guestText } from "../../utils/guestText";
import { fmtTime } from "../../utils/floorState";
import { isMarkedSpam } from "../../utils/bookingHeld";
import Button from "../ui/Button";

// Statuses a booking can be marked as spam from (the server's SPAM_FROM): a
// seated or finished party is a person in the room.
export const SPAM_FROM = ["requested", "confirmed", "no_show"];

export function canMarkSpam(r) {
  return !!r && r.source === "public" && SPAM_FROM.includes(r.status);
}

// A phone (6+ digits) or an address to mark — a purged booking has neither,
// and then the confirm promises no mark.
export function hasContact(r) {
  const digits = String(r?.guest_phone || "").replace(/\D/g, "");
  return digits.length >= 6 || /\S@\S/.test(String(r?.guest_email || ""));
}

// The masked contacts the server names ("•• •• •• 78 · s•••@gmail.com").
export function hintsOf(entries) {
  return (Array.isArray(entries) ? entries : []).map((e) => e?.hint).filter(Boolean).join(" · ");
}

function who(r, t, apptWords) {
  return guestText(r?.guest_name) || (apptWords ? t("rsvpColGuestAppt", "Customer") : t("rsvpGuest", "Guest"));
}

// The one confirm: what happens to the booking, what happens next time, and
// — as the quieter third answer — block the contact as well.
export function spamConfirmOpts(r, t, { apptWords = false } = {}) {
  const name = who(r, t, apptWords);
  const first = r?.status === "requested"
    ? (apptWords
      ? t("rsvpSpamBodyDeclineAppt", "The request from {name} is declined without a message to the customer.", { name })
      : t("rsvpSpamBodyDecline", "The request from {name} is declined without a message to the guest.", { name }))
    : (apptWords
      ? t("rsvpSpamBodyCancelAppt", "The appointment from {name} is cancelled without a message to the customer, and it no longer counts towards this month's appointments.", { name })
      : t("rsvpSpamBodyCancel", "The booking from {name} is cancelled without a message to the guest, and it no longer counts towards this month's bookings.", { name }));
  const contact = hasContact(r);
  const next = contact
    ? (apptWords
      ? t("rsvpSpamBodyMarkAppt", "Their next online appointment waits for your OK.")
      : t("rsvpSpamBodyMark", "Their next online booking waits for your OK."))
    : "";
  return {
    title: t("rsvpSpamConfirmTitle", "Mark as spam?"),
    message: next ? `${first} ${next}` : first,
    confirmLabel: t("rsvpSpamConfirmYes", "Mark as spam"),
    cancelLabel: t("rsvpCancelConfirmKeep", "Keep"),
    destructive: true,
    ...(contact ? { extraLabel: t("rsvpSpamConfirmBlock", "Spam, and block this contact") } : {}),
  };
}

// "Spam" in the drawer's quiet action row (the same look as Ret / Afvis).
export function SpamButton({ r, t, apptWords = false, busy = false, onDone }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  if (!canMarkSpam(r)) return null;

  const undo = async () => {
    try {
      const res = await api.post(`/reservations/reservations/${r.id}/spam/undo`);
      toast({
        severity: "info",
        message: apptWords
          ? t("rsvpSpamUndoneAppt", "Undone. The appointment is back as it was.")
          : t("rsvpSpamUndone", "Undone. The booking is back as it was."),
      });
      onDone?.(res?.data || {});
    } catch (e) {
      const code = e?.response?.data?.detail?.error;
      toast({
        severity: "notice",
        message: code === "slot_unavailable"
          ? (apptWords
            ? t("rsvpSpamUndoTakenAppt", "Couldn't undo: the time went to another appointment meanwhile. The appointment stays cancelled; call the customer if it was real.")
            : t("rsvpSpamUndoTaken", "Couldn't undo: the table went to another booking meanwhile. The booking stays cancelled; call the guest if it was real."))
          : t("rsvpSpamUndoFailed", "Couldn't undo. Nothing was changed back."),
      });
      onDone?.(null);
    }
  };

  const run = async () => {
    const answer = await confirm(spamConfirmOpts(r, t, { apptWords }));
    // `extra` is the quieter third way: spam AND block (useConfirm returns
    // the string, so test it exactly — never truthiness).
    if (answer !== true && answer !== "extra") return;
    const block = answer === "extra";
    setWorking(true);
    try {
      const res = await api.post(`/reservations/reservations/${r.id}/spam`, { block });
      const data = res?.data || {};
      const entries = data?.contact?.entries || [];
      const name = who(r, t, apptWords);
      const message = block && entries.length
        ? t("rsvpSpamBlockedDone", "Marked as spam and blocked: {contact} can't book online.", { contact: hintsOf(entries) })
        : entries.length
          ? (apptWords
            ? t("rsvpSpamDoneAppt", "Marked as spam. The next online appointment from {name} waits for your OK.", { name })
            : t("rsvpSpamDone", "Marked as spam. The next online booking from {name} waits for your OK.", { name }))
          : t("rsvpSpamDoneNoContact", "Marked as spam.");
      toast({ severity: "success", message, action: { label: t("rsvpSpamUndo", "Undo"), onClick: undo } });
      onDone?.(data);
    } catch {
      toast({ severity: "notice", message: t("rsvpSpamFailed", "Couldn't mark it as spam. Try again.") });
    } finally {
      setWorking(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="rsvp-spam"
      disabled={busy || working}
      onClick={run}
      className="inline-flex items-center gap-1 text-sm font-medium px-2 py-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
    >
      <ShieldAlert className="w-3.5 h-3.5" aria-hidden />
      {t("rsvpSpamAction", "Spam")}
    </button>
  );
}

// "Afvis alle N fra denne bølge" — on an open online request made with many
// others. Asks the server how big the wave is when the drawer opens; shows
// nothing below 2.
export function SpamWaveBox({ r, t, apptWords = false, onDone }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [wave, setWave] = useState(null);
  const [working, setWorking] = useState(false);
  const eligible = !!r && r.source === "public" && r.status === "requested";
  const id = r?.id;

  useEffect(() => {
    if (!eligible || !id) {
      setWave(null);
      return undefined;
    }
    let alive = true;
    api.get(`/reservations/spam-wave/${id}`)
      .then((res) => { if (alive) setWave(res?.data || null); })
      .catch(() => { if (alive) setWave(null); });
    return () => { alive = false; };
  }, [id, eligible]);

  const n = Number(wave?.count) || 0;
  if (!eligible || n < 2) return null;
  const from = fmtTime(wave.first_at);
  const to = fmtTime(wave.last_at);

  const run = async () => {
    const ok = await confirm({
      title: t("rsvpWaveConfirmTitle", "Decline the whole wave?"),
      message: apptWords
        ? t("rsvpWaveConfirmBodyAppt", "{n} open online requests made {from}–{to} are declined. Nobody gets an e-mail. If a real customer is among them, they won't hear from you — call them if you know one.", { n, from, to })
        : t("rsvpWaveConfirmBody", "{n} open online requests made {from}–{to} are declined. Nobody gets an e-mail. If a real guest is among them, they won't hear from you — call them if you know one.", { n, from, to }),
      confirmLabel: t("rsvpWaveConfirmYes", "Decline all {n}", { n }),
      cancelLabel: t("rsvpCancelConfirmKeep", "Keep"),
      destructive: true,
    });
    if (ok !== true) return;
    setWorking(true);
    try {
      const res = await api.post(`/reservations/spam-wave/${id}`, { ids: wave.ids || [] });
      const done = Number(res?.data?.rejected);
      toast({ severity: "info", message: t("rsvpWaveDone", "{n} requests declined without a message.", { n: Number.isFinite(done) ? done : n }) });
      onDone?.(res?.data || {});
    } catch {
      toast({ severity: "notice", message: t("rsvpWaveFailed", "Couldn't decline the wave. Try again.") });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      data-testid="rsvp-spam-wave"
      className="rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50/60 dark:bg-amber-900/10 px-3 py-2.5 space-y-2"
    >
      <p className="flex items-start gap-1.5 text-[12px] leading-snug text-amber-800 dark:text-amber-200">
        <Waves className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
        {t("rsvpWaveTitle", "One of {n} online requests made within {min} minutes ({from}–{to}).", {
          n, min: wave.minutes || 10, from, to,
        })}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="md"
        busy={working}
        disabled={working}
        onClick={run}
        data-testid="rsvp-spam-wave-action"
        className="w-full sm:w-auto max-sm:h-10 max-sm:min-h-0! max-sm:text-[13px]"
      >
        {t("rsvpWaveAction", "Decline all {n} from this wave", { n })}
      </Button>
    </div>
  );
}

// A booking already marked as spam: one quiet line under its status.
export function SpamMarkedLine({ r, t, apptWords = false }) {
  if (!isMarkedSpam(r)) return null;
  return (
    <p data-testid="rsvp-spam-marked" className="flex items-start gap-1.5 text-[12px] leading-snug text-gray-600 dark:text-gray-400">
      <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
      <span>
        <span className="font-semibold text-gray-800 dark:text-gray-200">{t("rsvpSpamMarked", "Marked as spam")}</span>
        {" · "}
        {apptWords
          ? t("rsvpSpamMarkedHintAppt", "Cancelled without a message to the customer.")
          : t("rsvpSpamMarkedHint", "Cancelled without a message to the guest.")}
      </span>
    </p>
  );
}
