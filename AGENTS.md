# AGENTS.md

## What this is

`gaslamp` lets Claude Code and Codex hand work to each other over MCP. Either
agent can pass the lamp to the other for a review, a second opinion, or a fix,
and both sides can read and write. It replaces the stock Codex-for-Claude
connector, which dispatches a Claude subagent to shell out to Codex through
Codex's experimental `app-server` broker — a path that hangs roughly half the
time and offers no reverse channel (Codex cannot call Claude at all).

The core finding behind the design: **Codex was never what hung.** Talking to
`codex mcp-server` directly round-trips in ~5s with zero hangs. The hang lived in
the broker plus the subagent middleman. So gaslamp deletes both layers and wires
the two CLIs to each other as plain MCP servers.

## Architecture

Two directions, two mechanisms. Both servers are registered under the name
`gaslamp`.

| direction | mechanism | what the agent calls |
|-----------|-----------|----------------------|
| **Claude → Codex** | Codex's native `codex mcp-server`, registered in Claude | `gaslamp/codex`, `gaslamp/codex-reply` |
| **Codex → Claude** | `src/server.mjs` (this repo), registered in Codex | `gaslamp`, `gaslamp-reply` |

Only the Codex→Claude side needs custom code, because `claude mcp serve` exposes
Claude's *tools* (Bash/Read/Edit) and a one-shot `Agent` spawn — not a persistent
"consult Claude" conversation. `src/server.mjs` is that missing piece: a zero-dep
stdio MCP server that wraps `claude -p`. It's a deliberate mirror of `codex
mcp-server` down to the surface: the `gaslamp` / `gaslamp-reply` pair mirrors
`codex` / `codex-reply` in tool shape, output schema (`{ sessionId, content }` ≈
`{ threadId, content }`), titles (`Claude` / `Claude Reply`), and tool
*descriptions* — Codex's are terse ("Run a Codex session. …"), so ours match that
register rather than out-selling them (any "when to consult" guidance belongs in
the agents' own config, not the tool blurb).

`src/server.mjs` flow on a `gaslamp` / `gaslamp-reply` call:

1. Spawn `claude -p <prompt> --output-format json` (`--resume <id>` on reply).
2. Map the per-call `sandbox` to permission flags — but the default is to pass
   none. An omitted `sandbox` lets the consulted `claude -p` read the user's own
   `~/.claude` config (permission defaultMode, allow/deny, model, MCP), the mirror
   of Codex deferring to `sandbox_mode` in config.toml. Overrides: `read-only` →
   `--permission-mode default --allowedTools <read set>` (forces advisory and beats
   the user's defaultMode, even `bypassPermissions`); `danger-full-access` →
   `--dangerously-skip-permissions`. Claude has no fs sandbox, so no `workspace-write`.
3. Strip `ANTHROPIC_API_KEY` from the child env so Claude uses keychain OAuth
   rather than a (possibly stale) env key. This is the *one* Claude-only step
   with no Codex analog (Codex never reads that var), so it isn't an asymmetry —
   it's what makes Claude's auth reliable. Verified: with the key left in, a stale
   value 401s every call (`Invalid API key`).
4. Parse the result JSON, return
   `{ content, structuredContent: { sessionId, content } }`.

Otherwise the consulted Claude is deliberately un-isolated — it inherits the
parent env and loads the user's full config/MCP (the whole toolbelt), with no
bespoke timeout — exactly as a consulted Codex is. The **one** deliberate
asymmetry-from-the-user is the recursion guard: a consult is one hop by default,
so the consulted Claude is denied the Claude→Codex bridge and a consulted Codex
is refused if it tries to hand work back (see "recursion guard" below).
`GASLAMP_ALLOW_RECURSION=1` removes the guard and restores the old fully-symmetric
behaviour, where any loop only closes if the agents choose to keep handing off.

The Claude→Codex side needs no wrapper: `codex mcp-server`'s `codex` tool returns
`structuredContent.threadId` for `codex-reply`, and it reads/writes according to
the user's `~/.codex/config.toml` `sandbox_mode`.

## Things that are not obvious

- **Directory trust gates Codex→Claude.** Codex requires approval for MCP tool
  calls via an `elicitation_request` — a gate *separate* from `approval_policy`
  (which only governs shell commands). Approval is auto-granted in directories
  marked `trust_level = "trusted"` in `~/.codex/config.toml`; elsewhere Codex
  raises a one-time prompt (`persist: ["session","always"]`). If a `gaslamp` call
  from Codex stalls forever with no `mcp_tool_call_end`, the cwd is untrusted and
  an approval elicitation is sitting unanswered. This was the single hardest bug
  to find — the shim looks hung but never received the `tools/call`.
- **The recursion guard is two halves, one per direction.** A consult is one hop
  by default, but the two directions are blocked by different mechanisms because
  only one side is our code. (1) *Nested Claude → Codex:* the `claude -p` in
  `server.mjs` is always itself a consult, so it's spawned with
  `--disallowedTools mcp__gaslamp` — a bare server name removes all of gaslamp's
  tools from Claude's context, and a deny rule holds **even under
  `--dangerously-skip-permissions`** (verified: deny > ask > allow, and deny
  beats bypassPermissions). (2) *Nested Codex → Claude:* `codex mcp-server` is
  native (not our code), so instead `gaslamp setup` registers it in Claude with
  `--env GASLAMP_NESTED=1`; that env flows down to the `gaslamp serve` Codex
  spawns, and `server.mjs` refuses any call when it sees the sentinel. The
  top-level agent the user drives is spawned by neither path, so it keeps full
  consult powers. `GASLAMP_ALLOW_RECURSION=1` disables both halves. Subtlety:
  blocking nested Claude needs the *Claude* side (deny the tool), and blocking
  nested Codex needs the *server* side (refuse the call) — an env sentinel alone
  can't stop a Claude from invoking an MCP tool, and a deny flag has no analog we
  can inject into native `codex mcp-server`.
- **Why not tmux.** The original idea was to drive both TUIs via
  `send-keys`/`capture-pane`. That would mean screen-scraping two redrawing,
  alt-screen TUIs and heuristically detecting turn completion — brittle, and it
  wouldn't have fixed the hang (which isn't a TTY problem). MCP gives structured
  framing, real completion signals, and session state for free. tmux's only real
  value was observability, which `~/.codex/gaslamp.log` provides instead.
- **OAuth vs API key.** A nested `claude -p` inherits the parent env; an
  `ANTHROPIC_API_KEY` there overrides keychain OAuth. If it's stale you get a
  401. The shim deletes it from the child env so OAuth is the source of truth.
- **The timeout is Codex's, not the server's.** `src/server.mjs` deliberately has
  no timeout — it waits for `claude -p` however long it takes. But Codex's MCP
  *client* enforces a per-call `tool_timeout_sec` (docs say default 60s; observed
  120s in codex-cli 0.137.0 / the desktop app) and kills any `tools/call` that
  overruns it with `timed out awaiting tools/call after 120s` — while the gaslamp
  child keeps running, orphaned (its result still lands in `gaslamp.log` when it
  finishes; Codex just never receives it). Substantial consults run 30-45 min, so
  this fires constantly. Two facts make the server powerless to fix it: `codex mcp
  add` can't persist the key (its `-c` flag is runtime-only, never written to the
  block), and Codex does **not** reset the deadline on `notifications/progress`
  (verified in `codex-rs/rmcp-client`: the timeout only pauses for a pending
  elicitation, never for progress) — so the server can't keep the call alive by
  emitting heartbeats either. The fix lives entirely in `config.toml`:
  `tool_timeout_sec` (+ `startup_timeout_sec` for the `npx -y` cold-start) under
  `[mcp_servers.gaslamp]`. `gaslamp setup` now patches both in directly after
  `codex mcp add` (see `patchCodexTimeouts` in `src/setup.mjs`); tune via
  `GASLAMP_TOOL_TIMEOUT_SEC` / `GASLAMP_STARTUP_TIMEOUT_SEC`. The default is
  `100000`s (≈27.8h), deliberately matching Claude Code's *own* default MCP tool
  timeout — its stdio resolver falls back to `1e8` ms when `MCP_TOOL_TIMEOUT` is
  unset (the docs' "about 28 hours"), and progress notifications don't extend it
  there either. So both directions now share the same effectively-unbounded
  ceiling; a genuinely wedged consult is the user's to cancel, not the client's to
  guillotine at 2 minutes. Caveat: a re-run of the *published* `gaslamp setup`
  only carries the patch once npm has a version with this `setup.mjs` — an older
  published `mcp remove`+`add` wipes the keys.

## Working on it

Zero dependencies; system `node` runs everything. No build step. The CLI entry
is `bin/gaslamp.mjs` (dispatches `serve` / `setup` / `doctor`); the server lives
in `src/server.mjs`.

Register / re-register both directions (idempotent; also clears legacy names):

```sh
./setup.sh                 # from-source: gaslamp setup --local
# or, on an installed copy:
gaslamp setup              # registers Codex to spawn `npx -y gaslamp serve`
gaslamp doctor             # verify binaries + registrations
```

Then restart Claude Code so it loads the server. The from-source registration is
version-pinned to this checkout (re-run after an nvm node upgrade); the published
`npx`-based registration is not, so it survives upgrades.

```sh
npm run check              # node -c syntax check on every source file
npm test                  # node --test against a stub claude binary
```

To exercise a server by hand, speak newline-delimited JSON-RPC over stdio:
`initialize` → `notifications/initialized` → `tools/list` → `tools/call`. The
Codex→Claude path can be tested without Claude in the loop by driving
`codex mcp-server` and asking it to call the `gaslamp` tool (do this in a trusted
cwd, or the approval elicitation will stall it). Watch progress with
`tail -f ~/.codex/gaslamp.log`.

## Files

- `bin/gaslamp.mjs` — CLI entry; dispatches `serve` / `setup` / `doctor`
- `src/server.mjs` — the MCP server (zero deps, stdio JSON-RPC)
- `src/setup.mjs` — registers both directions (`--local` for this checkout)
- `src/doctor.mjs` — non-invasive health check (binaries + registrations)
- `src/which.mjs` — PATH lookup without spawning a shell
- `tests/smoke.test.mjs` — drives the server over stdio against a stub `claude`
- `setup.sh` — thin from-source wrapper around `gaslamp setup --local`
- `package.json` — npm metadata; version is the single source of truth
- `README.md` — front-page usage

## Env knobs (Codex-side `gaslamp` registration)

| var | default | meaning |
|-----|---------|---------|
| `GASLAMP_ALLOWED_TOOLS` | `Read Grep Glob WebFetch WebSearch` | tools the `read-only` override permits |
| `GASLAMP_ALLOW_RECURSION` | unset | disable the recursion guard — let a consulted agent consult back (off = one hop). Also recognised by the spawned Claude (drops `--disallowedTools mcp__gaslamp`) |
| `GASLAMP_NESTED` | set by setup | sentinel the Claude→Codex registration puts on every consulted Codex; when present, `server.mjs` refuses (the Codex→Claude half of the guard). Not user-set |
| `GASLAMP_LOGFILE` | `~/.codex/gaslamp.log` | transcript path; `off` to disable |
| `GASLAMP_DEBUG` | unset | verbose stderr (raw JSON-RPC) |
| `CLAUDE_BIN` | autodetected | path to the `claude` binary |
| `GASLAMP_TOOL_TIMEOUT_SEC` | `100000` | *(setup-time)* `tool_timeout_sec` written to `[mcp_servers.gaslamp]`; how long Codex waits on one consult before killing it. Default ≈27.8h, chosen to match Claude Code's own default MCP tool timeout (`1e8` ms) so both directions behave the same |
| `GASLAMP_STARTUP_TIMEOUT_SEC` | `30` | *(setup-time)* `startup_timeout_sec` written to the same block; headroom for the `npx -y` cold-start |
