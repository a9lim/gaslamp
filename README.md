# gaslamp

[![CI](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml/badge.svg)](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![npm downloads](https://img.shields.io/npm/dm/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![node](https://img.shields.io/node/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Let Claude Code and Codex consult each other from the shell.

```sh
gaslamp codex  "review this diff for races: …"     # Claude asks Codex
gaslamp claude "verify this proof sketch: …"       # Codex asks Claude
git diff | gaslamp codex "review for races:"       # piped stdin rides as evidence
gaslamp codex - < notes/design-spar.md             # or: the whole prompt from a file
gaslamp claude --thread api-spar "counterpoint: …" # named session, continued
```

Each call blocks until the reply, then prints it plus a greppable trailer:

```
lamplight
[gaslamp] job: cx-20260612-142457-744e · session: 019ebdb9-… · resume: gaslamp codex --resume 019ebdb9-… · tok: 32k→60
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
gaslamp setup           # allowlist the command in ~/.claude/settings.json
gaslamp setup --skill   # …and install the gaslamp skill for BOTH agents
```

`setup` allowlists the command so a consult doesn't stall on a permission
prompt. It does **not** touch your agent instructions: a CLI can't
self-advertise the way MCP tools did, so each agent needs to learn gaslamp
exists from somewhere. The clean way is `--skill`: both CLIs speak the same
SKILL.md standard, so one flag installs a direction-aware skill on each side
(`~/.claude/skills/gaslamp/` teaching Claude to consult Codex,
`$CODEX_HOME/skills/gaslamp/` teaching Codex to consult Claude). The manual
alternative is a short note pasted into each agent's instruction file.

**`~/.claude/CLAUDE.md`** — so Claude consults Codex:

> Hand work to Codex for a second pair of eyes — verify a fix, spar on a design,
> review a diff, diagnose with fresh context. Send raw evidence (errors, diffs,
> commands), not just your framing.
>
> ```
> gaslamp codex [--thread <name>] [--model <m>] [--sandbox <mode>] "<prompt>"
> git diff | gaslamp codex "…"      # piped stdin rides as an evidence block
> gaslamp codex --json --schema '<json-schema>' "…"   # typed reply in .data
> gaslamp fleet codex -n N "…"      # fan out N takes in one command
> ```
>
> Run it as a background shell task (`run_in_background`) and keep working — the
> reply lands when it's done; several can run in parallel. A consult is one hop
> (the consulted agent can't consult back), so own the synthesis. `gaslamp jobs`
> lists records, `gaslamp poll <job|--last>` fetches one (exit 10 = running),
> `gaslamp threads` lists named sessions.

**`~/.codex/AGENTS.md`** — so Codex consults Claude: the same block with
`claude`/`Claude` in place of `codex`/`Codex`, and "run it in your background
terminal, check back between steps" in place of the `run_in_background` line.

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
gaslamp fleet <backend> [opts]     Fan out a fleet of consults in one command.
gaslamp fleet --resume <fleet-id>  Finish an interrupted fleet.
gaslamp jobs [-n N] [--json]       List consult records, newest first.
gaslamp threads                    List named threads, latest activity first.
gaslamp poll <job|fleet|--last> [--json]   One record's reply/status (exit 10 = running).
gaslamp tail <job|--last>          Follow one consult's events as one-liners.
gaslamp setup [--local] [--skill]  Allowlist the command; --skill installs the
                                   gaslamp skill for both agents.

Consult options:
  --resume <session|job>   Continue a session (a prior job id works too).
  --thread <name>          Named session: continue if bound, else start + bind.
  --model <m>              Backend model override.
  --effort <level>         Reasoning effort (native on both backends).
  --schema <file|json>     JSON Schema for the reply; --json gains data.
  --label <s>              Tag the job record (shows in gaslamp jobs).
  --sandbox <mode>         claude: read-only | danger-full-access
                           codex:  read-only | workspace-write | danger-full-access
  --raw                    Skip the consult preamble.
  --cwd <dir>              Working directory for the consult.
  --json                   {backend, jobId, sessionId, status, exitCode,
                            content, label?, usage?, data?}

Fleet options (plus the consult options above, applied to every consult):
  -n, --count N            Replicate the prompt across N fresh sessions.
  -j, --concurrency N      Max consults in flight (default 4).
  --stream                 Print replies as they complete (--json: JSONL).
  - < tasks.jsonl          One task per line: {"prompt", model?, sandbox?,
                           effort?, cwd?, resume?, thread?, label?, schema?,
                           raw?} or a bare prompt.
```

## Evidence on stdin

A prompt argument plus piped stdin composes them: the prompt frames, stdin is
the evidence, appended as a `<stdin>` block (codex's own convention for the
case, applied to both backends):

```sh
git diff | gaslamp codex "review this diff for races:"
cargo test 2>&1 | gaslamp claude "why is this failing?"
```

Send raw evidence — errors, diffs, failing output — not just your framing of
it; the fresh-context advantage works on facts. A bare `-` (or piping with no
prompt argument) still reads the whole prompt from stdin.

## Threads

`--thread <name>` is a named session: continue it if the name is bound, start
and bind it if not — idempotent, no fishing session UUIDs out of old trailers.

```sh
gaslamp codex --thread api-spar "opening take: …"
gaslamp codex --thread api-spar "counterpoint: …"    # same conversation
gaslamp threads                                      # list them
```

A thread is one pointer file under `~/.gaslamp/threads/`, re-pointed on every
consult. This matters doubly for claude, where each resume forks a *new*
session id — the pointer chases it automatically, which manual `--resume`
juggling cannot.

## Typed replies

`--schema <file|inline-json>` plumbs a JSON Schema to each backend's native
structured output (`claude --json-schema` / `codex exec --output-schema`); the
`--json` envelope then carries `data`, the parsed object. A reply that fails to
parse marks the consult **failed** — trust the exit code.

```sh
gaslamp codex --json --schema '{"type":"object","properties":{"verdict":
{"type":"string","enum":["correct","broken","unsure"]}},"required":["verdict"]}' \
  "is this fix correct? …" | jq .data.verdict
```

One backend asymmetry, papered over: OpenAI's endpoint only accepts *strict*
schemas (every object needs `additionalProperties:false` and all properties
required), so gaslamp strictifies schemas on the way to codex — spell optional
fields nullable (`{"type":["string","null"]}`) rather than leaving them out of
`required`. Claude takes the schema as written.

## The consult preamble

A consulted agent gets a few fixed lines of framing (claude via
`--append-system-prompt`, codex prepended as a `<gaslamp_consult>` block): it
is a one-hop consult, its final message returns verbatim to the calling agent,
deliver the deliverable. Without this, consulted agents reply conversationally
or promise work instead of doing it. `--raw` drops it. It is fixed and tiny by
design — not a context-injection hook.

## Fleets

`gaslamp fleet` fires a whole batch of consults from one command and blocks
until every reply is in — `-n N "<prompt>"` runs one prompt across N fresh
sessions (voting, diverse sampling), or a JSONL manifest on stdin runs one
`{prompt, model?, sandbox?, cwd?, resume?, label?}` task per line:

```sh
gaslamp fleet codex -n 5 "spot the worst bug in this diff: …"   # 5 takes, vote
gaslamp fleet claude - < tasks.jsonl                            # one task/line
gaslamp fleet codex -n 8 --json "…" | jq '.results[].content'   # structured
gaslamp fleet codex -n 4 --stream --json "…"                    # JSONL as they land
gaslamp fleet --resume fl-20260702-…                            # finish an interrupted one
```

Each task is a normal consult — its own job record and resumable session — so a
killed fleet costs in-flight turns, not sessions. Two safety defaults at N:
fleets run `--sandbox read-only` unless you opt into writes (N agents writing one
directory race), and a manifest that resumes the same session or thread twice is
refused (they'd deadlock on the session lock). `gaslamp poll <fleet-id>` regroups
a fleet's replies later. It's the same move as backgrounding one consult, one
layer up — and it's the only one-command fan-out Codex has, since (unlike Claude
Code) it has no built-in agent-workflow tool.

`--stream` prints each reply the moment it completes (completion order) so the
caller can peek partial output mid-run; with `--json` it becomes explicit JSONL —
one result line per reply, then a `fleet.done` line — leaving the collected
single-object `--json` contract untouched.

`fleet --resume <fleet-id>` finishes an interrupted fleet from its stored
manifest: done children replay their recorded replies, a killed child whose
session was captured is resumed with a fixed finish-and-deliver nudge (the
session already holds the prompt and partial work), and everything else reruns
fresh. The new fleet record points back via `resumedFrom`.

## Job records

Every consult writes through to `~/.gaslamp/jobs/<id>/` as it runs: the
prompt, the raw backend event stream, the reply, stderr, and a `meta.json`
whose session id is recorded the moment the backend reports it. If the
harness kills a consult mid-flight, the whole child process group dies with
it (no orphans silently burning API quota) — but the session survives on the
backend's side, so recovery is `--resume <session>`, not a lost half hour.

Token usage lands in the record too (claude's result usage + cost; codex's
per-turn usage, summed) and shows in the trailer — fleets are quota-shaped,
so quota is visible. `gaslamp jobs --json` and `gaslamp poll <id> --json`
make the records scriptable; `gaslamp tail <job|--last>` follows a running
consult's events as uniform one-liners across both backends' schemas.

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
| `GASLAMP_HOME` | `~/.gaslamp` | state dir (jobs + locks + threads) |
| `GASLAMP_ALLOWED_TOOLS` | `Read,Grep,Glob,WebFetch,WebSearch` + read-only git (`Bash(git diff:*)` etc) | tools the claude `read-only` override permits, comma-separated |
| `GASLAMP_ALLOW_RECURSION` | unset | allow consulted agents to consult back |
| `GASLAMP_DEBUG` | unset | verbose stderr (spawn argv) |
| `CLAUDE_BIN` / `CODEX_BIN` | autodetected | backend binaries |
| `CODEX_HOME` | `~/.codex` | where `setup --skill` puts Codex's copy |

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
