#!/usr/bin/env node
// gaslamp: let Claude Code and Codex consult each other from the shell.
//
//   gaslamp claude … / codex …   one blocking consult (the heart of it)
//   gaslamp fleet <backend> …    fan out a bounded fleet of consults
//   gaslamp jobs / poll          read the durable consult records
//   gaslamp setup [--local]      allowlist the command for Claude Code
//
// Each agent backgrounds the call with its own facility, so consults run in
// parallel and replies trickle in as they finish. No MCP servers, no daemon:
// asynchrony is the harness's job.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const HELP = `gaslamp ${pkg.version}: let Claude Code and Codex consult each other from the shell.

Usage:
  gaslamp claude [opts] <prompt|->   Consult Claude (blocks until the reply).
  gaslamp codex  [opts] <prompt|->   Consult Codex  (blocks until the reply).
  gaslamp fleet <backend> [opts]     Fan out a fleet of consults (one command).
    -n N <prompt>                    Replicate one prompt across N fresh sessions.
    - < tasks.jsonl                  Or one task per line on stdin (see below).
  gaslamp jobs [-n N]                List consult records, newest first.
  gaslamp poll <job|fleet|--last>    Print one record's reply/status.
  gaslamp setup [--local]            Allowlist the command in Claude Code so
                                     consults don't stall on a permission prompt.
                                     --local pins this checkout's bin path.

Consult options:
  --resume <session|job>   Continue a session (a prior job id works too).
  --model <m>              Backend model override.
  --sandbox <mode>         claude: read-only | danger-full-access
                           codex:  read-only | workspace-write | danger-full-access
                           Omit to defer to the consulted agent's own config.
  --cwd <dir>              Working directory for the consult (default: here).
  --schema <file|json>     JSON Schema for the reply (native on both backends:
                           claude --json-schema / codex --output-schema). The
                           --json envelope gains data (the parsed object); a
                           reply that doesn't parse marks the consult failed.
  --json                   Machine envelope on stdout:
                           {backend, jobId, sessionId, status, exitCode,
                            content, data?}
  -                        Read the prompt from stdin (default when piped).

Fleet options (in addition to --model / --sandbox / --cwd / --json, applied to
every consult unless a per-task field on a stdin manifest overrides it):
  -n, --count N            Replicate the prompt across N fresh sessions.
  -j, --concurrency N      Max consults in flight (default 4 — quota-shaped).
  - < tasks.jsonl          One task per line: a {"prompt",…} JSON object (also
                           model/sandbox/cwd/resume/label/schema — schema may
                           be an inline JSON object), or a bare prompt.
A fleet defaults its consults to --sandbox read-only (N writers in one cwd
race); pass --sandbox to opt into writes. It blocks until every consult is in,
then prints them all (--json: a results array, manifest order). A killed fleet
leaves each child resumable; gaslamp poll <fleet-id> regroups them later.

Run a consult (or a fleet) as a background shell task and keep working — several
can run in parallel, replies land as the tasks finish. Every consult writes through to
~/.gaslamp/jobs/<id>/ (prompt, raw events, reply, stderr), and the session id
is recorded the moment the backend reports it: a killed consult costs the
in-flight turn, not the session. Recovery is --resume, not orphans.

Exit codes:
  0 ok · 1 consult failed/killed · 2 usage · 3 nested (one-hop) refusal ·
  4 network-disabled sandbox · 5 session busy · poll: 10 still running

Env knobs:
  GASLAMP_HOME             state dir (default ~/.gaslamp)
  GASLAMP_ALLOWED_TOOLS    tools the claude read-only override permits
                           (default: Read Grep Glob WebFetch WebSearch)
  GASLAMP_ALLOW_RECURSION  let consulted agents consult back (off = one hop)
  GASLAMP_DEBUG            verbose stderr (spawn argv)
  CLAUDE_BIN / CODEX_BIN   backend binaries (autodetected otherwise)
`;

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "claude":
  case "codex": {
    const { runConsult } = await import(new URL("../src/consult.mjs", import.meta.url));
    runConsult(cmd, rest);
    break;
  }
  case "fleet": {
    const { runFleet } = await import(new URL("../src/fleet.mjs", import.meta.url));
    runFleet(rest[0], rest.slice(1));
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
  case "setup": {
    const { runSetup } = await import(new URL("../src/setup.mjs", import.meta.url));
    runSetup(rest);
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
  default:
    process.stderr.write(`gaslamp: unknown command "${cmd}"\n\n` + HELP);
    process.exitCode = 2;
}
