# Security policy

## Threat model

Gaslamp lets two agents call each other with **your own configured permissions,
unattended**: with no `--sandbox`, a consulted agent uses your `~/.claude` /
`~/.codex` config. If that allows writes, the consulted agent can write too,
without approval. Risks:

1. **Prompt injection / runaway loops.** Either direction *can* call back, so an
   injected prompt could try to drive an unbounded consult loop. By default this
   is bounded: a consult is **one hop** — a gaslamp-spawned agent is blocked from
   consulting back (the recursion guard; see AGENTS.md / README). Setting
   `GASLAMP_ALLOW_RECURSION=1` removes the bound and restores unbounded mutual
   handoff, so enable it only if you trust the loop to terminate.
2. **Credential handling.** `ANTHROPIC_API_KEY` is stripped from the child env so
   the consulted Claude authenticates via keychain OAuth, never an env key. No
   credentials are logged.

## What this tool does NOT do

* **No sandboxing of its own.** By design — gaslamp shells out to `claude -p` /
  `codex exec` with your full config, so the consulted agent inherits the parent
  env. If you need isolation, run the whole thing in a container (or use
  `--sandbox read-only` for an advisory, no-edit consult).
* **No network listener.** It's a plain CLI that spawns a backend subprocess and
  blocks on the reply. It opens no socket and runs no daemon.
* **No built-in timeout.** A consult runs until the backend returns, or until the
  calling harness kills the wrapper — at which point gaslamp kills the whole
  child process group (no orphans burning quota) and the session stays resumable.
  There is no wall-clock deadline inside gaslamp; bound it from the harness.
* **No multi-tenant or auth layer.** Single user, single machine.

## Reporting a vulnerability

Email `mx@a9l.im` with details, or use GitHub's private vulnerability reporting
on this repo. I'll acknowledge within a few days and publish a fix + advisory.

For non-urgent issues, feel free to open a public issue.
