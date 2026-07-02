// fleet.mjs — fan out a *fleet* of consults from one command.
//
//   gaslamp fleet codex -n 8 "review this diff"   8 fresh sessions, same prompt
//   gaslamp fleet codex - < tasks.jsonl           one task per line (see below)
//   gaslamp fleet claude --concurrency 4 …        bound the parallelism
//
// The fleet is a thin bounded-concurrency runner over the SAME single-consult
// CLI: it shells out to `gaslamp <backend> --json …` once per task, never
// reaching into consult.mjs. Each child is exactly today's tested consult — its
// own job record, its own kill-group, its own resumable session — so a killed
// fleet costs in-flight turns, not sessions: resume each child by its session.
//
// This keeps faith with the 2.0 principle (asynchrony is the harness's job):
// the harness still backgrounds the whole `gaslamp fleet …` as ONE blocking
// call and is notified when it finishes. The fleet just does the bounded
// fan-out the harness would otherwise make you hand-roll across N background
// tasks. It earns its place chiefly on Codex's behalf — Claude Code has the
// Workflow tool, Codex has nothing, so `gaslamp fleet claude` is the only way
// for Codex to fire a fleet of claudes from one command.
//
// Two things the fleet does that a single consult does not, both for safety at
// N: it defaults the consults to `--sandbox read-only` (N write-capable agents
// in one cwd is a race factory — pass --sandbox to opt into writes), and it
// refuses a manifest that resumes the same session twice (they'd deadlock on
// the session lock).
//
// Task sources (first that matches wins):
//   stdin (`-`, or piped with no prompt arg): one task per non-empty line. A
//     line starting with `{` is a JSON spec
//     {prompt, model?, sandbox?, cwd?, resume?, label?} (maps 1:1 to a Workflow
//     agent() call); any other line is a bare prompt. Fleet flags are the
//     default; a per-task field overrides.
//   prompt arg + -n N: replicate the prompt across N fresh sessions.
//   prompt arg alone: a fleet of one (a slow single consult; allowed).

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeSync } from "node:fs";
import { createFleet, newFleetId, readMeta, writeFleetMeta } from "./jobs.mjs";

const GASLAMP_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gaslamp.mjs");
// Quota-shaped, not CPU-shaped: the bottleneck is API rate limits, not cores
// (Workflow's min(16, cores-2) is wrong here). Raise it with --concurrency.
const DEFAULT_CONCURRENCY = 4;

const die = (code, msg) => { writeSync(2, `gaslamp: ${msg}\n`); process.exit(code); };
const note = (msg) => writeSync(2, `${msg}\n`);

const num = (flag, s) => {
  const n = Number(s);
  if (!Number.isInteger(n)) die(2, `${flag} needs an integer, got "${s}"`);
  return n;
};

function parseArgs(argv) {
  const o = { json: false, count: null, concurrency: DEFAULT_CONCURRENCY, prompt: null, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) die(2, `${a} needs a value`); return argv[++i]; };
    if (a === "-n" || a === "--count") o.count = num(a, val());
    else if (a === "--concurrency" || a === "-j") o.concurrency = num(a, val());
    else if (a === "--model" || a === "-m") o.model = val();
    else if (a === "--sandbox" || a === "-s") o.sandbox = val();
    else if (a === "--cwd" || a === "-C") o.cwd = val();
    else if (a === "--schema") o.schema = val();
    else if (a === "--raw") o.raw = true;
    else if (a === "--json") o.json = true;
    else if (a === "-") o.stdin = true;
    else if (a.startsWith("-") && a.length > 1) die(2, `unknown flag ${a} (see gaslamp --help)`);
    else if (o.prompt == null) o.prompt = a;
    else die(2, "more than one prompt argument — use -n to replicate, or a JSONL manifest on stdin");
  }
  if (o.concurrency < 1) die(2, "--concurrency must be >= 1");
  if (o.count != null && o.count < 1) die(2, "-n must be >= 1");
  return o;
}

