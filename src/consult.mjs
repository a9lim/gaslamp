// consult.mjs — the heart of gaslamp 2.0: one blocking consult, spawned as a
// shell child of whichever agent called it.
//
//   gaslamp claude [opts] <prompt|->    spawns `claude -p`
//   gaslamp codex  [opts] <prompt|->    spawns `codex exec`
//
// Block-until-reply, deliberately: asynchrony is the HARNESS's job. Each agent
// backgrounds the shell call with its own facility (Claude Code:
// run_in_background; Codex: its background terminal) and is told when it
// finishes — so consults run in parallel and replies trickle in, with no
// daemon, no job spool, and no second async layer inside gaslamp.
//
// What survives of a spool is passive write-through durability (see jobs.mjs):
// every consult records prompt/events/reply/stderr as it runs, and the session
// id is captured the moment the backend reports it. If the harness kills the
// wrapper we kill the whole child process group — deliberate orphans would
// invisibly double-burn API quota — and recovery is `--resume <session>`, not
// a surviving child.
//
// The recursion guard is ONE mechanism now (1.0 needed two): children are
// spawned with GASLAMP_NESTED=1 and the consult verbs refuse under it. A
// consult is one hop; GASLAMP_ALLOW_RECURSION=1 opts out. For Codex the
// sentinel is *also* forced into its shell env via
// `-c shell_environment_policy.set.GASLAMP_NESTED="1"`, because a
// `shell_environment_policy` with `inherit = "core"` would otherwise strip it
// before any nested `gaslamp` call could see it. (The dotted leaf MERGES with
// the user's [shell_environment_policy.set] table — verified on codex 0.139 —
// it does not replace it.) It is loop prevention, not a security boundary: a
// shell-capable agent could unset the env var.
//
// Exit codes (also in --help):
//   0 reply delivered · 1 consult failed or killed · 2 usage · 3 nested
//   (one-hop) refusal · 4 network-disabled sandbox · 5 session busy

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./which.mjs";
import {
  alive, createJob, jobDir, jobsDir, locksDir, looksLikeJobId,
  newJobId, readMeta, renderTrailer, writeMeta,
} from "./jobs.mjs";

// Tools permitted under the claude `read-only` override (advisory reviewer).
const ALLOWED_TOOLS = (process.env.GASLAMP_ALLOWED_TOOLS || "Read Grep Glob WebFetch WebSearch")
  .split(/[\s,]+/).filter(Boolean).join(",");
const ALLOW_RECURSION = !!process.env.GASLAMP_ALLOW_RECURSION;
const DEBUG = !!process.env.GASLAMP_DEBUG;
const log = (...a) => { if (DEBUG) writeSync(2, "[gaslamp] " + a.join(" ") + "\n"); };

// writeSync(2, …) so the message lands even through process.exit (stderr to a
// pipe is async in Node; a plain write could be truncated).
const die = (code, msg) => { writeSync(2, `gaslamp: ${msg}\n`); process.exit(code); };

const SANDBOXES = {
  claude: ["read-only", "danger-full-access"],
  codex: ["read-only", "workspace-write", "danger-full-access"],
};

function resolveBin(backend) {
  if (backend === "claude") {
    for (const c of [process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude")].filter(Boolean))
      if (existsSync(c)) return c;
    return which("claude") || "claude";
  }
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  return which("codex") || "codex";
}

function parseArgs(argv) {
  const o = { json: false, prompt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) die(2, `${a} needs a value`); return argv[++i]; };
    if (a === "--resume" || a === "-r") o.resume = val();
    else if (a === "--model" || a === "-m") o.model = val();
    else if (a === "--sandbox" || a === "-s") o.sandbox = val();
    else if (a === "--cwd" || a === "-C") o.cwd = val();
    else if (a === "--json") o.json = true;
    else if (a === "-") o.prompt = "-";
    else if (a.startsWith("-") && a.length > 1) die(2, `unknown flag ${a} (see gaslamp --help)`);
    else if (o.prompt == null) o.prompt = a;
    else die(2, "more than one prompt argument — quote the prompt, or pipe it on stdin");
  }
  return o;
}

// Map --resume to a concrete session id. Accepts a prior JOB id too (the
// handle the caller usually has at hand) and resolves it via the job record.
function resolveResume(backend, resume) {
  if (!looksLikeJobId(resume)) return resume;
  const m = readMeta(resume);
  if (!m) die(2, `no job record ${resume} under ${jobsDir()}`);
  if (m.backend !== backend)
    die(2, `job ${resume} was a ${m.backend} consult — use \`gaslamp ${m.backend} --resume ${resume}\``);
  if (!m.sessionId)
    die(2, `job ${resume} recorded no session id (it ${m.status === "running" ? "is still starting" : "died before the backend reported one"})`);
  return m.sessionId;
}

