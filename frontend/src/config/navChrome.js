/**
 * navChrome — the sidebar's shared STRUCTURAL tokens + the group-collapse
 * resolver.
 *
 * Both live here because both are sidebar STRUCTURE and both were previously
 * duplicated inline across Layout.jsx / ResumeRow.jsx / PillarDiscovery.jsx,
 * which is exactly how they drifted out of spec without anyone noticing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 1. THE MUTED TIER (NAV_MUTED / NAV_MUTED_HOVER)
 * ─────────────────────────────────────────────────────────────────────────
 * Every element that makes ~24 nav rows navigable — group headers, the venue
 * name, the ⌘K trigger, the Fortsæt eyebrow, the discovery-floor header and
 * its badges — was `text-gray-400 dark:text-gray-500`. Measured:
 *
 *   light  gray-400 #9ca3af on white   #ffffff → 2.54:1   ✗ (AA floor 4.5:1)
 *   dark   gray-500 #6b7280 on gray-800 #1f2937 → 3.04:1  ✗
 *
 * Both failed WCAG 2.1 AA for normal-size text, in BOTH themes — the dark
 * side was actually the worse of the two, which is why "just darken it"
 * would have been the wrong fix. The tier is now one step darker in light
 * and one step LIGHTER in dark:
 *
 *   light  gray-500 #6b7280 on white   #ffffff → 4.83:1   ✓
 *   dark   gray-400 #9ca3af on gray-800 #1f2937 → 5.78:1  ✓
 *
 * Hover keeps its "one step more present" relationship:
 *   light  gray-700 #374151 on white   → 10.31:1
 *   dark   gray-200 #e5e7eb on gray-800 →  11.86:1
 *
 * This is the STRUCTURAL tier only. Genuinely decorative text (icon opacity
 * washes, the mode-switcher's chevron) is deliberately left alone — it
 * carries no information a reader has to resolve.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 2. THE COLLAPSE RESOLVER (isNavGroupOpen / toggleNavGroup / readNavGroups)
 * ─────────────────────────────────────────────────────────────────────────
 * The old model had TWO writers to one map: the owner's toggle, and an
 * auto-expand effect that wrote `true` for whichever group contained the
 * current route and persisted it. The second writer always won, because the
 * owner cannot navigate without triggering it — so a deliberate collapse
 * survived only until the next visit to a page in that group, and the rail
 * was monotonically open.
 *
 * The fix is to make the stored map mean ONE thing: the owner's explicit
 * choice. Nothing else writes to it. "Reveal the active group" is then not a
 * write at all — it falls out of the default, because a group with no stored
 * choice is open. So there is no `activeGroupId` parameter here on purpose:
 *
 *   • explicit `false` → closed, INCLUDING the group the owner is standing
 *     in right now. That is the whole point — a collapse has to stick even
 *     while you are on a page inside it, or collapsing it is impossible.
 *   • explicit `true`  → open.
 *   • absent           → open. The active group is therefore always revealed
 *     on arrival for an owner who has never touched it, which is what the
 *     auto-expand effect was for — without a single write to storage, so it
 *     can never clobber another group's value.
 *
 * (Section 3, the colour mirrors for the index.css token blocks, is documented
 * where those exports live further down.)
 *
 * BACKWARD COMPATIBLE: the stored shape is unchanged — `{ [groupId]: bool }`
 * under the same `bonbox_nav_groups` key. Owners already carrying values
 * (including the `true`s the old auto-expand effect wrote for them) read back
 * as "open", exactly as they render today. readNavGroups() drops non-boolean
 * values rather than trusting whatever is in storage.
 */

/** localStorage key. Unchanged from the pre-fix shape — see BACKWARD COMPATIBLE above. */
export const NAV_GROUPS_STORAGE_KEY = "bonbox_nav_groups";

/** The structural muted tier. AA-passing in both themes — see the header. */
export const NAV_MUTED = "text-gray-500 dark:text-gray-400";

/** Hover companion for interactive muted chrome (group headers, ⌘K trigger). */
export const NAV_MUTED_HOVER = "hover:text-gray-700 dark:hover:text-gray-200";

/**
 * The rail's KEYBOARD focus ring.
 *
 * Layout had five focus-visible declarations and every one of them was on
 * chrome — the skip link, the hamburger, the hide button, the drawer ×, the
 * floating re-open. The ~28 nav rows, the group-header buttons, Fortsæt, the
 * discovery floor and the whole footer had none, so the only thing telling a
 * keyboard user where they were standing was the browser default outline:
 * a thin near-black hairline on a white rail, sitting directly beside rows
 * that already carry a gray-100 hover. Tab through it and you cannot tell.
 *
 * On --brand-green-accent, not a literal, for two reasons: it is the rail's
 * one identity accent (the same token the active row's 2px rail and the
 * collapsed-group dot are drawn in), and it FLIPS by theme — a fixed emerald
 * cannot clear the 3:1 non-text floor on both grounds. The offset ground is
 * --surface-card because that is the rail itself, which is what is actually
 * behind the ring.
 */
