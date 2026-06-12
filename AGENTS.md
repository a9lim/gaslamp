# AGENTS.md

## What this is

`gaslamp` lets Claude Code and Codex hand work to each other from the shell.
Either agent can pass the lamp to the other for a review, a second opinion, or
a fix; both sides can read and write; consults run in parallel and replies
trickle in as they finish.

2.0 replaced the 1.0 MCP servers with a direct CLI. The 1.0 design (two MCP
registrations, a custom stdio server wrapping `claude -p`) fixed the stock
connector's hangs, but MCP tool calls are blocking and serial: one consult at a
time, the caller pinned until it returns. The 2.0 finding is that **asynchrony
is the harness's job** — both agents already have background-task facilities
that notify on completion — so the right wrapper is a plain blocking CLI the
harness backgrounds, not a daemon, a job spool, or a second async layer.

Going CLI also deleted 1.0's three ugliest parts for free:

- the `tool_timeout_sec` saga (Codex's MCP client guillotined every call at
  ~120s, the timeout couldn't be persisted by `codex mcp add`, and progress
  notifications didn't reset the deadline — setup had to patch config.toml by
  hand). No MCP client, no client deadline.
- the elicitation/trust-gate bug class (Codex gated MCP tool calls behind a
  per-directory approval *separate* from `approval_policy`; an unanswered
  elicitation looked exactly like a hang — 1.0's hardest bug). Shell commands
  are governed by `approval_policy`, full stop.
- the two-mechanism recursion guard (a `--disallowedTools` deny on one side, an
  env sentinel injected at registration time on the other, because only one
  side was our code). In 2.0 both spawns are ours; one sentinel covers both.

## Architecture

One binary, both directions. The agent shells out; gaslamp spawns the other
agent's headless mode, blocks, and prints the reply.

| direction | what runs |
|-----------|-----------|
| **Claude → Codex** | `gaslamp codex …` → `codex exec [resume <sid>] --json -o <job>/reply.md -c shell_environment_policy.set.GASLAMP_NESTED="1" … -` |
| **Codex → Claude** | `gaslamp claude …` → `claude -p --output-format stream-json --verbose [--resume <sid>] …` (prompt on stdin) |

Flow of one consult (`src/consult.mjs`):

1. **Preflights.** Refuse if nested (`GASLAMP_NESTED`, exit 3 — a consult is
   one hop) or if the surrounding sandbox has no network
   (`CODEX_SANDBOX_NETWORK_DISABLED=1`, exit 4 — neither backend could phone
   home; a pointed error beats a mysterious timeout).
2. **Resume resolution.** `--resume` takes a session id *or a prior job id*
   (the handle the caller actually has); job ids resolve through the job
   record's `meta.json`.
3. **Lock.** Resumes take an atomic-create lockfile keyed
   `<backend>--<sessionId>` — two concurrent consults into the same session is
   undefined behavior on both backends, so the second is refused (exit 5).
   Dead-holder locks are reaped automatically.
4. **Job record.** Everything writes through to `~/.gaslamp/jobs/<id>/`
   (`meta.json`, `prompt.md`, `events.jsonl`, `reply.md`, `stderr.log`) as it
   happens. This is passive durability, not a daemon — see below.
5. **Spawn.** The backend runs in its own process group (`detached: true`),
   prompt always on stdin, `GASLAMP_NESTED=1` in its env;
   `ANTHROPIC_API_KEY` is stripped from a consulted Claude's env so keychain
   OAuth is authoritative (a stale env key 401s every call — 1.0's auth
   lesson, still true).
6. **Stream.** stdout events write through to `events.jsonl`; the session id
   is captured the moment the backend reports it (claude: `system:init`;
   codex: `thread.started`) and lands in `meta.json` immediately.
7. **Signals.** SIGINT/SIGTERM/SIGHUP → kill the whole child group, escalate
   to SIGKILL after 2s, mark the record `killed`, release the lock.
8. **Reply.** Print the reply plus a greppable trailer
   (`[gaslamp] job: … · session: … · resume: …`), or a `--json` envelope.

### Killed consults: resume, not orphans

Two of the spar's concerns pulled opposite ways — "kill the process group on
signal, no orphans" vs "the job dir is the escape hatch when the harness kills
the wrapper." Resolution: kill-group wins (a deliberately orphaned backend
invisibly double-burns API quota), and the recovery story is **resume, not
survival**. Because the session id is recorded within seconds of spawn, a
killed 40-minute consult costs the in-flight turn, not the session: `--resume`
it and ask for the conclusion. Both backends persist session state on their
side as they go.

This is also why claude runs `--output-format stream-json` rather than plain
`json`: plain json buffers everything until exit, so a killed wrapper would
leave nothing — no session id, no events. Stream mode makes the write-through
record real.

## Things that are not obvious

