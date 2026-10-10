/**
 * R-c round 2 — a date move is ONE request (POST /daily-close/move): the new
 * day's draft (or lock) rides in it as `body`, and the old day's draft is
 * deleted by the server in the same transaction — no separate DELETE. Page
 * tests that read "every draft the page saved for a day" off the mocked
 * api.post read the move's body as the new day's save it is.
 */

/** Every close body the page sent: plain saves, and the new day's half of a move. */
export function closeBodies(calls) {
  return (calls || []).flatMap(([url, body]) => {
    if (url === "/daily-close") return [body];
    if (url === "/daily-close/move") return [body?.body];
    return [];
  }).filter(Boolean);
}

/** The move requests the page sent (POST /daily-close/move). */
export function moveRequests(calls) {
  return (calls || []).filter(([url]) => url === "/daily-close/move").map(([, req]) => req);
}

/**
 * The server's answer to a move, for page tests whose mocked server answers
 * every save the same way: the new day's row (`close`) and each old day as
 * `status` left it — "deleted" (the old flow's DELETE answered 204), "none",
 * "draft_changed" or "locked" (then `row` is what is kept).
 */
export function moveAnswer(req, close, { status = "deleted", id = null, row = null } = {}) {
  const day = (f, i) => ({
    date: f.date, branch_id: f.branch_id ?? null, status, id: i === 0 ? id : null,
    row: status === "draft_changed" || status === "locked" ? row : null,
  });
  const from = [
    { date: req.from_date, branch_id: req.from_branch_id ?? null },
    ...(req.also_from || []),
  ].map(day);
  return {
    moved: status === "deleted" || status === "none",
    old_status: status,
    old: from[0].row,
    from,
    close,
    save_id: req.save_id,
    replay: false,
  };
}
