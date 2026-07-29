/**
 * A link to one of the two live iPhone apps.
 *
 * Deliberately NOT Apple's black "Download on the App Store" badge. That badge
 * is fixed artwork with its own clear-space and minimum-size rules, and it
 * carries a different type family and corner radius to everything else here —
 * dropping two of them onto this page would read as bolted on, which is the
 * texture the landing rebuild was fixing. Apple's marketing guidelines permit
 * a plain text link to a product page, so this is a text link wearing the
 * page's own pill: slate border, white ground, Lucide glyph, same radius as
 * the CTAs it sits beside.
 *
 * Two sizes because the two placements are not equal. The hero sits beside the
 * "Made in Copenhagen" badge and should feel like a peer of it; the staff one
 * sits against an 11px uppercase eyebrow and has to stay quieter than the h2
 * underneath it.
 *
 * Touch targets: index.css :253 already sets min-height 44px on every <a>
 * under (pointer: coarse), so the small variant is finger-safe on a phone
 * without carrying desktop padding it does not need.
 */
import { ArrowUpRight, Smartphone } from "lucide-react";

export default function AppStoreLink({ href, label, size = "sm" }) {
  const big = size === "md";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        "inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white font-medium text-slate-900 transition-colors duration-150 hover:border-slate-400 " +
        (big ? "px-[14px] py-[7px] text-[13px]" : "px-[11px] py-[5px] text-[12px]")
      }
    >
      <Smartphone
        size={big ? 14 : 13}
        strokeWidth={1.9}
        aria-hidden="true"
        className="flex-none text-slate-500"
      />
      {label}
      <ArrowUpRight
        size={big ? 13 : 12}
        strokeWidth={2}
        aria-hidden="true"
        className="flex-none text-slate-400"
      />
    </a>
  );
}
