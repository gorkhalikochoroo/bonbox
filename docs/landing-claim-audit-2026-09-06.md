# Landing page vs. the code — audit, 6 Sep 2026

Every promise on the "Six jobs. One system." section traced to the code that has
to keep it. 6 finder agents, every alleged gap then handed to 2 adversarial
verifiers whose instruction was to **refute** it; only gaps both declined to
refute are listed. 24 alleged → **15 refuted** → **9 confirmed**. The three
highest-consequence findings were then re-verified by hand against production.

**The pattern is not "features are missing."** Every noun on that page is built
and reachable. The defect class is narrower and more fixable: *the page states a
capability without the limit that stops it.* Most of these are a copy change or
a surfaced number, not a rebuild.

---

## Ranked by what a venue would actually feel

### 1. The public booking page silently stops taking bookings on Free — CONFIRMED

| | |
|---|---|
| Page says | "a public page guests book through" |
| Reality | Free plan caps **20 reservations/calendar month**. The 21st gets `409 {"error":"not_accepting"}` and the guest sees *"Stedet tager ikke imod flere reservationer lige nu."* |
| Proof | `billing.py:238` (`"reservations_per_month": 20`; trial/starter/pro are `-1` at :324/:369/:417), enforced `public_reservations.py:870` |

Three things make this the worst one on the list:

- **The trial hides it.** New venues resolve to `PLAN_CAPS["trial"]` — unlimited.
  It works perfectly for 14 days, then the cap engages on day 15.
- **Availability never checks the cap.** `public_reservations.py:264-327` computes
  slots without calling `at_cap()`. So the date strip shows the evening open, the
  time list still shows "2 left", the guest picks a table, types name, phone,
  allergies — and is refused *on the final tap*. The client's 409 handler only
  returns to step 1 for `slot_unavailable`/`stylist_unavailable`
  (`ReservationPublicPage.jsx:929-935`), so `not_accepting` leaves them on a
  filled-in dead form.
- **Nobody is told.** `GET /reservations/settings` returns `resources_cap` but not
  `reservations_per_month` usage or ceiling, and no frontend file reads that key.
  The job written to catch dead booking pages (`public_surface_monitor_job.py`)
  doesn't check the cap either, and emails BonBox admins rather than the venue —
  so it reports a cap-dead page as healthy.
- The landing pricing table lists **no reservation feature in any tier**, so there
  is no surface where a reader could learn the ceiling exists.

A venue taking one booking a day hits this in three weeks. Nothing in the product
tells them their booking page went dark.

### 2. Waste is booked as a VAT-deductible purchase — CONFIRMED

| | |
|---|---|
| Page says | "a waste tracker — so the milk that goes out on Thursday shows up in Thursday's numbers" |
| Reality | `waste.py:43-53` writes a real `Expense` in a category named "Waste" with `payment_method="card"`. `fradrag_factor()` returns **1.0 for unknown categories** (`dk_fradrag.py:56-63`) — "Waste" matches neither the zero nor the quarter list — so it claims full 25% købsmoms. |

A write-off is not a purchase. Either the goods were already expensed when they
came in (double deduction) or they weren't (VAT claimed with no supplier bilag).
Both are wrong on a MOMS-angivelse.

**25 rows already in production** — 22 on the demo seed, 2 founder, 1 external
(250 kr). Not yet material, but live and waiting for the first venue that uses it.

Also confirmed on this card: neither waste path uses the business-day convention.
`WastePage.jsx:41` seeds from `localIso()` while `businessTodayIso()` sits unused
in the same module; backend defaults to `date.today()` (UTC). Revenue for the same
service uses `business_today_local`. So a Copenhagen venue binning milk at 01:00
books the takings to Thursday and the milk to Friday — the exact thing the
sentence promises not to happen.

### 3. The owner's grid hides a second same-day shift — CONFIRMED

`getShiftForCell` uses `shifts.find()` (`StaffSchedulePage.jsx:1565-1570`), so a
cell renders exactly **one** shift per person per day. The second is invisible and
cannot be opened, moved or deleted. Meanwhile the Vagtplan Shield chip beside the
same name comes from the server and counts *all* shifts, and the publish sheet
counts the full array. Result on screen: Timer column reads 18.8t, chip reads 25t,
publish sheet says 8 drafts over 7 visible blocks. **The staff app shows the hidden
shift** (`StaffPortalPage.jsx:1689-1699`).

