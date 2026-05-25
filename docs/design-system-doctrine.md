# BonBox Design System Doctrine

**Locked 2026-05-25 by Manoj. Single source of truth. Every PR honors this.**

## The premium-feel principle

> **Color is signal, not decoration.** Every colored pixel must carry information. If you'd lose meaning by making it gray, color stays. Otherwise, it goes.

Reference products with the same discipline: Linear, Stripe Dashboard, Vercel Geist, Notion, Pleo, Apple Wallet. All built on gray hierarchy with color reserved for status.

---

## The color budget — 13 tokens, full stop

| Token | Light | Dark | When to use |
|---|---|---|---|
| `--bb-surface` | `gray-50` | `gray-950` | Page background |
| `--bb-card` | `white` | `gray-900` | Card / panel / modal surface |
| `--bb-border` | `gray-100` | `gray-800` | Card edge, dividers |
| `--bb-border-strong` | `gray-200` | `gray-700` | Inputs, dropdowns, selected chip ring |
| `--bb-text` | `gray-900` | `gray-50` | Headings, primary text |
| `--bb-text-body` | `gray-700` | `gray-300` | Paragraphs, body copy |
| `--bb-text-muted` | `gray-500` | `gray-400` | Captions, hints, secondary metadata |
| `--bb-text-placeholder` | `gray-400` | `gray-500` | Empty input placeholder |
| `--bb-action` | `gray-900` | `gray-50` | Primary action button background |
| `--bb-action-hover` | `gray-700` | `gray-200` | Primary action hover |
| `--bb-success` | `emerald-600` | `emerald-400` | Paid / completed / healthy / on-track signals |
| `--bb-danger` | `red-600` | `red-400` | Critical / overdue / failed signals |
| `--bb-warning` | `amber-500` | `amber-400` | MOMS countdown, low-stock, warning signals |

**That is the entire palette.** Anything else outside `components/ui/` requires explicit doctrine update.

The brand green `emerald-600` is allowed on:
- The Smart Scan FAB (one button, brand moment, earned)
- Landing/marketing pages (separate design language, scope-excluded)
- Success-state signal icons + dots (per `--bb-success` above)

Everything else: gray.

---

## Concrete component rules

