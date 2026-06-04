#!/usr/bin/env bash
#
# One-tap production deploy for the BonBox frontend (Vercel project "bonbox").
#
#   ./deploy.sh        # build + ship the current working tree to bonbox.dk (prod)
#
# WHY THIS EXISTS
#   Deploying used to be a 3-step dance. The Vercel CLI needs a `.vercel`
#   project link, but ours was in a bad state and `.vercel` is gitignored
#   (so a fresh clone has no link at all):
#     • the repo ROOT was linked to a defunct project ("smallbiz-dashboard",
#       framework=services — it errors on deploy), and
#     • the real "bonbox" link lived under frontend/ — yet bonbox's remote
#       "Root Directory" is set to "frontend", so `cd frontend && vercel`
#       resolves to frontend/frontend and fails.
#
#   The ONE configuration that matches bonbox's remote setting is: link at the
#   REPO ROOT and deploy from the repo root (Vercel then builds ./frontend).
#   This script pins that link every run and deploys from root — so it's one
#   command, from anywhere in the repo, every time, on any machine.
#
#   Backend (Render) auto-deploys on git push; this script is frontend-only.
#   The projectId/orgId below are project identifiers, not secrets.
#
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Pin the root link to the "bonbox" project. Idempotent — safe to run anytime.
mkdir -p .vercel
cat > .vercel/project.json <<'JSON'
{"projectId":"prj_mKrBIPiviS2HJNRoLFtDtuf0B7wm","orgId":"team_04HD79Tk6O8AX91if4gRNOrr","projectName":"bonbox"}
JSON

echo "▸ Deploying working tree → bonbox (production)…"
vercel --prod --yes

cat <<'NOTE'

✓ Deployed to production.
  Verify: curl -sI https://www.bonbox.dk/ | grep -i last-modified
  If the page looks stale, clear the service worker:
    DevTools ▸ Application ▸ Service Workers ▸ Unregister → hard-reload.
NOTE
