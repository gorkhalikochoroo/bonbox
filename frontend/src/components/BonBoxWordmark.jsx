/**
 * The BonBox wordmark — the word as the logo kit draws it (logo system v1,
 * 11 Oct 2026). Use it wherever the word BonBox sits next to the mark, instead
 * of typing "BonBox" in the UI font: typed, the word took each surface's own
 * size, weight and tracking, so it was a slightly different logo on each.
 *
 * The source of truth is docs/brand/wordmark/bonbox-wordmark-forest.svg: one
 * path, its viewBox kept as delivered (cropped tight; 10 units below the
 * baseline are the o's overshoot), drawn here in currentColor so the caller
 * sets the colour — text-bb-forest on a light ground, text-bb-paper (or white)
 * on a dark ground and in dark mode.
 *
 * Sized by HEIGHT, about 0.6 x the tile beside it; the width follows from the
 * kit's proportions, so it is set up front and nothing shifts when it paints.
 * Kit minimum on screen: 64 px wide, i.e. height 14.
 *
 * Accessible name "BonBox" (role="img"), so a link or heading that holds it
 * reads as before. Pass title="" only where the name is given elsewhere.
 */
export const BONBOX_WORDMARK_VIEWBOX = "0 -700 3299.67 710";
const VIEW_W = 3299.67;
const VIEW_H = 710;

