// WebsiteBookingKit — "Book bord på din hjemmeside": the ONE place an owner
// gets booking onto their own website. Three ways, fastest first:
//
//   1. Link og knap — the booking link (one-tap copy), a ready "Book bord"
//      button as plain HTML, and the QR code as a print-ready PNG.
//   2. Indlejr      — the whole booking form inside their page (iframe that
//      sizes itself from the page's bonbox:height messages), with a live
//      preview of the real booking page at phone width.
//   3. Vejledning   — four short steps per site builder.
//
// Plus a mailto: hand-off to whoever makes their website. It only OPENS the
// owner's own mail app, pre-filled — BonBox sends nothing.
//
// Every snippet comes from utils/bookingEmbed.js, so what is copied, what is
// e-mailed and what the preview shows are built by the same code.
import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, Download, ExternalLink, Globe, Mail } from "lucide-react";
import TabPills from "../ui/TabPills";
import { saveFile } from "../../utils/download";
import { platform } from "../../utils/platform";
import {
  BUTTON_STYLE,
  SITE_BUILDERS,
  buttonSnippet,
  iframeSnippet,
  mailtoHref,
  previewSrcFor,
  qrFileName,
} from "../../utils/bookingEmbed";

// Phone controls are 40px with 13px text (index.css's 44px coarse-pointer
// floor is released for exactly these); from sm: up they are 36px.
const CTRL =
  "inline-flex items-center justify-center gap-1.5 shrink-0 h-10 sm:h-9 min-h-0! px-3 rounded-lg " +
  "text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[rgb(var(--brand-green-accent))] focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-[rgb(var(--surface-card))]";
const PRIMARY =
  CTRL + " bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100";
const SECONDARY =
  CTRL +
  " border border-gray-200 dark:border-gray-700 bg-white dark:bg-transparent text-gray-800 " +
  "dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800";
const HEAD = "text-[13px] font-semibold text-gray-800 dark:text-gray-200";
const HINT = "text-xs text-gray-500 dark:text-gray-400 leading-relaxed";
const CODE =
  "max-h-28 overflow-auto rounded-lg bg-gray-50 dark:bg-gray-950 border border-gray-100 " +
  "dark:border-gray-800 p-2.5 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300 " +
  "font-mono whitespace-pre";

// The inline style of the snippet, as a React style object — the on-screen
// button IS the snippet's button.
const BUTTON_STYLE_OBJ = Object.fromEntries(
  BUTTON_STYLE.split(";").filter(Boolean).map((decl) => {
    const i = decl.indexOf(":");
    const prop = decl.slice(0, i).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return [prop, decl.slice(i + 1)];
  }),
);

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// The on-screen QR (SVG) drawn onto a 1024px canvas with a white ground — a
// print shop needs pixels, and a transparent PNG prints black-on-nothing.
function svgToPngBlob(svg, size = 1024) {
  return new Promise((resolve) => {
    try {
      const xml = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = size;
          c.height = size;
          const g = c.getContext("2d");
          g.fillStyle = "#ffffff";
          g.fillRect(0, 0, size, size);
          g.imageSmoothingEnabled = false;
          g.drawImage(img, 0, 0, size, size);
          c.toBlob((b) => resolve(b || null), "image/png");
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    } catch {
      resolve(null);
    }
  });
}

// promptLabel: when both clipboard paths are refused (an embedded webview, a
// locked-down browser), show the text in a prompt so it can be copied by hand
// — the last resort the old share card had, kept for the link.
function CopyButton({ text, label, copiedLabel, primary = false, testId, promptLabel = "" }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => setDone(false), 2500);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={async () => {
        const ok = await copyText(text);
        setDone(ok);
        if (!ok && promptLabel) {
          try {
            window.prompt(promptLabel, text);
          } catch { /* no prompt (headless): nothing more to offer */ }
        }
      }}
      className={primary ? PRIMARY : SECONDARY}
    >
      {done ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
      <span aria-live="polite">{done ? copiedLabel : label}</span>
    </button>
  );
}

