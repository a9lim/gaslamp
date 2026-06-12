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

// Job ids embed the backend and a local timestamp, so they sort chronologically
// (within a backend) and read at a glance: cl-20260612-141233-9af2
export function newJobId(backend) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `${backend === "claude" ? "cl" : "cx"}-${stamp}-${rand}`;
}

export const looksLikeJobId = (s) => /^(cl|cx)-\d{8}-\d{6}-[0-9a-f]{4}$/.test(String(s));

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
    if (meta.sessionId) bits.push(`resume: gaslamp ${meta.backend} --resume ${meta.sessionId}`);
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

// gaslamp jobs [-n N] — newest first, one line per consult.
export function runJobs(argv = []) {
  let n = 20;
  const i = argv.indexOf("-n");
  if (i >= 0) n = Number(argv[i + 1]) || n;
  const ids = listJobIds().slice(0, n);
  if (!ids.length) { console.log(`no jobs yet under ${jobsDir()}`); return; }
  for (const id of ids) {
    const m = readMeta(id);
    if (!m) continue;
    const status = liveStatus(m);
    const dur = m.endedAt
      ? fmtDur(new Date(m.endedAt) - new Date(m.startedAt))
      : fmtDur(Date.now() - new Date(m.startedAt)) + (status === "running" ? "…" : "");
    console.log([
      id.padEnd(23),
      status.padEnd(8),
      (m.sessionId ?? "-").slice(0, 8).padEnd(9),
      dur.padStart(8),
      ` ${promptPreview(id)}`,
    ].join(" "));
  }
}

// gaslamp poll <job|--last> — print one record's reply/status.
// Exit: 0 done · 1 failed/killed/stale · 2 usage · 10 still running.
export function runPoll(argv = []) {
  let id = argv.find((a) => !a.startsWith("-"));
  if (!id || argv.includes("--last")) id = listJobIds()[0];
  if (!id) { console.error(`gaslamp poll: no jobs under ${jobsDir()}`); process.exitCode = 2; return; }
  const m = readMeta(id);
  if (!m) { console.error(`gaslamp poll: no job record ${id}`); process.exitCode = 2; return; }
  const status = liveStatus(m);
  if (status === "running") { console.log(renderTrailer(m, status)); process.exitCode = 10; return; }
  const reply = readReply(id);
  if (reply) process.stdout.write(reply.endsWith("\n") ? reply : reply + "\n");
  console.log(renderTrailer(m, status));
  process.exitCode = status === "done" ? 0 : 1;
}
