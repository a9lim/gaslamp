// CLI tests: drive `gaslamp claude` / `gaslamp codex` end-to-end against STUB
// backend binaries, so consults, job records, locks, guards, and signal
// handling are exercised deterministically with no real agent in the loop.
//
// Run: node --test tests/*.test.mjs   (or: npm test)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "gaslamp.mjs");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// Mimics `claude -p --output-format stream-json --verbose` with the prompt on
// stdin: an init event (session id, early), then a result event.
const CLAUDE_STUB = `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code stub)"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => setTimeout(() => {
  const argv = process.argv.slice(2);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "cl-sess-1" }) + "\\n");
  const text = "stub claude: " + prompt + " || argv: " + JSON.stringify(argv) +
    " || key=" + ("ANTHROPIC_API_KEY" in process.env) + " || nested=" + (process.env.GASLAMP_NESTED || "");
  // --json-schema flips the result to structured output (unless STUB_BAD_JSON
  // simulates a backend that failed to honor the schema).
  const result = argv.includes("--json-schema") && !process.env.STUB_BAD_JSON
    ? { type: "result", result: JSON.stringify({ ok: true, who: "claude" }),
        structured_output: { ok: true, who: "claude" }, session_id: "cl-sess-1", is_error: false }
    : { type: "result", result: text, session_id: "cl-sess-1", is_error: false };
  result.usage = { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 200 };
  result.total_cost_usd = 0.07;
  process.stdout.write(JSON.stringify(result) + "\\n");
}, Number(process.env.STUB_DELAY_MS || 0)));
`;

// Mimics `codex exec [resume <id>] --json -o <file> … -`: a thread.started
// event (id channel), an agent_message item, and the final text via -o.
const CODEX_STUB = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => setTimeout(() => {
  // Simulate a backend that dies before reporting anything (fleet-resume tests).
  if (process.env.STUB_FAIL_SUBSTR && prompt.includes(process.env.STUB_FAIL_SUBSTR)) process.exit(1);
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("-o") + 1];
  const tid = argv[1] === "resume" ? argv[2] : "cx-thread-1";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: tid }) + "\\n");
  if (prompt.includes("search"))
    process.stdout.write(JSON.stringify({ type: "item.started", item: { id: "ws", type: "web_search", query: "q" } }) + "\\n");
  // Consume the <gaslamp_consult> preamble block the way a real backend would,
  // reporting it as a marker so tests can assert its presence/absence.
  const pre = prompt.startsWith("<gaslamp_consult>\\n");
  if (pre) prompt = prompt.replace(/^<gaslamp_consult>\\n[\\s\\S]*?\\n<\\/gaslamp_consult>\\n\\n/, "");
  const text = "stub codex: " + prompt + " || argv: " + JSON.stringify(argv) +
    " || nested=" + (process.env.GASLAMP_NESTED || "") + " || preamble=" + pre;
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 20 } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
  // --output-schema flips the -o reply to structured JSON (unless STUB_BAD_JSON).
  writeFileSync(out, argv.includes("--output-schema") && !process.env.STUB_BAD_JSON
    ? JSON.stringify({ ok: true, who: "codex" }) : text);
}, Number(process.env.STUB_DELAY_MS || 0)));
`;

// Mimics `agy --input-format stream-json --output-format stream-json …` (1.4.3):
// one {"event":"user"} line on stdin; init (conversation id, model,
// permission_mode, tools), step updates, a result. `agy models` lists one slug
// per effort level. STUB_AUTH_HANG reproduces print mode without a sign-in:
// a URL on stdout, then waiting forever.
const AGY_STUB = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("9.9.9"); process.exit(0); }
if (argv[0] === "models") {
  if (process.env.STUB_MODELS_FAIL) { console.error("network down"); process.exit(1); }
  console.log("Fetching available models...");
  for (const m of ["gemini-4-argon-medium", "gemini-4-argon-high", "gemini-3.8-argon-low",
    "gemini-3.8-flash-medium", "claude-opus-5-5-high"]) console.log(m + "\\tStub " + m);
  process.exit(0);
}
if (process.env.STUB_STUBBORN_CHILD) {
  // a descendant that ignores SIGTERM and closes the pipes it inherited
  const { spawn } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const c = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.STUB_STUBBORN_CHILD, String(c.pid));
}
if (process.env.STUB_AUTH_HANG === "unterminated") {
  // a prompt that never ends its line
  process.stdout.write("Authentication required. Paste the code: ");
  setInterval(() => {}, 1000);
} else if (process.env.STUB_AUTH_HANG) {
  // the sign-in notice, split mid-word across writes the way a pipe may deliver it
  process.stdout.write("Authentication requ");
  setTimeout(() => process.stdout.write("ired. Please visit the URL to log in:\\n  https://accounts.google.com/o/oauth2/auth?stub\\n"), 150);
  setInterval(() => {}, 1000);
} else {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => setTimeout(() => {
    let content = JSON.parse(input.trim().split("\\n")[0]).message.content;
    const pre = content.startsWith("<gaslamp_consult>\\n");
    if (pre) content = content.replace(/^<gaslamp_consult>\\n[\\s\\S]*?\\n<\\/gaslamp_consult>\\n\\n/, "");
    const at = (f) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : null;
    const cid = at("--conversation") ?? "gm-conv-1";
    const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    const mode = process.env.STUB_PERMISSION_MODE
      || (argv.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review");
    if (!process.env.STUB_NO_INIT)
      emit({ event: "init", conversation_id: cid, init: { model: at("--model"), cwd: process.cwd(), permission_mode: mode,
        tools: ["view_file", "search_web", "read_url_content", "browser_click_element", "browser_scroll"] } });
    if (content.includes("search"))
      emit({ event: "step_update", step_update: { conversation_id: cid, step_index: 1, state: "DONE", step_type: "tool",
        tool_name: "search_web", tool_info: { name: "search_web", parameters: { query: "q" } } } });
    emit({ event: "step_update", step_update: { conversation_id: cid, step_index: 2, state: "DONE", step_type: "agent_response",
      usage: { input_tokens: 700, output_tokens: 30, thinking_tokens: 5, cache_read_tokens: 100, total_tokens: 730 } } });
    if (process.env.STUB_EMPTY) process.stderr.write("jetski: no output produced — a tool required the write_file permission\\n");
    const result = { conversation_id: cid, status: "SUCCESS", num_turns: 1,
      // cumulative over the conversation: gaslamp must not take this as the job's usage
      usage: { input_tokens: 99999, output_tokens: 9999 },
      response: process.env.STUB_EMPTY ? "" : "stub gemini: " + content + " || argv: " + JSON.stringify(argv) +
        " || preamble=" + pre + " || nested=" + (process.env.GASLAMP_NESTED || "") +
        " || claudeSid=" + ("CLAUDE_CODE_SESSION_ID" in process.env) };
    if (argv.includes("--json-schema") && !process.env.STUB_BAD_JSON) {
      result.response = JSON.stringify({ ok: true, who: "gemini" });
      result.structured_output = { ok: true, who: "gemini" };
    }
    emit({ event: "result", result });
  }, Number(process.env.STUB_DELAY_MS || 0)));
}
`;