- **`shell_environment_policy.inherit = "core"` strips the sentinel.** A
  consulted Codex with that config (the author's) does not pass inherited env
  like `GASLAMP_NESTED` into its shell commands — so a nested `gaslamp` call
  would never see it and the one-hop guard would silently die in that
  direction. Fix: the spawn passes
  `-c shell_environment_policy.set.GASLAMP_NESTED="1"`, which forces the var
  into every shell command. **The dotted leaf MERGES with the user's
  `[shell_environment_policy.set]` table** (verified on codex 0.139 — existing
  vars survive); it does not replace it.
- **The guard is loop prevention, not a security boundary.** A shell-capable
  consulted agent could unset the env var. That's fine — its job is to stop
  accidental recursion, and `GASLAMP_ALLOW_RECURSION=1` is a documented
  opt-out anyway. The spawned claude also gets `--disallowedTools
  mcp__gaslamp` as belt-and-braces against *stale 1.0 MCP registrations*
  (deny rules hold even under `--dangerously-skip-permissions`).
- **The sentinel is an env footgun for tests.** Inside a consulted agent,
  `GASLAMP_NESTED=1` is ambient — and anything that spawns gaslamp inherits
  it, including this repo's own test suite, which then fails with nested
  refusals (found by a consulted Codex *running the suite during the design
  spar*). The tests scrub `GASLAMP_*` / `CODEX_SANDBOX_*` /
  `ANTHROPIC_API_KEY` from every spawn env; `doctor` flags an ambient
  sentinel.
- **Codex sets `CODEX_SANDBOX_NETWORK_DISABLED=1` in sandboxed shells** (and
  `CODEX_SANDBOX=seatbelt`) when network is off — under default
  `workspace-write`, DNS fails outright. 1.0's MCP server ran *outside* the
  per-command sandbox; the 2.0 CLI runs *inside* it. Hence the preflight: a
  consult from a network-disabled Codex refuses immediately with instructions,
  for both backends (the wrapper can't reach Anthropic *or* OpenAI from
  there). Published-package users on stock sandboxes hit this; full-access
  setups never do.
- **Session id channels differ per backend, and codex's reply comes from
  `-o`.** claude stream-json: `{"type":"system","subtype":"init","session_id"}`
  first, `{"type":"result","result","is_error","session_id"}` last — both
  parsed. codex `--json`: `{"type":"thread.started","thread_id"}` up front is
  the id; the final text is taken from `-o <file>` (authoritative, schema-
  stable) with a tolerant `item.completed`/`agent_message` fallback. `codex
  exec resume <id>` accepts the `thread_id` and takes the same flags
  (verified live: fresh + resume, both backends, including resume-by-job-id).
- **`codex exec resume` has no `-s` flag**, so the sandbox override rides
  `-c sandbox_mode="…"` on both the fresh and resume forms. Claude has no
  filesystem sandbox, so `--sandbox workspace-write` on the claude verb is a
  usage error rather than a silent lie; `read-only` maps to
  `--permission-mode default --allowedTools <read set>` (which beats the
  user's defaultMode, even bypass) and `danger-full-access` to
  `--dangerously-skip-permissions`. Omitted = the consulted agent's own
  config, both directions.
- **Exit-without-truncation.** Failure messages go through `writeSync(2, …)`
  and the close path sets `process.exitCode` instead of calling
  `process.exit()` — stdout/stderr to a *pipe* are async in Node, and a hard
  exit can truncate exactly the message that explains the failure.
- **Why block-until-reply and not detach-and-poll.** The load-bearing premise
  is that both harnesses can background a long shell command and report
  completion; a consulted Codex verified its own side empirically during the
  design spar (multi-minute background command inside `codex exec` 0.139,
  work continuing, completion delivered). If some Codex surface turns out not
  to background reliably, the job record is the escape hatch — the same
  `jobs`/`poll` readers work fine over a consult driven by `nohup … &`.

## Working on it

Zero dependencies; system `node` runs everything. No build step. The CLI entry
is `bin/gaslamp.mjs`; the consult engine is `src/consult.mjs`.

```sh
./setup.sh                 # from-source: gaslamp setup --local (pins this checkout)
gaslamp setup              # on an installed copy
gaslamp doctor             # binaries, guidance blocks, stale 1.0 regs, state

npm run check              # node -c syntax check on every source file
npm test                   # node --test against stub claude AND codex binaries
```

Setup is idempotent: it removes 1.0 MCP registrations (incl. legacy names),
upserts the guidance block between `<!-- gaslamp:begin/end -->` markers in
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, and allowlists the command in
`~/.claude/settings.json`. A CLI doesn't self-advertise in context the way MCP
tools did — the guidance blocks *are* the discoverability story.

To exercise by hand: `node bin/gaslamp.mjs claude --model haiku "ping"` is a
cheap live round-trip; `tail -f ~/.gaslamp/jobs/<id>/events.jsonl` watches one
in flight; `gaslamp jobs` / `gaslamp poll --last` read the records.

## Files

- `bin/gaslamp.mjs` — CLI entry; dispatches consult verbs / jobs / poll /
  setup / doctor; `serve` is a migration tombstone for stale 1.0 registrations
- `src/consult.mjs` — the heart: preflights, locks, spawn, stream, signals
- `src/jobs.mjs` — durable job records + `jobs` / `poll` readers
- `src/setup.mjs` — 1.0 teardown + guidance blocks + allowlist (`--local`
  pins this checkout's absolute bin path)
- `src/doctor.mjs` — non-invasive health check
- `src/which.mjs` — PATH lookup without spawning a shell
- `tests/cli.test.mjs` — consults end-to-end against stub backends
- `tests/setup.test.mjs` — pure helpers + e2e setup/doctor in a temp HOME
- `setup.sh` — thin from-source wrapper around `gaslamp setup --local`
- `package.json` — npm metadata; version is the single source of truth

## Env knobs and exit codes

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_HOME` | `~/.gaslamp` | state dir (jobs + locks) |
| `GASLAMP_ALLOWED_TOOLS` | `Read Grep Glob WebFetch WebSearch` | tools the claude `read-only` override permits |
| `GASLAMP_ALLOW_RECURSION` | unset | let consulted agents consult back (off = one hop) |
| `GASLAMP_NESTED` | set by gaslamp on children | the one-hop sentinel; consult verbs refuse under it. Not user-set |
| `GASLAMP_DEBUG` | unset | verbose stderr (spawn argv) |
| `CLAUDE_BIN` / `CODEX_BIN` | autodetected | backend binaries |

Exit codes: `0` reply delivered · `1` consult failed/killed · `2` usage ·
`3` nested (one-hop) refusal · `4` network-disabled sandbox · `5` session
busy · `poll`: `10` still running.
