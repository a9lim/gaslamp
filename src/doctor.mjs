// doctor.mjs — non-invasive health check for a gaslamp 2.0 install. Verifies
// binaries, guidance blocks, and local state without spending a Claude or
// Codex round-trip. Exits nonzero if anything actionable is off.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./which.mjs";
import { BEGIN } from "./setup.mjs";
import { alive, jobsDir, listJobIds, liveStatus, locksDir, readMeta } from "./jobs.mjs";

function resolveClaude() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const onPath = which("claude");
  if (onPath) return onPath;
  const local = join(homedir(), ".local/bin/claude");
  return existsSync(local) ? local : null;
}

export function runDoctor() {
  const checks = [];
  // soft checks report status but never fail the run (advisory, not broken).
  const add = (pass, label, detail, soft = false) => checks.push({ pass, label, detail, soft });

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 18, "node", `${process.version}${major < 18 ? " (need >= 18)" : ""}`);

  // Binaries
  const claude = resolveClaude();
  add(!!claude, "claude binary", claude || "not found (set CLAUDE_BIN or add to PATH)");
  const codex = (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN) && process.env.CODEX_BIN) || which("codex");
  add(!!codex, "codex binary", codex || "not found on PATH (or set CODEX_BIN)");

  // Guidance blocks (advisory — yours to add now; a CLI doesn't self-advertise,
  // so an agent won't discover gaslamp until its instructions mention it).
  for (const [who, file] of [
    ["claude", join(homedir(), ".claude", "CLAUDE.md")],
    ["codex", join(process.env.CODEX_HOME || join(homedir(), ".codex"), "AGENTS.md")],
  ]) {
    let present = false;
    try { present = readFileSync(file, "utf8").includes(BEGIN); } catch {}
    add(present, `${who} guidance block`,
      present ? file : `not in ${file} — add it so the agent discovers gaslamp: \`gaslamp guidance ${who} >> ${file}\``,
      true);
  }

  // Lingering 1.0 MCP registrations (2.0's `serve` is a tombstone, so a stale
  // registration would spawn a process that errors on every load)
  for (const cli of ["claude", "codex"]) {
    if (!which(cli)) continue;
    const r = spawnSync(cli, ["mcp", "list"], { encoding: "utf8" });
    const reg = /(^|\s)gaslamp(\s|:|$)/m.test((r.stdout || "") + (r.stderr || ""));
    add(!reg, `${cli}: no stale MCP registration`, reg ? "1.0 registration still present — run `gaslamp setup` to remove it" : "clean");
  }

  // Ambient sentinel: a top-level shell with GASLAMP_NESTED set refuses every
  // consult (and breaks the test suite — the spar found this the hard way).
  add(!process.env.GASLAMP_NESTED, "no ambient GASLAMP_NESTED",
    process.env.GASLAMP_NESTED ? "set in this shell — consults here will refuse as nested" : "clean");

  // Local state (informational; never fails)
  let stale = 0, total = 0;
  try {
    for (const f of readdirSync(locksDir())) {
      total++;
      let holder = null;
      try { holder = JSON.parse(readFileSync(join(locksDir(), f), "utf8")); } catch {}
      if (!holder?.pid || !alive(holder.pid)) stale++;
    }
  } catch {}
  add(true, "locks", total ? `${total} held, ${stale} stale (stale locks are reaped on the next consult)` : "none");

  const ids = listJobIds();
  const running = ids.filter((id) => { const m = readMeta(id); return m && liveStatus(m) === "running"; }).length;
  add(true, "jobs", ids.length ? `${ids.length} recorded under ${jobsDir()}${running ? ` (${running} running)` : ""}` : `none yet (${jobsDir()})`);

  let allGood = true;
  for (const c of checks) {
    process.stdout.write(`  ${c.pass ? "✓" : c.soft ? "•" : "✗"} ${c.label}: ${c.detail}\n`);
    if (!c.pass && !c.soft) allGood = false;
  }
  console.log();
  if (allGood) {
    console.log("all good. (doctor doesn't round-trip; for a live check, run a real consult from either agent.)");
  } else {
    console.error("some checks failed — see above.");
    process.exitCode = 1;
  }
}