// Two concurrent consults resuming the SAME session is undefined behavior on
// both backends, so it's refused (exit 5). Lockfiles are atomic-create
// (flag "wx"); a lock whose holder pid is dead is stale — reap and retry.
function acquireLock(backend, sid, jobId) {
  mkdirSync(locksDir(), { recursive: true });
  const path = join(locksDir(), `${backend}--${sid}`);
  const payload = JSON.stringify({ pid: process.pid, job: jobId, at: new Date().toISOString() }) + "\n";
  for (let attempt = 0; attempt < 3; attempt++) {
    try { writeFileSync(path, payload, { flag: "wx" }); return path; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null;
      try { holder = JSON.parse(readFileSync(path, "utf8")); } catch { /* malformed = stale */ }
      if (holder?.pid && alive(holder.pid))
        die(5, `session ${sid} is busy — job ${holder.job ?? "?"} (pid ${holder.pid}) is mid-consult on it. \`gaslamp poll ${holder.job ?? "--last"}\` to watch, or wait for it.`);
      try { unlinkSync(path); } catch { /* raced another reaper */ }
    }
  }
  die(5, `could not acquire the lock for session ${sid} under ${locksDir()}`);
}

function claudeArgs(o, resumeSid) {
  // stream-json (not plain json) so events land incrementally: the session id
  // arrives in the init event within seconds, and the write-through record
  // survives a killed wrapper. Plain json would buffer everything to the end.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (o.sandbox === "read-only") {
    // --permission-mode default overrides the user's defaultMode (even
    // bypass); the allowlist restricts to read tools. A real read-only.
    args.push("--permission-mode", "default", "--allowedTools", ALLOWED_TOOLS);
  } else if (o.sandbox === "danger-full-access") {
    args.push("--dangerously-skip-permissions");
  }
  // else: no permission flag — the consulted Claude uses the user's own
  // ~/.claude config, mirroring Codex deferring to config.toml.

  if (resumeSid) args.push("--resume", resumeSid);
  if (o.model) args.push("--model", o.model);
  return args; // prompt goes on stdin
}

function codexArgs(o, resumeSid, replyPath) {
  const args = ["exec"];
  if (resumeSid) args.push("resume", resumeSid);
  // -o is the authoritative reply text (the JSONL item schema is less stable);
  // --json is the session-id channel (thread.started arrives up front).
  args.push("--json", "-o", replyPath, "--skip-git-repo-check");
  // Force the sentinel into the consulted Codex's shell env (see header).
  args.push("-c", 'shell_environment_policy.set.GASLAMP_NESTED="1"');
  // `codex exec resume` has no -s flag; -c sandbox_mode works on both forms.
  if (o.sandbox) args.push("-c", `sandbox_mode="${o.sandbox}"`);
  if (o.model) args.push("-m", o.model);
  args.push("-"); // prompt on stdin, always — no argv-size or quoting traps
  return args;
}

