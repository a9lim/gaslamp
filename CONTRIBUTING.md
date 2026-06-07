# Contributing

Thank you for the interest. 

## Zero dependencies

Don't add runtime deps. Dev tooling beyond what ships with node (the built-in test 
runner) needs a strong reason.

## Before you change `src/server.mjs`

It's a deliberate **mirror of `codex mcp-server`** so the two consultation
directions stay symmetric. 

Read the header comment and point your agent at the AGENTS.md before touching 
either. Changing the interface shape away from the Codex mirror needs justifying 
on review.

## Test plan

```sh
npm test          # node --test against a stub claude binary (no real Claude)
npm run check     # node -c syntax check on every source file
```

`npm test` spins up the actual server over stdio and exercises the full handshake. 
If you change tool names, the input/output schema, or the result shape, update 
`tests/smoke.test.mjs` in the same PR.

## Releasing

Version lives in `package.json` and is the single source of truth. Bump it on a 
change you want published.

## License

By contributing you agree your contributions are licensed under AGPL-3.0-or-later, 
same as the rest of the project.
