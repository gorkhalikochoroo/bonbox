import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import {
  RevenueCard,
  ExpenseCard,
  InventoryCard,
  WasteCard,
  KhataCard,
  HealthCard,
} from "./AgentDataCards";

/* ------------------------------------------------------------------ */
/*  Tool -> data-card mapping                                          */
/* ------------------------------------------------------------------ */
const DATA_CARD_MAP = {
  query_revenue: RevenueCard,
  query_expenses: ExpenseCard,
  query_inventory: InventoryCard,
  query_waste: WasteCard,
  query_khata: KhataCard,
  business_overview: HealthCard,
};

/* ------------------------------------------------------------------ */
/*  Friendly tool labels                                               */
/* ------------------------------------------------------------------ */
const TOOL_LABELS = {
  query_revenue: "Querying revenue",
  query_expenses: "Checking expenses",
  query_inventory: "Scanning inventory",
  query_waste: "Analyzing waste",
  query_khata: "Looking up credit",
  business_overview: "Compiling overview",
};

/* ------------------------------------------------------------------ */
/*  Suggestion chips                                                   */
/* ------------------------------------------------------------------ */
const QUICK_SUGGESTIONS = [
  "How's today?",
  "This week's revenue",
  "Low stock items",
  "Who owes us?",
];

/* ------------------------------------------------------------------ */
/*  WELCOME MESSAGE                                                    */
/* ------------------------------------------------------------------ */
const WELCOME_CONTENT =
  "Hi! I'm your BonBox AI assistant. Ask me anything about your business \u2014 revenue, expenses, inventory, or staffing.";

