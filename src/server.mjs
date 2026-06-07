// server.mjs — let Codex consult Claude over MCP, built as a mirror image of
// Codex's native `codex mcp-server` so the two directions are symmetric. Either
// agent can hand work to the other for a review, a second opinion, or a fix.
//
// Tools exposed to Codex (mirror of codex / codex-reply):
//   gaslamp        start a Claude session (review / fix / second opinion)
//   gaslamp-reply  continue a prior consultation by sessionId
//
// Symmetry with `codex mcp-server`:
//   - Per-call `sandbox` arg; OMITTING it defers to the user's own Claude config
//     (~/.claude settings: permission defaultMode, allow/deny rules, model, MCP,
//     CLAUDE.md), the mirror of Codex deferring to `sandbox_mode` in config.toml.
//   - No bespoke timeout and no recursion isolation — a consulted Claude loads
//     the user's full config/MCP, exactly as a consulted Codex does.
//   - The lone Claude-only step (no Codex analog, so not an asymmetry):
//     ANTHROPIC_API_KEY is stripped from the child env so keychain OAuth is
//     authoritative. A stale env key 401s every call otherwise.
//
// Claude has no filesystem-scoped sandbox, so there is no honest `workspace-write`
// middle ground (it would map to the same full access as danger-full-access). The
// `sandbox` arg therefore has two explicit overrides, and omitting it is the
// default:
//   - omitted             → pass no permission flag; the consulted Claude uses
//                           the user's own ~/.claude config (see above). Since
//                           `claude -p` loads settings by default, this is exactly
//                           how the user's interactive Claude would behave here.
//   - read-only           → --permission-mode default --allowedTools <read set>,
//                           which overrides the user's defaultMode (even bypass)
//                           and restricts to read tools (advisory reviewer).
//   - danger-full-access  → --dangerously-skip-permissions (force full read/write).
//
// Zero dependencies. Newline-delimited JSON-RPC over stdio (MCP stdio transport).

import { spawn } from "node:child_process";
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the version: package.json. Read at runtime (rather
// than imported with an attribute) so it works across the whole engines range.
const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const SANDBOXES = ["read-only", "danger-full-access"];
// Tools permitted under the `read-only` override. Pure read set by default; set
// GASLAMP_ALLOWED_TOOLS (space- or comma-separated) to widen it, e.g. add
// `Bash(git diff:*)`. This is the ONLY thing this var affects now — there is no
// bespoke default sandbox; an omitted `sandbox` defers to the user's own config.
const ALLOWED_TOOLS = (process.env.GASLAMP_ALLOWED_TOOLS || "Read Grep Glob WebFetch WebSearch")
  .split(/[\s,]+/).filter(Boolean).join(",");
const DEBUG = !!process.env.GASLAMP_DEBUG;

// Persistent consultation transcript (the lightweight "watch them talk" log).
// Defaults to ~/.codex/gaslamp.log; set GASLAMP_LOGFILE=off to disable.
const LOGFILE = process.env.GASLAMP_LOGFILE === "off" ? null
  : (process.env.GASLAMP_LOGFILE || join(homedir(), ".codex", "gaslamp.log"));
const ts = () => new Date().toISOString();
function log(...a) { if (DEBUG) process.stderr.write("[gaslamp] " + a.join(" ") + "\n"); }
function transcript(line) { if (!LOGFILE) return; try { appendFileSync(LOGFILE, ts() + " " + line + "\n"); } catch {} }
const clip = (s, n = 200) => { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

function resolveClaude() {
  const cands = [process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude")].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return "claude"; // last resort: rely on PATH
}
const CLAUDE_BIN = resolveClaude();

// ---- MCP plumbing -----------------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

// Mirrors codex's `{ threadId, content }` outputSchema. sessionId may be null on
// a hard failure, so only `content` is required.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string", description: "The Claude session id; pass to gaslamp-reply to continue." },
    content: { type: "string" },
  },
  required: ["content"],
};

const SANDBOX_DESC =
  "Permission override. Omit to use the user's own Claude config (their permission " +
  "default, allow/deny rules, model, MCP) — this is the default. `read-only` forces " +
  "an advisory, no-edit reviewer; `danger-full-access` forces full read/write. " +
  "(Claude has no filesystem sandbox, so there is no honest `workspace-write`.)";

const TOOLS = [
  {
    name: "gaslamp",
    title: "Claude",
    description:
      "Start a Claude Code session for a code review, second opinion, or fix. Claude works in " +
      "`cwd` and returns a summary of what it found or changed. Returns a sessionId; pass it to " +
      "gaslamp-reply to continue the same thread with full context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "The initial prompt for Claude. Include the relevant context/paths." },
        cwd: { type: "string", description: "Working directory for the session. If relative, resolved against the server process's cwd." },
        model: { type: "string", description: "Optional Claude model id or alias (e.g. 'sonnet', 'opus'). Omit for the account default." },
        sandbox: { type: "string", enum: SANDBOXES, description: SANDBOX_DESC },
      },
      required: ["prompt"],
    },
    outputSchema: OUTPUT_SCHEMA,
  },
  {
    name: "gaslamp-reply",
    title: "Claude Reply",
    description: "Continue a Claude consultation by providing the sessionId and prompt, preserving its context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "The sessionId returned by a prior gaslamp / gaslamp-reply call." },
        prompt: { type: "string", description: "The next prompt to continue the Claude conversation." },
        cwd: { type: "string", description: "Working directory. If relative, resolved against the server process's cwd." },
        model: { type: "string", description: "Optional Claude model id or alias." },
        sandbox: { type: "string", enum: SANDBOXES, description: SANDBOX_DESC },
      },
      required: ["sessionId", "prompt"],
    },
    outputSchema: OUTPUT_SCHEMA,
  },
];

