# BonBox documentation

Everything written about BonBox that is not code, sorted by what you are
looking for. The code map is [`STRUCTURE.md`](../STRUCTURE.md); the rules for
working in the repo are [`CLAUDE.md`](../CLAUDE.md).

## Architecture — how it is built

| Document | What it covers |
|---|---|
| [architecture.md](architecture/architecture.md) | The system as a whole: apps, API, database, deploys |
| [reservations-architecture.md](architecture/reservations-architecture.md) | Reservations: booking engine, floor plan, host stand, guest page |
| [security-rls-doctrine.md](architecture/security-rls-doctrine.md) | Row-level security and tenant isolation in the database |
| [design-system-doctrine.md](architecture/design-system-doctrine.md) | The locked design system: primitives, colours, icons, type |

## Decisions — why it is built that way

| Record | Decision |
|---|---|
| [ADR-001](decisions/001-auto-migrations.md) | Schema migrations run automatically on startup |
| [ADR-002](decisions/002-i18n-custom-hook.md) | A small custom i18n hook instead of i18next |
| [ADR-003](decisions/003-service-worker-cache.md) | Service-worker cache versioning |

## Product — specs for features

| Spec | Feature |
|---|---|
| [event-booking-product-spec.md](product/event-booking-product-spec.md) | Event hosting and ticket reservations |
| [voucher-universal-scanner-design.md](product/voucher-universal-scanner-design.md) | Scanning vouchers and generating gavekort |
| [gavekort-online-payment-scoping.md](product/gavekort-online-payment-scoping.md) | Buying a gavekort online with a card |
| [passive-auto-capture-spec.md](product/passive-auto-capture-spec.md) | Capturing sales without typing them |
| [aiia-integration-spec.md](product/aiia-integration-spec.md) | Open-banking bank connection (Aiia) |
| [mobilepay-integration-spec.md](product/mobilepay-integration-spec.md) | MobilePay Business connection |
| [scope-mark-as-filed.md](product/scope-mark-as-filed.md) | "Mark as filed" — prerequisite for overdue-MOMS alerts |
| [tier-4-dashboard-restructure.md](product/tier-4-dashboard-restructure.md) | Dashboard / Sales / Expenses restructure |

## Research — audits and reviews

| Document | About |
|---|---|
| [landing-claim-audit-2026-09-06.md](research/landing-claim-audit-2026-09-06.md) | Every landing-page claim checked against the code |
| [home-sales-expenses-ux-audit.md](research/home-sales-expenses-ux-audit.md) | Clutter audit of Home, Sales and Expenses |
| [sudip-workflow-fit.md](research/sudip-workflow-fit.md) | One real owner's workflow against the product |
| [kill-criterion-vagtplan.md](research/kill-criterion-vagtplan.md) | The go / no-go test for the scheduling feature |

## Strategy

| Document | About |
|---|---|
| [positioning.md](strategy/positioning.md) | Positioning and pitch, one page |
| [roadmap.md](strategy/roadmap.md) | Prioritised roadmap |
| [marketing-reels-pack.md](strategy/marketing-reels-pack.md) | Short-video production pack |

## Runbooks — how to do things

| Runbook | Task |
|---|---|
| [deploy.md](runbooks/deploy.md) | Deploying backend and frontend |
| [DEPLOYMENT.md](runbooks/DEPLOYMENT.md) | Production deployment checklist |
| [add-new-feature.md](runbooks/add-new-feature.md) | Adding a new feature end to end |

Brand assets live in [`brand/`](brand/).