// Flags + sources → a flat list of normalized specs, then a finalize pass that
// stamps index + a stable label and rejects the two footguns (duplicate labels;
// duplicate resume targets, which would deadlock on the session lock).
function buildTasks(o) {
  // Default to read-only unless the caller opts into writes (fleet-wide or
  // per-task). N writers in one cwd race; one consult deferring to config is
  // fine, N is not.
  const baseSandbox = o.sandbox ?? "read-only";
  const norm = (spec, i) => {
    if (typeof spec === "string") spec = { prompt: spec };
    if (!spec || typeof spec.prompt !== "string" || !spec.prompt.trim())
      die(2, `task ${i + 1} has no prompt`);
    // A manifest `schema` may be an inline JSON object (the natural way to
    // write it on a JSONL line) — normalize to the string the CLI flag takes.
    let schema = spec.schema ?? o.schema ?? null;
    if (schema != null && typeof schema === "object") schema = JSON.stringify(schema);
    return {
      prompt: spec.prompt,
      model: spec.model ?? o.model,
      sandbox: spec.sandbox ?? baseSandbox,
      cwd: spec.cwd ?? o.cwd,
      resume: spec.resume ?? null,
      label: spec.label ?? null,
      schema,
      raw: spec.raw ?? o.raw ?? false,
    };
  };

  let raw;
  const stdinRequested = o.stdin || (o.prompt == null && !process.stdin.isTTY);
  if (stdinRequested) {
    const lines = readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) die(2, "no tasks on stdin");
    raw = lines.map((line, i) => norm(line.startsWith("{") ? parseJsonLine(line, i) : line, i));
  } else {
    if (o.prompt == null) die(2, "no tasks — pass a prompt with -n N, or a JSONL manifest on stdin");
    // Prompt arg + piped stdin: stdin is evidence for every replica, same
    // <stdin> convention as a single consult (git diff | gaslamp fleet …).
    let prompt = o.prompt;
    if (!process.stdin.isTTY) {
      const evidence = readFileSync(0, "utf8");
      if (evidence.trim())
        prompt += "\n\n<stdin>\n" + (evidence.endsWith("\n") ? evidence : evidence + "\n") + "</stdin>";
    }
    raw = Array.from({ length: o.count ?? 1 }, () => norm({ prompt }, 0));
  }

  const width = String(raw.length).length;
  const seenLabel = new Set(), seenResume = new Set();
  raw.forEach((t, i) => {
    t.index = i;
    if (t.label == null) t.label = `task-${String(i + 1).padStart(width, "0")}`;
    else if (seenLabel.has(t.label)) die(2, `duplicate task label "${t.label}" — labels must be unique`);
    seenLabel.add(t.label);
    if (t.resume) {
      if (seenResume.has(t.resume))
        die(2, `two tasks resume the same session (${t.resume}) — they would deadlock on the session lock; give each its own session`);
      seenResume.add(t.resume);
    }
  });
  return raw;
}

function parseJsonLine(line, i) {
  try { return JSON.parse(line); }
  catch (e) { die(2, `task ${i + 1} is not valid JSON: ${e.message}`); }
}

// argv for one child `gaslamp <backend> --json …`. Prompt rides on stdin (no
// argv-size or quoting traps), exactly as a hand-run consult would.
function childArgs(backend, task) {
  const args = [GASLAMP_BIN, backend, "--json"];
  if (task.resume) args.push("--resume", task.resume);
  if (task.model) args.push("--model", task.model);
  if (task.sandbox) args.push("--sandbox", task.sandbox);
  if (task.cwd) args.push("--cwd", task.cwd);
  if (task.schema) args.push("--schema", task.schema);
  if (task.raw) args.push("--raw");
  args.push("-");
  return args;
}

const tail = (s, n = 6) => (s || "").trim().split("\n").slice(-n).join("\n");

// Spawn one child consult; resolve with an enriched result. Never rejects — a
// launch/parse failure resolves to a failed result so one bad task can't sink
// the fleet. `onStart(jobId)` fires the moment the child reports its id (the
// gated "started" receipt), so the parent record names in-flight children even
// if the fleet is killed before they finish.
function runChild(backend, task, live, onStart) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, childArgs(backend, task), {
      stdio: ["pipe", "pipe", "pipe"], detached: false,
      // GASLAMP_FLEET makes the child emit the early started receipt. It is NOT
      // nested (a fleet sits where a hand-run consult sits), so no GASLAMP_NESTED.
      env: { ...process.env, GASLAMP_FLEET: "1" },
    });
    live.add(child);

    let out = "", err = "", buf = "", envelope = null, started = false;
    child.stdout.on("data", (d) => {
      out += d;
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === "started" && !started) { started = true; onStart?.(j.jobId); }
        else if (j.backend && j.status) envelope = j; // the final consult envelope
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.on("error", () => {});
    child.stdin.write(task.prompt);
    child.stdin.end();

    const fail = (extra) => resolve({
      index: task.index, label: task.label, jobId: extra.jobId ?? null, sessionId: null,
      status: "failed", exitCode: null, content: "", error: extra.error, stderrTail: tail(err),
      startedAt: null, endedAt: null,
    });
    child.on("error", (e) => { live.delete(child); fail({ error: e.message }); });
    child.on("close", () => {
      live.delete(child);
      if (!envelope) return fail({ error: tail(err) || "child produced no envelope" });
      const m = envelope.jobId ? readMeta(envelope.jobId) : null;
      resolve({
        index: task.index, label: task.label,
        jobId: envelope.jobId, sessionId: envelope.sessionId,
        status: envelope.status, exitCode: envelope.exitCode ?? null,
        content: envelope.content ?? "", error: envelope.status === "done" ? null : tail(err),
        stderrTail: envelope.status === "done" ? null : tail(err),
        startedAt: m?.startedAt ?? null, endedAt: m?.endedAt ?? null,
        ...("data" in envelope ? { data: envelope.data } : {}),
      });
    });
  });
}

