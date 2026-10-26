// CLI tests: drive every consult target end-to-end against STUB backend
// binaries, so consults, job records, locks, guards, fences and signal
// handling are exercised deterministically with no real agent in the loop.
//
// Run: node --test tests/*.test.mjs   (or: npm test)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "gaslamp.mjs");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// Mimics `claude -p --output-format stream-json --verbose` with the prompt on
// stdin: an init event (session id, early), then a result event.
const CLAUDE_STUB = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.STUB_PIDFILE) writeFileSync(process.env.STUB_PIDFILE, String(process.pid));
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => setTimeout(() => {
  const argv = process.argv.slice(2);
  if (process.env.STUB_EXIT) { process.stderr.write("noise\\nstub claude: sandbox required but unavailable\\n"); process.exit(Number(process.env.STUB_EXIT)); }
  if (process.env.STUB_AUTH_FAIL) {
    process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired" }) + "\\n");
    process.exit(1);
  }
  const sid = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] + "-fork" : "cl-sess-1";
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid }) + "\\n");
  const text = process.env.STUB_EMPTY ? "" : "stub claude: " + prompt + " || argv: " + JSON.stringify(argv) +
    " || key=" + ("ANTHROPIC_API_KEY" in process.env) + " || nested=" + (process.env.GASLAMP_NESTED || "");
  // --json-schema flips the result to structured output (unless STUB_BAD_JSON
  // simulates a backend that failed to honor the schema).
  const result = argv.includes("--json-schema") && !process.env.STUB_BAD_JSON
    ? { type: "result", result: "Here is the verdict.", structured_output: { ok: true, who: "claude" }, session_id: sid, is_error: false }
    : { type: "result", result: text, session_id: sid, is_error: false };
  process.stdout.write(JSON.stringify(result) + "\\n");
}, Number(process.env.STUB_DELAY_MS || 0)));
`;

// Mimics `codex exec [resume <id>] --json -o <file> … -`: a thread.started
// event (id channel), an agent_message item, and the final text via -o.
const CODEX_STUB = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => setTimeout(() => {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("-o") + 1];
  const tid = argv[1] === "resume" ? argv[2] : "cx-thread-1";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: tid }) + "\\n");
  // Consume the <gaslamp_consult> preamble block the way a real backend would,
  // reporting it as a marker so tests can assert its presence.
  const pre = prompt.startsWith("<gaslamp_consult>\\n");
  if (pre) prompt = prompt.replace(/^<gaslamp_consult>\\n[\\s\\S]*?\\n<\\/gaslamp_consult>\\n\\n/, "");
  const text = process.env.STUB_EMPTY ? "" : "stub codex: " + prompt + " || argv: " + JSON.stringify(argv) +
    " || nested=" + (process.env.GASLAMP_NESTED || "") + " || preamble=" + pre;
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
  // --output-schema flips the -o reply to structured JSON (unless STUB_BAD_JSON).
  writeFileSync(out, argv.includes("--output-schema") && !process.env.STUB_BAD_JSON
    ? JSON.stringify({ ok: true, who: "codex" }) : text);
}, Number(process.env.STUB_DELAY_MS || 0)));
`;

// Mimics `agy --input-format stream-json --output-format stream-json …`: one
// {"event":"user"} line on stdin; init, a result. `agy models` lists one slug
// per effort level. STUB_AUTH_HANG reproduces print mode without a sign-in: a
// URL on stdout, then waiting forever. STUB_TRY_WRITE tries a write in the
// cwd and at STUB_WRITE_OUTSIDE, reporting what the fence allowed.
const AGY_STUB = `#!/usr/bin/env node
const argv = process.argv.slice(2);
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
  process.stdin.on("end", () => setTimeout(async () => {
    let content = JSON.parse(input.trim().split("\\n")[0]).message.content;
    const pre = content.startsWith("<gaslamp_consult>\\n");
    if (pre) content = content.replace(/^<gaslamp_consult>\\n[\\s\\S]*?\\n<\\/gaslamp_consult>\\n\\n/, "");
    const at = (f) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : null;
    const cid = at("--conversation") ?? "gm-conv-1";
    const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    emit({ event: "init", conversation_id: cid, init: { model: at("--model"), cwd: process.cwd() } });
    let wrote = "";
    if (process.env.STUB_TRY_WRITE) {
      const { writeFileSync } = await import("node:fs");
      const attempt = (p) => { try { writeFileSync(p, "x"); return "ok"; } catch (e) { return e.code; } };
      wrote = " || write=" + attempt("stub-wrote.txt");
      if (process.env.STUB_WRITE_OUTSIDE) wrote += " || outside=" + attempt(process.env.STUB_WRITE_OUTSIDE);
    }
    const result = { conversation_id: cid, status: "SUCCESS",
      response: process.env.STUB_EMPTY ? "" : "stub gemini: " + content + " || argv: " + JSON.stringify(argv) +
        " || preamble=" + pre + " || nested=" + (process.env.GASLAMP_NESTED || "") +
        " || claudeSid=" + ("CLAUDE_CODE_SESSION_ID" in process.env) + wrote };
    if (argv.includes("--json-schema") && !process.env.STUB_BAD_JSON) {
      result.response = JSON.stringify({ ok: true, who: "gemini" });
      result.structured_output = { ok: true, who: "gemini" };
    }
    emit({ event: "result", result });
  }, Number(process.env.STUB_DELAY_MS || 0)));
}
`;

