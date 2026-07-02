## What

<!-- One or two sentences on what changed -->

## Why

<!-- What problem does this solve? Link issues with "Fixes #N" if applicable -->

## Test plan

- [ ] `npm test` passes
- [ ] `npm run check` passes
- [ ] No new runtime dependencies or a strong reason is given below
- [ ] If this touches `src/consult.mjs`: I kept the two consult directions symmetric (OAuth key-strip, sandbox mapping, session-id capture) intact
- [ ] If this changes a backend argv contract, the `--json` envelope, or job-record fields: I updated the tests in the same PR
- [ ] If this is a release (version bump in `package.json`): I confirm the release workflow will publish on merge

## Notes

<!-- Anything reviewers should know: security implications (this tool grants write access — see SECURITY.md), followups, known limitations. -->
