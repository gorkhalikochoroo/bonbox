import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";

const ROLE_COLORS = {
  owner: "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400",
  manager: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
  cashier: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400",
  viewer: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400",
};

const ROLE_DESCRIPTIONS = {
  owner: "Full access to everything",
  manager: "Sales, expenses, inventory, reports, cashbook, budgets, waste",
  cashier: "Sales and cashbook only",
  viewer: "View reports only",
};

export default function TeamPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [members, setMembers] = useState([]);
  const [permissions, setPermissions] = useState(null);
  const [loading, setLoading] = useState(true);

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("cashier");
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  const [error, setError] = useState("");

  // Fetch team
  useEffect(() => {
    Promise.all([
      api.get("/team/members"),
      api.get("/team/permissions"),
    ]).then(([memRes, permRes]) => {
      setMembers(memRes.data);
      setPermissions(permRes.data);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const isOwner = permissions?.is_owner;

  const handleInvite = async () => {
    if (!email.trim()) return;
    setInviting(true);
    setError("");
    try {
      const res = await api.post("/team/invite", { email: email.trim(), role, name: name.trim() });
      setInviteResult(res.data);
      // Refresh members
      const memRes = await api.get("/team/members");
      setMembers(memRes.data);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to invite");
    }
    setInviting(false);
  };

  const changeRole = async (memberId, newRole) => {
    try {
      await api.patch(`/team/${memberId}/role`, { role: newRole });
      setMembers((prev) => prev.map((m) => m.id === memberId ? { ...m, role: newRole } : m));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update role");
    }
  };

  const removeMember = async (memberId) => {
    if (!confirm("Remove this team member? They will lose access to your business data.")) return;
    try {
      await api.delete(`/team/${memberId}`);
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to remove");
    }
  };

  const resetInvite = () => {
    setShowInvite(false);
    setEmail("");
    setName("");
    setRole("cashier");
    setInviteResult(null);
    setError("");
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[900px] mx-auto">
      <FadeIn>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("team") || "Team"}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Manage who has access to your business on BonBox
            </p>
          </div>
          {isOwner && (
            <button
              onClick={() => setShowInvite(!showInvite)}
              className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition"
            >
              + Invite Staff
            </button>
          )}
        </div>
      </FadeIn>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Your role card */}
      {permissions && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center text-lg">
                {isOwner ? "👑" : "👤"}
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-800 dark:text-white">
                  Your role: <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${ROLE_COLORS[permissions.role]}`}>{permissions.role}</span>
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{ROLE_DESCRIPTIONS[permissions.role]}</p>
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Invite form */}
      {showInvite && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm space-y-4">
            <h3 className="text-base font-semibold text-gray-700 dark:text-gray-300">Invite a team member</h3>

            {inviteResult ? (
              <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 space-y-2">
                <p className="text-sm font-semibold text-green-700 dark:text-green-400">Invitation sent!</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">Share these credentials with {inviteResult.email}:</p>
                <div className="bg-white dark:bg-gray-700 rounded-lg p-3 text-sm font-mono space-y-1">
                  <p className="text-gray-800 dark:text-gray-200">Email: <strong>{inviteResult.email}</strong></p>
                  <p className="text-gray-800 dark:text-gray-200">Password: <strong>{inviteResult.temp_password}</strong></p>
                  <p className="text-gray-800 dark:text-gray-200">Role: <strong>{inviteResult.role}</strong></p>
                </div>
                <p className="text-xs text-gray-400">They should change their password after first login.</p>
                <button onClick={resetInvite} className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition">
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email address"
                    className="px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                  />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name (optional)"
                    className="px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 mb-1.5 block">Role</label>
                  <div className="flex gap-2">
                    {["manager", "cashier", "viewer"].map((r) => (
                      <button
                        key={r}
                        onClick={() => setRole(r)}
                        className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-medium border transition ${
                          role === r
                            ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400"
                            : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                        }`}
                      >
                        <span className="block capitalize">{r}</span>
                        <span className="block text-[10px] mt-0.5 opacity-60">{ROLE_DESCRIPTIONS[r]}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={handleInvite}
                  disabled={!email.trim() || inviting}
                  className="w-full py-2.5 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 disabled:opacity-40 transition"
                >
                  {inviting ? "Inviting..." : "Send Invite"}
                </button>
              </>
            )}
          </div>
        </FadeIn>
      )}

      {/* Team members list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
        </div>
      ) : members.length > 0 ? (
        <FadeIn>
          <div className="space-y-3">
            {members.map((m) => (
              <div key={m.id} className="bg-white dark:bg-gray-800 rounded-2xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg bg-gray-100 dark:bg-gray-700">
                  {m.role === "owner" ? "👑" : m.role === "manager" ? "📋" : m.role === "cashier" ? "💰" : "👁"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 dark:text-white truncate">{m.business_name || m.email}</p>
                  <p className="text-xs text-gray-400 truncate">{m.email}</p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-bold capitalize ${ROLE_COLORS[m.role]}`}>
                  {m.role}
                </span>
                {isOwner && m.role !== "owner" && (
                  <div className="flex items-center gap-1">
                    <select
                      value={m.role}
                      onChange={(e) => changeRole(m.id, e.target.value)}
                      className="px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-xs text-gray-700 dark:text-gray-300"
                    >
                      <option value="manager">Manager</option>
                      <option value="cashier">Cashier</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      onClick={() => removeMember(m.id)}
                      className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                      title="Remove"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </FadeIn>
      ) : (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-10 border border-gray-100 dark:border-gray-700 text-center">
            <div className="text-4xl mb-3">👥</div>
            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">Just you for now</h3>
            <p className="text-sm text-gray-400 mb-4">Invite staff members to give them limited access to your BonBox.</p>
            {isOwner && (
              <button
                onClick={() => setShowInvite(true)}
                className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition"
              >
                + Invite Staff
              </button>
            )}
          </div>
        </FadeIn>
      )}

      {/* Role reference */}
      <FadeIn>
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Role Permissions</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.entries(ROLE_DESCRIPTIONS).map(([r, desc]) => (
              <div key={r} className="flex items-start gap-2 p-2 rounded-lg">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize mt-0.5 ${ROLE_COLORS[r]}`}>{r}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
