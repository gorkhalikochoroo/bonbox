/**
 * The door screen as its own small app (R11, rubric B11): stand.html →
 * stand/main.jsx → here. Vercel, `vite` and `vite preview` serve stand.html
 * for /stand and /stand/<token> (vercel.json, scripts/standBuild.mjs
 * standHtml); the owner app keeps its own /stand routes as before (the
 * Capacitor app, and any in-app hop).
 *
 * Only what a paired door device uses: the language, confirm and toast
 * layers, the live alerts (the 20-second check, the chimes, the toasts), the
 * pairing page and the book. No route table of ~100 owner pages, no session
 * check, no entitlements, pillars, activation, branches or cookie banner: a
 * door device has no session, and with no banner it never has analytics
 * consent, so it never logs (stand/standEventLog.js).
 *
 * Any other address the book links to (an owner page) is the owner app's:
 * a full page load, never a blank screen here.
 */
import { Component, Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { LanguageProvider, detectInitialLanguage } from "../hooks/useLanguage";
import { AuthProvider } from "../hooks/useAuth";
import { ConfirmProvider } from "../hooks/useConfirm";
import { ToastProvider } from "../hooks/useToast";
import { LiveAlertsProvider } from "../hooks/useLiveAlerts";
import { useThemeColorSync } from "../hooks/useThemeColorSync";
import { reportClientError } from "../utils/reportClientError";
import Button from "../components/ui/Button";
import ReservationsPage from "../pages/ReservationsPage";

// The code page is the door screen's FIRST visit only (and "Enter a new
// code"): its own small chunk, so tonight's book never downloads it.
const StandPairPage = lazy(() => import("../pages/StandPairPage"));

// The crash screen cannot call t(): it catches the providers themselves.
const CRASH = {
  en: { title: "Something went wrong", body: "It is usually the connection. Reloading brings the book back.", reload: "Reload the page" },
  da: { title: "Noget gik galt", body: "Det skyldes som regel forbindelsen. Hent siden igen, så er bogen tilbage.", reload: "Hent siden igen" },
};
const crashCopy = () => {
  try {
    return detectInitialLanguage().lang === "da" ? CRASH.da : CRASH.en;
  } catch {
    return CRASH.en;
  }
};
const isChunkError = (err) => {
  const m = (err && err.message) || "";
  return (err && err.name === "ChunkLoadError") || /Loading (CSS )?chunk|dynamically imported|Importing a module script failed|valid JavaScript MIME type/.test(m);
};

/** A crash on the door screen: reported, a stale-deploy chunk reloads itself
 *  (twice at most), anything else gets one calm screen with Reload. */
export class StandErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err) {
    const chunk = isChunkError(err);
    try {
      reportClientError({ kind: chunk ? "chunk_load" : "render", message: (err && err.message) || String(err) });
    } catch {
      /* best effort */
    }
    if (!chunk) return;
    try {
      const n = parseInt(sessionStorage.getItem("error_retry_count") || "0", 10);
      if (n < 2) {
        sessionStorage.setItem("error_retry_count", String(n + 1));
        window.location.reload();
      }
      setTimeout(() => { try { sessionStorage.removeItem("error_retry_count"); } catch { /* ignore */ } }, 60000);
    } catch {
      /* storage blocked: the screen below */
    }
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    const copy = crashCopy();
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-900 px-4" data-stand-crash="">
        <div className="text-center max-w-md">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gray-100 dark:bg-[rgb(var(--surface-subtle))] text-gray-400 dark:text-gray-500">
            <AlertTriangle className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </div>
          <h1 className="text-[21px] font-semibold leading-tight text-gray-900 dark:text-gray-100 mb-2">{copy.title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{copy.body}</p>
          <Button size="lg" onClick={() => window.location.reload()}>{copy.reload}</Button>
        </div>
      </div>
    );
  }
}

/** An address that is not the door screen's: the owner app, by a full load.
 *  Anything under /stand stays here (a full load would only come back). */
function OwnerAppAddress() {
  const { pathname, search, hash } = useLocation();
  const ours = /^\/stand(\/|$)/.test(pathname);
  useEffect(() => {
    if (!ours) window.location.replace(pathname + search + hash);
  }, [ours, pathname, search, hash]);
  return ours ? <Suspense fallback={null}><StandPairPage /></Suspense> : null;
}

function ThemeColorSync() {
  useThemeColorSync();
  return null;
}

export function StandRoutes() {
  return (
    <Routes>
      <Route path="/stand" element={<Suspense fallback={null}><StandPairPage /></Suspense>} />
      <Route path="/stand/:standToken" element={<ReservationsPage />} />
      <Route path="*" element={<OwnerAppAddress />} />
    </Routes>
  );
}

export default function StandApp() {
  return (
    <StandErrorBoundary>
      <BrowserRouter>
        <ThemeColorSync />
        <LanguageProvider>
          <ConfirmProvider>
            <ToastProvider>
              <AuthProvider>
                <LiveAlertsProvider>
                  <StandRoutes />
                </LiveAlertsProvider>
              </AuthProvider>
            </ToastProvider>
          </ConfirmProvider>
        </LanguageProvider>
      </BrowserRouter>
    </StandErrorBoundary>
  );
}
