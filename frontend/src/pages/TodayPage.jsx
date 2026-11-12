/**
 * TodayPage — what /dashboard renders since the Nov 2026 "I dag" redesign.
 *
 * The owner gets the I dag page (components/today/TodayDashboard.jsx). Every
 * other caller keeps the previous Home (pages/DashboardPage.jsx, also on
 * /home for owners, "Fuldt overblik") exactly as it was:
 *   • the revisor's read-only view and invited staff seats — /api/today is
 *     owner-only (main.py member read guard), and their Home is curated;
 *   • a locked shared device — same reason, the curtain lives on the old Home;
 *   • a personal-mode account;
 *   • a FRESH account with nothing to show yet — the old Home carries the
 *     first-run checklist and the demo seeder, which I dag does not duplicate;
 *   • and whenever /api/today cannot answer (an older backend without the
 *     route, a 403, the network): never a blank page, never a half page.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { isStaffMemberRole } from "../config/navManifest";
import api from "../services/api";
import { peekGet } from "../lib/swrCache";
import TodayDashboard from "../components/today/TodayDashboard";
import { isFreshAccount } from "../components/today/todayModel";
import "../components/today/houseFonts";

const DashboardPage = lazy(() => import("./DashboardPage"));

function Legacy() {
  return (
    <Suspense fallback={<TodaySkeleton />}>
      <DashboardPage />
    </Suspense>
  );
}

function TodaySkeleton() {
  return (
    <div className="td-page" aria-busy="true">
      <div className="td-wrap">
        <div style={{ height: 96 }} />
        <div className="td-hero" style={{ minHeight: 220, opacity: 0.92 }} />
        <div className="td-card" style={{ minHeight: 280 }} />
      </div>
    </div>
  );
}

export default function TodayPage() {
  const { user } = useAuth();
  const { enabled: shared, locked } = useDeviceShare();
  const role = String(user?.role || "owner").toLowerCase();
  const legacyByRole =
    !user ||
    role === "accountant" ||
    isStaffMemberRole(role) ||
    String(user?.business_type || "").toLowerCase() === "personal" ||
    (shared && locked);

  const [first, setFirst] = useState(() => (legacyByRole ? null : peekGet("/today") || null));
  const [state, setState] = useState(() => (legacyByRole ? "legacy" : first ? "ok" : "loading"));

  useEffect(() => {
    if (legacyByRole) return undefined;
    let cancelled = false;
    api.get("/today")
      .then((res) => {
        if (cancelled) return;
        const body = res?.data;
        if (!body || typeof body !== "object" || !body.business_day) {
          setState("legacy");
          return;
        }
        setFirst(body);
        setState(isFreshAccount(body) ? "legacy" : "ok");
      })
      .catch(() => {
        if (!cancelled) setState((s) => (s === "ok" ? "ok" : "legacy"));
      });
    return () => { cancelled = true; };
  }, [legacyByRole]);

  // Once on I dag the page stays I dag for the visit: a later refresh never
  // flips it back to the old Home mid-look.
  if (legacyByRole || state === "legacy") return <Legacy />;
  if (state === "loading" || !first) return <TodaySkeleton />;
  return <TodayDashboard initial={first} />;
}
