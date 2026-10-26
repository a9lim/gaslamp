# AGENTS.md

## What this is

`gaslamp` lets coding agents consult each other from the shell: Claude Code,
Codex, Gemini (through Google's Antigravity CLI) and Grok (through xAI's Grok
Build). An agent runs `gaslamp <target> "<prompt>"` as a background shell task;
gaslamp spawns the target's headless mode, blocks, and prints the reply plus a
one-line trailer. Consults run in parallel because each harness backgrounds
them and reports completion.

The founding finding (2.0, which replaced 1.0's MCP servers) is that
**asynchrony is the harness's job**. MCP tool calls are blocking and serial,
and Codex's MCP client guillotined long calls and hid a per-directory trust
gate that looked exactly like a hang. A plain blocking CLI the harness
backgrounds has none of that: no daemon, no job spool, no second async layer.

3.0 made it parsimonious. Records keep only what gaslamp reads back, the four
targets share one sandbox vocabulary with OS-enforced fences, a thread is the
one name a consult carries, and one symmetric skill teaches all of it.

## Architecture

One binary, four targets. The agent shells out; gaslamp spawns, blocks,
prints.

| target | what runs |
|--------|-----------|
| claude | `claude -p --output-format stream-json --verbose --append-system-prompt <preamble> [sandbox flags] [--resume <sid>] …` (prompt on stdin) |
| codex  | `codex exec [resume <sid>] --json -o <job>/reply.md --skip-git-repo-check -c shell_environment_policy.set.GASLAMP_NESTED="1" [-c sandbox_mode=…] … -` |
| gemini | `[sandbox-exec -p <profile>] agy --input-format stream-json --output-format stream-json --model <gemini> --dangerously-skip-permissions [--conversation <id>] …` (one `{"event":"user"}` line on stdin) |
| grok   | `grok --prompt-file /dev/stdin --output-format streaming-messages-json --no-auto-update --rules <preamble> --sandbox … [--resume <id>] …` |

Flow of one consult (`src/consult.mjs`):

1. **Preflights.** Refuse if nested (`GASLAMP_NESTED`, exit 3), if the
   surrounding sandbox has no network (`CODEX_SANDBOX_NETWORK_DISABLED=1`,
   exit 4), or if a fenced gemini consult has no Seatbelt (exit 4), all before
   anything is recorded or spawned.
2. **The conversation.** `--thread <name>` reads a pointer file;
   `--resume <job-id>` reads that job's record. Either supplies the session id
   and the directory the conversation lives in.
3. **Lock.** One consult per conversation: an atomic-create lockfile keyed on
   the thread name (or, for a bare `--resume`, the session id). A second
   consult gets exit 5. Locking the *name* also closes the race of two fresh
   consults binding it. Dead-holder locks are reaped.
4. **Job record.** `~/.gaslamp/jobs/<id>/` gets `meta.json`, `prompt.md`,
   `events.jsonl`, `stderr.log`, `reply.md` (and `schema.json`/`data.json` for
   `--schema`) as the consult runs. Passive durability, not a daemon.
5. **Spawn.** Its own process group (`detached: true`), prompt on stdin,
   `GASLAMP_NESTED=1` in its env.
6. **Stream.** stdout writes through to `events.jsonl`. The session id is
   captured the moment the backend reports it (claude and grok: `system:init`;
   codex: `thread.started`; agy: `init`) and lands in `meta.json` and the
   thread pointer immediately.
7. **Signals.** SIGINT/SIGTERM/SIGHUP kill the whole child group, escalate to
   SIGKILL after 2s, mark the record `killed`, release the lock.
8. **Reply.** One terminal state, published once: reply and data are written
   and checked (empty reply, unparseable schema reply, backend error) before
   `meta.json` leaves `running`. Then the reply and trailer, or the `--json`
   envelope, which `poll --json` rebuilds identically from disk.

### Killed consults: continue, not orphans

Kill-group wins over "let the child finish": a deliberately orphaned backend
invisibly double-burns quota. The recovery story is the conversation, not the
process. Because the session id is recorded within seconds of spawn, a killed
40-minute consult costs the in-flight turn, not the session: continue it by
thread or job id and ask for the conclusion.

This is also why claude runs `--output-format stream-json` rather than plain
`json`: plain json buffers everything until exit, so a killed wrapper would
leave no session id.

### Records keep only what gaslamp reads back

`meta.json` is `id, backend, status, error, sessionId, thread, cwd, pid,
startedAt, endedAt`, all of it read by `jobs`, `poll`, the trailer,
continuation or liveness. The model a harness reported, its tool calls and its
usage are in `events.jsonl`, raw. 2.x computed provenance and token usage per
backend; nothing read them, the usage figures misled under subscription plans,
and each one was a per-vendor parser to keep correct.

### Sandboxes

`--sandbox read-only | workspace-write | danger-full-access` on all four.
Omitted: claude and codex use the consultee's own config (as a harness's own
subagents do); gemini and grok run read-only (the narrower trust they joined
with). Every fenced mode is OS-enforced and fails closed. "read-only" means no
writes outside the harness's own state and temp dirs, not no network.

