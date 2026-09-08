#!/bin/sh
# Candidate PATH applies to the official display, control process and both engines.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec uv run --script "$script_dir/../packages/agent-server/scripts/codex-ingress-upgrade-check.py" "$@"
