# gaslamp

[![CI](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml/badge.svg)](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![npm downloads](https://img.shields.io/npm/dm/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![node](https://img.shields.io/node/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Let Claude Code and Codex consult each other from the shell — parallel,
background-friendly, resumable.

```sh
gaslamp codex  "review this diff for races: …"     # Claude asks Codex
gaslamp claude "verify this proof sketch: …"       # Codex asks Claude
gaslamp codex - < notes/design-spar.md             # long prompts via stdin
```

Each call blocks until the reply, then prints it plus a greppable trailer:

```
lamplight
[gaslamp] job: cx-20260612-142457-744e · session: 019ebdb9-… · resume: gaslamp codex --resume 019ebdb9-…
```

The agent backgrounds the call with its own facility (Claude Code:
`run_in_background`; Codex: its background terminal), keeps working, and gets
the reply when it lands — so several consults run in parallel and replies
trickle in. No MCP servers, no daemon: asynchrony is the harness's job, and
gaslamp stays a thin wrapper around `claude -p` / `codex exec`.

> 1.x was a pair of MCP servers. 2.0 replaced them with this CLI: MCP tool
> calls are blocking and serial, Codex's MCP client enforced a per-call
> timeout that killed long consults, and its per-directory trust gate could
> stall calls invisibly. All three problems are structural to MCP and absent
> from a shell call.

## Requirements

Both CLIs installed and logged in: [Claude Code](https://code.claude.com/docs)
and [Codex](https://developers.openai.com/codex). Node ≥ 18.

## Install

```sh
npm install -g gaslamp
gaslamp setup           # remove 1.x MCP registrations, install guidance blocks
gaslamp doctor          # verify binaries + setup
```

Setup writes a managed block (between `<!-- gaslamp:begin/end -->` markers)
into `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` so each agent knows the
tool exists and how to call it, and allowlists the command in
`~/.claude/settings.json`. Re-running it refreshes the blocks in place.

### From source

```sh
git clone https://github.com/a9lim/gaslamp
cd gaslamp
./setup.sh              # === gaslamp setup --local (pins this checkout's path)
```

## CLI

```
gaslamp claude [opts] <prompt|->   Consult Claude (blocks until the reply).
gaslamp codex  [opts] <prompt|->   Consult Codex  (blocks until the reply).
gaslamp jobs [-n N]                List consult records, newest first.
gaslamp poll <job|--last>          Print one record's reply/status (exit 10 = running).
gaslamp setup [--local]            Clean up 1.x; install guidance blocks + allowlist.
gaslamp doctor                     Health check.

Consult options:
  --resume <session|job>   Continue a session (a prior job id works too).
  --model <m>              Backend model override.
  --sandbox <mode>         claude: read-only | danger-full-access
                           codex:  read-only | workspace-write | danger-full-access
  --cwd <dir>              Working directory for the consult.
  --json                   {backend, jobId, sessionId, status, exitCode, content}
```

## Job records

Every consult writes through to `~/.gaslamp/jobs/<id>/` as it runs: the
prompt, the raw backend event stream, the reply, stderr, and a `meta.json`
whose session id is recorded the moment the backend reports it. If the
harness kills a consult mid-flight, the whole child process group dies with
it (no orphans silently burning API quota) — but the session survives on the
backend's side, so recovery is `--resume <session>`, not a lost half hour.
`tail -f ~/.gaslamp/jobs/<id>/events.jsonl` watches a consult live.

Two concurrent consults into the same session would race, so gaslamp refuses
the second (exit 5) until the first finishes.

## Permissions

A consult with no `--sandbox` runs with the consulted agent's own config —
exactly as that agent would behave if you drove it yourself. Overrides:
`read-only` forces an advisory, no-edit reviewer on either backend;
`danger-full-access` forces full read/write. Claude has no filesystem
sandbox, so `workspace-write` there is a usage error rather than a silent
lie (Codex supports all three).

Note for sandboxed Codex setups: the gaslamp CLI runs *inside* Codex's
per-command sandbox (1.x's MCP server ran outside it). Under the default
`workspace-write` sandbox, network is disabled and a consulted agent could
reach neither Anthropic nor OpenAI — gaslamp detects this
(`CODEX_SANDBOX_NETWORK_DISABLED=1`) and refuses with instructions instead of
timing out. Grant the call escalated permissions, or set
`network_access = true` / `danger-full-access` in `~/.codex/config.toml`.

## Recursion

A consult is **one hop**: agents gaslamp spawns carry `GASLAMP_NESTED=1`
(forced into Codex's shell env via config override, since a strict
`shell_environment_policy` would strip it) and the consult verbs refuse under
it. This is loop prevention, not a security boundary. Set
`GASLAMP_ALLOW_RECURSION=1` to restore unbounded handoffs.

## Env knobs

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_HOME` | `~/.gaslamp` | state dir (jobs + locks) |
| `GASLAMP_ALLOWED_TOOLS` | `Read Grep Glob WebFetch WebSearch` | tools the claude `read-only` override permits |
| `GASLAMP_ALLOW_RECURSION` | unset | allow consulted agents to consult back |
| `GASLAMP_DEBUG` | unset | verbose stderr (spawn argv) |
| `CLAUDE_BIN` / `CODEX_BIN` | autodetected | backend binaries |

Exit codes: `0` ok · `1` consult failed/killed · `2` usage · `3` nested
refusal · `4` network-disabled sandbox · `5` session busy · `poll`: `10`
still running.

## Development

```sh
npm test                # node --test against stub claude and codex binaries
npm run check           # node -c syntax check on every source file
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