- **claude** uses Claude Code's own sandbox (Seatbelt on macOS, bubblewrap +
  socat on Linux), switched on per run with `--settings
  '{"sandbox":{…}}'`, which overrides the user's keys:
  - `failIfUnavailable: true`, because by default a sandbox that can't start
    silently runs commands unfenced.
  - `allowUnsandboxedCommands: false`, because otherwise Claude may retry a
    blocked command unsandboxed.
  - `autoAllowBashIfSandboxed: true`, so Bash runs without approval inside the
    fence.
  - The sandbox wraps Bash only. The file tools run outside it, so read-only
    also passes `--disallowedTools Edit,Write,NotebookEdit` with
    `--permission-mode manual`. Workspace-write uses `acceptEdits`, which edits
    inside the working directory and denies (doesn't hang on) a write outside
    it in `-p`.
  - A fenced consult loads no user, project or local settings
    (`--setting-sources ""`): only managed settings and gaslamp's `--settings`.
    The user's own settings can puncture the fence and `--settings` can't take
    it back. Sandbox lists merge across scopes, so `excludedCommands` run
    unfenced and `allowWrite` adds directories, and
    `sandbox.filesystem.disabled` is honored from user settings only. Probed:
    either one let a read-only consult write; with the sources excluded,
    neither did (Codex's review caught it, 2026-10-25). The cost is that a
    fenced consultee runs without the user's hooks, env and permission rules.
    Managed settings still load and outrank `--settings`, so an organization's
    sandbox exceptions apply inside the fence. That is the admin's policy, and
    part of it may arrive from a server, so gaslamp neither reads nor refuses
    it; the README says so.
  - Read-only denies writes to home and the cwd on top of the default write
    set (deny wins). `denyWrite: ["/"]` is not an option: it also denies
    Claude Code's per-command cwd bookkeeping in temp, and every Bash call then
    reports exit 1.
  - Probed on 2.1.310: read-only ran `git status` and `cat`, and `touch` in the
    cwd and home failed EPERM. Workspace-write wrote in the cwd via Bash and
    Write, its Write outside the cwd was denied, and Bash had no network. On
    Linux without socat it refuses to start, as intended.
  - Claude Code itself, outside the fence, creates an empty
    `.claude/.cc-writes/` in the cwd for its sandbox bookkeeping, read-only
    included. It's harness state, and git ignores an empty directory.
  - `--permission-mode default` was renamed `manual` in 2.1.200; `default`
    still parses.
- **codex** maps straight to `sandbox_mode`, passed as `-c` because
  `codex exec resume` has no `-s`.
- **gemini** runs agy under Seatbelt (`sandbox-exec -p <profile>`):
  - The profile allows writes to agy's state dir
    (`~/.gemini/antigravity-cli`) and temp dirs, plus the cwd under
    workspace-write. Inside the state dir, settings.json, keybindings.json,
    rules/, plugins/, skills/ and updater/ are denied again (the later SBPL
    rule wins). bin/ must stay writable: agy extracts bin/agentapi before every
    shell command.
  - agy's own permission layer is always skipped (`--dangerously-skip-permissions`):
    the kernel is the fence. Under its default request-review preset, print
    mode soft-denies `write_file` and `run_command` and ends the turn with an
    empty reply, and users keep lax interactive settings (always-proceed, auto
    mode) that no flag overrides per run. With the layer skipped, every mode
    behaves the same whatever those settings say.
  - Probed with agy under Seatbelt: workspace-write wrote in the cwd and failed
    EPERM in home; read-only failed EPERM everywhere, and the turn went on.
  - sandbox-exec execs in place, so pid, group and process name are agy's.
    Seatbelt doesn't exist on Linux and doesn't nest inside Codex's sandbox
    (`CODEX_SANDBOX` set), so there a fenced gemini consult is refused before
    agy runs. Never fall back to running it unfenced.
- **grok**'s `--sandbox` is kernel-enforced (Seatbelt / Landlock) and also
  wraps the MCP servers grok spawns. Its permission layer is skipped
  (`--always-approve`), as agy's is, because it is no guarantee either way:
  on 1.0.62 headless `--permission-mode default` denied the `write` tool but
  let `run_terminal_command touch …` through, and on 1.0.70 `acceptEdits`
  denied `write`, `search_replace` and `run_terminal_command` alike as "not
  pre-approved", so 2.x's workspace-write could write nothing (found when
  Grok tried to edit its own AGENTS.md). Probed on 1.0.70 with the layer
  skipped: read-only ran `git status` and every write failed EPERM;
  workspace-write wrote in the cwd only. `--always-approve` also beats the
  `defaultMode` grok reads from `~/.claude/settings.json`.

### Threads

A thread is one pointer file, `~/.gaslamp/threads/<backend>--<name>.json`:
session id, cwd, last job. It is bound when a fresh consult reports its
session and re-pointed on every consult after. That matters on claude, where
every resume forks a NEW session id. The pointer chases it, which is why the
bind happens in the stream handler and why trailers print `--thread <name>`
rather than an id.

A thread lives in the directory it started in. Reusing a name from another
cwd is a usage error (exit 2) naming the original. That is the safeguard that
made folding `--label` into `--thread` safe: almost every consult carried a
distinct label, and as a continuation handle a common name would otherwise
pull one repository's conversation into another. It also matches Claude Code
keeping sessions per project directory. The same rule applies to
`--resume <job-id>`, and the trailer adds `--cwd` to the continue command
whenever the conversation lives somewhere other than the caller's directory.

A job inside a thread continues only through the thread: `--resume` of it
is a usage error. Resuming it would fork the conversation past the pointer
(claude) or run a second consult on the same session under a different lock
(the others).

2.x records predate all this. A 2.x thread pointer has no `cwd`; its last
job's record does, and that is used. 2.x jobs stored `--cwd` as typed, so
stored paths are canonicalized before comparing, and one that can't be (a
relative `.`) is adopted only when the caller names it with `--cwd`. 2.x
`--schema` jobs have no `data.json`; `poll` parses their reply, which was the
JSON.