export const NAV_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[rgb(var(--brand-green-accent))] " +
  "focus-visible:ring-offset-1 focus-visible:ring-offset-[rgb(var(--surface-card))]";

/**
 * The literal colours behind the tokens above, kept next to them so the AA
 * guard test can assert the measured RATIO rather than trust a class name.
 * `surface` is the sidebar's own background (`bg-white dark:bg-gray-800`) —
 * contrast is meaningless without the ground the text sits on.
 */
export const NAV_MUTED_HEX = { light: "#6b7280", dark: "#9ca3af" };      // gray-500 / gray-400
export const NAV_MUTED_HOVER_HEX = { light: "#374151", dark: "#e5e7eb" }; // gray-700 / gray-200
export const NAV_SURFACE_HEX = { light: "#ffffff", dark: "#1f2937" };     // white / gray-800

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 3. THE COLOUR MIRRORS (guard-test inputs)
 * ─────────────────────────────────────────────────────────────────────────
 * The literals behind the CSS custom properties in index.css, mirrored here
 * for the SAME reason NAV_MUTED_HEX exists: a contrast ratio is invisible to a
 * build, an eslint pass and an i18n check, so it has to be asserted as a
 * NUMBER. jsdom does not resolve `var()` against a stylesheet it never loaded,
 * so a test cannot read these back off the DOM — mirroring them is the only
 * way to pin the ratio rather than a class name.
 *
 * KEEP IN SYNC with the BRAND GREEN and SURFACE LADDER blocks in index.css.
 * The guard test asserts the ratios these produce, so a drifted mirror shows
 * up as a failing ratio, not as a silently-passing lie.
 */

/** --brand-green-accent: the rail, the collapsed-group dot, focus rings, the
 *  AI glyph. Flips by theme because one fixed green cannot clear the 3:1
 *  non-text floor on both grounds (emerald-500 measured 2.30:1 in light). */
export const BRAND_ACCENT_HEX = { light: "#059669", dark: "#34d399" };   // emerald-600 / emerald-400

/** --brand-green: the logo tile. Deliberately the SAME in both themes. */
export const BRAND_MARK_HEX = "#059669";                                  // emerald-600
/** --brand-green-on: the glyph drawn on the mark. */
export const BRAND_MARK_INK_HEX = "#ffffff";

/** The active nav row's own background — the ground the 2px rail is drawn
 *  against, so it is what the rail's contrast must be measured on. Dark is the
 *  RESOLVED blend of `dark:bg-gray-700/60` over the gray-800 rail surface;
 *  a ratio taken against the un-blended gray-700 would flatter the result. */
export const NAV_ACTIVE_ROW_HEX = { light: "#f3f4f6", dark: "#2d3747" };  // gray-100 / gray-700@60% on gray-800

/** The SURFACE LADDER rungs (index.css). `ground` is the page, `subtle` is the
 *  half-rung used by pressed/selected chrome and Card's `subtle` variant,
 *  `card` is a resting card AND the shell, `raised` floats above a card,
 *  `line` is the hairline on a card. */
export const SURFACE_LADDER_HEX = {
  ground: { light: "#f8fafc", dark: "#111827" },
  subtle: { light: "#f9fafb", dark: "#18212f" },
  card:   { light: "#ffffff", dark: "#1f2937" },
  raised: { light: "#ffffff", dark: "#2b3544" },
  line:   { light: "#e5e7eb", dark: "#374151" },
};

/**
 * Parse + sanitize the stored group map. Anything that isn't a plain object
 * of booleans is discarded rather than trusted: this value survives across
 * releases in an owner's browser, so it is untrusted input like any other.
 *
 * @param {string|object|null} raw — the raw localStorage string (or a value).
 * @returns {Record<string, boolean>} the owner's explicit choices; {} if none.
 */
export function readNavGroups(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [gid, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") out[gid] = value;
    }
    return out;
  } catch {
    // Corrupt JSON / private mode → behave like a fresh owner (all open).
    return {};
  }
}

/**
 * Is this group expanded right now? Pure: stored choice wins, absence means
 * open. See the module header for why there is no active-route parameter.
 *
 * @param {Record<string, boolean>|null|undefined} stored
 * @param {string} groupId
 * @returns {boolean}
 */
export function isNavGroupOpen(stored, groupId) {
  const pref = stored ? stored[groupId] : undefined;
  if (typeof pref === "boolean") return pref;
  return true;
}

/**
 * Next stored map with `groupId` set to an explicit choice. Returns a NEW
 * object (never mutates) so React state updates stay referentially honest.
 */
export function setNavGroupOpen(stored, groupId, open) {
  return { ...(stored || {}), [groupId]: open === true };
}

/** Next stored map with `groupId` flipped from whatever it currently resolves to. */
export function toggleNavGroup(stored, groupId) {
  return setNavGroupOpen(stored, groupId, !isNavGroupOpen(stored, groupId));
}
