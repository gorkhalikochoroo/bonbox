# BonBox — Prioritised Roadmap (effortless-consolidation thesis)

*Last updated: 2026-05-30. Sequences the strategy brainstorm by trust→save→grow impact, effort, and dependency. DK-first restaurants.*

---

## Thesis
Win the **whole-business graph**: be the only system holding *demand × cost × revenue × cash* together, daily. Everything below either (a) **deepens** that graph into effortless automation, or (b) **protects the two inputs that feed it** — the daily **close** (revenue truth) and **reservations** (demand). Lose either input and the flagship moats (Labour-%, fill-empty-tables) degrade. Protect them above all.

Guardrails baked into every item:
- **Prepare → owner approves → then act.** Anything touching SKAT/eIndkomst/money is one-tap-with-a-stop-window, never silent. (Honest-claims doctrine.)
- **Accountant-grade artifacts** (bilagsnummer, doc-hash, signature, §10, provenance) on every revisor-bound output.
- **GDPR/Art.9** on guest + staff data; consent-gated outreach; retention-bounded.

---

## Phase 0 — Shipped (the foundation the rest builds on)
Daily close / kasserapport (Z-report OCR) · bank reconciliation (PSD2) · OCR receipts + DK supplier auto-detect · MOMS countdown + Tax Autopilot · faktura + kreditnota · payroll *lønhjælp* · staff schedule + hours + tips · inventory + expiry · **reservations + SMS reminders (Starter+Pro)** · event-booking · accountant read-only login + one-tap month-end package · 9am AI brief.

> These already exist — the roadmap is largely **wiring them together**, which is why early phases are mostly orchestration, not net-new domains.

---

## Phase 1 — Deepen the core: "books that close themselves" (TRUST + SAVE)
The biggest trust + hard-savings win, and mostly orchestration of Phase-0 pieces.

| Item | Why (pillar) | Effort | Notes / dependency |
|---|---|---|---|
| **Self-closing books** — auto-draft postings on every close-lock + bank-sync, VAT-coded, reconciled-to-bank nightly | Trust ★★★ · Save ★★ | **L** | The spine. Reuses close + recon + OCR. |
| **One-tap month → revisor** — auto-compile the reconciled month (bilag, bank, MOMS, payroll, P&L, gaps flagged) and send | Trust ★★★ · Save ★★★ | **M** | Reuses accountant-grade artifact builders + revisor login. The dread-killer. |
| **e-conomic / Dinero / Billy native sync** | Trust ★★★ (no lock-in + revisor sees data) · Save ★★ | **M** | The stickiness layer — switching cost = audit risk. Unblocks the revisor-as-referrer channel. |

**Sequencing:** one-tap month first (fastest, reuses most), then self-closing books, then accounting sync. Ship the **first-week "it reconciled itself / MOMS already sitting there" moments** here — they earn trust fastest.

---

## Phase 2 — The unique flagships (the "only-we-can" + the growth headline)
| Item | Why (pillar) | Effort | Notes / dependency |
|---|---|---|---|
| **Labour-% autopilot** — live cost-of-staff vs forecast revenue → prescriptive shift trims | Save ★★★ (biggest lever) · Grow ★★ | **M** | Structurally impossible for rivals (needs demand+cost+revenue). The "wow" demo + Pro hook. Owner must act — surface the kr, they decide. |
| **Fill-empty-tables** — forward-gap detection + 1-tap lapsed-guest win-back / slow-night push | Grow ★★★ | **M** | The single growth story owners *need*. Pure incremental revenue. Needs reservations + guest consent ledger. |
| **9am brief = decision coach** — "do these 3 things today," one-tap each | Grow ★★ (adoption multiplier) | **S–M** | Turns every other lever into action. Its KPI is *actions approved/week*, not kr. |

**Sequencing:** Labour-% first (proves the moat, drives Pro), then fill-empty-tables (the revenue story), with the brief upgraded as the surfacing layer that makes both *happen*.

---

## Phase 3 — Expand + compound (category swing + network moat)
| Item | Why (pillar) | Effort | Notes / risk |
|---|---|---|---|
| **Egenkontrol / HACCP autolog** — temp/cleaning logs tied to who's clocked in; inspection-ready PDF | Trust ★★ · Save ★★ · daily habit | **M (L done right)** | Clean unowned gap, mandatory, fear-driven, multi-times-a-day engagement. **Heavy to do right** (risk analysis, ideally Bluetooth fridge sensors). A thin clone that fails a kontrol is worse than none — only build if done properly. |
| **Deposits / no-show card-hold** | Save ★★ · Grow ★ | **M–L** | The real no-show cure. Needs charge-on-booking (Stripe/Reepay) + refund + MOMS treatment. |
| **Benchmarking network** — "cafés like you run labour at 27%, you're at 33%" | Trust ★★ (wake-up) · retention · long-term moat | **M (needs scale)** | ~0 direct kr but a true data-network effect that widens with every venue. Airtight anonymisation (k-anonymity). The *endgame* moat. |
| **Cash/shrinkage sentinel** — covers × stock × sales × bank anomaly watch | Save ★★ | **M** | Pure cross-silo; catches slow bleeds (food-cost creep, till variance) before year-end. |

---

## DK "boring but sticky" integration backlog (lock-in plumbing)
Trust-gated + slow + compounding — competitors can't sprint these. Sequence: **accounting sync → MitID → MOMS/eIndkomst submission helpers → payment rails (Betalingsservice/Leverandørservice)**. Plus NemHandel/OIOUBL e-invoice ingest (upgrades OCR to structured supplier data), Feriekonto, NemKonto. Each converts BonBox from "an app you use" into "the rail your money + compliance run on."

---

## What NOT to build (stay honest to the wedge)
- **A POS** (in-service tabs/kitchen-fire) — stay the brain above the till.
- **A diner marketplace** (OpenTable rival) — convert their own traffic, don't sell demand-gen.
- **Khata / customer-credit ledger** — irrelevant for Copenhagen.
- **Silent auto-filing** to SKAT — always owner-approved.

## One-line sequencing rationale
Phase 1 makes them **trust** us and **pay for itself**; Phase 2 makes us **uniquely indispensable** and **grows** them; Phase 3 **expands the category** and **compounds the moat** — all while fiercely protecting the close + reservations inputs that feed it.
