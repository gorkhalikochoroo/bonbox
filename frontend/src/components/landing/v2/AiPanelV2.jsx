import { Send, Sparkles, TrendingUp, X } from "lucide-react";
import { useLanguage } from "../../../hooks/useLanguage";

/**
 * Landing v2 — "BonBox AI" section.
 * Left: eyebrow + h2 + body + four example-prompt chips (mixed DA/EN by design).
 * Right: a static mock of the copilot chat panel (max 400px).
 *
 * Fix-list #5 applied: the MOMS figure is 88.777 kr. everywhere (the design's
 * 41.061 kr. contradicted the dashboard and the ~17.800 kr./week pace).
 * The panel is a picture of a conversation, so its glyph controls are
 * decorative (aria-hidden) rather than focusable no-op buttons.
 */
export default function AiPanelV2() {
  const { t } = useLanguage();

  const chips = [
    t("landingV2.ai.chip1", "Hvor meget skylder jeg i MOMS?"),
    t("landingV2.ai.chip2", "Which expenses have no bilag?"),
    t("landingV2.ai.chip3", "Hvad spildte vi sidste uge?"),
    t("landingV2.ai.chip4", "Who's on overtime?"),
  ];

  return (
    <section
      id="ai"
      aria-labelledby="ai-heading"
      className="border-t border-slate-200 bg-white"
    >
      <div className="mx-auto w-full max-w-[1800px] px-[clamp(24px,4vw,80px)] py-[clamp(52px,6vw,88px)]">
        <div className="grid grid-cols-1 items-center gap-9 min-[1041px]:grid-cols-[minmax(0,1fr)_minmax(0,0.86fr)] min-[1041px]:gap-[clamp(36px,5vw,64px)]">
          {/* Left column */}
          <div>
            <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {t("landingV2.ai.eyebrow", "BonBox AI")}
            </div>

            <h2
              id="ai-heading"
              className="mb-4 font-display text-[clamp(28px,3.1vw,40px)] font-bold leading-[1.06] tracking-[-0.028em] text-slate-900"
            >
              {t(
                "landingV2.ai.title",
                "Ask it in plain Danish. It answers with your own numbers."
              )}
            </h2>

            <p className="mb-[26px] max-w-[46ch] text-[17px] text-slate-600">
              {t(
                "landingV2.ai.body",
                "The copilot sits on top of your real data — revenue, expenses, inventory, credit, waste and staff. It quotes figures from your business, and says so when it doesn't have enough to answer."
              )}
            </p>

            <div className="flex flex-wrap gap-[9px]">
              {chips.map((chip) => (
                <span
                  key={chip}
                  className="rounded-full border border-slate-200 bg-slate-50 px-[15px] py-[9px] text-[14px] text-slate-900"
                >
                  {chip}
                </span>
              ))}
            </div>
          </div>

          {/* Right column — chat panel mock */}
          <div className="flex justify-center">
            <figure
              aria-label={t(
                "landingV2.ai.panelLabel",
                "Example conversation with the BonBox copilot"
              )}
              className="w-full max-w-[400px] overflow-hidden rounded-[20px] bg-chat-bg shadow-[0_30px_60px_-28px_rgba(15,23,42,0.55)]"
            >
              {/* Header */}
              <div className="flex items-center gap-3 border-b border-chat-border px-[18px] py-4">
                <span
                  aria-hidden="true"
                  className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[11px] bg-bb-green text-white"
                >
                  <Sparkles size={18} strokeWidth={1.75} />
                </span>

                <div className="flex-1">
                  <div className="font-display text-[16px] font-bold tracking-[-0.015em] text-slate-50">
                    {t("landingV2.ai.assistantName", "BonBox AI")}
                  </div>
                  <div className="mt-px flex items-center gap-1.5 text-[12px] text-slate-400">
                    <span
                      aria-hidden="true"
                      className="inline-block h-1.5 w-1.5 rounded-full bg-bb-green-bright"
                    />
                    {t("landingV2.ai.status", "Online")}
                  </div>
                </div>

                <span aria-hidden="true" className="flex-none text-slate-500">
                  <X size={17} strokeWidth={1.75} />
                </span>
              </div>

              {/* Conversation */}
              <div className="grid gap-3 px-[18px] py-4">
                <p className="rounded-[14px] bg-chat-bubble px-[15px] py-[14px] text-[14px] leading-[1.5] text-slate-300">
                  {t(
                    "landingV2.ai.greeting",
                    "Hey — I'm your BonBox copilot. Ask me anything about the business. I can check revenue, expenses, inventory, credit, waste and staff."
                  )}
                </p>

                <div className="flex justify-end">
                  <p className="max-w-[80%] rounded-[14px] bg-bb-green px-[15px] py-[11px] text-[14px] font-medium text-white">
                    {t("landingV2.ai.question", "Hvor meget skylder jeg i MOMS?")}
                  </p>
                </div>

                <p className="rounded-[14px] bg-chat-bubble px-[15px] py-[14px] text-[14px] leading-[1.5] text-slate-300">
                  {t("landingV2.ai.answerPre", "About ")}
                  <strong className="font-semibold text-slate-50">
                    {t("landingV2.ai.answerAmount", "88.777 kr.")}
                  </strong>
                  {t("landingV2.ai.answerMid", " for H1, due ")}
                  <strong className="font-semibold text-slate-50">
                    {t("landingV2.ai.answerDue", "1 September")}
                  </strong>
                  {t(
                    "landingV2.ai.answerPost",
                    " — 36 days out. At this pace you'd want to set aside ~17.800 kr. a week. Shall I add it as a reminder?"
                  )}
                </p>

                {/* Inline metric card */}
                <div className="flex items-center justify-between gap-3 rounded-[14px] bg-white px-[15px] py-[14px]">
                  <div>
                    <div className="mb-1 text-[12px] min-[1041px]:text-[10.5px] font-semibold uppercase tracking-[0.13em] text-slate-400">
                      {t("landingV2.ai.metricLabel", "MOMS payable")}
                    </div>
                    <div className="font-display text-[24px] font-bold tracking-[-0.02em] text-slate-900">
                      {t("landingV2.ai.metricValue", "88.777")}
                      <span className="text-[13px] font-medium text-slate-500">
                        {" "}
                        {t("landingV2.ai.metricUnit", "kr.")}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-slate-500">
                      {t("landingV2.ai.metricSub", "to SKAT · H1 2026")}
                    </div>
                  </div>

                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 flex-none items-center justify-center rounded-[11px] bg-slate-100 text-slate-900"
                  >
                    <TrendingUp size={18} strokeWidth={1.75} />
                  </span>
                </div>
              </div>

              {/* Input row */}
              <div className="px-[18px] pb-[10px]">
                <div className="flex items-center gap-[9px] rounded-[14px] border border-chat-border py-[9px] pl-[15px] pr-[9px]">
                  <span className="flex-1 text-[14px] text-slate-500">
                    {t("landingV2.ai.inputPlaceholder", "Ask about your business…")}
                  </span>
                  <span
                    aria-hidden="true"
                    className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-slate-800 text-slate-300"
                  >
                    <Send size={15} strokeWidth={1.75} />
                  </span>
                </div>
                <figcaption className="px-0 pb-1.5 pt-[9px] text-center text-[11.5px] text-slate-600">
                  {t("landingV2.ai.caption", "Shift+Enter for new line")}
                </figcaption>
              </div>
            </figure>
          </div>
        </div>
      </div>
    </section>
  );
}
