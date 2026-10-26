# gaslamp

[![CI](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml/badge.svg)](https://github.com/a9lim/gaslamp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![npm downloads](https://img.shields.io/npm/dm/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![node](https://img.shields.io/node/v/gaslamp)](https://www.npmjs.com/package/gaslamp)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

Let coding agents consult each other from the shell: Claude, Codex, Gemini and
Grok.

```sh
gaslamp codex  "review this diff for races: …"         # Claude asks Codex
gaslamp claude "verify this proof sketch: …"           # Codex asks Claude
git diff | gaslamp codex "review for races:"           # piped stdin rides along as evidence
gaslamp gemini "what changed in the v5 API? cite URLs" # Gemini, through Antigravity CLI
gaslamp grok --thread launch "how did people react?"   # Grok, through Grok Build
```

Each call blocks until the reply, then prints it and one line:

```
lamplight
[gaslamp] job cx-20261026-142457-744e · continue: gaslamp codex --resume cx-20261026-142457-744e
```

The calling agent runs the command in the background (`run_in_background` in
Claude Code, a background terminal in Codex), keeps working, and gets the reply
when it lands, so several consults run at once. No MCP servers, no daemon:
asynchrony is the harness's job, and gaslamp stays a thin wrapper around each
agent's headless mode.

## Requirements

Node ≥ 18, and whichever agents you want to reach, installed and signed in:
[Claude Code](https://code.claude.com/docs), [Codex](https://developers.openai.com/codex),
[Antigravity CLI](https://antigravity.google/docs/cli/headless/) (`agy`, signed
in once interactively), [Grok Build](https://docs.x.ai/build/overview) (`grok login`).
Fenced Claude consults on Linux need `bubblewrap` and `socat`, which Claude
Code's sandbox runs on.

## Install

```sh
npm install -g gaslamp
gaslamp setup
```

`setup` links gaslamp's skill into `~/.claude/skills/` and
`$CODEX_HOME/skills/`, which is how both agents learn the command exists, and
allowlists `Bash(gaslamp *)` in `~/.claude/settings.json` so a consult doesn't
stall on a permission prompt. It is idempotent and never touches an agent's
instruction files. The skill is a link into the installed package, so it
always matches the binary.

From source: clone, `npm link`, `gaslamp setup`.

## CLI

```
gaslamp <claude|codex|gemini|grok> [opts] <prompt|->   Consult one; blocks until the reply.
gaslamp jobs [-n N] [--json]                          Recent consults, newest first.
gaslamp poll <job|--last> [--json]                    One consult's reply (exit 10 = running).
gaslamp threads                                       Named conversations, latest first.
gaslamp setup                                         Link the skill, allowlist the command.

  --thread <name>          Name the conversation: start it, or continue it.
  --resume <job-id>        Continue an unnamed consult's conversation.
  --model <m>              An exact id or a tier: claude fable|opus|sonnet|haiku,
                           codex astra|sol|luna, gemini argon|flash.
  --effort <level>         low|medium|high|xhigh|max.
  --sandbox <mode>         read-only | workspace-write | danger-full-access.
  --cwd <dir>              Where the consult runs.
  --schema <file|json>     JSON Schema for the reply (with --json: parsed into data).
  --json                   {backend, jobId, status, thread, content, error?, data?}
```

Tier words resolve against each harness's own model catalog, so a new
generation is picked up without a gaslamp release. A gemini consult always
pins a Gemini model (argon unless you say otherwise): Antigravity also serves
Claude and GPT models under the same account.

## Conversations

`--thread <name>` names a conversation. The first consult with a name starts
it and every later one continues it, so you never handle session ids:

```sh
gaslamp codex --thread api-spar "opening take: …"
gaslamp codex --thread api-spar "counterpoint: …"    # same conversation
gaslamp threads
```

A reused name carries the earlier context along, so name a conversation for
its subject, and use a new name for an independent second opinion. A thread
belongs to the directory it started in. From anywhere else, gaslamp refuses
(continue it with `--cwd`, or pick another name), so a common name can't pull
one repository's conversation into another. One consult runs per conversation
at a time; a second gets exit 5. Without `--thread`, a consult is a one-off,
and the trailer's `--resume <job-id>` still continues it.

## Sandboxes

| | omitted | read-only | workspace-write | danger-full-access |
|---|---|---|---|---|
| claude | its own config | Claude Code's sandbox, no writes | Claude Code's sandbox, cwd only | no checks |
| codex | its own config | codex's sandbox | codex's sandbox | no checks |
| gemini | read-only | Seatbelt, no writes (macOS) | Seatbelt, cwd only (macOS) | no checks |
| grok | read-only | grok's sandbox | grok's sandbox | no checks |

The fenced modes are enforced by the OS, and a fence that can't start refuses
the consult instead of running it unfenced. "No writes" means nothing outside
the harness's own state and temp dirs. The fences cover the filesystem, not
the network: a read-only consultee can still search and fetch. Claude Code's
sandbox wraps Bash commands only, so gaslamp also turns off Claude's file-edit
tools in read-only. A fenced Claude consult loads none of your Claude settings
files (only managed settings), because their sandbox exceptions would merge
into the fence: it runs without your hooks, env and permission rules.
Managed (organization) Claude settings still apply, and any sandbox exceptions
they grant apply inside the fence too. Grok's
and Gemini's own permission layers are skipped; their fence is the kernel's. Gemini's fence is Seatbelt (`sandbox-exec`) with agy's own
permission layer skipped. Seatbelt doesn't exist on Linux and doesn't nest
inside another sandbox, so in those environments a fenced gemini consult is
refused (exit 4).

Inside a sandboxed Codex with network off, no consult can reach its provider;
gaslamp detects `CODEX_SANDBOX_NETWORK_DISABLED=1` and refuses (exit 4)
instead of timing out.

## Evidence on stdin

A prompt argument plus piped stdin composes them: the prompt frames, and
stdin is appended as a `<stdin>` block. A bare `-`, or piping with no prompt
argument, reads the whole prompt from stdin.

```sh
cargo test 2>&1 | gaslamp claude "why is this failing?"
gaslamp codex - < notes/design-spar.md
```

## Typed replies

`--schema` plumbs a JSON Schema to each backend's native structured output.
With `--json` the parsed object lands in `data`, and a reply that doesn't
parse fails the consult.

```sh
gaslamp codex --json --schema '{"type":"object","properties":{"verdict":
{"type":"string","enum":["correct","broken","unsure"]}},"required":["verdict"]}' \
  "is this fix correct? …" | jq .data.verdict
```

OpenAI only accepts *strict* schemas (every object closed, every property
required), so gaslamp strictifies them on the way to codex. Spell an optional
field nullable (`{"type":["string","null"]}`) rather than leaving it out of
`required`.

## Records

Every consult writes through to `~/.gaslamp/jobs/<id>/` as it runs: the
prompt, the backend's raw event stream, its stderr, the reply, and a small
`meta.json` (status, error, session, thread, directory, timing). The session is
recorded the moment the backend reports it. If the calling harness kills a
consult, the whole child process group dies with it (no orphans quietly
burning quota), but the conversation survives on the backend's side, so you
continue it instead of starting over. Failure reasons, gaslamp's own included,
land in `error` and in the trailer.

The consultee gets a few fixed lines of framing: it is a one-hop consult, its
final message returns verbatim to the caller, so deliver the deliverable.

## Recursion

A consult is one hop: agents gaslamp spawns carry `GASLAMP_NESTED=1` (forced
into Codex's shell env through a config override, since a strict
`shell_environment_policy` would strip it), and the consult verbs refuse under
it. This is loop prevention, not a security boundary.
`GASLAMP_ALLOW_RECURSION=1` lifts it.

## Exit codes and environment

`0` ok · `1` failed or killed · `2` usage · `3` nested · `4` can't run here (no
network, or no OS sandbox for the mode) · `5` conversation busy · `poll`: `10`
still running.

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_HOME` | `~/.gaslamp` | state dir (jobs, locks, threads) |
| `GASLAMP_ALLOW_RECURSION` | unset | let consulted agents consult back |
| `GASLAMP_DEBUG` | unset | print the spawn argv |
| `CLAUDE_BIN` / `CODEX_BIN` / `AGY_BIN` / `GROK_BIN` | autodetected | backend binaries |
| `CODEX_HOME` | `~/.codex` | where `setup` links Codex's skill |

## Upgrading from 2.x

- `fleet` and `tail` are gone. Background several consults instead, or use your
  harness's own fan-out.
- `--label` folded into `--thread`, `--raw` is gone, and `--resume` takes job
  ids only.
- `meta.json` keeps only what gaslamp reads back. Provenance, usage and cost are
  gone from records and output; the raw event stream still has what each
  harness reported.
- Claude and Gemini gained `workspace-write`, and Claude's `read-only` is now
  OS-enforced. Gemini's fenced modes need macOS.
- `setup` always installs the skill (as a link), and `--local`, `--skill`,
  `GASLAMP_ALLOWED_TOOLS` and `GASLAMP_GEMINI_SEATBELT` are gone.

## Development

```sh
npm test                # node --test against stub claude, codex, agy and grok binaries
npm run check           # node -c syntax check on every source file
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
