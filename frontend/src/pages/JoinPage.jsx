/**
 * Public "enter your code to connect" page — the typed-code half of the staff
 * invite. The owner reads a 6-character code off their screen; the staffer
 * types it here and lands on their own portal. The tap-link is the other half
 * (it skips this page entirely).
 *
 * No auth: the code IS the credential. The backend hard-rate-limits and returns
 * a generic 404 for any miss, so there's nothing to enumerate here. The page
 * therefore never shows server or axios text: every failure maps to our own
 * da/en copy (joinFailure below).
 */
import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, KeyRound, AlertCircle, CloudOff, Clock } from "lucide-react";
import portalApi from "../services/portalApi";
import { useLanguage } from "../hooks/useLanguage";
import { useKeyboardReveal } from "../hooks/useKeyboardReveal";
import { haptic } from "../utils/haptics"; // no-op on web; physical buzz in the iOS shell

const CODE_LEN = 6;
const UNKNOWN_CODE_EN =
  "That code doesn't work. It may be mistyped, expired (codes last 7 days) or already used — ask your manager for a new one.";

/**
 * What went wrong, in the staffer's language — never a server or axios string.
 *
 * The backend answers EVERY dead code (unknown, mistyped, expired, already
 * used, revoked) with one indistinguishable 404 on purpose: anything that
 * confirmed a code once existed is what an enumerator pays for (see
 * staff_portal.portal_join, pinned by test_join_code_hardening). So the 404
 * copy names all three real causes and the one fix that always works — a new
 * code from the manager — instead of calling a correct-but-expired code a
 * typo.
 *
 * Only the 404 is "your code"; every other failure is the connection or the
 * server and must not look like the staffer typed it wrong.
 */
function joinFailure(err, t) {
  const status = err?.response?.status;
  if (status === 404) {
    return { kind: "code", text: t("joinUnknownCode", UNKNOWN_CODE_EN) };
  }
  if (status === 429) {
    return { kind: "wait", text: t("joinTooMany", "Too many tries — wait a minute and try again.") };
  }
  if (!err?.response || err?.code === "ECONNABORTED") {
    return { kind: "offline", text: t("joinNoConnection", "No connection — check your internet and try again.") };
  }
  if (status >= 500) {
    return { kind: "server", text: t("joinServerDown", "The server isn't answering right now — try again in a moment.") };
  }
  return { kind: "server", text: t("joinError", "Something went wrong — try again.") };
}

export default function JoinPage() {
  const { t, lang, setLang } = useLanguage();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState(null);   // null | {kind, text}
  const [shake, setShake] = useState(false);
  const inputRef = useRef(null);
  // Native keyboard height (0 on the web): the centred card re-centres in
  // what the keyboard leaves, so Tilslut stays visible.
  const kb = useKeyboardReveal();

  // The tab / app-switcher title is the staff app's, not the owner pitch.
  useEffect(() => {
    const prev = document.title;
    document.title = t("joinDocTitle", "BonBox Scheduler — Connect");
    return () => { document.title = prev; };
  }, [t]);

  // A cold server can take a while (the client retries for ~20 s). Past a few
  // seconds say so, instead of a button that just reads "Tilslutter…".
  useEffect(() => {
    if (!busy) { setSlow(false); return undefined; }
    const id = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(id);
  }, [busy]);

  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);

  // Rejected code → make it FEEL wrong: red border + a short shake + the iOS
  // "error" haptic, and re-select the field so a retype replaces it in one go.
  // Only for the code itself: a dropped connection or a busy server is not
  // the staffer's mistake, so it gets a calm line and keeps the code as typed.
  const flag = (failure) => {
    setError(failure);
    if (failure.kind !== "code") return;
    haptic.error();
    setShake(true);
    setTimeout(() => setShake(false), 480);
    try { inputRef.current?.focus(); inputRef.current?.select(); } catch { /* noop */ }
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    if (normalized.length < CODE_LEN || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await portalApi.post("/portal/join", { code: normalized });
      const path = res.data?.path;
      if (path && path.startsWith("/s/")) {
        haptic.success();
        navigate(path, { replace: true });
      } else {
        flag({ kind: "code", text: t("joinUnknownCode", UNKNOWN_CODE_EN) });
      }
    } catch (err) {
      flag(joinFailure(err, t));
    } finally {
      setBusy(false);
    }
  };

  const wrong = error?.kind === "code";
  const ErrIcon = error?.kind === "offline" ? CloudOff : error?.kind === "wait" ? Clock : AlertCircle;

  return (
    /* v2 treatment. With PINs gone this is genuinely the FIRST screen a staffer
       ever sees, and it was the last one still wearing the blue --brand accent
       while everything behind it had gone dark-and-green. Same surface as the
       Schedule hero: 152deg gradient, radius 22, bloom off the top-right. */
    <div
      className="relative min-h-[100dvh] text-gray-900 flex items-center justify-center p-6 pt-[max(1.5rem,env(safe-area-inset-top))]"
      style={{ background: "#f5f7fb", ...(kb > 0 ? { minHeight: `calc(100dvh - ${kb}px)` } : {}) }}
    >
      {/* DA / EN before joining: a staffer who does not read Danish on a
          Danish-locale phone can switch here. Only the language — the
          first-run default is unchanged. */}
      <div
        className="absolute right-4 top-[max(0.75rem,env(safe-area-inset-top))] flex rounded-xl border border-gray-200 bg-white p-0.5 gap-0.5"
        role="group"
        aria-label={t("portalLangLabel", "Language")}
      >
        {["da", "en"].map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            aria-pressed={lang === code}
            className={`min-w-[44px] min-h-[40px] px-2.5 rounded-[10px] text-[12px] font-bold uppercase transition active:scale-[0.98] ${
              lang === code ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {code === "da" ? "DA" : "EN"}
          </button>
        ))}
      </div>
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
            aria-invalid={wrong}
            aria-describedby={error ? "join-error" : undefined}
            aria-label={t("joinCodeLabel", "Join code")}
            className={`w-full text-center text-2xl font-bold tracking-[0.4em] uppercase px-3 py-3 rounded-xl bg-gray-50 border text-gray-900 placeholder:text-gray-300 outline-none transition-colors ${shake ? "animate-shake" : ""} ${wrong ? "border-red-400 bg-red-50/40 focus:border-red-500" : "border-gray-300 focus:border-gray-900/30"}`}
          />
          {error && (
            <div
              id="join-error"
              role="alert"
              data-kind={error.kind}
              className={`text-xs mt-2 flex items-start gap-1.5 leading-snug ${wrong ? "text-red-600" : "text-amber-800"}`}
            >
              <ErrIcon className="w-3.5 h-3.5 mt-px shrink-0" strokeWidth={2} aria-hidden />
              <span>{error.text}</span>
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
          {busy && slow && (
            <p role="status" className="mt-2 text-center text-[12px] text-gray-600 leading-snug">
              {t("joinSlow", "This is taking longer than usual — still trying.")}
            </p>
          )}
        </form>

        {/* gray-500 at 12px: the 11px gray-400 measured ~2.4:1 on #f5f7fb. */}
        <p className="text-center text-[12px] text-gray-500 mt-4">
          {t("joinTapHint", "Got a link instead? Just tap it — no code needed.")}
        </p>
      </div>
    </div>
  );
}
