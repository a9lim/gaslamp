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
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => setTimeout(() => {
  // Simulate a backend that dies before reporting anything (fleet-resume tests).
  if (process.env.STUB_FAIL_SUBSTR && prompt.includes(process.env.STUB_FAIL_SUBSTR)) process.exit(1);
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("-o") + 1];
  const tid = argv[1] === "resume" ? argv[2] : "cx-thread-1";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: tid }) + "\\n");
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

let dir, home, claudeStub, codexStub;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gaslamp-test-"));
  home = join(dir, "gaslamp-home");
  claudeStub = join(dir, "claude-stub.mjs");
  codexStub = join(dir, "codex-stub.mjs");
  writeFileSync(claudeStub, CLAUDE_STUB);
  writeFileSync(codexStub, CODEX_STUB);
  chmodSync(claudeStub, 0o755);
  chmodSync(codexStub, 0o755);
});

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// Scrubbed env: an outer consult's sentinel (or a real API key, or a sandbox
// marker) must not leak into the suite — the design spar hit exactly this.
function env(extra = {}) {
  const e = { ...process.env };
  for (const k of ["GASLAMP_NESTED", "GASLAMP_ALLOW_RECURSION", "GASLAMP_FLEET", "CODEX_SANDBOX_NETWORK_DISABLED",
    "GASLAMP_DEBUG", "GASLAMP_ALLOWED_TOOLS", "ANTHROPIC_API_KEY", "STUB_DELAY_MS", "STUB_BAD_JSON",
    "STUB_FAIL_SUBSTR"]) delete e[k];
  return { ...e, CLAUDE_BIN: claudeStub, CODEX_BIN: codexStub, GASLAMP_HOME: home, ...extra };
}

const run = (args, opts = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts, env: env(opts.env) });

const jobIdFrom = (out) => out.match(/job: (c[lx]-\d{8}-\d{6}-[0-9a-f]{4})/)?.[1];
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
