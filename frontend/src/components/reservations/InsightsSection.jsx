// InsightsSection — the "Insights" (Indsigt) lens of the owner Reservations
// page. Read-only analytics over the booking book.
//
// Consumes GET /api/reservations/insights?range=<1w|2w|4w|8w|12w>&zone=<all|zone>
// via the app's axios `api` instance (same auth/CSRF path as the rest of the
// page). The data is fetched lazily — the parent only mounts this component
// when the Insights tab is opened, so it never blocks the Book view load.
//
// Honesty layer (the whole point of the design): every insight object carries
// a `confidence ∈ "hidden" | "provisional" | "confident"`.
//   • hidden      → the card is NOT rendered. If ALL/most are hidden we show a
//                   single "collecting data" line, never a grid of empty cards.
//   • provisional → rendered, but values are MUTED (gray-500, not bold
//                   gray-900), no trend arrows, no forecast, and an
//                   "Early — needs more data" chip.
//   • confident   → full treatment (bold gray-900 values).
//
// Design doctrine (LOCKED): gray-900 primary + STATUS COLORS ONLY. The
// signature heatmap is a SINGLE GRAY RAMP (intensity via lightness only — no
// hue, no rainbow → premium + colorblind-safe). The only non-gray accents are
// amber for a high no-show rate and emerald for a strong result, used
// sparingly. Lucide outline icons, Inter, rounded-xl, mobile-first.
//
// Covers basis: the backend computes covers from BOOKED party_size (Σ
// party_size), not POS guest counts — figures are labelled accordingly where
// shown (covers_basis === "booked").
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  TrendingUp,
  Users,
  Clock,
  CalendarCheck,
  Globe,
  Footprints,
  Phone,
  BarChart3,
  AlertTriangle,
  HeartHandshake,
} from "lucide-react";
import api from "../../services/api";
import { useAuth } from "../../hooks/useAuth";
import { bookingModeFor } from "../../config/venueProfiles";
import { formatKr } from "../../utils/currency";
import StatCard from "../ui/StatCard";
import Chip from "../ui/Chip";
import Card from "../ui/Card";
import FilterBar from "../ui/FilterBar";
import UpgradeNudge from "../ui/UpgradeNudge";

// ─── small format helpers ─────────────────────────────────────────────────
// Percent from a 0..100 number (already a percentage from the backend), or "—".
function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v)}%`;
}
// Percent from a 0..1 rate (no-show), or "—".
function fmtRatePct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v * 100)}%`;
}
// Plain integer or "—".
function fmtInt(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return new Intl.NumberFormat("da-DK").format(v);
}

// A confidence is "shown" if it's not the hidden state.
const isShown = (c) => c === "provisional" || c === "confident";

// dd/mm short date for the forecast list (DK-style).
function fmtDkShort(iso) {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  if (!m || !d) return iso;
  return `${d}/${m}`;
}

// ─── shared: confidence chip (provisional only) ───────────────────────────
// Rendered inside a card header when the insight is provisional. Quiet gray
// chip — "Early — needs more data". Confident cards render nothing here.
function ConfidenceChip({ confidence, t }) {
  if (confidence !== "provisional") return null;
  return (
    <Chip size="sm" className="cursor-default pointer-events-none" aria-disabled="true">
      {t("rsvpInsEarly", "Early — needs more data")}
    </Chip>
  );
}

// StatCard always renders its value bold gray-900. To show a PROVISIONAL value
// muted (gray-500, not bold) per the honesty layer, we pass the value as a
// <span> whose own color + weight win over the inherited bold gray-900 (color
// inherits; the child's explicit class overrides). Confident → plain string so
// StatCard's bold gray-900 applies unchanged.
function kpiValue(text, confidence) {
  if (confidence === "provisional") {
    return <span className="font-normal text-gray-500 dark:text-gray-400">{text}</span>;
  }
  return text;
}

