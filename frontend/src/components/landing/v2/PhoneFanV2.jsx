import React from "react";
import { BatteryFull } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";

/**
 * PhoneFanV2 — the three-phone 3D fan from the "staff" section of the
 * newlanding design. Left = Availability, centre = My schedule,
 * right = My hours. Static demo values, no data fetching.
 *
 * Side phones are hidden below 980px (min-[981px]:block), matching the
 * design's [data-phone="side"] media query.
 *
 * The .bb-float keyframe already lives in index.css; data-anim="1" is what
 * the global prefers-reduced-motion rule keys off, so every animated
 * wrapper carries it.
 */

const SHADOW_SIDE = "shadow-[0_30px_56px_-28px_rgba(15,23,42,0.50)]";
const SHADOW_CENTRE = "shadow-[0_34px_64px_-26px_rgba(15,23,42,0.55)]";

function PhoneShell({ shadow, children }) {
  return (
    <div className={`w-[280px] bg-slate-900 rounded-[38px] p-[9px] ${shadow}`}>
      <div className="bg-white text-slate-900 rounded-[30px] overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="flex items-center justify-between px-5 pt-3 pb-1.5 text-xs font-semibold">
      <span>09.41</span>
      <span
        aria-hidden="true"
        className="w-[62px] h-4 rounded-full bg-slate-900"
      />
      <BatteryFull
        aria-hidden="true"
        size={17}
        strokeWidth={1.75}
        className="text-slate-900"
      />
    </div>
  );
}

function ScreenHeader({ title, venue, live }) {
  return (
    <div className="flex items-start justify-between gap-2.5 px-[18px] pt-2 pb-3.5">
      <div>
        <div className="font-display text-[19px] font-bold tracking-[-0.02em]">
          {title}
        </div>
        <div className="text-[11.5px] text-slate-400">{venue}</div>
      </div>
      <span className="inline-flex items-center gap-[5px] bg-bb-green-tint text-bb-green-dark text-[10.5px] font-semibold px-[9px] py-1 rounded-full">
        <span
          aria-hidden="true"
          className="inline-block w-[5px] h-[5px] rounded-full bg-bb-green-bright"
        />
        {live}
      </span>
    </div>
  );
}

function TabBar({ tabs, active }) {
  return (
    <div className="grid grid-cols-4 gap-1 px-3 pt-[9px] pb-3.5 border-t border-slate-100 text-center text-[9.5px]">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={
            tab.id === active
              ? "text-bb-green font-semibold"
              : "text-slate-400"
          }
        >
          {tab.label}
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ children, className = "" }) {
  return (
    <div
      className={`text-[9.5px] font-semibold tracking-[0.13em] uppercase text-slate-400 ${className}`}
    >
      {children}
    </div>
  );
}