export default function WebsiteBookingKit({
  publicUrl,
  venueName,
  isProvider = false,
  enabled = true,
  t,
  // Injected for tests; the real values come from the running app.
  appOrigin = typeof window !== "undefined" ? window.location.origin : "",
  canFramePreview = !(platform.isNative && platform.isIOS),
}) {
  const [option, setOption] = useState("link");
  const [builder, setBuilder] = useState(SITE_BUILDERS[0].id);
  const [qrError, setQrError] = useState(false);
  const [previewH, setPreviewH] = useState(640);
  const qrRef = useRef(null);
  const frameRef = useRef(null);

  // `isProvider`: the page's appointment words (a salon, a shop, a workshop —
  // venueProfiles.speaksAppointments): "Book tid", customers, the counter;
  // never "Book bord" or table cards (vertical-fit review, Oct 2026).
  const title = isProvider ? t("rsvpWebTitleProvider") : t("rsvpWebTitle");
  const label = isProvider ? t("rsvpWebButtonLabelProvider") : t("rsvpEmbedButtonLabel");
  const live = enabled && !!publicUrl;

  const kit = useMemo(() => {
    if (!live) return null;
    const button = buttonSnippet({ publicUrl, label });
    const iframe = iframeSnippet({
      publicUrl,
      label,
      venueName,
      fallbackLabel: t("rsvpEmbedOpenInNewTab"),
    });
    const mail = mailtoHref({
      subject: t("rsvpEmbedMailSubject"),
      body: t("rsvpWebMailBody", { link: publicUrl, button, iframe }),
    });
    return { button, iframe, mail, preview: previewSrcFor(publicUrl, appOrigin) };
  }, [live, publicUrl, label, venueName, appOrigin, t]);

  // The preview sizes itself exactly like the owner's page will: from the
  // booking page's own height messages, trusted only from that frame.
  useEffect(() => {
    if (!kit || option !== "embed") return undefined;
    let origin = "";
    try {
      origin = new URL(kit.preview).origin;
    } catch { /* no origin, no messages accepted */ }
    const onMsg = (e) => {
      const f = frameRef.current;
      if (!f || e.source !== f.contentWindow || e.origin !== origin) return;
      if (!e.data || e.data.type !== "bonbox:height") return;
      const h = Number(e.data.height);
      if (Number.isFinite(h) && h > 0) setPreviewH(Math.min(Math.max(Math.ceil(h), 320), 2400));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [kit, option]);

  const downloadQr = async () => {
    setQrError(false);
    const svg = qrRef.current?.querySelector("svg");
    const blob = svg ? await svgToPngBlob(svg) : null;
    const res = blob
      ? await saveFile(blob, qrFileName(publicUrl), { type: "image/png", title })
      : { ok: false };
    if (!res?.ok) setQrError(true);
  };

  const active = SITE_BUILDERS.find((b) => b.id === builder) || SITE_BUILDERS[0];

  return (
    <section
      id="website"
      aria-labelledby="website-title"
      data-testid="website-booking-kit"
      className="scroll-mt-24 rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-4 space-y-4"
    >
      <div>
        <h2
          id="website-title"
          tabIndex={-1}
          className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2 focus:outline-none"
        >
          <Globe className="w-4 h-4 text-gray-400" aria-hidden />
          {title}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {live ? t("rsvpWebSub") : isProvider ? t("rsvpWebOffProvider") : t("rsvpWebOff")}
        </p>
      </div>

      {kit && (
        <>
          <TabPills
            tabs={[
              { id: "link", label: t("rsvpWebTabLink") },
              { id: "embed", label: t("rsvpWebTabEmbed") },
              { id: "guides", label: t("rsvpWebTabGuides") },
            ]}
            activeId={option}
            onChange={setOption}
            ariaLabel={t("rsvpWebOptionsAria")}
            phone="segmented"
          />

          {option === "link" && (
            <div className="space-y-5" data-testid="website-option-link">
              <div className="space-y-2">
                <p className={HEAD}>{t("rsvpWebLinkHeading")}</p>
                <div className="flex items-center gap-2">
                  <div
                    className="flex-1 min-w-0 h-10 sm:h-9 px-3 flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-[13px] text-gray-700 dark:text-gray-300 truncate"
                    data-testid="website-link"
                  >
                    <span className="truncate">{publicUrl}</span>
                  </div>
                  <CopyButton
                    text={publicUrl}
                    label={t("rsvpWebCopyLink")}
                    copiedLabel={t("rsvpCopied")}
                    primary
                    testId="website-copy-link"
                    promptLabel={t("rsvpCopyLinkPrompt")}
                  />
                  {/* Below sm: the icon alone, so the link box keeps room
                      for the address; named by aria-label, titled on hover. */}
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("rsvpOpenPage")}
                    title={t("rsvpOpenPage")}
                    className={SECONDARY + " max-sm:w-10 max-sm:px-0"}
                    data-testid="website-open-page"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden />
                    <span className="max-sm:hidden">{t("rsvpOpenPage")}</span>
                  </a>
                </div>
                <p className={HINT}>{isProvider ? t("rsvpWebLinkHintProvider") : t("rsvpWebLinkHint")}</p>
              </div>

              <div className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-4">
                <p className={HEAD}>{t("rsvpWebButtonHeading", { label })}</p>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {/* The real button, styled from the same string the snippet
                      carries — a live link to the booking page. */}
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={BUTTON_STYLE_OBJ}
                    className="min-h-0!"
                    data-testid="website-button-preview"
                  >
                    {label}
                  </a>
                  <CopyButton
                    text={kit.button}
                    label={t("rsvpEmbedCopyCode")}
                    copiedLabel={t("rsvpCopied")}
                    testId="website-copy-button"
                  />
                </div>
                <pre className={CODE} data-testid="website-button-code">{kit.button}</pre>
                <p className={HINT}>{t("rsvpWebButtonHint")}</p>
              </div>

              <div className="border-t border-gray-100 dark:border-gray-800 pt-4 flex items-start gap-4">
                <div ref={qrRef} className="shrink-0 bg-white rounded-lg border border-gray-200 dark:border-gray-700 p-1.5">
                  {/* Generated client-side (qrcode.react): no image service,
                      works offline, and the PNG is drawn from this SVG. */}
                  <QRCodeSVG
                    value={publicUrl}
                    size={88}
                    level="M"
                    marginSize={2}
                    title={t("rsvpQrAlt")}
                    className="w-[88px] h-[88px]"
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <p className={HEAD}>{isProvider ? t("rsvpWebQrHeadingProvider") : t("rsvpWebQrHeading")}</p>
                  <p className={HINT}>{isProvider ? t("rsvpWebQrHintProvider") : t("rsvpWebQrHint")}</p>
                  <button type="button" onClick={downloadQr} className={SECONDARY} data-testid="website-qr-download">
                    <Download className="w-4 h-4" aria-hidden />
                    {t("rsvpWebQrDownload")}
                  </button>
                  {qrError && (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">{t("rsvpWebQrFailed")}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {option === "embed" && (
            <div className="space-y-4" data-testid="website-option-embed">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={HEAD}>{t("rsvpWebEmbedHeading")}</p>
                    <p className={HINT}>{t("rsvpWebEmbedHint")}</p>
                  </div>
                  <CopyButton
                    text={kit.iframe}
                    label={t("rsvpEmbedCopyCode")}
                    copiedLabel={t("rsvpCopied")}
                    primary
                    testId="website-copy-embed"
                  />
                </div>
                <pre className={CODE} data-testid="website-embed-code">{kit.iframe}</pre>
                <p className={HINT}>
                  {/* The failure an owner can't see: on a plain-http site the
                      frame is blocked and shows a blank box, no error. */}
                  {t("rsvpWebNeedsHttps")}{" "}
                  <button
                    type="button"
                    onClick={() => setOption("guides")}
                    className="inline min-h-0! font-medium text-gray-800 dark:text-gray-200 underline underline-offset-2"
                  >
                    {t("rsvpWebEmbedGuideLink")}
                  </button>
                </p>
              </div>

              <div className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <p className={HEAD}>{t("rsvpWebPreviewHeading")}</p>
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 min-h-0! text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-200"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden />
                    {t("rsvpOpenPage")}
                  </a>
                </div>
                {canFramePreview && (
                  // A phone-width frame around the REAL booking page — the
                  // same /r/ route and ?embed=1 the snippet loads.
                  <div className="mx-auto w-full max-w-[375px] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
                    <iframe
                      ref={frameRef}
                      src={kit.preview}
                      title={t("rsvpWebPreviewTitle")}
                      loading="lazy"
                      data-testid="website-preview"
                      style={{ height: previewH }}
                      className="block w-full border-0"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {option === "guides" && (
            <div className="space-y-3" data-testid="website-option-guides">
              <p className={HEAD}>{t("rsvpWebGuidePick")}</p>
              <div role="radiogroup" aria-label={t("rsvpWebGuidePick")} className="flex flex-wrap gap-1.5">
                {SITE_BUILDERS.map((b) => {
                  const on = b.id === active.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setBuilder(b.id)}
                      className={
                        "h-10 sm:h-8 min-h-0! px-3 rounded-full text-[13px] font-medium transition-colors " +
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-green-accent))] " +
                        (on
                          ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700")
                      }
                    >
                      {b.name}
                    </button>
                  );
                })}
              </div>
              <ol className="space-y-2" data-testid="website-guide-steps">
                {[t(active.open), t(active.add), t("rsvpWebGuidePaste"), t("rsvpWebGuidePublish")].map((s, i) => (
                  <li key={i} className="flex gap-3 text-[13px] text-gray-700 dark:text-gray-300 leading-snug">
                    <span
                      className="shrink-0 w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300 grid place-items-center"
                      aria-hidden
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 pt-px space-y-2">
                      <span className="block">{s}</span>
                      {/* Step 3 pastes the code: copy it right here — the
                          same snippet as "Indlejr", no tab switch. */}
                      {i === 2 && (
                        <CopyButton
                          text={kit.iframe}
                          label={t("rsvpEmbedCopyCode")}
                          copiedLabel={t("rsvpCopied")}
                          primary
                          testId="website-guide-copy-embed"
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {active.wpNote && <p className={HINT}>{t("rsvpWebGuideWpNote")}</p>}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 dark:border-gray-800 pt-3">
                <p className={HINT + " min-w-0 flex-1"}>{t("rsvpWebGuideButtonOnly", { builder: active.name })}</p>
                <CopyButton
                  text={publicUrl}
                  label={t("rsvpWebCopyLink")}
                  copiedLabel={t("rsvpCopied")}
                  testId="website-guide-copy-link"
                />
              </div>
            </div>
          )}

          {/* Most owners don't edit their own site — hand the whole thing to
              whoever does, in one tap. */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-1.5">
            <a href={kit.mail} className={SECONDARY + " w-full sm:w-auto"} data-testid="website-mailto">
              <Mail className="w-4 h-4" aria-hidden />
              {t("rsvpWebSendDev")}
            </a>
            <p className={HINT}>{t("rsvpWebSendDevHint")}</p>
          </div>
        </>
      )}
    </section>
  );
}
