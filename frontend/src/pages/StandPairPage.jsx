/**
 * Pair this device — the screen you hand someone in a restaurant.
 *
 * Type the six-character code the owner reads out, and this device becomes a
 * host stand bound to their book, with reservations-only reach. No email, no
 * password, nothing typed in front of a prospect.
 *
 * FINISH. This is the first screen a stranger sees on their own tablet, so it
 * carries the gloss recipe from the design handoff rather than the owner app's
 * flat chrome: a vertical gradient fill, a 1px top inset highlight, and a
 * colour-matched drop shadow on the raised elements. Everything else in the
 * app stays flat — gloss is for the surfaces someone is handed.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CalendarCheck } from "lucide-react";

import api from "../services/api";
import { setStandToken } from "../services/standAuth";
import { useLanguage } from "../hooks/useLanguage";

// Same 32-character alphabet the server mints from — no I/O/0/1, because these
// get read aloud across a room. Typing a lowercase "l" should still work, so we
// upper-case first and only then reject what genuinely isn't in the set.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LEN = 6;

export default function StandPairPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [venue, setVenue] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const clean = (raw) =>
    String(raw || "")
      .toUpperCase()
      .replace(/[\s-]/g, "")
      .split("")
      .filter((c) => ALPHABET.includes(c))
      .join("")
      .slice(0, LEN);

  const submit = async (value) => {
    const c = clean(value);
    if (c.length !== LEN || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.post("/stand/join", { code: c });
      const path = res?.data?.path || "";
      const token = path.split("/").filter(Boolean).pop();
      if (!token) throw new Error("no token");
      setVenue(res?.data?.venue || null);
      setStandToken(token);
      // Straight into the book — the point of the code is that the next thing
      // you see is the service, not a menu.
      navigate(`/stand/${token}`, { replace: true });
    } catch {
      // The server answers 404 for unknown / expired / already-used / revoked
      // so codes cannot be probed. Say the same one true thing here rather
      // than inventing a more specific reason we do not actually have.
      setError(
        t(
          "standPairBadCode",
          "That code didn't work. Ask for a fresh one — codes expire after 20 minutes and only work once.",
        ),
      );
      setCode("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const full = clean(code).length === LEN;

  return (
    <div
      className="min-h-dvh flex items-center justify-center px-5 py-10"
      style={{ background: "linear-gradient(180deg,#f8fafc,#eef2f6)" }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-7"
        style={{
          background: "linear-gradient(180deg,#ffffff,#f7f9fc)",
          boxShadow:
            "inset 0 1px 0 #fff, 0 1px 2px rgba(15,23,42,.05), 0 18px 44px -24px rgba(15,23,42,.35)",
        }}
      >
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-white mb-5"
          style={{
            background: "linear-gradient(180deg,#22c55e,#16a34a)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,.35), 0 10px 22px -12px rgba(22,163,74,.85)",
          }}
        >
          <CalendarCheck className="w-6 h-6" aria-hidden />
        </div>

        <h1 className="text-[22px] font-bold tracking-[-0.025em] text-slate-900">
          {t("standPairTitle", "Forbind denne enhed")}
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-slate-500">
          {t(
            "standPairBody",
            "Indtast koden fra ejeren. Enheden viser kun reservationer — aldrig regnskab eller løn.",
          )}
        </p>

        <label htmlFor="stand-code" className="sr-only">
          {t("standPairCodeLabel", "Kode")}
        </label>
        <input
          id="stand-code"
          ref={inputRef}
          value={code}
          onChange={(e) => {
            const v = clean(e.target.value);
            setCode(v);
            setError("");
            if (v.length === LEN) submit(v); // no extra tap once it's complete
          }}
          onKeyDown={(e) => e.key === "Enter" && submit(code)}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          placeholder="ABC123"
          aria-invalid={!!error}
          className="mt-6 w-full h-16 rounded-xl border border-slate-200 bg-white px-4 text-center font-mono text-[30px] tracking-[0.32em] tabular-nums text-slate-900 placeholder:text-slate-300 focus:border-slate-900 focus:outline-none"
        />

        {error && (
          <p role="alert" className="mt-3 text-[13px] leading-snug text-red-600">
            {error}
          </p>
        )}
        {venue && !error && (
          <p className="mt-3 text-[13px] text-slate-500">{venue}</p>
        )}

        <button
          type="button"
          onClick={() => submit(code)}
          disabled={!full || busy}
          className="mt-5 w-full h-13 min-h-[52px] rounded-xl text-white text-[15.5px] font-semibold inline-flex items-center justify-center gap-2 transition-opacity disabled:cursor-not-allowed"
          style={
            full && !busy
              ? {
                  background: "linear-gradient(180deg,#22c55e,#16a34a)",
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,.35), 0 14px 30px -12px rgba(22,163,74,.85)",
                }
              : { background: "#e2e8f0", color: "#64748b" }
          }
        >
          {busy
            ? t("standPairBusy", "Forbinder…")
            : t("standPairCta", "Forbind")}
          {full && !busy && <ArrowRight className="w-4 h-4" aria-hidden />}
        </button>

        <p className="mt-4 text-[12px] leading-snug text-slate-400">
          {t(
            "standPairFoot",
            "Ejeren kan når som helst fjerne adgangen for denne enhed.",
          )}
        </p>
      </div>
    </div>
  );
}
