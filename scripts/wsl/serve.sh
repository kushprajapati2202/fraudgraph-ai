#!/usr/bin/env bash
# Production-like single URL: build the UI, then serve UI + API on http://localhost:8000.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$REPO_ROOT"
activate_venv
(cd frontend && npm run build)
exec uvicorn backend.main:app --host 0.0.0.0 --port "${PORT:-8000}"
