/**
 * What a page says when it could not ask.
 *
 * One component so that "we couldn't load this" reads the same everywhere and
 * nobody has to re-invent the sentence at the moment they are fixing something
 * else. Lifted verbatim from BranchSummaryView, which already had it right:
 * an amber SectionBanner, the house "Something went wrong" copy, and a Try
 * again that re-runs the same fetcher.
 *
 * Amber, not red. The owner has not broken anything and nothing is lost — the
 * request did not come back. Red is for money at risk.
 *
 * Use it INSTEAD of the empty state, never above it. The whole point is that
 * "no rows" and "no answer" are different screens: rendering both would still
 * leave "You have no transactions" on a page that has no idea.
 */
import { useLanguage } from "../../hooks/useLanguage";
import SectionBanner from "./SectionBanner";

export default function LoadFailed({
  /** Re-runs the fetch. Wire this to useAsyncData's `reload`. */
  onRetry = null,
  /** Override when the page can say something more specific than the default. */
  title = null,
  /** Optional extra sentence — e.g. which numbers on screen are now stale. */
  body = null,
  className = "",
}) {
  const { t } = useLanguage();
  return (
    <SectionBanner
      severity="warn"
      icon="AlertTriangle"
      title={title || t("somethingWentWrong")}
      className={className}
    >
      {body ? <p className="mb-1">{body}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="font-semibold underline underline-offset-2 hover:no-underline"
        >
          {t("tryAgain")}
        </button>
      ) : null}
    </SectionBanner>
  );
}