// Bounded worker pool, preserving input order in the results array.
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function runFleet(backend, argv) {
  if (backend !== "claude" && backend !== "codex")
    die(2, `fleet needs a backend: gaslamp fleet <claude|codex> … (got "${backend ?? ""}")`);

  const o = parseArgs(argv);

  // A fleet of consults is still a consult: refuse if nested (a fleet OF fleets
  // is exactly the recursion we guard), and refuse a network-disabled sandbox.
  if (process.env.GASLAMP_NESTED && !process.env.GASLAMP_ALLOW_RECURSION)
    die(3, "this agent is itself a gaslamp consult — a consult is one hop. (GASLAMP_ALLOW_RECURSION=1 opts out.)");
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1")
    die(4, "network is disabled in this sandbox (CODEX_SANDBOX_NETWORK_DISABLED=1) — consulted agents could reach neither Anthropic nor OpenAI. Re-run with network access.");

  const tasks = buildTasks(o);
  const concurrency = Math.min(o.concurrency, tasks.length);

  const fleetId = newFleetId();
  const meta = {
    id: fleetId, kind: "fleet", backend,
    tasks: tasks.length, concurrency,
    sandbox: o.sandbox ?? "read-only (default)",
    children: [], // [{ index, label, jobId, status }] — filled as they start/finish
    counts: { done: 0, failed: 0, killed: 0 },
    status: "running", pid: process.pid,
    startedAt: new Date().toISOString(), endedAt: null,
  };
  createFleet(meta, tasks);

  note(`[gaslamp fleet] → ${backend} · ${tasks.length} task${tasks.length === 1 ? "" : "s"} · concurrency ${concurrency} · fleet ${fleetId}`);
  if (!o.sandbox) note(`[gaslamp fleet] consults run --sandbox read-only by default (N writers in one cwd race); pass --sandbox to change`);

  // ---- signals: forward to live children; each kills its own backend group ----
  // Children are NOT detached, so they share our group and a terminal SIGINT
  // reaches them too; we also forward explicitly for a harness signal sent to
  // our pid alone. Each child's own handler does the graceful backend teardown.
  const live = new Set();
  let killedBy = null;
  const forward = (sig) => { for (const c of live) { try { c.kill(sig); } catch {} } };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (killedBy) return forward("SIGKILL");
      killedBy = sig;
      note(`[gaslamp fleet] ${sig} — stopping ${live.size} in-flight consult${live.size === 1 ? "" : "s"}; each session survives, recover with --resume`);
      forward(sig);
      setTimeout(() => forward("SIGKILL"), 5000).unref();
    });
  }

  // ---- run ------------------------------------------------------------------
  let finished = 0;
  const results = await pool(tasks, concurrency, async (task, i) => {
    const onStart = (jobId) => {
      meta.children[i] = { index: i, label: task.label, jobId, status: "running" };
      writeFleetMeta(meta); // write-through: a killed fleet's record still names its children
    };
    const r = await runChild(backend, task, live, onStart);
    finished++;
    meta.children[i] = { index: i, label: r.label, jobId: r.jobId, sessionId: r.sessionId, status: r.status };
    writeFleetMeta(meta);
    note(`[gaslamp fleet] ${r.status === "done" ? "✓" : "✗"} ${finished}/${tasks.length} · ${r.jobId ?? "?"} · ${r.label} · ${r.status}`);
    return r;
  });

  for (const r of results) {
    if (r.status === "done") meta.counts.done++;
    else if (r.status === "killed") meta.counts.killed++;
    else meta.counts.failed++;
  }
  meta.status = killedBy ? "killed" : meta.counts.done === tasks.length ? "done" : "failed";
  meta.endedAt = new Date().toISOString();
  writeFleetMeta(meta);

  // ---- output: block-and-collect, manifest order ----------------------------
  if (o.json) {
    process.stdout.write(JSON.stringify({
      fleetId, backend, tasks: tasks.length, counts: meta.counts,
      results: results.map((r) => ({
        index: r.index, label: r.label, jobId: r.jobId, sessionId: r.sessionId,
        status: r.status, exitCode: r.exitCode ?? null, content: r.content ?? "",
        error: r.error ?? null, stderrTail: r.stderrTail ?? null,
        startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null,
        ...("data" in r ? { data: r.data } : {}),
      })),
    }) + "\n");
  } else {
    const out = [];
    results.forEach((r) => {
      const sid = r.sessionId ? ` · ${r.sessionId.slice(0, 8)}` : "";
      out.push(`\n━━ [${r.label}] ${r.status} · ${r.jobId ?? "?"}${sid} ━━`);
      if (r.content?.trim()) out.push(r.content.trimEnd());
      else {
        out.push(`(no reply — ${r.status})`);
        if (r.stderrTail) out.push(r.stderrTail);
        if (r.sessionId) out.push(`resume: gaslamp ${backend} --resume ${r.sessionId}`);
      }
    });
    out.push(`\n[gaslamp fleet] ${fleetId} · ${meta.counts.done}/${tasks.length} done` +
      (meta.counts.failed ? ` · ${meta.counts.failed} failed` : "") +
      (meta.counts.killed ? ` · ${meta.counts.killed} killed` : "") +
      ` · poll: gaslamp poll ${fleetId}`);
    process.stdout.write(out.join("\n") + "\n");
  }

  process.exitCode = meta.status === "done" ? 0 : 1;
}
