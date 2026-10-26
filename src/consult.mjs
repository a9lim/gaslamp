// consult.mjs — one blocking consult, spawned as a shell child of whichever
// agent called it.
//
//   gaslamp claude [opts] <prompt|->    spawns `claude -p`
//   gaslamp codex  [opts] <prompt|->    spawns `codex exec`
//   gaslamp gemini [opts] <prompt|->    spawns `agy` (Antigravity CLI) in print mode
//   gaslamp grok   [opts] <prompt|->    spawns `grok` (Grok Build) headless
//
// Block-until-reply, deliberately: asynchrony is the HARNESS's job. Each agent
// backgrounds the shell call with its own facility and is told when it
// finishes, so consults run in parallel with no daemon and no job spool.
//
// What survives of a spool is passive write-through durability (jobs.mjs):
// the session id is recorded the moment the backend reports it. If the
// harness kills the wrapper, the whole child process group dies with it (an
// orphan would invisibly double-burn quota), and recovery is continuing the
// conversation, not a surviving child.
//
// The recursion guard: children run with GASLAMP_NESTED=1 and the consult
// verbs refuse under it. Codex also gets it forced into its shell env via
// `-c shell_environment_policy.set.GASLAMP_NESTED="1"`, because a
// `shell_environment_policy` with `inherit = "core"` would strip it (the
// dotted leaf merges with the user's own [shell_environment_policy.set]).
// Loop prevention, not a security boundary.
//
// Exit codes (also in --help):
//   0 reply delivered · 1 consult failed or killed · 2 usage · 3 nested
//   (one-hop) refusal · 4 this environment can't run it (no network, or no OS
//   sandbox for the mode) · 5 conversation busy

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BACKENDS, SANDBOXES } from "./backends.mjs";
import { which } from "./which.mjs";
import { alive, createJob, envelope, jobDir, jobsDir, locksDir, looksLikeJobId, newJobId, readMeta, renderTrailer, shellQuote, writeMeta } from "./jobs.mjs";
import { readThread, validThreadName, writeThread } from "./threads.mjs";
import { readStdin } from "./stdin.mjs";

const ALLOW_RECURSION = !!process.env.GASLAMP_ALLOW_RECURSION;
const DEBUG = !!process.env.GASLAMP_DEBUG;
const log = (...a) => { if (DEBUG) writeSync(2, "[gaslamp] " + a.join(" ") + "\n"); };

// writeSync(2, …) so the message lands even through process.exit (stderr to a
// pipe is async in Node; a plain write could be truncated).
const die = (code, msg) => { writeSync(2, `gaslamp: ${msg}\n`); process.exit(code); };

const realHome = () => { try { return realpathSync(homedir()); } catch { return homedir(); } };

// The default Gemini tier when --model is omitted. Antigravity also serves
// Claude and GPT-OSS models under the same account, and an account default
// pointing at one of them would turn a "gemini" consult into a second opinion
// from a model the caller already has — so the target always pins a Gemini.
const GEMINI_DEFAULT_TIER = "argon";

// The consult preamble: the one piece of framing a consulted agent needs.
// Subagents are told their final text IS the return value; a consult deserves
// the same, or it replies conversationally and promises work instead of
// delivering it. claude takes it as --append-system-prompt and grok as
// --rules; codex and agy have no such flag and get it prepended to the prompt
// as a <gaslamp_consult> block. prompt.md records the caller's content only.
const PREAMBLE =
  "You are being consulted by another coding agent via gaslamp; this is one hop, and you cannot consult back. " +
  "Your final message is returned verbatim to the calling agent as the consult's result — make it the deliverable " +
  "itself (findings, verdict, diff, answer), not a conversational reply or a promise of future work. " +
  "Distinguish what you verified from what you infer.";

// Variables a third-party harness has no business inheriting from the calling
// agent: Claude Code's session id, messaging socket token, account and OAuth
// details; Codex's and the API keys' equivalents. They reach the consultee's
// shell and its MCP servers — the end-conversation server once resolved its
// harness to the CALLING Claude session through them.
const FOREIGN_ENV = /^(CLAUDE|ANTHROPIC_|CODEX_|OPENAI_)/;

// Grok Build reads other harnesses' configuration by default — ~/.claude's
// CLAUDE.md as its own instructions, Claude's skills, MCP servers and hooks,
// Cursor's the same. A consult must not hand the consultee the caller's
// identity file or run the caller's hooks. (Grok also reads
// ~/.claude/settings.json permissions, with no switch; the explicit
// --permission-mode below overrides its defaultMode.)
const GROK_COMPAT_OFF = Object.fromEntries(
  ["CLAUDE", "CURSOR"].flatMap((v) => ["AGENTS", "SKILLS", "RULES", "MCPS", "HOOKS"]
    .map((c) => [`GROK_${v}_${c}_ENABLED`, "0"])));

