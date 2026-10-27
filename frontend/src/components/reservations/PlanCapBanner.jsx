// R1b (27 Oct 2026) — the plan's monthly booking cap, said to the owner.
//
// Before R1b the cap was enforced and reported nowhere: the Free plan's 20
// bookings a month ran out, the public page answered "not accepting", and
// the owner learned it from a guest. Now the owner's settings say how many
// are used, the cap and what reaching it does (`month_cap_mode`):
//   • "requests" — the page stays OPEN and a new online booking comes in as
//     a request the owner confirms (backend booking_screen rule 4b,
//     BOOKING_PLAN_CAP_REQUESTS — Manoj's "Free cap = requests");
//   • "closed"   — the page takes no more online bookings this month (live).
// Either way the book shows one amber line, with the upgrade nudge.
//
// The nudge is UpgradeNudge, which renders nothing in the iOS app (Apple
// 3.1.1): the sentences here state the fact and never say "upgrade"
// themselves.
import React from "react";
import { CalendarClock } from "lucide-react";
import UpgradeNudge from "../ui/UpgradeNudge";

// {used, cap, mode} from GET /reservations/settings, or null when the
// server says nothing about the cap (an older server, a paired stand).
export function monthCapFromSettings(data) {
  if (!data || data.reservations_cap === undefined || data.reservations_cap === null) return null;
  const cap = Number(data.reservations_cap);
  if (!Number.isFinite(cap)) return null;
  return {
    used: Number(data.reservations_used_this_month) || 0,
    cap,
    mode: data.month_cap_mode === "requests" ? "requests" : "closed",
  };
}

// Reached: a real cap (unlimited is -1) and the month's bookings at it.
export function monthCapReached(monthCap) {
  if (!monthCap) return false;
  const cap = Number(monthCap.cap);
  const used = Number(monthCap.used);
  return Number.isFinite(cap) && cap >= 0 && Number.isFinite(used) && used >= cap;
}

function nudgeBenefit(t, apptWords) {
  return apptWords
    ? t("rsvpPlanCapNudgeAppt", "Online appointments with no monthly limit")
    : t("rsvpPlanCapNudge", "Online bookings with no monthly limit");
}

export default function PlanCapBanner({ monthCap, t, apptWords = false }) {
  if (!monthCapReached(monthCap)) return null;
  const n = Number(monthCap.cap);
  const requests = monthCap.mode === "requests";
  const title = apptWords
    ? t("rsvpPlanCapTitleAppt", "This month's {n} appointments are used", { n })
    : t("rsvpPlanCapTitle", "This month's {n} bookings are used", { n });
  let body;
  if (requests) {
    body = apptWords
      ? t("rsvpPlanCapRequestsBodyAppt", "Your booking page stays open. New online appointments come in as requests you confirm in your book.")
      : t("rsvpPlanCapRequestsBody", "Your booking page stays open. New online bookings come in as requests you confirm in your book.");
  } else {
    body = apptWords
      ? t("rsvpPlanCapClosedBodyAppt", "Your booking page takes no more online appointments until the month turns.")
      : t("rsvpPlanCapClosedBody", "Your booking page takes no more online bookings until the month turns.");
  }
  return (
    <div
      role="status"
      data-testid="plan-cap-banner"
      data-mode={requests ? "requests" : "closed"}
      className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-900/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
    >
      <CalendarClock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-0.5 text-[13px] opacity-90">{body}</p>
        </div>
        <UpgradeNudge intent="inline" tier="starter" benefit={nudgeBenefit(t, apptWords)} />
      </div>
    </div>
  );
}

// The drawer of a booking held because the cap is reached: the nudge under
// the reason (web only — UpgradeNudge is empty in the iOS app).
export function PlanCapHeldNudge({ t, apptWords = false }) {
  return (
    <div data-testid="plan-cap-held-nudge" className="pt-1">
      <UpgradeNudge intent="inline" tier="starter" benefit={nudgeBenefit(t, apptWords)} />
    </div>
  );
}
