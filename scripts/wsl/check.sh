#!/usr/bin/env bash
# Run all checks in WSL: backend tests, frontend typecheck and production build.
# Usage: bash scripts/wsl/check.sh [--eval]   (--eval also regenerates docs/evaluation.md)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$REPO_ROOT"
activate_venv

echo "==> Backend tests"
python -m pytest backend/tests -q -p no:cacheprovider

echo "==> Frontend typecheck + build"
(cd frontend && npm run typecheck && npm run build)

if [ "${1:-}" = "--eval" ]; then
  echo "==> Evaluation"
  python scripts/evaluate.py --latency > /dev/null 2>&1
  echo "Wrote docs/evaluation.md"
fi
echo "==> All checks passed"