// ─── SIGNATURE: "When you're busy" heatmap ─────────────────────────────────
// Weekday rows (Mon-first) × day-part columns. Each cell filled on a single
// gray ramp by its covers quantile — NO hue. Text flips to white on the dark
// cells. Low-confidence / absent cells render hatched with an em-dash so we
// never paint a misleadingly dark guess. Tapping a cell toggles a small
// popover with "{weekday} {day_part} · {covers} covers".
//
// The ramp is computed from the NON-low-confidence cells' covers so a single
// sparse-but-high cell can't blow out the scale.
const RAMP = [
  // [bg, text] — five steps, lightness only.
  ["bg-gray-100 dark:bg-gray-800/60", "text-gray-700 dark:text-gray-300"],
  ["bg-gray-200 dark:bg-gray-700/70", "text-gray-800 dark:text-gray-200"],
  ["bg-gray-400 dark:bg-gray-600", "text-white"],
  ["bg-gray-700 dark:bg-gray-400", "text-white dark:text-gray-900"],
  ["bg-gray-900 dark:bg-gray-200", "text-white dark:text-gray-900"],
];

function rampStep(covers, max) {
  if (!max || max <= 0) return 0;
  const f = covers / max;
  if (f <= 0) return 0;
  if (f <= 0.2) return 0;
  if (f <= 0.4) return 1;
  if (f <= 0.6) return 2;
  if (f <= 0.8) return 3;
  return 4;
}

function dayPartLabel(dp, t) {
  // Static keys (no template literal) so the i18n grep verifies en+da.
  switch (dp) {
    case "Morning":
      return t("rsvpInsPartMorning", "Morning");
    case "Lunch":
      return t("rsvpInsPartLunch", "Lunch");
    case "Afternoon":
      return t("rsvpInsPartAfternoon", "Afternoon");
    case "Dinner":
      return t("rsvpInsPartDinner", "Dinner");
    case "Late":
      return t("rsvpInsPartLate", "Late");
    default:
      return dp;
  }
}

function weekdayLabel(wd, t) {
  switch (wd) {
    case "Mon":
      return t("rsvpDayMon", "Mon");
    case "Tue":
      return t("rsvpDayTue", "Tue");
    case "Wed":
      return t("rsvpDayWed", "Wed");
    case "Thu":
      return t("rsvpDayThu", "Thu");
    case "Fri":
      return t("rsvpDayFri", "Fri");
    case "Sat":
      return t("rsvpDaySat", "Sat");
    case "Sun":
      return t("rsvpDaySun", "Sun");
    default:
      return wd;
  }
}

