# gaslamp

Hand work between Claude Code and Codex over MCP. Either agent can pass the lamp
to the other for a review, a second opinion, or a fix — no tmux, no subagent
middleman, no app-server broker. Both sides can **read and write**.

## Why this exists

The stock Codex connector for Claude dispatches a Claude *subagent* whose only
job is to shell out to Codex through Codex's experimental `app-server` broker.
That layering hangs ~half the time, and there's no reverse channel (Codex can't
call Claude at all).

Talking to `codex mcp-server` directly round-trips in ~5s with zero hangs — the
hang was the broker + subagent layering, never Codex itself. So:

| direction | mechanism | what the agent calls |
|-----------|-----------|----------------------|
| **Claude → Codex** | `codex mcp-server` registered in Claude as `gaslamp` | `gaslamp/codex`, `gaslamp/codex-reply` |
| **Codex → Claude** | `gaslamp.mjs` (this repo) registered in Codex as `gaslamp` | `gaslamp`, `gaslamp-reply` |

`claude mcp serve` is *not* used for the reverse direction: it exposes Claude's
*tools* (Bash/Read/Edit) and a one-shot `Agent` spawn, not a persistent
conversation. Hence the thin shim.

## Setup

```sh
./setup.sh        # registers both directions as `gaslamp`
```

Then **restart Claude Code** (or start a new session) so it loads the server.
The Codex side is live immediately. Verify with `codex mcp list` / `claude mcp list`.
Re-run `setup.sh` after an `nvm` node/codex upgrade (paths are version-pinned).

## Using it

- **From Codex:** call `gaslamp` with a `prompt` (and optional `cwd`, `model`).
  Claude works in `cwd` with full read/write and returns a summary. The result's
  `structuredContent.sessionId` feeds `gaslamp-reply` to continue.
- **From Claude:** call `gaslamp/codex`. Codex reads and writes by default,
  following your `~/.codex/config.toml` `sandbox_mode` (full read/write when it's
  `workspace-write` or `danger-full-access`). Pass a `sandbox` arg to override per
  call. Its `structuredContent.threadId` feeds `gaslamp/codex-reply`.

Codex→Claude consultations are appended to `~/.codex/gaslamp.log`:

```
→ codex asks claude @ /Users/a9lim/Work/saklas: fix the off-by-one in the window slicer
← claude ok (8120ms, session 564b5b2e): Fixed — the slice end was exclusive; …
```

`tail -f ~/.codex/gaslamp.log` is the lightweight "watch them talk" view.
(Only the Codex→Claude direction is logged here; the other direction goes
through Codex's native server.)

## Design decisions

- **Read/write by default.** The consulted Claude can edit files in `cwd`
  (`--dangerously-skip-permissions`, matching the full-access posture Codex
  already runs with). Set `GASLAMP_READONLY=1` for an advisory, no-edit reviewer.
- **No recursion.** Claude is launched with `--strict-mcp-config` + an empty MCP
  config, so a consulted Claude has *no* MCP servers — it can't pass the lamp
  back into Codex, and it stays lean.
- **OAuth, not API key.** The shim strips `ANTHROPIC_API_KEY` from the child env
  so Claude uses keychain OAuth.

## ⚠️ Directory trust gates Codex→Claude

Codex requires **approval** for MCP tool calls — a separate gate from
`approval_policy` (which only covers shell commands). It's auto-granted in
**trusted** project dirs (`[projects."…"] trust_level = "trusted"` in
`~/.codex/config.toml`); in an untrusted dir Codex shows a one-time approval
prompt (approve "always" to persist). All of `~/Work` is trusted, so real
consultations just work. If a `gaslamp` call from Codex stalls, check the cwd is
under a trusted project.

## Env knobs (on the Codex-side `gaslamp` registration)

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_READONLY` | unset | `1` → advisory, no-edit reviewer |
| `GASLAMP_ALLOWED_TOOLS` | read-only set | tools when `GASLAMP_READONLY=1` |
| `GASLAMP_TIMEOUT_MS` | `600000` | per-consultation timeout |
| `GASLAMP_LOGFILE` | `~/.codex/gaslamp.log` | transcript path; `off` to disable |
| `GASLAMP_DEBUG` | unset | verbose stderr (raw JSON-RPC) |
| `CLAUDE_BIN` | autodetected | path to the `claude` binary |

## Files

- `gaslamp.mjs` — the MCP server (zero deps, stdio JSON-RPC)
- `empty-mcp.json` — the empty MCP config handed to the consulted Claude
- `setup.sh` — registers both directions
