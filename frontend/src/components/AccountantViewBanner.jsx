import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";

/**
 * Sticky top banner shown when the authenticated user is an accountant
 * (role === "accountant"). The owner's business_name comes back from
 * the /auth/me endpoint, BUT through the delegation we get the OWNER
 * user back — so we look up the original accountant identity via
 * /accountants/grants where we filter to the currently-active grant.
 *
 * For simplicity, the banner reads from /accountants/clients and
 * matches the current logged-in user.id (which IS the delegated owner)
 * against the client list to pick the active client name.
 *
 * If the accountant has >1 grant, the banner exposes a "Switch client"
 * link to /accountant/clients.
 */
export default function AccountantViewBanner() {
  const { user, logout } = useAuth() || {};
  const [clients, setClients] = useState([]);
  const [currentName, setCurrentName] = useState(null);

  useEffect(() => {
    if (!user) return;
    if (user.role !== "accountant") return;
    api
      .get("/accountants/clients")
      .then((res) => {
        const list = res.data || [];
        setClients(list);
        // The delegation returns the OWNER as the "current user", so
        // user.id at this point is the owner's id. Match it against
        // the client list to surface the active client's name.
        const match = list.find((c) => String(c.owner_user_id) === String(user.id));
        if (match) setCurrentName(match.business_name);
      })
      .catch(() => {});
  }, [user]);

  if (!user || user.role !== "accountant") return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-30 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 px-4 py-2"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-amber-900 dark:text-amber-200 min-w-0 flex-1">
          <span className="font-medium">
            {currentName ? `Viewing ${currentName}` : "Accountant view"}
          </span>
          <span className="opacity-80"> · read only</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {clients.length > 1 && (
            <Link
              to="/accountant/clients"
              className="text-amber-900 dark:text-amber-200 hover:underline font-medium"
            >
              Switch client
            </Link>
          )}
          <button
            onClick={() => logout?.()}
            className="text-amber-900 dark:text-amber-200 hover:underline"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
