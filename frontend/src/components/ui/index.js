/**
 * BonBox UI primitives — the single source of truth.
 *
 * Usage:
 *   import { Button, Card, PageHeader, StatCard,
 *            SectionBanner, TabPills, Empty, UpgradeNudge } from "@/components/ui";
 *
 * Design language (sidebar-matched, May 2026 unification):
 *   • Neutral gray-* palette across all surfaces (was stone-*) — pages
 *     now match the sidebar exactly (Layout.jsx is the reference).
 *   • Emerald-600 reserved for the "money moment" — primary CTAs,
 *     paid-tier upgrade nudges, send-complete toasts, brand mark.
 *     Never used for selected nav / tabs / cards (the sidebar's design
 *     comment explicitly rejects "tech glow" colored active states).
 *   • Gray-900 primary buttons + selected pills (confident but quiet)
 *   • rounded-xl (12px), not 2xl (16px) — less bubbly
 *   • Subtle 1px borders, shadows only on hover/elevation
 *   • Typography hierarchy via size+weight, never via color alone
 *   • Inter throughout. 11px uppercase tracking-wider gray-400 is the
 *     canonical "eyebrow / label" treatment. 28px bold tracking-[-0.025em]
 *     gray-900 is the page H1.
 *
 * What NOT to do:
 *   • Inventing new colors per page
 *   • Mixing rounded sizes
 *   • Using window.alert() — use UpgradeNudge or a toast instead
 *   • Hardcoded English strings — wrap in t(key, fallback)
 *   • Emoji in primary slots — use <Icon name="…" /> instead
 *
 * When in doubt: read the docs in each component file. Each one
 * documents the contract + when to pick which variant.
 */
export { default as Button } from "./Button";
export { default as Card } from "./Card";
export { default as Empty } from "./Empty";
export { default as Icon } from "./Icon";
export { default as PageHeader } from "./PageHeader";
export { default as SectionBanner } from "./SectionBanner";
export { default as StatCard } from "./StatCard";
export { default as TabPills } from "./TabPills";
export { default as UpgradeNudge } from "./UpgradeNudge";
