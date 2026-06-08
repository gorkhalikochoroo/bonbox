import { Link, useNavigate } from "react-router-dom";
import { useBranch } from "../components/BranchSelector";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useTheme, THEMES } from "../hooks/useTheme";
import Icon from "../components/ui/Icon";

// Icon names map to the same Lucide tokens the sidebar (Layout.jsx)
// uses — keeps the mobile More page visually consistent with the
// desktop sidebar nav so an owner switching devices sees the same
// glyph for each destination. Audit a4cf5f referenced Manoj's request
// to "match with side bar" — single source of icon truth.
const sections = [
  {
    title: "Money",
    items: [
      { to: "/cashbook", icon: "BookOpen", labelKey: "cashBook" },
      { to: "/cashflow", icon: "LineChart", labelKey: "cashFlow" },
      { to: "/budgets", icon: "Target", labelKey: "budgetOverview" },
      { to: "/bank-import", icon: "Landmark", labelKey: "bankImport" },
      { to: "/payment-imports", icon: "CreditCard", labelKey: "paymentImports" },
    ],
  },
  {
    title: "Stock",
    items: [
      { to: "/inventory", icon: "Package", labelKey: "inventory" },
      { to: "/wine-list", icon: "Wine", labelKey: "wineList", visibleFor: ["restaurant", "bar", "cafe", "hotel", "general"] },
      { to: "/expiry", icon: "AlarmClock", labelKey: "expiryForecasting", visibleFor: ["restaurant", "retail", "general"] },
      { to: "/waste", icon: "Trash2", labelKey: "wasteTracker", visibleFor: ["restaurant", "retail", "general"] },
    ],
  },
  {
    title: "Staff",
    items: [
      { to: "/staff/schedule", icon: "Calendar", labelKey: "staffSchedule" },
      { to: "/staff/hours", icon: "Timer", labelKey: "staffHours" },
      { to: "/staff/tips", icon: "Coins", labelKey: "staffTips" },
      { to: "/staff/payroll", icon: "FileSpreadsheet", labelKey: "staffPayroll" },
    ],
  },
  {
    title: "Reports",
    items: [
      { to: "/reports", icon: "ClipboardList", labelKey: "reports" },
      { to: "/daily-close", icon: "Moon", labelKey: "dailyClose" },
      { to: "/tax", icon: "Calculator", labelKey: "taxAutopilot" },
      { to: "/bookkeeping-export", icon: "Send", labelKey: "bookkeepingExport" },
    ],
  },
  {
    title: "Intelligence",
    visibleFor: ["restaurant", "retail", "service", "general"],
    items: [
      { to: "/insights", icon: "Sparkles", labelKey: "aiInsights" },
      { to: "/weather", icon: "CloudSun", labelKey: "weatherSmart" },
      { to: "/staffing", icon: "CalendarClock", labelKey: "smartStaffing" },
      { to: "/pricing", icon: "BadgePercent", labelKey: "priceOptimization" },
      { to: "/retention", icon: "Heart", labelKey: "customerRetention" },
      { to: "/competitors", icon: "Telescope", labelKey: "competitorScan" },
    ],
  },
  {
    title: "Manage",
    items: [
      { to: "/connections", icon: "Link2", labelKey: "navConnections" },
      { to: "/branches", icon: "Building2", labelKey: "branches" },
      { to: "/terminals", icon: "Monitor", labelKey: "terminals" },
      { to: "/team", icon: "UserCog", labelKey: "team" },
      { to: "/profile", icon: "Settings", labelKey: "profile" },
      { to: "/subscription", icon: "Sparkles", labelKey: "subscription" },
      { to: "/feedback", icon: "MessageCircle", labelKey: "feedback" },
    ],
  },
];

export default function MorePage() {
  const { branchType, businessTypes } = useBranch();
  const { t } = useLanguage();
  const { logout } = useAuth();
  const [dark, toggleDark] = useDarkMode();
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();
  const activeTypes = branchType ? [branchType] : businessTypes.length ? businessTypes : ["general"];

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  // Filter sections and items by business type
  const visible = sections
    .filter((s) => !s.visibleFor || s.visibleFor.some((bt) => activeTypes.includes(bt)))
    .map((s) => ({
      ...s,
      items: s.items.filter((item) => !item.visibleFor || item.visibleFor.some((bt) => activeTypes.includes(bt))),
    }))
    .filter((s) => s.items.length > 0);

  return (
    <div className="p-4 pb-24 page-enter">
      <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-4">
        {t("more") || "More"}
      </h2>
      {visible.map((section) => (
        <div key={section.title} className="mb-6">
          <h3 className="text-xs text-gray-400 dark:text-gray-500 font-semibold uppercase tracking-wider mb-2 px-1">
            {section.title}
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {section.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="flex flex-col items-center justify-center
                  bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                  rounded-xl p-3 min-h-[72px] active:scale-95 transition-transform
                  hover:border-gray-300 dark:hover:border-gray-600"
              >
                <Icon name={item.icon} size={20} strokeWidth={1.75} className="text-gray-700 dark:text-gray-300 mb-1.5" />
                <span className="text-[11px] text-gray-600 dark:text-gray-400 text-center leading-tight font-medium">
                  {t(item.labelKey) || item.labelKey}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}

      {/* Theme picker — accent only, doesn't change light/dark mode */}
      <div className="mt-2 mb-2">
        <h3 className="text-xs text-gray-400 dark:text-gray-500 font-semibold uppercase tracking-wider mb-2 px-1">
          {t("appearance") || "Appearance"}
        </h3>
        <div className="grid grid-cols-4 gap-2">
          {THEMES.map((th) => {
            const active = theme === th.id;
            return (
              <button
                key={th.id}
                onClick={() => setTheme(th.id)}
                aria-pressed={active}
                aria-label={`${th.name} theme — ${th.description}`}
                className={`flex flex-col items-center justify-center
                  bg-white dark:bg-gray-800 rounded-xl p-3 min-h-[72px]
                  active:scale-95 transition-transform
                  ${active
                    ? "border-2 border-blue-500 dark:border-blue-400"
                    : "border border-gray-200 dark:border-gray-700"}`}
              >
                <span
                  className="block w-6 h-6 rounded-full mb-1.5 ring-1 ring-black/5 dark:ring-white/10"
                  style={{ backgroundColor: th.swatch }}
                />
                <span className="text-[11px] text-gray-700 dark:text-gray-300 text-center leading-tight font-medium">
                  {th.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Dark mode + Sign out */}
      <div className="mt-4 space-y-2">
        <button
          onClick={toggleDark}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl
            bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
            text-sm text-gray-700 dark:text-gray-300 active:scale-[0.98] transition-transform"
        >
          <Icon name={dark ? "Sun" : "Moon"} size={18} strokeWidth={1.75} className="text-gray-600 dark:text-gray-300" />
          {dark ? t("lightMode") || "Light Mode" : t("darkMode") || "Dark Mode"}
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl
            bg-white dark:bg-gray-800 border border-red-200 dark:border-red-900/50
            text-sm text-red-500 dark:text-red-400 font-medium active:scale-[0.98] transition-transform"
        >
          <Icon name="LogOut" size={18} strokeWidth={1.75} />
          {t("signOut") || "Sign Out"}
        </button>
      </div>
    </div>
  );
}