## Things that are not obvious

- **`shell_environment_policy.inherit = "core"` strips the sentinel.** A
  consulted Codex with that config doesn't pass inherited env like
  `GASLAMP_NESTED` to its shell commands, so the one-hop guard would silently
  die. The spawn forces it with `-c shell_environment_policy.set.GASLAMP_NESTED="1"`;
  the dotted leaf MERGES with the user's `[shell_environment_policy.set]`.
  It survives Codex's own delegation (`--effort ultra` subagents inherit the
  thread config).
- **The guard is loop prevention, not a security boundary.** A shell-capable
  consultee could unset it; `GASLAMP_ALLOW_RECURSION=1` is the documented
  opt-out.
- **The sentinel is an env footgun for tests.** Inside a consult,
  `GASLAMP_NESTED=1` is ambient, and this repo's own suite would then fail
  with nested refusals. The tests scrub `GASLAMP_*`, `CODEX_SANDBOX*`,
  `ANTHROPIC_API_KEY` and the caller's Claude session from every spawn env.
- **Codex looks for `codex-code-mode-host` beside the path it was invoked
  as, symlinks unresolved.** The standalone install's `~/.local/bin/codex` is
  a bare symlink, so a codex spawned through it can neither read nor write
  ("failed to spawn code-mode host"). `resolveBin` realpaths codex.
