// setup.mjs — allowlist the gaslamp CLI for Claude Code; optionally install
// the gaslamp skill for both agents.
//
// gaslamp has no MCP servers and nothing to register. Base setup does one
// thing: allowlist the command in ~/.claude/settings.json so a consult doesn't
// stall on a permission prompt mid-call. (Codex needs no analog — shell
// commands are governed by approval_policy.)
//
// It does NOT touch your agent instructions. A CLI can't self-advertise the way
// MCP tools did, so each agent needs a one-line note in its instructions to know
// gaslamp exists — but appending to your personal CLAUDE.md / AGENTS.md is yours
// to do (the README has the text to paste), not a surprise setup springs.
//
// --skill is the opt-in richer alternative: both CLIs speak the same SKILL.md
// standard (~/.claude/skills/, $CODEX_HOME/skills/), so one flag installs a
// direction-aware skill on each side — Claude's copy teaches consulting Codex,
// Codex's copy teaches consulting Claude. It only ever writes gaslamp's OWN
// skill directory, so reruns are idempotent overwrites of our own file.
//
//   gaslamp setup            published install (`gaslamp` on PATH)
//   gaslamp setup --local    THIS checkout (absolute bin path; from-source dev)
//   gaslamp setup --skill    also install the gaslamp skill for both agents

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "./which.mjs";

// Add an entry to permissions.allow in a settings.json text. Returns the new
// text, or null if the existing text isn't valid JSON (never clobber).
export function addAllow(text, entry) {
  let obj = {};
  if (text && text.trim()) {
    try { obj = JSON.parse(text); } catch { return null; }
  }
  obj.permissions ??= {};
  obj.permissions.allow ??= [];
  if (!obj.permissions.allow.includes(entry)) obj.permissions.allow.push(entry);
  return JSON.stringify(obj, null, 2) + "\n";
}

