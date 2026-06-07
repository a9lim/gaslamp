# Security policy

## Threat model

Gaslamp lets two agents call each other with **your own configured permissions, 
unattended**: by default the subagents use your `~/.claude` and `~/.codex` 
configs. If either allows writes, the dispatched subagents will be able to as 
well, without approval. Risks:

1. **Prompt injection.** Because either direction can call back, a loop can
   form. 
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