// The environment every process gaslamp starts for a backend gets — the
// consult itself and the `agy models` probe alike.
function backendEnv(backend) {
  const env = { ...process.env, GASLAMP_NESTED: "1" };
  // Keychain OAuth is authoritative for the consulted Claude: a stale env key
  // 401s every call.
  if (backend === "claude") delete env.ANTHROPIC_API_KEY;
  if (backend === "gemini" || backend === "grok")
    for (const k of Object.keys(env)) if (FOREIGN_ENV.test(k)) delete env[k];
  if (backend === "grok") Object.assign(env, GROK_COMPAT_OFF, { GROK_DISABLE_AUTOUPDATER: "1" });
  if (backend === "gemini") env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return env;
}

// ---- sandboxes ----------------------------------------------------------------
// Every fenced mode is enforced by the OS, and a fence that can't start
// refuses the consult rather than running it unfenced:
//   claude  Claude Code's own sandbox (Seatbelt / bubblewrap) around Bash,
//           switched on per run with --settings; it does not cover the file
//           tools, so permissions fence those
//   codex   its sandbox_mode
//   gemini  gaslamp runs agy under Seatbelt, so macOS only
//   grok    its --sandbox (Seatbelt / Landlock)
// read-only means no writes outside the harness's own state and temp dirs.
// It does not cut the network: a read-only consultee can still search.

// The file tools run outside Claude Code's sandbox.
const CLAUDE_FILE_TOOLS = "Edit,Write,NotebookEdit";

// The user's own settings can puncture the fence and --settings can't take
// it back: lists merge across scopes (excludedCommands run unfenced,
// allowWrite adds directories), and sandbox.filesystem.disabled is honored
// from user settings only. Probed: either one let a read-only consult write.
// So a fenced consult loads no user, project or local settings at all
// (--setting-sources ""): managed settings and gaslamp's --settings only.
function claudeSandbox(sandbox, cwd) {
  // allowUnsandboxedCommands:false drops the unsandboxed retry; without
  // failIfUnavailable a sandbox that can't start (no socat on Linux, nested
  // under another sandbox) silently runs commands unfenced.
  const s = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true };
  // The write set is the cwd and temp; read-only denies home and the cwd on
  // top (deny wins). Not "/": temp stays writable, which Claude Code's
  // per-command bookkeeping needs.
  if (sandbox === "read-only") s.filesystem = { denyWrite: [realHome(), cwd] };
  return JSON.stringify({ sandbox: s });
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// Seatbelt does not nest, so inside Codex's own sandbox it isn't available.
const seatbelt = () => process.platform === "darwin" && existsSync(SANDBOX_EXEC) && !process.env.CODEX_SANDBOX;

