/* The two flags of the language switch (PORT_PLAN 2.3; Manoj 21 Oct: "dk en we can put flag easier", 23 Oct: "instead of
 * dk en just put flag"). Drawn, never emoji: Windows shows an emoji flag as two letters. Decorative (the button carries the
 * name). Both 24 x 18 (4:3), drawn on that pixel grid: every straight edge falls on a whole pixel, so the flags are crisp at
 * 1x as well as 2x and 3x (only the Union Jack's diagonals are antialiased, as they must be).
 *   Denmark: Dannebrog, red #C8102E with the white Nordic cross, 2 wide, 8 from the hoist and from the top
 *   (8 : 14 = 12 : 21, the flag's own arm lengths).
 *   United Kingdom: the Union Jack, blue #012169; the white saltire corner to corner (the flag's 6/30 of the height, 3.6),
 *   its red counterchanged half (2/30, 1.2) on the side the flag puts it (below the white in the hoist's upper quarter,
 *   turning round the centre), drawn as four wedges so no id is needed (the switch is on the page twice); the white-edged
 *   red cross, 4 wide with 1 of white each side. */

export default function Flag({ code }) {
  if (code === "da") {
    return (
      <svg className="flag" viewBox="0 0 24 18" width="24" height="18" aria-hidden="true" focusable="false">
        <path fill="#C8102E" d="M0 0h24v18H0z" />
        <path fill="#FFFFFF" d="M8 0h2v18H8zM0 8h24v2H0z" />
      </svg>
    );
  }
  if (code === "en") {
    return (
      <svg className="flag" viewBox="0 0 24 18" width="24" height="18" aria-hidden="true" focusable="false">
        <path fill="#012169" d="M0 0h24v18H0z" />
        <path stroke="#FFFFFF" strokeWidth="3.6" d="M-4-3L28 21M28-3L-4 21" />
        <path fill="#C8102E" d="M0 0L12 9L11.28 9.96L0 1.5ZM24 18L12 9L12.72 8.04L24 16.5ZM24 0L12 9L11.28 8.04L22 0ZM0 18L12 9L12.72 9.96L2 18Z" />
        <path fill="#FFFFFF" d="M9 0h6v18H9zM0 6h24v6H0z" />
        <path fill="#C8102E" d="M10 0h4v18h-4zM0 7h24v4H0z" />
      </svg>
    );
  }
  return null;
}
