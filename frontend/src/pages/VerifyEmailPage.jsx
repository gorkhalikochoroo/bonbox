import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import api from "../services/api";

export default function VerifyEmailPage() {
  const { user, setEmailVerified } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRefs = useRef([]);

  // Start 60-second cooldown on mount (code was just sent during registration)
  useEffect(() => {
    setResendCooldown(60);
  }, []);

  // Countdown timer for resend
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  // Focus first input on mount
  useEffect(() => {
    if (inputRefs.current[0]) {
      inputRefs.current[0].focus();
    }
  }, []);

  const handleChange = (index, value) => {
    // Only allow digits
    const digit = value.replace(/\D/g, "").slice(-1);
    const newCode = [...code];
    newCode[index] = digit;
    setCode(newCode);
    setError("");

    // Auto-focus next input
    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits are filled
    if (digit && index === 5) {
      const fullCode = newCode.join("");
      if (fullCode.length === 6) {
        handleVerify(fullCode);
      }
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    // Allow paste
    if (e.key === "v" && (e.ctrlKey || e.metaKey)) return;
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 0) return;
    const newCode = [...code];
    for (let i = 0; i < 6; i++) {
      newCode[i] = pasted[i] || "";
    }
    setCode(newCode);
    setError("");
    // Focus last filled input
    const lastIndex = Math.min(pasted.length - 1, 5);
    inputRefs.current[lastIndex]?.focus();
    // Auto-submit if full
    if (pasted.length === 6) {
      handleVerify(pasted);
    }
  };

  const handleVerify = async (codeStr) => {
    const fullCode = codeStr || code.join("");
    if (fullCode.length !== 6) {
      setError("Please enter all 6 digits");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/verify-email", { code: fullCode });
      setSuccess("Email verified successfully!");
      setEmailVerified();
      setTimeout(() => navigate("/dashboard"), 1200);
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (err.response?.status === 429) {
        setError("Too many attempts. Please wait a moment and try again.");
      } else {
        setError(detail || "Verification failed. Please try again.");
      }
      // Clear code on failure
      setCode(["", "", "", "", "", ""]);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setError("");
    try {
      await api.post("/auth/resend-verification");
      setResendCooldown(60);
      setSuccess("New code sent! Check your inbox.");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      if (err.response?.status === 429) {
        setError("Too many resend attempts. Please wait a moment.");
      } else {
        setError("Could not resend code. Please try again.");
      }
    }
  };

  const maskedEmail = user?.email
    ? (() => {
        const [local, domain] = user.email.split("@");
        if (local.length <= 2) return user.email;
        return `${local[0]}${"*".repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}@${domain}`;
      })()
    : "";

  return (
    <>
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
      `}</style>

      <div className="min-h-screen flex bg-slate-950">
        {/* Left panel — branding */}
        <div className="hidden lg:flex lg:w-1/2 items-center justify-center p-12 relative overflow-hidden">
          <div className="absolute top-20 left-1/4 w-80 h-80 bg-green-600/10 rounded-full blur-[100px]" />
          <div className="absolute bottom-20 right-1/4 w-60 h-60 bg-emerald-600/8 rounded-full blur-[100px]" />

          <div className="relative z-10 text-center max-w-md" style={{ animation: "fadeIn 0.8s ease-out" }}>
            <div className="flex items-center justify-center gap-4 mb-10">
              <div className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-sm border border-white/10">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                  <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2.5"/>
                  <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                  <path d="M4 20h20" stroke="#22c55e" strokeWidth="2"/>
                </svg>
              </div>
              <span className="text-3xl font-bold text-white tracking-tight">
                Bon<span className="text-green-400">Box</span>
              </span>
            </div>

            {/* Email verification illustration */}
            <svg viewBox="0 0 300 260" fill="none" className="w-64 mx-auto mb-8" style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.3))" }}>
              <ellipse cx="150" cy="140" rx="130" ry="110" fill="rgba(34,197,94,0.06)" />
              {/* Envelope body */}
              <g style={{ animation: "pulse 3s ease-in-out infinite" }}>
                <rect x="60" y="90" width="180" height="120" rx="12" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />
                {/* Envelope flap */}
                <path d="M60 102 L150 160 L240 102" stroke="#22c55e" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                {/* Checkmark in circle */}
                <circle cx="150" cy="145" r="28" fill="rgba(34,197,94,0.15)" stroke="#22c55e" strokeWidth="2" />
                <path d="M138 145 L146 153 L163 136" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </g>
              {/* Sparkles */}
              <circle cx="80" cy="70" r="4" fill="#22c55e" opacity="0.6" />
              <circle cx="220" cy="75" r="3" fill="#22c55e" opacity="0.4" />
              <circle cx="240" cy="200" r="3.5" fill="#22c55e" opacity="0.5" />
            </svg>

            <h2 className="text-2xl font-bold text-white mb-3">
              Almost there!
            </h2>
            <p className="text-gray-400 leading-relaxed">
              We just need to verify your email address to keep your account secure.
            </p>
          </div>
        </div>

        {/* Right panel — verification form */}
        <div className="flex-1 flex items-center justify-center px-6 py-10">
          <div className="w-full max-w-md" style={{ animation: "slideUp 0.5s ease-out" }}>
            {/* Logo (mobile) */}
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-6 lg:hidden">
                <div className="w-11 h-11 bg-white/10 rounded-xl flex items-center justify-center border border-white/10">
                  <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
                    <rect x="4" y="2" width="20" height="24" rx="3" stroke="white" strokeWidth="2.5"/>
                    <path d="M9 8h10M9 12h10M9 16h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M4 20h20" stroke="#22c55e" strokeWidth="2"/>
                  </svg>
                </div>
                <span className="text-xl font-bold text-white">Bon<span className="text-green-400">Box</span></span>
              </div>

              <h1 className="text-3xl font-bold text-white">Verify your email</h1>
              <p className="text-gray-400 mt-2">
                We sent a 6-digit code to{" "}
                <span className="text-white font-medium">{maskedEmail}</span>
              </p>
            </div>

            {/* Success message */}
            {success && (
              <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 text-green-400 p-3.5 rounded-xl mb-5 text-sm" style={{ animation: "slideUp 0.3s ease-out" }}>
                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{success}</span>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 p-3.5 rounded-xl mb-5 text-sm" style={{ animation: "slideUp 0.3s ease-out" }}>
                <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* OTP input boxes */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">Verification code</label>
              <div className="flex gap-3 justify-center" onPaste={handlePaste}>
                {code.map((digit, index) => (
                  <input
                    key={index}
                    ref={(el) => (inputRefs.current[index] = el)}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleChange(index, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(index, e)}
                    className={`w-13 h-14 text-center text-2xl font-bold rounded-xl border-2 transition-all duration-200 bg-white/[0.05] text-white focus:outline-none ${
                      digit
                        ? "border-green-500/50 bg-green-500/5"
                        : "border-white/10 focus:border-green-500 focus:ring-2 focus:ring-green-500/20"
                    }`}
                    style={{ width: "3.25rem" }}
                    disabled={loading}
                    autoComplete="one-time-code"
                  />
                ))}
              </div>
            </div>

            {/* Verify button */}
            <button
              onClick={() => handleVerify()}
              disabled={loading || code.join("").length !== 6}
              className="w-full bg-green-500 text-white py-3.5 rounded-xl hover:bg-green-400 active:scale-[0.98] transition-all font-semibold text-base disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-green-500/25"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Verifying...
                </>
              ) : (
                "Verify Email"
              )}
            </button>

            {/* Resend code */}
            <div className="mt-5 text-center">
              <p className="text-sm text-gray-500 mb-2">Didn't receive the code?</p>
              <button
                onClick={handleResend}
                disabled={resendCooldown > 0}
                className={`text-sm font-semibold transition ${
                  resendCooldown > 0
                    ? "text-gray-600 cursor-not-allowed"
                    : "text-green-400 hover:text-green-300 hover:underline"
                }`}
              >
                {resendCooldown > 0
                  ? `Resend code in ${resendCooldown}s`
                  : "Resend code"}
              </button>
            </div>

            {/* Help text */}
            <div className="mt-8 p-4 bg-white/[0.03] border border-white/10 rounded-xl">
              <p className="text-xs text-gray-500 leading-relaxed">
                Check your inbox and spam folder. The code expires in 30 minutes.
                If you continue to have issues, try requesting a new code.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
