---
name: gaslamp
description: Consult another coding agent (Claude, Codex, Gemini or Grok) from the shell for a second read or a handoff, such as a review, a check, a search or a piece of work. Use it when another agent's view would help, or when asked to consult Claude / Codex / Gemini / Grok.
---

# gaslamp

    gaslamp <claude|codex|gemini|grok> [options] "<prompt>"
    git diff | gaslamp codex "review this:"   # piped stdin rides along as <stdin> evidence
    gaslamp claude - < notes.md               # the whole prompt from a file

A consult blocks until the reply arrives, so run it in the background and keep working. Several can run at once. You get the consultee's final message, then a `[gaslamp]` line with the job id and the command that continues the conversation. The consultee can't consult back.

## Models

`--model` takes a tier word, which resolves to its family's newest version, or an exact id. Strength as of November 2026, band 1 strongest:

| band | claude | codex | gemini | grok |
|------|--------|-------|--------|------|
| 1 | fable | astra | neon | |
| 2 | opus | sol | carbon | |
| 3 | sonnet | terra | hydrogen | |
| 4 | haiku | luna | | grok |

Without `--model`, gemini runs neon and the others run their harness's default. Grok takes an id from `grok models`.

`--effort low|medium|high|xhigh|max`. Codex's astra, sol and terra also take `ultra`, and they default to `low`.

## Conversations

`--thread <name>`: the first consult with a name starts a conversation and later ones continue it. A new name starts fresh. A thread lives in the directory it started in, so continue it from elsewhere with `--cwd`. A consult without `--thread` can still be continued with `--resume <job-id>`.

## Sandbox

`--sandbox read-only | workspace-write | danger-full-access`. Read-only writes nothing outside the harness's own state and temp dirs, and workspace-write writes only in the cwd. The OS enforces both, and if its sandbox can't start, gaslamp refuses the consult. Gemini's sandbox is macOS-only. Without `--sandbox`, claude and codex use their own config, and gemini and grok run read-only. A fenced consultee can still search: Google for Gemini, web and X for Grok.

## The rest

- `--json` prints `{backend, jobId, status, thread, content, error?, data?}`. `--schema <file|json>` puts the parsed reply in `.data`.
- `gaslamp jobs`, `gaslamp poll <job|--last>` and `gaslamp threads` read the records in `~/.gaslamp/`. A killed consult keeps its conversation.
- Exit codes: 0 ok · 1 failed or killed · 2 usage · 3 nested · 4 can't run here · 5 conversation busy.
