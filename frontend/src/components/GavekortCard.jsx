// GavekortCard — the printable, owner-branded gift card (visual source of truth).
//
// ONE presentational component, TWO premium templates:
//   • "minimal" — Nordic light: warm paper, ink, a single accent (the owner's
//                 brand colour, else BonBox green), a 5px accent bar down the
//                 left edge, QR dark-on-white.
//   • "foil"    — Charcoal foil: near-black with a subtle sheen, gold accent,
//                 gold-outline monogram, a thin gold hairline above the amount,
//                 QR dark-on-cream.
//
// This same component renders the LIVE on-screen preview inside
// GavekortPrintModal AND is the pixel reference the backend PDF matches — so
// the two must share the EXACT tokens/layout below. Change one, change both.
//
// DK labels are BRAND-LOCKED and never translated ("Gavekort", "Til", "Fra",
// "Indløs i butik", "Gyldig til", "CVR") — a gavekort is a Danish physical
// artefact, so the card reads Danish regardless of the app's UI language.
//
// Design doctrine: premium = restraint. Generous margins, refined type, ONE
// accent per card, no gradients besides the subtle foil sheen, no clutter.
//
// Sizing: the card holds a fixed credit-card aspect (1.586 : 1) and scales its
// whole type ramp off the container width via `cqw` units, so it stays
// pixel-proportional from a 340px phone to a 460px modal. Everything inside is
// sized in `em` off the card's own font-size — one knob scales the lot.
import React from "react";
import { QRCodeSVG } from "qrcode.react";

// Credit-card ratio (width : height). Locked — shared with the PDF.
const CARD_RATIO = 1.586;

