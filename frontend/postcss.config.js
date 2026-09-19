import { fileURLToPath } from "node:url";

/* Tailwind v4 has no tailwind.config.js here — `@import "tailwindcss"` in
   src/index.css turns on AUTOMATIC source detection, and `base` is the only
   knob that says where that scan starts. It defaults to the cwd, i.e. the
   whole of frontend/.

   WHY THAT WAS WRONG: frontend/ contains the committed Capacitor web bundles.
   ios/ and android/ are gitignored (Tailwind's auto-detection honours
   .gitignore, so it already skipped them), but ios-scheduler/App/App/public is
   TRACKED on purpose — the scheduler app is shipped from this repo, so its
   bundle must stay committed. Tailwind therefore scanned 374 files of LAST
   build's output and treated their classes as live source.

   The visible cost: the stale bundle still carries the pre-fix sidebar accent
   `shadow-[inset_2px_0_0_0_#10b981]`, so every deployed stylesheet kept
   emitting that rule months after src/ moved to
   `shadow-[inset_2px_0_0_0_rgb(var(--brand-green-dot))]`. The worse cost is
   epistemic: output scanned as input is a feedback loop, so a class could
   never be observed to DIE — it kept re-justifying itself from the last build.

   Pointing base at src/ makes the scan describe hand-written source only.
   Nothing is lost: index.html carries zero class attributes, and public/*.html
   are self-contained pages that never load this stylesheet. Resolved from
   import.meta.url rather than "./src" so it holds no matter which directory
   the build is invoked from. */
export default {
  plugins: {
    "@tailwindcss/postcss": {
      base: fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
};
