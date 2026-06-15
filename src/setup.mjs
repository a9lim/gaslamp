// setup.mjs — allowlist the gaslamp CLI for Claude Code.
//
// gaslamp has no MCP servers and nothing to register. Setup does one thing:
// allowlist the command in ~/.claude/settings.json so a consult doesn't stall
// on a permission prompt mid-call. (Codex needs no analog — shell commands are
// governed by approval_policy.)
//
// It does NOT touch your agent instructions. A CLI can't self-advertise the way
// MCP tools did, so each agent needs a one-line note in its instructions to know
// gaslamp exists — but appending to your personal CLAUDE.md / AGENTS.md is yours
// to do (the README has the text to paste), not a surprise setup springs.
//
//   gaslamp setup            published install (`gaslamp` on PATH)
//   gaslamp setup --local    THIS checkout (absolute bin path; from-source dev)

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

export function runSetup(argv = []) {
  const local = argv.includes("--local") || argv.includes("-l");
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

  console.log("\ndone. one thing left, yours to do: add a short consult note to your");
  console.log("agent instructions (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) so each agent");
  console.log("knows the command exists — see the README for the text to paste.");
}
