# Contributing

Thanks for the interest. A few ground rules for gaslamp specifically.

## Zero dependencies is a hard rule

gaslamp ships with an empty `dependencies`. It runs on system `node`, no build
step, no `node_modules`. That's a feature — it's a thing two CLIs spawn, and
every dependency is supply-chain surface in that position. Don't add runtime
deps. Dev tooling beyond what ships with node (the built-in test runner) needs a
strong reason.

## Before you change `src/server.mjs`

It's a deliberate **mirror of `codex mcp-server`** so the two consultation
directions stay symmetric. Two things are load-bearing, not incidental:

* The **OAuth key-strip** (deleting `ANTHROPIC_API_KEY` from the child env).
  Without it a stale env key 401s every call.
* The **sandbox mapping** (`read-only` → tool allowlist; `workspace-write` /
  `danger-full-access` → `--dangerously-skip-permissions`).

Read the header comment and AGENTS.md before touching either. Changing the
interface shape away from the Codex mirror needs justifying on review.

## Test plan

```sh
npm test          # node --test against a stub claude binary (no real Claude)
npm run check     # node -c syntax check on every source file
```

`npm test` spins up the actual server over stdio and exercises the full JSON-RPC
handshake. If you change tool names, the input/output schema, or the result
shape, update `tests/smoke.test.mjs` in the same PR.

## Style

* Match the existing style: 2-space indent, ESM, `node:`-prefixed builtins.
* Keep the server's stdout clean — on the `serve` path it's a JSON-RPC channel.
  Diagnostics go to stderr (gated behind `GASLAMP_DEBUG`) or the transcript log.
* Comments should explain *why*, especially anything that looks like it could be
  simplified but can't (the asymmetries above are the usual culprits).

## Commits and PRs

* Small commits, descriptive messages, one logical change per commit.
* PR description: what changed, why, and what tests cover it.
* Note security implications explicitly if any (this tool hands an agent
  write access — see SECURITY.md).

## Releasing

Version lives in `package.json` and is the single source of truth (the server
reads it at runtime). Bump it on a change you want published; on merge to `main`
the release workflow tags `vX.Y.Z` and publishes to npm via OIDC trusted
publishing. The **first** publish is manual (`npm publish`) — trusted publishing
can't be configured until the package exists.

## License

By contributing you agree your contributions are licensed under
AGPL-3.0-or-later, same as the rest of the project.