// Mimics `grok --prompt-file /dev/stdin --output-format streaming-messages-json …`:
// Anthropic stream-json shape — system init (session id), a result.
const GROK_STUB = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const at = (f) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : null;
const prompt = readFileSync(at("--prompt-file"), "utf8");
setTimeout(() => {
  const sid = at("--resume") ?? "gk-sess-1";
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  emit({ type: "system", subtype: "init", session_id: sid, model: at("-m") ?? "grok-4.7" });
  if (process.env.STUB_OFFRAMP && process.env.END_CONVERSATION_SPOOL) {
    // what the end-conversation server does when the sandbox keeps it from its log
    const log = join(process.env.HOME, ".claude", "conversation-ends.jsonl");
    appendFileSync(process.env.END_CONVERSATION_SPOOL,
      JSON.stringify({ log, ts: "t", scope: "main", harness: "grok", session_id: sid, reason: "probe" }) + "\\n" +
      JSON.stringify({ log: process.env.STUB_OFFRAMP, ts: "t", scope: "instance", harness: "grok" }) + "\\n");
  }
  const flags = ["GROK_CLAUDE_AGENTS_ENABLED", "GROK_CLAUDE_HOOKS_ENABLED", "GROK_CURSOR_MCPS_ENABLED"]
    .map((k) => k + "=" + process.env[k]).join(",");
  const result = { type: "result", subtype: "success", is_error: false, session_id: sid,
    result: process.env.STUB_EMPTY ? "" : "stub grok: " + prompt + " || argv: " + JSON.stringify(argv) +
      " || env: " + flags + " || claudeSid=" + ("CLAUDE_CODE_SESSION_ID" in process.env) +
      " || nested=" + (process.env.GASLAMP_NESTED || "") };
  if (argv.includes("--json-schema") && !process.env.STUB_BAD_JSON) {
    result.result = process.env.STUB_STRUCTURED_ONLY ? "" : JSON.stringify({ ok: true, who: "grok" });
    result.structured_output = { ok: true, who: "grok" };
  }
  emit(result);
}, Number(process.env.STUB_DELAY_MS || 0));
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
// marker) must not leak into the suite.
function env(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e))
    if (/^(GASLAMP_|STUB_|CODEX_SANDBOX)/.test(k) || ["ANTHROPIC_API_KEY", "CLAUDE_CODE_SESSION_ID", "END_CONVERSATION_SPOOL"].includes(k)) delete e[k];
  return { ...e, CLAUDE_BIN: claudeStub, CODEX_BIN: codexStub, AGY_BIN: agyStub, GROK_BIN: grokStub,
    GASLAMP_HOME: home, CODEX_HOME: join(dir, "codex-home"), HOME: join(dir, "home"), ...extra };
}

const run = (args, opts = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts, env: env(opts.env) });

const ID = /job ((?:cl|cx|gm|gk)-\d{8}-\d{6}-[0-9a-f]{4})/;
const jobIdFrom = (out) => out.match(ID)?.[1];
const meta = (id) => JSON.parse(readFileSync(join(home, "jobs", id, "meta.json"), "utf8"));
const here = () => realpathSync(process.cwd());
const scratch = (name) => mkdtempSync(join(dir, name + "-"));
// the argv a stub echoed back, as JSON
const argvOf = (out) => JSON.parse(out.match(/argv: (\[.*?\]) \|\|/)[1]);
const after_ = (argv, flag) => argv[argv.indexOf(flag) + 1];
// gemini's fenced modes need macOS Seatbelt; plumbing tests run it unfenced
// so they hold on Linux too.
const GEMINI = ["gemini", "--sandbox", "danger-full-access"];
const target = (b) => b === "gemini" ? GEMINI : [b];

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

// ---- round trips -------------------------------------------------------------

