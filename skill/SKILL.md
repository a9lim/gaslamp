---
name: gaslamp
description: Consult another coding agent (Claude, Codex, Gemini or Grok) from the shell for an independent read or a handoff. Use it to verify a fix or proof, spar on a design, review a diff, search, diagnose with fresh context, or hand off a piece of work. Use it when a claim deserves checking before you rely on it, or when asked to consult Claude / Codex / Gemini / Grok, get a second opinion, or hand work off.
---

# gaslamp

    gaslamp <claude|codex|gemini|grok> [options] "<prompt>"
    git diff | gaslamp codex "review this for races:"   # piped stdin rides along as <stdin> evidence
    gaslamp claude - < notes.md                         # the whole prompt from a file

A consult blocks until the reply arrives, so run it in the background (`run_in_background` in Claude Code, a background terminal in Codex) and keep working. Several can run at once. You get the consultee's final message verbatim, then one `[gaslamp]` line with the job id and the command that continues the conversation. A consult is one hop: the consultee can't consult back, so the synthesis is yours.

Send raw evidence, such as errors, diffs and failing output, not just your reading of it.

## Choosing a consultee

| target | `--model` | omitted `--model` | omitted `--sandbox` |
|--------|-----------|-------------------|---------------------|
| claude | fable, opus, sonnet, haiku | its own default | its own config |
| codex  | astra, sol, luna | its own default | its own config |
| gemini | argon, flash | argon | read-only |
| grok   | an id from `grok models` | the account default | read-only |

Roughly, strongest first: fable\* > opus ≈ astra > sonnet ≈ argon ≈ sol > haiku ≈ flash ≈ grok ≈ luna. Match the tier to the stakes, as you would when picking a subagent's model.

\* The public fable is a generation behind the others (5.1, against 5.5 for opus, sonnet and haiku), so for now it sits between opus and sonnet.

`--effort low|medium|high|xhigh|max` sets reasoning effort. astra and sol also take `ultra`. sol defaults to `low`, so set it when the consult matters.

## Conversations

`--thread <name>` names a conversation. The first consult with a name starts it, and every later one continues it.

- Name it for its subject (`auth-race-review`, not `review`).
- For an independent second opinion, use a new name, because a reused name carries the earlier context along.
- A thread lives in the directory it started in. To continue it from anywhere else, pass `--cwd`.

Without `--thread` a consult is a one-off, though `--resume <job-id>` can still continue it.

## Sandbox

`--sandbox read-only | workspace-write | danger-full-access`

- **read-only:** the consultee writes nothing outside its harness's own state and temp dirs.
- **workspace-write:** it writes only in the cwd.

The OS sandbox enforces both, and if the sandbox can't start, gaslamp refuses the consult instead of running it unfenced. Gemini's sandbox is macOS-only, so elsewhere only `danger-full-access` runs it.

The sandbox fences the filesystem, not search. A read-only consultee can still look things up: Google for Gemini, web and X for Grok. For a search consult, send the question and ask for source URLs, since a summary of search results isn't verification. For a review, pipe in the material.

## The rest

- `--cwd <dir>` runs the consult in another directory.
- `--json` prints `{backend, jobId, status, thread, content, error?, data?}`.
- `--schema <file|json>` with `--json` puts the parsed reply in `.data`. A reply that doesn't parse fails the consult.
- `gaslamp jobs` lists recent consults, `gaslamp poll <job|--last>` prints one (exit 10 means it's still running), and `gaslamp threads` lists conversations.
- Each job lives in `~/.gaslamp/jobs/<id>/`, raw events included. A killed consult loses its current turn but keeps its conversation.

Exit codes: 0 ok · 1 failed or killed · 2 usage · 3 nested · 4 can't run here (no network, or no sandbox for the mode) · 5 conversation busy.