export default function PhoneFanV2() {
  const { t } = useLanguage();

  const venue = t("landingV2.phones.venue", "Bistro Nørrebro");
  const live = t("landingV2.phones.live", "Live");

  const tabs = [
    { id: "schedule", label: t("landingV2.phones.tabSchedule", "Schedule") },
    {
      id: "availability",
      label: t("landingV2.phones.tabAvailability", "Availability"),
    },
    { id: "swaps", label: t("landingV2.phones.tabSwaps", "Swaps") },
    { id: "hours", label: t("landingV2.phones.tabHours", "Hours") },
  ];

  const week = [
    { key: "mon", letter: t("landingV2.phones.dayMon", "M"), date: "27", state: "today" },
    { key: "tue", letter: t("landingV2.phones.dayTue", "T"), date: "28", state: "off" },
    { key: "wed", letter: t("landingV2.phones.dayWed", "W"), date: "29", state: "off" },
    { key: "thu", letter: t("landingV2.phones.dayThu", "T"), date: "30", state: "off" },
    { key: "fri", letter: t("landingV2.phones.dayFri", "F"), date: "31", state: "shift" },
    { key: "sat", letter: t("landingV2.phones.daySat", "S"), date: "1", state: "shift" },
    { key: "sun", letter: t("landingV2.phones.daySun", "S"), date: "2", state: "off" },
  ];

  const dayCell = {
    today: "text-[12px] font-semibold py-[5px] rounded-[7px]",
    off: "text-[12px] py-[5px] text-slate-300",
    shift: "text-[12px] font-semibold py-[5px] rounded-[7px] bg-bb-green-tint text-bb-green-dark",
  };

  return (
    <div
      className="flex items-center justify-center pt-5 pb-2"
      style={{ perspective: "2000px" }}
    >
      {/* Left — Availability */}
      <div
        className="hidden min-[981px]:block mr-[-30px] z-[1]"
        style={{
          transform:
            "rotateY(26deg) rotateX(4deg) translateZ(-90px) scale(0.88)",
        }}
      >
        <div
          data-anim="1"
          className="bb-float"
          style={{ animationDelay: "1.2s" }}
        >
          <PhoneShell shadow={SHADOW_SIDE}>
            <StatusBar />
            <ScreenHeader
              title={t("landingV2.phones.availabilityTitle", "Availability")}
              venue={venue}
              live={live}
            />
            <div className="px-3.5">
              <SectionLabel className="mb-2">
                {t("landingV2.phones.holidaySickLabel", "Holiday & sick leave")}
              </SectionLabel>
              <div className="border border-slate-200 rounded-xl p-[11px] text-center text-[12.5px] font-medium mb-[18px]">
                {t(
                  "landingV2.phones.requestLeave",
                  "Request holiday / sick leave"
                )}
              </div>
              <SectionLabel className="mb-2">
                {t("landingV2.phones.cantWorkLabel", "Can't work")}
              </SectionLabel>
              <p className="m-0 mb-3 text-[12px] leading-[1.45] text-slate-500">
                {t(
                  "landingV2.phones.cantWorkBody",
                  "Mark the days or times you can't work. Your manager sees it while building the schedule."
                )}
              </p>
              <div className="border border-dashed border-slate-200 rounded-xl px-3 py-[26px] text-center text-[12px] text-slate-400 mb-3">
                {t("landingV2.phones.nothingMarked", "Nothing marked yet.")}
              </div>
              <div className="bg-slate-900 text-white rounded-xl p-3 text-center text-[12.5px] font-medium mb-4">
                {t("landingV2.phones.markCantWork", "+ Mark “can't work”")}
              </div>
            </div>
            <TabBar tabs={tabs} active="availability" />
          </PhoneShell>
        </div>
      </div>

      {/* Centre — My schedule */}
      <div
        data-anim="1"
        className="bb-float z-[3]"
        style={{ animationDelay: "0s" }}
      >
        <PhoneShell shadow={SHADOW_CENTRE}>
          <StatusBar />
          <ScreenHeader
            title={t("landingV2.phones.scheduleTitle", "My schedule")}
            venue={venue}
            live={live}
          />

          <div className="mx-3.5 mb-3 bg-slate-900 text-white rounded-[14px] px-4 py-[15px]">
            <div className="text-[9.5px] font-semibold tracking-[0.13em] uppercase text-slate-500 mb-1.5">
              {t("landingV2.phones.nextShiftLabel", "Your next shift")}
            </div>
            <div className="font-display text-[19px] font-bold tracking-[-0.02em]">
              {t("landingV2.phones.nextShiftWhen", "Fri 31 Jul · 16–23")}
            </div>
            <div className="text-[12px] text-slate-400 mt-[5px]">
              {t(
                "landingV2.phones.nextShiftMeta",
                "Floor · 6.25 h · with Alma and Aksel"
              )}
            </div>
          </div>

          <div className="mx-3.5 mb-3.5 border border-slate-200 rounded-[14px] px-[15px] py-3.5">
            <div className="flex justify-between items-baseline mb-3">
              <SectionLabel>
                {t("landingV2.phones.thisWeek", "This week")}
              </SectionLabel>
              <span className="text-[11.5px] text-slate-500">
                {t("landingV2.phones.weekRange", "27 Jul – 2 Aug")}
              </span>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center">
              {week.map((day) => (
                <div key={day.key}>
                  <div className="text-[9.5px] text-slate-400 mb-[5px]">
                    {day.letter}
                  </div>
                  <div className={dayCell[day.state]}>{day.date}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-[11px] border-t border-slate-200 text-[11.5px] text-slate-500">
              {t(
                "landingV2.phones.weekTotal",
                "12.5 h · 2 shifts · ≈ 1.812 kr"
              )}
            </div>
          </div>

          <TabBar tabs={tabs} active="schedule" />
        </PhoneShell>
      </div>

      {/* Right — My hours */}
      <div
        className="hidden min-[981px]:block ml-[-30px] z-[1]"
        style={{
          transform:
            "rotateY(-26deg) rotateX(4deg) translateZ(-90px) scale(0.88)",
        }}
      >
        <div
          data-anim="1"
          className="bb-float"
          style={{ animationDelay: "2.4s" }}
        >
          <PhoneShell shadow={SHADOW_SIDE}>
            <StatusBar />
            <ScreenHeader
              title={t("landingV2.phones.hoursTitle", "My hours")}
              venue={venue}
              live={live}
            />
            <div className="px-3.5">
              <div className="text-[11.5px] text-slate-500 mb-2.5">
                {t("landingV2.phones.hoursPeriod", "Period: 1 Jul – 31 Jul")}
              </div>
              <div className="grid grid-cols-2 gap-[9px] mb-4">
                <div className="border border-slate-200 rounded-xl px-[13px] py-3">
                  <div className="text-[9.5px] text-slate-400 mb-[5px]">
                    {t("landingV2.phones.rosteredHours", "Rostered hours")}
                  </div>
                  <div className="font-display text-[21px] font-bold tracking-[-0.02em]">
                    12.5
                  </div>
                </div>
                <div className="border border-slate-200 rounded-xl px-[13px] py-3">
                  <div className="text-[9.5px] text-slate-400 mb-[5px]">
                    {t("landingV2.phones.shiftsCount", "Shifts")}
                  </div>
                  <div className="font-display text-[21px] font-bold tracking-[-0.02em]">
                    2
                  </div>
                </div>
              </div>

              <SectionLabel className="mb-2">
                {t("landingV2.phones.yourShifts", "Your shifts")}
              </SectionLabel>
              <div className="border border-slate-200 rounded-xl overflow-hidden mb-4">
                <div className="flex justify-between gap-2.5 px-[13px] py-3 border-b border-slate-100 text-[12px]">
                  <span>
                    {t(
                      "landingV2.phones.shiftOne",
                      "Fri 31 Jul · 16:00–23:00"
                    )}
                  </span>
                  <span className="text-slate-500">
                    {t("landingV2.phones.shiftLength", "6.25 h")}
                  </span>
                </div>
                <div className="flex justify-between gap-2.5 px-[13px] py-3 text-[12px]">
                  <span>
                    {t("landingV2.phones.shiftTwo", "Sat 1 Aug · 16:00–23:00")}
                  </span>
                  <span className="text-slate-500">
                    {t("landingV2.phones.shiftLength", "6.25 h")}
                  </span>
                </div>
              </div>
              <div className="text-[11.5px] text-slate-400 mb-4">
                {t(
                  "landingV2.phones.hoursEstimate",
                  "Estimate · ≈ 1.812 kr. before tax"
                )}
              </div>
            </div>
            <TabBar tabs={tabs} active="hours" />
          </PhoneShell>
        </div>
      </div>
    </div>
  );
}
