# BONBOX — REELS PRODUCTION PACK (FINAL)
**Vertical 9:16 · 1080×1920 · sound OFF by design · Danish primary**
All fatal flaws from the judging round are fixed below. Every number, tier and UI string in this pack was verified against the codebase; sources are cited in §5.

---

## 1. THE TWO REELS

---

## REEL A — "SKAT bliver en linje"
**Premise:** The one word a Danish owner dreads, demoted to an ordinary row inside the app — by a product that visibly refuses to file for them.

**What changed vs. the judged draft:** the four-word reading-homework open is gone (one word, held 1.0s, demoted by 1.6s — the match-cut is now the hook, not the payoff); the daily close is shown as the real five-step wizard, never "one tap"; the end card now attributes what was shown to the tier that actually delivers it and labels 129 as a founding price.

**Runtime 23.0s**

| # | Time | Shot | On-screen DA | On-screen EN |
|---|------|------|--------------|--------------|
| A1 | 0.0–1.0 | Full-bleed paper-white card. `SKAT` in gray-900 Inter Bold, optical centre, filling ~80% of width. Absolutely static. No logo. | **SKAT** | **SKAT** |
| A2 | 1.0–1.6 | Match-cut: the word scales down *in place* and lands as an ordinary row label inside the real app. One continuous scale, 0.6s, ease-out. | Herinde er det bare en linje. | In here it's just a row. |
| A3 | 1.6–4.0 | Pull back 25%: phone in one hand, closed café at night, chairs up, one pendant. Screen is the brightest object in frame. Visible in the list: MOMS · Kasserapport · Revisor — the other three dreaded words, already just rows. | *(no overlay — let the rows read)* | *(none)* |
| A4 | 4.0–8.5 | Real daily close, unbroken: step chip reads **Trin 3 af 5 — Kassetælling**, thumb types counted cash; cut forward to **Trin 5 — Gennemgang**; lock. Card resolves to "Aftenens kassebon — låst kl. 23.47". Then hold dead still 0.6s. | Tæl kassen. Fem trin. Så er dagen låst. | Count the till. Five steps. The day is locked. |
| A5 | 8.5–12.0 | MOMS period view. The already-locked days sit as rows; thumb scrolls once; the MOMS figure resolves from those rows. The app's own line **"Kun estimater. Kontakt en revisor for officiel indberetning."** stays legible in frame. | MOMS bygger på de dage, du har låst. | Your MOMS is built from days you already locked. |
| A6 | 12.0–16.0 | Kasserapport export. Tap; the generated document appears: periode, bilagsnr, signatur-linje, kasse-/kort-/MobilePay-split. Slow thumb scroll so it reads as a document, not a graphic. | Revisor får en fil. Ikke en kasse med bilag. | Your revisor gets a file. Not a box of receipts. |
| A7 | 16.0–19.5 | Honesty beat. iOS share sheet open with the PDF — **nothing is pressed**. Hand lowers the phone flat, screen still lit. No send-to-SKAT control exists anywhere in frame. | Vi gør tallene klar. Du indberetter selv til SKAT. | We get the numbers ready. You file to SKAT yourself. |
| A8 | 19.5–23.0 | Cut to white. Static end card, 3.5s. Only motion: one green dot fading in. | *(see end frame)* | *(see end frame)* |