function runClaude({ prompt, cwd, model, sandbox, resume }, id) {
  const mode = SANDBOXES.includes(sandbox) ? sandbox : null; // null = defer to user's config
  const modeLabel = mode || "user-config";
  const args = ["-p", prompt, "--output-format", "json"];
  if (mode === "read-only") {
    // --permission-mode default overrides the user's defaultMode (even bypass),
    // and the allowlist restricts to read tools; anything else is denied in
    // headless. A real read-only that holds regardless of the user's config.
    args.push("--permission-mode", "default", "--allowedTools", ALLOWED_TOOLS);
  } else if (mode === "danger-full-access") {
    args.push("--dangerously-skip-permissions");
  }
  // else (omitted): pass no permission flag — the consulted Claude uses the
  // user's own ~/.claude config, mirroring Codex deferring to config.toml.
  if (resume) args.push("--resume", resume);
  if (model) args.push("--model", model);

  // Strip ANTHROPIC_API_KEY so the consulted Claude authenticates via keychain
  // OAuth. This has no Codex analog (Codex doesn't read this var), so it isn't an
  // asymmetry — it's what makes Claude's auth "just work" from its keychain the
  // way Codex's does. A stale/invalid env key would otherwise 401 every call.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const t0 = Date.now();
  log("spawn", CLAUDE_BIN, "mode=" + modeLabel, "resume=" + (resume || "-"), "cwd=" + (cwd || process.cwd()));
  transcript(`→ codex asks claude${resume ? " (reply " + resume.slice(0, 8) + ")" : ""} [${modeLabel}] @ ${cwd || process.cwd()}: ${clip(prompt)}`);
  const child = spawn(CLAUDE_BIN, args, { cwd: cwd || process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });

  let out = "", err = "", done = false;
  const finish = (fn) => { if (done) return; done = true; fn(); };
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => finish(() => fail(id, -32000, `Failed to launch claude: ${e.message}`)));
  child.on("close", (code) => finish(() => {
    log("close code=" + code + " ms=" + (Date.now() - t0) + " outlen=" + out.length + " errlen=" + err.length);
    let parsed;
    try { parsed = JSON.parse(out); } catch { parsed = null; }
    const r = Array.isArray(parsed) ? parsed.find((m) => m && m.type === "result") : parsed;
    const text = r ? (r.result ?? r.content ?? JSON.stringify(r)) : (out.trim() || err.trim() || `claude exited ${code} with no output`);
    const sessionId = r?.session_id ?? resume ?? null;
    const isError = r ? !!r.is_error : code !== 0;
    transcript(`← claude ${isError ? "ERR" : "ok"} (${Date.now() - t0}ms, session ${sessionId ? sessionId.slice(0, 8) : "-"}): ${clip(text)}`);
    reply(id, {
      content: [{ type: "text", text: String(text) }],
      structuredContent: { sessionId, content: String(text) },
      isError,
    });
  }));
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "gaslamp", title: "Claude", version: VERSION },
    });
  } else if (method?.startsWith("notifications/")) {
    /* no response to notifications */
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    const a = params?.arguments || {};
    if (name === "gaslamp") {
      if (!a.prompt) return fail(id, -32602, "missing required arg: prompt");
      runClaude({ prompt: a.prompt, cwd: a.cwd, model: a.model, sandbox: a.sandbox }, id);
    } else if (name === "gaslamp-reply") {
      if (!a.sessionId || !a.prompt) return fail(id, -32602, "missing required arg: sessionId and/or prompt");
      runClaude({ prompt: a.prompt, cwd: a.cwd, model: a.model, sandbox: a.sandbox, resume: a.sessionId }, id);
    } else {
      fail(id, -32601, `unknown tool: ${name}`);
    }
  } else if (id !== undefined) {
    fail(id, -32601, `unknown method: ${method}`);
  }
}

// ---- stdio loop -------------------------------------------------------------
// Start the MCP server: read newline-delimited JSON-RPC on stdin, write
// responses on stdout. Blocks (keeps the process alive) until stdin closes.
export function startServer() {
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      log("recv", line.slice(0, 300));
      try { handle(JSON.parse(line)); }
      catch (e) { log("parse error", e.message, "on", line.slice(0, 120)); }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  log("ready; claude=" + CLAUDE_BIN + " version=" + VERSION);
}

export { VERSION, TOOLS };
