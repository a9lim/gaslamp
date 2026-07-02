#!/usr/bin/env bash
# Allowlist THIS checkout's gaslamp for Claude Code (from-source / dev).
# Thin wrapper around `gaslamp setup --local`; the real logic lives in
# src/setup.mjs. For an installed copy, just run `gaslamp setup`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/bin/gaslamp.mjs" setup --local "$@"
