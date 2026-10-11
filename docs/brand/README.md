# BonBox logo system

Direction B · Rullen, v1 (11 October 2026). Symbol, favicons, app icons, wordmark and lock-up.

## Colours

| Name    | HEX       | RGB           | Use                                                    |
|---------|-----------|---------------|--------------------------------------------------------|
| Forest  | `#093A26` | 9 · 58 · 38   | Primary. App tile, logo on light backgrounds           |
| Paper   | `#F6F4EC` | 246 · 244 · 236 | Neutral. The b on forest, Vagtplan tile              |
| Emerald | `#059669` | 5 · 150 · 105 | Vagtplan strip only. Never the main b                  |
| Black   | `#000000` | 0 · 0 · 0     | One-colour print                                       |
| White   | `#FFFFFF` | 255 · 255 · 255 | One-colour reversed (dark or photo backgrounds)      |

Contrast: paper on forest 11.6:1. Emerald on paper or forest is about 3.4:1, which is fine for large shapes but too low for small text.

## Clear space

- Lock-up and wordmark: one o-height (the wordmark's x-height) clear on every side.
- Symbol and icon artwork: a quarter of the b's height clear on every side. Inside an app tile, the tile edge counts as the clear space.

## Minimum size

- Lock-up: 96 px wide on screen, 25 mm in print.
- Wordmark: 64 px wide on screen, 18 mm in print.
- Symbol: 20 px in the interface (the 24 × 24 file). Below 20 px use the favicon artwork, which is drawn separately for 16 and 32 px.

## Files

```
symbol/
  bonbox-symbol.svg              24 × 24, one path, fill="currentColor"
  bonbox-symbol-{forest,paper,black,white}.svg
  vagtplan-symbol.svg            roll in forest + strip in emerald
  BonBoxSymbol.tsx               React component (size, title props)
favicon/
  favicon.ico                    16 + 32 px, each drawn on its own pixel grid
  favicon-16.png / .svg, favicon-32.png / .svg
  apple-touch-icon.png           180 × 180, square (iOS rounds it)
  vagtplan-favicon.ico, vagtplan-favicon-16/32.png/.svg, vagtplan-apple-touch-icon.png
app-icon/
  bonbox-app-icon-1024.png / .svg     1024 × 1024, square, no rounded corners, RGB, no transparency
  vagtplan-app-icon-1024.png / .svg
wordmark/
  bonbox-wordmark-{forest,paper,black,white}.svg / .png   PNG is 2400 px wide, transparent
lockup/
  bonbox-lockup-{forest,paper,black,white}.svg / .png     PNG is 2400 px wide, transparent
```

SVG files are cropped tight to the artwork. Add the clear space when you place them.

## Favicon snippet

```html
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

For the Vagtplan app, use the `vagtplan-` files in the same way.

## React

```tsx
import { BonBoxSymbol } from "./BonBoxSymbol";

<BonBoxSymbol size={24} style={{ color: "#093A26" }} />  // takes the text colour
<BonBoxSymbol size={20} title="" />                         // decorative, next to the word BonBox
```

## Rules

- Main app: forest tile, paper b. Vagtplan: paper tile, forest b, emerald strip.
- Never put the b in a circle; always use the rounded square (or no container).
- Don't mirror or rotate the b (it turns into a d, p or q), stretch it, outline it or add effects.
- Never make the main b emerald, and don't put forest on emerald or mid-greens.
- App icons are square on purpose: iOS and Android apply their own mask.

---

## In this repo

This folder is the kit's README and SVG sources, copied as delivered (the PNG and ICO files live where they ship, below). If the kit changes, re-cut every row of this table.

| Shipped file | Cut from |
|---|---|
| `frontend/src/components/BonBoxMark.jsx` | `symbol/bonbox-symbol.svg` (same path, `fill="currentColor"`) |
| Logo tiles in the app, landing, login, register, legal pages | `bg-bb-forest text-bb-paper` (`--color-bb-forest` / `--color-bb-paper` in `frontend/src/index.css`) with `BonBoxMark` at about 0.8 × the tile |
| `frontend/public/favicon.ico`, `favicon-16.png`, `favicon-32.png` | `favicon/` (copied) |
| `frontend/public/favicon.svg` | `favicon/favicon-32.svg` |
| `frontend/public/apple-touch-icon.png` | `favicon/apple-touch-icon.png` |
| `frontend/public/icon-192.png`, `icon-512.png`, `icon-192.svg` | `app-icon/bonbox-app-icon-1024.svg`, rendered square |
| `frontend/public/icon-maskable-192.png`, `icon-maskable-512.png` | the app icon with the b scaled to 0.85 about the centre, so its farthest point sits at 33.7 % from the centre (the maskable safe zone is 40 %) |
| `frontend/public/vagtplan-*` | the `vagtplan-` files, same rules; used on staff routes (`/s/…`) and by the staff portal's web manifest |
| `frontend/public/og-image.png`, `og-image-v2.png` | the old tile replaced in the same 180 px box by a forest tile (radius 6/32, as the favicon) with the app icon's b; the text is untouched |
| `frontend/public/og-image-v3.png` (what index.html links) | 1200 × 630 on paper: `lockup/bonbox-lockup-forest.svg` at 580 px wide, centred, over the v2 tagline (its pixels lifted off the white ground and laid on paper, unchanged) |
| `frontend/public/badge-96.png` (push status-bar badge) | `symbol/bonbox-symbol-white.svg` at 96 px, transparent |
| `frontend/ios/…/AppIcon-512@2x.png` | `app-icon/bonbox-app-icon-1024.png` |
| `frontend/ios-scheduler/…/AppIcon-512@2x.png` | `app-icon/vagtplan-app-icon-1024.png` |
| iOS `Splash.imageset` (both apps) | the old 420 px tile replaced in place: forest tile (owner app), paper Vagtplan tile (scheduler) |

Rendering: `rsvg-convert` for the SVGs and Pillow for compositing; no npm packages.
