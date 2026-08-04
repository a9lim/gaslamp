# Contributing

Thank you for the interest.

## Zero dependencies

Don't add runtime deps. Dev tooling beyond what ships with node (the built-in
test runner) needs a strong reason.

## Before you change the consult engine

`src/consult.mjs` is the heart, and both spawn directions (Claude → Codex,
Codex → Claude) are deliberately kept symmetric. Read the header comments and
`AGENTS.md` ("Things that are not obvious") before touching it — several flags
encode hard-won, non-obvious backend behavior. Changing the backend argv
contract, the session-id capture, or the kill/resume semantics needs justifying
on review.

## Test plan

```sh
npm test          # node --test against stub claude AND codex binaries
npm run check     # node -c syntax check on every source file
```

`npm test` drives both consult directions and the fleet end-to-end against stub
backends — no real agent in the loop. If you change a backend argv contract, the
`--json` envelope shape, or the job-record fields, update the tests in the same
PR.

## Releasing

Version lives in `package.json` and is the single source of truth. Bump it on a
change you want published.

## License

By contributing you agree your contributions are licensed under
AGPL-3.0-or-later, same as the rest of the project.
