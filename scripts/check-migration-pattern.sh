#!/usr/bin/env bash
# scripts/check-migration-pattern.sh
#
# Layer 3 of the 4-layer safety net added after the 2026-05-26 prod-down
# incident (commit 7c0e4c2 shipped User columns via Alembic instead of
# the in-process ALTER list, causing every authenticated request to 500
# with `column users.invite_token_hash does not exist`).
#
# WHAT IT DOES
# ------------
# Looks at the change-set being committed (staged files, or HEAD if run
# standalone). If a file under `backend/alembic/versions/` changed but
# `backend/app/main.py` did NOT change in the same change-set, the script
# refuses with a clear pointer to CLAUDE.md.
#
# Heuristic rationale:
#   • Alembic file touched + main.py touched   → likely the author DID
#     remember to mirror the DDL into the ALTER list. Pass (with a
#     non-blocking reminder to double-check).
#   • Alembic file touched + main.py untouched → almost certainly the
#     exact 7c0e4c2 regression pattern. Block.
#   • No Alembic file touched                  → pass silently.
#
# USAGE
# -----
#   bash scripts/check-migration-pattern.sh           # checks staged diff
#   bash scripts/check-migration-pattern.sh --head    # checks HEAD diff
#   BONBOX_SKIP_MIGRATION_GUARD=1 git commit …        # explicit override
#                                                       (use for doc-only
#                                                       changes to Alembic
#                                                       comments)
#
# WIRING
# ------
# Standalone (no framework): copy into .git/hooks/pre-commit, or run
# manually before `git commit`.
#
# pre-commit framework: add a local hook to .pre-commit-config.yaml:
#     - id: migration-pattern
#       name: Migration pattern guard
#       entry: bash scripts/check-migration-pattern.sh
#       language: system
#       pass_filenames: false
#
# Exit codes:
#   0  — pass (no Alembic change, or both files changed)
#   1  — block (Alembic changed but main.py did not)
#   2  — environment problem (not in a git repo)

set -uo pipefail

# Resolve repo root so the script works from anywhere.
if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "check-migration-pattern: not inside a git repository — skipping." >&2
    exit 2
fi
cd "$REPO_ROOT"

# Explicit override — for doc-only Alembic edits (e.g. updating the
# "documentation only" banner). Use sparingly; CI should not set this.
if [[ "${BONBOX_SKIP_MIGRATION_GUARD:-0}" == "1" ]]; then
    echo "check-migration-pattern: BONBOX_SKIP_MIGRATION_GUARD=1 — bypassed."
    exit 0
fi

# Pick the diff source. Default is the staged change-set (pre-commit
# usage). --head inspects HEAD vs HEAD~1 (CI / post-commit usage).
DIFF_MODE="staged"
for arg in "$@"; do
    case "$arg" in
        --head) DIFF_MODE="head" ;;
        --help|-h)
            sed -n '2,40p' "$0"
            exit 0
            ;;
    esac
done

if [[ "$DIFF_MODE" == "head" ]]; then
    # Last commit (works on a normal branch, gracefully handles a fresh
    # repo with a single commit — falls back to empty set).
    if ! CHANGED_FILES="$(git diff --name-only HEAD~1 HEAD 2>/dev/null)"; then
        CHANGED_FILES="$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null || true)"
    fi
else
    # Staged + cached, i.e. what `git commit` is about to record.
    CHANGED_FILES="$(git diff --cached --name-only)"
fi

# Look for any change under backend/alembic/versions/. Anything outside
# `versions/` (e.g. env.py, script.py.mako) is infrastructure and never
# carries DDL, so we don't gate on it.
ALEMBIC_TOUCHED=""
MAIN_PY_TOUCHED=""
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    case "$line" in
        backend/alembic/versions/*) ALEMBIC_TOUCHED="$line $ALEMBIC_TOUCHED" ;;
        backend/app/main.py)        MAIN_PY_TOUCHED="$line" ;;
    esac
done <<<"$CHANGED_FILES"

if [[ -z "$ALEMBIC_TOUCHED" ]]; then
    # Nothing to check.
    exit 0
fi

# Loud reminder regardless of whether main.py also changed — Alembic
# files in this repo are documentation-only, and the operator should
# know that fact each time they touch one.
echo
echo "================================================================"
echo "  check-migration-pattern: Alembic version file(s) changed."
echo "  Files: $ALEMBIC_TOUCHED"
echo
echo "  REMINDER: BonBox runs migrations via the in-process ALTER list"
echo "  in backend/app/main.py:_run_migrations(), NOT via"
echo "  'alembic upgrade head'. Render never invokes Alembic."
echo
echo "  See CLAUDE.md -> 'Schema changes — DO NOT use Alembic' for"
echo "  the full rule and the d3dc5ae fix for the canonical pattern."
echo "================================================================"

if [[ -z "$MAIN_PY_TOUCHED" ]]; then
    echo
    echo "  BLOCKED: backend/app/main.py is NOT in this change-set."
    echo
    echo "  This is the exact pattern of the 2026-05-26 prod-down"
    echo "  incident (commit 7c0e4c2). The SQLAlchemy model will"
    echo "  declare columns the live DB doesn't have, and every"
    echo "  authenticated request on PG will 500 at startup."
    echo
    echo "  Required: mirror the same DDL as 'ALTER TABLE ... ADD"
    echo "  COLUMN IF NOT EXISTS' statements in the ALTER list in"
    echo "  backend/app/main.py (search for '_migrations = ['), then"
    echo "  re-stage and re-run the commit."
    echo
    echo "  If this is a documentation-only edit (e.g. updating a"
    echo "  comment or the 'documentation only' banner), bypass with:"
    echo "    BONBOX_SKIP_MIGRATION_GUARD=1 git commit ..."
    echo "================================================================"
    exit 1
fi

echo
echo "  OK: backend/app/main.py is also in this change-set."
echo "  Double-check that every column added in the Alembic upgrade()"
echo "  has a matching ALTER TABLE ... IF NOT EXISTS in _run_migrations()"
echo "  before pushing. The startup self-test (_verify_schema_no_drift)"
echo "  will catch missed columns at deploy time, but it's better to"
echo "  catch them here."
echo "================================================================"
echo
exit 0