// Mimics `grok --prompt-file /dev/stdin --output-format streaming-messages-json …`
// (1.0.62): Anthropic stream-json shape — system init (session id, model,
// permissionMode, tools), assistant messages, a result carrying modelUsage
// (the billed model) — and the session's system_prompt.txt on disk.
const GROK_STUB = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("grok 9.9.9 (stub) [stable]"); process.exit(0); }
const at = (f) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : null;
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => setTimeout(() => {
  const sid = at("--resume") ?? "gk-sess-1";
  const dir = join(process.env.GROK_HOME, "sessions", encodeURIComponent(process.cwd()), sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "system_prompt.txt"), "stub system prompt" + (at("--rules") ? "\\n" + at("--rules") : ""));
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  emit({ type: "system", subtype: "init", session_id: sid, model: at("-m") ?? "grok-4.7",
    permissionMode: at("--permission-mode") ?? (argv.includes("--always-approve") ? "bypassPermissions" : "default"),
    tools: ["read_file", "web_search", "web_fetch", "run_terminal_command"], mcp_servers: [] });
  if (prompt.includes("search"))
    emit({ type: "assistant", session_id: sid, message: { content: [{ type: "tool_use", name: "web_search", input: { query: "q" } }] } });
  const flags = ["GROK_CLAUDE_AGENTS_ENABLED", "GROK_CLAUDE_HOOKS_ENABLED", "GROK_CURSOR_MCPS_ENABLED"]
    .map((k) => k + "=" + process.env[k]).join(",");
  const result = { type: "result", subtype: "success", is_error: false, session_id: sid,
    result: process.env.STUB_EMPTY ? "" : "stub grok: " + prompt + " || argv: " + JSON.stringify(argv) +
      " || env: " + flags + " || claudeSid=" + ("CLAUDE_CODE_SESSION_ID" in process.env) +
      " || nested=" + (process.env.GASLAMP_NESTED || ""),
    usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 },
    modelUsage: { "grok-4.7-build": { inputTokens: 100, outputTokens: 50 } }, total_cost_usd: 0.04 };
  if (argv.includes("--json-schema") && !process.env.STUB_BAD_JSON) {
    result.result = process.env.STUB_STRUCTURED_ONLY ? "" : JSON.stringify({ ok: true, who: "grok" });
    result.structured_output = { ok: true, who: "grok" };
  }
  emit(result);
}, Number(process.env.STUB_DELAY_MS || 0)));
`;

// Codex's own live model catalog, as tier resolution reads it.
const CODEX_MODELS = { models: [
  { slug: "gpt-6.1-sol", visibility: "list" }, { slug: "gpt-6-sol", visibility: "list" },
  { slug: "gpt-6-astra", visibility: "list" }, { slug: "gpt-6-luna", visibility: "list" },
  { slug: "gpt-7-luna", visibility: "hide" }, { slug: "gpt-5.6-luna", visibility: "list" },
] };

let dir, home, claudeStub, codexStub, agyStub, grokStub;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gaslamp-test-"));
  home = join(dir, "gaslamp-home");
  claudeStub = join(dir, "claude-stub.mjs");
  codexStub = join(dir, "codex-stub.mjs");
  agyStub = join(dir, "agy-stub.mjs");
  grokStub = join(dir, "grok-stub.mjs");
  writeFileSync(claudeStub, CLAUDE_STUB);
  writeFileSync(codexStub, CODEX_STUB);
  writeFileSync(agyStub, AGY_STUB);
  writeFileSync(grokStub, GROK_STUB);
  for (const s of [claudeStub, codexStub, agyStub, grokStub]) chmodSync(s, 0o755);
  mkdirSync(join(dir, "codex-home"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "codex-home", "models_cache.json"), JSON.stringify(CODEX_MODELS));
});

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// Scrubbed env: an outer consult's sentinel (or a real API key, or a sandbox
// marker) must not leak into the suite — the design spar hit exactly this.
function env(extra = {}) {
  const e = { ...process.env };
  for (const k of ["GASLAMP_NESTED", "GASLAMP_ALLOW_RECURSION", "GASLAMP_FLEET", "CODEX_SANDBOX_NETWORK_DISABLED",
    "GASLAMP_DEBUG", "GASLAMP_ALLOWED_TOOLS", "ANTHROPIC_API_KEY", "STUB_DELAY_MS", "STUB_BAD_JSON",
    "STUB_FAIL_SUBSTR", "STUB_EMPTY", "STUB_AUTH_HANG", "STUB_PERMISSION_MODE", "CLAUDE_CODE_SESSION_ID",
    "STUB_NO_INIT", "STUB_MODELS_FAIL", "STUB_STUBBORN_CHILD", "STUB_STRUCTURED_ONLY"]) delete e[k];
  return { ...e, CLAUDE_BIN: claudeStub, CODEX_BIN: codexStub, AGY_BIN: agyStub, GROK_BIN: grokStub,
    GASLAMP_HOME: home, GROK_HOME: join(dir, "grok-home"), CODEX_HOME: join(dir, "codex-home"),
    HOME: join(dir, "home"), ...extra };
}

const run = (args, opts = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts, env: env(opts.env) });

const jobIdFrom = (out) => out.match(/job: ((?:cl|cx|gm|gk)-\d{8}-\d{6}-[0-9a-f]{4})/)?.[1];
const meta = (id) => JSON.parse(readFileSync(join(home, "jobs", id, "meta.json"), "utf8"));
const fleetIdFrom = (s) => s.match(/fleet (fl-\d{8}-\d{6}-[0-9a-f]{4})/)?.[1];

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

// ---- round trips -------------------------------------------------------------

test("claude consult round-trips: reply, trailer, durable record", () => {
  const r = run(["claude", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stub claude: hello/);
  assert.match(r.stdout, /\[gaslamp\] job: cl-.* · session: cl-sess-1 · resume: gaslamp claude --resume cl-sess-1/);
  const id = jobIdFrom(r.stdout);
  const m = meta(id);
  assert.equal(m.status, "done");
  assert.equal(m.sessionId, "cl-sess-1");
  assert.equal(readFileSync(join(home, "jobs", id, "prompt.md"), "utf8"), "hello");
  assert.match(readFileSync(join(home, "jobs", id, "reply.md"), "utf8"), /stub claude: hello/);
  assert.ok(existsSync(join(home, "jobs", id, "events.jsonl")));
});

test("codex consult round-trips: reply from -o, session from thread.started", () => {
  const r = run(["codex", "hi codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stub codex: hi codex/);
  assert.match(r.stdout, /session: cx-thread-1 · resume: gaslamp codex --resume cx-thread-1/);
  const m = meta(jobIdFrom(r.stdout));
  assert.equal(m.status, "done");
  assert.equal(m.sessionId, "cx-thread-1");
});

test("prompt via stdin (`-`)", () => {
  const r = run(["claude", "-"], { input: "piped prompt" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stub claude: piped prompt/);
});

test("--json emits a machine envelope on a clean stdout", () => {
  const r = run(["codex", "--json", "q"]);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.backend, "codex");
  assert.equal(j.sessionId, "cx-thread-1");
  assert.equal(j.status, "done");
  assert.match(j.content, /stub codex: q/);
  assert.match(j.jobId, /^cx-/);
});

// ---- backend argv contracts ----------------------------------------------------

test("claude spawn: stream-json + verbose, sentinel set, API key stripped", () => {
  const r = run(["claude", "p"], { env: { ANTHROPIC_API_KEY: "stale-key" } });
  assert.match(r.stdout, /"--output-format","stream-json"/);
  assert.match(r.stdout, /"--verbose"/);
  assert.match(r.stdout, /key=false/);   // ANTHROPIC_API_KEY stripped → keychain OAuth
  assert.match(r.stdout, /nested=1/);    // child carries the one-hop sentinel
});

test("codex spawn: exec --json -o, stdin prompt, env-policy leaf forced", () => {
  const r = run(["codex", "p"]);
  assert.match(r.stdout, /"exec","--json","-o"/);
  assert.match(r.stdout, /"--skip-git-repo-check"/);
  // the dotted leaf MERGES into [shell_environment_policy.set] (codex 0.139)
  assert.match(r.stdout, /shell_environment_policy\.set\.GASLAMP_NESTED=\\"1\\"/);
  assert.match(r.stdout, /nested=1/);
  assert.match(r.stdout, /"-"\]/);       // prompt always on stdin
});

test("model flag maps per backend", () => {
  const rc = run(["claude", "--model", "opus", "p"]);
  assert.match(rc.stdout, /"--model","opus"/);
  const rx = run(["codex", "--model", "gpt-5.5", "p"]);
  assert.match(rx.stdout, /"-m","gpt-5.5"/);
});

test("effort flag maps per backend", () => {
  const rc = run(["claude", "--effort", "high", "p"]);
  assert.match(rc.stdout, /"--effort","high"/);
  const rx = run(["codex", "--effort", "high", "p"]);
  assert.match(rx.stdout, /model_reasoning_effort=\\"high\\"/);
});

test("--label lands in meta, envelope, and the jobs listing", () => {
  const r = run(["codex", "--label", "spike-check", "--json", "p"]);
  const j = JSON.parse(r.stdout);
  assert.equal(j.label, "spike-check");
  assert.equal(meta(j.jobId).label, "spike-check");
  assert.match(run(["jobs"]).stdout, /\[spike-check\] p/);
});

// ---- sandbox mapping -----------------------------------------------------------

test("claude --sandbox read-only forces permission-mode default + allowlist", () => {
  const r = run(["claude", "--sandbox", "read-only", "p"]);
  assert.match(r.stdout, /"--permission-mode","default"/);
  assert.match(r.stdout, /"--allowedTools"/);
  assert.doesNotMatch(r.stdout, /--dangerously-skip-permissions/);
});

test("read-only default allowlist keeps Bash(git diff:*) intact (comma parsing)", () => {
  const r = run(["claude", "--sandbox", "read-only", "p"]);
  assert.match(r.stdout, /Read,Grep,Glob,WebFetch,WebSearch,Bash\(git diff:\*\),Bash\(git log:\*\)/);
});

test("GASLAMP_ALLOWED_TOOLS: comma lists keep parens; legacy space lists still work", () => {
  const commas = run(["claude", "--sandbox", "read-only", "p"],
    { env: { GASLAMP_ALLOWED_TOOLS: "Read, Bash(git log:*)" } });
  assert.match(commas.stdout, /"--allowedTools","Read,Bash\(git log:\*\)"/);
  const spaces = run(["claude", "--sandbox", "read-only", "p"],
    { env: { GASLAMP_ALLOWED_TOOLS: "Read Grep" } });
  assert.match(spaces.stdout, /"--allowedTools","Read,Grep"/);
});

test("claude --sandbox danger-full-access forces skip-permissions", () => {
  const r = run(["claude", "--sandbox", "danger-full-access", "p"]);
  assert.match(r.stdout, /"--dangerously-skip-permissions"/);
});

test("claude --sandbox workspace-write is an honest usage error", () => {
  const r = run(["claude", "--sandbox", "workspace-write", "p"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no filesystem sandbox/);
});

test("codex --sandbox goes through -c sandbox_mode (works on resume too)", () => {
  const r = run(["codex", "--sandbox", "read-only", "p"]);
  assert.match(r.stdout, /sandbox_mode=\\"read-only\\"/);
});

test("omitted sandbox defers to the consulted agent's own config", () => {
  const r = run(["claude", "p"]);
  assert.doesNotMatch(r.stdout, /--permission-mode/);
  assert.doesNotMatch(r.stdout, /--dangerously-skip-permissions/);
});

// ---- guards ----------------------------------------------------------------------

test("nested guard: a consulted agent's consult refuses (one hop), no record", () => {
  const beforeCount = readdirSync(join(home, "jobs")).length;
  const r = run(["codex", "p"], { env: { GASLAMP_NESTED: "1" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /one hop/);
  assert.equal(readdirSync(join(home, "jobs")).length, beforeCount);
});

test("GASLAMP_ALLOW_RECURSION restores nesting", () => {
  const r = run(["claude", "p"], { env: { GASLAMP_NESTED: "1", GASLAMP_ALLOW_RECURSION: "1" } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stub claude: p/);
});

test("network-disabled sandbox refuses both backends pointedly", () => {
  for (const backend of ["claude", "codex"]) {
    const r = run([backend, "p"], { env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" } });
    assert.equal(r.status, 4, backend);
    assert.match(r.stderr, /network is disabled/);
  }
});

// ---- resume + locks ----------------------------------------------------------------

test("resume by session id reaches the backend", () => {
  const rc = run(["claude", "--resume", "sess-abc", "p"]);
  assert.match(rc.stdout, /"--resume","sess-abc"/);
  const rx = run(["codex", "--resume", "thread-abc", "p"]);
  assert.match(rx.stdout, /"exec","resume","thread-abc"/);
});

test("resume by job id resolves to that job's session", () => {
  const first = run(["claude", "first"]);
  const id = jobIdFrom(first.stdout);
  const second = run(["claude", "--resume", id, "again"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"--resume","cl-sess-1"/);
});

test("resume by job id refuses a backend mismatch", () => {
  const first = run(["claude", "first"]);
  const id = jobIdFrom(first.stdout);
  const r = run(["codex", "--resume", id, "again"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /was a claude consult/);
});

test("same-session consults are serialized: busy lock refuses, kill releases", async () => {
  const slow = spawn(process.execPath, [BIN, "claude", "--resume", "sess-slow", "p"],
    { env: env({ STUB_DELAY_MS: "4000" }) });
  slow.stdin.end(); // piped-but-open stdin would block the evidence read (cat-like)
  let serr = "";
  slow.stderr.on("data", (d) => (serr += d));
  const lock = join(home, "locks", "claude--sess-slow");
  await until(() => existsSync(lock));

  const busy = run(["claude", "--resume", "sess-slow", "p2"]);
  assert.equal(busy.status, 5);
  assert.match(busy.stderr, /busy/);

  slow.kill("SIGTERM");
  const code = await new Promise((r) => slow.on("close", r));
  assert.equal(code, 1);
  const id = serr.match(/job (cl-\d{8}-\d{6}-[0-9a-f]{4})/)?.[1];
  assert.ok(id, "breadcrumb carries the job id: " + serr);
  const m = meta(id);
  assert.equal(m.status, "killed");
  assert.equal(m.signal, "SIGTERM");
  assert.ok(!existsSync(lock), "lock released on kill");
  // the child group died with us — no orphans burning quota
  assert.throws(() => process.kill(m.childPid, 0), /ESRCH/);
});

test("a stale lock (dead holder) is reaped, not fatal", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]); // a pid that just exited
  mkdirSync(join(home, "locks"), { recursive: true });
  writeFileSync(join(home, "locks", "claude--sess-stale"),
    JSON.stringify({ pid: dead.pid, job: "cl-00000000-000000-dead" }) + "\n");
  const r = run(["claude", "--resume", "sess-stale", "p"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(home, "locks", "claude--sess-stale")));
});

// ---- threads ---------------------------------------------------------------------------

test("--thread binds fresh, then resumes by name, chasing the session id", () => {
  const first = run(["claude", "--thread", "spar-x", "open question"]);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /"--resume"/); // unbound name → fresh session
  assert.match(first.stdout, /thread: spar-x/);
  assert.match(first.stdout, /resume: gaslamp claude --thread spar-x/);
  const t = JSON.parse(readFileSync(join(home, "threads", "claude--spar-x.json"), "utf8"));
  assert.equal(t.sessionId, "cl-sess-1");
  assert.equal(t.lastJobId, jobIdFrom(first.stdout));

  const second = run(["claude", "--thread", "spar-x", "follow-up"]);
  assert.match(second.stdout, /"--resume","cl-sess-1"/); // bound name → resume
  assert.equal(meta(jobIdFrom(second.stdout)).thread, "spar-x");
});

test("threads verb lists bound threads; codex threads bind too", () => {
  const r = run(["codex", "--thread", "cx-spar", "p"]);
  assert.equal(r.status, 0, r.stderr);
  const list = run(["threads"]);
  assert.match(list.stdout, /cx-spar\s+codex\s+cx-threa/);
  assert.match(list.stdout, /spar-x\s+claude/);
});

test("--thread usage errors: with --resume, and bad names", () => {
  const both = run(["claude", "--thread", "x", "--resume", "sid", "p"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /exclusive/);
  assert.equal(run(["claude", "--thread", "no spaces", "p"]).status, 2);
  assert.equal(run(["claude", "--thread", "-leadingdash", "p"]).status, 2);
});

test("fleet: manifest thread reaches the child; duplicate threads are refused", () => {
  const dup = run(["fleet", "codex", "-"], { input: '{"prompt":"a","thread":"fl-th"}\n{"prompt":"b","thread":"fl-th"}\n' });
  assert.equal(dup.status, 2);
  assert.match(dup.stderr, /same thread/);
  const ok = run(["fleet", "codex", "-"], { input: '{"prompt":"a","thread":"fl-th"}\n' });
  assert.equal(ok.status, 0, ok.stderr);
  // --thread is consumed by the child gaslamp (not the backend argv): its
  // observable effect is the binding it leaves behind
  const t = JSON.parse(readFileSync(join(home, "threads", "codex--fl-th.json"), "utf8"));
  assert.equal(t.sessionId, "cx-thread-1");
});

test("fleet: a bound thread collides with a direct resume of its session", () => {
  run(["codex", "--thread", "bound-th", "p"]); // binds bound-th → cx-thread-1
  const r = run(["fleet", "codex", "-"], { input: '{"prompt":"a","thread":"bound-th"}\n{"prompt":"b","resume":"cx-thread-1"}\n' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /same session/);
});

// ---- tail ------------------------------------------------------------------------------

test("tail renders both backends' events uniformly and exits with the job's status", () => {
  const cl = run(["claude", "tail me"]);
  const clTail = run(["tail", jobIdFrom(cl.stdout)]);
  assert.equal(clTail.status, 0, clTail.stderr);
  assert.match(clTail.stdout, /init · session cl-sess-/);
  assert.match(clTail.stdout, /result · ok · \$0\.07/);
  assert.match(clTail.stdout, /\[gaslamp\] job: cl-/);

  const cx = run(["codex", "tail me too"]);
  const cxTail = run(["tail", jobIdFrom(cx.stdout)]);
  assert.equal(cxTail.status, 0, cxTail.stderr);
  assert.match(cxTail.stdout, /init · thread cx-threa/);
  assert.match(cxTail.stdout, /turn done · tok 50→20/);
  assert.match(cxTail.stdout, /text · stub codex: tail me too/);
});

test("tail follows a running consult to completion", async () => {
  const slow = spawn(process.execPath, [BIN, "claude", "tail follow"],
    { env: env({ STUB_DELAY_MS: "1500" }) });
  slow.stdin.end();
  let serr = "";
  slow.stderr.on("data", (d) => (serr += d));
  await until(() => /job cl-/.test(serr));
  const id = serr.match(/job (cl-\d{8}-\d{6}-[0-9a-f]{4})/)[1];
  const tailed = run(["tail", id], { timeout: 10000 }); // blocks until the job ends
  assert.equal(tailed.status, 0, tailed.stderr);
  assert.match(tailed.stdout, /result · ok/);
  await new Promise((r) => slow.on("close", r));
});

test("tail refuses fleets and unknown ids", () => {
  const r = run(["fleet", "codex", "-n", "1", "p"]);
  const fleetId = fleetIdFrom(r.stderr);
  assert.equal(run(["tail", fleetId]).status, 2);
  assert.equal(run(["tail", "cl-00000000-000000-dead"]).status, 2);
});

// ---- usage + machine readers -----------------------------------------------------------

test("usage lands in meta, envelope, and trailer (claude: with cost)", () => {
  const r = run(["claude", "--json", "p"]);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.usage, { inputTokens: 100, outputTokens: 200, costUsd: 0.07 });
  assert.deepEqual(meta(j.jobId).usage, j.usage);
  const text = run(["claude", "p"]);
  assert.match(text.stdout, /tok: 100→200 · \$0\.07/);
});

test("codex usage sums turn.completed events; cached_input_tokens is a subset, not added", () => {
  const j = JSON.parse(run(["codex", "--json", "p"]).stdout);
  assert.deepEqual(j.usage, { inputTokens: 50, outputTokens: 20, costUsd: null });
});

test("jobs --json lists machine-readable records", () => {
  const done = run(["claude", "--label", "json-jobs", "machine list me"]);
  const id = jobIdFrom(done.stdout);
  const list = JSON.parse(run(["jobs", "--json"]).stdout);
  const rec = list.find((r) => r.jobId === id);
  assert.equal(rec.status, "done");
  assert.equal(rec.label, "json-jobs");
  assert.equal(rec.backend, "claude");
  assert.match(rec.promptPreview, /machine list me/);
  assert.equal(rec.usage.outputTokens, 200);
});

test("poll --json emits the envelope shape, with data for schema jobs", () => {
  const done = run(["codex", "--schema", '{"type":"object"}', "--json", "p"]);
  const id = JSON.parse(done.stdout).jobId;
  const p = run(["poll", id, "--json"]);
  assert.equal(p.status, 0);
  const j = JSON.parse(p.stdout);
  assert.equal(j.jobId, id);
  assert.equal(j.status, "done");
  assert.deepEqual(j.data, { ok: true, who: "codex" });
});

test("poll <fleet-id> --json regroups children as a results array", () => {
  const r = run(["fleet", "claude", "-n", "2", "fleet json poll"]);
  const fleetId = fleetIdFrom(r.stderr);
  const p = run(["poll", fleetId, "--json"]);
  assert.equal(p.status, 0, p.stderr);
  const j = JSON.parse(p.stdout);
  assert.equal(j.counts.done, 2);
  assert.equal(j.results.length, 2);
  assert.match(j.results[0].content, /fleet json poll/);
});

// ---- jobs / poll ---------------------------------------------------------------------

test("jobs lists records; poll fetches one; poll exits 10 while running", async () => {
  const done = run(["claude", "a listed prompt"]);
  const id = jobIdFrom(done.stdout);

  const jobs = run(["jobs"]);
  assert.match(jobs.stdout, new RegExp(id));
  assert.match(jobs.stdout, /done/);
  assert.match(jobs.stdout, /a listed prompt/);

  const polled = run(["poll", id]);
  assert.equal(polled.status, 0);
  assert.match(polled.stdout, /stub claude: a listed prompt/);

  const slow = spawn(process.execPath, [BIN, "claude", "slow one"],
    { env: env({ STUB_DELAY_MS: "4000" }) });
  slow.stdin.end(); // piped-but-open stdin would block the evidence read (cat-like)
  let serr = "";
  slow.stderr.on("data", (d) => (serr += d));
  await until(() => /job cl-/.test(serr));
  const slowId = serr.match(/job (cl-\d{8}-\d{6}-[0-9a-f]{4})/)[1];
  await until(() => existsSync(join(home, "jobs", slowId, "meta.json")));
  const running = run(["poll", slowId]);
  assert.equal(running.status, 10);
  assert.match(running.stdout, /RUNNING/);
  slow.kill("SIGTERM");
  await new Promise((r) => slow.on("close", r));
});

// ---- usage + plumbing ------------------------------------------------------------------

test("usage errors: empty prompt, unknown flag, two prompts", () => {
  assert.equal(run(["claude"], { input: "" }).status, 2);
  assert.equal(run(["claude", "--bogus", "p"]).status, 2);
  assert.equal(run(["claude", "p1", "p2"]).status, 2);
});

test("--version prints the package version; --help shows consults + exit codes", () => {
  assert.equal(run(["--version"]).stdout.trim(), PKG.version);
  const h = run(["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /gaslamp claude/);
  assert.match(h.stdout, /gaslamp fleet/);
  assert.match(h.stdout, /session busy/);
});

// ---- evidence + preamble ---------------------------------------------------------------

test("prompt arg + piped stdin appends a <stdin> evidence block", () => {
  const r = run(["claude", "review this diff:"], { input: "DIFF CONTENT\n" });
  assert.equal(r.status, 0, r.stderr);
  const sent = readFileSync(join(home, "jobs", jobIdFrom(r.stdout), "prompt.md"), "utf8");
  assert.equal(sent, "review this diff:\n\n<stdin>\nDIFF CONTENT\n</stdin>");
});

test("empty piped stdin adds no evidence block", () => {
  const r = run(["claude", "solo prompt"], { input: "" });
  assert.equal(readFileSync(join(home, "jobs", jobIdFrom(r.stdout), "prompt.md"), "utf8"), "solo prompt");
});

test("preamble is on by default: claude via --append-system-prompt, codex in-prompt", () => {
  const rc = run(["claude", "p"]);
  assert.match(rc.stdout, /"--append-system-prompt"/);
  const rx = run(["codex", "hi codex"]);
  assert.match(rx.stdout, /preamble=true/);
  // prompt.md records the CALLER's content only — no preamble in the record
  assert.doesNotMatch(readFileSync(join(home, "jobs", jobIdFrom(rx.stdout), "prompt.md"), "utf8"), /gaslamp_consult/);
});

test("--raw drops the preamble on both backends", () => {
  assert.doesNotMatch(run(["claude", "--raw", "p"]).stdout, /--append-system-prompt/);
  assert.match(run(["codex", "--raw", "p"]).stdout, /preamble=false/);
});

// ---- schema ----------------------------------------------------------------------------

test("claude --schema plumbs to --json-schema; envelope carries parsed data", () => {
  const r = run(["claude", "--schema", '{"type":"object"}', "--json", "p"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.data, { ok: true, who: "claude" });
  assert.match(j.content, /"ok":\s*true/);
  // the schema text reached the backend, and the job dir records it
  const m = meta(j.jobId);
  assert.equal(m.schema, true);
  assert.equal(readFileSync(join(home, "jobs", j.jobId, "schema.json"), "utf8").trim(), '{"type":"object"}');
});

test("codex --schema materializes schema.json and passes --output-schema", () => {
  const r = run(["codex", "--schema", '{"type":"object"}', "--json", "p"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.data, { ok: true, who: "codex" });
  const schemaPath = join(home, "jobs", j.jobId, "schema.json");
  assert.ok(existsSync(schemaPath));
  // the argv the stub echoed carries the --output-schema path (in events.jsonl)
  const events = readFileSync(join(home, "jobs", j.jobId, "events.jsonl"), "utf8");
  assert.match(events, /--output-schema/);
});

test("--schema accepts a file path", () => {
  const schemaFile = join(dir, "verdict.schema.json");
  writeFileSync(schemaFile, '{"type":"object","required":["ok"]}');
  const r = run(["codex", "--schema", schemaFile, "--json", "p"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  const sent = JSON.parse(readFileSync(join(home, "jobs", j.jobId, "schema.json"), "utf8"));
  assert.deepEqual(sent.required, ["ok"]);
});

test("codex schemas are strictified for OpenAI strict mode; claude's go as written", () => {
  // verified live: codex 400s unless every object has additionalProperties:false
  // and required lists every property key, recursively
  const loose = '{"type":"object","properties":{"a":{"type":"string"},"nest":{"type":"object","properties":{"b":{"type":"number"}}}},"required":["a"]}';
  const rx = run(["codex", "--schema", loose, "--json", "p"]);
  const sent = JSON.parse(readFileSync(join(home, "jobs", JSON.parse(rx.stdout).jobId, "schema.json"), "utf8"));
  assert.equal(sent.additionalProperties, false);
  assert.deepEqual(sent.required, ["a", "nest"]);
  assert.equal(sent.properties.nest.additionalProperties, false);
  assert.deepEqual(sent.properties.nest.required, ["b"]);

  const rc = run(["claude", "--schema", loose, "--json", "p"]);
  const asWritten = JSON.parse(readFileSync(join(home, "jobs", JSON.parse(rc.stdout).jobId, "schema.json"), "utf8"));
  assert.equal(asWritten.additionalProperties, undefined);
  assert.deepEqual(asWritten.required, ["a"]);
});

test("a bad --schema is a usage error, not a mid-consult backend error", () => {
  assert.equal(run(["claude", "--schema", "{not json", "p"]).status, 2);
  assert.equal(run(["claude", "--schema", "/nope/missing.json", "p"]).status, 2);
});

test("a schema consult whose reply is not JSON is marked failed", () => {
  const r = run(["claude", "--schema", '{"type":"object"}', "--json", "p"], { env: { STUB_BAD_JSON: "1" } });
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, "failed");
  assert.equal(j.data, null);
  assert.match(r.stderr, /not valid JSON/);
});

test("no --schema, no data key (envelope contract unchanged)", () => {
  const j = JSON.parse(run(["codex", "--json", "q"]).stdout);
  assert.ok(!("data" in j));
});

// ---- fleet -----------------------------------------------------------------------------

test("fleet -n replicates a prompt across N consults, blocks, collects all", () => {
  const r = run(["fleet", "codex", "-n", "3", "review this"]);
  assert.equal(r.status, 0, r.stderr);
  // three distinct replies in manifest order, plus a done summary
  assert.equal((r.stdout.match(/stub codex: review this/g) || []).length, 3);
  assert.match(r.stdout, /\[task-1\] done/);
  assert.match(r.stdout, /\[task-3\] done/);
  assert.match(r.stdout, /3\/3 done/);
  // a fleet record grouping three real child job ids, all done
  const fleetId = fleetIdFrom(r.stderr);
  assert.match(fleetId, /^fl-/);
  const fm = JSON.parse(readFileSync(join(home, "jobs", fleetId, "meta.json"), "utf8"));
  assert.equal(fm.children.length, 3);
  assert.equal(fm.counts.done, 3);
  for (const c of fm.children) { assert.match(c.jobId, /^cx-/); assert.equal(meta(c.jobId).status, "done"); }
});

test("fleet --json emits a results array in manifest order", () => {
  const r = run(["fleet", "codex", "-n", "2", "--json", "q"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.backend, "codex");
  assert.equal(j.results.length, 2);
  assert.equal(j.counts.done, 2);
  assert.deepEqual(j.results.map((x) => x.index), [0, 1]);
  for (const x of j.results) { assert.equal(x.status, "done"); assert.match(x.content, /stub codex: q/); assert.match(x.jobId, /^cx-/); }
});

test("fleet reads a JSONL manifest on stdin; per-task fields override", () => {
  const r = run(["fleet", "codex", "-"], { input: '{"prompt":"task one","model":"gpt-x","label":"alpha"}\nbare task two\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[alpha\] done/);          // explicit label honored
  assert.match(r.stdout, /stub codex: task one/);
  assert.match(r.stdout, /"-m","gpt-x"/);            // per-task model reached that child
  assert.match(r.stdout, /\[task-2\] done/);         // default label for the bare line
  assert.match(r.stdout, /stub codex: bare task two/);
});

test("fleet defaults consults to read-only; --sandbox opts into writes", () => {
  const def = run(["fleet", "codex", "-n", "1", "p"]);
  assert.match(def.stdout, /sandbox_mode=\\?"read-only\\?"/);
  assert.match(def.stderr, /read-only by default/);
  const danger = run(["fleet", "codex", "-n", "1", "--sandbox", "danger-full-access", "p"]);
  assert.match(danger.stdout, /sandbox_mode=\\?"danger-full-access\\?"/);
  // claude fleet gets the read-only mapping too
  const cl = run(["fleet", "claude", "-n", "1", "p"]);
  assert.match(cl.stdout, /"--permission-mode","default"/);
});

test("fleet: prompt arg + piped stdin shares one evidence block across replicas", () => {
  const r = run(["fleet", "codex", "-n", "2", "find races:"], { input: "EVIDENCE\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/<stdin>\nEVIDENCE\n<\/stdin>/g) || []).length, 2);
});

test("fleet: per-task raw drops the preamble for that child only", () => {
  const r = run(["fleet", "codex", "-"], { input: '{"prompt":"a","raw":true,"label":"bare"}\n{"prompt":"b"}\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /preamble=false/);
  assert.match(r.stdout, /preamble=true/);
});

test("fleet: --effort reaches children; fleet labels land in child job records", () => {
  const r = run(["fleet", "codex", "-n", "1", "--effort", "low", "--json", "p"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.match(j.results[0].content, /model_reasoning_effort=\\"low\\"/);
  assert.equal(meta(j.results[0].jobId).label, "task-1");
});

test("fleet: per-task schema object reaches the child as --schema; data flows back", () => {
  const r = run(["fleet", "codex", "--json", "-"],
    { input: '{"prompt":"typed","schema":{"type":"object"},"label":"t"}\n{"prompt":"plain"}\n' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.results[0].data, { ok: true, who: "codex" });
  assert.ok(!("data" in j.results[1]));
});

test("fleet forbids duplicate resume targets (would deadlock on the lock)", () => {
  const r = run(["fleet", "codex", "-"], { input: '{"prompt":"a","resume":"sess-1"}\n{"prompt":"b","resume":"sess-1"}\n' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /same session/);
});

test("fleet forbids duplicate labels", () => {
  const r = run(["fleet", "codex", "-"], { input: '{"prompt":"a","label":"dup"}\n{"prompt":"b","label":"dup"}\n' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /duplicate task label/);
});

test("fleet honors the one-hop guard and a bad backend", () => {
  assert.equal(run(["fleet", "codex", "-n", "1", "p"], { env: { GASLAMP_NESTED: "1" } }).status, 3);
  assert.equal(run(["fleet", "bogus", "p"]).status, 2);
});

test("the early started receipt is gated on GASLAMP_FLEET (single consult stays clean)", () => {
  // without the flag, --json stdout is exactly the envelope (existing contract)
  assert.doesNotMatch(run(["codex", "--json", "p"]).stdout, /"type":"started"/);
  // with it, the child emits the receipt before the envelope, on its own line
  const r = run(["codex", "--json", "p"], { env: { GASLAMP_FLEET: "1" } });
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /"type":"started"/);
  assert.ok(JSON.parse(lines[0]).jobId.startsWith("cx-"));
  assert.equal(JSON.parse(lines.at(-1)).status, "done");
});

test("fleet --resume: done children replay, failed children rerun fresh", () => {
  const first = run(["fleet", "codex", "-"], {
    input: '{"prompt":"alpha task","label":"alpha"}\n{"prompt":"beta task","label":"beta"}\n',
    env: { STUB_FAIL_SUBSTR: "beta" },
  });
  assert.equal(first.status, 1);
  const oldId = fleetIdFrom(first.stderr);
  // the manifest now stores each task in full — that's what makes this possible
  const man = readFileSync(join(home, "jobs", oldId, "manifest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(man[1].prompt, "beta task");

  const second = run(["fleet", "--resume", oldId, "--json"]);
  assert.equal(second.status, 0, second.stderr);
  const j = JSON.parse(second.stdout);
  assert.equal(j.resumedFrom, oldId);
  assert.equal(j.counts.done, 2);
  assert.equal(j.results[0].replayed, true);
  assert.ok(!j.results[1].replayed);
  assert.match(j.results[1].content, /beta task/);
  // the replayed child kept its original job id
  const oldMeta = JSON.parse(readFileSync(join(home, "jobs", oldId, "meta.json"), "utf8"));
  assert.equal(j.results[0].jobId, oldMeta.children[0].jobId);
});

test("fleet --resume: a killed child with a session gets nudged, not rerun", () => {
  const first = run(["fleet", "codex", "-n", "1", "nudge me"]);
  const oldId = fleetIdFrom(first.stderr);
  const childId = JSON.parse(readFileSync(join(home, "jobs", oldId, "meta.json"), "utf8")).children[0].jobId;
  const cm = meta(childId); // fabricate a wrapper killed after session capture
  cm.status = "killed";
  writeFileSync(join(home, "jobs", childId, "meta.json"), JSON.stringify(cm));

  const second = run(["fleet", "--resume", oldId]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"exec","resume","cx-thread-1"/); // same session
  assert.match(second.stdout, /interrupted mid-flight/);        // the nudge, not the prompt
  assert.doesNotMatch(second.stdout, /nudge me/);
});

test("fleet --resume usage errors: bad id, extra prompt", () => {
  assert.equal(run(["fleet", "--resume", "not-a-fleet"]).status, 2);
  assert.equal(run(["fleet", "--resume", "fl-00000000-000000-dead"]).status, 2);
  const r = run(["fleet", "codex", "-n", "1", "p"]);
  const id = fleetIdFrom(r.stderr);
  assert.equal(run(["fleet", "--resume", id, "extra prompt"]).status, 2);
});

test("fleet --stream prints results as they complete; --json --stream is JSONL", () => {
  const human = run(["fleet", "codex", "-n", "2", "--stream", "streamed"]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal((human.stdout.match(/━━ \[task-/g) || []).length, 2);
  assert.match(human.stdout, /2\/2 done/);

  const jsonl = run(["fleet", "codex", "-n", "2", "--stream", "--json", "streamed"]);
  const lines = jsonl.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines.filter((l) => l.type === "result").length, 2);
  assert.equal(lines.at(-1).type, "fleet.done");
  assert.equal(lines.at(-1).counts.done, 2);
});

test("poll <fleet-id> regroups children, deriving status from their records", () => {
  const r = run(["fleet", "claude", "-n", "2", "grouped"]);
  const fleetId = fleetIdFrom(r.stderr);
  const p = run(["poll", fleetId]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal((p.stdout.match(/stub claude: grouped/g) || []).length, 2);
  assert.match(p.stdout, new RegExp(`${fleetId} · claude · 2/2 done`));
});

// ---- gemini (Antigravity CLI) and grok (Grok Build) ------------------------------

const replyOf = (out) => out.split("\n[gaslamp]")[0];

test("gemini consult round-trips over agy's streaming input, read-only, provenance recorded", () => {
  const r = run(["gemini", "hello gemini"]);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.match(id, /^gm-/);
  assert.match(r.stdout, /stub gemini: hello gemini/);
  // prompt rides stdin as one user event; the preamble is in-prompt, like codex
  assert.match(r.stdout, /preamble=true/);
  assert.match(r.stdout, /"--input-format","stream-json","--output-format","stream-json"/);
  // no --model given: the argon tier, resolved against `agy models` (newest version)
  assert.match(r.stdout, /"--model","gemini-4-argon"/);
  assert.doesNotMatch(r.stdout, /dangerously-skip-permissions/);
  assert.match(r.stdout, /session: gm-conv-1 · resume: gaslamp gemini --resume gm-conv-1 · model: gemini-4-argon/);
  const m = meta(id);
  assert.equal(m.status, "done");
  assert.equal(m.sandbox, "read-only");
  assert.equal(m.model, "gemini-4-argon");
  // usage is the sum of this job's steps, not the conversation-cumulative result
  // (agy's input_tokens excludes cache reads, so both count)
  assert.deepEqual(m.usage, { inputTokens: 800, outputTokens: 30, costUsd: null });
  const p = m.provenance;
  assert.equal(p.provider, "google");
  assert.equal(p.harness, "agy");
  assert.equal(p.harnessVersion, "9.9.9");
  assert.equal(p.model, "gemini-4-argon");
  assert.equal(p.modelRequested, null);
  assert.equal(p.permissionMode, "request-review");
  assert.deepEqual(p.systemPrompt, { known: false });
  assert.deepEqual(p.retrieval, { available: ["search_web", "read_url_content", "browser_*"], used: [] });
  assert.equal(p.gaslamp.version, PKG.version);
  assert.match(p.gaslamp.revision, /^([0-9a-f]{12}(\+dirty)?|unknown)$/);
});

test("grok consult round-trips: kernel read-only sandbox, preamble as --rules, billed model, system prompt hashed", () => {
  const r = run(["grok", "hello grok"]);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.match(id, /^gk-/);
  assert.match(r.stdout, /stub grok: hello grok/);
  assert.match(r.stdout, /"--prompt-file","\/dev\/stdin","--output-format","streaming-messages-json","--no-auto-update"/);
  assert.match(r.stdout, /"--rules","You are being consulted/);
  assert.match(r.stdout, /"--sandbox","read-only","--permission-mode","default"/);
  assert.match(r.stdout, /model: grok-4\.7 \(billed grok-4\.7-build\) · tok: 1\.0k→50 · \$0\.04/);
  const p = meta(id).provenance;
  assert.equal(p.provider, "xai");
  assert.equal(p.harnessVersion, "grok 9.9.9 (stub) [stable]");
  assert.deepEqual(p.billedModels, ["grok-4.7-build"]);
  assert.equal(p.permissionMode, "default");
  assert.equal(p.systemPrompt.known, true);
  assert.match(p.systemPrompt.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.retrieval, { available: ["web_search", "web_fetch"], used: [] });
});

test("gemini and grok spawns drop the caller's harness env; grok's vendor-compat imports are off", () => {
  const extra = { env: { CLAUDE_CODE_SESSION_ID: "the-callers-session" } };
  const g = run(["gemini", "p"], extra);
  assert.match(g.stdout, /claudeSid=false/);
  assert.match(g.stdout, /nested=1/);
  const k = run(["grok", "p"], extra);
  assert.match(k.stdout, /claudeSid=false/);
  assert.match(k.stdout, /env: GROK_CLAUDE_AGENTS_ENABLED=0,GROK_CLAUDE_HOOKS_ENABLED=0,GROK_CURSOR_MCPS_ENABLED=0/);
  // claude and codex consults are unchanged: the caller's env passes through
  assert.match(run(["claude", "p"], extra).stdout, /stub claude: p/);
});

test("--sandbox maps honestly for the newcomers", () => {
  const gw = run(["gemini", "--sandbox", "workspace-write", "p"]);
  assert.equal(gw.status, 2);
  assert.match(gw.stderr, /no honest workspace-write/);
  assert.match(run(["gemini", "--sandbox", "danger-full-access", "p"]).stdout, /"--dangerously-skip-permissions"/);
  assert.match(run(["grok", "--sandbox", "workspace-write", "p"]).stdout,
    /"--sandbox","workspace","--permission-mode","acceptEdits"/);
  assert.match(run(["grok", "--sandbox", "danger-full-access", "p"]).stdout, /"--sandbox","off","--always-approve"/);
});

test("a read-only gemini consult refuses a harness reporting a laxer permission mode", () => {
  const r = run(["gemini", "p"], { env: { STUB_PERMISSION_MODE: "always-proceed", STUB_DELAY_MS: "3000" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /permission mode "always-proceed", not request-review/);
  const m = meta(jobIdFrom(r.stdout));
  assert.equal(m.status, "failed");
  assert.match(m.refusal, /always-proceed/);
});

test("an empty reply is a failed consult on both newcomers, with the reason surfaced", () => {
  const g = run(["gemini", "p"], { env: { STUB_EMPTY: "1" } });
  assert.equal(g.status, 1);
  assert.match(g.stderr, /empty reply/);
  assert.match(g.stderr, /no output produced/);
  assert.equal(meta(jobIdFrom(g.stdout)).status, "failed");
  const k = run(["grok", "p"], { env: { STUB_EMPTY: "1" } });
  assert.equal(k.status, 1);
  assert.equal(meta(jobIdFrom(k.stdout)).status, "failed");
});

test("agy waiting on a sign-in is stopped, not left hanging", () => {
  const t0 = Date.now();
  const pidFile = join(dir, "stubborn.pid");
  const r = run(["gemini", "p"], { env: { STUB_AUTH_HANG: "1", STUB_STUBBORN_CHILD: pidFile } });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 8000, "refused promptly");
  // the whole group went down, including a descendant that ignored SIGTERM
  const stubborn = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(stubborn, 0), /ESRCH/);
  assert.match(r.stderr, /agy is not signed in/);
  assert.match(meta(jobIdFrom(r.stdout)).refusal, /not signed in/);
});

test("retrieval the consultee actually used lands in provenance", () => {
  const g = run(["gemini", "please search for it"]);
  assert.deepEqual(meta(jobIdFrom(g.stdout)).provenance.retrieval.used, ["search_web"]);
  const k = run(["grok", "please search for it"]);
  assert.deepEqual(meta(jobIdFrom(k.stdout)).provenance.retrieval.used, ["web_search"]);
});

test("tier words resolve against the harness's own catalog; exact ids and unknown words pass through", () => {
  assert.match(run(["codex", "--model", "sol", "p"]).stdout, /"-m","gpt-6\.1-sol"/);
  // a hidden newer slug is not a candidate
  const luna = run(["codex", "--model", "luna", "p"]);
  assert.match(luna.stdout, /"-m","gpt-6-luna"/);
  const p = meta(jobIdFrom(luna.stdout)).provenance;
  assert.equal(p.modelRequested, "luna");
  assert.equal(p.modelPassed, "gpt-6-luna");
  assert.match(run(["codex", "--model", "nova", "p"]).stdout, /"-m","nova"/);
  assert.match(run(["gemini", "--model", "flash", "p"]).stdout, /"--model","gemini-3\.8-flash"/);
  assert.match(run(["gemini", "--model", "gemini-3.8-argon", "p"]).stdout, /"--model","gemini-3\.8-argon"/);
  // claude resolves its own aliases
  assert.match(run(["claude", "--model", "sonnet", "p"]).stdout, /"--model","sonnet"/);
});

test("newcomer resume, effort, and --raw map to each harness's flags", () => {
  const g = run(["gemini", "--resume", "conv-9", "--effort", "high", "p"]);
  assert.match(g.stdout, /"--effort","high","--conversation","conv-9"/);
  assert.match(g.stdout, /session: conv-9/);
  const k = run(["grok", "--resume", "gk-sess-9", "--effort", "high", "--raw", "p"]);
  assert.match(k.stdout, /"--resume","gk-sess-9"/);
  assert.match(k.stdout, /"--effort","high"/);
  assert.doesNotMatch(k.stdout, /--rules/);
  assert.match(run(["gemini", "--raw", "p"]).stdout, /preamble=false/);
  // a grok job id resumes its session
  const first = run(["grok", "p"]);
  const again = run(["grok", "--resume", jobIdFrom(first.stdout), "p2"]);
  assert.match(again.stdout, /"--resume","gk-sess-1"/);
});

test("--schema reaches both newcomers natively; data flows back", () => {
  for (const b of ["gemini", "grok"]) {
    const r = run([b, "--json", "--schema", '{"type":"object","properties":{"ok":{"type":"boolean"}}}', "p"]);
    assert.equal(r.status, 0, r.stderr);
    const env = JSON.parse(r.stdout);
    assert.equal(env.backend, b);
    assert.deepEqual(env.data, { ok: true, who: b });
  }
});

test("fleets fan out over the newcomers; tail renders their events", () => {
  const f = run(["fleet", "gemini", "-n", "2", "--json", "name a color"]);
  assert.equal(f.status, 0, f.stderr);
  const j = JSON.parse(f.stdout);
  assert.equal(j.backend, "gemini");
  assert.equal(j.counts.done, 2);
  for (const x of j.results) { assert.match(x.jobId, /^gm-/); assert.match(x.content, /stub gemini: name a color/); }
  const g = run(["gemini", "please search"]);
  const tg = run(["tail", jobIdFrom(g.stdout)]);
  assert.match(tg.stdout, /init · conversation gm-conv- · gemini-4-argon/);
  assert.match(tg.stdout, /tool → search_web/);
  assert.match(tg.stdout, /result · SUCCESS/);
  const k = run(["grok", "please search"]);
  const tk = run(["tail", jobIdFrom(k.stdout)]);
  assert.match(tk.stdout, /init · session gk-sess- · grok-4\.7/);
  assert.match(tk.stdout, /tool → web_search/);
});

// ---- review findings (Codex, 2026-10-20) ------------------------------------

const agySettings = (obj) => {
  const d = join(dir, "home", ".gemini", "antigravity-cli");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "settings.json"), JSON.stringify(obj));
};

test("a read-only gemini consult refuses settings that would let it act unprompted", () => {
  try {
    agySettings({ permissions: { allow: ["command(git diff)", "mcp(end-conversation/*)", "read_file(/var/log)"] } });
    const ok = run(["gemini", "p"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(meta(jobIdFrom(ok.stdout)).provenance.grants,
      ["command(git diff)", "mcp(end-conversation/*)", "read_file(/var/log)"]);

    agySettings({ permissions: { allow: ["command(git diff)", "write_file(src/)"] } });
    const w = run(["gemini", "p"]);
    assert.equal(w.status, 1);
    assert.match(w.stderr, /write_file\(src\/\)/);
    assert.doesNotMatch(w.stdout, /stub gemini/, "never spawned");

    agySettings({ toolPermission: "always-proceed" });
    assert.match(run(["gemini", "p"]).stderr, /toolPermission "always-proceed"/);

    // the escape hatch is explicit
    assert.equal(run(["gemini", "--sandbox", "danger-full-access", "p"]).status, 0);
  } finally {
    agySettings({});
  }
});

test("a read-only gemini consult without a confirming init event fails", () => {
  const r = run(["gemini", "p"], { env: { STUB_NO_INIT: "1" } });
  assert.equal(r.status, 1);
  const m = meta(jobIdFrom(r.stdout));
  assert.equal(m.status, "failed");
  assert.match(m.refusal, /no init event/);
});

test("an unterminated sign-in prompt is caught too", () => {
  const t0 = Date.now();
  const r = run(["gemini", "p"], { env: { STUB_AUTH_HANG: "unterminated" } });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 8000, "refused promptly");
  assert.match(r.stderr, /agy is not signed in/);
});

test("grants in the app-shared and per-project permission files count too", () => {
  const cfg = join(dir, "home", ".gemini", "config");
  mkdirSync(join(cfg, "projects"), { recursive: true });
  try {
    writeFileSync(join(cfg, "config.json"), JSON.stringify({ userSettings: { permissions: { allow: ["command(npm test)"] } } }));
    assert.match(run(["gemini", "p"]).stderr, /command\(npm test\) \(.*config\.json\)/);
    writeFileSync(join(cfg, "config.json"), "{}");
    writeFileSync(join(cfg, "projects", "p1.json"), JSON.stringify({ id: "p1", permissions: { allow: ["unsandboxed(*)"] } }));
    assert.match(run(["gemini", "p"]).stderr, /unsandboxed\(\*\) \(.*p1\.json\)/);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("auth text inside a reply is content, not a sign-in prompt", () => {
  const r = run(["gemini", "explain Authentication required errors"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(meta(jobIdFrom(r.stdout)).status, "done");
});

test("a structured-only result is a deliverable", () => {
  const r = run(["grok", "--json", "--schema", '{"type":"object"}', "p"], { env: { STUB_STRUCTURED_ONLY: "1" } });
  assert.equal(r.status, 0, r.stderr);
  const envl = JSON.parse(r.stdout);
  assert.equal(envl.status, "done");
  assert.deepEqual(envl.data, { ok: true, who: "grok" });
  assert.equal(readFileSync(join(home, "jobs", envl.jobId, "reply.md"), "utf8"), '{"ok":true,"who":"grok"}');
});

test("codex web search lands in retrieval provenance", () => {
  const r = run(["codex", "please search for it"]);
  assert.deepEqual(meta(jobIdFrom(r.stdout)).provenance.retrieval.used, ["web_search"]);
});

test("a failed catalog lookup passes the tier word through for the harness to judge", () => {
  const r = run(["gemini", "p"], { env: { STUB_MODELS_FAIL: "1" } });
  assert.match(r.stdout, /"--model","argon"/);
  assert.equal(meta(jobIdFrom(r.stdout)).provenance.modelPassed, "argon");
});

test("a consult's record goes from running straight to its final state", async () => {
  const child = spawn(process.execPath, [BIN, "gemini", "p"], { env: env({ STUB_EMPTY: "1", STUB_DELAY_MS: "300" }) });
  child.stdin.end();
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  let closed = false;
  child.on("close", () => (closed = true));
  const seen = new Set();
  let id = null;
  while (!closed) {
    id ??= err.match(/job (gm-\d{8}-\d{6}-[0-9a-f]{4})/)?.[1];
    if (id) { try { seen.add(meta(id).status); } catch {} }
    await new Promise((r) => setTimeout(r, 5));
  }
  seen.add(meta(id).status);
  assert.deepEqual([...seen].filter((x) => x !== "running"), ["failed"]);
});
