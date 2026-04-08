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

const BranchContext = createContext({
  branches: [],
  branchId: null,
  branchName: "All",
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

  useEffect(() => {
    if (branchId) {
      localStorage.setItem("bonbox_branch", branchId);
    } else {
      localStorage.removeItem("bonbox_branch");
    }
  }, [branchId]);

  const branchName = branchId
    ? branches.find(b => b.id === branchId)?.name || "Branch"
    : "All Branches";

  return (
    <BranchContext.Provider value={{
      branches, branchId, branchName,
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

  if (loading || !hasBranches) return null;

  if (compact) {
    return (
      <select
        value={branchId || ""}
        onChange={(e) => setBranchId(e.target.value || null)}
        className="text-xs px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-700 bg-white dark:text-gray-200"
      >
        <option value="">All Branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
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
        <option value="">All Branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} {b.is_default ? "(Default)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
