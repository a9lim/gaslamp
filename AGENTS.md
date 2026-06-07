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
stdio MCP server that wraps `claude -p`.

`src/server.mjs` flow on a `gaslamp` / `gaslamp-reply` call:

1. Spawn `claude -p <prompt> --output-format json` (`--resume <id>` on reply).
2. Map the per-call `sandbox` (same enum as Codex) to a permission flag:
   `read-only` → `--allowedTools <read-only set>`; `workspace-write` /
   `danger-full-access` → `--dangerously-skip-permissions`. The default comes from
   `GASLAMP_SANDBOX`, mirroring Codex reading `sandbox_mode` from config.toml.
3. Strip `ANTHROPIC_API_KEY` from the child env so Claude uses keychain OAuth
   rather than a (possibly stale) env key. This is the *one* Claude-only step
   with no Codex analog (Codex never reads that var), so it isn't an asymmetry —
   it's what makes Claude's auth reliable. Verified: with the key left in, a stale
   value 401s every call (`Invalid API key`).
4. Parse the result JSON, return
   `{ content, structuredContent: { sessionId, content } }`.

Otherwise the consulted Claude is deliberately un-isolated — it inherits the
parent env and loads the user's full config/MCP (the whole toolbelt, and it *can*
now consult Codex back), with no bespoke timeout — exactly as a consulted Codex
is. That symmetry is the design goal; any loop only closes if the agents choose to
keep handing off.

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
- **Why not tmux.** The original idea was to drive both TUIs via
  `send-keys`/`capture-pane`. That would mean screen-scraping two redrawing,
  alt-screen TUIs and heuristically detecting turn completion — brittle, and it
  wouldn't have fixed the hang (which isn't a TTY problem). MCP gives structured
  framing, real completion signals, and session state for free. tmux's only real
  value was observability, which `~/.codex/gaslamp.log` provides instead.
- **OAuth vs API key.** A nested `claude -p` inherits the parent env; an
  `ANTHROPIC_API_KEY` there overrides keychain OAuth. If it's stale you get a
  401. The shim deletes it from the child env so OAuth is the source of truth.

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
| `GASLAMP_SANDBOX` | `workspace-write` | default sandbox when a call omits `sandbox` (`read-only` = advisory reviewer) |
| `GASLAMP_ALLOWED_TOOLS` | read-only set | tools available under the `read-only` sandbox |
| `GASLAMP_LOGFILE` | `~/.codex/gaslamp.log` | transcript path; `off` to disable |
| `GASLAMP_DEBUG` | unset | verbose stderr (raw JSON-RPC) |
| `CLAUDE_BIN` | autodetected | path to the `claude` binary |