Reachable three ways in production: a staffer claiming an open shift, copy-week,
and the Add-Shift modal's free staff+date picker — the backend explicitly allows
non-overlapping same-day shifts (`staff.py:2187-2192`).

### 4. Publish is unbounded; the Scheduler app shows two weeks — CONFIRMED

`staff_portal.py:597` returns `week_start .. +20 days`; the app renders only
`this`/`next` (`StaffPortalPage.jsx:1643`), and week 3 collapses to the bare words
"Coming up" with no dates or tap target (:2508-2510). `publish_week` has **no upper
date bound**.

So: owner publishes the October rota in early September, the sheet says *"12 shifts
are now live on your team's schedule. 6 staff notified."*, staff get the email, open
the app, tap Next week — nothing. They text the manager. Which is the behaviour the
app is sold to stop.

### 5. The revisor ZIP computes MOMS with a second, naive engine — CONFIRMED

`export_moms_summary()` (`bookkeeping_export.py:552`) reads only Sale + Expense
rows, hardcodes 25%, splits gross with a flat `gross/(1+rate)`, ignores
`prices_include_moms`, and applies blanket 100% købsmoms with no §42 weighting.
The real engine (`compute_filing_data` → `_calc_vat`) does all four correctly and
adds DailyClose (kasserapport) revenue and invoices.

A café that closes with a kasserapport sees `Salg ekskl. moms 0,00` in
`moms-summary.csv` while the angivelse PDF for the same period shows the real
figure — and the bundle README tells the revisor this file *confirms* the
angivelse.

### 6. The MOMS countdown is silent on the frist day itself — CONFIRMED

`_get_next_deadlines()` drops any deadline with `deadline <= today`
(`tax_service.py:807`), so `days_until` is always ≥ 1. On 1 September — the frist
for a default DK half-yearly filer — `/tax` reads **181 days** (the following
period) instead of "due today", and no overdue state is ever reachable on any
later day. The `status="overdue"` branch, the overdue alerts, the daily brief's
`< 0` and `== 0` candidates and the TaxAutopilot UI branches are all dead code.

Same family as the `deadline`/`date` key bug fixed today (`dae09ec7`) — and the
source comment already admits it.

### 7. Gavekort reaches no revisor artifact — CONFIRMED

The outstanding balance — the deferred-revenue liability a revisor must book at
period end — is computed only inside `GET /api/gavekort` and rendered on one
dashboard tile (`GavekortPage.jsx:991`, its only consumer). No gavekort file in the
bundle, no section in the MOMS PDF, no `GiftCard` reference in `reports.py` or
`bookkeeping_export.py`. The only way to give the revisor the number is to read a
tile and retype it.

---

## Cards that came back clean

**Daily close** — 4 alleged gaps, **4 refuted**. Photographing, OCR and the
variance flagging all hold; "differences flagged, not guessed" is accurate.

**Hours & pay** — 4 alleged gaps, **4 refuted**. The punch clock writes real
measured rows, labor% is computed against DailyClose-wins revenue and goes null
rather than fake-zero, and the 12.5% feriepenge uplift is applied and honestly
labelled an estimate.

One caveat I checked by hand: the finder claimed *"Overtime flagged before it
happens"* is false because nothing sets `is_overtime`. Production agrees the column
is dead — **0 of 36 rows**, and no frontend file ever sets it. But the verifiers
were right to refute: the promise is kept by a different mechanism, the Vagtplan
Shield's 48-hour and 11-timers warnings, which *do* fire before publish. The claim
holds; the `is_overtime` column is dead code that should probably be removed rather
than wired up.

---

## Suggested order

1. **Reservations cap** — surface it (owner-facing usage + ceiling), check it in
   availability so the page shows closed rather than refusing at the last tap, and
   put the number in the pricing table. Silent + customer-facing + on the free tier
   everyone lands on.
2. **Waste fradrag** — a `_ZERO_FRADRAG` entry is a one-line fix; the
   double-booking question needs a decision about whether waste is an expense at all.
3. **Business-day for waste** — import the helper that already exists.
4. **Grid `.find()`** — render all shifts in a cell.
5. **Publish bound or app range** — either clamp publish to what the app can show,
   or extend the app. Do not ship a confirm sheet that says "live" for shifts nobody
   can see.
6. **Revisor ZIP MOMS** — route it through `compute_filing_data`.
7. **Frist-day countdown** — `deadline < today` instead of `<=`.
8. **Gavekort in the bundle.**
