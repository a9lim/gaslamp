// setup.mjs — point both agents at the gaslamp CLI and clean up 1.0.
//
// gaslamp 2.0 has no MCP servers, so there is nothing to register. Setup
// instead:
//
//   1. removes the 1.0 MCP registrations from both CLIs (incl. legacy names;
//      `codex mcp remove` drops the tool_timeout_sec patch along with the
//      block — the whole timeout saga dies with the registration)
//   2. writes a managed guidance block — between <!-- gaslamp:begin/end -->
//      markers, idempotently — into ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md.
//      A CLI doesn't self-advertise in context the way MCP tools did; the
//      consult contract lives in the agents' own instructions, which is where
//      the when-to-consult guidance always belonged anyway.
//   3. allowlists the command in ~/.claude/settings.json so consults don't
//      stall on a permission prompt. (Codex needs no analog: shell commands
//      are governed by approval_policy.)
//
//   gaslamp setup            published install (`gaslamp` on PATH)
//   gaslamp setup --local    THIS checkout (absolute bin path; from-source dev)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "./which.mjs";

export const BEGIN = "<!-- gaslamp:begin -->";
export const END = "<!-- gaslamp:end -->";

// Replace the marked block in place if present, else append. Pure; idempotent
// by construction (upsert(upsert(t)) === upsert(t)).
export function upsertBlock(text, block) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  if (b >= 0 && e > b) return text.slice(0, b) + block + text.slice(e + END.length);
  const sep = !text ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return text + sep + block + "\n";
}

// The block written into the CONSULTING agent's instructions; `target` is the
// agent on the other end. Direction-appropriate backgrounding guidance.
export function guidanceBlock(target, cmd) {
  const Target = target === "codex" ? "Codex" : "Claude";
  const bg = target === "codex"
    ? "Run it as a background shell task (run_in_background) and keep working — the task notification delivers the reply."
    : "Run it in your background terminal and keep working — check back for the reply between steps.";
  return `${BEGIN}
## gaslamp — consult ${Target}

Hand work to ${Target} for a second pair of eyes: **verify** a fix before
claiming it works, **spar** on a design, **review** a diff, **diagnose** with
fresh context. Send raw evidence (errors, diffs, commands) — not just your
framing. Reach for it actively, not only when stuck.

    ${cmd} ${target} [--resume <session|job>] [--model <m>] [--sandbox <mode>] "<prompt>"
    ${cmd} ${target} - < prompt.md     # long prompts via stdin

Blocks until the reply, then prints it plus a \`[gaslamp] job: … · session: …\`
trailer. ${bg}
Several consults can run in parallel. Continue a thread with --resume (session
id, or the job id from the trailer). \`${cmd} jobs\` lists consult records,
\`${cmd} poll <job|--last>\` fetches one (exit 10 = still running); records
live under ~/.gaslamp/jobs/. A consult is one hop: the consulted agent cannot
consult back, so own the synthesis yourself.
${END}`;
}

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
  const claude = which("claude");
  const codex = which("codex");
  if (!claude) console.warn("setup: `claude` not on PATH — `gaslamp claude` consults will fail until it is (or set CLAUDE_BIN).");
  if (!codex) console.warn("setup: `codex` not on PATH — `gaslamp codex` consults will fail until it is (or set CODEX_BIN).");

  const cmd = local
    ? resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gaslamp.mjs"))
    : "gaslamp";
  console.log(`mode: ${local ? `local checkout (${cmd})` : "published (`gaslamp` on PATH)"}\n`);

  // --- 1) tear down 1.0 MCP registrations (and legacy names) -----------------
  for (const [cli, names, scope] of [
    ["claude", ["gaslamp", "codex"], ["-s", "user"]],
    ["codex", ["gaslamp", "claude"], []],
  ]) {
    if (!which(cli)) continue;
    for (const name of names) {
      const r = spawnSync(cli, ["mcp", "remove", name, ...scope], { encoding: "utf8" });
      if (r.status === 0) console.log(`  removed 1.0 MCP registration: ${name} (from ${cli})`);
    }
  }

  // --- 2) managed guidance blocks ---------------------------------------------
  const targets = [
    [join(homedir(), ".claude", "CLAUDE.md"), "codex"],
    [join(process.env.CODEX_HOME || join(homedir(), ".codex"), "AGENTS.md"), "claude"],
  ];
  for (const [file, target] of targets) {
    mkdirSync(dirname(file), { recursive: true });
    const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
    writeFileSync(file, upsertBlock(prev, guidanceBlock(target, cmd)));
    console.log(`  guidance block: ${file}`);
  }

  // --- 3) Claude-side allowlist --------------------------------------------------
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

  console.log("\ndone. restart Claude Code once so it drops the 1.0 MCP tools; the CLI itself needs no restart.");
  console.log("verify: gaslamp doctor");
}
