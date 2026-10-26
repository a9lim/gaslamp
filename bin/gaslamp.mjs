#!/usr/bin/env node
// gaslamp: let coding agents consult each other from the shell — Claude,
// Codex, Gemini and Grok.
//
//   gaslamp claude|codex|gemini|grok …   one blocking consult (the heart of it)
//   gaslamp jobs / poll / threads        read the durable records
//   gaslamp setup                        link the skill, allowlist the command
//
// Each agent backgrounds the call with its own facility, so consults run in
// parallel and replies trickle in as they finish. No MCP servers, no daemon:
// asynchrony is the harness's job.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const HELP = `gaslamp ${pkg.version}: let coding agents consult each other from the shell.

Usage:
  gaslamp <claude|codex|gemini|grok> [opts] <prompt|->
                             Consult one; blocks until the reply. Run it in the
                             background and keep working.
  gaslamp jobs [-n N] [--json]       Recent consults, newest first.
  gaslamp poll <job|--last> [--json] One consult's reply (exit 10 = running).
  gaslamp threads                    Named conversations, latest first.
  gaslamp setup                      Link the skill into Claude Code and Codex,
                                     and allowlist the command for Claude Code.

Consult options:
  --thread <name>          Name the conversation: the first consult with a
                           name starts it, later ones continue it (from the
                           directory it started in).
  --resume <job-id>        Continue an unnamed consult's conversation.
  --model <m>              An exact id, or a tier: claude fable|opus|sonnet|
                           haiku; codex astra|sol|luna; gemini argon|flash
                           (default argon).
  --effort <level>         low|medium|high|xhigh|max (codex astra/sol: ultra).
  --sandbox <mode>         read-only | workspace-write | danger-full-access.
                           Omitted: claude and codex use their own config;
                           gemini and grok run read-only. The fenced modes
                           are OS-enforced; gemini's needs macOS.
  --cwd <dir>              Run the consult there (default: here).
  --schema <file|json>     JSON Schema for the reply; with --json the parsed
                           reply is in data, and one that doesn't parse fails.
  --json                   {backend, jobId, status, thread, content, error?, data?}
  -                        Read the prompt from stdin (the default when piped).
                           With a prompt argument, piped stdin is appended as
                           a <stdin> evidence block:
                             git diff | gaslamp codex "review for races:"

Every consult writes through to ~/.gaslamp/jobs/<id>/ (prompt, raw events,
stderr, reply), and its session is recorded the moment the backend reports it:
a killed consult loses the turn in flight, not the conversation.

Exit codes:
  0 ok · 1 failed or killed · 2 usage · 3 nested (one-hop) refusal ·
  4 can't run here (no network, or no OS sandbox for the mode) ·
  5 conversation busy · poll: 10 still running

Env:
  GASLAMP_HOME             state dir (default ~/.gaslamp)
  GASLAMP_ALLOW_RECURSION  let consulted agents consult back (off = one hop)
  GASLAMP_DEBUG            print the spawn argv
  CLAUDE_BIN / CODEX_BIN / AGY_BIN / GROK_BIN   backend binaries
`;

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "claude":
  case "codex":
  case "gemini":
  case "grok": {
    const { runConsult } = await import(new URL("../src/consult.mjs", import.meta.url));
    runConsult(cmd, rest);
    break;
  }
  case "jobs": {
    const { runJobs } = await import(new URL("../src/jobs.mjs", import.meta.url));
    runJobs(rest);
    break;
  }
  case "poll": {
    const { runPoll } = await import(new URL("../src/jobs.mjs", import.meta.url));
    runPoll(rest);
    break;
  }
  case "threads": {
    const { runThreads } = await import(new URL("../src/threads.mjs", import.meta.url));
    runThreads();
    break;
  }
  case "setup": {
    const { runSetup } = await import(new URL("../src/setup.mjs", import.meta.url));
    runSetup();
    break;
  }
  case "-v":
  case "--version":
    process.stdout.write(pkg.version + "\n");
    break;
  case undefined:
  case "-h":
  case "--help":
    process.stdout.write(HELP);
    break;
  case "fleet":
  case "tail":
    process.stderr.write(`gaslamp: ${cmd} is gone in gaslamp 3 — run several consults in the background instead (see gaslamp --help)\n`);
    process.exitCode = 2;
    break;
  default:
    process.stderr.write(`gaslamp: unknown command "${cmd}"\n\n` + HELP);
    process.exitCode = 2;
}
