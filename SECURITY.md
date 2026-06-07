# Security policy

## Threat model

gaslamp lets two coding agents drive each other. By default a consultation
grants the **peer agent full read/write** in the working directory, with no
per-action approval: the Codex→Claude shim runs `claude
--dangerously-skip-permissions`, and the Claude→Codex side runs Codex at
whatever `sandbox_mode` your `~/.codex/config.toml` sets. The threat model is
dominated by:

1. **Delegated write access.** A consult hands the other agent the same
   filesystem reach you have, unattended. Mitigation: pass `sandbox:
   "read-only"` for advisory reviews (Claude side maps it to a read-only tool
   allowlist; no edits). Only run read/write consults in repos you'd let either
   agent edit on its own.
2. **Prompt injection, possibly cross-agent.** Content an agent reads (a hostile
   repo, a fetched web page) can instruct it to consult the *other* agent with an
   adversarial prompt — and because either direction can call back, a loop can
   form. Untrusted input therefore reaches a tool that can write files.
   Mitigations: the Codex-side **directory-trust gate** (MCP tool calls are only
   auto-approved in dirs marked `trust_level = "trusted"`; elsewhere Codex raises
   an approval prompt — see AGENTS.md), `read-only` sandbox for anything touching
   untrusted material, and running consults only in trusted directories you
   control.
3. **Credential handling.** `ANTHROPIC_API_KEY` is stripped from the child env so
   the consulted Claude authenticates via keychain OAuth, never a (possibly
   stale or leaked) env key. No credentials are logged.
4. **Transcript exposure.** Codex→Claude consults are appended to
   `~/.codex/gaslamp.log` (prompt + clipped response). That can contain snippets
   of your code. It's a local file; set `GASLAMP_LOGFILE=off` to disable, or
   point it elsewhere.

## What this tool does NOT do

* **No sandboxing of the consulted agent.** By design — gaslamp mirrors `codex
  mcp-server`, which is also un-isolated. The agent inherits the parent env and
  your full MCP/config. If you need isolation, run the whole thing in a
  container.
* **No network listener.** It's a local stdio subprocess spawned by the host
  CLI. There is no port, no socket, nothing remote to reach.
* **No timeout / kill switch.** A runaway consultation runs until the child
  process exits. Mirrors Codex's behavior; deliberate, not an oversight.
* **No multi-tenant or auth layer.** Single user, single machine. Whoever can
  run `codex`/`claude` can run a consult.

## Reporting a vulnerability

Email `mx@a9l.im` with details, or use GitHub's private vulnerability reporting
on this repo. I'll acknowledge within a few days and publish a fix + advisory.

For non-urgent issues, feel free to open a public issue.
