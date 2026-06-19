/**
 * StaffBackOfficePage — C12 Bucket B (Staff back-office tab-merge).
 *
 * Before this, the Staff group carried FOUR sidebar rows for what an owner
 * thinks of as one job — "settle the staff numbers": Hours, Time-registration,
 * Tips, Payroll. This thin wrapper collapses them into a SINGLE destination
 * (/staff/hours) with a TabPills switcher (Timer · Tidsregistrering ·
 * Drikkepenge · Løn). The four underlying pages are UNCHANGED and still
 * mounted — we just render the chosen one beneath the tab row.
 *
 * /staff/schedule is deliberately NOT part of this merge: it is weekly (not
 * back-office), and the salon bottom-nav 4th tab depends on its exact `to`
 * match, so it stays its own top-level sidebar row.
 *
 * The legacy /staff/time-registration, /staff/tips, /staff/payroll routes stay
 * registered (App.jsx) but now <Navigate replace> here with the matching ?tab,
 * so old bookmarks, deep links, push-notification targets, and ⌘K all land
 * correctly. (DK terminology lock: the "Løn" tab keeps its Danish label even
 * in the EN UI.)
 *
 * Layout note: this mirrors ImportsPage exactly — every child page already
 * brings its own page gutters / max-width / PageHeader, so this wrapper does
 * NOT add a PageShell (that would double the gutters). The tab row renders in
 * a matching-gutter strip above the child; only one child mounts at a time so
 * their data fetches don't all fire.
 *
 * The active tab is reflected in the URL (?tab=hours|time|tips|payroll) so it's
 * shareable / bookmarkable and the legacy redirects can target a tab.
 */
import { useSearchParams } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { TabPills } from "../components/ui";
import StaffHoursPage from "./StaffHoursPage";
import TimeRegistrationPage from "./TimeRegistrationPage";
import StaffTipsPage from "./StaffTipsPage";
import StaffPayrollPage from "./StaffPayrollPage";

const VALID_TABS = ["hours", "time", "tips", "payroll"];

export default function StaffBackOfficePage() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = searchParams.get("tab");
  const activeTab = VALID_TABS.includes(raw) ? raw : "hours";

  const setTab = (id) => {
    // Replace (not push) so the tab switch doesn't pile up history entries —
    // the back button should leave Staff, not step through its tabs.
    setSearchParams({ tab: id }, { replace: true });
  };

  const tabs = [
    { id: "hours", label: t("staffHours") },        // Timer / Hours
    { id: "time", label: t("staffTimeReg") },       // Tidsregistrering
    { id: "tips", label: t("staffTips") },          // Drikkepenge / Tips
    { id: "payroll", label: t("staffPayroll") },    // Løn (DK lock, EN too)
  ];

  return (
    <div>
      {/* Tab row — matches the child pages' top gutters (px-4 sm:px-6) so the
          pills line up with the page content below. */}
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="max-w-5xl mx-auto">
          <TabPills
            tabs={tabs}
            activeId={activeTab}
            onChange={setTab}
            ariaLabel={t("staffBackOffice")}
          />
        </div>
      </div>
      {/* The unchanged underlying page for the active tab. Each owns its own
          header/cards/tier behavior. */}
      {activeTab === "hours" && <StaffHoursPage />}
      {activeTab === "time" && <TimeRegistrationPage />}
      {activeTab === "tips" && <StaffTipsPage />}
      {activeTab === "payroll" && <StaffPayrollPage />}
    </div>
  );
}