// Per-template token sets. These hex values are the contract with the backend
// PDF renderer — do not drift them without updating the PDF side too.
const TOKENS = {
  minimal: {
    paper: "#fbfaf7",
    ink: "#14120f",
    muted: "#8a857c",
    note: "#5f5a52", // softer than muted — the personal note reads warmer
    hairline: "#e8e5df",
    qrFg: "#14120f",
    qrChip: "#ffffff",
    defaultAccent: "#166b4f",
  },
  foil: {
    paper: "#14120f",
    ink: "#f4f1ea",
    muted: "#a49a86",
    note: "#cfc6b4",
    hairline: "rgba(201,169,106,0.16)",
    qrFg: "#14120f",
    qrChip: "#f4f1ea",
    gold: "#c9a96a",
  },
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// Split "1.500 kr." → { num: "1.500", suffix: "kr." } so the number can be the
// bold hero and " kr." a whispered muted tail. Falls back to showing the whole
// label as the number when there's no recognisable kr. suffix.
function splitAmount(label) {
  const s = String(label ?? "").trim();
  const m = s.match(/^(.*?)\s*(kr\.?)\s*$/i);
  if (m && m[1].trim()) return { num: m[1].trim(), suffix: "kr." };
  return { num: s, suffix: "" };
}

export default function GavekortCard({
  businessName = "",
  address = "",
  monogram = "",
  logoUrl = null,
  amountLabel = "",
  recipient = "",
  note = "",
  code = "",
  validUntilLabel = "",
  cvr = "",
  accentColor = null,
  template = "minimal",
  qrValue = "",
  maxWidth = 460,
}) {
  const isFoil = template === "foil";
  const tk = isFoil ? TOKENS.foil : TOKENS.minimal;

  // ONE accent per card. Foil is always gold (owner colour is ignored on the
  // dark template by design). Minimal uses the owner's brand hex, else green.
  const accent = isFoil
    ? tk.gold
    : accentColor && HEX_RE.test(accentColor)
      ? accentColor
      : tk.defaultAccent;

  const { num: amountNum, suffix: amountSuffix } = splitAmount(amountLabel);

  // "Til <recipient>" — shown only when the owner named a recipient.
  const toFromLine = recipient ? `Til ${recipient}` : "";

  // "Gyldig til <date> · CVR <cvr>" — omit either fragment when missing.
  const fine = [];
  if (validUntilLabel) fine.push(`Gyldig til ${validUntilLabel}`);
  if (cvr) fine.push(`CVR ${cvr}`);
  const finePrint = fine.join("  ·  ");

  const monoLetters = (monogram || businessName.trim().charAt(0) || "•")
    .toString()
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      style={{
        containerType: "inline-size",
        width: "100%",
        maxWidth,
        margin: "0 auto",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: `${CARD_RATIO} / 1`,
          borderRadius: 16,
          overflow: "hidden",
          color: tk.ink,
          background: isFoil
            ? "linear-gradient(135deg, #191510 0%, #141210 48%, #100e0b 100%)"
            : tk.paper,
          border: `1px solid ${tk.hairline}`,
          boxShadow: isFoil
            ? "0 12px 34px -14px rgba(0,0,0,0.6)"
            : "0 12px 32px -16px rgba(20,18,15,0.28)",
          fontFamily: "Inter, system-ui, -apple-system, sans-serif",
          // The single scale knob: card font-size tracks container width.
          fontSize: "clamp(8.5px, 2.55cqw, 12.5px)",
        }}
      >
        {/* Minimal: a 5px accent bar down the left edge. */}
        {!isFoil && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 5,
              background: accent,
            }}
          />
        )}

        <div
          style={{
            position: "relative",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: "1.55em 1.8em",
            boxSizing: "border-box",
          }}
        >
          {/* ── TOP ROW: brand (left) · eyebrow (right) ── */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "1em",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.7em",
                minWidth: 0,
              }}
            >
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt=""
                  style={{
                    height: "2.5em",
                    maxWidth: "8em",
                    objectFit: "contain",
                    display: "block",
                  }}
                />
              ) : (
                <div
                  aria-hidden
                  style={{
                    width: "2.5em",
                    height: "2.5em",
                    borderRadius: "0.55em",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    background: isFoil ? "transparent" : accent,
                    border: isFoil ? `1px solid ${accent}` : "none",
                    color: isFoil ? accent : tk.paper,
                  }}
                >
                  <span
                    style={{ fontSize: "0.92em", fontWeight: 700, letterSpacing: "0.02em" }}
                  >
                    {monoLetters}
                  </span>
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "1.12em",
                    fontWeight: 600,
                    lineHeight: 1.1,
                    letterSpacing: "-0.01em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {businessName}
                </div>
                {address && (
                  <div
                    style={{
                      fontSize: "0.82em",
                      color: tk.muted,
                      marginTop: "0.28em",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {address}
                  </div>
                )}
              </div>
            </div>

            <div
              style={{
                fontSize: "0.82em",
                fontWeight: 600,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: accent,
                whiteSpace: "nowrap",
                paddingTop: "0.35em",
                flexShrink: 0,
              }}
            >
              Gavekort
            </div>
          </div>

          {/* ── MID: the amount hero + to/from + note ── */}
          <div
            style={{
              flexGrow: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "0.45em 0",
              minHeight: 0,
            }}
          >
            {/* Foil: a thin gold hairline above the amount. */}
            {isFoil && (
              <div
                aria-hidden
                style={{
                  height: 1,
                  width: "2.6em",
                  background: accent,
                  opacity: 0.7,
                  marginBottom: "0.7em",
                }}
              />
            )}
            <div style={{ display: "flex", alignItems: "baseline", minWidth: 0 }}>
              <span
                style={{
                  fontSize: "4.3em",
                  fontWeight: 700,
                  lineHeight: 1,
                  letterSpacing: "-0.025em",
                  whiteSpace: "nowrap",
                }}
              >
                {amountNum}
              </span>
              {amountSuffix && (
                <span
                  style={{
                    fontSize: "1.8em", // ~0.42 of the hero number
                    fontWeight: 500,
                    color: tk.muted,
                    marginLeft: "0.3em",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {amountSuffix}
                </span>
              )}
            </div>

            {toFromLine && (
              <div
                style={{
                  fontSize: "0.9em",
                  color: tk.muted,
                  marginTop: "0.7em",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {toFromLine}
              </div>
            )}

            {note && (
              <div
                style={{
                  fontSize: "0.92em",
                  fontStyle: "italic",
                  color: tk.note,
                  marginTop: toFromLine ? "0.35em" : "0.7em",
                  lineHeight: 1.35,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {note}
              </div>
            )}
          </div>

          {/* ── BOTTOM ROW: redeem block (left) · QR (right) ── */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: "1em",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: "0.68em",
                  fontWeight: 600,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: tk.muted,
                }}
              >
                Indløs i butik
              </div>
              <div
                style={{
                  fontFamily:
                    "'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "1.15em",
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  marginTop: "0.32em",
                  color: tk.ink,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {code}
              </div>
              {finePrint && (
                <div
                  style={{
                    fontSize: "0.72em",
                    color: tk.muted,
                    marginTop: "0.4em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {finePrint}
                </div>
              )}
            </div>

            {qrValue && (
              <div
                style={{
                  flexShrink: 0,
                  background: tk.qrChip,
                  padding: "0.36em",
                  borderRadius: "0.4em",
                  lineHeight: 0,
                }}
              >
                <QRCodeSVG
                  value={qrValue}
                  size={56}
                  level="M"
                  fgColor={tk.qrFg}
                  bgColor={tk.qrChip}
                  marginSize={0}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
