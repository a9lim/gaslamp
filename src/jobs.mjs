// jobs.mjs — durable consult records, plus the `jobs` / `poll` readers.
//
// Every consult writes through to a job dir as it runs:
//
//   $GASLAMP_HOME/jobs/<id>/
//     meta.json      backend, status, error, session id, thread, cwd, pid, timing
//     prompt.md      the prompt as sent (the caller's content; no preamble)
//     events.jsonl   the backend's raw event stream
//     stderr.log     the backend's stderr
//     reply.md       the final reply
//     schema.json    the schema as sent (--schema consults)
//     data.json      the parsed reply (--schema consults)
//
// meta.json holds only what gaslamp reads back. Whatever else a harness
// reported (the model, tool calls, usage) is in events.jsonl as it arrived.
//
// The record is passive durability, not a daemon: the blocking `gaslamp
// <backend>` process is the only process. If the caller's harness kills it,
// the record still holds the session id (captured the moment the backend
// reports it), and the conversation can be continued.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BACKENDS, JOB_ID_RE } from "./backends.mjs";

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
// glance: cl-20260612-141233-9af2 (claude), cx-… (codex), gm-… (gemini),
// gk-… (grok).
export function newJobId(backend) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `${BACKENDS[backend].prefix}-${stamp}-${rand}`;
}

export const looksLikeJobId = (s) => JOB_ID_RE.test(String(s));

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

const readText = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

// Newest first. The timestamp follows the 2-char backend prefix, so compare
// past it — pure lexical order would group by backend instead.
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

export const shellQuote = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

// The command that continues a consult's conversation: its thread, else the
// job itself (--resume resolves a job id to its session), with --cwd when the
// conversation lives somewhere other than here.
function continuation(m) {
  const how = m.thread ? `--thread ${m.thread}` : m.sessionId ? `--resume ${m.id}` : null;
  if (!how) return null;
  let here = process.cwd();
  try { here = realpathSync(here); } catch {}
  const where = typeof m.cwd === "string" && isAbsolute(m.cwd) && m.cwd !== here ? ` --cwd ${shellQuote(m.cwd)}` : "";
  return `gaslamp ${m.backend}${where} ${how}`;
}

// The one line printed after every reply and by `poll`.
export function renderTrailer(meta, status = meta.status) {
  if (status === "running") return `[gaslamp] RUNNING · job ${meta.id}`;
  const bits = [];
  if (status !== "done") {
    const why = meta.error ?? (status === "stale" ? "the wrapper died mid-run" : null);
    bits.push(status.toUpperCase() + (why ? `: ${why}` : ""));
  }
  bits.push(`job ${meta.id}`);
  const next = continuation(meta);
  if (next) bits.push(`continue: ${next}`);
  if (status !== "done") bits.push(`log: ${join(jobDir(meta.id), "stderr.log")}`);
  return `[gaslamp] ${bits.join(" · ")}`;
}

// The --json envelope, built from the record on disk — the same object
// whether a consult prints it on completion or `poll --json` prints it later.
export function envelope(meta, status = liveStatus(meta)) {
  const dir = jobDir(meta.id);
  const schema = existsSync(join(dir, "schema.json"));
  const reply = status === "running" ? null : readText(join(dir, "reply.md"));
  let data = null;
  // 2.x wrote no data.json; its schema replies were the JSON itself.
  if (schema) for (const text of [readText(join(dir, "data.json")), reply]) {
    try { data = JSON.parse(text); } catch {}
    if (data != null) break;
  }
  return {
    backend: meta.backend, jobId: meta.id, status, thread: meta.thread ?? null,
    content: reply ?? "",
    ...(meta.error ? { error: meta.error } : {}),
    ...(schema ? { data } : {}),
  };
}

function promptPreview(id, n = 44) {
  const line = (readText(join(jobDir(id), "prompt.md")) ?? "").split("\n").find((l) => l.trim()) ?? "";
  const s = line.trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
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
  const metas = listJobIds().slice(0, n).map(readMeta).filter(Boolean);
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(metas.map((m) => ({
      jobId: m.id, backend: m.backend, status: liveStatus(m), thread: m.thread ?? null,
      startedAt: m.startedAt ?? null, endedAt: m.endedAt ?? null, promptPreview: promptPreview(m.id, 80),
    }))) + "\n");
    return;
  }
  if (!metas.length) { console.log(`no jobs yet under ${jobsDir()}`); return; }
  for (const m of metas) {
    const status = liveStatus(m);
    const dur = m.endedAt
      ? fmtDur(new Date(m.endedAt) - new Date(m.startedAt))
      : fmtDur(Date.now() - new Date(m.startedAt)) + (status === "running" ? "…" : "");
    console.log([
      m.id.padEnd(23),
      status.padEnd(7),
      dur.padStart(7),
      ` ${m.thread ? `@${m.thread} ` : ""}${promptPreview(m.id)}`,
    ].join(" "));
  }
}

// gaslamp poll <job|--last> [--json] — print one record's reply and trailer.
// Exit: 0 done · 1 failed/killed/stale · 2 usage · 10 still running.
export function runPoll(argv = []) {
  let id = argv.find((a) => !a.startsWith("-"));
  if (!id || argv.includes("--last")) id = listJobIds()[0];
  if (!id) { console.error(`gaslamp poll: no jobs under ${jobsDir()}`); process.exitCode = 2; return; }
  const m = readMeta(id);
  if (!m) { console.error(`gaslamp poll: no job record ${id}`); process.exitCode = 2; return; }
  const status = liveStatus(m);
  process.exitCode = status === "running" ? 10 : status === "done" ? 0 : 1;
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(envelope(m, status)) + "\n");
    return;
  }
  const reply = status === "running" ? null : readText(join(jobDir(id), "reply.md"));
  if (reply) process.stdout.write(reply.endsWith("\n") ? reply : reply + "\n");
  console.log(renderTrailer(m, status));
}