**End frame A** — paper-white (#FAFAF9), gray-900 Inter, generous margin, optically centred above middle:
> **Bygget til danske regler.**
> Ikke oversat til dem.
>
> *small, quiet, bottom third:*
> Gratis plan: 7 dages revisor-udtræk. Måneds- og kvartalsudtræk til revisor: Starter 129 kr/md (grundlæggerpris, normalt 199).
> bonbox.dk

BonBox wordmark small bottom-left, one green dot beside it. No button, no arrow, no "swipe up".
EN cut swaps only the two headline lines and the price note; **MOMS, kasserapport, revisor, SKAT stay Danish.**

---

## REEL B — "−25 kr"
**Premise:** Business software shows its own bad number, declines to fix it, and prints it on the document the revisor receives.

**What changed vs. the judged draft:** "Ét tryk", the running timer, "Ét take. Ingen klip." and "14 sekunder" are **cut entirely** — the shipped close is a five-step wizard, so a one-tap claim could only be filmed by staging it, and the burned elapsed time was an implied time-saving statistic. The shortfall is now frame one instead of second four.

**Runtime 21.0s**

| # | Time | Shot | On-screen DA | On-screen EN |
|---|------|------|--------------|--------------|
| B1 | 0.0–1.2 | Full-bleed, extreme crop of the real difference row: **−25,00 kr** in the app's amber attention state, filling the frame. Overlay lands at 0.4s. | Kassen stemmer ikke. | The till doesn't balance. |
| B2 | 1.2–3.0 | Pull out: it's a phone in one hand on a café counter, 23.41 on the status bar, counted notes and the open drawer at the edge of frame. | Den skjuler det ikke. | It doesn't hide it. |
| B3 | 3.0–6.5 | Real capture, no cut inside: the thumb hovers over the −25, and does nothing. Nothing recounted, deleted or edited. Step chip **Trin 3 af 5** visible. | Ingen retter det bagefter. | Nobody quietly fixes it later. |
| B4 | 6.5–10.0 | The rest of the real wizard: tips step, then **Trin 5 — Gennemgang** with Difference −25,00 kr in the summary, then lock. | Fem trin. Så er dagen låst. | Five steps. The day is locked. |
| B5 | 10.0–14.0 | The generated kasserapport, scrolled slowly. Hold on the line **Kassedifference (+/-) −25,00 kr** long enough to read. | De 25 kr står også i kasserapporten. | The 25 kr is on the kasserapport too. |
| B6 | 14.0–17.5 | Share sheet with the PDF. Nothing pressed. Phone lowered to the counter, screen still lit. | Vi klargør. Du sender selv til SKAT. | We prepare it. You file to SKAT yourself. |
| B7 | 17.5–21.0 | Cut to white end card, 3.5s static. | *(see end frame)* | *(see end frame)* |

**End frame B** — paper-white, gray-900 Inter:
> **Vi viser også det, der ikke passer.**
>
> *small:* Dagens kasserapport — også på den gratis plan. Måneds- og kvartalsudtræk til revisor: Starter 129 kr/md (grundlæggerpris, normalt 199).
> bonbox.dk

Wordmark bottom-left, one green dot. Nothing moves.

---

## 2. READY-TO-PASTE GENERATION PROMPTS

**Governing rule — read before generating anything:** any frame in which a viewer can read product UI, a label, or a figure must be a **REAL SCREEN RECORDING** of the shipped app. Generators may produce only the room, hand, counter and light, with the phone screen shot as a blank tracking target that the real recording is composited into 1:1 — no retiming, no re-typesetting, no invented numbers, no re-drawn UI. A generated screen showing invented figures is precisely the dishonesty this brand exists to refuse.

### Reel A

**A1 — GENERATED (typography card, no UI).**
> Pure design frame, no photography. Flat paper-white field #FAFAF9, absolutely even, no gradient, no vignette, no texture. Single word "SKAT" in Inter Bold, near-black #111827, letter-spacing tight, cap height filling roughly 80% of the frame width, optically centred slightly above the vertical middle. Vertical 9:16, 1080×1920. Completely static, no motion, no shadow, no glow, no logo, no decoration, no red, no seal, no envelope, no official crest. Mood: calm, institutional restraint, Danish graphic design. Negative: drama, gradients, 3D, glossy, stock-photo, warning icons, exclamation marks.

**A2 — REAL SCREEN RECORDING + generated nothing.** Executed as a post move: scale the A1 word down along a matched path until it registers pixel-exactly onto the real row label in the recording. No generator involvement.

**A3 — GENERATED PLATE + REAL SCREEN COMPOSITE.**
> Photoreal cinematic still, vertical 9:16. Interior of a small Danish café after closing, seen at counter height. Chairs upside-down on tables in soft background bokeh, one warm pendant lamp far back, everything else in low warm shadow. Foreground: an anonymous adult hand holding a modern smartphone at a natural angle, thumb resting near the lower edge; the phone screen is a flat neutral grey rectangle (tracking plate, to be replaced). Screen is the brightest object in the composition and spills cool light onto the fingers. 35mm equivalent, shallow depth of field, natural handheld micro-motion, no camera move. Colour: warm dark wood and near-black, deliberately desaturated, no teal-orange grade. Mood: quiet competence at the end of a long shift, not sadness. No face, no logo on the counter, no venue signage, no branded cups. Negative: styled artisan-café clichés, latte art, neon, smiling model, stock lifestyle, lens flare.

**A4, A5, A6, A7 — REAL SCREEN RECORDING (mandatory).** No generation. A7's plate may reuse A3's room; the screen content and the share sheet must be the genuine capture, unedited.

**A8 — GENERATED (typography card, no UI).**
> Flat paper-white #FAFAF9 field, vertical 9:16, huge margins. Two lines of Inter in near-black #111827: a large semibold line and a lighter line beneath at ~45% size, left-aligned block optically centred. Small quiet type block in the lower third at ~28% size, generous line spacing. One 12px solid green dot as the only colour in the frame, placed to the right of a small wordmark bottom-left. Absolutely static, no animation except the dot fading in. Mood: last page of a design manual. Negative: buttons, arrows, badges, app-store icons, bursts, drop shadows, gradients, stock photography.

### Reel B

**B1 — REAL SCREEN RECORDING (mandatory).** Crop/zoom into the genuine capture. Do not re-typeset the number, do not recolour the amber, do not composite a designed "−25 kr" graphic.

**B2 — GENERATED PLATE + REAL SCREEN COMPOSITE.**
> Photoreal cinematic still, vertical 9:16, slight overhead three-quarter angle. A café service counter at night: counted banknotes squared into a small stack, an open cash drawer just clipping the frame edge, a wiped steel surface catching one warm overhead light. An anonymous adult hand holds a smartphone one-handed above the counter; the screen is a flat neutral grey tracking plate and is the brightest thing in frame. 40mm equivalent, shallow depth, locked-off camera, only natural hand micro-movement. Palette: warm near-black, brushed steel, muted note-colour, no saturated accents anywhere. Mood: end of service, focused, unhurried. No face, no venue branding, no receipts arranged decoratively. Negative: cash-fan clichés, money-flying imagery, green tint, hero lighting, stock-business composition.

**B3, B4, B5, B6 — REAL SCREEN RECORDING (mandatory).** No generation, no speed-ramp inside a step, no invented document.

**B7 — GENERATED (typography card).** Same prompt as A8 with the Reel B copy.

---

## 3. SHOT-CAPTURE CHECKLIST (real app)

**Device & capture**
- iPhone 14/15 (6.1"), iOS screen recording at native res, export ≥1170×2532, downscale to 1080×1920 in edit.
- Display: standard zoom (no accessibility text scaling), brightness 100%, True Tone off, dark mode **off** (product is white/gray-900).
- Device language **Dansk (Danmark)**, region Denmark — number format must render `4.850,00 kr`, never `4,850`.
- **Do Not Disturb ON.** One reservation banner with a real guest name is a GDPR incident, not a reshoot.
- Set the device clock to ~23.41 before recording, or shoot late. The status-bar time, the "låst kl." stamp and the room's light level must agree.

**Account state**
- A dedicated **demo/test owner account** — never the live external customer, never a real staff name, CVR, or guest name in any frame.
- `business_type = cafe`. Plan = **Starter** (film on the tier the end cards attribute the shown flow to; a Free account cannot produce the month-range revisor export and would make the reel lie).
- Seed **14–21 previously locked days** at small-café scale (four-figure daily revenue) so the MOMS view has genuine rows and the split has a real historical basis. No round numbers like 10.000,00.

**Capture order (one session, ~30 min)**
1. **Home / SKAT-MOMS list at rest** — hold 4s, no touch. → A2, A3.
2. **Daily close, full run, unbroken:** Trin 1 omsætning → Trin 2 betalingsmetoder → Trin 3 kassetælling (type `4.850`; expected total must make the difference land at **−25,00**) → let the difference row resolve and **hold 3s with the thumb hovering, touching nothing** → Trin 4 drikkepenge → Trin 5 gennemgang → lock. → B1, B3, B4, A4.
   - If the anomaly double-check dialog appears, **film it and keep it.** Do not re-run to avoid it.
3. **Locked state card** — hold 3s on "Aftenens kassebon — låst kl. …". → A4 tail.
4. **MOMS period view** — one slow scroll; make sure the disclaimer line "Kun estimater. Kontakt en revisor for officiel indberetning." is in frame and legible. → A5.
5. **Kasserapport PDF** — open, scroll slowly, **verify the line `Kassedifference (+/-) −25,00 kr` is actually on the document.** If it is not there, cut B5 and Reel B's spine with it. → A6, B5.
6. **Share sheet** — open it, hold 3s, **press nothing**, lower the phone. → A7, B6.

**Pre-delivery verification**
- No frame contains a send/submit-to-SKAT control, a bank logo, or any "synkroniseret" chip.
- Every overlay sits inside the middle 80% vertically, clear of the top 130px and bottom 320px; check the 4:5 and 1:1 auto-crops separately.
- Native Danish read-through of all burned copy before publish; `MOMS` uppercase everywhere, `kasserapport`/`revisor`/`SKAT` untranslated in the EN cut.
- Mute the master track and watch both reels end to end. If any beat stops making sense, that beat is broken.

---

## 4. CAPTIONS + HASHTAGS

**Instagram — Reel A**
> Fire ord, du helst vil være fri for: MOMS. Kasserapport. Revisor. SKAT.
> I BonBox er de bare linjer, du lukker én gang om dagen.
> Vi gør tallene klar. Du indberetter selv til SKAT — det gør vi ikke for dig, og vi lader som om.
> Alt i videoen er optaget i den rigtige app.
> bonbox.dk
>
> Four words you'd rather avoid. In BonBox they're just rows. We get the numbers ready — you file to SKAT yourself.

`#kasserapport #MOMS #revisor #småvirksomhed #cafédrift #restaurantdrift #iværksætterdk #bogføring #dagsafslutning #dansk`

**Instagram — Reel B**
> Kassen manglede 25 kr. Vi rettede det ikke.
> Differencen står i appen — og den står på kasserapporten, som din revisor får.
> Software, der skjuler sine egne skæve tal, er ikke et regnskab. Det er en fornemmelse.
> Optaget i den rigtige app, med en rigtig difference.
> bonbox.dk
>
> The till was 25 kr short. We didn't fix it. The difference is in the app — and on the kasserapport your revisor receives.

`#kasserapport #kassedifference #revisor #MOMS #restaurantdrift #cafédrift #småvirksomhed #bogføring #dansk`

**Facebook — Reel A** (longer, same claims)
> Kl. 23.30 sidder du med dagen, ikke med regnskabet.
> BonBox er bagkontoret til den lille danske café og restaurant: tæl kassen, luk dagen i fem trin, og kasserapporten ligger klar til din revisor. MOMS-tallene bygger på de dage, du allerede har låst.
> Én ting gør vi ikke: vi indberetter ikke til SKAT for dig. Vi gør tallene klar — du sender selv.
> Gratis plan findes (7 dages revisor-udtræk). Måneds- og kvartalsudtræk til revisor er på Starter, 129 kr/md i grundlæggerpris, normalt 199 kr/md.
> bonbox.dk

`#småvirksomhed #kasserapport #revisor`

**Facebook — Reel B**
> Den her reklame viser vores software vise et dårligt tal.
> Kassen manglede 25 kr. Appen viser det, retter det ikke — og differencen står trykt på den kasserapport, revisor får.
> Det er hele pointen: du skal kunne stole på tallet, også når det er skævt.
> Optaget i den rigtige app. bonbox.dk

`#kasserapport #kassedifference #revisor`

---

## 5. CLAIMS LEDGER

| # | Claim (where) | Verdict | Justification |
|---|---|---|---|
| 1 | "Herinde er det bare en linje" (A2) | **KEEP** | Visual, not a claim; must land on the real screen recording. |
| 2 | "Tæl kassen. Fem trin. Så er dagen låst." (A4/B4) | **KEEP** | Close is a five-step wizard (revenue → payments → cash → tips → review) with a visible step counter: `/Users/nova/Downloads/Project_CHL/smallbiz-dashboard/frontend/src/pages/DailyClosePage.jsx:2296-2300`. Filming it as five steps is what the product does. |
| 3 | "Ét tryk" / running timer / "14 sekunder" / "Ét take. Ingen klip." | **CUT** | Cannot be shot without pre-filling steps off-camera; a flagged close also forces an extra acknowledgement (`backend/app/routers/daily_close.py:968`). The burned elapsed time was an implied time-saving statistic. Cut, not softened. |
| 4 | "MOMS bygger på de dage, du har låst." (A5) | **KEEP** | MOMS view aggregates from locked closes; the app's own estimate disclaimer stays in frame (`frontend/src/hooks/useLanguage.jsx:12600`). |
| 5 | "Kun estimater. Kontakt en revisor for officiel indberetning." (shown in-frame, A5) | **KEEP** | Verbatim shipped product string, same file:line. Filmed, not overlaid. |
| 6 | "Revisor får en fil. Ikke en kasse med bilag." (A6) | **KEEP** | Kasserapport PDF with periode/bilagsnr/signatur is generated by `backend/app/services/kasserapport_pdf.py`. |
| 7 | "Vi gør tallene klar. Du indberetter selv til SKAT." (A7/B6) | **KEEP** | Matches shipped copy: "BonBox indberetter ikke til SKAT — du sender selv; beløbet er et estimat" (`useLanguage.jsx:12947`). Enforced in-frame by the absence of any submit control. |
| 8 | "Kassen stemmer ikke." / "−25 kr" (B1) | **KEEP** | `cash_difference` is computed, persisted and rendered: `backend/app/routers/daily_close.py:920, 1006`. Must be a real close, not a designed graphic. |
| 9 | "De 25 kr står også i kasserapporten." (B5) | **KEEP — verify on set** | `kasserapport_pdf.py:443` prints `Kassedifference (+/-)`. Confirm on the actual generated PDF before the shoot; if absent, cut B5 and the reel. |
| 10 | "Ingen retter det bagefter." (B3) | **KEEP** | Describes what is on screen — the difference persists into the locked record and onto the document. |
| 11 | "Gratis plan: 7 dages revisor-udtræk" (End A) | **KEEP** | Free `daily_close_export_days: 7` (`backend/app/services/billing.py:157`). |
| 12 | "Måneds- og kvartalsudtræk til revisor: Starter" (End A/B) | **KEEP** | Starter `daily_close_export_days: 31` (`billing.py:278`), Pro 366 (`billing.py:348`); accountant CSV templates are Starter+ (`billing.py:456, 472, 793`). This is the fix for the judged flaw of implying the whole flow was free. |
| 13 | "Starter 129 kr/md (grundlæggerpris, normalt 199)" | **KEEP** | 129/249 are founding prices; list is 199/349 (`billing.py:10-11`). Printing 129 bare, as if standard, was the flaw — labelled now. |
| 14 | "Dagens kasserapport — også på den gratis plan." (End B) | **KEEP** | Free retains the manual Send-til-revisor path after locking (`useLanguage.jsx:10520`); only auto-send and multi-month spans are paid. |
| 15 | Receipt-photo beat ("it drops in with the amount already read off it") | **CUT from both reels** | The real flow suggests and the owner confirms: `suggested_amount`, `all_amounts_found`, and explicit failure states in `frontend/src/components/ReceiptCapture.jsx:169-173, 562-607`. If ever filmed, it must show the detected-amount confirm step and the thumb confirming — not a silent auto-fill. |
| 16 | Any adoption, time-saving or customer-count figure | **CUT** | One live external customer. Any such number is fabrication. Nothing in either reel or caption states one. |
| 17 | Bank sync / live balance | **CUT — and staged as absence** | No PSD2 feed exists; balances are typed. No balance, bank logo or "synkroniseret" chip may appear in any frame. |
| 18 | Testimonial / named owner / venue branding | **CUT** | No face, no venue signage, no quoted customer anywhere. Hands are anonymous. |
| 19 | Competitor name, price or comparison | **CUT** | Never quoted, implied or shown. "Ikke oversat til dem" refers to foreign tooling as a category; if any cut shows a rival product, it is out. |
| 20 | "Bygget til danske regler." (End A) | **KEEP** | Product is built around MOMS/kasserapport/SKAT-shaped DK records — a description of the build, not a certification claim. Must never drift to "godkendt af SKAT". |
