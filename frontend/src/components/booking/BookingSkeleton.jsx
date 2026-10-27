// The booking page's wait as React (booking R5) — the very markup
// skeletonHtml() writes into index.html for the first paint, so the
// hand-over from the HTML to the route's fallback to the page is invisible.
// See bookingWait.js for the why. `word` is the page's own "Henter…";
// without one the line is kept, empty (the HTML version has no words yet).
import { skeletonTree } from "./bookingWait";

function render(node, key, word) {
  const Tag = node.tag;
  if (node.children === null) {
    return (
      <Tag key={key} className={node.className}>
        {word || "\u00a0"}
      </Tag>
    );
  }
  return (
    <Tag key={key} className={node.className}>
      {node.children.map((c, i) => render(c, i, word))}
    </Tag>
  );
}

export default function BookingSkeleton({ variant = "plain", word = "" }) {
  const tree = skeletonTree(variant);
  return (
    <tree.tag
      className={tree.className}
      data-bb-wait={variant}
      data-testid="rsvp-wait"
      aria-hidden={word ? undefined : "true"}
    >
      {tree.children.map((c, i) => render(c, i, word))}
    </tree.tag>
  );
}
