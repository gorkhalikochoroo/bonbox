/**
 * TodayDashboard — the owner's "I dag" page (Nov 2026 redesign; Manoj's canvas
 * Dashboard.dc.html, Dashboard-morning.dc.html, Dashboard-mobile.dc.html).
 *
 * Reads three things and nothing else:
 *   • GET /api/today                 — the day on the venue's clock (one read)
 *   • GET /api/cashflow/forecast     — the MOMS foresight (the Moms card)
 *   • GET /api/diagnostics/needs-you — the existing "Skal ses nu" findings
 * and refreshes on the freshness bus (`bonbox-data-changed`), on return to the
 * tab, and every five minutes while visible. The first /today read is the
 * one TodayPage just made (`initial`, `initialAt`) — not asked again.
 *
 * Honest by construction (see todayModel.js): no figure without a source, the
 * sales trend is a word and only like-for-like, "Kræver dig" lists only what
 * the owner can act on, and every button goes somewhere real.
 *
 * Motion (Vagtplan's feel, todayMotion.jsx + today.css): one intro per visit
 * and business day — the hero stands still while its figures rise into place
 * (the beat), the cards settle, bars grow, the meter fills, the now-line
 * fades in — then nothing moves on a poll. Presses come from pressFeel (a
 * finger never flashes a press while scrolling), installed once for the whole
 * owner app by Layout (phone R1), not here. Haptics only on an outcome
 * (PREMIUM-FEEL-SPEC A.5, 1.4): Skjul (feel.soft) and a real Frokost/Aften
 * change (feel.tick); navigation is silent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight, CalendarPlus, Check, ChevronRight, Moon, ReceiptText as Receipt, Send, Timer, UserPlus, Users, X,
} from "lucide-react";
import api from "../../services/api";
import { peekGet } from "../../lib/swrCache";
import { useLanguage } from "../../hooks/useLanguage";
import { useAuth } from "../../hooks/useAuth";
import { usePillars } from "../../hooks/usePillars";
import { archetypeIdFor } from "../../config/archetypes";
import { formatOwnerMoney } from "../../utils/currency";
import { dateLocale } from "../../utils/dateFormat";
import { DATED_CODES, RENDERERS, keyFor, loadDismissed, saveDismissal, skipParamFor } from "../needsYouRenderers";
import {
  buildNeeds, chartWindow, closeSteps, defaultService, greetingKey, heatCells, hhmm,
  laborLine, minutesOf, plural, relMinutes, salesTile, shiftState, splitService, staffSummary, tonightCovers,
} from "./todayModel";
import { introStamp, useTodayIntro } from "./todayMotion";
import { feel } from "../staff/feel";
import { NEW_BOOKING_TO, WALK_IN_TO, canWalkInWith, noteBookFacts } from "./quickJobs";

const REFRESH_MS = 5 * 60 * 1000;
// TodayPage's own /today answer is this fresh or fresher → the first load
// does not ask again (one landing used to read /today twice).
const FRESH_INITIAL_MS = 30 * 1000;
const DATA_EVENT = "bonbox-data-changed";
const AVATAR_HUES = ["#93573F", "#456E5F", "#8A6A2F", "#4F5F80", "#2F5D4E", "#5B6E8C", "#7A4F6A", "#3E6A7A"];

function avatarFor(id) {
  let h = 0;
  for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "·";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function longDate(iso) {
  try {
    const s = new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return iso;
  }
}
function weekdayName(iso) {
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), { weekday: "long" });
  } catch {
    return "";
  }
}
// A figure in a card rises once its card has landed (the cards' rise is
// today.css's tdRise, 0.5 s after the card's own delay), never inside a card
// that is still fading up.
const CARD_RISE_MS = 500;
const figAfterCard = (cardDelayMs) => ({ animationDelay: `${cardDelayMs + CARD_RISE_MS}ms` });

export default function TodayDashboard({ initial = null, initialAt = null, onFresh = null }) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { hiddenPillars } = usePillars();
  const currency = user?.currency || "DKK";
  const money = useCallback((v) => formatOwnerMoney(v, currency), [currency]);
  const archetype = archetypeIdFor(user?.business_type);
  const isFood = archetype === "food_service" || archetype === "bar";
  const isAppointments = archetype === "salon" || archetype === "retail" || archetype === "services";
  const rsvOn = !hiddenPillars.has("reservations");
  const staffOn = !hiddenPillars.has("staff");

  const [data, setData] = useState(initial);
  const [fetchedAt, setFetchedAt] = useState(() => (initial && initialAt ? initialAt : Date.now()));
  const [foresight, setForesight] = useState(() => peekGet("/cashflow/forecast")?.foresight || null);
  // The owner's dismissals ("Skjul"), shared with the old Home's queue.
  const [dismissed, setDismissed] = useState(loadDismissed);
  const dismissedRef = useRef(dismissed);
  // The needs-you findings: null = NOT KNOWN YET. Until they are, the page
  // says neither "all caught up" nor a count — a first paint (or a failed
  // read) must not claim nothing needs the owner.
  const [findings, setFindings] = useState(() => {
    const skip = skipParamFor(dismissed);
    const kept = peekGet("/diagnostics/needs-you", skip ? { skip } : {});
    return Array.isArray(kept?.findings) ? kept.findings : null;
  });
  const [findingsFailed, setFindingsFailed] = useState(false);
  // The wall clock the venue time is moved on by — set by the minute tick,
  // never read during render (React's purity rule).
  const [clockNow, setClockNow] = useState(() => Date.now());
  const alive = useRef(true);
  const [reuseInitial] = useState(() => !!(initial && initialAt && Date.now() - initialAt < FRESH_INITIAL_MS));
  const reusedRef = useRef(false);
  // Set in the effect body too: StrictMode (dev) runs mount → unmount → mount,
  // and a cleanup-only ref would stay false and drop every later answer.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    const skip = skipParamFor(dismissedRef.current);
    const reuse = reuseInitial && !reusedRef.current;
    reusedRef.current = true;
    const [td, fc, nq] = await Promise.allSettled([
      reuse ? Promise.resolve(null) : api.get("/today"),
      api.get("/cashflow/forecast"),
      api.get("/diagnostics/needs-you", { params: skip ? { skip } : {} }),
    ]);
    if (!alive.current) return;
    if (td.status === "fulfilled" && td.value?.data) {
      const at = Date.now();
      setData(td.value.data);
      setFetchedAt(at);
      setClockNow(at);
    }
    if (fc.status === "fulfilled") setForesight(fc.value?.data?.foresight || null);
    if (nq.status === "fulfilled" && Array.isArray(nq.value?.data?.findings)) {
      setFindings(nq.value.data.findings);
      setFindingsFailed(false);
    } else {
      // Could not check: the last known list stays; none known → "failed",
      // never an empty list that reads as "nothing needs you".
      setFindingsFailed(true);
    }
  }, [reuseInitial]);

  const dismiss = useCallback((item) => {
    const next = saveDismissal(dismissedRef.current, item);
    dismissedRef.current = next;
    setDismissed(next);
    // A dated dismissal changes the server's scan (worst-only detectors): ask
    // again so the next one surfaces instead of hiding behind it.
    if (DATED_CODES.has(item.code)) load();
  }, [load]);

  useEffect(() => {
    // First read on the next tick, not in the effect body (React 19's
    // set-state-in-effect rule; same pattern as EventPublicPage).
    const first = setTimeout(load, 0);
    const onData = () => load();
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener(DATA_EVENT, onData);
    document.addEventListener("visibilitychange", onVis);
    const every = setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
    const clock = setInterval(() => setClockNow(Date.now()), 60 * 1000);
    return () => {
      clearTimeout(first);
      window.removeEventListener(DATA_EVENT, onData);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(every);
      clearInterval(clock);
    };
  }, [load]);

  useEffect(() => {
    if (data && onFresh) onFresh(data);
  }, [data, onFresh]);

  // The visit's one intro (todayMotion.jsx): td-intro on the page element the
  // first time this account sees this business day in this session, never on
  // a poll. The DOM's class, not state: its end re-renders nothing.
  const pageRef = useRef(null);
  useTodayIntro(data ? introStamp(user?.id, data.business_day) : null, pageRef);
  // The phone "+" sheet offers the same jobs as the quick row below (one
  // model, two ways in — quickJobs.js): it reads the book's facts from here.
  useEffect(() => {
    if (data?.reservations) noteBookFacts(user?.id, data.reservations);
  }, [data, user?.id]);

  if (!data) return null;

  const cutoff = data.cutoff_hour ?? 6;
  // The venue's clock, moved on by the minutes since the payload was read.
  const nowMin = ((data.now_minutes ?? 0) + Math.max(0, Math.floor((clockNow - fetchedAt) / 60000))) % 1440;
  const dayState = data.day_state;
  const before = dayState === "before_open" || dayState === "closed_today";
  const rsv = rsvOn ? data.reservations : null;
  const showRsv = !!(rsv && rsv.has_book);
  const shifts = staffOn ? (data.staff?.shifts || []) : [];
  const sum = staffSummary(shifts, nowMin, cutoff);
  const known = Array.isArray(findings);
  const visibleFindings = known ? findings.filter((f) => !(keyFor(f) in dismissed)) : null;
  const needs = buildNeeds(data, visibleFindings, { hiddenPillars });

  const closeTo = "/daily-close";
  const newBookingTo = NEW_BOOKING_TO;
  const walkInTo = WALK_IN_TO;
  const canWalkIn = canWalkInWith({ showRsv, isFood, seats: rsv?.seats });

  const greeting = t(greetingKey(nowMin));
  const summary = headerSummary({ t, before, dayState, rsv: showRsv ? rsv : null, isFood, cutoff });

  return (
    <div ref={pageRef} className="td-page">
      <div className="td-wrap">
        <header className="td-head td-rise">
          <div style={{ minWidth: 0 }}>
            <p className="td-head-date">{longDate(data.business_day)} · {hhmm(nowMin)}</p>
            <h1 className="td-head-h1 td-h">{greeting}</h1>
            <p className="td-head-sum">
              {summary}{summary && known ? " " : ""}
              {known && (
                <a href="#td-needs">
                  {needs.length ? t("tdNeedsLink", { count: needs.length }) : t("tdAllCaughtUp")}
                </a>
              )}
            </p>
          </div>
          <div className="td-head-actions">
            <Link to="/home" className="td-link">{t("tdFullOverview")}</Link>
            {showRsv && (
              <Link to={newBookingTo} className="td-btn"><CalendarPlus size={18} aria-hidden="true" />{t("tdNewBooking")}</Link>
            )}
            <Link to={closeTo} className="td-btn td-btn-brass"><Moon size={18} aria-hidden="true" />{t("tdCloseTheDay")}</Link>
          </div>
        </header>

        <Hero t={t} data={data} money={money} before={before} nowMin={nowMin} cutoff={cutoff}
          rsv={showRsv ? rsv : null} shifts={shifts} sum={sum} staffOn={staffOn} isAppointments={isAppointments} />

        <div className="td-quick" role="group" aria-label={t("tdQuickActions")}>
          {showRsv && <Link to={newBookingTo} className="td-btn"><CalendarPlus size={16} aria-hidden="true" />{t("tdNewBooking")}</Link>}
          {canWalkIn && <Link to={walkInTo} className="td-btn"><UserPlus size={16} aria-hidden="true" />{t("tdWalkIn")}</Link>}
          <Link to={closeTo} className="td-btn td-btn-brass"><Moon size={16} aria-hidden="true" />{t("tdCloseTheDay")}</Link>
        </div>

        {/* DOM order is the phone's (canvas: Kræver dig before the book); on a
            wide page the grid areas put the book left, Kræver dig + Personale right. */}
        <div className={`td-grid${showRsv ? "" : " no-res"}`}>
          <Needs t={t} needs={needs} known={known} failed={findingsFailed} navigate={navigate} onDismiss={dismiss} isAppointments={isAppointments} />
          {showRsv && (
            <Bookings t={t} rsv={rsv} day={data.business_day} cutoff={cutoff} nowMin={nowMin}
              isFood={isFood} isAppointments={isAppointments} canWalkIn={canWalkIn} newBookingTo={newBookingTo} walkInTo={walkInTo} />
          )}
          {staffOn && shifts.length > 0 && (
            <Staff t={t} shifts={shifts} sum={sum} nowMin={nowMin} cutoff={cutoff} before={before} />
          )}
        </div>

        <div className="td-bottom">
          <CloseCard t={t} close={data.close} day={data.business_day} money={money} before={before} closeTo={closeTo} />
          <div className="td-minis">
            {foresight?.available && <MomsCard t={t} fs={foresight} money={money} />}
            {staffOn && data.labor && (data.labor.planned_total > 0 || data.labor.logged_total > 0) && (
              <HoursCard t={t} labor={data.labor} day={data.business_day} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function headerSummary({ t, before, dayState, rsv, isFood, cutoff }) {
  const tc = rsv ? tonightCovers(rsv, cutoff) : null;
  // Only "booked tonight" when the figure IS tonight's.
  const covers = tc && tc.when === "tonight" ? tc.covers : 0;
  if (dayState === "closed_today") return t("tdSumClosedToday");
  if (before) {
    return covers > 0
      ? (isFood
        ? t("tdSumBeforeCovers", { count: covers, word: plural(t, covers, "tdWGuest", "tdWGuests") })
        : t("tdSumBeforeAppts", { n: rsv.count, word: plural(t, rsv.count, "tdWAppt", "tdWAppts") }))
      : t("tdSumBefore");
  }
  if (dayState === "after_close") return t("tdSumAfterClose");
  if (covers > 0) {
    return isFood
      ? t("tdSumCovers", { count: covers, word: plural(t, covers, "tdWGuest", "tdWGuests") })
      : t("tdSumAppts", { n: rsv.count, word: plural(t, rsv.count, "tdWAppt", "tdWAppts") });
  }
  return "";
}

/* ── the dark hero ─────────────────────────────────────────────────────── */

function Hero({ t, data, money, before, nowMin, cutoff, rsv, shifts, sum, staffOn, isAppointments }) {
  const hours = data.hours;
  const pill = hours && !hours.closed
    ? (before ? t("tdOpensAt", { time: hours.open }) : (data.day_state === "after_close" ? t("tdClosedNow") : t("tdOpenNow")))
    : (hours?.closed ? t("tdClosedToday") : null);
  const live = !!hours && !hours.closed && !before && data.day_state !== "after_close";

  const tiles = [];
  // Salg i dag
  const st = salesTile(data.sales, data.day_state);
  if (st) {
    const wd = weekdayName(data.business_day);
    let value; let sub = null; let word = false; let brass = false;
    if (st.mode === "before") {
      value = t("tdNotOpenYet"); word = true;
      if (st.yesterday != null) sub = t("tdYesterdayAmount", { amount: money(st.yesterday) });
    } else if (st.mode === "atclose") {
      value = t("tdComesWithClose"); word = true;
      if (st.lastWeek != null) sub = t("tdLastWeekdayAmount", { weekday: wd, amount: money(st.lastWeek) });
      else if (st.yesterday != null) sub = t("tdYesterdayAmount", { amount: money(st.yesterday) });
    } else {
      value = money(st.amount);
      if (st.trend) { sub = t(st.trend, { weekday: wd }); brass = true; }
      else if (st.mode === "sofar" && st.lastWeek != null) sub = t("tdLastWeekdayAmount", { weekday: wd, amount: money(st.lastWeek) });
      else if (st.mode === "sofar") sub = t("tdSoFar");
      else if (st.mode === "none") sub = t("tdNoSalesYet");
    }
    tiles.push({ key: "sales", label: t("tdSalesToday"), value, sub, word, brass, to: "/sales" });
  }
  // Gæster i aften / Tidsbestillinger i dag
  if (rsv) {
    let sub;
    const tc = tonightCovers(rsv, cutoff);
    const n = isAppointments ? rsv.count : tc.count;
    const word = isAppointments
      ? plural(t, n, "tdWAppt", "tdWAppts")
      : plural(t, n, "tdWBooking", "tdWBookings");
    if (!rsv.count && !rsv.requested) sub = t("tdNoBookingsYet");
    else if (rsv.peak?.full) sub = t("tdBookingsFullAt", { n, word, time: rsv.peak.time });
    else if (rsv.peak) sub = t("tdBookingsBusiestAt", { n, word, time: rsv.peak.time });
    else sub = t("tdBookingsCount", { n, word });
    tiles.push({
      key: "guests",
      label: isAppointments ? t("tdApptsToday") : (tc.when === "tonight" ? t("tdGuestsTonight") : t("tdGuestsToday")),
      value: isAppointments ? String(rsv.count) : String(tc.covers),
      sub, to: "/reservations",
    });
  }
  // På vagt nu
  if (staffOn) {
    if (!shifts.length) {
      tiles.push({ key: "staff", label: t("tdOnShiftNow"), value: t("tdNoShiftsToday"), word: true, sub: null, to: "/staff/schedule" });
    } else {
      const measured = data.staff?.uses_clock && typeof data.staff?.clocked_in_now === "number";
      const value = t("tdXofY", { x: measured ? data.staff.clocked_in_now : sum.onNow, y: sum.total });
      let sub;
      if (measured) sub = t("tdClockedInOfPlan", { planned: sum.onNow });
      else if (sum.nextStart != null) sub = before && sum.onNow === 0
        ? t("tdFirstInAt", { time: hhmm(sum.nextStart) })
        : t("tdMoreAt", { count: sum.nextCount, time: hhmm(sum.nextStart) });
      else sub = t("tdPerSchedule");
      tiles.push({ key: "staff", label: t("tdOnShiftNow"), value, sub, to: "/staff/schedule" });
    }
  }
  // Kasserapport
  const ct = data.close?.today; const cy = data.close?.yesterday;
  // A day the venue's own hours say it was shut is not a missing kasserapport.
  const yClosedVenue = !!(cy && (data.close?.days || []).find((d) => d.date === cy.date)?.venue_closed);
  if (ct) {
    const cs = closeSteps(ct);
    let value; let sub; let word = true; let brass = false;
    if (ct.status === "confirmed") { value = t("tdCloseLocked"); sub = ct.closed_at ? t("tdLockedAt", { time: ct.closed_at }) : null; brass = true; }
    else if (ct.status === "draft") { value = t("tdStepsXofY", { x: cs.done, y: 4 }); sub = t("tdCloseInProgress"); }
    else if (before && cy?.status === "confirmed") {
      value = t("tdYesterdayDone");
      sub = cy.revenue != null
        ? (cy.closed_at ? t("tdLockedAtAmount", { time: cy.closed_at, amount: money(cy.revenue) }) : t("tdYesterdayAmount", { amount: money(cy.revenue) }))
        : null;
    }
    else if (before && cy && cy.status !== "confirmed" && data.sales?.uses_daily_close && !yClosedVenue) { value = t("tdYesterdayMissing"); sub = t("tdCloseYesterday"); }
    else { value = t("tdTonight"); sub = t("tdAfterService4"); }
    tiles.push({ key: "close", label: t("navToday"), value, sub, word, brass, to: "/daily-close" });
  }

  return (
    // The hero stands still in the intro: its figures rising is the beat.
    <section aria-labelledby="td-hero-h" className="td-hero">
      <div className="td-hero-stats">
        <div className="td-hero-top">
          <h2 id="td-hero-h" className="td-hero-h td-h">{t("tdTodayTitle")}</h2>
          {pill && (
            <span className="td-pill">
              <span className="td-pill-dot" style={{ background: live ? "#8FD3A8" : "#A9A39A", boxShadow: `0 0 0 3px ${live ? "rgba(143,211,168,0.25)" : "rgba(169,184,174,0.2)"}` }} />
              {pill}
            </span>
          )}
        </div>
        <div className="td-tiles">
          {tiles.map((x) => (
            // vp-row: a stand-alone card — pressFeel presses it 70 ms late, so a
            // scroll that starts on it never shows a press.
            <Link key={x.key} to={x.to} className="td-tile vp-row">
              <span className="td-tile-l">{x.label}</span>
              {/* td-fig: rises into place once, as one piece, in the intro. */}
              <span className={`td-tile-v td-num td-fig${x.word ? " is-word" : ""}`}>{x.value}</span>
              {x.sub ? <span className={`td-tile-s${x.brass ? " is-brass" : ""}`}>{x.sub}</span> : <span className="td-tile-s" aria-hidden="true">&nbsp;</span>}
            </Link>
          ))}
        </div>
      </div>
      <ServiceChart t={t} data={data} rsv={rsv} shifts={shifts} nowMin={nowMin} cutoff={cutoff} before={before} />
    </section>
  );
}

function ServiceChart({ t, data, rsv, shifts, nowMin, cutoff, before }) {
  const win = chartWindow({ ...data, reservations: rsv || { slots: [] }, staff: { shifts } }, cutoff);
  const slots = rsv?.slots || [];
  if (!win || (!slots.length && !shifts.length)) return null;
  const span = win.to - win.from;
  const pos = (m) => Math.max(0, Math.min(100, ((m - win.from) / span) * 100));
  const seats = rsv?.seats || null;
  const maxCovers = Math.max(1, seats || 0, ...slots.map((s) => s.covers));
  const byM = new Map(slots.map((s) => [s.m, s.covers]));
  const n = relMinutes(nowMin, cutoff);
  const bars = [];
  for (let m = win.from; m < win.to; m += 30) {
    const c = byM.get(m) || 0;
    const past = !before && m + 30 <= n;
    const full = seats && c >= seats;
    bars.push({
      m, c,
      h: c ? Math.max(6, Math.round((c / maxCovers) * 68)) : 2,
      bg: !c ? "rgba(247,245,240,0.10)" : past ? "rgba(247,245,240,0.22)" : full ? "var(--td-brass)" : "rgba(247,245,240,0.62)",
    });
  }
  const lanes = shifts.slice(0, 8).map((s, i) => {
    let a = relMinutes(minutesOf(s.start_time), cutoff);
    let b = relMinutes(minutesOf(s.end_time), cutoff);
    if (a == null || b == null) return null;
    if (b <= a) b += 1440;
    const st = before ? "later" : shiftState(s, nowMin, cutoff);
    return {
      key: s.id || i, left: pos(a), width: Math.max(1, pos(b) - pos(a)), top: i * 9,
      bg: st === "on" ? "#F7F5F0" : st === "done" ? "rgba(247,245,240,0.18)" : "rgba(247,245,240,0.42)",
    };
  }).filter(Boolean);
  const axis = [];
  const step = span > 12 * 60 ? 120 : 60;
  for (let m = win.from; m <= win.to; m += step) axis.push(m);
  const closeM = (() => {
    const h = data.hours;
    if (!h || h.closed) return null;
    let c = relMinutes(minutesOf(h.close), cutoff);
    const o = relMinutes(minutesOf(h.open), cutoff);
    if (c != null && o != null && c <= o) c += 1440;
    return c != null && c > win.from && c <= win.to ? c : null;
  })();
  const showNow = !before && n >= win.from && n <= win.to;
  const covers = rsv?.covers || 0;
  const label = t("tdChartAria", { covers, staff: shifts.length });
  // The bars rise left to right within ~0.42 s however long the day is.
  const barStep = Math.min(14, Math.floor(420 / Math.max(1, bars.length)));

  return (
    <div className="td-chart" role="img" aria-label={label}>
      <div className="td-chart-h">
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t("tdServiceToday")}</span>
        <div className="td-legend" aria-hidden="true">
          {slots.length > 0 && <span><span className="td-sw" style={{ background: "rgba(247,245,240,0.62)" }} />{t("tdBookedGuests")}</span>}
          {slots.length > 0 && seats ? <span><span className="td-sw" style={{ background: "var(--td-brass)" }} />{t("tdFullSeats", { seats })}</span> : null}
          {lanes.length > 0 && <span><span className="td-sw" style={{ width: 14, height: 4, background: "#F7F5F0" }} />{t("tdStaffOnShift")}</span>}
        </div>
      </div>
      <div className="td-plot" aria-hidden="true">
        {slots.length > 0 && (
          <div className="td-lane">
            <span className="td-lane-l">{t("tdLaneGuests")}</span>
            <div className="td-bars">
              {bars.map((b, i) => (
                <span key={b.m} className="td-bar" style={{ height: b.h, background: b.bg, animationDelay: `${260 + i * barStep}ms` }} />
              ))}
            </div>
          </div>
        )}
        {lanes.length > 0 && (
          <div className="td-lane" style={{ marginTop: 12, alignItems: "flex-start" }}>
            <span className="td-lane-l">{t("tdLaneStaff")}</span>
            <div className="td-shifts" style={{ height: lanes.length * 9 + 4 }}>
              {lanes.map((l, i) => (
                <span key={l.key} className="td-shift" style={{ left: `${l.left}%`, width: `${l.width}%`, top: l.top, background: l.bg, animationDelay: `${420 + i * 60}ms` }} />
              ))}
            </div>
          </div>
        )}
        <div className="td-lane" style={{ marginTop: 8 }}>
          <span className="td-lane-l" />
          <div className="td-axis">
            {axis.map((m) => (
              <span key={m} style={{ left: `${pos(m)}%`, transform: m === win.from ? "none" : m === win.to ? "translateX(-100%)" : "translateX(-50%)" }}>{hhmm(m).slice(0, 2)}</span>
            ))}
          </div>
        </div>
        <div className="td-marks">
          {closeM != null && (
            <>
              <div className="td-closeline" style={{ left: `${pos(closeM)}%` }} />
              <span className="td-closeline-l" style={{ left: `${pos(closeM)}%`, transform: pos(closeM) > 92 ? "translateX(-100%)" : undefined }}>{t("tdCloses")}</span>
            </>
          )}
          {showNow && (
            <>
              <div className="td-now" style={{ left: `${pos(n)}%` }} />
              <span className="td-now-l" style={{ left: `${pos(n)}%` }}>{hhmm(nowMin)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── bookings tonight ──────────────────────────────────────────────────── */

const STATUS_KEY = {
  requested: "tdStRequested",
  confirmed: "tdStConfirmed",
  seated: "tdStSeated",
  completed: "tdStCompleted",
};

function Bookings({ t, rsv, day, cutoff, nowMin, isFood, isAppointments, canWalkIn, newBookingTo, walkInTo }) {
  const split = useMemo(() => splitService(rsv.items, cutoff), [rsv.items, cutoff]);
  const both = isFood && split.lunch.length > 0 && split.dinner.length > 0;
  const [svc, setSvc] = useState(() => defaultService(split, nowMin));
  const list = !isFood ? rsv.items : (both ? (svc === "lunch" ? split.lunch : split.dinner) : rsv.items);
  const MAX = 10;
  const shown = list.slice(0, MAX);
  const guests = list.filter((r) => r.status !== "requested").reduce((a, r) => a + (r.party || 0), 0);
  const title = isAppointments ? t("tdApptsTitle")
    : !isFood ? t("tdBookingsToday")
      : (both && svc === "lunch") ? t("tdBookingsLunch") : t("tdBookingsTonight");
  const sub = isAppointments
    ? t("tdApptsSub", { n: list.length, word: plural(t, list.length, "tdWAppt", "tdWAppts") })
    : t("tdBookingsSub", {
      n: list.length, word: plural(t, list.length, "tdWBooking", "tdWBookings"),
      guests, gword: plural(t, guests, "tdWGuest", "tdWGuests"),
    });

  return (
    <section aria-labelledby="td-res-h" className="td-card td-a-res td-rise" style={{ animationDelay: "150ms" }}>
      <div className="td-card-h" style={{ flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <h2 id="td-res-h" className="td-card-title td-h">{title}</h2>
          <p className="td-sub">{sub}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {both && (
            <div className="td-seg" role="group" aria-label={t("tdService")}>
              {/* A segment: Vagtplan's selection tick on a real change (iOS app only). */}
              <button type="button" aria-pressed={svc === "lunch"} onClick={() => { if (svc !== "lunch") feel.tick(); setSvc("lunch"); }}>{t("tdLunch")}</button>
              <button type="button" aria-pressed={svc === "dinner"} onClick={() => { if (svc !== "dinner") feel.tick(); setSvc("dinner"); }}>{t("tdDinner")}</button>
            </div>
          )}
          <Link to={`/reservations?date=${day}`} className="td-link">{t("tdOpenBook")}<ChevronRight size={16} aria-hidden="true" /></Link>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="td-empty">
          <span>{isAppointments ? t("tdNoApptsYet") : t("tdNoBookingsTonight")}</span>
          <Link to={newBookingTo} className="td-btn td-btn-sm"><CalendarPlus size={16} aria-hidden="true" />{t("tdNewBooking")}</Link>
        </div>
      ) : (
        <div role="table" aria-label={title}>
          <div className="td-table-h" role="row">
            <span role="columnheader">{t("tdColTime")}</span>
            <span role="columnheader">{isAppointments ? t("tdColClient") : t("tdColGuest")}</span>
            <span role="columnheader">{t("tdColParty")}</span>
            <span role="columnheader">{isAppointments ? t("tdColService") : t("tdColTable")}</span>
            <span role="columnheader">{t("tdColStatus")}</span>
          </div>
          {shown.map((r) => (
            // vp-tint: one row among others in one card — it tints, never shrinks,
            // and only 70 ms into a touch (pressFeel), so a scroll never flashes it.
            <Link key={r.id} role="row" to={`/reservations?booking=${encodeURIComponent(r.id)}&date=${day}`} className="td-brow td-row vp-tint">
              <span role="cell" className="td-brow-t">{r.time}</span>
              <span role="cell" className="td-brow-g">
                <span className="td-brow-name">{r.name || t("tdGuestNoName")}</span>
                {r.allergy && <span className="td-tag is-warn">{t("tdAllergy")}</span>}
                {r.occasion && <span className="td-tag">{r.occasion}</span>}
              </span>
              <span role="cell" className="td-brow-p">
                <Users size={14} aria-hidden="true" />{r.party}
                <span className="sr-only">{t("tdGuestsWord")}</span>
              </span>
              <span role="cell" className="td-brow-tb">{isAppointments ? (r.service || "—") : (r.tables?.length ? r.tables.join(" + ") : "—")}</span>
              <span className="td-brow-meta" aria-hidden="true">
                {r.party} {plural(t, r.party, "tdWGuest", "tdWGuests")}
                {(isAppointments ? r.service : r.tables?.length) ? ` · ${isAppointments ? r.service : r.tables.join(" + ")}` : ""}
              </span>
              <span role="cell" className={`td-st s-${r.status}`}><span className="td-st-dot" />{t(STATUS_KEY[r.status] || "tdStConfirmed")}</span>
            </Link>
          ))}
        </div>
      )}
      {(list.length > MAX || rsv.waitlist > 0 || canWalkIn) && (
        <div className="td-foot">
          <span>
            {list.length > MAX ? t("tdMoreBookings", { count: list.length - MAX }) : ""}
            {list.length > MAX && rsv.waitlist > 0 ? " · " : ""}
            {rsv.waitlist > 0 ? t("tdOnWaitlist", { count: rsv.waitlist }) : ""}
          </span>
          {canWalkIn && <Link to={walkInTo} className="td-btn td-btn-sm"><UserPlus size={16} aria-hidden="true" />{t("tdSeatWalkIn")}</Link>}
        </div>
      )}
    </section>
  );
}

/* ── Kræver dig ────────────────────────────────────────────────────────── */

function needWords(t, item, isAppointments = false) {
  if (item.kind === "publish") {
    return {
      tone: "amber", Icon: Users,
      title: t("tdNeedPublishTitle", { week: item.meta.week }),
      sub: t("tdNeedPublishSub", { count: item.meta.count, word: plural(t, item.meta.count, "tdWShift", "tdWShifts") }),
      action: t("tdPublishAction"),
    };
  }
  if (item.kind === "revisor") {
    return {
      tone: "red", Icon: Send,
      title: t("tdNeedRevisorTitle"),
      sub: t("tdNeedRevisorSub"),
      action: t("tdNeedRevisorAction"),
    };
  }
  const r = RENDERERS[item.code];
  if (!r) return null;
  if (item.code === "unconfirmed_reservations" && item.guest) {
    return {
      tone: "green", Icon: r.icon,
      title: t("tdNeedOneRequestTitle", { name: item.guest.name || t("tdGuestNoName") }),
      // A salon's request is one client and a treatment, not "1 gæst".
      sub: isAppointments
        ? (item.guest.service
          ? t("tdNeedOneRequestSubAppt", { time: item.guest.time, service: item.guest.service })
          : t("tdNeedOneRequestSubApptNoSvc", { time: item.guest.time }))
        : t("tdNeedOneRequestSub", { time: item.guest.time, count: item.guest.party, word: plural(t, item.guest.party, "tdWGuest", "tdWGuests") }),
      action: t("tdNeedAnswer"),
    };
  }
  return {
    tone: item.severity === "urgent" ? "red" : item.code === "unconfirmed_reservations" ? "green" : "amber",
    Icon: r.icon,
    title: r.title(t, item.meta || {}),
    sub: null,
    action: r.action(t),
  };
}

function Needs({ t, needs, known, failed, navigate, onDismiss, isAppointments }) {
  // Not known yet: no count and no "all clear" — the rows we DO know (the
  // unpublished week, the revisor set-up) still show, with a quiet line
  // saying the rest is being checked (or could not be).
  // "Tjekker …" never pulses: at most one fade in, inside the visit's intro.
  const pending = !known && (
    <div className="td-li td-pending" style={{ minHeight: needs.length ? 40 : 52 }}>
      <span className="td-li-body"><span className="td-li-s">{failed ? t("tdNeedsCouldNotCheck") : t("tdNeedsChecking")}</span></span>
    </div>
  );
  return (
    <section id="td-needs" aria-labelledby="td-needs-h" aria-live="polite" aria-busy={!known && !failed} className="td-card td-a-needs td-rise" style={{ animationDelay: "210ms" }}>
      <div className="td-card-h" style={{ justifyContent: "flex-start", gap: 8 }}>
        <h2 id="td-needs-h" className="td-card-title td-h">{t("tdNeedsTitle")}</h2>
        {known && (needs.length > 0 ? <span className="td-count">{needs.length}</span> : <span className="td-clear">{t("tdAllClear")}</span>)}
      </div>
      {known && needs.length === 0 && (
        <div className="td-li" style={{ minHeight: 52 }}>
          <span className="td-li-ic t-green"><Check size={18} aria-hidden="true" /></span>
          <span className="td-li-body"><span className="td-li-s">{t("tdNothingNeedsYou")}</span></span>
        </div>
      )}
      {needs.map((item) => {
        const w = needWords(t, item, isAppointments);
        if (!w) return null;
        const Icon = w.Icon;
        return (
          <div key={item.id} className="td-li td-row">
            <span className={`td-li-ic t-${w.tone}`}><Icon size={18} aria-hidden="true" /></span>
            <span className="td-li-body">
              <span className="td-li-t">{w.title}</span>
              {w.sub && <span className="td-li-s">{w.sub}</span>}
            </span>
            <button type="button" className="td-btn td-btn-sm td-btn-soft" onClick={() => navigate(item.to)}>
              {w.action}
            </button>
            {/* The same "Skjul" the old Home's queue has, on the server's
                findings only (the week and the revisor go away by doing). */}
            {item.kind === "finding" && (
              // Skjul hides it here and now: an outcome, one light tap (iOS app).
              <button type="button" className="td-x" onClick={() => { feel.soft(); onDismiss(item); }} aria-label={t("nyqDismiss")} title={t("nyqDismiss")}>
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
      {pending}
    </section>
  );
}

/* ── Personale i dag ───────────────────────────────────────────────────── */

function Staff({ t, shifts, sum, nowMin, cutoff, before }) {
  const MAX = 8;
  const summary = before && sum.onNow === 0 && sum.firstStart != null
    ? t("tdStaffSumBefore", { n: sum.total, word: plural(t, sum.total, "tdWPerson", "tdWPeople"), time: hhmm(sum.firstStart) })
    : t("tdStaffSum", { n: sum.total, word: plural(t, sum.total, "tdWPerson", "tdWPeople"), on: sum.onNow }) + (sum.unseen > 0 ? ` · ${t("tdStaffUnseen", { count: sum.unseen })}` : "");
  return (
    <section aria-labelledby="td-staff-h" className="td-card td-a-staff td-rise" style={{ animationDelay: "260ms" }}>
      <div className="td-card-h">
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <h2 id="td-staff-h" className="td-card-title td-h">{t("tdStaffToday")}</h2>
          <p className="td-sub">{summary}</p>
        </div>
        <Link to="/staff/schedule" className="td-link">{t("staffSchedule")}<ChevronRight size={16} aria-hidden="true" /></Link>
      </div>
      {shifts.slice(0, MAX).map((s) => {
        const st = before ? "later" : shiftState(s, nowMin, cutoff);
        const chip = st === "on" ? t("tdOnShift") : st === "done" ? t("tdShiftDone") : t("tdFromTime", { time: s.start_time });
        const seen = s.status === "draft" ? t("tdShiftDraft") : s.confirmed_at ? t("tdSeenShift") : t("tdNotSeenShift");
        return (
          <div key={s.id} className="td-person td-row">
            <span className="td-ava" style={{ background: avatarFor(s.staff_id) }} aria-hidden="true">{initials(s.name)}</span>
            <span className="td-person-b">
              <span className="td-person-n">{s.name}</span>
              <span className="td-person-m">
                {s.role ? `${s.role} · ` : ""}
                <span className={!s.confirmed_at && s.status !== "draft" ? "is-unseen" : ""}>{seen}</span>
              </span>
            </span>
            <span className="td-person-time">{s.start_time}–{s.end_time}</span>
            <span className={`td-chip${st === "on" ? " is-on" : ""}`}>{chip}</span>
          </div>
        );
      })}
      {shifts.length > MAX && <div className="td-more-row">{t("tdMoreShifts", { count: shifts.length - MAX })}</div>}
    </section>
  );
}

/* ── Kasserapport card ─────────────────────────────────────────────────── */

const STEP_KEYS = {
  photo: ["tdStepPhoto", "tdStepPhotoSub"],
  sales: ["tdStepSales", "tdStepSalesSub"],
  payments: ["tdStepPayments", "tdStepPaymentsSub"],
  locked: ["tdStepLock", "tdStepLockSub"],
};
const WEEK_LETTERS = ["tdWdMon", "tdWdTue", "tdWdWed", "tdWdThu", "tdWdFri", "tdWdSat", "tdWdSun"];

function CloseCard({ t, close, day, money, before, closeTo }) {
  if (!close) return null;
  const cs = closeSteps(close.today);
  const { cells, bounds } = heatCells(close.days, day);
  const curIdx = cs.status === "confirmed" ? -1 : cs.steps.findIndex((s) => !s.done);
  const chip = cs.status === "confirmed" ? t("tdCloseLocked")
    : cs.status === "draft" ? t("tdStepsDone", { x: cs.done, y: 4 })
      : before ? t("tdNextTonight") : t("tdTonightAfterService");
  const y = close.yesterday;
  return (
    <section aria-labelledby="td-close-h" className="td-card td-close td-rise" style={{ animationDelay: "300ms" }}>
      <div className="td-k-h">
        <div className="td-k-title">
          <span className="td-k-ic"><Moon size={16} aria-hidden="true" /></span>
          <h2 id="td-close-h" className="td-card-title td-h">{t("navToday")}</h2>
        </div>
        <span className={`td-chip${cs.status === "confirmed" ? " is-on" : " is-amber"}`}>{chip}</span>
      </div>
      <div className="td-k-b">
        <ol className="td-steps">
          {cs.steps.map((s, i) => {
            const [title, sub] = STEP_KEYS[s.key];
            return (
              <li key={s.key}>
                <Link to={closeTo} className={`td-step td-row vp-tint${s.done ? " is-done" : ""}${i === curIdx && cs.status === "draft" ? " is-cur" : ""}`}>
                  <span className="td-step-dot">{s.done ? <Check size={14} aria-hidden="true" /> : i + 1}</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <span className="td-step-t">{t(title)}</span>
                    <span className="td-li-s">{s.done ? t("tdStepDone") : t(sub)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
            <span style={{ fontWeight: 600 }}>{t("tdLast4Weeks")}</span>
            {y?.status === "confirmed" && y.revenue != null && (
              <span className="td-sub" style={{ fontSize: 12.5 }}>
                {y.closed_at ? t("tdYesterdayLockedLine", { amount: money(y.revenue), time: y.closed_at }) : t("tdYesterdayAmount", { amount: money(y.revenue) })}
              </span>
            )}
          </div>
          <div className="td-heat" role="img" aria-label={t("tdHeatAria")}>
            {WEEK_LETTERS.map((k) => <span key={k} className="td-heat-l" aria-hidden="true">{t(k)}</span>)}
            {cells.map((c, i) => (
              <span key={c.date || `f${i}`} className={`td-cell c-${c.state === "closed" ? `closed${c.level}` : c.state}`}
                title={c.date ? `${c.date}${c.revenue != null ? ` · ${money(c.revenue)}` : ""}` : undefined} />
            ))}
          </div>
          <div className="td-legend-k" aria-hidden="true">
            {bounds ? (
              <>
                <span><span className="td-sw td-cell c-closed1" style={{ width: 9, height: 9 }} />≤ {money(bounds[0])}</span>
                <span><span className="td-sw td-cell c-closed2" style={{ width: 9, height: 9 }} />≤ {money(bounds[1])}</span>
                <span><span className="td-sw td-cell c-closed3" style={{ width: 9, height: 9 }} />&gt; {money(bounds[1])}</span>
              </>
            ) : (
              <span><span className="td-sw td-cell c-closed2" style={{ width: 9, height: 9 }} />{t("tdLegendLocked")}</span>
            )}
            <span><span className="td-sw td-cell c-missing" style={{ width: 9, height: 9 }} />{t("dcHeatmapNoClose")}</span>
            <span><span className="td-sw td-cell c-venueClosed" style={{ width: 9, height: 9 }} />{t("tdLegendVenueClosed")}</span>
          </div>
        </div>
      </div>
      <div className="td-k-foot">
        <span className="td-sub">{cs.status === "confirmed" ? t("tdCloseDoneFoot") : t("tdCloseFoot")}</span>
        <Link to={closeTo} className="td-btn td-btn-sm td-btn-brass">
          <Moon size={16} aria-hidden="true" />
          {cs.status === "confirmed" ? t("tdOpenClose") : cs.status === "draft" ? t("tdContinueClose") : t("tdCloseTheDay")}
        </Link>
      </div>
    </section>
  );
}

/* ── Moms ──────────────────────────────────────────────────────────────── */

const MOMS_DELAY_MS = 340;

function MomsCard({ t, fs, money }) {
  const rate = fs.action && !fs.action.already_covered ? fs.action.weekly_rate : null;
  const realized = fs.moms?.realized;
  const expected = fs.moms?.expected;
  const pct = typeof realized === "number" && typeof expected === "number" && expected > 0
    ? Math.max(0, Math.min(100, Math.round((realized / expected) * 100))) : null;
  const dl = fs.deadline;
  let dlText = null;
  if (dl?.date) {
    try {
      dlText = new Date(`${dl.date}T12:00:00`).toLocaleDateString(dateLocale(), { day: "numeric", month: "long", year: "numeric" });
    } catch { dlText = dl.date; }
  }
  return (
    <section aria-labelledby="td-moms-h" className="td-card td-rise" style={{ animationDelay: `${MOMS_DELAY_MS}ms` }}>
      <div className="td-k-h">
        <div className="td-k-title">
          <span className="td-k-ic"><Receipt size={16} aria-hidden="true" /></span>
          <h2 id="td-moms-h" className="td-card-title td-h">MOMS</h2>
        </div>
        {dl?.period_label && <span className="td-chip">{dl.period_label}</span>}
      </div>
      <div className="td-k-b">
        {rate != null ? (
          <div>
            <span className="td-li-s">{t("tdSetAsideWeekly")}</span>
            <div className="td-big td-num td-fig" style={figAfterCard(MOMS_DELAY_MS)}>~{money(rate)}</div>
          </div>
        ) : fs.action?.already_covered ? (
          <div>
            <span className="td-li-s">{t("tdSetAsideWeekly")}</span>
            <div className="td-big td-h" style={{ fontSize: 20 }}>{t("tdMomsCovered")}</div>
          </div>
        ) : (
          <div>
            <span className="td-li-s">{t("tdMomsExpected")}</span>
            <div className="td-big td-num td-fig" style={figAfterCard(MOMS_DELAY_MS)}>~{money(expected)}</div>
          </div>
        )}
        {pct != null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="td-meter" role="img" aria-label={t("tdMomsMeterAria", { booked: money(realized), expected: money(expected) })}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: "var(--td-muted)" }}>
              <span><strong style={{ color: "var(--td-ink)" }}>{money(realized)}</strong> {t("tdMomsBooked")}</span>
              <span>~{money(expected)} {t("tdMomsEstimated")}</span>
            </div>
          </div>
        )}
      </div>
      <div className="td-k-foot">
        <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          {dlText && <span style={{ fontWeight: 600 }}>{t("tdDeadline", { date: dlText })}</span>}
          {typeof dl?.days_until === "number" && <span className="td-li-s">{t("tdInDays", { count: dl.days_until, word: plural(t, dl.days_until, "tdWDay", "tdWDays") })}</span>}
        </span>
        <Link to="/tax" className="td-link">{t("tdOpen")}<ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </section>
  );
}

/* ── Timer ─────────────────────────────────────────────────────────────── */

const HOURS_DELAY_MS = 380;

function HoursCard({ t, labor, day }) {
  const ll = laborLine(labor);
  const planned = labor.planned_by_day || [];
  const done = labor.logged_by_day || [];
  const max = Math.max(1, ...planned, ...done);
  const todayIdx = (() => {
    try { return (new Date(`${day}T12:00:00`).getDay() + 6) % 7; } catch { return -1; }
  })();
  const fmtH = (h) => String(Math.round((h || 0) * 10) / 10).replace(".", ",");
  return (
    <section aria-labelledby="td-hours-h" className="td-card td-rise" style={{ animationDelay: `${HOURS_DELAY_MS}ms` }}>
      <div className="td-k-h">
        <div className="td-k-title">
          <span className="td-k-ic"><Timer size={16} aria-hidden="true" /></span>
          <h2 id="td-hours-h" className="td-card-title td-h">{t("tdHoursTitle")}</h2>
        </div>
        <span className="td-chip">{t("tdWeekN", { week: labor.week_number })}</span>
      </div>
      <div className="td-k-b">
        <div>
          <span className="td-li-s">{t("tdLoggedSoFar")}</span>
          <div className="td-big td-num td-fig" style={figAfterCard(HOURS_DELAY_MS)}>{fmtH(labor.logged_total)} <small>{t("tdOfPlannedHours", { hours: fmtH(labor.planned_total) })}</small></div>
        </div>
        <div className="td-week" role="img" aria-label={t("tdHoursAria", { logged: fmtH(labor.logged_total), planned: fmtH(labor.planned_total) })}>
          {planned.map((p, i) => {
            const ph = Math.max(4, Math.round(((p || 0) / max) * 56));
            const dh = Math.min(ph, Math.round(((done[i] || 0) / max) * 56));
            return (
              // --td-i: the column's place in the week's one-by-one growth (today.css).
              <div key={i} className={`td-week-col${i === todayIdx ? " is-today" : ""}`} style={{ "--td-i": i }}>
                <div className="td-week-plan" style={{ height: ph }}>
                  {dh > 0 && <div className="td-week-done" style={{ height: dh }} />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="td-heat" aria-hidden="true" style={{ marginTop: -6 }}>
          {WEEK_LETTERS.map((k) => <span key={k} className="td-heat-l">{t(k)}</span>)}
        </div>
      </div>
      <div className="td-k-foot">
        <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          {ll?.pct != null ? (
            <>
              <span className="td-fig" style={{ fontWeight: 600, ...figAfterCard(HOURS_DELAY_MS) }}>{t("tdLaborPct", { pct: ll.pct })}</span>
              <span className="td-li-s">{t("tdLaborPctSub", { count: ll.days, word: plural(t, ll.days, "tdWDay", "tdWDays") })}</span>
            </>
          ) : ll?.reason === "missingWage" ? (
            <span className="td-li-s">{t("tdLaborMissingWage", { count: ll.count })}</span>
          ) : (
            <span className="td-li-s">{t("tdLaborNoSettled")}</span>
          )}
        </span>
        <Link to="/staff/hours" className="td-link">{t("staffBackOffice")}<ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </section>
  );
}
