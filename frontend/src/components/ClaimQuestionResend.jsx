import { useEffect, useRef, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { remailClaimQuestion, remailResultText } from "../utils/senderGate";

/**
 * "Send spørgsmålet igen" — next to every send BonBox holds while "Har du
 * selv oprettet denne konto?" waits for the inbox owner's answer (release
 * gate, 9 Oct; utils/senderGate.js).
 *
 * One tap asks the server to e-mail the question again to the account's own
 * inbox (at most once a day — the server says when otherwise). It answers
 * nothing: only the link in that mail can. The outcome is said right here,
 * next to the button the owner tapped.
 */
export default function ClaimQuestionResend({ className = "", testId = "claim-resend-question" }) {
  const { t, lang } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  // The answer is brought into view when it appears: on a phone the button
  // can sit just above the fixed bottom tab bar, and the answer rendered
  // under it (release gate R-b). The scroll margin clears the bar (h-14 +
  // the safe area); "nearest" moves nothing where it is already in view.
  const resultRef = useRef(null);
  useEffect(() => {
    if (!result) return;
    try { resultRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); } catch { /* old browser */ }
  }, [result]);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await remailClaimQuestion(api);
      setResult(remailResultText(res, t, lang));
    } catch (err) {
      setResult(remailResultText(err, t, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        data-testid={testId}
        className="font-semibold underline underline-offset-2 whitespace-nowrap disabled:opacity-50"
      >
        {busy ? t("sendingBtn", "Sending…") : t("claimResendQuestion", "Send the question again")}
      </button>
      {result && (
        <span role="status" data-testid={`${testId}-result`} ref={resultRef}
          style={{ scrollMarginBottom: "calc(5rem + env(safe-area-inset-bottom, 0px))" }}
          className={result.ok ? "" : "font-medium"}>
          {result.text}
        </span>
      )}
    </span>
  );
}
