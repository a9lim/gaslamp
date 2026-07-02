// jobs.mjs — durable consult records, plus the `jobs` / `poll` readers.
//
// Every consult writes through to a job dir as it runs:
//
//   $GASLAMP_HOME/jobs/<id>/
//     meta.json      backend, status, sessionId, pids, timing, exit
//     prompt.md      the prompt as sent
//     events.jsonl   raw backend event stream (claude stream-json / codex --json)
//     reply.md       final reply text
//     stderr.log     backend stderr
//
// The record is passive durability, not a daemon: the blocking `gaslamp
// <backend>` process is the only process. If the caller's harness kills it,
// the record still holds the session id (captured early, the moment the
// backend reports it) — recovery is `--resume`, not orphaned children.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = () => process.env.GASLAMP_HOME || join(homedir(), ".gaslamp");
export const jobsDir = () => join(HOME(), "jobs");
export const locksDir = () => join(HOME(), "locks");
export const jobDir = (id) => join(jobsDir(), id);

// `kill(pid, 0)` probes liveness without signaling; EPERM means alive-but-not-ours.
export const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
};

// Ids embed a local timestamp, so they sort chronologically and read at a
// glance: cl-20260612-141233-9af2 (claude), cx-… (codex), fl-… (fleet).
function stampAndRand() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${rand}`;
}

export const newJobId = (backend) => `${backend === "claude" ? "cl" : "cx"}-${stampAndRand()}`;
export const newFleetId = () => `fl-${stampAndRand()}`;

export const looksLikeJobId = (s) => /^(cl|cx)-\d{8}-\d{6}-[0-9a-f]{4}$/.test(String(s));
export const looksLikeFleetId = (s) => /^fl-\d{8}-\d{6}-[0-9a-f]{4}$/.test(String(s));

// A fleet record lives alongside the consult records under jobs/, but it is
// grouping metadata only — never the authority on a child's state (a killed
// parent leaves it stale). `poll <fleet-id>` recomputes from the child records.
export const fleetDir = (id) => join(jobsDir(), id);
export function writeFleetMeta(meta) {
  writeFileSync(join(fleetDir(meta.id), "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}
export function readFleetMeta(id) {
  try { return JSON.parse(readFileSync(join(fleetDir(id), "meta.json"), "utf8")); }
  catch { return null; }
}
export function createFleet(meta, tasks) {
  mkdirSync(fleetDir(meta.id), { recursive: true });
  writeFileSync(join(fleetDir(meta.id), "manifest.jsonl"),
    tasks.map((t) => JSON.stringify({
      index: t.index, label: t.label, promptChars: t.prompt.length,
      model: t.model ?? null, sandbox: t.sandbox ?? null, cwd: t.cwd ?? null,
      resume: t.resume ?? null, thread: t.thread ?? null, effort: t.effort ?? null,
    })).join("\n") + "\n");
  writeFleetMeta(meta);
}

export function readMeta(id) {
  try { return JSON.parse(readFileSync(join(jobDir(id), "meta.json"), "utf8")); }
  catch { return null; }
}

export function writeMeta(meta) {
  writeFileSync(join(jobDir(meta.id), "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

export function createJob(meta, prompt) {
  mkdirSync(jobDir(meta.id), { recursive: true });
  writeFileSync(join(jobDir(meta.id), "prompt.md"), prompt);
  writeMeta(meta);
}

export function readReply(id) {
  try { return readFileSync(join(jobDir(id), "reply.md"), "utf8"); }
  catch { return null; }
}

// Newest first. The timestamp follows the 2-char backend prefix, so compare
// past it — pure lexical order would interleave cl-/cx- wrongly.
export function listJobIds() {
  let ids;
  try { ids = readdirSync(jobsDir()); } catch { return []; }
  return ids.filter(looksLikeJobId).sort((a, b) => b.slice(3).localeCompare(a.slice(3)));
}

// A meta that says "running" is only as honest as its pid: if the wrapper was
// SIGKILLed (harness teardown), nothing finalized the record. Report `stale`
// rather than lying about liveness.
export function liveStatus(meta) {
  if (meta.status !== "running") return meta.status;
  return meta.pid && alive(meta.pid) ? "running" : "stale";
}

const fmtTok = (n) => n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const fmtUsage = (u) =>
  `tok: ${fmtTok(u.inputTokens ?? 0)}→${fmtTok(u.outputTokens ?? 0)}` +
  (u.costUsd != null ? ` · $${u.costUsd.toFixed(2)}` : "");

// The one-line, greppable record of a consult — printed after every reply and
// by `poll`. Always carries the two handles that matter: job id and session id.
export function renderTrailer(meta, status = meta.status) {
  const dir = jobDir(meta.id);
  const bits = [];
  if (status === "running") {
    bits.push("RUNNING", `job: ${meta.id}`, `watch: tail -f ${join(dir, "events.jsonl")}`);
  } else {
    if (status === "failed") bits.push(`FAILED${meta.exitCode != null ? ` (exit ${meta.exitCode})` : ""}`);
    if (status === "killed") bits.push(`KILLED${meta.signal ? ` (${meta.signal})` : ""}`);
    if (status === "stale") bits.push("STALE (wrapper died mid-run)");
    bits.push(`job: ${meta.id}`, `session: ${meta.sessionId ?? "?"}`);
    if (meta.thread) bits.push(`thread: ${meta.thread}`);
    // a thread pointer chases the freshest session id; prefer it as the handle
    if (meta.sessionId) bits.push(`resume: gaslamp ${meta.backend} ${meta.thread ? `--thread ${meta.thread}` : `--resume ${meta.sessionId}`}`);
    if (meta.usage) bits.push(fmtUsage(meta.usage));
    if (status !== "done") bits.push(`log: ${join(dir, "stderr.log")}`);
  }
  return `[gaslamp] ${bits.join(" · ")}`;
}

function promptPreview(id, n = 44) {
  try {
    const line = readFileSync(join(jobDir(id), "prompt.md"), "utf8")
      .split("\n").find((l) => l.trim()) || "";
    const s = line.trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  } catch { return ""; }
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 100 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// gaslamp jobs [-n N] [--json] — newest first, one line per consult.
export function runJobs(argv = []) {
  let n = 20;
  const i = argv.indexOf("-n");
  if (i >= 0) n = Number(argv[i + 1]) || n;
  const ids = listJobIds().slice(0, n);
  if (argv.includes("--json")) {
    const list = ids.map((id) => {
      const m = readMeta(id);
      return m && {
        jobId: m.id, backend: m.backend, status: liveStatus(m), sessionId: m.sessionId ?? null,
        label: m.label ?? null, thread: m.thread ?? null,
        startedAt: m.startedAt ?? null, endedAt: m.endedAt ?? null,
        usage: m.usage ?? null, promptPreview: promptPreview(id, 80),
      };
    }).filter(Boolean);
    process.stdout.write(JSON.stringify(list) + "\n");
    return;
  }
  if (!ids.length) { console.log(`no jobs yet under ${jobsDir()}`); return; }
  for (const id of ids) {
    const m = readMeta(id);
    if (!m) continue;
    const status = liveStatus(m);
    const dur = m.endedAt
      ? fmtDur(new Date(m.endedAt) - new Date(m.startedAt))
      : fmtDur(Date.now() - new Date(m.startedAt)) + (status === "running" ? "…" : "");
    const tags = (m.label ? `[${m.label}] ` : "") + (m.thread ? `@${m.thread} ` : "");
    console.log([
      id.padEnd(23),
      status.padEnd(8),
      (m.sessionId ?? "-").slice(0, 8).padEnd(9),
      dur.padStart(8),
      ` ${tags}${promptPreview(id)}`,
    ].join(" "));
  }
}

// gaslamp poll <job|fleet|--last> [--json] — print one record's reply/status.
// Exit: 0 done · 1 failed/killed/stale · 2 usage · 10 still running.
export function runPoll(argv = []) {
  const json = argv.includes("--json");
  let id = argv.find((a) => !a.startsWith("-"));
  if (!id || argv.includes("--last")) id = listJobIds()[0];
  if (!id) { console.error(`gaslamp poll: no jobs under ${jobsDir()}`); process.exitCode = 2; return; }
  if (looksLikeFleetId(id)) return pollFleet(id, json);
  const m = readMeta(id);
  if (!m) { console.error(`gaslamp poll: no job record ${id}`); process.exitCode = 2; return; }
  const status = liveStatus(m);
  const reply = status === "running" ? null : readReply(id);
  if (json) {
    // The consult envelope shape, recomputed from the record.
    let data = null;
    if (m.schema && reply != null) { try { data = JSON.parse(reply); } catch {} }
    process.stdout.write(JSON.stringify({
      backend: m.backend, jobId: m.id, sessionId: m.sessionId ?? null, status,
      exitCode: m.exitCode ?? null, content: reply ?? "",
      ...(m.label ? { label: m.label } : {}),
      ...(m.thread ? { thread: m.thread } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
      ...(m.schema ? { data } : {}),
    }) + "\n");
    process.exitCode = status === "running" ? 10 : status === "done" ? 0 : 1;
    return;
  }
  if (status === "running") { console.log(renderTrailer(m, status)); process.exitCode = 10; return; }
  if (reply) process.stdout.write(reply.endsWith("\n") ? reply : reply + "\n");
  console.log(renderTrailer(m, status));
  process.exitCode = status === "done" ? 0 : 1;
}

// gaslamp poll <fleet-id> — recompute every child's state from its own record
// (the fleet meta is grouping, not authority) and print each reply.
// Exit: 0 all done · 1 some failed/killed · 2 usage · 10 some still running.
function pollFleet(id, json = false) {
  const fm = readFleetMeta(id);
  if (!fm) { console.error(`gaslamp poll: no fleet record ${id} under ${jobsDir()}`); process.exitCode = 2; return; }
  const children = (fm.children || []).filter((c) => c && c.jobId);
  let running = 0, done = 0, other = 0;
  const out = [], results = [];
  for (const c of children) {
    const m = readMeta(c.jobId);
    const status = m ? liveStatus(m) : "missing";
    if (status === "running") running++;
    else if (status === "done") done++;
    else other++;
    const reply = status === "done" ? readReply(c.jobId) : null;
    if (json) {
      let data = null;
      if (m?.schema && reply != null) { try { data = JSON.parse(reply); } catch {} }
      results.push({
        index: c.index, label: c.label ?? null, jobId: c.jobId,
        sessionId: m?.sessionId ?? null, status, content: reply ?? "",
        ...(m?.usage ? { usage: m.usage } : {}),
        ...(m?.schema ? { data } : {}),
      });
      continue;
    }
    const sid = m?.sessionId ? ` · ${m.sessionId.slice(0, 8)}` : "";
    out.push(`\n━━ [${c.label ?? c.index}] ${status} · ${c.jobId}${sid} ━━`);
    if (reply?.trim()) out.push(reply.trimEnd());
    else if (status !== "running") {
      out.push(`(no reply — ${status})`);
      if (m?.sessionId) out.push(`resume: gaslamp ${m.backend} --resume ${m.sessionId}`);
    }
  }
  if (json) {
    process.stdout.write(JSON.stringify({
      fleetId: id, backend: fm.backend,
      counts: { done, running, other }, results,
    }) + "\n");
  } else {
    if (out.length) process.stdout.write(out.join("\n") + "\n");
    console.log(`[gaslamp fleet] ${id} · ${fm.backend} · ${done}/${children.length} done` +
      (running ? ` · ${running} running` : "") + (other ? ` · ${other} failed/killed` : ""));
  }
  process.exitCode = running ? 10 : (children.length && done === children.length) ? 0 : 1;
}