export function runConsult(backend, argv) {
  const o = parseArgs(argv);

  // ---- preflights -----------------------------------------------------------
  if (process.env.GASLAMP_NESTED && !ALLOW_RECURSION)
    die(3, "this agent is itself a gaslamp consult — a consult is one hop. (GASLAMP_ALLOW_RECURSION=1 opts out.)");
  // Codex sets this in sandboxed shell envs when network is off. Neither
  // backend could phone home, so refuse pointedly instead of timing out.
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1")
    die(4, "network is disabled in this sandbox (CODEX_SANDBOX_NETWORK_DISABLED=1) — a consulted agent could reach neither Anthropic nor OpenAI. Re-run with network access (escalated permissions, or sandbox_mode/network_access in ~/.codex/config.toml).");

  if (o.sandbox && !SANDBOXES[backend].includes(o.sandbox)) {
    die(2, backend === "claude" && o.sandbox === "workspace-write"
      ? "claude has no filesystem sandbox, so there is no honest workspace-write — use read-only, danger-full-access, or omit --sandbox to defer to the user's own config"
      : `bad --sandbox "${o.sandbox}" (${backend}: ${SANDBOXES[backend].join(" | ")})`);
  }

  // ---- prompt (argv, or stdin via `-` / piped-with-no-arg) -------------------
  let prompt = o.prompt;
  if (prompt == null || prompt === "-") {
    if (prompt == null && process.stdin.isTTY) die(2, "no prompt — pass one as an argument or pipe it on stdin");
    prompt = readFileSync(0, "utf8");
  }
  if (!prompt.trim()) die(2, "empty prompt");

  // ---- resume + lock ---------------------------------------------------------
  const resumeSid = o.resume ? resolveResume(backend, o.resume) : null;
  const id = newJobId(backend);
  let lockPath = resumeSid ? acquireLock(backend, resumeSid, id) : null;
  const releaseLock = () => { if (lockPath) { try { unlinkSync(lockPath); } catch {} lockPath = null; } };

  // ---- job record ------------------------------------------------------------
  const dir = jobDir(id);
  const meta = {
    id, backend, status: "running",
    sessionId: resumeSid, resumedFrom: resumeSid,
    model: o.model ?? null, sandbox: o.sandbox ?? null,
    cwd: o.cwd || process.cwd(),
    pid: process.pid, childPid: null, exitCode: null, signal: null,
    startedAt: new Date().toISOString(), endedAt: null,
    promptChars: prompt.length,
  };
  createJob(meta, prompt);

  // ---- spawn -----------------------------------------------------------------
  const bin = resolveBin(backend);
  const replyPath = join(dir, "reply.md");
  const args = backend === "claude" ? claudeArgs(o, resumeSid) : codexArgs(o, resumeSid, replyPath);

  const env = { ...process.env, GASLAMP_NESTED: "1" };
  // Keychain OAuth is authoritative for the consulted Claude: a stale env key
  // 401s every call (1.0's hardest auth lesson). No Codex analog needed.
  if (backend === "claude") delete env.ANTHROPIC_API_KEY;

  log("spawn", bin, JSON.stringify(args));
  // detached → the child leads its own process group, so signal forwarding can
  // kill the whole tree (backend + whatever it spawned), never just the top.
  const child = spawn(bin, args, { cwd: meta.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  meta.childPid = child.pid ?? null;
  writeMeta(meta);

  writeSync(2, `[gaslamp] → ${backend} · job ${id} · watch: tail -f ${join(dir, "events.jsonl")}\n`);

  // Early machine receipt for the fleet runner (gated on GASLAMP_FLEET, which the
  // fleet sets on its children): the parent records each child's job id the
  // moment it spawns — durable even if the fleet is killed mid-run — without
  // scraping the human stderr breadcrumb. The lone --json line is the envelope
  // (it carries `backend`/`status`); this receipt carries `type:"started"`.
  if (o.json && process.env.GASLAMP_FLEET === "1")
    process.stdout.write(JSON.stringify({ type: "started", jobId: id, childPid: meta.childPid }) + "\n");

  child.stdin.on("error", () => {}); // EPIPE if the child dies before reading
  child.stdin.write(prompt);
  child.stdin.end();

  const events = createWriteStream(join(dir, "events.jsonl"), { flags: "a" });
  const errlog = createWriteStream(join(dir, "stderr.log"), { flags: "a" });
  child.stderr.on("data", (d) => errlog.write(d));

  // ---- event stream: write through; fish out session id + reply --------------
  let buf = "", resultText = null, resultErr = false, lastAgentText = null;
  child.stdout.on("data", (d) => {
    events.write(d);
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const sid = backend === "claude"
        ? ((j.type === "system" && j.subtype === "init") || j.type === "result" ? j.session_id : null)
        : (j.type === "thread.started" ? (j.thread_id ?? j.threadId) : null);
      if (sid && meta.sessionId !== sid) { meta.sessionId = sid; writeMeta(meta); } // early: the recovery handle
      if (backend === "claude" && j.type === "result") {
        resultText = j.result ?? j.content ?? null;
        resultErr = !!j.is_error;
      } else if (backend === "codex" && j.type === "item.completed") {
        // Tolerant fallback if -o never lands (schema drift across versions).
        const item = j.item ?? {};
        if ((item.type === "agent_message" || item.item_type === "agent_message") && typeof item.text === "string")
          lastAgentText = item.text;
      }
    }
  });

  // ---- signals: kill the group, finalize, no orphans --------------------------
  let killedBy = null;
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); }
    catch { try { child.kill(sig); } catch {} }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (killedBy) return killGroup("SIGKILL");
      killedBy = sig;
      writeSync(2, `[gaslamp] ${sig} — stopping job ${id}; the session survives, recover with --resume\n`);
      killGroup(sig);
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    });
  }

  const finalize = (status, code) => {
    if (meta.status !== "running") return;
    meta.status = status;
    meta.exitCode = code;
    meta.signal = killedBy;
    meta.endedAt = new Date().toISOString();
    if (backend === "claude" && resultText != null) writeFileSync(replyPath, String(resultText));
    if (backend === "codex" && !existsSync(replyPath) && lastAgentText != null) writeFileSync(replyPath, lastAgentText);
    writeMeta(meta);
    releaseLock();
  };

  child.on("error", (e) => {
    finalize("failed", null);
    die(1, `failed to launch ${bin}: ${e.message}`);
  });

  child.on("close", (code) => {
    events.end();
    errlog.end();
    finalize(killedBy ? "killed" : (code !== 0 || resultErr) ? "failed" : "done", code);
    const reply = existsSync(replyPath) ? readFileSync(replyPath, "utf8") : null;
    if (o.json) {
      process.stdout.write(JSON.stringify({
        backend, jobId: id, sessionId: meta.sessionId, status: meta.status,
        exitCode: code, content: reply ?? "",
      }) + "\n");
    } else {
      if (reply) process.stdout.write(reply.endsWith("\n") ? reply : reply + "\n");
      if (!reply && meta.status !== "done") {
        try { // surface the stderr tail so a failure isn't a shrug
          const tail = readFileSync(join(dir, "stderr.log"), "utf8").trim().split("\n").slice(-6).join("\n");
          if (tail) writeSync(2, tail + "\n");
        } catch {}
      }
      process.stdout.write(renderTrailer(meta) + "\n");
    }
    // exitCode (not exit()) so stdout drains; nothing else holds the loop open.
    process.exitCode = meta.status === "done" ? 0 : 1;
  });
}