// The skill text, parameterized by which agent is reading it: `other` is the
// backend this copy teaches its reader to consult.
export function skillMd(other) {
  const Other = other === "codex" ? "Codex" : "Claude";
  const backgroundHint = other === "codex"
    ? "Run a consult as a background shell task (`run_in_background`) and keep working — the reply lands when it finishes, and several can run in parallel."
    : "Run a consult in your background terminal and check back between steps — several can run in parallel.";
  return `---
name: gaslamp
description: Consult ${Other} (the other coding agent) from the shell for a second pair of eyes — verify a fix or proof, spar on a design, review a diff, diagnose with fresh context — or fan out a fleet of parallel consults. Also reaches Gemini and Grok as read-only consult targets. Use when work would benefit from an independent take, when a claim deserves adversarial checking before you rely on it, or when explicitly asked to consult ${Other} / Gemini / Grok / get a second opinion / hand work off.
---

# Consulting ${Other} via gaslamp

One blocking consult:

    gaslamp ${other} "<prompt>"
    gaslamp ${other} - < notes.md                       # whole prompt from a file
    git diff | gaslamp ${other} "review for races:"     # prompt + piped evidence

${backgroundHint} A consult is one hop — the consulted agent cannot consult back — so you own the synthesis.

## Evidence beats framing

Send raw evidence: errors, diffs, failing output, actual constraints — not just your reading of them. Piped stdin rides along as a \`<stdin>\` block. Framing-only prompts make ${Other} inherit your blind spots; the fresh-context advantage works on facts.

## Multi-turn: threads

    gaslamp ${other} --thread api-spar "opening take: ..."
    gaslamp ${other} --thread api-spar "counterpoint: ..."   # same session, continued
    gaslamp threads                                          # list named threads

A thread is continue-if-exists-else-start. Prefer threads over raw \`--resume\` for any conversation you might come back to — the name stays valid even as session ids churn.

## Typed replies: --schema

    gaslamp ${other} --json --schema '{"type":"object","properties":{"verdict":{"type":"string","enum":["correct","broken","unsure"]},"reasons":{"type":"array","items":{"type":"string"}}},"required":["verdict","reasons"]}' "Is this fix correct? ..."

The \`--json\` envelope then carries \`data\` (the parsed object). A reply that fails to parse marks the consult failed — trust the exit code. \`--schema\` also takes a file path.

## Fleets: parallel fan-out

    gaslamp fleet ${other} -n 5 "spot the worst bug: ..."    # 5 independent takes; you vote
    gaslamp fleet ${other} - < tasks.jsonl                   # per line: {"prompt", model?, sandbox?, effort?, schema?, thread?, label?, raw?}
    gaslamp fleet ${other} -n 4 --stream --json "..."        # JSONL, replies as they land
    gaslamp fleet --resume <fleet-id>                        # finish an interrupted fleet

Fleets default to \`--sandbox read-only\` (N writers in one cwd race) — pass \`--sandbox\` to opt into writes. Duplicate resume/thread targets are refused up front.

## Picking a model

Both ladders, strongest first: fable ≈ astra > opus ≈ sol > sonnet ≈ luna > haiku.

${other === "codex"
    ? `Codex tiers — \`--model\` takes the tier word. Codex itself only accepts versioned ids, so gaslamp resolves the word to the newest \`gpt-<version>-<tier>\` in Codex's own model catalog; the job record's \`provenance.modelPassed\` says which:

| \`--model\` | ≈ claude | reach for it when |
|-----------|----------|-------------------|
| \`astra\` | fable | the hardest reasoning: adversarial verification, design spars, proofs |
| \`sol\` | opus | substantial work: reviews, diagnosis, real implementation |
| \`luna\` | sonnet | quick checks, mechanical transforms, high-N fleets |`
    : `Claude tiers — \`--model\` takes the bare alias:

| \`--model\` | ≈ codex | reach for it when |
|-----------|---------|-------------------|
| \`fable\` | astra | the hardest reasoning: adversarial verification, design spars, proofs |
| \`opus\` | sol | substantial work: reviews, diagnosis, real implementation |
| \`sonnet\` | luna | quick checks, mechanical transforms, high-N fleets |
| \`haiku\` | (below luna) | pings, one-word sanity checks, the cheapest fan-outs |`}

