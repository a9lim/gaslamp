// setup.mjs — point both agents at the gaslamp CLI and clean up 1.0.
//
// gaslamp 2.0 has no MCP servers, so there is nothing to register. Setup
// instead:
//
//   1. removes the 1.0 MCP registrations from both CLIs (incl. legacy names;
//      `codex mcp remove` drops the tool_timeout_sec patch along with the
//      block — the whole timeout saga dies with the registration)
//   2. allowlists the command in ~/.claude/settings.json so consults don't
//      stall on a permission prompt. (Codex needs no analog: shell commands
//      are governed by approval_policy.)
//   3. prints the consult guidance for you to add to your agent instructions.
//      Setup does NOT edit ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md — those are
//      your files to own; silently appending to a personal instructions file is
//      exactly the surprise a published tool shouldn't spring. `gaslamp guidance
//      [claude|codex]` reprints the block any time (pipe it where you want it).
//
//   gaslamp setup            published install (`gaslamp` on PATH)
//   gaslamp setup --local    THIS checkout (absolute bin path; from-source dev)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "./which.mjs";

// The <!-- gaslamp:begin/end --> markers bracket the block as provenance and so
// you (or a future re-paste) can find and replace it in place. doctor detects a
// block by BEGIN. Setup no longer writes it — see the header.
export const BEGIN = "<!-- gaslamp:begin -->";
export const END = "<!-- gaslamp:end -->";

// The block for the CONSULTING agent's instructions; `target` is the
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

For a whole *fleet* in one command — N independent tasks, or one prompt sampled
N times — \`${cmd} fleet ${target} -n N "<prompt>"\` (or one task per line on
stdin: \`${cmd} fleet ${target} - < tasks.jsonl\`). It blocks until every reply
is in, then prints them all; fleets run --sandbox read-only by default, and
\`${cmd} poll <fleet-id>\` regroups them.
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

  // --- 2) Claude-side allowlist --------------------------------------------------
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

  // --- 3) hand the guidance to the user (setup no longer writes it) -----------
  const claudeFile = join(homedir(), ".claude", "CLAUDE.md");
  const codexFile = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "AGENTS.md");
  const lf = local ? " --local" : "";
  console.log("\nadd the consult guidance to your agent instructions (yours to own — setup won't touch them):");
  console.log(`  Claude (so it consults Codex):  ${cmd} guidance claude${lf} >> ${claudeFile}`);
  console.log(`  Codex  (so it consults Claude): ${cmd} guidance codex${lf}  >> ${codexFile}`);
  console.log(`  review both first:               ${cmd} guidance${lf}`);

  console.log("\ndone. restart Claude Code once so it drops the 1.0 MCP tools; the CLI itself needs no restart.");
  console.log("verify: gaslamp doctor");
}

// gaslamp guidance [--local] [claude|codex] — print the consult guidance block
// for an agent's instruction file, for you to review or pipe into place. The arg
// is the agent whose file you're filling (claude → ~/.claude/CLAUDE.md, which
// gets the "consult Codex" guidance; codex → ~/.codex/AGENTS.md, "consult
// Claude"). No arg prints both, each headed by its destination. --local embeds
// this checkout's absolute bin path, mirroring `setup --local`.
export function runGuidance(argv = []) {
  const local = argv.includes("--local") || argv.includes("-l");
  const who = argv.find((a) => !a.startsWith("-"));
  if (who && who !== "claude" && who !== "codex") {
    console.error(`gaslamp guidance: unknown agent "${who}" — use claude, codex, or no arg for both`);
    process.exitCode = 2;
    return;
  }
  const cmd = local
    ? resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gaslamp.mjs"))
    : "gaslamp";
  // dest = the agent whose file this is; target = the agent it should consult.
  const dests = who ? [who] : ["claude", "codex"];
  const out = [];
  for (const dest of dests) {
    const target = dest === "claude" ? "codex" : "claude";
    // No header in single-agent mode: stdout is exactly the block, clean for `>>`.
    if (!who) out.push(`# add to ${dest === "claude" ? "~/.claude/CLAUDE.md" : "~/.codex/AGENTS.md"}`);
    out.push(guidanceBlock(target, cmd));
  }
  process.stdout.write(out.join("\n\n") + "\n");
}
