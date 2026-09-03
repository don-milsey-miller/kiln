#!/usr/bin/env bash
# Run the compatibility spike on a POSIX host that may not have Node.
#
# Installs nothing system-wide: Node lands under /tmp and disappears with the next reboot. If the
# host already has a Node new enough for the pinned runtime, this uses it and downloads nothing.
#
#   bash tools/pi-compat/posix-bootstrap.sh
#
# ⚠️ /tmp DOES NOT SURVIVE A WSL RESTART. The saved result goes straight into the repository's
# `runs/` directory, so the evidence is committed rather than left in a directory that evaporates —
# an earlier result set was lost exactly that way.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NODE_VER="${NODE_VER:-v24.11.0}"
CACHE=/tmp/kiln-node

need_node() {
  command -v node >/dev/null 2>&1 || return 0
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -lt 22 ]
}

if need_node; then
  if [ ! -x "$CACHE/bin/node" ]; then
    echo "==> no suitable node; fetching $NODE_VER into $CACHE (nothing installed system-wide)"
    mkdir -p "$CACHE"
    arch="$(uname -m)"
    case "$arch" in
      x86_64) arch=x64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
    esac
    curl -sSL -o /tmp/kiln-node.tar.xz "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${arch}.tar.xz"
    tar -xJf /tmp/kiln-node.tar.xz -C "$CACHE" --strip-components=1
  fi
  export PATH="$CACHE/bin:$PATH"
fi

echo "==> node $(node --version), npm $(npm --version)"
cd "$REPO"
exec node tools/pi-compat/run-all.mjs "$@"