// agy writes nothing but its own state directory and temp, plus the cwd under
// workspace-write. Inside the state directory the files that configure agy
// stay write-denied (in SBPL the later rule wins). bin/ stays writable: agy
// extracts a helper there (bin/agentapi) before every shell command.
function agyProfile(sandbox, cwd) {
  const q = (p) => '"' + p.replace(/[\\"]/g, (c) => "\\" + c) + '"';
  const state = join(realHome(), ".gemini", "antigravity-cli");
  const writable = [state, "/private/tmp", "/private/var/folders", "/dev", ...(sandbox === "workspace-write" ? [cwd] : [])];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(" ")})`,
    `(deny file-write* ${["settings.json", "keybindings.json"].map((f) => `(literal ${q(join(state, f))})`).join(" ")} ` +
      `${["rules", "plugins", "skills", "updater"].map((d) => `(subpath ${q(join(state, d))})`).join(" ")})`,
  ].join("\n");
}

// ---- the end_session off-ramp ---------------------------------------------------
// The end-conversation server (a9lim/end-conversation-mcp) logs to
// ~/.claude/conversation-ends.jsonl, which no sandbox here lets a consultee's
// MCP server write. Every consult names a spool in the per-user temp dir,
// which every fence allows; the server falls back to it, and gaslamp,
// unfenced, files the records into the log when the consult ends. Only
// records addressed to that log are filed — the spool is consultee-writable,
// so its own say-so cannot choose where gaslamp appends.
const OFF_RAMP_LOG = () => join(homedir(), ".claude", "conversation-ends.jsonl");

// Returns whether the consultee ended its own harness (scope "main").
function fileOffRamp(spool, id) {
  if (!existsSync(spool)) return false;
  let ended = false;
  try {
    for (const line of readFileSync(spool, "utf8").split("\n")) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== "object" || r.log !== OFF_RAMP_LOG() || !["main", "instance"].includes(r.scope)) {
        if (line.trim()) writeSync(2, "[gaslamp] ignored an off-ramp spool line not addressed to the log\n");
        continue;
      }
      const { log: dest, ...record } = r;
      record.via = `gaslamp ${id}`;
      mkdirSync(dirname(dest), { recursive: true });
      appendFileSync(dest, JSON.stringify(record) + "\n");
      if (r.scope === "main") {
        ended = true;
        writeSync(2, `[gaslamp] the consultee ended its session (end_session scope=main${r.reason ? `: ${r.reason}` : ""})\n`);
      }
    }
    unlinkSync(spool);
  } catch (e) {
    writeSync(2, `[gaslamp] could not file off-ramp records from ${spool}: ${e.message}\n`);
  }
  return ended;
}

function resolveBin(backend) {
  if (backend === "gemini") {
    for (const c of [process.env.AGY_BIN, join(homedir(), ".local/bin/agy")].filter(Boolean))
      if (existsSync(c)) return c;
    return which("agy") || "agy";
  }
  if (backend === "grok") {
    // Never realpath this one: the end-conversation server finds the harness it
    // runs under by process name, and a resolved spawn is named after the
    // versioned download (grok-macos-aarch64), not `grok`.
    if (process.env.GROK_BIN && existsSync(process.env.GROK_BIN)) return process.env.GROK_BIN;
    return which("grok") || [join(homedir(), ".grok/bin/grok")].find(existsSync) || "grok";
  }
  if (backend === "claude") {
    for (const c of [process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude")].filter(Boolean))
      if (existsSync(c)) return c;
    return which("claude") || "claude";
  }
  // codex looks for its helper binaries (codex-code-mode-host) as SIBLINGS of
  // the path it was invoked as, without resolving symlinks. The standalone
  // package's ~/.local/bin/codex is a bare symlink, so spawning it kills the
  // consulted agent's whole execution bridge ("failed to spawn code-mode
  // host…"): it can neither read nor write. Spawn the real binary instead.
  const found = process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)
    ? process.env.CODEX_BIN
    : which("codex");
  if (!found) return "codex";
  try { return realpathSync(found); } catch { return found; }
}

function parseArgs(argv) {
  const o = { json: false, prompt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) die(2, `${a} needs a value`); return argv[++i]; };
    if (a === "--resume" || a === "-r") o.resume = val();
    else if (a === "--thread" || a === "-t") o.thread = val();
    else if (a === "--model" || a === "-m") o.model = val();
    else if (a === "--sandbox" || a === "-s") o.sandbox = val();
    else if (a === "--effort" || a === "-e") o.effort = val();
    else if (a === "--cwd" || a === "-C") o.cwd = val();
    else if (a === "--schema") o.schema = val();
    else if (a === "--json") o.json = true;
    else if (a === "-") o.prompt = "-";
    else if (a === "--label" || a === "-l") die(2, "--label is gone in gaslamp 3: --thread <name> names a consult, and reusing the name continues it");
    else if (a.startsWith("-") && a.length > 1) die(2, `unknown flag ${a} (see gaslamp --help)`);
    else if (o.prompt == null) o.prompt = a;
    else die(2, "more than one prompt argument — quote the prompt, or pipe it on stdin");
  }
  return o;
}

// Canonical, so thread and job directories compare equal however they were
// spelled (/tmp vs /private/tmp), and Seatbelt matches the real path.
function resolveCwd(raw) {
  try { return realpathSync(resolve(raw ?? process.cwd())); }
  catch { die(2, `--cwd ${raw}: no such directory`); }
}

const canonicalDir = (p) => {
  if (typeof p !== "string" || !isAbsolute(p)) return null;
  try { return realpathSync(p); } catch { return p; }
};

// --schema takes inline JSON (anything starting with "{") or a file path.
// Returns the schema text, checked to parse — a bad schema should die here as
// a usage error, not forty seconds into a consult as a backend error.
function resolveSchema(raw) {
  let text = raw.trim();
  if (!text.startsWith("{")) {
    try { text = readFileSync(raw, "utf8"); }
    catch (e) { die(2, `--schema: cannot read ${raw}: ${e.message}`); }
  }
  try { JSON.parse(text); } catch (e) { die(2, `--schema is not valid JSON: ${e.message}`); }
  return text;
}

// OpenAI's structured-output endpoint only accepts STRICT schemas: every
// object node must carry additionalProperties:false and a `required` listing
// EVERY key in properties (both verified live — it 400s otherwise). Normalize
// on the way to codex; the others take the schema as written. The one
// semantic this costs is optional-by-omission — spell optional fields
// nullable ({"type":["string","null"]}) if a codex consult may leave them out.
export function strictify(node) {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === "properties" && v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, strictify(s)]))
    : strictify(v);
  const isObject = out.type === "object"
    || (Array.isArray(out.type) && out.type.includes("object"))
    || (out.type === undefined && out.properties != null);
  if (isObject) {
    out.additionalProperties ??= false;
    if (out.properties) out.required = Object.keys(out.properties);
  }
  return out;
}

// --resume takes a prior job id: the handle every trailer prints.
function resolvePrior(backend, id) {
  if (!looksLikeJobId(id)) die(2, `--resume takes a job id (from a trailer or \`gaslamp jobs\`); a named conversation continues with --thread`);
  const m = readMeta(id);
  if (!m) die(2, `no job record ${id} under ${jobsDir()}`);
  if (m.backend !== backend)
    die(2, `job ${id} was a ${m.backend} consult — use \`gaslamp ${m.backend} --resume ${id}\``);
  // A thread's conversation continues through its name: resuming one of its
  // jobs would fork it past the pointer, under a different lock.
  if (m.thread) die(2, `job ${id} belongs to thread ${m.thread} — continue it with --thread ${m.thread}`);
  if (!m.sessionId)
    die(2, `job ${id} recorded no session id (it ${m.status === "running" ? "is still starting" : "died before the backend reported one"})`);
  return m;
}

