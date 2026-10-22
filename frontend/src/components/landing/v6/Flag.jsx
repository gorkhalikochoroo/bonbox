/* The two flags beside the language codes (PORT_PLAN 2.3; Manoj 21 Oct: "dk en we can put flag easier").
 * Drawn, never emoji: Windows shows an emoji flag as two letters. 16 x 12, decorative (the code beside it is the text).
 *   Denmark: Dannebrog, red #C8102E with the white Nordic cross (37:28, cross 4 wide, 12 from the hoist).
 *   United Kingdom: the Union Jack, blue #012169, white and counterchanged red saltires, the white-edged red
 *   cross; drawn on the flag's 60 x 30 grid, shown as the middle 40 x 30 (4:3, like the Danish one). */

export default function Flag({ code }) {
  if (code === "da") {
    return (
      <svg className="flag" viewBox="0 0 37 28" width="16" height="12" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect width="37" height="28" fill="#C8102E" />
        <path fill="#FFFFFF" d="M12 0h4v28h-4zM0 12h37v4H0z" />
      </svg>
    );
  }
  if (code === "en") {
    return (
      <svg className="flag" viewBox="10 0 40 30" width="16" height="12" aria-hidden="true" focusable="false">
        <rect width="60" height="30" fill="#012169" />
        <path d="M0 0L60 30M60 0L0 30" stroke="#FFFFFF" strokeWidth="6" />
        <path fill="#C8102E" d="M0 0L30 15H25.528L0 2.236ZM60 30L30 15H34.472L60 27.764ZM60 0L30 15V12.764L60 -2.236ZM0 30L30 15V17.236L0 32.236Z" />
        <path d="M30 0V30M0 15H60" stroke="#FFFFFF" strokeWidth="10" />
        <path d="M30 0V30M0 15H60" stroke="#C8102E" strokeWidth="6" />
      </svg>
    );
  }
  return null;
}