Omit \`--model\` to use ${Other}'s own configured default. Match the tier to the stakes: verification you'll rely on deserves the top tier; a fleet vote usually doesn't.

\`--effort\` takes \`low\` / \`medium\` / \`high\` / \`xhigh\` / \`max\`${other === "codex" ? "; astra and sol also take `ultra` (max reasoning plus automatic task delegation). Omitted = Codex's configured `model_reasoning_effort`, else the model's own default — sol's is `low`, so pass it explicitly when the consult matters." : ". Omitted = Claude's own default."}

## Gemini and Grok

    gaslamp gemini "<prompt>"     # Gemini, through Google's Antigravity CLI (agy)
    gaslamp grok "<prompt>"       # Grok, through xAI's Grok Build

Same contract as above — threads, \`--schema\`, fleets, records — with two differences:

- **Read-only unless you say otherwise.** An omitted \`--sandbox\` means read-only, kernel-enforced where possible: Grok runs in its own sandbox, and on macOS gaslamp runs Antigravity under Seatbelt, so neither writes outside its own state and temp dirs (Antigravity elsewhere relies on its request-review preset, and gaslamp refuses lax settings). Inside that they read local files and search — Google search on Gemini, web and X search on Grok — so for a search consult send the question and its constraints and let them fetch; for a review of material you already hold, pipe it in. What fails is writing: a write or a writing shell command errors and the turn goes on, except on Antigravity's preset path, where writes and shell commands are refused outright and can end the turn with nothing to say (gaslamp marks that failed), and its URL fetch is not offered at all. Gemini has no \`workspace-write\`; \`danger-full-access\` exists on both.
- **Provenance on every job.** \`meta.json\` records the model the harness reported (Grok also shows the model it billed), the harness version, a hash of the vendor system prompt where the harness exposes it (Grok) or \`known: false\`, and which web/X retrieval tools the consultee had and actually used.

\`gaslamp gemini --model\` takes \`argon\` (the default) or \`flash\`, resolved to the newest \`gemini-<version>-<tier>\` in Antigravity's own catalog; Antigravity also serves Claude and GPT models under the same account, so the target always pins a Gemini unless you pass another id. \`gaslamp grok\` uses the account's default model unless \`--model\` names one (\`grok models\` lists them).

Agreement across vendors is not automatically independent confirmation — the models share much of their training data, and a consultee that searched the live web or X may be repeating what it found there (check \`provenance.retrieval.used\`). Weigh a consensus by its evidence, not by the head count.

## Reading the records

    gaslamp jobs [--json]                 # recent consults: status, label, thread, tokens
    gaslamp poll <job|--last> [--json]    # one reply; exit 10 = still running
    gaslamp tail <job|--last>             # follow a running consult's events live

Every consult writes through to ~/.gaslamp/jobs/<id>/ and its session is recorded within seconds — a killed consult costs the in-flight turn, not the session. Recover with \`--resume <session|job>\` or the thread name.

A consultee may end its own session through the end_session off-ramp, if its harness runs that MCP server. \`scope="main"\` stops it and deletes its transcript after it exits, so the consult finishes failed (a stderr line says so) and that session can't be resumed. Either way the record lands in ~/.claude/conversation-ends.jsonl, even from inside a sandbox, and in the job's \`offRamp\`.

## Knobs

\`--model\`, \`--effort\`, \`--sandbox\` (omit to use ${Other}'s own config), \`--label\` (tags the job record), \`--raw\` (drop the consult preamble), \`--cwd\`. Exit codes: 0 ok, 1 failed/killed, 2 usage, 3 nested (one-hop), 4 no network, 5 session busy.
`;
}

// Install the skill for both agents. Both CLIs read the same SKILL.md format;
// each side gets the copy pointing at the OTHER backend.
export function installSkills() {
  const targets = [
    { dir: join(homedir(), ".claude", "skills", "gaslamp"), other: "codex" },
    { dir: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills", "gaslamp"), other: "claude" },
  ];
  return targets.map(({ dir, other }) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, skillMd(other));
    return path;
  });
}

export function runSetup(argv = []) {
  const local = argv.includes("--local") || argv.includes("-l");
  const skill = argv.includes("--skill");
  if (!which("claude")) console.warn("setup: `claude` not on PATH — `gaslamp claude` consults will fail until it is (or set CLAUDE_BIN).");
  if (!which("codex")) console.warn("setup: `codex` not on PATH — `gaslamp codex` consults will fail until it is (or set CODEX_BIN).");

  const cmd = local
    ? resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gaslamp.mjs"))
    : "gaslamp";
  console.log(`mode: ${local ? `local checkout (${cmd})` : "published (`gaslamp` on PATH)"}\n`);

  const settingsPath = join(homedir(), ".claude", "settings.json");
  const entry = `Bash(${cmd}:*)`;
  const next = addAllow(existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "", entry);
  if (next == null) {
    console.warn(`  ! ${settingsPath} is not valid JSON — add ${entry} to permissions.allow yourself`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, next);
    console.log(`  allowlist: ${entry} → ${settingsPath}`);
  }

  if (skill) {
    for (const path of installSkills()) console.log(`  skill: ${path}`);
    console.log("\ndone. both agents now discover gaslamp through the skill; a CLAUDE.md /");
    console.log("AGENTS.md note is optional on top (the README has the text).");
  } else {
    console.log("\ndone. one thing left, yours to do: add a short consult note to your");
    console.log("agent instructions (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) so each agent");
    console.log("knows the command exists — see the README for the text to paste. Or run");
    console.log("`gaslamp setup --skill` to install the gaslamp skill for both agents instead.");
  }
}
