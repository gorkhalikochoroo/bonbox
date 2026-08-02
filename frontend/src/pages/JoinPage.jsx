/**
 * Public "enter your code to connect" page — the typed-code half of the staff
 * invite. The owner reads a 6-character code off their screen; the staffer
 * types it here and lands on their own portal. The tap-link is the other half
 * (it skips this page entirely).
 *
 * No auth: the code IS the credential. The backend hard-rate-limits and returns
 * a generic 404 for any miss, so there's nothing to enumerate here.
 */
import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, KeyRound, Inbox } from "lucide-react";
import portalApi from "../services/portalApi";
import { useLanguage } from "../hooks/useLanguage";
import { errText } from "../utils/errText";
import { haptic } from "../utils/haptics"; // no-op on web; physical buzz in the iOS shell

const CODE_LEN = 6;

export default function JoinPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const inputRef = useRef(null);

  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);

  // Rejected code → make it FEEL wrong: red border + a short shake + the iOS
  // "error" haptic, and re-select the field so a retype replaces it in one go.
  const flagWrong = (msg) => {
    setError(msg);
    haptic.error();
    setShake(true);
    setTimeout(() => setShake(false), 480);
    try { inputRef.current?.focus(); inputRef.current?.select(); } catch { /* noop */ }
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    if (normalized.length < CODE_LEN || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await portalApi.post("/portal/join", { code: normalized });
      const path = res.data?.path;
      if (path && path.startsWith("/s/")) {
        haptic.success();
        navigate(path, { replace: true });
      } else {
        flagWrong(t("joinUnknownCode", "Wrong code — please check it."));
      }
    } catch (err) {
      const status = err?.response?.status;
      let msg;
      if (status === 404) {
        msg = t("joinUnknownCode", "We couldn't find that code. Check it and try again.");
      } else if (!err?.response || err?.code === "ECONNABORTED") {
        // No HTTP response at all = offline or a cold-start timeout (the retry
        // interceptor has already tried twice). Show a calm, honest reason
        // instead of a raw "Network Error" — the server may just be waking up.
        msg = t("joinNoConnection", "No connection — try again.");
      } else {
        msg = errText(err, t("joinError", "Something went wrong. Try again."));
      }
      flagWrong(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    /* v2 treatment. With PINs gone this is genuinely the FIRST screen a staffer
       ever sees, and it was the last one still wearing the blue --brand accent
       while everything behind it had gone dark-and-green. Same surface as the
       Schedule hero: 152deg gradient, radius 22, bloom off the top-right. */
    <div
      className="min-h-[100dvh] text-gray-900 flex items-center justify-center p-6 pt-[max(1.5rem,env(safe-area-inset-top))]"
      style={{ background: "#f5f7fb" }}
    >
      <div className="w-full max-w-xs">
        <div
          className="relative overflow-hidden text-center"
          style={{
            borderRadius: 22,
            padding: "26px 20px 22px",
            background: "linear-gradient(152deg,#1d2a3b 0%,#0f172a 46%,#080e16 100%)",
            boxShadow: "0 24px 46px -26px rgba(4,10,18,.95), inset 0 1px 0 rgba(255,255,255,.13)",
          }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute h-[230px] w-[230px] rounded-full"
            style={{
              top: -90, right: -80,
              background: "radial-gradient(closest-side, rgba(34,197,94,.40), rgba(34,197,94,0))",
            }}
          />
          <div className="relative">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{
                background: "rgba(255,255,255,.08)",
                border: "1px solid rgba(255,255,255,.14)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,.18)",
              }}
            >
              <KeyRound className="w-6 h-6" strokeWidth={2} aria-hidden style={{ color: "#4ade80" }} />
            </div>
            <h1
              className="text-white"
              style={{ font: "700 21px/1.12 var(--font-display)", letterSpacing: "-0.03em" }}
            >
              {t("joinTitle", "Connect to your workplace")}
            </h1>
            <p className="mt-1.5" style={{ font: "400 12.5px/1.45 var(--font-text)", color: "rgba(255,255,255,.55)" }}>
              {t("joinSubtitle", "Enter the 6-character code your manager gave you.")}
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-3.5 rounded-2xl bg-white border border-gray-200/70 card-glossy p-4">
          <label className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5 block">
            {t("joinCodeLabel", "Join code")}
          </label>
          <input
            ref={inputRef}
            value={normalized}
            onChange={(e) => { setCode(e.target.value); if (error) setError(""); }}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="K7P2QM"
            aria-invalid={!!error}
            aria-label={t("joinCodeLabel", "Join code")}
            className={`w-full text-center text-2xl font-bold tracking-[0.4em] uppercase px-3 py-3 rounded-xl bg-gray-50 border text-gray-900 placeholder:text-gray-300 outline-none transition-colors ${shake ? "animate-shake" : ""} ${error ? "border-red-400 bg-red-50/40 focus:border-red-500" : "border-gray-300 focus:border-gray-900/30"}`}
          />
          {error && (
            <div className="text-xs text-red-600 mt-2 flex items-center gap-1.5">
              <Inbox className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={normalized.length < CODE_LEN || busy}
            className="mt-3 w-full px-4 py-3 text-sm font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-40 transition"
            style={{
              borderRadius: 14,
              background: "linear-gradient(180deg,#22c55e,#16a34a)",
              boxShadow: "0 10px 22px -12px rgba(22,163,74,.95), inset 0 1px 0 rgba(255,255,255,.35)",
            }}
          >
            {busy ? t("joinConnecting", "Connecting…") : t("joinConnect", "Connect")}
            {!busy && <ArrowRight className="w-4 h-4" strokeWidth={2} aria-hidden />}
          </button>
        </form>

        <p className="text-center text-[11px] text-gray-400 mt-4">
          {t("joinTapHint", "Got a link instead? Just tap it — no code needed.")}
        </p>
      </div>
    </div>
  );
}
