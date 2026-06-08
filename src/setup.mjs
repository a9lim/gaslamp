// setup.mjs — register both consultation channels under the name `gaslamp`.
//
// Two directions:
//   Codex → Claude : Codex gets a `gaslamp` tool that hands off to this server.
//   Claude → Codex : Claude gets Codex's native `codex mcp-server` (its `codex`
//                    / `codex-reply` tools), registered as `gaslamp`.
//
// Idempotent: removes prior registrations (including the legacy `claude` /
// `codex` names) before re-adding.
//
//   gaslamp setup            register the published package (Codex spawns
//                            `npx -y gaslamp serve`). Survives node upgrades —
//                            no absolute, version-pinned paths.
//   gaslamp setup --local    register THIS checkout (Codex spawns
//                            `<node> <abs>/bin/gaslamp.mjs serve`). Use before
//                            the package is published, or for from-source dev.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "./which.mjs";

function run(label, cmd, args) {
  process.stdout.write(`  ${label}: ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status === 0;
}

// `codex mcp add` cannot persist per-server timeouts (its `-c` flag is a runtime
// override that never lands in the block), so we patch ~/.codex/config.toml
// directly. Without this, Codex's MCP client kills any tools/call that runs past
// its default tool_timeout_sec — a substantial consult (30-45 min) dies with
// `timed out awaiting tools/call after 120s` while the gaslamp child keeps
// working, orphaned. The server itself has no timeout; this is the client side.
// Idempotent: sets the keys in-place if present, inserts them if not.
function patchCodexTimeouts() {
  const tool = process.env.GASLAMP_TOOL_TIMEOUT_SEC || "100000"; // ~27.8h — matches Claude Code's own default MCP tool timeout (1e8 ms), so both directions are symmetric
  const startup = process.env.GASLAMP_STARTUP_TIMEOUT_SEC || "30"; // headroom for npx cold-start
  const cfgPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

  let text;
  try { text = readFileSync(cfgPath, "utf8"); }
  catch { console.warn(`  (could not read ${cfgPath}; skipped timeout patch)`); return; }

  const lines = text.split("\n");
  const header = lines.findIndex((l) => l.trim() === "[mcp_servers.gaslamp]");
  if (header < 0) { console.warn("  (no [mcp_servers.gaslamp] block found; skipped timeout patch)"); return; }

  // Block runs from the header to the next table header (line starting with `[`).
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) { if (/^\s*\[/.test(lines[i])) { end = i; break; } }
  const block = lines.slice(header, end);

  const setKey = (key, val) => {
    const i = block.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (i >= 0) { block[i] = `${key} = ${val}`; return; }
    let at = block.length;                       // insert before trailing blank lines
    while (at > 1 && block[at - 1].trim() === "") at--;
    block.splice(at, 0, `${key} = ${val}`);
  };
  setKey("tool_timeout_sec", tool);
  setKey("startup_timeout_sec", startup);

  writeFileSync(cfgPath, [...lines.slice(0, header), ...block, ...lines.slice(end)].join("\n"));
  process.stdout.write(`  timeouts: tool_timeout_sec=${tool}s startup_timeout_sec=${startup}s in ${cfgPath}\n`);
}

// Quietly remove an existing registration (ignore "not found" noise).
function remove(cli, name, scopeArgs = []) {
  spawnSync(cli, ["mcp", "remove", name, ...scopeArgs], { stdio: "ignore" });
}

export function runSetup(argv = []) {
  const local = argv.includes("--local") || argv.includes("-l");

  const codex = which("codex");
  const claude = which("claude");
  if (!codex) { console.error("setup: `codex` not found on PATH. Install Codex first."); process.exitCode = 1; return; }
  if (!claude) { console.error("setup: `claude` not found on PATH. Install Claude Code first."); process.exitCode = 1; return; }
  if (!local && !which("npx")) {
    console.error("setup: `npx` not found on PATH — the published registration spawns `npx -y gaslamp serve`.");
    console.error("       Install Node's npm/npx, or use `gaslamp setup --local` to register this checkout instead.");
    process.exitCode = 1; return;
  }

  console.log(`codex: ${codex}`);
  console.log(`claude: ${claude}`);
  console.log(`mode:  ${local ? "local checkout" : "published (npx)"}\n`);

  // --- Codex -> Claude: codex gets a `gaslamp` tool that hands off to Claude ---
  remove("codex", "gaslamp");
  remove("codex", "claude"); // legacy name
  let serveCmd;
  if (local) {
    const node = which("node") || process.execPath;
    const shim = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gaslamp.mjs"));
    serveCmd = ["mcp", "add", "gaslamp", "--", node, shim, "serve"];
  } else {
    // Bare `npx` (not an absolute path) so whatever node is active resolves the
    // latest published gaslamp at spawn time — survives nvm/node upgrades.
    serveCmd = ["mcp", "add", "gaslamp", "--", "npx", "-y", "gaslamp", "serve"];
  }
  const okCodex = run("codex -> claude", "codex", serveCmd);
  if (okCodex) patchCodexTimeouts(); // codex mcp add can't persist these; do it ourselves

  // --- Claude -> Codex: claude gets gaslamp's codex tools (user scope) --------
  remove("claude", "gaslamp", ["-s", "user"]);
  remove("claude", "codex", ["-s", "user"]); // legacy name
  const okClaude = run("claude -> codex", "claude",
    ["mcp", "add", "gaslamp", "-s", "user", "--", "codex", "mcp-server"]);

  console.log();
  if (okCodex && okClaude) {
    console.log("registered both directions as `gaslamp`.");
    console.log("→ restart Claude Code so it loads the server.");
    console.log("  verify:  codex mcp list   and   claude mcp list");
  } else {
    console.error("setup: one or both registrations failed (see above).");
    process.exitCode = 1;
  }
}