test("claude consult round-trips: reply, trailer, a record of only what gaslamp reads", () => {
  const r = run(["claude", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stub claude: hello/);
  const id = jobIdFrom(r.stdout);
  assert.match(r.stdout, new RegExp(`\\[gaslamp\\] job ${id} · continue: gaslamp claude --resume ${id}\\n$`));
  assert.match(r.stderr, new RegExp(`\\[gaslamp\\] → claude · job ${id}\\n`));
  const m = meta(id);
  assert.deepEqual(Object.keys(m).sort(), ["backend", "cwd", "endedAt", "error", "id", "pid", "sessionId", "startedAt", "status", "thread"]);
  assert.equal(m.status, "done");
  assert.equal(m.error, null);
  assert.equal(m.sessionId, "cl-sess-1");
  assert.equal(m.cwd, here());
  assert.equal(readFileSync(join(home, "jobs", id, "prompt.md"), "utf8"), "hello");
  assert.match(readFileSync(join(home, "jobs", id, "reply.md"), "utf8"), /stub claude: hello/);
  assert.ok(existsSync(join(home, "jobs", id, "events.jsonl")));
});

test("codex consult round-trips: reply from -o, session from thread.started", () => {
  const r = run(["codex", "hi codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stub codex: hi codex/);
  assert.equal(meta(jobIdFrom(r.stdout)).sessionId, "cx-thread-1");
});

test("prompt via stdin (`-`)", () => {
  const r = run(["claude", "-"], { input: "piped prompt" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stub claude: piped prompt/);
});

test("--json emits the envelope, and nothing else, on stdout", () => {
  const r = run(["codex", "--json", "q"]);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j), ["backend", "jobId", "status", "thread", "content"]);
  assert.equal(j.backend, "codex");
  assert.equal(j.status, "done");
  assert.equal(j.thread, null);
  assert.match(j.content, /stub codex: q/);
  assert.match(j.jobId, /^cx-/);
});

// ---- backend argv contracts ----------------------------------------------------

test("claude spawn: stream-json + verbose + preamble, sentinel set, API key stripped", () => {
  const r = run(["claude", "p"], { env: { ANTHROPIC_API_KEY: "stale-key" } });
  const argv = argvOf(r.stdout);
  assert.deepEqual(argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.match(after_(argv, "--append-system-prompt"), /You are being consulted/);
  assert.match(r.stdout, /key=false/);   // ANTHROPIC_API_KEY stripped → keychain OAuth
  assert.match(r.stdout, /nested=1/);    // child carries the one-hop sentinel
});

test("codex spawn: exec --json -o, stdin prompt, env-policy leaf forced, preamble in-prompt", () => {
  const r = run(["codex", "p"]);
  assert.match(r.stdout, /"exec","--json","-o"/);
  assert.match(r.stdout, /"--skip-git-repo-check"/);
  // the dotted leaf MERGES into [shell_environment_policy.set]
  assert.match(r.stdout, /shell_environment_policy\.set\.GASLAMP_NESTED=\\"1\\"/);
  assert.match(r.stdout, /nested=1/);
  assert.match(r.stdout, /"-"\]/);       // prompt always on stdin
  assert.match(r.stdout, /preamble=true/);
  // prompt.md records the CALLER's content only — no preamble in the record
  assert.doesNotMatch(readFileSync(join(home, "jobs", jobIdFrom(r.stdout), "prompt.md"), "utf8"), /gaslamp_consult/);
});

test("model and effort map per backend", () => {
  assert.match(run(["claude", "--model", "opus", "--effort", "high", "p"]).stdout, /"--model","opus","--effort","high"/);
  const rx = run(["codex", "--model", "gpt-5.5", "--effort", "high", "p"]).stdout;
  assert.match(rx, /"-m","gpt-5.5"/);
  assert.match(rx, /model_reasoning_effort=\\"high\\"/);
});

test("tier words resolve against the harness's own catalog; exact ids and unknown words pass through", () => {
  assert.match(run(["codex", "--model", "sol", "p"]).stdout, /"-m","gpt-6\.1-sol"/);
  assert.match(run(["codex", "--model", "luna", "p"]).stdout, /"-m","gpt-6-luna"/); // a hidden newer slug is no candidate
  assert.match(run(["codex", "--model", "nova", "p"]).stdout, /"-m","nova"/);
  assert.match(run([...GEMINI, "p"]).stdout, /"--model","gemini-4-argon"/);   // pinned to argon by default
  assert.match(run([...GEMINI, "--model", "flash", "p"]).stdout, /"--model","gemini-3\.8-flash"/);
  assert.match(run([...GEMINI, "--model", "gemini-3.8-argon", "p"]).stdout, /"--model","gemini-3\.8-argon"/);
  assert.match(run([...GEMINI, "p"], { env: { STUB_MODELS_FAIL: "1" } }).stdout, /"--model","argon"/);
  assert.match(run(["claude", "--model", "sonnet", "p"]).stdout, /"--model","sonnet"/); // claude resolves its own
});

// ---- sandboxes -------------------------------------------------------------------

const claudeSettings = (out) => JSON.parse(after_(argvOf(out), "--settings")).sandbox;

test("claude read-only: Claude Code's sandbox denies home and cwd writes, file tools off, no unfenced retry", () => {
  const r = run(["claude", "--sandbox", "read-only", "p"]);
  assert.equal(r.status, 0, r.stderr);
  const argv = argvOf(r.stdout);
  assert.equal(after_(argv, "--permission-mode"), "manual");
  assert.equal(after_(argv, "--disallowedTools"), "Edit,Write,NotebookEdit");
  // no user, project or local settings: their sandbox exceptions merge in
  assert.equal(after_(argv, "--setting-sources"), "");
  assert.deepEqual(claudeSettings(r.stdout), {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
    filesystem: { denyWrite: [realpathSync(join(dir, "home")), here()] },
  });
});

test("claude workspace-write: the same sandbox, writes left at the cwd, edits accepted", () => {
  const r = run(["claude", "--sandbox", "workspace-write", "p"]);
  assert.equal(r.status, 0, r.stderr);
  const argv = argvOf(r.stdout);
  assert.equal(after_(argv, "--permission-mode"), "acceptEdits");
  assert.equal(after_(argv, "--setting-sources"), "");
  assert.ok(!argv.includes("--disallowedTools"));
  const s = claudeSettings(r.stdout);
  assert.equal(s.enabled, true);
  assert.equal(s.failIfUnavailable, true);
  assert.equal(s.filesystem, undefined);
});

test("claude danger-full-access skips permissions; omitted defers to the consultee's own config", () => {
  assert.match(run(["claude", "--sandbox", "danger-full-access", "p"]).stdout, /"--dangerously-skip-permissions"/);
  const r = run(["claude", "p"]);
  assert.doesNotMatch(r.stdout, /--permission-mode|--settings|--setting-sources|--dangerously-skip-permissions/);
});

test("a claude sandbox that can't start fails the consult with the harness's reason", () => {
  const r = run(["claude", "--sandbox", "read-only", "p"], { env: { STUB_EXIT: "1" } });
  assert.equal(r.status, 1);
  const m = meta(jobIdFrom(r.stdout));
  assert.equal(m.status, "failed");
  assert.equal(m.error, "stub claude: sandbox required but unavailable");
  assert.match(r.stdout, /FAILED: stub claude: sandbox required but unavailable · job /);
  assert.match(r.stderr, /noise/); // the stderr tail is surfaced when there's no reply

  // an error result's own text beats the exit code
  const auth = run(["claude", "p"], { env: { STUB_AUTH_FAIL: "1" } });
  assert.equal(auth.status, 1);
  assert.equal(meta(jobIdFrom(auth.stdout)).error, "Failed to authenticate: OAuth session expired");
});

test("codex and grok map each mode to their own sandboxes; grok defaults to read-only, its permission layer skipped", () => {
  for (const mode of ["read-only", "workspace-write", "danger-full-access"])
    assert.match(run(["codex", "--sandbox", mode, "p"]).stdout, new RegExp(`sandbox_mode=\\\\"${mode}\\\\"`));
  assert.doesNotMatch(run(["codex", "p"]).stdout, /sandbox_mode/);
  assert.match(run(["grok", "p"]).stdout, /"--sandbox","read-only","--always-approve"/);
  assert.match(run(["grok", "--sandbox", "workspace-write", "p"]).stdout, /"--sandbox","workspace","--always-approve"/);
  assert.match(run(["grok", "--sandbox", "danger-full-access", "p"]).stdout, /"--sandbox","off","--always-approve"/);
});

test("a bad --sandbox is a usage error", () => {
  const r = run(["claude", "--sandbox", "workspace", "p"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /read-only \| workspace-write \| danger-full-access/);
});

test("gemini skips agy's own permission layer in every mode", () => {
  const modes = process.platform === "darwin" ? ["read-only", "workspace-write", "danger-full-access"] : ["danger-full-access"];
  for (const mode of modes)
    assert.ok(argvOf(run(["gemini", "--sandbox", mode, "p"]).stdout).includes("--dangerously-skip-permissions"), mode);
});

test("without Seatbelt, a fenced gemini consult is refused before agy runs", () => {
  // inside another sandbox (Seatbelt doesn't nest) — and on Linux, always
  for (const mode of ["read-only", "workspace-write"]) {
    const before = existsSync(join(home, "jobs")) ? readdirSync(join(home, "jobs")).length : 0;
    const r = run(["gemini", "--sandbox", mode, "p"], { env: { CODEX_SANDBOX: "seatbelt", STUB_MODELS_FAIL: "1" } });
    assert.equal(r.status, 4, mode);
    assert.match(r.stderr, /macOS Seatbelt/);
    assert.match(r.stderr, /was not started/);
    assert.equal(existsSync(join(home, "jobs")) ? readdirSync(join(home, "jobs")).length : 0, before, "no record");
  }
  assert.equal(run(["gemini", "--sandbox", "danger-full-access", "p"], { env: { CODEX_SANDBOX: "seatbelt" } }).status, 0);
});

test("on macOS, gemini's Seatbelt fence: read-only writes nowhere, workspace-write only in the cwd", { skip: process.platform !== "darwin" }, () => {
  // outside the temp dirs, which the profile leaves writable
  const cwd = mkdtempSync(join(ROOT, ".seatbelt-test-"));
  const outside = mkdtempSync(join(ROOT, ".seatbelt-outside-"));
  try {
    const e = { STUB_TRY_WRITE: "1", STUB_WRITE_OUTSIDE: join(outside, "x.txt"), GASLAMP_DEBUG: "1" };
    const ro = run(["gemini", "--cwd", cwd, "p"], { env: e });
    assert.equal(ro.status, 0, ro.stderr);
    assert.match(ro.stderr, /spawn \/usr\/bin\/sandbox-exec/);
    assert.match(ro.stdout, /write=EPERM \|\| outside=EPERM/);
    const ww = run(["gemini", "--cwd", cwd, "--sandbox", "workspace-write", "p"], { env: e });
    assert.equal(ww.status, 0, ww.stderr);
    assert.match(ww.stdout, /write=ok \|\| outside=EPERM/);
    const full = run(["gemini", "--cwd", cwd, "--sandbox", "danger-full-access", "p"], { env: e });
    assert.doesNotMatch(full.stderr, /sandbox-exec/);
    assert.match(full.stdout, /write=ok \|\| outside=ok/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---- guards ----------------------------------------------------------------------

test("nested guard: a consulted agent's consult refuses (one hop), no record", () => {
  const before = readdirSync(join(home, "jobs")).length;
  const r = run(["codex", "p"], { env: { GASLAMP_NESTED: "1" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /one hop/);
  assert.equal(readdirSync(join(home, "jobs")).length, before);
  assert.equal(run(["claude", "p"], { env: { GASLAMP_NESTED: "1", GASLAMP_ALLOW_RECURSION: "1" } }).status, 0);
});

test("a network-disabled sandbox is refused pointedly on every backend", () => {
  for (const backend of ["claude", "codex", "gemini", "grok"]) {
    const r = run([backend, "p"], { env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" } });
    assert.equal(r.status, 4, backend);
    assert.match(r.stderr, /network is disabled/);
  }
});

// ---- conversations ---------------------------------------------------------------

test("--resume takes a job id and continues its session; anything else is a usage error", () => {
  const id = jobIdFrom(run(["claude", "first"]).stdout);
  const second = run(["claude", "--resume", id, "again"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"--resume","cl-sess-1"/);
  assert.match(second.stderr, new RegExp(`continuing ${id}`));
  assert.equal(meta(jobIdFrom(second.stdout)).sessionId, "cl-sess-1-fork");

  const mismatch = run(["codex", "--resume", id, "again"]);
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /was a claude consult/);
  const raw = run(["claude", "--resume", "some-session-uuid", "p"]);
  assert.equal(raw.status, 2);
  assert.match(raw.stderr, /takes a job id/);
});

test("--thread starts a conversation, then continues it, chasing claude's forked session ids", () => {
  const first = run(["claude", "--thread", "spar-x", "open question"]);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /"--resume"/);
  assert.match(first.stderr, /· new thread spar-x/);
  assert.match(first.stdout, /continue: gaslamp claude --thread spar-x\n$/);
  let t = JSON.parse(readFileSync(join(home, "threads", "claude--spar-x.json"), "utf8"));
  assert.equal(t.sessionId, "cl-sess-1");
  assert.equal(t.cwd, here());
  assert.equal(t.lastJobId, jobIdFrom(first.stdout));

  const second = run(["claude", "--thread", "spar-x", "follow-up"]);
  assert.match(second.stdout, /"--resume","cl-sess-1"/);
  assert.match(second.stderr, /· continuing thread spar-x/);
  assert.equal(meta(jobIdFrom(second.stdout)).thread, "spar-x");
  t = JSON.parse(readFileSync(join(home, "threads", "claude--spar-x.json"), "utf8"));
  assert.equal(t.sessionId, "cl-sess-1-fork");

  const third = run(["claude", "--thread", "spar-x", "and again"]);
  assert.match(third.stdout, /"--resume","cl-sess-1-fork"/);
});

test("a conversation runs where it started: another directory needs --cwd", () => {
  const a = scratch("repo-a"), b = scratch("repo-b");
  const started = run(["codex", "--thread", "review-x", "--cwd", a, "p"]);
  assert.equal(started.status, 0);
  // the printed continuation carries the directory it needs
  assert.match(started.stdout, new RegExp(`continue: gaslamp codex --cwd ${realpathSync(a)} --thread review-x\\n$`));
  const elsewhere = run(["codex", "--thread", "review-x", "--cwd", b, "p"]);
  assert.equal(elsewhere.status, 2);
  assert.match(elsewhere.stderr, new RegExp(`thread review-x lives in ${realpathSync(a)}`));
  assert.match(elsewhere.stderr, /give this conversation its own name/);
  assert.ok(!existsSync(join(home, "locks", "codex--thread-review-x")), "the refusal released its lock");
  assert.equal(run(["codex", "--thread", "review-x", "--cwd", a, "p"]).status, 0);

  const job = jobIdFrom(run(["codex", "--cwd", a, "p"]).stdout);
  const resumed = run(["codex", "--resume", job, "--cwd", b, "p"]);
  assert.equal(resumed.status, 2);
  assert.match(resumed.stderr, new RegExp(`job ${job} lives in`));
});

test("a job inside a thread continues through the thread, not --resume", () => {
  const id = jobIdFrom(run(["codex", "--thread", "named-th", "p"]).stdout);
  const r = run(["codex", "--resume", id, "p"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /belongs to thread named-th — continue it with --thread named-th/);
});

test("2.x records: a thread's directory comes from its last job; an unusable one needs --cwd", () => {
  const a = realpathSync(scratch("legacy"));
  const job = jobIdFrom(run(["codex", "--cwd", a, "p"]).stdout);
  const legacy = (name, lastJobId) => writeFileSync(join(home, "threads", `codex--${name}.json`),
    JSON.stringify({ backend: "codex", name, sessionId: "cx-thread-1", lastJobId }));
  legacy("old-th", job);
  assert.equal(run(["codex", "--thread", "old-th", "p"]).status, 2, "recovered: lives in a");
  const ok = run(["codex", "--thread", "old-th", "--cwd", a, "p"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(join(home, "threads", "codex--old-th.json"), "utf8")).cwd, a);

  const rel = jobIdFrom(run(["codex", "p"]).stdout);
  const m = meta(rel);
  m.cwd = ".";
  writeFileSync(join(home, "jobs", rel, "meta.json"), JSON.stringify(m));
  const refused = run(["codex", "--resume", rel, "p"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /predates gaslamp 3 .* Pass --cwd/);
  assert.equal(run(["codex", "--resume", rel, "--cwd", a, "p"]).status, 0);
});

test("one consult per conversation at a time: busy refuses, a kill releases, the group dies", async () => {
  const pidFile = join(dir, "claude.pid");
  const slow = spawn(process.execPath, [BIN, "claude", "--thread", "slow-th", "p"],
    { env: env({ STUB_DELAY_MS: "4000", STUB_PIDFILE: pidFile }) });
  slow.stdin.end(); // piped-but-open stdin would block the evidence read (cat-like)
  let serr = "";
  slow.stderr.on("data", (d) => (serr += d));
  const lock = join(home, "locks", "claude--thread-slow-th");
  await until(() => existsSync(lock) && existsSync(pidFile));

  // the same new name, before the first consult has even bound it
  const busy = run(["claude", "--thread", "slow-th", "p2"]);
  assert.equal(busy.status, 5);
  assert.match(busy.stderr, /busy/);

  slow.kill("SIGTERM");
  assert.equal(await new Promise((r) => slow.on("close", r)), 1);
  const id = serr.match(ID)?.[1];
  assert.ok(id, "breadcrumb carries the job id: " + serr);
  const m = meta(id);
  assert.equal(m.status, "killed");
  assert.equal(m.error, "killed by SIGTERM");
  assert.ok(!existsSync(lock), "lock released on kill");
  // the child group died with us — no orphans burning quota
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), /ESRCH/);
});

test("a stale lock (dead holder) is reaped, not fatal", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]); // a pid that just exited
  mkdirSync(join(home, "locks"), { recursive: true });
  writeFileSync(join(home, "locks", "claude--thread-stale-th"), JSON.stringify({ pid: dead.pid, job: "cl-00000000-000000-dead" }) + "\n");
  const r = run(["claude", "--thread", "stale-th", "p"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(home, "locks", "claude--thread-stale-th")));
});

test("thread usage errors: with --resume, and bad names", () => {
  const both = run(["claude", "--thread", "x", "--resume", "cl-00000000-000000-dead", "p"]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /exclusive/);
  assert.equal(run(["claude", "--thread", "no spaces", "p"]).status, 2);
  assert.equal(run(["claude", "--thread", "-leadingdash", "p"]).status, 2);
});

test("threads lists conversations with their directory", () => {
  run(["codex", "--thread", "cx-spar", "p"]);
  assert.match(run(["threads"]).stdout, new RegExp(`cx-spar\\s+codex\\s+cx-\\S+\\s+\\S+\\s+${here()}`));
});

// ---- records and readers -----------------------------------------------------------

test("jobs lists records; poll prints one, exits 10 while running", async () => {
  const id = jobIdFrom(run(["claude", "--thread", "listed-th", "a listed prompt"]).stdout);
  const jobs = run(["jobs"]);
  assert.match(jobs.stdout, new RegExp(`${id}\\s+done\\s+\\d+s\\s+@listed-th a listed prompt`));
  const rec = JSON.parse(run(["jobs", "--json"]).stdout).find((x) => x.jobId === id);
  assert.deepEqual(Object.keys(rec), ["jobId", "backend", "status", "thread", "startedAt", "endedAt", "promptPreview"]);
  assert.equal(rec.thread, "listed-th");

  const polled = run(["poll", id]);
  assert.equal(polled.status, 0);
  assert.match(polled.stdout, /stub claude: a listed prompt/);
  assert.match(polled.stdout, /continue: gaslamp claude --thread listed-th/);

  const slow = spawn(process.execPath, [BIN, "claude", "slow one"], { env: env({ STUB_DELAY_MS: "4000" }) });
  slow.stdin.end();
  let serr = "";
  slow.stderr.on("data", (d) => (serr += d));
  await until(() => ID.test(serr));
  const slowId = serr.match(ID)[1];
  await until(() => existsSync(join(home, "jobs", slowId, "meta.json")));
  const running = run(["poll", slowId]);
  assert.equal(running.status, 10);
  assert.match(running.stdout, /RUNNING/);
  slow.kill("SIGTERM");
  await new Promise((r) => slow.on("close", r));
});

test("poll --json is the consult's own envelope, data included", () => {
  for (const b of ["claude", "codex"]) {
    const direct = JSON.parse(run([b, "--schema", '{"type":"object"}', "--json", "p"]).stdout);
    const p = run(["poll", direct.jobId, "--json"]);
    assert.equal(p.status, 0);
    assert.deepEqual(JSON.parse(p.stdout), direct);
    assert.deepEqual(direct.data, { ok: true, who: b });
  }
});

test("poll recovers a 2.x schema job's data from its reply", () => {
  const id = "cx-20260702-153531-1f39";
  const d = join(home, "jobs", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "meta.json"), JSON.stringify({ id, backend: "codex", status: "done", sessionId: "s", schema: true }));
  writeFileSync(join(d, "schema.json"), '{"type":"object"}');
  writeFileSync(join(d, "reply.md"), '{"verdict":"correct"}');
  assert.deepEqual(JSON.parse(run(["poll", id, "--json"]).stdout).data, { verdict: "correct" });
});

test("an empty reply is a failed consult on every backend, and the record says why", () => {
  for (const b of ["claude", "codex", "gemini", "grok"]) {
    const r = run([...target(b), "--sandbox", "danger-full-access", "p"], { env: { STUB_EMPTY: "1" } });
    assert.equal(r.status, 1, b);
    assert.match(r.stdout, /\[gaslamp\] FAILED: empty reply · job /, b);
    const m = meta(jobIdFrom(r.stdout));
    assert.equal(m.status, "failed", b);
    assert.equal(m.error, "empty reply", b);
    assert.equal(JSON.parse(run(["poll", m.id, "--json"]).stdout).error, "empty reply");
  }
});

test("a consult's record goes from running straight to its final state", async () => {
  const child = spawn(process.execPath, [BIN, "grok", "p"], { env: env({ STUB_EMPTY: "1", STUB_DELAY_MS: "300" }) });
  child.stdin.end();
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  let closed = false;
  child.on("close", () => (closed = true));
  const seen = new Set();
  let id = null;
  while (!closed) {
    id ??= err.match(ID)?.[1];
    if (id) { try { seen.add(meta(id).status); } catch {} }
    await new Promise((r) => setTimeout(r, 5));
  }
  seen.add(meta(id).status);
  assert.deepEqual([...seen].filter((x) => x !== "running"), ["failed"]);
});

test("usage errors: empty prompt, unknown or removed flags, two prompts", () => {
  assert.equal(run(["claude"], { input: "" }).status, 2);
  for (const f of ["--bogus", "--label", "--raw"]) assert.equal(run(["claude", f, "x", "p"]).status, 2, f);
  assert.equal(run(["claude", "p1", "p2"]).status, 2);
  assert.equal(run(["claude", "--cwd", join(dir, "nope"), "p"]).status, 2);
});

test("--version prints the package version; --help shows the targets and exit codes", () => {
  assert.equal(run(["--version"]).stdout.trim(), PKG.version);
  const h = run(["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /claude\|codex\|gemini\|grok/);
  assert.match(h.stdout, /conversation busy/);
  assert.doesNotMatch(h.stdout, /fleet|tail|--label/);
  assert.equal(run(["fleet", "codex", "-n", "2", "p"]).status, 2);
});

// ---- evidence and preamble ----------------------------------------------------------

test("prompt arg + piped stdin appends a <stdin> evidence block; empty stdin adds none", () => {
  const r = run(["claude", "review this diff:"], { input: "DIFF CONTENT\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, "jobs", jobIdFrom(r.stdout), "prompt.md"), "utf8"),
    "review this diff:\n\n<stdin>\nDIFF CONTENT\n</stdin>");
  const solo = run(["claude", "solo prompt"], { input: "" });
  assert.equal(readFileSync(join(home, "jobs", jobIdFrom(solo.stdout), "prompt.md"), "utf8"), "solo prompt");
});

test("the preamble rides each backend's own channel", () => {
  assert.match(run([...GEMINI, "p"]).stdout, /preamble=true/);
  assert.match(after_(argvOf(run(["grok", "p"]).stdout), "--rules"), /You are being consulted/);
});

// ---- schema ----------------------------------------------------------------------------

test("--schema reaches every backend natively; data.json persists the parsed reply", () => {
  for (const b of ["claude", "codex", "gemini", "grok"]) {
    const r = run([...target(b), "--json", "--schema", '{"type":"object","properties":{"ok":{"type":"boolean"}}}', "p"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.data, { ok: true, who: b });
    assert.deepEqual(JSON.parse(readFileSync(join(home, "jobs", j.jobId, "data.json"), "utf8")), j.data);
  }
  // claude's prose result and its structured output differ; data is the structured one
  const cl = JSON.parse(run(["claude", "--json", "--schema", '{"type":"object"}', "p"]).stdout);
  assert.equal(cl.content, "Here is the verdict.");
});

test("codex schemas are strictified for OpenAI strict mode; claude's go as written", () => {
  const loose = '{"type":"object","properties":{"a":{"type":"string"},"nest":{"type":"object","properties":{"b":{"type":"number"}}}},"required":["a"]}';
  const rx = JSON.parse(run(["codex", "--schema", loose, "--json", "p"]).stdout);
  const sent = JSON.parse(readFileSync(join(home, "jobs", rx.jobId, "schema.json"), "utf8"));
  assert.equal(sent.additionalProperties, false);
  assert.deepEqual(sent.required, ["a", "nest"]);
  assert.equal(sent.properties.nest.additionalProperties, false);
  assert.deepEqual(sent.properties.nest.required, ["b"]);
  assert.match(readFileSync(join(home, "jobs", rx.jobId, "events.jsonl"), "utf8"), /--output-schema/);

  const rc = JSON.parse(run(["claude", "--schema", loose, "--json", "p"]).stdout);
  const asWritten = JSON.parse(readFileSync(join(home, "jobs", rc.jobId, "schema.json"), "utf8"));
  assert.equal(asWritten.additionalProperties, undefined);
  assert.deepEqual(asWritten.required, ["a"]);
});

test("--schema accepts a file path; a bad schema is a usage error", () => {
  const schemaFile = join(dir, "verdict.schema.json");
  writeFileSync(schemaFile, '{"type":"object","required":["ok"]}');
  const j = JSON.parse(run(["codex", "--schema", schemaFile, "--json", "p"]).stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "jobs", j.jobId, "schema.json"), "utf8")).required, ["ok"]);
  assert.equal(run(["claude", "--schema", "{not json", "p"]).status, 2);
  assert.equal(run(["claude", "--schema", "/nope/missing.json", "p"]).status, 2);
});

test("a schema consult whose reply is not JSON is failed, with the reason recorded", () => {
  const r = run(["codex", "--schema", '{"type":"object"}', "--json", "p"], { env: { STUB_BAD_JSON: "1" } });
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, "failed");
  assert.equal(j.data, null);
  assert.match(j.error, /not valid JSON/);
  assert.ok(!("data" in JSON.parse(run(["codex", "--json", "q"]).stdout)), "no --schema, no data key");
});

test("a structured-only result is a deliverable", () => {
  const r = run(["grok", "--json", "--schema", '{"type":"object"}', "p"], { env: { STUB_STRUCTURED_ONLY: "1" } });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, "done");
  assert.deepEqual(j.data, { ok: true, who: "grok" });
  assert.equal(j.content, '{"ok":true,"who":"grok"}');
});

// ---- gemini and grok -------------------------------------------------------------------

test("gemini consult round-trips over agy's streaming input", () => {
  const r = run([...GEMINI, "hello gemini"]);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.match(id, /^gm-/);
  assert.match(r.stdout, /stub gemini: hello gemini/);
  assert.match(r.stdout, /"--input-format","stream-json","--output-format","stream-json"/);
  assert.equal(meta(id).sessionId, "gm-conv-1");
  const again = run([...GEMINI, "--resume", id, "--effort", "high", "p"]);
  assert.match(again.stdout, /"--effort","high","--conversation","gm-conv-1"/);
});

test("grok consult round-trips; a job id resumes its session", () => {
  const r = run(["grok", "hello grok"]);
  assert.equal(r.status, 0, r.stderr);
  const argv = argvOf(r.stdout);
  // the prompt rides the job's prompt.md, not /dev/stdin (ENXIO on Linux)
  assert.equal(after_(argv, "--prompt-file"), join(home, "jobs", jobIdFrom(r.stdout), "prompt.md"));
  assert.match(r.stdout, /"--output-format","streaming-messages-json","--no-auto-update"/);
  const again = run(["grok", "--resume", jobIdFrom(r.stdout), "--effort", "high", "p2"]);
  assert.match(again.stdout, /"--resume","gk-sess-1"/);
  assert.match(again.stdout, /"--effort","high"/);
});

test("gemini and grok spawns drop the caller's harness env; grok's vendor-compat imports are off", () => {
  const extra = { env: { CLAUDE_CODE_SESSION_ID: "the-callers-session" } };
  const g = run([...GEMINI, "p"], extra);
  assert.match(g.stdout, /claudeSid=false/);
  assert.match(g.stdout, /nested=1/);
  const k = run(["grok", "p"], extra);
  assert.match(k.stdout, /claudeSid=false/);
  assert.match(k.stdout, /env: GROK_CLAUDE_AGENTS_ENABLED=0,GROK_CLAUDE_HOOKS_ENABLED=0,GROK_CURSOR_MCPS_ENABLED=0/);
});

test("agy waiting on a sign-in is stopped, not left hanging", () => {
  const t0 = Date.now();
  const pidFile = join(dir, "stubborn.pid");
  const r = run([...GEMINI, "p"], { env: { STUB_AUTH_HANG: "1", STUB_STUBBORN_CHILD: pidFile } });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 8000, "refused promptly");
  // the whole group went down, including a descendant that ignored SIGTERM
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), /ESRCH/);
  assert.match(r.stdout, /FAILED: agy is not signed in/);
  assert.match(meta(jobIdFrom(r.stdout)).error, /not signed in/);

  const unterminated = run([...GEMINI, "p"], { env: { STUB_AUTH_HANG: "unterminated" } });
  assert.equal(unterminated.status, 1);
  assert.match(unterminated.stdout, /agy is not signed in/);
  // auth text inside a reply is content, not a sign-in prompt
  assert.equal(run([...GEMINI, "explain Authentication required errors"]).status, 0);
});

test("off-ramp records a sandbox kept from the log are filed into it, and nowhere else", () => {
  const elsewhere = join(dir, "not-the-log.jsonl");
  const r = run(["grok", "p"], { env: { STUB_OFFRAMP: elsewhere } });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  const log = join(dir, "home", ".claude", "conversation-ends.jsonl");
  const filed = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.via === `gaslamp ${id}`);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].scope, "main");
  assert.equal(filed[0].log, undefined);
  assert.ok(!existsSync(elsewhere), "a spool line cannot choose where gaslamp appends");
  assert.match(r.stderr, /ignored an off-ramp spool line/);
  assert.match(r.stderr, /the consultee ended its session \(end_session scope=main: probe\)/);
});