const BONBOX_WORDMARK_PATH =
  "M1764 -700H2050.5Q2088.2 -700 2122.7 -685.4Q2156 -671.3 2181.7 -645.7Q2207.3 -620 2221.4 -586.7Q" +
  "2236 -552.2 2236 -514.5Q2236 -476.8 2221.4 -442.3Q2207.3 -409 2181.7 -383.3Q2171 -372.7 2159.1 -" +
  "364Q2165.5 -358.6 2171.5 -352.5Q2200.1 -324 2215.8 -286.9Q2232 -248.5 2232 -206.5Q2232 -164.5 22" +
  "15.8 -126.1Q2200.1 -89 2171.5 -60.5Q2143 -31.9 2105.9 -16.2Q2067.5 0 2025.5 0L1970.5 0Q1928.5 0 " +
  "1890.1 -16.2Q1853 -31.9 1824.5 -60.5Q1795.9 -89 1780.2 -126.1Q1764.1 -164.3 1764 -206ZM0 -700H28" +
  "6.5Q324.2 -700 358.7 -685.4Q392 -671.3 417.7 -645.7Q443.3 -620 457.4 -586.7Q472 -552.2 472 -514." +
  "5Q472 -476.8 457.4 -442.3Q443.3 -409 417.7 -383.3Q407 -372.7 395.1 -364Q401.5 -358.6 407.5 -352." +
  "5Q436.1 -324 451.8 -286.9Q468 -248.5 468 -206.5Q468 -164.5 451.8 -126.1Q436.1 -89 407.5 -60.5Q37" +
  "9 -31.9 341.9 -16.2Q303.5 0 261.5 0L206.5 0Q164.5 0 126.1 -16.2Q89 -31.9 60.5 -60.5Q31.9 -89 16." +
  "2 -126.1Q0.1 -164.3 0 -206H0ZM2558 -515C2707.1 -515 2828 -397.5 2828 -252.5C2828 -107.5 2707.1 1" +
  "0 2558 10C2408.9 10 2288 -107.5 2288 -252.5C2288 -397.5 2408.9 -515 2558 -515ZM794 -515C943.1 -5" +
  "15 1064 -397.5 1064 -252.5C1064 -107.5 943.1 10 794 10C644.9 10 524 -107.5 524 -252.5C524 -397.5" +
  " 644.9 -515 794 -515ZM1166 0V-505H1250V-460.6Q1276.6 -482.9 1308.9 -496.6Q1352.4 -515 1400 -515Q" +
  "1447.6 -515 1491.1 -496.6Q1533.1 -478.8 1565.5 -446.5Q1597.8 -414.1 1615.6 -372.1Q1634 -328.6 16" +
  "34 -281V0H1550V-281Q1550 -311.5 1538.2 -339.4Q1526.8 -366.3 1506.1 -387.1Q1485.3 -407.8 1458.4 -" +
  "419.2Q1430.5 -431 1400 -431Q1369.5 -431 1341.6 -419.2Q1314.7 -407.8 1293.9 -387.1Q1273.2 -366.3 " +
  "1261.8 -339.4Q1250 -311.5 1250 -281V0ZM794 -433.5C691.3 -433.5 608 -352.5 608 -252.5C608 -152.5 " +
  "691.3 -71.5 794 -71.5C896.7 -71.5 980 -152.5 980 -252.5C980 -352.5 896.7 -433.5 794 -433.5ZM2558" +
  " -433.5C2455.3 -433.5 2372 -352.5 2372 -252.5C2372 -152.5 2455.3 -71.5 2558 -71.5C2660.7 -71.5 2" +
  "744 -152.5 2744 -252.5C2744 -352.5 2660.7 -433.5 2558 -433.5ZM3032.9 -252.5 2868.3 -505H2970.6L3" +
  "084 -331L3197.4 -505H3299.7L3135.1 -252.5L3299.7 0H3197.4L3084 -174L2970.6 0H2868.3L3032.9 -252." +
  "5ZM2025.5 -329H1848V-206.4Q1848 -181.5 1857.6 -158.8Q1866.9 -136.9 1883.9 -119.9Q1900.9 -102.9 1" +
  "922.8 -93.6Q1945.5 -84 1970.5 -84L2025.5 -84Q2050.5 -84 2073.2 -93.6Q2095.1 -102.9 2112.1 -119.9" +
  "Q2129.1 -136.9 2138.4 -158.8Q2148 -181.5 2148 -206.5Q2148 -231.5 2138.4 -254.2Q2129.1 -276.1 211" +
  "2.1 -293.1Q2095.1 -310.1 2073.2 -319.4Q2050.5 -329 2025.5 -329ZM261.5 -329H84V-206.4Q84 -181.5 9" +
  "3.6 -158.8Q102.9 -136.9 119.9 -119.9Q136.9 -102.9 158.8 -93.6Q181.5 -84 206.5 -84L261.5 -84Q286." +
  "5 -84 309.2 -93.6Q331.1 -102.9 348.1 -119.9Q365.1 -136.9 374.4 -158.8Q384 -181.5 384 -206.5Q384 " +
  "-231.5 374.4 -254.2Q365.1 -276.1 348.1 -293.1Q331.1 -310.1 309.2 -319.4Q286.5 -329 261.5 -329ZM1" +
  "848 -616V-413H2050.5Q2071.2 -413 2090 -421Q2108.2 -428.7 2122.3 -442.7Q2136.3 -456.8 2144 -475Q2" +
  "152 -493.8 2152 -514.5Q2152 -535.2 2144 -554Q2136.3 -572.2 2122.3 -586.3Q2108.2 -600.3 2090 -608" +
  "Q2071.2 -616 2050.5 -616ZM84 -616V-413H286.5Q307.2 -413 326 -421Q344.2 -428.7 358.3 -442.7Q372.3" +
  " -456.8 380 -475Q388 -493.8 388 -514.5Q388 -535.2 380 -554Q372.3 -572.2 358.3 -586.3Q344.2 -600." +
  "3 326 -608Q307.2 -616 286.5 -616Z";

export default function BonBoxWordmark({ height = 16, title = "BonBox", className = "", ...rest }) {
  const width = Math.round(((height * VIEW_W) / VIEW_H) * 10) / 10;
  const a11y = title
    ? { role: "img", "aria-label": title }
    : { "aria-hidden": "true" };
  return (
    <svg
      width={width}
      height={height}
      viewBox={BONBOX_WORDMARK_VIEWBOX}
      fill="currentColor"
      focusable="false"
      className={`block shrink-0 ${className}`.trim()}
      {...a11y}
      {...rest}
    >
      <path d={BONBOX_WORDMARK_PATH} />
    </svg>
  );
}
