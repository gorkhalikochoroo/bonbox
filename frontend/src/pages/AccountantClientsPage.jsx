import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";

/**
 * Client picker for accountant sessions.
 *
 * Drives the "which client am I working on?" UX:
 *   • Lands here after login when there are 2+ active grants
 *   • Tapping a card POSTs to /accountants/switch-client/{owner_id}
 *     which sets the bonbox_acct_client cookie + writes an audit row
 *   • After the switch, all subsequent /api/* requests resolve to that
 *     owner's data via the get_current_user delegation
 *
 * Security:
 *   • Server-side checks: only active grants for this accountant return
 *   • Switching to a non-granted client → 403 (frontend never hits it
 *     because we filter the picker, but defense-in-depth)
 *   • Picker shows status (active only) — pending/revoked grants are
 *     filtered server-side
 */
export default function AccountantClientsPage() {
  const { user, logout } = useAuth() || {};
  const navigate = useNavigate();
  const [clients, setClients] = useState(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(null);

  useEffect(() => {
    api
      .get("/accountants/clients")
      .then((res) => {
        const list = res.data || [];
        setClients(list);
        // Auto-redirect when there's exactly one client (the backend
        // already auto-selects them via get_current_user, but routing
        // straight to /dashboard is a better UX).
        if (list.length === 1) {
          handlePick(list[0].owner_user_id);
        }
      })
      .catch((err) => {
        setError(
          err?.response?.data?.detail?.message ||
            "Could not load your client list. Try refreshing."
        );
      });
  }, []);

  const handlePick = async (ownerId) => {
    setSwitching(ownerId);
    try {
      await api.post(`/accountants/switch-client/${ownerId}`);
      window.location.href = "/dashboard";
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message ||
          "Could not switch client. Try again."
      );
      setSwitching(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-900 px-4 py-12">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              Choose a client
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              Signed in as <strong>{user?.email}</strong> · read-only access
            </p>
          </div>
          <button
            onClick={() => logout?.()}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
          >
            Sign out
          </button>
        </div>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 text-sm mb-4">
            {error}
          </div>
        )}

        {clients === null && (
          <div className="text-center text-gray-500 dark:text-gray-400 py-12">
            Loading your clients…
          </div>
        )}

        {clients && clients.length === 0 && (
          <div className="bg-white dark:bg-gray-800 border border-stone-200 dark:border-stone-700 rounded-xl p-8 text-center">
            <p className="text-gray-700 dark:text-gray-200 mb-2">No active client grants.</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Ask one of your client businesses to invite you from their BonBox
              Profile → Revisor access.
            </p>
          </div>
        )}

        {clients && clients.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {clients.map((c) => (
              <button
                key={c.owner_user_id}
                onClick={() => handlePick(c.owner_user_id)}
                disabled={!!switching}
                className="text-left bg-white dark:bg-gray-800 border border-stone-200 dark:border-stone-700 rounded-xl p-5 hover:border-green-500 hover:shadow-sm transition disabled:opacity-60"
              >
                <div className="text-base font-semibold text-gray-900 dark:text-white mb-1 truncate">
                  {c.business_name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {c.currency || "DKK"} ·{" "}
                  {c.last_visited_at
                    ? `Last opened ${new Date(c.last_visited_at).toLocaleDateString()}`
                    : "Never opened"}
                </div>
                {switching === c.owner_user_id && (
                  <div className="text-xs text-green-700 dark:text-green-300 mt-2">
                    Opening…
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
