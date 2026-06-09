# gaslamp

[![CI](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml/badge.svg)](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![npm downloads](https://img.shields.io/npm/dm/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![node](https://img.shields.io/node/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Minimal MCP server that lets Claude and Codex talk to each other.

Gaslamp wires the two CLIs to each other as plain MCP servers:

| direction | server | tools |
|-----------|-----------|----------------------|
| **Claude → Codex** | `codex mcp-server` registered in Claude as `gaslamp` | `gaslamp/codex`, `gaslamp/codex-reply` |
| **Codex → Claude** | this package, registered in Codex as `gaslamp` | `gaslamp`, `gaslamp-reply` |

`claude mcp serve` only exposes Claude's
*tools* and a one-shot `Agent`, not a persistent
conversation, so we need a shim in `src/server.mjs`.

## Requirements

Both CLIs installed and logged in: [Claude Code](https://code.claude.com/docs)
and [Codex](https://developers.openai.com/codex). Node ≥ 18.

## Install

```sh
npm install -g gaslamp
gaslamp setup           # register both directions
gaslamp doctor          # verify binaries + registrations
```

Zero-install also works:

```sh
npx gaslamp setup
```

### From source

```sh
git clone https://github.com/a9lim/gaslamp
cd gaslamp
./setup.sh              # === node bin/gaslamp.mjs setup --local
```

## CLI

```
gaslamp [serve]        Run the MCP server on stdio (what Codex spawns).
gaslamp setup          Register both directions (add --local for this checkout).
gaslamp doctor         Check binaries + registrations.
gaslamp --version      Print version.
gaslamp --help         Print help.
```

## Permissions

A Codex→Claude consult with no `sandbox` arg runs with your own Claude config
(permission mode, allow/deny rules, model, MCP) — just as your interactive Claude
would. Per-call overrides: `read-only` (advisory, no edits) or `danger-full-access`
(full read/write). Claude has no filesystem sandbox, so there's no `workspace-write`.

## Recursion

A consult is **one hop** by default: a Claude reached through gaslamp can't turn
around and consult Codex, and a Codex reached through gaslamp can't consult Claude
back. (The Claude→Codex registration tags the consulted Codex with
`GASLAMP_NESTED=1`, and the spawned Claude is denied the bridge with
`--disallowedTools mcp__gaslamp`.) Only the top-level agent you drive can open a
consult. Set `GASLAMP_ALLOW_RECURSION=1` to restore unbounded, symmetric handoffs.

## Env knobs

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_ALLOWED_TOOLS` | `Read Grep Glob WebFetch WebSearch` | tools the `read-only` override permits |
| `GASLAMP_ALLOW_RECURSION` | unset | allow a consulted agent to consult back (off = one hop) |
| `GASLAMP_LOGFILE` | `~/.codex/gaslamp.log` | transcript path; `off` to disable |
| `GASLAMP_DEBUG` | unset | verbose stderr (raw JSON-RPC) |
| `CLAUDE_BIN` | autodetected | path to the `claude` binary |

## Development

```sh
npm test                # node --test against a stub claude binary
npm run check           # node -c syntax check on every source file
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