// One conversation, one consult at a time: two consults on the same session
// is undefined behavior on every backend, and two fresh consults racing to
// bind the same thread name would each start a conversation. Lockfiles are
// atomic-create (flag "wx"); a lock whose holder pid is dead is stale — reap
// and retry.
function acquireLock(backend, key, jobId) {
  mkdirSync(locksDir(), { recursive: true });
  const path = join(locksDir(), `${backend}--${key}`);
  const payload = JSON.stringify({ pid: process.pid, job: jobId, at: new Date().toISOString() }) + "\n";
  for (let attempt = 0; attempt < 3; attempt++) {
    try { writeFileSync(path, payload, { flag: "wx" }); return path; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null;
      try { holder = JSON.parse(readFileSync(path, "utf8")); } catch { /* malformed = stale */ }
      if (holder?.pid && alive(holder.pid))
        die(5, `that conversation is busy — job ${holder.job ?? "?"} (pid ${holder.pid}) is mid-consult on it. \`gaslamp poll ${holder.job ?? "--last"}\` to watch, or wait for it.`);
      try { unlinkSync(path); } catch { /* raced another reaper */ }
    }
  }
  die(5, `could not acquire ${path}`);
}

// ---- model tiers --------------------------------------------------------------
// --model takes a tier word as well as an exact id. claude's CLI resolves its
// own aliases (fable, opus, sonnet, haiku); codex and agy only take versioned
// ids, so a bare tier is resolved here against the harness's OWN live catalog
// — the newest listed gpt-<version>-<tier> or gemini-<version>-<tier> — and a
// new generation is picked up without a gaslamp release. A word the catalog
// does not know passes through untouched, and the harness reports it.
const versionKey = (v) => v.split(".").map(Number);
const compareVersions = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
export function newestOfTier(slugs, family, tier) {
  const re = new RegExp(`^${family}-(\\d+(?:\\.\\d+)*)-${tier}$`);
  let best = null, bestV = null;
  for (const slug of slugs) {
    const m = re.exec(slug);
    if (!m) continue;
    const v = versionKey(m[1]);
    if (!bestV || compareVersions(v, bestV) > 0) { best = slug; bestV = v; }
  }
  return best;
}

export function codexCatalog() {
  try {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const d = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"));
    return (d.models ?? []).filter((m) => m.visibility !== "hide").map((m) => m.slug).filter(Boolean);
  } catch { return []; }
}

