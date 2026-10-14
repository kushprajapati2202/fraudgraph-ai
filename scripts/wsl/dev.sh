#!/usr/bin/env bash
# Run the API (:8000) and Vite dev server (:5173) from WSL. Open http://127.0.0.1:5173 in the Windows browser.
# Usage: bash scripts/wsl/dev.sh [api|web|all]   (default: all)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$REPO_ROOT"
activate_venv
mode="${1:-all}"

run_api() { uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir backend; }
# --host 0.0.0.0 so the Windows browser can reach Vite through WSL2 localhost forwarding.
run_web() { cd frontend && npm run dev -- --host 0.0.0.0; }

case "$mode" in
  api) run_api ;;
  web) run_web ;;
  all)
    run_api & api_pid=$!
    trap 'kill $api_pid 2>/dev/null || true' EXIT INT TERM
    run_web
    ;;
  *) echo "usage: $0 [api|web|all]"; exit 2 ;;
esac
