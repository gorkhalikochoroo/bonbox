/**
 * ScheduleForecastPanel — C7 Intelligence collapse.
 *
 * Weather-smart + Smart-staffing used to be two standalone Intelligence
 * pages (/weather, /staffing). The IA declutter folds them into ONE
 * collapsed forecast panel that lives on the Staff Schedule page — right
 * where an owner is actually deciding next week's shifts.
 *
 * Embedding pattern mirrors InventoryAutopilotPanel: a self-contained card
 * the host page drops in. Collapsed by default (it's planning context, not
 * the main event); expanding reveals a sub-tab switcher between the weather
 * forecast and the staffing-demand forecast. Each body is the EXISTING page
 * component rendered with `embedded` so it sheds its own page chrome — no
 * forecast logic is rewritten here.
 *
 * Lazy-loaded bodies: the weather/staffing chunks (+ their recharts usage)
 * only download once the owner expands the panel and picks a sub-tab, so a
 * schedule visit that never touches forecasting stays light.
 */
import { Suspense, lazy, useState } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

const WeatherPage = lazy(() => import("../pages/WeatherPage"));
const StaffingPage = lazy(() => import("../pages/StaffingPage"));

function BodyFallback() {
  return (
    <div className="flex items-center justify-center py-10">
      <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-gray-900 dark:border-gray-100" />
    </div>
  );
}

export default function ScheduleForecastPanel() {
  const { t } = useLanguage();
  // Collapsed by default — planning context, opened on demand. Mirrors the
  // "Manage Staff" collapsible on the same page.
  const [open, setOpen] = useState(false);
  // Sub-tab inside the panel: weather forecast vs staffing-demand forecast.
  const [tab, setTab] = useState("weather");

  const subTabs = [
    { id: "weather", label: t("forecastTabWeather") || "Weather", icon: "CloudSun" },
    { id: "staffing", label: t("forecastTabStaffing") || "Staffing", icon: "CalendarClock" },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40 transition rounded-xl"
      >
        <span className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Icon name="CloudSun" size={16} className="text-gray-500" />
          {t("forecastPanelTitle") || "Forecast & demand"}
          <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
            {t("forecastPanelHint") || "weather + staffing"}
          </span>
        </span>
        <Icon
          name="ChevronDown"
          size={16}
          className={`text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-5 space-y-4 border-t border-gray-100 dark:border-gray-700/60 pt-4">
          {/* Sub-tab switcher — small segmented row inside the panel. */}
          <div role="tablist" aria-label={t("forecastPanelTitle") || "Forecast & demand"} className="flex gap-1.5">
            {subTabs.map((s) => {
              const selected = s.id === tab;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(s.id)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors " +
                    (selected
                      ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600")
                  }
                >
                  <Icon name={s.icon} size={14} />
                  {s.label}
                </button>
              );
            })}
          </div>

          <Suspense fallback={<BodyFallback />}>
            {tab === "weather" && <WeatherPage embedded />}
            {tab === "staffing" && <StaffingPage embedded />}
          </Suspense>
        </div>
      )}
    </div>
  );
}