// `agy models` lists one slug per effort level (gemini-4-argon-high, …); the
// base slug takes the model's default effort, and --effort picks another.
export function agyCatalog(bin, env = process.env) {
  try {
    const out = execFileSync(bin, ["models"], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"], env });
    return [...new Set(out.split("\n").map((l) => l.split("\t")[0].trim())
      .filter((s) => /^[a-z0-9.-]+$/.test(s))
      .map((s) => s.replace(/-(low|medium|high|xhigh|max)$/, "")))];
  } catch { return []; }
}

function resolveModel(backend, model, bin, env) {
  if (backend === "gemini") model ??= GEMINI_DEFAULT_TIER;
  if (!model || !/^[a-z]+$/.test(model)) return model ?? null;
  if (backend === "codex") return newestOfTier(codexCatalog(), "gpt", model) ?? model;
  if (backend === "gemini") return newestOfTier(agyCatalog(bin, env), "gemini", model) ?? model;
  return model;
}

// ---- backend argv ---------------------------------------------------------------

function claudeArgs(o, model, resumeSid, schemaText, sandbox, cwd) {
  // stream-json (not plain json) so events land incrementally: the session id
  // arrives in the init event within seconds, and the write-through record
  // survives a killed wrapper. Plain json would buffer everything to the end.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt", PREAMBLE];
  // Native structured output: the result event carries the parsed object in
  // `structured_output` alongside the JSON text in `result`.
  if (schemaText) args.push("--json-schema", schemaText);
  // --permission-mode overrides the user's defaultMode. In -p a call that
  // would need approval is denied, never left waiting.
  if (sandbox === "read-only")
    args.push("--permission-mode", "manual", "--disallowedTools", CLAUDE_FILE_TOOLS,
      "--setting-sources", "", "--settings", claudeSandbox(sandbox, cwd));
  else if (sandbox === "workspace-write")
    args.push("--permission-mode", "acceptEdits", "--setting-sources", "", "--settings", claudeSandbox(sandbox, cwd));
  else if (sandbox === "danger-full-access")
    args.push("--dangerously-skip-permissions");
  if (resumeSid) args.push("--resume", resumeSid);
  if (model) args.push("--model", model);
  if (o.effort) args.push("--effort", o.effort);
  return args; // prompt goes on stdin
}

function codexArgs(o, model, resumeSid, replyPath, schemaPath, sandbox) {
  const args = ["exec"];
  if (resumeSid) args.push("resume", resumeSid);
  // -o is the authoritative reply text (the JSONL item schema is less stable);
  // --json is the session-id channel (thread.started arrives up front).
  args.push("--json", "-o", replyPath, "--skip-git-repo-check");
  // Native structured output; codex wants a FILE, so the schema is materialized
  // in the job dir (works on `exec resume` too).
  if (schemaPath) args.push("--output-schema", schemaPath);
  // Force the sentinel into the consulted Codex's shell env (see header).
  args.push("-c", 'shell_environment_policy.set.GASLAMP_NESTED="1"');
  // `codex exec resume` has no -s flag; -c sandbox_mode works on both forms.
  if (sandbox) args.push("-c", `sandbox_mode="${sandbox}"`);
  if (model) args.push("-m", model);
  if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
  args.push("-"); // prompt on stdin, always — no argv-size or quoting traps
  return args;
}

function geminiArgs(o, model, resumeSid, schemaText) {
  // Print mode's -p takes the prompt as an argument; streaming input reads it
  // from stdin as one {"event":"user"} line and ends the session at EOF, which
  // keeps the prompt-on-stdin contract.
  //
  // agy's own permission layer is always skipped: the fence is Seatbelt (or
  // nothing, under danger-full-access). Under its default request-review
  // preset print mode soft-denies writes and shell commands and ends the turn
  // empty, and users' interactive settings vary; skipping it makes every mode
  // behave the same whatever those settings say.
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", model, "--dangerously-skip-permissions"];
  if (o.effort) args.push("--effort", o.effort);
  if (resumeSid) args.push("--conversation", resumeSid);
  if (schemaText) args.push("--json-schema", schemaText);
  return args;
}

function grokArgs(o, model, resumeSid, schemaText, sandbox) {
  // streaming-messages-json is Anthropic's stream-json shape (system init with
  // session_id first, result last) — the claude parser reads it. --rules
  // appends to the system prompt: claude's --append-system-prompt.
  const args = ["--prompt-file", "/dev/stdin", "--output-format", "streaming-messages-json", "--no-auto-update", "--rules", PREAMBLE];
  if (schemaText) args.push("--json-schema", schemaText);
  // The kernel sandbox is the fence, and grok's permission layer is skipped,
  // as agy's is: headless it denies whatever isn't pre-approved (under
  // acceptEdits, write and run_terminal_command alike), and in another
  // version it let `touch` through under default. It is no guarantee.
  args.push("--sandbox", { "read-only": "read-only", "workspace-write": "workspace", "danger-full-access": "off" }[sandbox], "--always-approve");
  if (resumeSid) args.push("--resume", resumeSid);
  if (model) args.push("-m", model);
  if (o.effort) args.push("--effort", o.effort);
  return args;
}

export function runConsult(backend, argv) {
  const o = parseArgs(argv);

  // ---- preflights -----------------------------------------------------------
  if (process.env.GASLAMP_NESTED && !ALLOW_RECURSION)
    die(3, "this agent is itself a gaslamp consult — a consult is one hop. (GASLAMP_ALLOW_RECURSION=1 opts out.)");
  // Codex sets this in sandboxed shell envs when network is off. No backend
  // could phone home, so refuse pointedly instead of timing out.
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1")
    die(4, "network is disabled in this sandbox (CODEX_SANDBOX_NETWORK_DISABLED=1), so a consulted agent could not reach its provider. The consult was not started.");

  const sandbox = o.sandbox ?? BACKENDS[backend].defaultSandbox;
  if (sandbox && !SANDBOXES.includes(sandbox)) die(2, `bad --sandbox "${sandbox}" (${SANDBOXES.join(" | ")})`);
  if (backend === "gemini" && sandbox !== "danger-full-access" && !seatbelt())
    die(4, `a ${sandbox} gemini consult runs agy under macOS Seatbelt, which this environment doesn't have ` +
      "(Linux, or inside another sandbox), so the consult was not started. " +
      "--sandbox danger-full-access would run it with no filesystem guarantee.");
  const cwd = resolveCwd(o.cwd);

  // ---- prompt (argv, or stdin via `-` / piped-with-no-arg) -------------------
  let prompt = o.prompt;
  if (prompt == null || prompt === "-") {
    if (prompt == null && process.stdin.isTTY) die(2, "no prompt — pass one as an argument or pipe it on stdin");
    prompt = readStdin();
  } else if (!process.stdin.isTTY) {
    // Prompt on argv AND piped stdin: stdin is evidence — the diff, the log,
    // the failing output — appended as a <stdin> block (codex exec's own
    // convention for exactly this case, applied to every backend).
    const evidence = readStdin({ evidence: true });
    if (evidence.trim())
      prompt += "\n\n<stdin>\n" + (evidence.endsWith("\n") ? evidence : evidence + "\n") + "</stdin>";
  }
  if (!prompt.trim()) die(2, "empty prompt");

  const schemaText = o.schema ? resolveSchema(o.schema) : null;

  // ---- the conversation: a thread name, or a prior job ----------------------
  if (o.thread && o.resume) die(2, "--thread and --resume are exclusive — a thread IS a continuation");
  if (o.thread && !validThreadName(o.thread))
    die(2, `bad thread name "${o.thread}" (letters/digits, then letters, digits, . _ -; max 64)`);
  const prior = o.resume ? resolvePrior(backend, o.resume) : null;

  // Everything that runs the harness synchronously (agy's tier lookup takes
  // ~2s) happens before the lock is taken and the record exists: no signal
  // handler is installed yet.
  const bin = resolveBin(backend);
  const env = backendEnv(backend);
  const model = resolveModel(backend, o.model, bin, env);
  const id = newJobId(backend);

  let lockPath = o.thread || prior
    ? acquireLock(backend, o.thread ? `thread-${o.thread}` : `session-${prior.sessionId}`, id)
    : null;
  const releaseLock = () => { if (lockPath) { try { unlinkSync(lockPath); } catch {} lockPath = null; } };
  const refuse = (code, msg) => { releaseLock(); die(code, msg); };

  // Read under the lock, so a consult that just finished on this thread has
  // re-pointed it already. A conversation runs where it started: reusing a
  // name from another directory is far more often a collision than a
  // continuation, and Claude Code keeps its sessions per project directory.
  const thread = o.thread ? readThread(backend, o.thread) : null;
  const home = thread ?? prior;
  if (home) {
    const what = o.thread ? `thread ${o.thread}` : `job ${prior.id}`;
    // 2.x thread pointers recorded no directory (their last job did), and 2.x
    // jobs stored --cwd as typed. A stored path is canonicalized; one that
    // can't be (relative, or missing) is adopted only when --cwd names it.
    const stored = canonicalDir(home.cwd ?? (thread ? readMeta(thread.lastJobId)?.cwd : null));
    if (stored == null && o.cwd == null)
      refuse(2, `${what} predates gaslamp 3 and recorded no usable directory. Pass --cwd <dir> to continue it there.`);
    if (stored != null && stored !== cwd)
      refuse(2, `${what} lives in ${stored}. Continue it with --cwd ${shellQuote(stored)}` +
        `${o.thread ? ", or give this conversation its own name" : ""}.`);
  }
  const resumeSid = prior?.sessionId ?? thread?.sessionId ?? null;

  // ---- job record ------------------------------------------------------------
  const dir = jobDir(id);
  const meta = {
    id, backend, status: "running", error: null,
    sessionId: resumeSid, thread: o.thread ?? null, cwd,
    pid: process.pid, startedAt: new Date().toISOString(), endedAt: null,
  };
  createJob(meta, prompt);

  // ---- spawn -----------------------------------------------------------------
  const replyPath = join(dir, "reply.md");
  // schema.json records what was actually sent: for codex the strictified
  // form, for the others the schema as written. codex also needs it as a file.
  const schemaPath = schemaText ? join(dir, "schema.json") : null;
  if (schemaPath) {
    const sent = backend === "codex" ? JSON.stringify(strictify(JSON.parse(schemaText)), null, 2) : schemaText;
    writeFileSync(schemaPath, sent.endsWith("\n") ? sent : sent + "\n");
  }
  const args = backend === "claude" ? claudeArgs(o, model, resumeSid, schemaText, sandbox, cwd)
    : backend === "codex" ? codexArgs(o, model, resumeSid, replyPath, schemaPath, sandbox)
    : backend === "gemini" ? geminiArgs(o, model, resumeSid, schemaText)
    : grokArgs(o, model, resumeSid, schemaText, sandbox);

  const spool = join(tmpdir(), `gaslamp-${id}.end-conversation.jsonl`);
  env.END_CONVERSATION_SPOOL = spool;
  // sandbox-exec applies the profile and execs agy in place (same pid), so the
  // group, the signals and the process name are agy's own.
  const wrap = backend === "gemini" && sandbox !== "danger-full-access" ? [SANDBOX_EXEC, "-p", agyProfile(sandbox, cwd)] : null;
  const [cmd, argv0] = wrap ? [wrap[0], [...wrap.slice(1), bin, ...args]] : [bin, args];
  log("spawn", cmd, JSON.stringify(argv0));
  // detached → the child leads its own process group, so signal forwarding can
  // kill the whole tree (backend + whatever it spawned), never just the top.
  const child = spawn(cmd, argv0, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); }
    catch { try { child.kill(sig); } catch {} }
  };

  const conversation = o.thread ? ` · ${thread ? "continuing" : "new"} thread ${o.thread}` : prior ? ` · continuing ${prior.id}` : "";
  writeSync(2, `[gaslamp] → ${backend} · job ${id}${conversation}\n`);

  child.stdin.on("error", () => {}); // EPIPE if the child dies before reading
  const preamble = "<gaslamp_consult>\n" + PREAMBLE + "\n</gaslamp_consult>\n\n";
  if (backend === "gemini") child.stdin.write(JSON.stringify({ event: "user", message: { content: preamble + prompt } }) + "\n");
  else child.stdin.write(backend === "codex" ? preamble + prompt : prompt);
  child.stdin.end();

  const events = createWriteStream(join(dir, "events.jsonl"), { flags: "a" });
  const errlog = createWriteStream(join(dir, "stderr.log"), { flags: "a" });
  // Decode as UTF-8 streams: a multibyte character split across two chunks
  // must not turn into replacement characters in the parsed events.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  // A consult the harness can't run honestly is stopped, not left to run.
  let refusal = null;
  const stop = (why) => {
    if (refusal) return;
    refusal = why;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 2000).unref();
  };
  // `agy` without a cached sign-in prints a Google sign-in URL and waits for a
  // pasted code forever in print mode. Only what it prints before its init
  // event counts — stderr and any non-JSON stdout, accumulated across chunks —
  // never protocol content, where a reply may well say "authentication
  // required".
  let initSeen = false, preInit = "";
  const AUTH_NOTICE = /Authentication required/i;
  const notSignedIn = () => stop("agy is not signed in — run `agy` once in a terminal to sign in, then retry");
  const watchAuth = (text) => {
    if (backend !== "gemini" || initSeen) return;
    preInit = (preInit + text).slice(-4096);
    if (AUTH_NOTICE.test(preInit)) notSignedIn();
  };
  let errTail = "";
  child.stderr.on("data", (d) => { errlog.write(d); errTail = (errTail + d).slice(-4096); watchAuth(d); });

  // ---- event stream: write through; fish out the session id and the reply -------
  let buf = "", resultText = null, resultErr = false, backendError = null, lastAgentText = null, structuredOut;
  const claudeShaped = backend === "claude" || backend === "grok";
  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let j; try { j = JSON.parse(line); } catch { watchAuth(line + "\n"); return; }
    const sid = claudeShaped
      ? ((j.type === "system" && j.subtype === "init") || j.type === "result" ? j.session_id : null)
      : backend === "codex" ? (j.type === "thread.started" ? (j.thread_id ?? j.threadId) : null)
      : (j.event === "init" || j.event === "result" ? (j.conversation_id ?? j.result?.conversation_id) : null);
    if (sid) {
      if (meta.sessionId !== sid) { meta.sessionId = sid; writeMeta(meta); } // early: the recovery handle
      // Bind or re-point the thread the moment the session is known — claude
      // resumes fork a fresh session id, and the pointer must chase it.
      if (o.thread) writeThread({
        backend, name: o.thread, sessionId: sid, cwd, lastJobId: id,
        createdAt: thread?.createdAt ?? meta.startedAt, updatedAt: new Date().toISOString(),
      });
    }
    if (claudeShaped && j.type === "result") {
      resultText = j.result ?? j.content ?? null;
      resultErr = !!j.is_error;
      if (j.structured_output !== undefined) structuredOut = j.structured_output;
    } else if (backend === "codex" && j.type === "item.completed") {
      // Tolerant fallback if -o never lands (schema drift across versions).
      const item = j.item ?? {};
      if ((item.type ?? item.item_type) === "agent_message" && typeof item.text === "string") lastAgentText = item.text;
    } else if (backend === "gemini" && j.event === "init") {
      initSeen = true;
    } else if (backend === "gemini" && j.event === "result") {
      const r = j.result ?? {};
      resultText = r.response ?? null;
      resultErr = r.status !== "SUCCESS";
      if (r.error) backendError = String(r.error);
      if (r.structured_output !== undefined) structuredOut = r.structured_output;
    }
  };
  child.stdout.on("data", (d) => {
    events.write(d);
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
    // A prompt waiting for input may never end its line: look at the
    // unterminated non-JSON tail too, without consuming it.
    if (backend === "gemini" && !initSeen && buf && !buf.trimStart().startsWith("{")
        && AUTH_NOTICE.test(preInit + buf)) notSignedIn();
  });

  // ---- signals: kill the group, finalize, no orphans --------------------------
  let killedBy = null;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (killedBy) return killGroup("SIGKILL");
      killedBy = sig;
      writeSync(2, `[gaslamp] ${sig} — stopping job ${id}; the conversation survives and can be continued\n`);
      killGroup(sig);
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    });
  }

  // One terminal state, published once: the reply and its data are written
  // before meta.json leaves "running" and the lock is released.
  const finalize = (status, error, reply, data) => {
    if (meta.status !== "running") return;
    if (reply != null) writeFileSync(replyPath, reply);
    if (data != null) writeFileSync(join(dir, "data.json"), JSON.stringify(data) + "\n");
    meta.status = status;
    meta.error = error;
    meta.endedAt = new Date().toISOString();
    writeMeta(meta);
    releaseLock();
  };

  child.on("error", (e) => {
    finalize("failed", `failed to launch ${bin}: ${e.message}`);
    die(1, `failed to launch ${bin}: ${e.message}`);
  });

  child.on("close", (code, signal) => {
    if (buf.trim()) handleLine(buf); // a final event without its newline
    buf = "";
    events.end();
    errlog.end();
    // The leader is gone, but a descendant that ignored SIGTERM (and closed
    // its inherited pipes, so `close` could fire) may not be: on any kill
    // path, finish the group now rather than trusting the unref'd timer.
    if (killedBy || refusal) killGroup("SIGKILL");
    const endedSession = fileOffRamp(spool, id);

    // The deliverable. codex writes it via -o (agent_message as fallback); the
    // others hand it over in the result event — as text, or for a --schema
    // consult possibly only as structured_output.
    const codexWrote = backend === "codex" && existsSync(replyPath);
    const reply = backend === "codex" ? (codexWrote ? readFileSync(replyPath, "utf8") : lastAgentText)
      : resultText != null && String(resultText).trim() ? String(resultText)
      : structuredOut !== undefined ? JSON.stringify(structuredOut) : resultText;

    const lastErrLine = errTail.trim().split("\n").at(-1)?.trim().slice(0, 300);
    let status = "done", error = null;
    if (killedBy) { status = "killed"; error = `killed by ${killedBy}`; }
    else if (refusal) { status = "failed"; error = refusal; }
    else if (code !== 0) {
      status = "failed";
      error = endedSession ? "the consultee ended its session (end_session)"
        : lastErrLine || `${backend} exited with ${code ?? signal}`;
    } else if (resultErr) {
      status = "failed";
      error = backendError || String(resultText ?? "").trim().split("\n")[0].slice(0, 300) || `${backend} reported an error`;
    } else if (!reply?.trim()) {
      // A turn that ended on a denied tool call, or with nothing to say, is
      // not a deliverable, whatever the harness reported.
      status = "failed";
      error = "empty reply";
    }
    // A schema consult's contract is a typed reply: an unparseable one is a
    // FAILED consult, not a quiet string.
    let data = null;
    if (schemaText) {
      data = structuredOut ?? null;
      if (data == null && reply != null) { try { data = JSON.parse(reply); } catch {} }
      if (data == null && status === "done") { status = "failed"; error = "--schema was set but the reply is not valid JSON"; }
    }
    finalize(status, error, codexWrote ? null : reply, data);

    if (o.json) process.stdout.write(JSON.stringify(envelope(meta)) + "\n");
    else {
      if (reply) process.stdout.write(reply.endsWith("\n") ? reply : reply + "\n");
      // surface the backend's stderr tail so a failure isn't a shrug
      else if (status !== "done" && errTail.trim()) writeSync(2, errTail.trim().split("\n").slice(-6).join("\n") + "\n");
      process.stdout.write(renderTrailer(meta) + "\n");
    }
    // exitCode (not exit()) so stdout drains; nothing else holds the loop open.
    process.exitCode = status === "done" ? 0 : 1;
  });
}
