#!/usr/bin/env bash
# One-time (idempotent) setup inside WSL. Usage: bash scripts/wsl/setup.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$REPO_ROOT"

if ! command -v uv >/dev/null 2>&1; then
  echo "==> Installing uv into ~/.local/bin"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "==> Creating Python $PYTHON_VERSION venv at $VENV_DIR"
  uv venv "$VENV_DIR" --python "$PYTHON_VERSION"
fi
echo "==> Installing Python dependencies"
uv pip install --python "$VENV_DIR/bin/python" -r requirements-dev.txt

if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" --version)" != "$NODE_VERSION" ]; then
  echo "==> Installing Node $NODE_VERSION into $NODE_DIR"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$NODE_DIR" --strip-components=1
fi

echo "==> Installing frontend dependencies (Linux build of node_modules)"
cd frontend
# node_modules contains platform-specific binaries (esbuild); reinstall if it was created on Windows.
if [ -d node_modules ] && [ "$(cat node_modules/.fraudgraph-platform 2>/dev/null)" != "linux" ]; then
  rm -rf node_modules
fi
npm install --no-audit --no-fund
echo linux > node_modules/.fraudgraph-platform
cd ..

echo "==> Generating synthetic dataset"
"$VENV_DIR/bin/python" scripts/generate_dataset.py

[ -f .env ] || { cp .env.example .env; echo "==> Created .env from .env.example (add GEMINI_API_KEY to enable Gemini)"; }
echo "==> Setup complete. Python: $("$VENV_DIR/bin/python" --version), Node: $(node --version)"
