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
 *
 * WAGE GATE (18 Sep 2026). Drikkepenge and Løn are dropped from the strip for a
 * delegated seat and for a curtained shared device — the server denies every
 * read behind both, so the tabs could only ever render an empty state that
 * either lies ("no tips") or looks broken (a period picker above nothing). A
 * deep link into a dropped tab gets WagePrivacyNotice instead of the page, so
 * the denied fetch never fires. See WAGE_TABS below.
 */
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { useLanguage } from "../hooks/useLanguage";
import { isStaffMemberRole } from "../config/navManifest";
import { TabPills } from "../components/ui";
import WagePrivacyNotice from "../components/WagePrivacyNotice";
import StaffHoursPage from "./StaffHoursPage";
import TimeRegistrationPage from "./TimeRegistrationPage";
import StaffTipsPage from "./StaffTipsPage";
import StaffPayrollPage from "./StaffPayrollPage";

const VALID_TABS = ["hours", "time", "tips", "payroll"];

// The two tabs that are money end to end. Both now 403 for a delegated seat and
// for a curtained shared device: /api/staff/tips is denied outright, and the
// Løn tab's three reads (/payroll/estimate, /payroll/csv, /payroll/loenseddel)
// are all owner-only since the estimate carve-out closed (18 Sep 2026).
//
// Denying the endpoint without touching the tab is how a rule starts reading as
// a bug. StaffTipsPage catches its 403 into an empty history and then renders
// "no tips" over a real one — a screen that states a falsehood — and the Løn
// tab renders a period picker above nothing. A tab that cannot answer anything
// should not be in the strip.
//
// Timer and Tidsregistrering stay: their wage FIELDS arrive null (redacted
// server-side) while the hours, the clock-ins and the exception feed — the
// things a manager actually runs a shift on — still work.
const WAGE_TABS = ["tips", "payroll"];

export default function StaffBackOfficePage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Same expression the sidebar, the More grid, ⌘K and the schedule use for
  // owner-financial gating (Layout.jsx / MorePage.jsx): a delegated seat, OR
  // the owner's own session on a shared device whose curtain is still up.
  // Copied rather than abstracted because that is how the other five call
  // sites read today; one shared helper across all six is a follow-up, not a
  // thing to invent in the middle of a security change.
  //
  // `ready` matters: enabled/locked both default to FALSE until
  // /auth/device-pin/status answers, so on a hard refresh at ?tab=payroll the
  // curtain had not landed yet, the tab was not yet hidden, StaffPayrollPage
  // mounted and fired the owner-only read before the answer arrived. Role
  // seats were never exposed to that (ProtectedRoute holds render until the
  // user resolves); the shared-device population was. Hold the strip until the
  // signal is settled and compute the tab set once, from facts.
  const { ready: devReady, enabled: devShared, locked: devLocked } = useDeviceShare();
  const curtained = devShared && devLocked;
  const wagesHidden = isStaffMemberRole(user?.role) || curtained;

  const raw = searchParams.get("tab");
  const activeTab = VALID_TABS.includes(raw) ? raw : "hours";
  // A deep link (bookmark, ⌘K, an old /staff/tips redirect) can still land on a
  // hidden tab. Don't silently bounce them to Timer — a redirect with no
  // explanation is the same dead end in a different shape. Say why.
  const blocked = wagesHidden && WAGE_TABS.includes(activeTab);

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
  ].filter((tab) => !(wagesHidden && WAGE_TABS.includes(tab.id)));

  // A skeleton, not the page: mounting the child and unmounting it a beat later
  // is the bug, not the fix for it. One short frame of grey is the honest
  // rendering of "we do not yet know what this seat may see".
  if (!devReady) {
    return (
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="max-w-5xl mx-auto">
          <div className="h-9 w-72 bg-gray-100 dark:bg-gray-800 rounded-full animate-pulse" />
        </div>
      </div>
    );
  }

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
          header/cards/tier behavior. A blocked tab does NOT mount its page —
          the point is that the denied fetch never fires, so there is no empty
          state to misread while it fails. */}
      {blocked ? (
        <div className="px-4 sm:px-6 pt-4 sm:pt-6">
          <div className="max-w-5xl mx-auto">
            {/* WHY it is blocked decides what the card may honestly say. A
                curtained owner is not blocked by their role and must not be
                told to go ask themselves — they get the PIN. */}
            <WagePrivacyNotice
              reason={curtained && !isStaffMemberRole(user?.role) ? "curtain" : "role"}
              actionLabel={t("staffHours")}
              onAction={() => setTab("hours")}
            />
          </div>
        </div>
      ) : (
        <>
          {activeTab === "hours" && <StaffHoursPage />}
          {activeTab === "time" && <TimeRegistrationPage />}
          {activeTab === "tips" && <StaffTipsPage />}
          {activeTab === "payroll" && <StaffPayrollPage />}
        </>
      )}
    </div>
  );
}
