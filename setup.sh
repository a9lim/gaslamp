#!/usr/bin/env bash
# Register both consultation channels under the name `gaslamp`.
# Idempotent: removes prior registrations (incl. legacy names) first.
# Re-run after an nvm node/codex upgrade — the paths below are version-pinned.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node)"
CODEX="$(command -v codex)"
SHIM="$HERE/gaslamp.mjs"

echo "node:  $NODE"
echo "codex: $CODEX"
echo "shim:  $SHIM"

# --- Codex -> Claude: codex gets a `gaslamp` tool that hands off to Claude ----
codex mcp remove gaslamp >/dev/null 2>&1 || true
codex mcp remove claude  >/dev/null 2>&1 || true   # legacy name
codex mcp add gaslamp -- "$NODE" "$SHIM"
echo "registered: codex -> claude  (tool: gaslamp)"

# --- Claude -> Codex: claude gets gaslamp's codex tools (user scope) ----------
claude mcp remove gaslamp -s user >/dev/null 2>&1 || true
claude mcp remove codex   -s user >/dev/null 2>&1 || true   # legacy name
claude mcp add gaslamp -s user -- "$CODEX" mcp-server
echo "registered: claude -> codex  (tools: gaslamp/codex, gaslamp/codex-reply)  — restart Claude Code to load"

echo
echo "done. verify:  codex mcp list   and   claude mcp list"
