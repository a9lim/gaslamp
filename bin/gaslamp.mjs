#!/usr/bin/env node
// gaslamp — pass the lamp between Claude Code and Codex over MCP.
//
//   gaslamp            run the MCP server on stdio (what Codex spawns)
//   gaslamp serve      same as above, explicit
//   gaslamp setup      register both directions (add --local for this checkout)
//   gaslamp doctor     verify the install without a round-trip
//   gaslamp --version  print the version
//   gaslamp --help     print this help
//
// The bare/`serve` path speaks newline-delimited JSON-RPC on stdout and must
// stay quiet otherwise; `setup`/`doctor` are interactive and print freely.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const HELP = `gaslamp ${pkg.version} — pass the lamp between Claude Code and Codex over MCP

Usage:
  gaslamp [serve]        Run the MCP server on stdio (what Codex spawns).
  gaslamp setup          Register both directions as \`gaslamp\` (published / npx).
  gaslamp setup --local  Register THIS checkout instead of the published package.
  gaslamp doctor         Check binaries + registrations (no round-trip).
  gaslamp --version      Print the version.
  gaslamp --help         Print this help.

Env knobs (read by the server):
  GASLAMP_SANDBOX        default sandbox: read-only | workspace-write | danger-full-access
  GASLAMP_ALLOWED_TOOLS  tools allowed under the read-only sandbox
  GASLAMP_LOGFILE        transcript path (default ~/.codex/gaslamp.log; "off" disables)
  GASLAMP_DEBUG          verbose stderr (raw JSON-RPC)
  CLAUDE_BIN             path to the claude binary (autodetected otherwise)
`;

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "serve": {
    const { startServer } = await import(new URL("../src/server.mjs", import.meta.url));
    startServer();
    break;
  }
  case "setup": {
    const { runSetup } = await import(new URL("../src/setup.mjs", import.meta.url));
    runSetup(rest);
    break;
  }
  case "doctor": {
    const { runDoctor } = await import(new URL("../src/doctor.mjs", import.meta.url));
    runDoctor(rest);
    break;
  }
  case "-v":
  case "--version":
    process.stdout.write(pkg.version + "\n");
    break;
  case "-h":
  case "--help":
    process.stdout.write(HELP);
    break;
  default:
    process.stderr.write(`gaslamp: unknown command "${cmd}"\n\n` + HELP);
    process.exitCode = 2;
}
