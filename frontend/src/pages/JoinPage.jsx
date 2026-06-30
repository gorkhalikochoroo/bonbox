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

const CODE_LEN = 6;

export default function JoinPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (normalized.length < CODE_LEN || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await portalApi.post("/portal/join", { code: normalized });
      const path = res.data?.path;
      if (path && path.startsWith("/s/")) {
        navigate(path, { replace: true });
      } else {
        setError(t("joinUnknownCode", "We couldn't find that code. Check it and try again."));
      }
    } catch (err) {
      setError(
        err?.response?.status === 404
          ? t("joinUnknownCode", "We couldn't find that code. Check it and try again.")
          : errText(err, t("joinError", "Something went wrong. Try again.")),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex items-center justify-center p-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="w-full max-w-xs">
        <div className="text-center mb-6">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 text-white shadow-soft"
            style={{ background: "rgb(var(--brand-600))" }}
          >
            <KeyRound className="w-6 h-6" strokeWidth={2} aria-hidden />
          </div>
          <h1 className="text-xl font-bold text-gray-900">{t("joinTitle", "Connect to your workplace")}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t("joinSubtitle", "Enter the 6-character code your manager gave you.")}
          </p>
        </div>

        <form onSubmit={submit} className="rounded-2xl bg-white border border-gray-200/70 card-glossy p-4">
          <label className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5 block">
            {t("joinCodeLabel", "Join code")}
          </label>
          <input
            ref={inputRef}
            value={normalized}
            onChange={(e) => setCode(e.target.value)}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="K7P2QM"
            aria-label={t("joinCodeLabel", "Join code")}
            className="w-full text-center text-2xl font-bold tracking-[0.4em] uppercase px-3 py-3 rounded-xl bg-gray-50 border border-gray-300 text-gray-900 placeholder:text-gray-300 outline-none focus:border-gray-900/30"
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
            className="mt-3 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-40 transition"
            style={{ background: "rgb(var(--brand-600))" }}
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
