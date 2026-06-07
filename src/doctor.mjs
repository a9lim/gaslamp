// doctor.mjs — non-invasive health check for a gaslamp install. Verifies the
// pieces are present and both directions are registered, without spending an
// actual Claude or Codex round-trip. Exits nonzero if anything critical is off.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./which.mjs";

function resolveClaude() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const onPath = which("claude");
  if (onPath) return onPath;
  const local = join(homedir(), ".local/bin/claude");
  return existsSync(local) ? local : null;
}

// Read `<cli> mcp list` and report whether a server named `gaslamp` is present.
function registered(cli) {
  const r = spawnSync(cli, ["mcp", "list"], { encoding: "utf8" });
  return /(^|\s)gaslamp(\s|:|$)/m.test((r.stdout || "") + (r.stderr || ""));
}

export function runDoctor() {
  const checks = [];
  const add = (pass, label, detail) => checks.push({ pass, label, detail });

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 18, "node", `${process.version}${major < 18 ? " (need >= 18)" : ""}`);

  // Binaries
  const claude = resolveClaude();
  add(!!claude, "claude binary", claude || "not found (set CLAUDE_BIN or add to PATH)");
  const codex = which("codex");
  add(!!codex, "codex binary", codex || "not found on PATH");

  // Registrations (only checkable if the relevant CLI exists)
  if (codex) {
    const reg = registered("codex");
    add(reg, "codex -> claude", reg ? "gaslamp registered in Codex" : "not registered — run `gaslamp setup`");
  }
  if (claude) {
    const reg = registered("claude");
    add(reg, "claude -> codex", reg ? "gaslamp registered in Claude" : "not registered — run `gaslamp setup`");
  }

  let allGood = true;
  for (const c of checks) {
    process.stdout.write(`  ${c.pass ? "✓" : "✗"} ${c.label}: ${c.detail}\n`);
    if (!c.pass) allGood = false;
  }
  console.log();
  if (allGood) {
    console.log("all good. (doctor doesn't round-trip; for a live check, consult from one agent to the other.)");
  } else {
    console.error("some checks failed — see above.");
    process.exitCode = 1;
  }
}
