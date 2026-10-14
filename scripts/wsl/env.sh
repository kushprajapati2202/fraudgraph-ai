# Shared environment for the WSL scripts. Sourced, not executed.
# Everything installs under $HOME (no sudo): uv in ~/.local/bin, Node in ~/.local/node,
# the Python venv in ~/.venvs/fraudgraph, and the SQLite DB on the Linux filesystem
# (SQLite locking on /mnt/<drive> is unreliable).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="${FRAUDGRAPH_VENV:-$HOME/.venvs/fraudgraph}"
NODE_DIR="${FRAUDGRAPH_NODE:-$HOME/.local/node}"
NODE_VERSION="${FRAUDGRAPH_NODE_VERSION:-v20.18.1}"
PYTHON_VERSION="${FRAUDGRAPH_PYTHON_VERSION:-3.12}"

export PATH="$HOME/.local/bin:$NODE_DIR/bin:$PATH"
export DB_PATH="${DB_PATH:-$HOME/.cache/fraudgraph/fraudgraph.db}"
mkdir -p "$(dirname "$DB_PATH")"

activate_venv() {
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
}
