# Kill criterion — Vagtplan concierge week

**Written 6 Sep 2026, before the concierge week runs.** That ordering is the
whole point. A criterion written afterwards is a rationalisation; this one is
written while the answer is still unknown, so it can actually bind.

Owner: Manoj. Nobody else can invoke or waive it.

---

## The number that prompted this

Measured 6 Sep 2026 against production, founder and internal accounts excluded
via `services/internal_accounts` (the same list the thesis export uses).
Reproduce it any time with `GET /api/admin/activation`.

| Step | Venues | of 51 |
|---|---:|---:|
| Rostered a shift | 2 | 3.9% |
| Published a shift (staff could see it) | 1 | 2.0% |
| A staff member opened their link | **0** | 0% |
| A staff member clocked in | **0** | 0% |
| Owner exported hours | **0** | 0% |

Every clock-in and every opened staff link in the database belongs to a founder
or internal account. Of the two external venues that rostered anything, one is
a junk signup (`business_name` "asfasgfa", one shift).

So: after roughly six months and 51 external signups, **no venue outside this
building has ever run a shift through BonBox.** The Scheduler app is live on the
App Store, the loop is built end to end, and it has never been used by a
stranger.

That is not a product-quality claim. It is a distribution claim: nothing has
ever put the product in front of a venue that had a reason to try it. Which is
exactly what the concierge week is for — and exactly why it needs a stop
condition agreed in advance.

---

## The concierge week

**What:** five Danish ICP venues (5–12 staff, owner-operated, under 10M DKK
turnover — see `strategy_dk_market_verdict`). Each is offered a free month with
me doing the setup by hand: I build their first week's roster from whatever they
use now (paper, Excel, a WhatsApp group), hand out the staff links myself, and
sit through one real service.

**Not** a demo, not a trial signup, not a landing page. Hand-held, in person or
over a call, one venue at a time.

**When:** the week beginning **Monday 14 Sep 2026**. Outcome assessed
**Monday 28 Sep 2026** — two weeks after the last hand-off, so a venue has had
time to run a second week on its own.

---

## The criterion

> **If zero of the five venues accepts the free hand-held month, Vagtplan
> development freezes.**

"Accepts" means: the venue agrees to the setup and I complete it. It does not
require them to still be using it two weeks later — that is a separate, softer
signal recorded below, not part of the gate.

Freeze means: no new Vagtplan features, no polish passes, no App Store builds
for the Scheduler. Bug fixes for anyone already using it continue. The effort
moves to whichever pillar can show a stranger doing something unprompted.

### Why zero, and not "fewer than three"

Because zero is unarguable. Any threshold above zero invites a conversation
about whether venue #2 half-counted, and that conversation always resolves in
favour of continuing — it is the same reflex that produced six months of
building on a funnel nobody had measured. One acceptance out of five is a weak
but real signal that the offer is not absurd; zero out of five, with me doing
all the work for free, means the problem is not the software.

### What does NOT count as passing

- A venue saying "sounds interesting, send me something."
- A signup with no completed setup.
- Any account I control, including demo and App Store review accounts.
- A venue accepting and then never having a staff member open a link. That
  counts as an acceptance for the gate — the gate is about willingness to try —
  but it is recorded, and five of those would be its own finding.

---

## What gets recorded, per venue

Kept as plain notes, not in the app:

1. Vertical, headcount, what they schedule with today.
2. Whether they accepted. If no — the sentence they actually said, verbatim.
3. If yes: did a staff member open the link? clock in? did the owner build week
   two without me?
4. The first thing they asked for that does not exist.
5. The first thing they were visibly confused by.

Points 4 and 5 are the return on the week regardless of the gate. Even five
refusals produce five verbatim reasons, which is five more than exist today.

---

## If it passes

The gate passing is not a mandate to keep building the same way. The next
question is whether any accepting venue runs a second week unassisted. That is
the real retention signal, and it gets its own criterion written before its own
window — same discipline, same file.

---

Related: [[strategy_market_entry_punchlist]] (the transaction layer is the other
gating theme), [[finding_restaurant_audience_gap]], [[strategy_dk_market_verdict]].
