#!/bin/sh
# Wrapper so the tool can be called as updateinventory.sh from any shell.
exec node "$(dirname "$0")/updateinventory.mjs" "$@"
