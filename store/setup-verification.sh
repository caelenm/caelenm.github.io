#!/bin/sh
# Wrapper so the tool can be run as ./setup-verification.sh from any shell.
set -e

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script="$dir/setup-verification.mjs"

if [ ! -f "$script" ]; then
  echo "setup-verification.mjs is missing from $dir" >&2
  exit 1
fi

# Under WSL the Windows node.exe is usually not on PATH, and a bare `exec node`
# there fails in a way that is easy to mistake for the script doing nothing.
if command -v node >/dev/null 2>&1; then
  node_bin=node
elif command -v nodejs >/dev/null 2>&1; then
  node_bin=nodejs
else
  echo "Node.js was not found on this shell's PATH." >&2
  echo >&2
  echo "If you are in WSL, Windows installs of Node are usually not visible here." >&2
  echo "Install it inside WSL:" >&2
  echo "    sudo apt update && sudo apt install -y nodejs" >&2
  echo >&2
  echo "Or run the script from Windows instead:" >&2
  echo "    node setup-verification.mjs" >&2
  exit 127
fi

exec "$node_bin" "$script" "$@"