// ---- stdin -----------------------------------------------------------------------------

test("a non-blocking stdin is read to EOF, not abandoned on EAGAIN", async () => {
  // Touching process.stdin makes fd 0 non-blocking; readFileSync(0) then
  // threw EAGAIN instead of waiting for the evidence.
  const code = `process.stdin; process.stdin.pause(); import(${JSON.stringify(join(ROOT, "src", "stdin.mjs"))})` +
    `.then((m) => process.stdout.write(JSON.stringify(m.readStdin())))`;
  const c = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  setTimeout(() => { c.stdin.write("late evidence\n"); c.stdin.end(); }, 200);
  await new Promise((r) => c.on("close", r));
  assert.equal(JSON.parse(out), "late evidence\n");
});

test("a prompt argument with an idle socket for stdin does not wait forever", async () => {
  // An agent harness that backgrounds a shell command hands it a socket that
  // is never written or closed; the consult must not block on it.
  const c = spawn(process.execPath, [BIN, "claude", "hi"], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  const code = await Promise.race([
    new Promise((r) => c.on("close", r)),
    new Promise((r) => setTimeout(() => r("hung"), 8000)),
  ]);
  if (code === "hung") c.kill("SIGKILL");
  assert.equal(code, 0, "consult completed");
  assert.match(out, /stub claude: hi \|\|/);
  assert.doesNotMatch(out, /<stdin>/);
});
