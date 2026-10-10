/**
 * BranchSelector — dropdown to pick active branch for data entry.
 *
 * Usage in any page:
 *   import BranchSelector, { useBranch } from "../components/BranchSelector";
 *
 *   const { branchId } = useBranch();
 *   // pass branchId when logging sales/expenses/etc
 *
 *   <BranchSelector />  // renders the dropdown
 */

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";

const BTYPE_ICONS = {
  restaurant: "🍽️",
  workshop: "🔧",
  retail: "🛒",
  service: "💼",
  general: "🏢",
};

const BranchContext = createContext({
  branches: [],
  branchId: null,
  branchName: "All",
  branchType: null,       // active branch's business_type (null = all)
  businessTypes: [],      // unique types across all branches
  setBranchId: () => {},
  loading: false,
  hasBranches: false,
});

export function BranchProvider({ children }) {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(() => localStorage.getItem("bonbox_branch") || null);
  const [loading, setLoading] = useState(false);

  const fetchBranches = useCallback(async () => {
    // Only fetch if user is logged in (token exists)
    const token = localStorage.getItem("token");
    if (!token) {
      setBranches([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get("/branches/list");
      setBranches(res.data.branches || []);
    } catch { /* silent — user may not have branches */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchBranches(); }, [fetchBranches]);

  // R-c round 2 fix-up (CMS-1) — the branch picked is the signed-in
  // account's own, or none. It is kept on the phone (bonbox_branch) and
  // survived sign-out: the next account's Daily close filed every close
  // under the previous account's branch — refused by the server since R-c
  // (403 branch_not_owned), so nothing of theirs was saved, and an account
  // with no branches has no picker to get out of it. Another account (or
  // signed out): the pick is let go of. Signed in: the account's branches are
  // read, and a pick that is not among them is let go of — only once the list
  // has really loaded (a failed read never re-files closes with no branch).
  // (Read for every session — the picker's own list above is read on the
  // native app only, as before.)
  // (Inside AuthProvider, as its sibling providers — App.jsx.)
  const { user } = useAuth();
  const userId = user?.id != null ? String(user.id) : null;
  const [shownFor, setShownFor] = useState(userId);
  if (shownFor !== userId) {
    // (Set while rendering, from the account before: React's way to reset
    // state when an input changes.)
    setShownFor(userId);
    if (shownFor) {
      setBranchId(null);
      setBranches([]);
    }
  }
  useEffect(() => {
    if (!userId) return undefined;
    let gone = false;
    (async () => {
      try {
        const res = await api.get("/branches/list", { _noRetry: true });
        const list = res?.data?.branches;
        if (gone || !Array.isArray(list)) return;
        setBranchId((cur) => (cur && !list.some((b) => String(b?.id) === String(cur)) ? null : cur));
      } catch { /* not known: the pick stays */ }
    })();
    return () => { gone = true; };
  }, [userId]);

  useEffect(() => {
    if (branchId) {
      localStorage.setItem("bonbox_branch", branchId);
    } else {
      localStorage.removeItem("bonbox_branch");
    }
  }, [branchId]);

  const activeBranch = branchId ? branches.find(b => b.id === branchId) : null;
  const branchName = activeBranch?.name || "All Branches";
  const branchType = activeBranch?.business_type || null;
  const businessTypes = [...new Set(branches.map(b => b.business_type || "general"))];

  return (
    <BranchContext.Provider value={{
      branches, branchId, branchName, branchType, businessTypes,
      setBranchId, loading,
      hasBranches: branches.length > 0,
      refresh: fetchBranches,
    }}>
      {children}
    </BranchContext.Provider>
  );
}

export function useBranch() {
  return useContext(BranchContext);
}

export default function BranchSelector({ compact = false }) {
  const { branches, branchId, setBranchId, hasBranches, loading } = useBranch();
  const { t } = useLanguage();

  if (loading || !hasBranches) return null;

  if (compact) {
    return (
      <select
        value={branchId || ""}
        onChange={(e) => setBranchId(e.target.value || null)}
        className="text-xs px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-700 bg-white dark:text-gray-200"
      >
        <option value="">{t("bselAllBranches", "All Branches")}</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{BTYPE_ICONS[b.business_type] || "🏢"} {b.name}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 dark:text-gray-400">🏢</span>
      <select
        value={branchId || ""}
        onChange={(e) => setBranchId(e.target.value || null)}
        className="text-sm px-3 py-1.5 rounded-xl border border-gray-300 dark:border-gray-600 dark:bg-gray-700 bg-white dark:text-gray-200 font-medium"
      >
        <option value="">{t("bselAllBranches", "All Branches")}</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {BTYPE_ICONS[b.business_type] || "🏢"} {b.name} {b.is_default ? t("bselDefaultParen", "(Default)") : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
