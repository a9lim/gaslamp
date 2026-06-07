# gaslamp

[![CI](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml/badge.svg)](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![npm downloads](https://img.shields.io/npm/dm/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![node](https://img.shields.io/node/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Pass the lamp between Claude Code and Codex over MCP. Either agent can hand work
to the other for a review, a second opinion, or a fix — no tmux, no subagent
middleman, no app-server broker. Both sides can **read and write**. Zero
dependencies.

## Why this exists

The stock Codex connector for Claude dispatches a Claude *subagent* whose only
job is to shell out to Codex through Codex's experimental `app-server` broker.
That layering hangs ~half the time, and there's no reverse channel (Codex can't
call Claude at all).

Talking to `codex mcp-server` directly round-trips in ~5s with zero hangs — the
hang was the broker + subagent layering, never Codex itself. So gaslamp deletes
both layers and wires the two CLIs to each other as plain MCP servers:

| direction | mechanism | what the agent calls |
|-----------|-----------|----------------------|
| **Claude → Codex** | `codex mcp-server` registered in Claude as `gaslamp` | `gaslamp/codex`, `gaslamp/codex-reply` |
| **Codex → Claude** | this package, registered in Codex as `gaslamp` | `gaslamp`, `gaslamp-reply` |

`claude mcp serve` is *not* used for the reverse direction: it exposes Claude's
*tools* (Bash/Read/Edit) and a one-shot `Agent` spawn, not a persistent
conversation. Hence the thin shim in `src/server.mjs`.

## Requirements

Both CLIs installed and logged in: [Claude Code](https://docs.claude.com/en/docs/claude-code)
and [Codex](https://github.com/openai/codex). Node ≥ 18.

## Install

```sh
npm install -g gaslamp
gaslamp setup           # register both directions
gaslamp doctor          # verify binaries + registrations
```

Then **restart Claude Code** (or start a new session) so it loads the server.
The Codex side is live immediately.

Zero-install also works — `gaslamp setup` registers Codex to spawn
`npx -y gaslamp serve`, so there's no absolute, version-pinned path to break when
you upgrade node:

```sh
npx gaslamp setup
```

### From source

```sh
git clone https://github.com/a9lim/gaslamp
cd gaslamp
./setup.sh              # === node bin/gaslamp.mjs setup --local
```

`--local` registers *this checkout* (`node …/bin/gaslamp.mjs serve`) instead of
the published package — use it before the package is published, or for dev.

## Using it

- **From Codex:** call `gaslamp` with a `prompt` (and optional `cwd`, `model`,
  `sandbox`). Claude works in `cwd` with full read/write by default and returns a
  summary; pass `sandbox: "read-only"` for an advisory, no-edit reviewer. The
  result's `structuredContent.sessionId` feeds `gaslamp-reply` to continue.
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

## CLI

```
gaslamp [serve]        Run the MCP server on stdio (what Codex spawns).
gaslamp setup          Register both directions (add --local for this checkout).
gaslamp doctor         Check binaries + registrations (no round-trip).
gaslamp --version      Print the version.
gaslamp --help         Print help.
```

## Design decisions

- **Mirrors `codex mcp-server`.** Same interface shape as the Codex→Claude
  reference: a per-call `sandbox` arg (`read-only` | `workspace-write` |
  `danger-full-access`), defaulting to `GASLAMP_SANDBOX` the way Codex defaults to
  `sandbox_mode` in `config.toml`. No bespoke timeout and no recursion isolation —
  a consulted Claude inherits the parent env and loads your full config/MCP, just
  as a consulted Codex does.
- **Sandbox mapping.** Claude has no filesystem-scoped sandbox, so `workspace-write`
  and `danger-full-access` both grant full read/write
  (`--dangerously-skip-permissions`); `read-only` restricts to a read-only tool
  allowlist (advisory reviewer). All three values are accepted for parity with
  Codex; the latter two map alike.
- **OAuth, not API key.** The shim strips `ANTHROPIC_API_KEY` from the child env so
  Claude authenticates via keychain OAuth. This is kept despite the mirror goal: it
  has no Codex analog (Codex never reads that var), and without it a stale env key
  401s every consultation.

## ⚠️ Directory trust gates Codex→Claude

Codex requires **approval** for MCP tool calls — a separate gate from
`approval_policy` (which only covers shell commands). It's auto-granted in
**trusted** project dirs (`[projects."…"] trust_level = "trusted"` in
`~/.codex/config.toml`); in an untrusted dir Codex shows a one-time approval
prompt (approve "always" to persist). If a `gaslamp` call from Codex stalls,
check the cwd is under a trusted project.

## Env knobs (on the Codex-side `gaslamp` registration)

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_SANDBOX` | `workspace-write` | default sandbox when a call omits `sandbox` (`read-only` = advisory reviewer) |
| `GASLAMP_ALLOWED_TOOLS` | read-only set | tools available under the `read-only` sandbox |
| `GASLAMP_LOGFILE` | `~/.codex/gaslamp.log` | transcript path; `off` to disable |
| `GASLAMP_DEBUG` | unset | verbose stderr (raw JSON-RPC) |
| `CLAUDE_BIN` | autodetected | path to the `claude` binary |

## Development

Zero dependencies; system `node` runs everything. No build step.

```sh
npm test                # node --test against a stub claude binary
npm run check           # node -c syntax check on every source file
```

To exercise the server by hand, speak newline-delimited JSON-RPC over stdio:
`initialize` → `notifications/initialized` → `tools/list` → `tools/call`.

See [AGENTS.md](AGENTS.md) for the architecture deep-dive and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