### Primary buttons
- **Was:** `bg-green-600 text-white hover:bg-green-700` (everywhere — Sales submit, Expenses submit, + Quick Sale, + Item Sale, Faktura create)
- **Is:** `bg-gray-900 text-white hover:bg-gray-700`
- One primary action per page (Hick's Law). All others use secondary (`border-gray-200 text-gray-700 hover:bg-gray-50`).

### Chips (amount presets, payment methods, category pills)
- **Unselected:** `bg-white border border-gray-200 text-gray-700 hover:border-gray-300`
- **Selected:** `bg-gray-900 text-white border-gray-900`
- **NO** color variation by page (Sales blue vs Expenses green is dead).

### Status pills (Paid / Overdue / Draft / Active / Healthy)
- **Was:** `bg-green-100 text-green-700` full-color pill
- **Is:** `bg-gray-100 text-gray-700` neutral pill + colored DOT prefix
- Examples:
  - `● Paid` — green dot, gray pill
  - `● Overdue` — red dot, gray pill
  - `● Draft` — gray dot, gray pill
  - `● Healthy` — green dot, gray pill

### Context callouts (P&L "on track", success banners)
- **Was:** `bg-emerald-50 border-emerald-200 text-emerald-700` full green-tinted block
- **Is:** `bg-gray-50 border-gray-100` neutral block + colored ICON prefix
  - Success: `<Check className="text-emerald-600" />`
  - Warning: `<AlertCircle className="text-amber-500" />`
  - Danger: `<AlertOctagon className="text-red-600" />`
- The icon carries signal. The card stays neutral.

### KPI tiles (StatCard)
- Card surface: `bg-white` always, never tinted
- Number: `text-gray-900 font-semibold text-3xl`
- Label: `text-gray-500 uppercase tracking-wide text-xs`
- Delta arrow: `text-emerald-600 ↑12%` or `text-red-600 ↓4%` — arrow + percent are the only colored pixels

### Charts (Revenue Trend, Top Sellers, Revenue Forecast)
- Base series: `gray-700` line / `gray-200` bars
- Highlight: `gray-900` for the current/selected bar; `emerald-600` only when the series IS the success signal
- Grid: `gray-100`
- Axis labels: `gray-500`
- Maximum 2 colors per chart. No categorical rainbow palettes ever.

### Gradients
- **Banned everywhere in app chrome.** Search-grep `from-` outside `components/ui/` returns zero.
- Marketing/landing pages keep theirs (different design language, scope-excluded).
- Brand FAB keeps its `from-green-500 to-emerald-600` (one brand moment, earned).

### Shadows
- One shadow utility: `shadow-sm`. That's it.
- No colored shadows (`shadow-green-600`, `shadow-blue-500` are banned).
- No `shadow-2xl` / `shadow-xl` / `shadow-md` / `shadow-lg` — all replaced with `shadow-sm` or removed entirely.

### Border radius
- One value for surfaces: `rounded-xl` (12px). Cards, panels, buttons (size md+), modals, banners.
- One value for pills: `rounded-full`. Status pills, avatars, FAB.
- One value for inputs: `rounded-lg` (8px). Inputs, small chips.
- Everything else (`rounded-2xl`, `rounded-3xl`, `rounded-md`, `rounded-sm`) banned outside `components/ui/`.

### Typography
- H1: `text-[28px] font-semibold tracking-tight` (PageHeader prescribes — never bypass)
- H2: `text-xl font-semibold`
- H3: `text-base font-semibold`
- Body: `text-sm`
- Caption: `text-xs text-gray-500`

### Spacing
- Page gutter: PageShell prescribes (`p-4 sm:p-6`)
- Card padding: `p-5` default, `p-4 sm:p-5` for dense
- Vertical rhythm between sections: `space-y-6`
- Gap inside grids: `gap-4` default, `gap-3` for dense, `gap-6` for sparse

---

## Banned patterns (lint-blocked at pre-commit)

| Pattern | Why banned |
|---|---|
| `bg-green-[1-9]00` outside `ui/` | All primary actions must use `bg-gray-900`. Green = signal only. |
| `bg-emerald-[1-9]00` outside `ui/` | Same. |
| `from-` / `to-` / `via-` outside `ui/` and `LandingPage.jsx` | No gradients in app chrome. |
| `text-green-[1-9]00` outside `ui/` | Status indicators must use Icon primitive with success color. |
| `border-green-` / `border-emerald-` outside `ui/` | Status indicators must use Icon. |
| `bg-stone-` anywhere | Legacy palette. Codemod migrated to `bg-gray-*`. |
| `text-stone-` anywhere | Same. |
| `rounded-2xl` outside `ui/Modal.jsx` | Drift. Use `rounded-xl`. |
| `shadow-2xl`, `shadow-xl`, `shadow-md`, `shadow-lg` | Use `shadow-sm` or remove. |
| `<button className=` outside `ui/` | Use `<Button>` primitive. |
| `<input className=` outside `ui/` | Use `<Input>` primitive. |
| `<table className=` outside `ui/` | Use `<DataTable>` primitive. |
| Emoji in JSX chrome (📷 🧾 ⚠ ✅ ❌) | Use `<Icon name="..." />` Lucide primitive. |

---

## The page shell — every page follows this skeleton

```jsx
<PageShell width="default">                              {/* gutters + max-w */}
  <PageHeader eyebrow="MONEY" title="..." actions={...} /> {/* H1 + 1-2 actions */}
  <PageNotices>                                          {/* banners, max 2 visible */}
    {/* SectionBanner, InboxBanner, drift warnings */}
  </PageNotices>
  <PageBody layout="entry+stats">                        {/* main work area */}
    <PageBody.Primary><EntryCard /></PageBody.Primary>
    <PageBody.Aside><KPIGrid /></PageBody.Aside>
  </PageBody>
  <PageSection title="Recent ..." actions={<FilterBar />}>
    <DataTable />
  </PageSection>
</PageShell>
```

---

## The 6 missing primitives (this sprint)

1. **`Input.jsx`** — collapses 94 raw `<input>` instances
2. **`Chip.jsx`** — collapses every amount/payment/category chip; one selected style
3. **`EntryCard.jsx`** — the money-entry pattern (Sales + Expenses + future)
4. **`DataTable.jsx`** — collapses 64 raw `<table>` instances
5. **`FilterBar.jsx`** — date-range + select + reset, used 4+ times
6. **`PageShell.jsx`** — locks gutters + max-width to 3 named values

---

## Migration discipline

- **Pre-commit lint runs `scripts/check-design-doctrine.sh`** (added this sprint). Blocks new bleed.
- **Codemod** stone-* → gray-*, rounded-2xl → rounded-xl. Mechanical, scripted.
- **Each migration PR** must include a doctrine check `npm run lint:doctrine` showing zero violations in the migrated files.
- **No exceptions.** If a new feature genuinely needs a new token, it's a doctrine update PR first.

---

## Scope boundaries

**In scope** (must conform):
- All pages in `frontend/src/pages/` except:
  - `LandingPage.jsx`, `PricingPage.jsx`, `TermsPage.jsx`, `PrivacyPolicyPage.jsx`, `CookiePolicyPage.jsx`, `ContactPage.jsx`
- All components in `frontend/src/components/` and `frontend/src/components/ui/`
- All shared utilities, modals, banners

**Out of scope** (different design language):
- Marketing/landing pages (keep their hero gradients)
- PDF generation (server-side, separate design constraints)
- Email templates (HTML email constraints)

---

*Last updated: 2026-05-25 — Manoj approved "finish all" execution.*
