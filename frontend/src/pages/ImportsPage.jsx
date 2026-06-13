/**
 * ImportsPage — C5 nav diet (Imports merge).
 *
 * Before this, /bank-import and /payment-imports were two sidebar entries for
 * what an owner thinks of as one job: "get my transactions into BonBox". This
 * thin wrapper collapses them into a SINGLE 'Imports' destination with a
 * TabPills switcher (Bank · Payments). The two underlying pages are unchanged
 * and still mounted — we just render the chosen one beneath the tab row.
 *
 * The legacy /bank-import and /payment-imports routes stay registered (App.jsx)
 * but now <Navigate replace> here with the matching ?tab, so old bookmarks,
 * deep links, and the Connections page's internal links still land correctly.
 *
 * Layout note: BOTH child pages already bring their own page gutters/max-width
 * (BankImportPage wraps in `p-4 sm:p-6 … max-w-[1200px] mx-auto`;
 * PaymentImportsPage renders its own <PageShell>). So this wrapper deliberately
 * does NOT add another PageShell — that would double the gutters. The tab row
 * is rendered in a matching-gutter strip above the child instead.
 *
 * The active tab is reflected in the URL (?tab=bank|payments) so it's
 * shareable / bookmarkable and the legacy redirects can target a tab.
 */
import { useSearchParams } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { TabPills } from "../components/ui";
import BankImportPage from "./BankImportPage";
import PaymentImportsPage from "./PaymentImportsPage";

const VALID_TABS = ["bank", "payments"];

export default function ImportsPage() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = searchParams.get("tab");
  const activeTab = VALID_TABS.includes(raw) ? raw : "bank";

  const setTab = (id) => {
    // Replace (not push) so the tab switch doesn't pile up history entries —
    // the back button should leave Imports, not step through its tabs.
    setSearchParams({ tab: id }, { replace: true });
  };

  const tabs = [
    { id: "bank", label: t("bankImport") },
    { id: "payments", label: t("paymentImports") },
  ];

  return (
    <div>
      {/* Tab row — matches the child pages' top gutters (px-4 sm:px-6) so the
          pills line up with the page content below. pb-0 keeps it tight to
          the child's own top padding. */}
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="max-w-[1200px] mx-auto">
          <TabPills
            tabs={tabs}
            activeId={activeTab}
            onChange={setTab}
            ariaLabel={t("imports")}
          />
        </div>
      </div>
      {/* The unchanged underlying page for the active tab. Each owns its own
          header/cards/tier behavior. Only one mounts at a time so their data
          fetches don't both fire. */}
      {activeTab === "bank" ? <BankImportPage /> : <PaymentImportsPage />}
    </div>
  );
}
