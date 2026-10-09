import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import ClaimQuestion from "../components/ClaimQuestion";

/**
 * /login/claim?token=<ticket>&answer=keep|secure — where the two links in the
 * notice mail land ("Har du selv oprettet denne BonBox-konto …?", backend
 * services/claim_decision.py, Manoj 8 Oct).
 *
 * Opening the link changes NOTHING: mail scanners open links, so the page
 * reads the ticket's state (POST /auth/claim-decision/status, read-only) and
 * asks once more; only a tap answers (POST /auth/claim-decision). The answer
 * from the link is drawn as the primary button, the other one is still there.
 *
 * A mail link signs nobody in. After "secure" every device is signed out and
 * the owner chooses a new password (/forgot-password) or uses a login link.
 */
export default function ClaimDecisionPage() {
  const [searchParams] = useSearchParams();
  const ticket = searchParams.get("token") || "";
  const preferred = searchParams.get("answer") === "keep" ? "keep"
    : searchParams.get("answer") === "secure" ? "secure" : "";
  const { t } = useLanguage();

  // loading | open | kept | secured | expired | decided | invalid | loadFailed
  const [state, setState] = useState("loading");
  const [createdAt, setCreatedAt] = useState("");
  // Opened by a password reset: the owner just chose the current password,
  // so the question names the first one (as the mail does).
  const [afterReset, setAfterReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accessClosed, setAccessClosed] = useState(false);

  useEffect(() => {
    if (!ticket || ticket.length < 43) {
      setState("invalid");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.post("/auth/claim-decision/status", { ticket });
        if (cancelled) return;
        setCreatedAt(res?.data?.question?.created_at || "");
        setAfterReset(res?.data?.question?.after_reset === true);
        const s = res?.data?.state;
        setState(s === "open" ? "open" : s === "expired" ? "expired" : s === "decided" ? "decided" : "invalid");
      } catch (err) {
        if (cancelled) return;
        // Unknown ticket → invalid; anything else (offline, rate limit) is
        // not the link's fault — say so instead of calling it invalid.
        setState(err?.response?.status === 404 ? "invalid" : "loadFailed");
      }
    })();
    return () => { cancelled = true; };
    // One read per page-load; the ticket comes from the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = async (choice) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/auth/claim-decision", { ticket, answer: choice });
      setAccessClosed(!!res?.data?.access_closed);
      setState(choice === "keep" ? "kept" : "secured");
    } catch (err) {
      const status = err?.response?.status;
      if (status === 410) setState("expired");
      else if (status === 409) setState("decided");
      else if (status === 404) setState("invalid");
      else setError(t("claimFailed"));
    } finally {
      setBusy(false);
    }
  };

  const headline = {
    loading: "",
    open: t("claimMailTitle"),
    kept: t("claimKeptTitle"),
    secured: t("claimSecuredTitle"),
    expired: t("claimExpired"),
    decided: t("claimDecided"),
    invalid: t("magicLinkInvalid"),
    loadFailed: t("claimLoadFailed"),
  }[state];

  const primaryBtn = "inline-block bg-[#22c55e] hover:bg-[#16a34a] text-white px-5 py-2.5 rounded-lg text-[14px] font-medium transition";

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md bg-white border border-gray-200 rounded-xl shadow-sm p-7 text-center">
        <div className="flex justify-center mb-5">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-[#22c55e]">
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2.2"/>
              <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
        </div>

        {state === "loading" && (
          <div className="flex justify-center mb-2" aria-busy="true">
            <svg className="animate-spin h-7 w-7 text-emerald-600" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        )}

        {headline && (
          <h1 className="text-[20px] font-semibold text-gray-900 tracking-tight">{headline}</h1>
        )}

        {state === "open" && (
          <ClaimQuestion
            createdAt={createdAt}
            onAnswer={answer}
            busy={busy}
            error={error}
            preferred={preferred}
            // After a reset, "Nej / Ved ikke" ends the password just chosen
            // with the code too — said before the tap (release gate, 9 Oct).
            explainKey={afterReset ? "claimMailExplainAfterReset" : "claimMailExplain"}
            textKey={afterReset ? "claimQuestionTextAfterReset" : "claimQuestionText"}
          />
        )}

        {state === "kept" && (
          <div className="mt-6" data-testid="claim-kept">
            <Link to="/dashboard" className={primaryBtn}>{t("magicLinkClaimedContinue")}</Link>
          </div>
        )}

        {state === "secured" && (
          <div className="mt-3" data-testid="claim-secured">
            <p className="text-[14px] text-gray-500 leading-relaxed">{t(afterReset ? "claimSecuredMailBodyAfterReset" : "claimSecuredMailBody")}</p>
            {accessClosed && (
              <p className="text-[14px] text-gray-500 leading-relaxed mt-3">{t("magicLinkClaimedAccessClosed")}</p>
            )}
            <div className="mt-5">
              <Link to="/forgot-password" className={primaryBtn}>{t("magicLinkClaimedSetPassword")}</Link>
            </div>
            <p className="text-[13px] text-gray-500 mt-4">
              <Link to="/login" className="underline underline-offset-2 hover:text-gray-800">
                {t("claimSignInWithLink")}
              </Link>
            </p>
          </div>
        )}

        {(state === "expired" || state === "invalid") && (
          <div className="mt-6">
            <Link to="/login" className={primaryBtn}>{t("magicLinkRetry")}</Link>
          </div>
        )}

        {state === "loadFailed" && (
          <div className="mt-6">
            <button type="button" onClick={() => window.location.reload()} className={primaryBtn}>
              {t("tryAgain")}
            </button>
          </div>
        )}

        {state === "decided" && (
          <div className="mt-6">
            <Link to="/dashboard" className={primaryBtn}>{t("magicLinkClaimedContinue")}</Link>
          </div>
        )}
      </div>
    </div>
  );
}