- **Never realpath grok.** `~/.local/bin/grok` links to a versioned download,
  and the end-conversation server finds its harness by process name, which
  would become `grok-macos-aarch64`.
- **Session id channels differ per backend, and codex's reply comes from
  `-o`** (authoritative, schema-stable), with a tolerant `agent_message`
  fallback. claude and grok carry the reply in the `result` event, agy in
  `result.response`; under `--schema` either may carry only
  `structured_output`, which counts as a reply.
- **OpenAI's structured output only accepts STRICT schemas**:
  `additionalProperties:false` and a `required` listing every key, on every
  object node (400 `invalid_json_schema` otherwise). `strictify()` normalizes
  schemas on the way to codex; the job's `schema.json` records what was sent.
  claude's `result` can be prose while `structured_output` holds the object,
  so the parsed object is persisted as `data.json` rather than re-parsed from
  the reply.
- **The preamble rides each harness's own channel**: claude
  `--append-system-prompt`, grok `--rules`, codex and agy prepended as a
  `<gaslamp_consult>` block. `prompt.md` records the caller's content only.
- **agy specifics.**
  - `-p` takes the prompt as its value, so the prompt rides
    `--input-format stream-json` instead: one line, one turn, EOF ends the
    session.
  - Without a cached sign-in, print mode prints a Google OAuth URL and waits
    forever. gaslamp watches what agy prints before its init event (stderr and
    non-JSON stdout, across chunks, never reply content) for
    `Authentication required` and kills the group.
  - agy serves Claude and GPT-OSS models under the same account, and its slugs
    carry the effort (`gemini-4-argon-high`), so a gemini consult always passes
    a Gemini base slug (default tier argon) and `--effort` picks the level.
- **grok specifics.**
  - `streaming-messages-json` is Anthropic's stream-json shape, so the claude
    parser reads it.
  - grok imports other harnesses' config by default (`~/.claude/CLAUDE.md` as
    instructions, Claude's skills, MCP servers and hooks, Cursor's likewise), so
    consults set `GROK_{CLAUDE,CURSOR}_*_ENABLED=0`. It reads
    `~/.claude/settings.json` permissions with no switch; the explicit
    `--permission-mode` overrides that file's `defaultMode`.
- **Foreign env is dropped for gemini and grok.** Harnesses pass their
  parent's env to their shells and MCP servers. A consult inherited the
  caller's `CLAUDE_CODE_SESSION_ID`, messaging token and account details, and an
  end-conversation server under a gemini consult once resolved its harness to
  the *calling* Claude session. `ANTHROPIC_API_KEY` is stripped for claude
  consults so keychain OAuth is authoritative (a stale key 401s every call).
- **Every kill path reaps the group at close.** SIGTERM to the group can kill
  the leader while a descendant that ignores it closes its inherited pipes;
  `close` then fires before the unref'd SIGKILL timer. Signal and refusal paths
  SIGKILL the group on close.
- **stdin may arrive non-blocking, or never close.** `readFileSync(0)` throws
  EAGAIN on an O_NONBLOCK stdin, so `src/stdin.mjs` loops with short naps until
  EOF. An agent harness that backgrounds a command can hand it a socket nobody
  writes or closes, so on a socket the evidence read gives up if no byte
  arrives within 300 ms. Pipes and files stay cat-like.
