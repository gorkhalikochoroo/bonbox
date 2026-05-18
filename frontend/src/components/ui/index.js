/**
 * BonBox UI primitives — the single source of truth.
 *
 * Usage:
 *   import { Button, Card, Empty, UpgradeNudge } from "@/components/ui";
 *
 * Design language (Claude-inspired warm-neutral aesthetic):
 *   • Warm stone palette (not pure gray) for surfaces and borders
 *   • Emerald-600 reserved for the "money moment" — confirmations,
 *     paid-tier upgrade nudges, send-complete toasts
 *   • Stone-900 primary buttons (confident but quiet)
 *   • rounded-xl (12px), not 2xl (16px) — less bubbly
 *   • Subtle 1px borders, shadows only on hover/elevation
 *   • Typography hierarchy via size+weight, never via color alone
 *
 * What NOT to do:
 *   • Inventing new colors per page
 *   • Mixing rounded sizes
 *   • Using window.alert() — use UpgradeNudge or a toast instead
 *   • Hardcoded English strings — wrap in t(key, fallback)
 *
 * When in doubt: read the docs in each component file. Each one
 * documents the contract + when to pick which variant.
 */
export { default as Button } from "./Button";
export { default as Card } from "./Card";
export { default as Empty } from "./Empty";
export { default as UpgradeNudge } from "./UpgradeNudge";