/* ================================================================== */
/*  MAIN COMPONENT                                                     */
/* ================================================================== */
export default function BonBoxAgent() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = user?.currency || "DKK";

  /* ---- state ---- */
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "assistant", content: WELCOME_CONTENT, isWelcome: true },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState([]);
  const [isExpanding, setIsExpanding] = useState(false); // for morph animation

  /* ---- refs ---- */
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const scrollContainerRef = useRef(null);

  /* ---- auto-scroll ---- */
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, activeTools, scrollToBottom]);

  /* ---- focus input when opened ---- */
  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 350);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  /* ---------------------------------------------------------------- */
  /*  OPEN / CLOSE with morph animation                                */
  /* ---------------------------------------------------------------- */
  const handleOpen = useCallback(() => {
    setIsExpanding(true);
    setIsOpen(true);
    // remove expanding flag after animation completes
    setTimeout(() => setIsExpanding(false), 400);
  }, []);

  const handleClose = useCallback(() => {
    setIsExpanding(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsExpanding(false);
    }, 250);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  SSE STREAMING                                                    */
  /* ---------------------------------------------------------------- */
  const sendMessage = useCallback(
    async (overrideText) => {
      const userMsg = (overrideText || input).trim();
      if (!userMsg || isStreaming) return;
      setInput("");
      setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
      setIsStreaming(true);
      setActiveTools([]);

      const token = localStorage.getItem("token");
      const baseUrl =
        import.meta.env.VITE_API_URL || "http://localhost:8000/api";

      try {
        const res = await fetch(`${baseUrl}/agent/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            message: userMsg,
            history: messages
              .slice(-10)
              .map((m) => ({ role: m.role, content: m.content })),
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let currentText = "";
        let currentDataCards = [];
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

          for (const block of lines) {
            const eventMatch = block.match(/^event: (\w+)/);
            const dataMatch = block.match(/^data: (.+)$/m);
            if (!eventMatch || !dataMatch) continue;

            const event = eventMatch[1];
            let data;
            try {
              data = JSON.parse(dataMatch[1]);
            } catch {
              continue;
            }

            if (event === "text") {
              currentText += data.delta;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant" && !last.isWelcome) {
                  return [
                    ...updated.slice(0, -1),
                    {
                      ...last,
                      content: currentText,
                      dataCards: [...currentDataCards],
                    },
                  ];
                }
                return [
                  ...updated,
                  {
                    role: "assistant",
                    content: currentText,
                    dataCards: [...currentDataCards],
                  },
                ];
              });
            } else if (event === "tool_call") {
              setActiveTools((prev) => [...prev, data.tool]);
            } else if (event === "tool_result") {
              setActiveTools((prev) => prev.filter((t) => t !== data.tool));
              if (data.result?.data) {
                currentDataCards = [
                  ...currentDataCards,
                  { tool: data.tool, data: data.result.data },
                ];
              }
            } else if (event === "error") {
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: data.message || "Something went wrong. Please try again.",
                },
              ]);
            }
            // event === "done" handled by the loop ending
          }
        }
      } catch (err) {
        console.error("BonBoxAgent SSE error:", err);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Sorry, something went wrong. Please try again.",
          },
        ]);
      } finally {
        setIsStreaming(false);
        setActiveTools([]);
      }
    },
    [input, isStreaming, messages]
  );

  /* ---- keyboard: Enter to send, Shift+Enter for newline ---- */
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  /* ---- suggestion chip click ---- */
  const handleSuggestion = useCallback(
    (text) => {
      sendMessage(text);
    },
    [sendMessage]
  );

  /* ================================================================ */
  /*  RENDER HELPERS                                                   */
  /* ================================================================ */

  /* ---- data card renderer ---- */
  const renderDataCard = useCallback(
    (card, idx) => {
      const CardComponent = DATA_CARD_MAP[card.tool];
      if (!CardComponent || !card.data) return null;
      return (
        <div key={`${card.tool}-${idx}`} className="mt-2">
          <CardComponent data={card.data} currency={currency} />
        </div>
      );
    },
    [currency]
  );

  /* ---- message renderer ---- */
  const renderMessage = useCallback(
    (msg, idx) => {
      const isUser = msg.role === "user";
      return (
        <div
          key={idx}
          className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}
          style={{
            animation: "msgSlide 0.25s ease-out both",
            animationDelay: `${Math.min(idx * 30, 150)}ms`,
          }}
        >
          <div className={`max-w-[85%] ${isUser ? "order-2" : "order-1"}`}>
            {/* bubble */}
            <div
              className={`
                px-4 py-2.5 text-[13.5px] leading-relaxed
                ${isUser
                  ? "bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-2xl rounded-br-md shadow-lg shadow-green-900/20"
                  : "bg-gray-800/60 dark:bg-gray-800/60 text-gray-100 dark:text-gray-100 rounded-2xl rounded-bl-md border border-white/[0.04] backdrop-blur-sm"
                }
              `}
            >
              {/* render markdown-like bold with ** */}
              {msg.content.split(/(\*\*.*?\*\*)/).map((part, pi) =>
                part.startsWith("**") && part.endsWith("**") ? (
                  <strong key={pi} className="font-semibold">
                    {part.slice(2, -2)}
                  </strong>
                ) : (
                  <span key={pi}>{part}</span>
                )
              )}
            </div>

            {/* data cards */}
            {msg.dataCards?.map((card, ci) => renderDataCard(card, ci))}

            {/* suggestion chips below welcome */}
            {msg.isWelcome && (
              <div className="flex flex-wrap gap-2 mt-3">
                {QUICK_SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSuggestion(q)}
                    disabled={isStreaming}
                    className="
                      text-[11.5px] px-3 py-1.5 rounded-full
                      bg-white/[0.06] border border-white/[0.08]
                      text-gray-300 hover:text-white hover:bg-white/[0.1] hover:border-white/[0.15]
                      transition-all duration-200
                      disabled:opacity-40 disabled:cursor-not-allowed
                    "
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    },
    [renderDataCard, handleSuggestion, isStreaming]
  );

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */
  return (
    <>
      {/* ============== INJECTED STYLES ============== */}
      <style>{`
        @keyframes orbPulse {
          0%, 100% {
            box-shadow:
              0 0 20px rgba(34, 197, 94, 0.3),
              0 0 60px rgba(34, 197, 94, 0.1);
          }
          50% {
            box-shadow:
              0 0 30px rgba(34, 197, 94, 0.5),
              0 0 80px rgba(34, 197, 94, 0.2);
          }
        }
        @keyframes orbFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes orbParticle {
          0%   { opacity: 0; transform: translate(0, 0) scale(0); }
          30%  { opacity: 1; transform: translate(var(--px), var(--py)) scale(1); }
          100% { opacity: 0; transform: translate(calc(var(--px) * 2.5), calc(var(--py) * 2.5)) scale(0); }
        }
        @keyframes shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes neuralPulse {
          0%, 100% { opacity: 0.6; }
          50%      { opacity: 1; }
        }
        @keyframes panelOpen {
          from { opacity: 0; transform: scale(0.85) translateY(20px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes panelClose {
          from { opacity: 1; transform: scale(1) translateY(0); }
          to   { opacity: 0; transform: scale(0.85) translateY(20px); }
        }
        @keyframes msgSlide {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes typingWave {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30%            { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes borderGlow {
          0%, 100% { border-color: rgba(34, 197, 94, 0.25); }
          50%      { border-color: rgba(34, 197, 94, 0.5); }
        }
        @keyframes gradientShift {
          0%   { background-position: 0% 50%; }
          50%  { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }

        .bonbox-agent-scrollbar::-webkit-scrollbar { width: 4px; }
        .bonbox-agent-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .bonbox-agent-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.1);
          border-radius: 4px;
        }
        .bonbox-agent-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.2);
        }
      `}</style>

      {/* Hidden trigger — always in DOM so dashboard "Ask anything" can open the agent */}
      <button
        data-bonbox-agent-toggle
        onClick={handleOpen}
        aria-hidden="true"
        className="hidden"
      />

      {/* ============== ORB BUTTON (collapsed state) ============== */}
      {!isOpen && (
        <button
          onClick={handleOpen}
          aria-label="Open BonBox AI Assistant"
          className="
            fixed bottom-6 right-6 z-[9999]
            w-14 h-14 rounded-full
            bg-gradient-to-br from-green-500 to-emerald-600
            flex items-center justify-center
            cursor-pointer select-none
            transition-transform duration-300 ease-out
            hover:scale-110 active:scale-95
          "
          style={{
            animation: "orbPulse 3s ease-in-out infinite, orbFloat 4s ease-in-out infinite",
          }}
        >
          {/* particles (CSS pseudo-element approach via multiple small spans) */}
          {[...Array(6)].map((_, i) => {
            const angle = (i / 6) * Math.PI * 2;
            const px = Math.cos(angle) * 18;
            const py = Math.sin(angle) * 18;
            return (
              <span
                key={i}
                className="absolute w-1 h-1 rounded-full bg-green-300"
                style={{
                  "--px": `${px}px`,
                  "--py": `${py}px`,
                  animation: `orbParticle ${2 + i * 0.3}s ease-out infinite`,
                  animationDelay: `${i * 0.4}s`,
                }}
              />
            );
          })}

          {/* sparkle icon */}
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            className="relative z-10"
          >
            <path
              d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"
              fill="white"
              fillOpacity="0.95"
            />
            <path
              d="M19 3L20 6L23 7L20 8L19 11L18 8L15 7L18 6L19 3Z"
              fill="white"
              fillOpacity="0.6"
            />
          </svg>
        </button>
      )}

      {/* ============== CHAT PANEL ============== */}
      {isOpen && (
        <div
          className="
            fixed z-[9999]
            bottom-6 right-6
            sm:w-[420px] sm:h-[620px]
            max-sm:inset-0 max-sm:bottom-0 max-sm:right-0
            flex flex-col
            rounded-2xl max-sm:rounded-none
            overflow-hidden
            border border-white/[0.08]
            shadow-2xl shadow-black/40
          "
          style={{
            background:
              "linear-gradient(135deg, rgba(17,24,39,0.97) 0%, rgba(10,15,28,0.98) 100%)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
            animation: isExpanding
              ? (isOpen ? "panelOpen 0.35s cubic-bezier(0.16,1,0.3,1) both" : "panelClose 0.25s ease-in both")
              : "none",
            transformOrigin: "bottom right",
          }}
        >
          {/* --- gradient top edge --- */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/30 to-transparent" />

          {/* ========= HEADER ========= */}
          <div className="flex items-center justify-between px-5 py-3.5 max-sm:pt-[max(0.875rem,env(safe-area-inset-top))] border-b border-white/[0.06] shrink-0">
            <div className="flex items-center gap-3">
              {/* animated brain icon */}
              <div
                className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center"
                style={{ animation: "neuralPulse 3s ease-in-out infinite" }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white">
                  <path
                    d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"
                    fill="currentColor"
                  />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white leading-none">
                  BonBox AI
                </h3>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
                  <span className="text-[10px] text-gray-400">Online</span>
                </div>
              </div>
            </div>

            {/* close button — larger tap target + back arrow on mobile */}
            <button
              onClick={handleClose}
              aria-label="Close chat"
              className="
                w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center
                text-gray-300 sm:text-gray-400 hover:text-white
                hover:bg-white/[0.08] active:bg-white/[0.12]
                transition-colors duration-200
              "
            >
              {/* Back arrow on mobile, X on desktop */}
              <svg className="sm:hidden" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5" />
                <path d="M12 19l-7-7 7-7" />
              </svg>
              <svg className="hidden sm:block" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* ========= MESSAGES AREA ========= */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto px-4 py-4 bonbox-agent-scrollbar"
          >
            {messages.map((msg, idx) => renderMessage(msg, idx))}

            {/* ---- active tool pills ---- */}
            {activeTools.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {activeTools.map((tool) => (
                  <ToolPill key={tool} tool={tool} />
                ))}
              </div>
            )}

            {/* ---- typing indicator ---- */}
            {isStreaming && activeTools.length === 0 && (
              <div className="flex justify-start mb-3">
                <div className="bg-gray-800/60 border border-white/[0.04] rounded-2xl rounded-bl-md px-4 py-3 flex items-center gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-2 h-2 rounded-full bg-emerald-400"
                      style={{
                        animation: "typingWave 1.2s ease-in-out infinite",
                        animationDelay: `${i * 0.15}s`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* ========= INPUT AREA ========= */}
          <div className="shrink-0 px-4 pb-4 pt-2">
            <div
              className="
                relative flex items-end gap-2
                rounded-xl
                border border-white/[0.08]
                bg-white/[0.04]
                transition-all duration-300
                focus-within:border-emerald-500/40 focus-within:bg-white/[0.06]
                focus-within:shadow-[0_0_20px_rgba(34,197,94,0.08)]
              "
              style={{
                /* animated gradient border on focus is handled via box-shadow above */
              }}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your business..."
                disabled={isStreaming}
                rows={1}
                className="
                  flex-1 bg-transparent border-none outline-none resize-none
                  text-[13.5px] text-gray-100 placeholder-gray-500
                  px-4 py-3 max-h-[100px]
                  disabled:opacity-50
                "
                style={{
                  height: "auto",
                  minHeight: "44px",
                }}
                onInput={(e) => {
                  e.target.style.height = "auto";
                  e.target.style.height =
                    Math.min(e.target.scrollHeight, 100) + "px";
                }}
              />

              {/* send button */}
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || isStreaming}
                aria-label="Send message"
                className="
                  shrink-0 w-9 h-9 mr-1.5 mb-1.5
                  rounded-lg flex items-center justify-center
                  bg-gradient-to-br from-green-500 to-emerald-600
                  text-white
                  disabled:opacity-30 disabled:cursor-not-allowed
                  hover:from-green-400 hover:to-emerald-500
                  transition-all duration-200
                  active:scale-90
                "
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22,2 15,22 11,13 2,9 22,2" />
                </svg>
              </button>
            </div>

            {/* footer hint */}
            <p className="text-[10px] text-gray-600 text-center mt-2 select-none">
              Shift+Enter for new line
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/* ================================================================== */
/*  TOOL PILL SUB-COMPONENT                                            */
/* ================================================================== */
function ToolPill({ tool }) {
  const label = TOOL_LABELS[tool] || tool.replace(/_/g, " ");

  return (
    <div
      className="
        inline-flex items-center gap-2
        px-3 py-1.5 rounded-full
        border border-white/[0.06]
        text-[11px] font-medium text-emerald-300
      "
      style={{
        background:
          "linear-gradient(90deg, rgba(34,197,94,0.08) 0%, rgba(16,185,129,0.04) 100%)",
        backgroundSize: "200% 100%",
        animation: "shimmer 2s linear infinite, neuralPulse 2s ease-in-out infinite",
      }}
    >
      {/* lightning icon */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
        <path d="M13 2L3 14h9l-1 10 10-12h-9l1-10z" />
      </svg>
      <span className="truncate">{label}...</span>
      {/* scanning dots */}
      <span className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1 h-1 rounded-full bg-emerald-400"
            style={{
              animation: "typingWave 1s ease-in-out infinite",
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </span>
    </div>
  );
}