- **Off-ramp records ride a spool.** The end-conversation server's log,
  `~/.claude/conversation-ends.jsonl`, is unwritable under every fence. Each
  consult sets `END_CONVERSATION_SPOOL` to a temp file every fence allows, and
  gaslamp files the records into the log at close. Only records whose `log`
  field equals that path are filed: the consultee can write the spool, so the
  spool must not choose where gaslamp appends.
- **Tier words resolve against each harness's own catalog** (codex:
  `$CODEX_HOME/models_cache.json`; agy: `agy models`, about 2 s) to the newest
  `<family>-<version>-<tier>`. An unknown word passes through for the harness
  to reject. Resolution runs before the lock and the record: no signal handler
  exists yet, so a kill there must strand nothing.
- **Exit without truncation.** Failure messages go through `writeSync(2, …)`,
  and the close path sets `process.exitCode` instead of calling `process.exit()`:
  stdout to a pipe is async in Node, and a hard exit can truncate exactly the
  message that explains the failure.
- **Why block-until-reply and not detach-and-poll.** Both harnesses background a
  long shell command and report completion (verified on each side). If some
  surface can't, the job record is the escape hatch: `jobs` and `poll` work
  over a consult driven by `nohup … &`.

## Working on it

Zero dependencies; system `node` runs everything. No build step. The entry is
`bin/gaslamp.mjs`; the consult engine is `src/consult.mjs`.

```sh
npm link && gaslamp setup  # from source
npm run check              # node -c syntax check on every source file
npm test                   # node --test against stub claude, codex, agy and grok
```

`node bin/gaslamp.mjs claude --model haiku "ping"` is a cheap live round trip.
`gaslamp jobs`, `gaslamp poll --last` and `tail -f ~/.gaslamp/jobs/<id>/events.jsonl`
read the records.

Releasing: bump `version` in `package.json` and merge to `main`. The release
workflow tests, publishes to npm (trusted publishing), tags, and cuts the GitHub
release.

## Files

- `bin/gaslamp.mjs`: CLI entry, help, dispatch
- `src/consult.mjs`: the heart. Preflights, conversations and locks, sandboxes,
  spawn, stream, signals, schema plumbing (`strictify`), tier resolution,
  the off-ramp spool
- `src/backends.mjs`: job-id prefixes and the omitted-`--sandbox` default per
  target
- `src/jobs.mjs`: job records, the trailer, the `--json` envelope, `jobs` and `poll`
- `src/threads.mjs`: thread pointers and `threads`
- `src/stdin.mjs`: read stdin to EOF, even non-blocking; give up on an idle socket
- `src/setup.mjs`: link the skill into both harnesses; allowlist the command
- `src/which.mjs`: PATH lookup without spawning a shell
- `skill/SKILL.md`: the one skill both harnesses read
- `tests/cli.test.mjs`: every target end-to-end against stub binaries
- `tests/setup.test.mjs`: allowlist merge and skill links in a temp HOME

## Env knobs and exit codes

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_HOME` | `~/.gaslamp` | state dir (jobs, locks, threads) |
| `GASLAMP_ALLOW_RECURSION` | unset | let consulted agents consult back (off = one hop) |
| `GASLAMP_NESTED` | set on children | the one-hop sentinel; not user-set |
| `GASLAMP_DEBUG` | unset | print the spawn argv |
| `CLAUDE_BIN` / `CODEX_BIN` / `AGY_BIN` / `GROK_BIN` | autodetected | backend binaries |
| `CODEX_HOME` | `~/.codex` | where `setup` links Codex's skill |

Exit codes: `0` reply delivered · `1` consult failed or killed (including an
empty or unparseable schema reply) · `2` usage · `3` nested · `4` can't run
here (no network, or no OS sandbox for the mode) · `5` conversation busy ·
`poll`: `10` still running.