function HeatmapCard({ heatmap, t }) {
  // The active cell (for the tap popover): "wdIdx-dayPart" or null.
  const [active, setActive] = useState(null);

  const weekdays = heatmap.weekdays || [];
  const dayParts = heatmap.day_parts || [];

  // Index cells by "wdIdx|dayPart" for O(1) lookup. A cell absent from the
  // payload = no samples that slot → render hatched.
  const cellMap = useMemo(() => {
    const m = {};
    (heatmap.cells || []).forEach((c) => {
      m[`${c.weekday_index}|${c.day_part}`] = c;
    });
    return m;
  }, [heatmap.cells]);

  // Ramp scale from confident (non-low_confidence) cells only.
  const maxCovers = useMemo(() => {
    let mx = 0;
    (heatmap.cells || []).forEach((c) => {
      if (!c.low_confidence && c.covers > mx) mx = c.covers;
    });
    // If literally every cell is low-confidence, fall back to the global max so
    // the matrix still shows *some* relative shape (cells stay hatched anyway).
    if (mx === 0) {
      (heatmap.cells || []).forEach((c) => {
        if (c.covers > mx) mx = c.covers;
      });
    }
    return mx;
  }, [heatmap.cells]);

  const provisional = heatmap.confidence === "provisional";

  return (
    <Card>
      <Card.Header
        icon={<CalendarCheck className="w-4 h-4" aria-hidden />}
        title={t("rsvpInsHeatmapTitle", "When you're busy")}
        subtitle={t("rsvpInsHeatmapSub", "Booked guests by day and time")}
        action={<ConfidenceChip confidence={heatmap.confidence} t={t} />}
      />

      {/* Horizontal scroll guard for narrow phones; the grid keeps a sane min
          column width so taps stay ≥40px. */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="min-w-[34rem]">
          {/* Column header row: empty corner + day-part labels. */}
          <div
            className="grid gap-1 mb-1"
            style={{ gridTemplateColumns: `3rem repeat(${dayParts.length}, minmax(0, 1fr))` }}
          >
            <div />
            {dayParts.map((dp) => (
              <div
                key={dp}
                className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 text-center truncate px-0.5"
              >
                {dayPartLabel(dp, t)}
              </div>
            ))}
          </div>

          {/* One row per weekday. */}
          <div className="space-y-1">
            {weekdays.map((wd, wdIdx) => (
              <div
                key={wd}
                className="grid gap-1"
                style={{ gridTemplateColumns: `3rem repeat(${dayParts.length}, minmax(0, 1fr))` }}
              >
                <div className="flex items-center text-xs font-medium text-gray-500 dark:text-gray-400">
                  {weekdayLabel(wd, t)}
                </div>
                {dayParts.map((dp) => {
                  const key = `${wdIdx}|${dp}`;
                  const cell = cellMap[key];
                  const hatched = !cell || cell.low_confidence;
                  const covers = cell ? cell.covers : 0;
                  const step = hatched ? -1 : rampStep(covers, maxCovers);
                  const [bg, txt] = step >= 0 ? RAMP[step] : ["", ""];
                  const isActive = active === key;

                  // Hatched: a quiet dashed tile with an em-dash. NEVER a dark
                  // guess. Provisional whole-card → keep tiles muted (lighter
                  // top step swap handled implicitly by smaller maxCovers).
                  const base =
                    "relative h-10 rounded-md flex items-center justify-center text-xs tabular-nums transition";
                  const cls = hatched
                    ? base +
                      " border border-dashed border-gray-200 dark:border-gray-700 text-gray-300 dark:text-gray-600 bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,rgba(0,0,0,0.03)_5px,rgba(0,0,0,0.03)_6px)] dark:bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,rgba(255,255,255,0.04)_5px,rgba(255,255,255,0.04)_6px)]"
                    : `${base} ${bg} ${txt} ${
                        provisional ? "opacity-80" : ""
                      } ${isActive ? "ring-2 ring-gray-900 dark:ring-gray-100 ring-offset-1 ring-offset-white dark:ring-offset-gray-900" : ""}`;

                  if (hatched) {
                    return (
                      <div
                        key={dp}
                        className={cls}
                        title={t("rsvpInsCellNoData", "Not enough data")}
                        aria-label={`${weekdayLabel(wd, t)} ${dayPartLabel(dp, t)} · ${t("rsvpInsCellNoData", "Not enough data")}`}
                      >
                        —
                      </div>
                    );
                  }

                  return (
                    <button
                      key={dp}
                      type="button"
                      onClick={() => setActive(isActive ? null : key)}
                      className={cls + " focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"}
                      aria-label={`${weekdayLabel(wd, t)} ${dayPartLabel(dp, t)} · ${covers} ${t("rsvpInsCoversWord", "covers")}`}
                    >
                      {fmtInt(covers)}
                      {isActive && (
                        <span
                          role="status"
                          className="absolute z-20 bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-[11px] font-medium px-2.5 py-1.5 shadow-sm pointer-events-none"
                        >
                          {weekdayLabel(wd, t)} {dayPartLabel(dp, t)} · {fmtInt(covers)}{" "}
                          {t("rsvpInsCoversWord", "covers")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend: less → more, on the same ramp. Plus a covers-basis note. */}
      <div className="flex items-center justify-between gap-3 mt-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{t("rsvpInsLegendLess", "Less")}</span>
          {RAMP.map(([bg], i) => (
            <span key={i} className={"w-4 h-3 rounded-sm " + bg} aria-hidden />
          ))}
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{t("rsvpInsLegendMore", "More")}</span>
        </div>
        <span className="text-[10px] text-gray-400 dark:text-gray-500">
          {t("rsvpInsBookedBasis", "Based on booked guests")}
        </span>
      </div>
    </Card>
  );
}

// ─── Party-size fit ─────────────────────────────────────────────────────────
// Demand (booked party sizes) vs supply (table capacities) as paired gray
// bars per bin. Confident = gray-900 demand bar; provisional = gray-400.
function PartySizeCard({ data, t }) {
  const provisional = data.confidence === "provisional";
  const party = data.party_histogram || [];
  const cap = data.capacity_histogram || [];

  // Both series are ≤4 bins — cheap to compute inline each render (no useMemo
  // needed). Shared max across BOTH series so the bars are comparable.
  let max = 0;
  party.forEach((b) => (b.count > max ? (max = b.count) : null));
  cap.forEach((b) => (b.count > max ? (max = b.count) : null));
  const capByBin = {};
  cap.forEach((b) => (capByBin[b.bin] = b.count));

  const demandBar = provisional ? "bg-gray-400 dark:bg-gray-500" : "bg-gray-900 dark:bg-gray-100";

  return (
    <Card>
      <Card.Header
        icon={<Users className="w-4 h-4" aria-hidden />}
        title={t("rsvpInsPartyTitle", "Party-size fit")}
        subtitle={t("rsvpInsPartySub", "Booked party sizes vs your table sizes")}
        action={<ConfidenceChip confidence={data.confidence} t={t} />}
      />
      <div className="space-y-3">
        {party.map((b) => {
          const capCount = capByBin[b.bin] || 0;
          const demandPct = max > 0 ? Math.round((b.count / max) * 100) : 0;
          const capPct = max > 0 ? Math.round((capCount / max) * 100) : 0;
          return (
            <div key={b.bin} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-gray-700 dark:text-gray-300 tabular-nums">
                  {b.bin} {t("rsvpInsGuestsWord", "guests")}
                </span>
                <span className="text-gray-400 dark:text-gray-500 tabular-nums">
                  {t("rsvpInsPartyRow", "{booked} booked · {tables} tables", {
                    booked: b.count,
                    tables: capCount,
                  })}
                </span>
              </div>
              {/* Demand bar (filled) over a supply track (outline). */}
              <div className="space-y-1">
                <div className="h-2.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                  <div
                    className={"h-full rounded-full " + demandBar}
                    style={{ width: `${demandPct}%` }}
                    aria-hidden
                  />
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gray-300 dark:bg-gray-600"
                    style={{ width: `${capPct}%` }}
                    aria-hidden
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className={"w-3 h-2 rounded-sm " + demandBar} aria-hidden />
          {t("rsvpInsPartyDemand", "Bookings")}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="w-3 h-2 rounded-sm bg-gray-300 dark:bg-gray-600" aria-hidden />
          {t("rsvpInsPartySupply", "Tables")}
        </span>
      </div>
    </Card>
  );
}

// ─── Source mix ─────────────────────────────────────────────────────────────
// public / manual / walk_in shares as labelled gray bars. Sums covers? No —
// the backend share is count_share; we show the count share (channel mix).
function sourceLabel(src, t) {
  switch (src) {
    case "public":
      return t("rsvpInsSourcePublic", "Online");
    case "manual":
      return t("rsvpInsSourceManual", "Phone / in-person");
    case "walk_in":
      return t("rsvpInsSourceWalkIn", "Walk-in");
    default:
      return src;
  }
}
function SourceIcon({ src }) {
  if (src === "public") return <Globe className="w-3.5 h-3.5" aria-hidden />;
  if (src === "walk_in") return <Footprints className="w-3.5 h-3.5" aria-hidden />;
  return <Phone className="w-3.5 h-3.5" aria-hidden />;
}

function SourceMixCard({ data, t }) {
  const provisional = data.confidence === "provisional";
  const sources = data.sources || [];
  const bar = provisional ? "bg-gray-400 dark:bg-gray-500" : "bg-gray-900 dark:bg-gray-100";

  return (
    <Card>
      <Card.Header
        icon={<BarChart3 className="w-4 h-4" aria-hidden />}
        title={t("rsvpInsSourceTitle", "Where bookings come from")}
        subtitle={t("rsvpInsSourceSub", "Share of bookings by channel")}
        action={<ConfidenceChip confidence={data.confidence} t={t} />}
      />
      <div className="space-y-3">
        {sources.map((s) => {
          const pct = s.count_share == null ? 0 : Math.round(s.count_share * 100);
          return (
            <div key={s.source} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-gray-700 dark:text-gray-300">
                  <SourceIcon src={s.source} />
                  {sourceLabel(s.source, t)}
                </span>
                <span
                  className={
                    "tabular-nums " +
                    (provisional
                      ? "text-gray-400 dark:text-gray-500"
                      : "font-semibold text-gray-900 dark:text-gray-100")
                  }
                >
                  {fmtPct(pct)}
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                <div className={"h-full rounded-full " + bar} style={{ width: `${pct}%` }} aria-hidden />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── No-show by lead-time ─────────────────────────────────────────────────
function leadBucketLabel(b, t) {
  switch (b) {
    case "same_day":
      return t("rsvpInsLeadSameDay", "Same day");
    case "1_3_days":
      return t("rsvpInsLead1to3", "1–3 days ahead");
    case "4_7_days":
      return t("rsvpInsLead4to7", "4–7 days ahead");
    case "over_7_days":
      return t("rsvpInsLeadOver7", "Over a week ahead");
    default:
      return b;
  }
}

function NoShowCard({ data, t, smsHref }) {
  const provisional = data.confidence === "provisional";
  const rows = (data.by_lead_time || []).filter((r) => isShown(r.confidence));
  // A "high" no-show rate earns the one amber accent (sparingly): ≥ 15% overall.
  const high = data.rate != null && data.rate >= 0.15;

  return (
    <Card>
      <Card.Header
        icon={<AlertTriangle className="w-4 h-4" aria-hidden />}
        title={t("rsvpInsNoShowTitle", "No-shows")}
        subtitle={t("rsvpInsNoShowSub", "Booked guests who didn't turn up")}
        action={<ConfidenceChip confidence={data.confidence} t={t} />}
      />

      {/* Headline rate + denominator. Amber only when high AND confident. */}
      <div className="flex items-baseline gap-2 mb-3">
        <span
          className={
            "text-2xl font-bold tabular-nums " +
            (provisional
              ? "text-gray-500 dark:text-gray-400"
              : high
                ? "text-amber-600 dark:text-amber-400"
                : "text-gray-900 dark:text-gray-100")
          }
        >
          {fmtRatePct(data.rate)}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
          {t("rsvpInsNoShowOf", "{n} of {d} bookings", {
            n: fmtInt(data.no_shows),
            d: fmtInt(data.denominator),
          })}
        </span>
      </div>

      {rows.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {t("rsvpInsNoShowByLead", "By how far ahead they booked")}
          </p>
          {rows.map((r) => {
            const rowHigh = r.rate != null && r.rate >= 0.15;
            return (
              <div key={r.bucket} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-gray-600 dark:text-gray-300">{leadBucketLabel(r.bucket, t)}</span>
                <span className="inline-flex items-center gap-2">
                  <span className="text-gray-400 dark:text-gray-500 tabular-nums">
                    {fmtInt(r.no_shows)}/{fmtInt(r.denominator)}
                  </span>
                  <span
                    className={
                      "tabular-nums font-semibold w-9 text-right " +
                      (r.confidence === "provisional"
                        ? "text-gray-400 dark:text-gray-500"
                        : rowHigh
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-gray-700 dark:text-gray-200")
                    }
                  >
                    {fmtRatePct(r.rate)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Action: turn on SMS reminders → the reservations Settings tab. Only
          shown when there's a real no-show signal to act on (confident +
          some no-shows). Quiet link-style, not a loud CTA. */}
      {!provisional && data.no_shows > 0 && (
        <Link
          to={smsHref}
          className="inline-flex items-center gap-1.5 mt-3 text-xs font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 underline-offset-2 hover:underline"
        >
          <Clock className="w-3.5 h-3.5" aria-hidden />
          {t("rsvpInsNoShowSms", "Turn on SMS reminders")}
        </Link>
      )}
    </Card>
  );
}

// ─── Genvundet — waitlist recovered covers ───────────────────────────────────
// "The Venteliste seated N guests this period ≈ X kr." N (covers) always;
// the kr line renders ONLY when the backend supplies a real value (kr != null)
// — otherwise an honest nudge to add guest counts. kr is GROSS (incl. moms);
// the label says so. Emerald is the one positive accent (only when confident).
function RecoveredCard({ data, t }) {
  const provisional = data.confidence === "provisional";
  const covers = data.recovered_covers || 0;
  const bookings = data.recovered_bookings || 0;
  const hasKr = data.kr != null;

  const coversLabel =
    covers === 1
      ? t("rsvpInsRecoveredGuestOne", "guest recovered")
      : t("rsvpInsRecoveredGuests", "guests recovered");
  const fromLabel =
    bookings === 1
      ? t("rsvpInsRecoveredFromOne", "from {n} seated booking", { n: fmtInt(bookings) })
      : t("rsvpInsRecoveredFrom", "from {n} seated bookings", { n: fmtInt(bookings) });

  return (
    <Card>
      <Card.Header
        icon={<HeartHandshake className="w-4 h-4" aria-hidden />}
        title={t("rsvpInsRecoveredTitle", "Recovered by the waitlist")}
        subtitle={t("rsvpInsRecoveredSub", "Guests seated from the Venteliste")}
        action={<ConfidenceChip confidence={data.confidence} t={t} />}
      />

      {/* Headline: covers recovered. Emerald when confident, gray when early. */}
      <div className="flex items-baseline gap-2 mb-1">
        <span
          className={
            "text-2xl font-bold tabular-nums " +
            (provisional
              ? "text-gray-500 dark:text-gray-400"
              : "text-emerald-600 dark:text-emerald-400")
          }
        >
          {fmtInt(covers)}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{coversLabel}</span>
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500 tabular-nums mb-3">{fromLabel}</p>

      {hasKr ? (
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            ≈ {formatKr(data.kr, { decimals: 0 })}
          </p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            {t("rsvpInsRecoveredKrBasis", "≈ revenue recovered (incl. VAT)")}
            {data.avg_cover != null && (
              <>
                {" · "}
                {t("rsvpInsRecoveredAvg", "your avg {kr}/guest", {
                  kr: formatKr(data.avg_cover, { decimals: 0 }),
                })}
              </>
            )}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          {t(
            "rsvpInsRecoveredNoKr",
            "Add guest counts to your sales to see recovered revenue.",
          )}
        </p>
      )}
    </Card>
  );
}

// ─── Pro forecast block ─────────────────────────────────────────────────────
// forecast present → "Next 7 days" mini-list. forecast_locked → UpgradeNudge.
// forecast === null && !locked → calm "not enough data yet" (Pro, thin data).
function ForecastBlock({ forecast, forecastLocked, t }) {
  if (forecastLocked) {
    return (
      <UpgradeNudge
        intent="card"
        tier="pro"
        benefit={t("rsvpInsForecastUpsell", "See next week's expected guests — plan staff and stock ahead.")}
        ctaLabel={t("rsvpInsForecastCta", "See plans")}
      />
    );
  }

  if (!forecast) {
    return (
      <Card>
        <Card.Header
          icon={<TrendingUp className="w-4 h-4" aria-hidden />}
          title={t("rsvpInsForecastTitle", "Next 7 days")}
        />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("rsvpInsForecastThin", "Not enough data yet — your forecast appears once a few weeks of bookings build up.")}
        </p>
      </Card>
    );
  }

  const days = forecast.days || [];
  // The quiet provenance caption: "based on last N same-weekdays" — averaged.
  const avgSamples =
    days.length > 0
      ? Math.round(days.reduce((a, d) => a + (d.same_weekday_samples || 0), 0) / days.length)
      : 0;

  return (
    <Card>
      <Card.Header
        icon={<TrendingUp className="w-4 h-4" aria-hidden />}
        title={t("rsvpInsForecastTitle", "Next 7 days")}
        subtitle={t("rsvpInsForecastSub", "Expected guests")}
      />
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {days.map((d) => (
          <li key={d.date} className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-baseline gap-2 min-w-0">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200 w-9">
                {weekdayLabel(d.weekday, t)}
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">{fmtDkShort(d.date)}</span>
            </span>
            <span className="text-sm font-bold tabular-nums text-gray-900 dark:text-gray-100">
              {fmtInt(d.predicted_covers)}{" "}
              <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
                {t("rsvpInsGuestsWord", "guests")}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
        {t("rsvpInsForecastBasis", "Based on the last {n} matching weekdays", { n: avgSamples })}
      </p>
    </Card>
  );
}

// ─── main section ───────────────────────────────────────────────────────────
export default function InsightsSection({ t, zones = [] }) {
  const { user } = useAuth();
  // A salon books a PROVIDER (a chair/behandler tied to a person), not a table,
  // so the seat/table vocabulary reads wrong here. Reuse the app-wide provider
  // signal (salon is the only "provider" archetype) so this stays in lockstep
  // with the rest of the reservations page. Pure label/visibility reframe — the
  // metrics are unchanged. Non-provider verticals are byte-identical.
  const isSalon = bookingModeFor(user?.business_type) === "provider";
  const [range, setRange] = useState("4w");
  const [zone, setZone] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchInsights = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/reservations/insights", { params: { range, zone } });
      setData(res.data || null);
    } catch (e) {
      // Fail-soft: never crash the page. Surface a calm error; the render path
      // below treats a null payload as the "collecting data" state.
      setError(e?.response?.data?.detail?.error || t("rsvpInsError", "Couldn't load insights."));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [range, zone, t]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  // The range select options (spec mapping: This week→1w, 4 weeks→4w, 90
  // days→12w). We keep exactly these three so the control stays calm.
  const rangeOptions = [
    { value: "1w", label: t("rsvpInsRangeWeek", "This week") },
    { value: "4w", label: t("rsvpInsRange4w", "4 weeks") },
    { value: "12w", label: t("rsvpInsRange90d", "90 days") },
  ];
  const zoneOptions = useMemo(
    () => [
      { value: "all", label: t("rsvpInsZoneAll", "All areas") },
      ...zones.map((z) => ({ value: z, label: z })),
    ],
    [zones, t],
  );

  // Pull the insight objects (defensive defaults so a partial payload never
  // throws). A missing payload → everything hidden → "collecting data" line.
  const util = data?.utilization || { confidence: "hidden" };
  const heatmap = data?.heatmap || { confidence: "hidden", weekdays: [], day_parts: [], cells: [] };
  const noShow = data?.no_show_rate || { confidence: "hidden", by_lead_time: [] };
  const sourceMix = data?.source_mix || { confidence: "hidden", sources: [], total: 0 };
  const partyFit = data?.party_size_fit || { confidence: "hidden" };
  const forecast = data?.forecast || null;
  const forecastLocked = !!data?.forecast_locked;
  const recovered = data?.recovered || { confidence: "hidden" };

  // Headline "online share" — public covers ÷ total covers across sources
  // (spec). Trivial over ≤3 sources, computed inline. null when there's no
  // covers denominator to divide by (renders as "—").
  const onlineShare = (() => {
    if (!sourceMix || !sourceMix.total || sourceMix.total <= 0) return null;
    const srcs = sourceMix.sources || [];
    const pub = srcs.find((s) => s.source === "public");
    const totalCovers = srcs.reduce((a, s) => a + (s.covers || 0), 0);
    if (totalCovers <= 0) return null;
    return (pub?.covers || 0) / totalCovers;
  })();

  // Are ALL/most insights hidden? If so we show ONE calm line, not a grid of
  // empty cards. "Most" = none of the primary insights are shown.
  const anyShown =
    isShown(util.confidence) ||
    isShown(heatmap.confidence) ||
    isShown(noShow.confidence) ||
    isShown(sourceMix.confidence) ||
    (!isSalon && isShown(partyFit.confidence)) ||
    isShown(recovered.confidence) ||
    !!forecast ||
    forecastLocked;

  // Reservations Settings tab is on this same page; the SMS toggle lives
  // there. We point at the page hash the parent can read to switch tabs, but
  // since the tab switch is in-page state, we link to the settings route the
  // app uses. The owner reservations page is /reservations; switching to the
  // Settings tab is done via a query the page honors (graceful: falls back to
  // the page top). We use a plain anchor to the page with ?tab=settings.
  const smsHref = "/reservations?tab=settings";

  return (
    <div className="space-y-4">
      {/* FilterBar — range + (optional) zone. */}
      <FilterBar>
        <FilterBar.Select
          label={t("rsvpInsRange", "Period")}
          value={range}
          onChange={setRange}
          options={rangeOptions}
        />
        {zones.length > 0 && (
          <FilterBar.Select
            label={t("rsvpInsZone", "Area")}
            value={zone}
            onChange={setZone}
            options={zoneOptions}
          />
        )}
      </FilterBar>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500 dark:text-gray-400">{t("loading", "Loading…")}</div>
      ) : !anyShown ? (
        // Collecting-data state — ONE calm line, never a grid of empty cards.
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 py-12 text-center">
          <BarChart3 className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" aria-hidden />
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {t("rsvpInsCollectingTitle", "Collecting data — insights appear soon")}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto">
            {t("rsvpInsCollectingBody", "As bookings come in, you'll see when you're busy, your no-show rate, and more here.")}
          </p>
        </div>
      ) : (
        <>
          {/* Headline StatCard row — only tiles whose insight is shown carry a
              real value; a hidden insight renders an em-dash so the row never
              implies a fabricated number. Provisional values are muted. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label={isSalon ? t("rsvpInsChairUtil", "Chair use") : t("rsvpInsKpiUtil", "Seat utilization")}
              value={kpiValue(isShown(util.confidence) ? fmtPct(util.seat_hour_pct) : "—", util.confidence)}
              helper={
                isSalon
                  ? t("rsvpInsKpiUtilHelpSalon", "of chair-hours")
                  : t("rsvpInsKpiUtilHelp", "of seat-hours")
              }
            />
            <StatCard
              label={t("rsvpInsKpiNoShow", "No-show rate")}
              value={kpiValue(isShown(noShow.confidence) ? fmtRatePct(noShow.rate) : "—", noShow.confidence)}
              accent={
                noShow.confidence === "confident" && noShow.rate != null && noShow.rate >= 0.15
                  ? "warn"
                  : "neutral"
              }
            />
            <StatCard
              label={t("rsvpInsKpiCovers", "Booked guests")}
              value={kpiValue(isShown(util.confidence) ? fmtInt(util.booked_covers) : "—", util.confidence)}
              helper={t("rsvpInsBookedBasis", "Based on booked guests")}
            />
            <StatCard
              label={t("rsvpInsKpiOnline", "Online share")}
              value={kpiValue(
                isShown(sourceMix.confidence) && onlineShare != null ? fmtRatePct(onlineShare) : "—",
                sourceMix.confidence,
              )}
              helper={t("rsvpInsKpiOnlineHelp", "of guests")}
            />
          </div>

          {/* SIGNATURE heatmap. */}
          {isShown(heatmap.confidence) && <HeatmapCard heatmap={heatmap} t={t} />}

          {/* Secondary cards — each self-hides on its own confidence. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {isShown(recovered.confidence) && <RecoveredCard data={recovered} t={t} />}
            {/* Party-size fit is meaningless for a salon (always party-of-1) — hide it. */}
            {!isSalon && isShown(partyFit.confidence) && <PartySizeCard data={partyFit} t={t} />}
            {isShown(sourceMix.confidence) && <SourceMixCard data={sourceMix} t={t} />}
            {isShown(noShow.confidence) && <NoShowCard data={noShow} t={t} smsHref={smsHref} />}
          </div>

          {/* Pro forecast block (present → list, locked → nudge, null → calm). */}
          <ForecastBlock forecast={forecast} forecastLocked={forecastLocked} t={t} />
        </>
      )}
    </div>
  );
}
