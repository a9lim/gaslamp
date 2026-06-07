// Smoke test: drive the gaslamp MCP server over stdio against a STUB `claude`
// binary, so the full JSON-RPC handshake (initialize / tools/list / tools/call /
// gaslamp-reply) is exercised deterministically with no real Claude in the loop.
//
// Run: node --test tests/*.test.mjs   (or: npm test)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "gaslamp.mjs");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// A fake `claude` that emits the JSON shape `claude -p ... --output-format json`
// produces: a single result object with `result`, `session_id`, `is_error`.
const STUB = `#!/usr/bin/env node
const a = process.argv.slice(2);
const i = a.indexOf("-p");
const prompt = i >= 0 && a[i + 1] ? a[i + 1] : "";
process.stdout.write(JSON.stringify({
  type: "result",
  result: "stub ok: " + prompt + " || argv: " + JSON.stringify(a),
  session_id: "sess-123",
  is_error: false,
}));
`;

let dir, stubPath, srv, rpc;

// Minimal newline-delimited JSON-RPC client over the child's stdio.
function makeRpc(child) {
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  return {
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    request: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 10000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }),
  };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gaslamp-test-"));
  stubPath = join(dir, "claude-stub.mjs");
  writeFileSync(stubPath, STUB);
  chmodSync(stubPath, 0o755);
  srv = spawn(process.execPath, [BIN, "serve"], {
    env: { ...process.env, CLAUDE_BIN: stubPath, GASLAMP_LOGFILE: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  rpc = makeRpc(srv);
});

after(() => {
  if (srv) srv.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("initialize reports server name and package version", async () => {
  const r = await rpc.request("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(r.result.serverInfo.name, "gaslamp");
  assert.equal(r.result.serverInfo.version, PKG.version);
  rpc.notify("notifications/initialized", {});
});

test("tools/list exposes gaslamp and gaslamp-reply", async () => {
  const r = await rpc.request("tools/list", {});
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["gaslamp", "gaslamp-reply"]);
});

test("tools/call gaslamp round-trips through the stub", async () => {
  const r = await rpc.request("tools/call", {
    name: "gaslamp",
    arguments: { prompt: "hello", sandbox: "read-only" },
  });
  assert.equal(r.result.structuredContent.sessionId, "sess-123");
  assert.match(r.result.structuredContent.content, /stub ok: hello/);
  assert.equal(r.result.isError, false);
});

test("tools/call gaslamp-reply preserves the session id", async () => {
  const r = await rpc.request("tools/call", {
    name: "gaslamp-reply",
    arguments: { sessionId: "sess-123", prompt: "again" },
  });
  assert.equal(r.result.structuredContent.sessionId, "sess-123");
  assert.match(r.result.structuredContent.content, /stub ok: again/);
});

test("omitted sandbox passes no permission flag (defers to the user's config)", async () => {
  const r = await rpc.request("tools/call", { name: "gaslamp", arguments: { prompt: "p" } });
  const c = r.result.structuredContent.content;
  assert.doesNotMatch(c, /--dangerously-skip-permissions/);
  assert.doesNotMatch(c, /--permission-mode/);
});

test("read-only override forces --permission-mode default + allowlist", async () => {
  const r = await rpc.request("tools/call", { name: "gaslamp", arguments: { prompt: "p", sandbox: "read-only" } });
  const c = r.result.structuredContent.content;
  assert.match(c, /--permission-mode/);
  assert.match(c, /--allowedTools/);
  assert.doesNotMatch(c, /--dangerously-skip-permissions/);
});

test("danger-full-access override forces --dangerously-skip-permissions", async () => {
  const r = await rpc.request("tools/call", { name: "gaslamp", arguments: { prompt: "p", sandbox: "danger-full-access" } });
  assert.match(r.result.structuredContent.content, /--dangerously-skip-permissions/);
});

test("unknown sandbox value falls back to the user's config (no flag)", async () => {
  const r = await rpc.request("tools/call", { name: "gaslamp", arguments: { prompt: "p", sandbox: "workspace-write" } });
  const c = r.result.structuredContent.content;
  assert.doesNotMatch(c, /--dangerously-skip-permissions/);
  assert.doesNotMatch(c, /--permission-mode/);
});

test("missing required arg is a JSON-RPC error", async () => {
  const r = await rpc.request("tools/call", { name: "gaslamp", arguments: {} });
  assert.ok(r.error, "expected an error for missing prompt");
});

test("CLI: --version prints package version", () => {
  const r = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), PKG.version);
  assert.equal(r.status, 0);
});

test("CLI: --help exits 0 and mentions setup", () => {
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gaslamp setup/);
});
