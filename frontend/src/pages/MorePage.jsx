import { Link, useNavigate } from "react-router-dom";
import { useBranch } from "../components/BranchSelector";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useTheme, THEMES } from "../hooks/useTheme";

const sections = [
  {
    title: "Money",
    items: [
      { to: "/cashbook", icon: "📒", labelKey: "cashBook" },
      { to: "/cashflow", icon: "📈", labelKey: "cashFlow" },
      { to: "/budgets", icon: "🎯", labelKey: "budgetOverview" },
      { to: "/bank-import", icon: "🏦", labelKey: "bankImport" },
      { to: "/payment-imports", icon: "💳", labelKey: "paymentImports" },
    ],
  },
  {
    title: "Stock",
    items: [
      { to: "/inventory", icon: "📦", labelKey: "inventory" },
      { to: "/wine-list", icon: "🍷", labelKey: "wineList", visibleFor: ["restaurant", "bar", "cafe", "hotel", "general"] },
      { to: "/expiry", icon: "⏰", labelKey: "expiryForecasting", visibleFor: ["restaurant", "retail", "general"] },
      { to: "/waste", icon: "🗑️", labelKey: "wasteTracker", visibleFor: ["restaurant", "retail", "general"] },
    ],
  },
  {
    title: "Staff",
    items: [
      { to: "/staff/schedule", icon: "📅", labelKey: "staffSchedule" },
      { to: "/staff/hours", icon: "⏱", labelKey: "staffHours" },
      { to: "/staff/tips", icon: "💰", labelKey: "staffTips" },
      { to: "/staff/payroll", icon: "📄", labelKey: "staffPayroll" },
    ],
  },
  {
    title: "Reports",
    items: [
      { to: "/reports", icon: "📋", labelKey: "reports" },
      { to: "/daily-close", icon: "🧾", labelKey: "dailyClose" },
      { to: "/tax", icon: "💰", labelKey: "taxAutopilot" },
      { to: "/bookkeeping-export", icon: "📤", labelKey: "bookkeepingExport" },
    ],
  },
  {
    title: "Intelligence",
    visibleFor: ["restaurant", "retail", "service", "general"],
    items: [
      { to: "/insights", icon: "✨", labelKey: "aiInsights" },
      { to: "/weather", icon: "🌦️", labelKey: "weatherSmart" },
      { to: "/staffing", icon: "👥", labelKey: "smartStaffing" },
      { to: "/pricing", icon: "💲", labelKey: "priceOptimization" },
      { to: "/retention", icon: "🤝", labelKey: "customerRetention" },
      { to: "/competitors", icon: "🔍", labelKey: "competitorScan" },
    ],
  },
  {
    title: "Manage",
    items: [
      { to: "/branches", icon: "🏢", labelKey: "branches" },
      { to: "/team", icon: "👤", labelKey: "team" },
      { to: "/profile", icon: "⚙️", labelKey: "profile" },
      { to: "/subscription", icon: "💎", labelKey: "subscription" },
      { to: "/feedback", icon: "💬", labelKey: "feedback" },
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
          <div className="grid grid-cols-4 gap-2">
            {section.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="flex flex-col items-center justify-center
                  bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                  rounded-xl p-3 min-h-[72px] active:scale-95 transition-transform"
              >
                <span className="text-xl mb-1">{item.icon}</span>
                <span className="text-[11px] text-gray-500 dark:text-gray-400 text-center leading-tight font-medium">
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
          <span className="text-lg">{dark ? "☀️" : "🌙"}</span>
          {dark ? t("lightMode") || "Light Mode" : t("darkMode") || "Dark Mode"}
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl
            bg-white dark:bg-gray-800 border border-red-200 dark:border-red-900/50
            text-sm text-red-500 dark:text-red-400 font-medium active:scale-[0.98] transition-transform"
        >
          <span className="text-lg">🚪</span>
          {t("signOut") || "Sign Out"}
        </button>
      </div>
    </div>
  );
}
