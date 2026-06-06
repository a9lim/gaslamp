#!/usr/bin/env node
// gaslamp.mjs — let Codex consult Claude over MCP (the reverse of Claude→Codex,
// which uses Codex's native `codex mcp-server`). Together: either agent can hand
// work to the other for a review, a second opinion, or a fix.
//
// Tools exposed to Codex:
//   gaslamp        hand off to a fresh Claude session (review / fix / second opinion)
//   gaslamp-reply  continue a prior consultation by sessionId
//
// Design:
//   - Read/write by default: the consulted Claude can edit files in `cwd`
//     (--dangerously-skip-permissions). Set GASLAMP_READONLY=1 for an advisory,
//     no-edit reviewer instead.
//   - No recursion: Claude is launched with --strict-mcp-config + an empty MCP
//     config, so a consulted Claude has no MCP servers (can't loop back into
//     Codex) and stays lean.
//   - Strips ANTHROPIC_API_KEY from the child env so Claude uses keychain OAuth.
//
// Zero dependencies. Newline-delimited JSON-RPC over stdio (MCP stdio transport).

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMPTY_MCP = join(HERE, "empty-mcp.json");
if (!existsSync(EMPTY_MCP)) writeFileSync(EMPTY_MCP, JSON.stringify({ mcpServers: {} }));

const READONLY = !!process.env.GASLAMP_READONLY;
const ALLOWED_TOOLS = process.env.GASLAMP_ALLOWED_TOOLS ||
  "Read Grep Glob WebFetch WebSearch Bash(git *)";
const CALL_TIMEOUT_MS = Number(process.env.GASLAMP_TIMEOUT_MS) || 600_000;
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

const CAP = READONLY
  ? "investigates read-only (Read/Grep/Glob/git/web) and returns findings as text — it does NOT edit"
  : "can read AND edit files in `cwd` (full read/write), and returns a summary of what it found or changed";

const TOOLS = [
  {
    name: "gaslamp",
    description:
      `Hand off to a fresh Claude Code session for a code review, second opinion, or fix. Claude ${CAP}. ` +
      "Returns a sessionId; pass it to gaslamp-reply to continue the same thread with full context.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What you want Claude to review, check, or do. Include the relevant context/paths." },
        cwd: { type: "string", description: "Absolute path to work in (the repo/dir). Defaults to the shim's cwd." },
        model: { type: "string", description: "Optional Claude model id. Omit to use the account default." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "gaslamp-reply",
    description: "Continue a previous Claude consultation by sessionId, preserving its context.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The sessionId returned by a prior gaslamp / gaslamp-reply call." },
        prompt: { type: "string", description: "Your follow-up for Claude." },
        cwd: { type: "string", description: "Absolute path to work in. Defaults to the shim's cwd." },
        model: { type: "string", description: "Optional Claude model id." },
      },
      required: ["sessionId", "prompt"],
    },
  },
];

function runClaude({ prompt, cwd, model, resume }, id) {
  const args = ["-p", prompt, "--output-format", "json", "--strict-mcp-config", "--mcp-config", EMPTY_MCP];
  if (READONLY) args.push("--allowedTools", ALLOWED_TOOLS);
  else args.push("--dangerously-skip-permissions");
  if (resume) args.push("--resume", resume);
  if (model) args.push("--model", model);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // force keychain OAuth

  const t0 = Date.now();
  log("spawn", CLAUDE_BIN, "resume=" + (resume || "-"), "cwd=" + (cwd || process.cwd()));
  transcript(`→ codex asks claude${resume ? " (reply " + resume.slice(0, 8) + ")" : ""} @ ${cwd || process.cwd()}: ${clip(prompt)}`);
  const child = spawn(CLAUDE_BIN, args, { cwd: cwd || process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });

  let out = "", err = "", done = false;
  const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
  const timer = setTimeout(() => finish(() => {
    child.kill("SIGKILL");
    fail(id, -32000, `Claude consultation timed out after ${CALL_TIMEOUT_MS}ms`);
  }), CALL_TIMEOUT_MS);

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
      structuredContent: { sessionId, content: String(text), isError },
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
      serverInfo: { name: "gaslamp", version: "0.1.0" },
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
      runClaude({ prompt: a.prompt, cwd: a.cwd, model: a.model }, id);
    } else if (name === "gaslamp-reply") {
      if (!a.sessionId || !a.prompt) return fail(id, -32602, "missing required arg: sessionId and/or prompt");
      runClaude({ prompt: a.prompt, cwd: a.cwd, model: a.model, resume: a.sessionId }, id);
    } else {
      fail(id, -32601, `unknown tool: ${name}`);
    }
  } else if (id !== undefined) {
    fail(id, -32601, `unknown method: ${method}`);
  }
}

// ---- stdin loop -------------------------------------------------------------
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
log("ready; claude=" + CLAUDE_BIN + " mode=" + (READONLY ? "readonly" : "read-write"));
