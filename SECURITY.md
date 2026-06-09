# Security policy

## Threat model

Gaslamp lets two agents call each other with **your own configured permissions, 
unattended**: by default the subagents use your `~/.claude` and `~/.codex` 
configs. If either allows writes, the dispatched subagents will be able to as 
well, without approval. Risks:

1. **Prompt injection / runaway loops.** Either direction *can* call back, so an
   injected prompt could try to drive an unbounded consult loop. By default this is
   bounded: a consult is **one hop** — a gaslamp-spawned agent is blocked from
   consulting back (the recursion guard; see AGENTS.md / README). Setting
   `GASLAMP_ALLOW_RECURSION=1` removes the bound and restores unbounded mutual
   handoff, so enable it only if you trust the loop to terminate.
2. **Credential handling.** `ANTHROPIC_API_KEY` is stripped from the child env so
   the consulted Claude authenticates via keychain OAuth, never an env key. No 
   credentials are logged.

## What this tool does NOT do

* **No sandboxing.** By design — gaslamp mirrors `codex
  mcp-server`, so the agent inherits the parent env and your full config. If you 
  need isolation, run the whole thing in a container.
* **No network listener.** It's a local stdio subprocess spawned by the host
  CLI. 
* **No timeout / kill switch.** A runaway consultation runs until the child
  process exits.
* **No multi-tenant or auth layer.** Single user, single machine. 

## Reporting a vulnerability

Email `mx@a9l.im` with details, or use GitHub's private vulnerability reporting
on this repo. I'll acknowledge within a few days and publish a fix + advisory.

For non-urgent issues, feel free to open a public issue.
