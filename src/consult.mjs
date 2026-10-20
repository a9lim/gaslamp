// consult.mjs — the heart of gaslamp 2.0: one blocking consult, spawned as a
// shell child of whichever agent called it.
//
//   gaslamp claude [opts] <prompt|->    spawns `claude -p`
//   gaslamp codex  [opts] <prompt|->    spawns `codex exec`
//   gaslamp gemini [opts] <prompt|->    spawns `agy` (Antigravity CLI) in print mode
//   gaslamp grok   [opts] <prompt|->    spawns `grok` (Grok Build) in headless mode
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

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKENDS } from "./backends.mjs";
import { which } from "./which.mjs";
import {
  alive, createJob, jobDir, jobsDir, locksDir, looksLikeJobId,
  newJobId, readMeta, renderTrailer, writeMeta,
} from "./jobs.mjs";
import { readThread, validThreadName, writeThread } from "./threads.mjs";

// Tools permitted under the claude `read-only` override (advisory reviewer).
// The git reads matter: a reviewer that can't run `git diff`/`git log` is
// blind to exactly the evidence it's usually asked about (codex's read-only
// sandbox can run them; this keeps the two read-onlys comparable). Note the
// override is "read-capable", not purely tool-read-only.
const DEFAULT_ALLOWED_TOOLS = "Read,Grep,Glob,WebFetch,WebSearch," +
  "Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*)";
// Comma-split when a comma is present (entries like `Bash(git diff:*)` carry
// spaces — a naive /[\s,]+/ shreds them); legacy whitespace lists still work.
const ALLOWED_TOOLS_RAW = process.env.GASLAMP_ALLOWED_TOOLS || DEFAULT_ALLOWED_TOOLS;
const ALLOWED_TOOLS = ALLOWED_TOOLS_RAW
  .split(ALLOWED_TOOLS_RAW.includes(",") ? "," : /\s+/)
  .map((s) => s.trim()).filter(Boolean).join(",");
const ALLOW_RECURSION = !!process.env.GASLAMP_ALLOW_RECURSION;
const DEBUG = !!process.env.GASLAMP_DEBUG;
const log = (...a) => { if (DEBUG) writeSync(2, "[gaslamp] " + a.join(" ") + "\n"); };

// writeSync(2, …) so the message lands even through process.exit (stderr to a
// pipe is async in Node; a plain write could be truncated).
const die = (code, msg) => { writeSync(2, `gaslamp: ${msg}\n`); process.exit(code); };

// The default Gemini tier when --model is omitted. Antigravity also serves
// Claude and GPT-OSS models under the same account, and an account default
// pointing at one of them would turn a "gemini" consult into a second opinion
// from a model the caller already has — so the target always pins a Gemini.
const GEMINI_DEFAULT_TIER = "argon";

// Tool names that reach the live web (or X) per backend, for the provenance
// record: what the consultee could retrieve, and what it actually did.
const RETRIEVAL_TOOLS = {
  claude: /^(WebSearch|WebFetch)$/,
  codex: /^web_search/,
  gemini: /^(search_web|read_url_content|open_browser_url|read_browser_page|browser_)/,
  grok: /^(web_search|web_fetch|x_search|x_)/,
};

// Variables a third-party harness has no business inheriting from the calling
// agent: Claude Code's session id, messaging socket token, account and OAuth
// details; Codex's and the API keys' equivalents. They reach the consultee's
// shell and its MCP servers — the end-conversation server keyed its
// destructive path on CLAUDE_CODE_SESSION_ID before it learned to stop at the
// nearest harness — and nothing in a Gemini or Grok consult needs them.
const FOREIGN_ENV = /^(CLAUDE|ANTHROPIC_|CODEX_|OPENAI_)/;

// Grok Build reads other harnesses' configuration by default — ~/.claude's
// CLAUDE.md as its own instructions, Claude's skills, MCP servers and hooks,
// Cursor's the same. A consult must not hand the consultee the caller's
// identity file or run the caller's hooks. Machines bootstrapped from a9lim's
// ledger turn these off in ~/.grok/config.toml; this covers every other one.
// (Grok also reads ~/.claude/settings.json permissions, with no switch; the
// explicit --permission-mode below overrides its defaultMode.)
const GROK_COMPAT_OFF = Object.fromEntries(
  ["CLAUDE", "CURSOR"].flatMap((v) => ["AGENTS", "SKILLS", "RULES", "MCPS", "HOOKS"]
    .map((c) => [`GROK_${v}_${c}_ENABLED`, "0"])));

// The environment every process gaslamp starts for a backend gets — the
// consult itself and its probes (`--version`, `agy models`) alike.
function backendEnv(backend) {
  const env = { ...process.env, GASLAMP_NESTED: "1" };
  // Keychain OAuth is authoritative for the consulted Claude: a stale env key
  // 401s every call (1.0's hardest auth lesson). No Codex analog needed.
  if (backend === "claude") delete env.ANTHROPIC_API_KEY;
  if (backend === "gemini" || backend === "grok")
    for (const k of Object.keys(env)) if (FOREIGN_ENV.test(k)) delete env[k];
  if (backend === "grok") Object.assign(env, GROK_COMPAT_OFF, { GROK_DISABLE_AUTOUPDATER: "1" });
  return env;
}

// What a read-only gemini consult may find pre-allowed in Antigravity's
// permission files: reads, read-only git (read-capable like the claude read
// set — git's own --output flags aside), and the end_session off-ramp. Any
// other grant (writes, other commands, unsandboxed, browser actuation, other
// MCP tools) would run unprompted under the request-review preset, so its
// presence refuses the consult rather than letting "read-only" mean less.
const AGY_READ_GRANT = /^(read_file|read_url)\(|^command\(git (diff|log|show|status)\)$|^mcp\(end-conversation\/(\*|end_session)\)$/;
const AGY_LAX_PRESETS = new Set(["always-proceed", "proceed-in-sandbox"]);

// Allow rules and the tool-permission preset from every file the CLI merges:
// its settings.json, the settings shared with the Antigravity app, and the
// per-project files (all of them — which one applies is not knowable here).
function agyPermissionState() {
  const root = join(homedir(), ".gemini");
  const files = [join(root, "antigravity-cli", "settings.json"), join(root, "config", "config.json")];
  try {
    for (const f of readdirSync(join(root, "config", "projects")))
      if (f.endsWith(".json")) files.push(join(root, "config", "projects", f));
  } catch {}
  const grants = [], presets = [];
  const walk = (node, file) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, file));
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "allow" && Array.isArray(v)) for (const r of v) if (typeof r === "string") grants.push({ rule: r, file });
      if (k === "toolPermission" && typeof v === "string") presets.push({ preset: v, file });
      walk(v, file);
    }
  };
  for (const f of files) {
    try { walk(JSON.parse(readFileSync(f, "utf8")), f); } catch {}
  }
  return { grants, presets };
}

// The consult preamble: the one piece of framing a consulted agent needs.
// Workflow subagents are told their final text IS the return value; a consult
// deserves the same, or it replies conversationally and promises work instead
// of delivering it. Fixed and tiny by design — not a context-injection hook.
// claude carries it as --append-system-prompt; codex (no such flag) gets it
// prepended to the prompt as a <gaslamp_consult> block. --raw drops it.
const PREAMBLE =
  "You are being consulted by another coding agent via gaslamp; this is one hop, and you cannot consult back. " +
  "Your final message is returned verbatim to the calling agent as the consult's result — make it the deliverable " +
  "itself (findings, verdict, diff, answer), not a conversational reply or a promise of future work. " +
  "Distinguish what you verified from what you infer.";

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
    else if (a === "--label" || a === "-l") o.label = val();
    else if (a === "--cwd" || a === "-C") o.cwd = val();
    else if (a === "--schema") o.schema = val();
    else if (a === "--raw") o.raw = true;
    else if (a === "--json") o.json = true;
    else if (a === "-") o.prompt = "-";
    else if (a.startsWith("-") && a.length > 1) die(2, `unknown flag ${a} (see gaslamp --help)`);
    else if (o.prompt == null) o.prompt = a;
    else die(2, "more than one prompt argument — quote the prompt, or pipe it on stdin");
  }
  return o;
}

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
// on the way to codex; claude takes the schema as written. The one semantic
// this costs is optional-by-omission — spell optional fields nullable
// ({"type":["string","null"]}) if a codex consult may leave them out.
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

// ---- provenance -----------------------------------------------------------------
// Vendors can change the model or the system prompt behind a stable product
// name, so every job records what it can about who actually answered.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
let revisionMemo;
function gaslampRevision() {
  if (revisionMemo !== undefined) return revisionMemo;
  try {
    const git = (...a) => execFileSync("git", ["-C", PKG_ROOT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    const rev = git("rev-parse", "--short=12", "HEAD");
    revisionMemo = git("status", "--porcelain", "--untracked-files=no") ? `${rev}+dirty` : rev;
  } catch { revisionMemo = "unknown"; }
  return revisionMemo;
}

function harnessVersion(bin, env) {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], env });
    return out.split("\n").find((l) => l.trim())?.trim() || "unknown";
  } catch { return "unknown"; }
}

// Grok writes each session's full system prompt next to its transcript —
// the one backend whose vendor prompt is knowable, so it is hashed into the
// record (a change between jobs is visible without storing the text twice).
function grokSystemPrompt(sessionId, cwd) {
  const root = join(process.env.GROK_HOME || join(homedir(), ".grok"), "sessions");
  const candidates = [join(root, encodeURIComponent(cwd), sessionId, "system_prompt.txt")];
  try { for (const d of readdirSync(root)) candidates.push(join(root, d, sessionId, "system_prompt.txt")); } catch {}
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      return { known: true, sha256: createHash("sha256").update(text).digest("hex"), chars: text.length, path };
    } catch {}
  }
  return { known: false };
}

function geminiArgs(o, resumeSid, schemaText, model, sandbox) {
  // Print mode's -p takes the prompt as an argument; streaming input reads it
  // from stdin as one {"event":"user"} line and ends the session at EOF, which
  // keeps the prompt-on-stdin contract (no argv-size or quoting traps).
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", model];
  if (o.effort) args.push("--effort", o.effort);
  if (resumeSid) args.push("--conversation", resumeSid);
  if (schemaText) args.push("--json-schema", schemaText);
  // read-only adds no flag: the default request-review preset already denies
  // writes, shell and web reads in print mode. Before spawn, the permission
  // files are checked for grants that would let anything else through; after,
  // the init event's permission_mode must confirm the preset (fail closed).
  if (sandbox === "danger-full-access") args.push("--dangerously-skip-permissions");
  return args;
}

function grokArgs(o, resumeSid, schemaText, sandbox) {
  // streaming-messages-json is Anthropic's stream-json shape (system init with
  // session_id and model first, result last) — the claude parser reads it.
  const args = ["--prompt-file", "/dev/stdin", "--output-format", "streaming-messages-json", "--no-auto-update"];
  // --rules appends to the system prompt: claude's --append-system-prompt.
  if (!o.raw) args.push("--rules", PREAMBLE);
  if (schemaText) args.push("--json-schema", schemaText);
  // The kernel sandbox (Seatbelt / Landlock) is the read-only guarantee. The
  // permission layer is not: under --permission-mode default a headless run
  // denied the write tool but ran an arbitrary `touch` through the shell
  // (probed on 1.0.62). read-only still writes ~/.grok (sessions) and temp dirs.
  if (sandbox === "read-only") args.push("--sandbox", "read-only", "--permission-mode", "default");
  else if (sandbox === "workspace-write") args.push("--sandbox", "workspace", "--permission-mode", "acceptEdits");
  else if (sandbox === "danger-full-access") args.push("--sandbox", "off", "--always-approve");
  if (resumeSid) args.push("--resume", resumeSid);
  if (o.model) args.push("-m", o.model);
  if (o.effort) args.push("--effort", o.effort);
  return args;
}

function claudeArgs(o, resumeSid, schemaText) {
  // stream-json (not plain json) so events land incrementally: the session id
  // arrives in the init event within seconds, and the write-through record
  // survives a killed wrapper. Plain json would buffer everything to the end.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (!o.raw) args.push("--append-system-prompt", PREAMBLE);
  // Native structured output: the result event carries the parsed object in
  // `structured_output` alongside the JSON text in `result`.
  if (schemaText) args.push("--json-schema", schemaText);
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
  if (o.effort) args.push("--effort", o.effort);
  return args; // prompt goes on stdin
}

function codexArgs(o, resumeSid, replyPath, schemaPath) {
  const args = ["exec"];
  if (resumeSid) args.push("resume", resumeSid);
  // -o is the authoritative reply text (the JSONL item schema is less stable);
  // --json is the session-id channel (thread.started arrives up front).
  args.push("--json", "-o", replyPath, "--skip-git-repo-check");
  // Native structured output; codex wants a FILE, so the schema is materialized
  // in the job dir (works on `exec resume` too — verified on codex 0.142).
  if (schemaPath) args.push("--output-schema", schemaPath);
  // Force the sentinel into the consulted Codex's shell env (see header).
  args.push("-c", 'shell_environment_policy.set.GASLAMP_NESTED="1"');
  // `codex exec resume` has no -s flag; -c sandbox_mode works on both forms.
  if (o.sandbox) args.push("-c", `sandbox_mode="${o.sandbox}"`);
  if (o.model) args.push("-m", o.model);
  if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
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

  const facts = BACKENDS[backend];
  if (o.sandbox && !facts.sandboxes.includes(o.sandbox)) {
    die(2, backend === "claude" && o.sandbox === "workspace-write"
      ? "claude has no filesystem sandbox, so there is no honest workspace-write — use read-only, danger-full-access, or omit --sandbox to defer to the user's own config"
      : backend === "gemini" && o.sandbox === "workspace-write"
        ? "Antigravity print mode denies file writes unless every permission is skipped, so there is no honest workspace-write — use read-only (the default) or danger-full-access"
        : `bad --sandbox "${o.sandbox}" (${backend}: ${facts.sandboxes.join(" | ")})`);
  }
  // claude/codex: omitted = the consulted agent's own config. gemini/grok:
  // omitted = read-only (BACKENDS.defaultSandbox).
  const sandbox = o.sandbox ?? facts.defaultSandbox;

  // ---- prompt (argv, or stdin via `-` / piped-with-no-arg) -------------------
  let prompt = o.prompt;
  if (prompt == null || prompt === "-") {
    if (prompt == null && process.stdin.isTTY) die(2, "no prompt — pass one as an argument or pipe it on stdin");
    prompt = readFileSync(0, "utf8");
  } else if (!process.stdin.isTTY) {
    // Prompt on argv AND piped stdin: stdin is evidence — the diff, the log,
    // the failing output — appended as a <stdin> block. This is codex exec's
    // own convention for exactly this case, applied uniformly to both backends.
    const evidence = readFileSync(0, "utf8");
    if (evidence.trim())
      prompt += "\n\n<stdin>\n" + (evidence.endsWith("\n") ? evidence : evidence + "\n") + "</stdin>";
  }
  if (!prompt.trim()) die(2, "empty prompt");

  const schemaText = o.schema ? resolveSchema(o.schema) : null;

  // ---- thread → resume + lock -------------------------------------------------
  // A thread is resume-if-bound: an existing pointer supplies the session id
  // (and the session lock below serializes concurrent consults on it); an
  // unbound name runs fresh and binds when the backend reports its session.
  // (Two concurrent consults racing to BIND the same new name is a caller bug;
  // the loser's session stays reachable through its job record.)
  if (o.thread) {
    if (o.resume) die(2, "--thread and --resume are exclusive — a thread IS a resume handle");
    if (!validThreadName(o.thread)) die(2, `bad thread name "${o.thread}" (letters/digits then letters, digits, . _ -; max 64)`);
  }
  const thread = o.thread ? readThread(backend, o.thread) : null;
  const resumeSid = o.resume ? resolveResume(backend, o.resume) : thread?.sessionId ?? null;
  // Everything that runs the harness synchronously (the tier lookup can take
  // agy ~2s, the version probe a few ms) happens before the lock is taken and
  // the record exists: no signal handler is installed yet, and a kill here
  // must not strand either.
  const bin = resolveBin(backend);
  const env = backendEnv(backend);
  let grants = null;
  if (backend === "gemini" && sandbox === "read-only") {
    const state = agyPermissionState();
    const lax = state.presets.filter((p) => AGY_LAX_PRESETS.has(p.preset));
    const open = state.grants.filter((g) => !AGY_READ_GRANT.test(g.rule));
    if (lax.length || open.length)
      die(1, "Antigravity's settings would let a read-only consult act unprompted — " +
        [...lax.map((p) => `toolPermission "${p.preset}" (${p.file})`), ...open.map((g) => `${g.rule} (${g.file})`)].join(", ") +
        ". Remove them, or pass --sandbox danger-full-access to consult without the guarantee.");
    grants = state.grants.map((g) => g.rule);
  }
  const model = resolveModel(backend, o.model, bin, env);
  const version = harnessVersion(bin, env);
  const id = newJobId(backend);
  let lockPath = resumeSid ? acquireLock(backend, resumeSid, id) : null;
  const releaseLock = () => { if (lockPath) { try { unlinkSync(lockPath); } catch {} lockPath = null; } };

  // ---- job record ------------------------------------------------------------
  const dir = jobDir(id);
  const meta = {
    id, backend, status: "running",
    sessionId: resumeSid, resumedFrom: resumeSid, thread: o.thread ?? null,
    label: o.label ?? null,
    model, sandbox, effort: o.effort ?? null,
    cwd: o.cwd || process.cwd(),
    pid: process.pid, childPid: null, exitCode: null, signal: null,
    startedAt: new Date().toISOString(), endedAt: null,
    promptChars: prompt.length, schema: !!schemaText, raw: !!o.raw,
    provenance: {
      provider: facts.provider, harness: facts.harness, harnessVersion: version,
      // `model` is what the backend reported answering with; unknown until it
      // does (codex never reports one in its event stream).
      model: "unknown", modelRequested: o.model ?? null, modelPassed: model,
      permissionMode: null, sandbox,
      ...(grants ? { grants } : {}),
      systemPrompt: { known: false },
      retrieval: { available: null, used: [] },
      gaslamp: { version: PKG_VERSION, revision: gaslampRevision() },
    },
  };
  createJob(meta, prompt);

  // ---- spawn -----------------------------------------------------------------
  const replyPath = join(dir, "reply.md");
  // schema.json lands in the job dir for BOTH backends: codex needs the file,
  // and the record should show what was actually sent — for codex that is the
  // strictified form (see strictify above), for claude the schema as written.
  const schemaPath = schemaText ? join(dir, "schema.json") : null;
  if (schemaPath) {
    const sent = backend === "codex"
      ? JSON.stringify(strictify(JSON.parse(schemaText)), null, 2)
      : schemaText;
    writeFileSync(schemaPath, sent.endsWith("\n") ? sent : sent + "\n");
  }
  const args = backend === "claude" ? claudeArgs({ ...o, model }, resumeSid, schemaText)
    : backend === "codex" ? codexArgs({ ...o, model }, resumeSid, replyPath, schemaPath)
    : backend === "gemini" ? geminiArgs(o, resumeSid, schemaText, model, sandbox)
    : grokArgs(o, resumeSid, schemaText, sandbox);

  log("spawn", bin, JSON.stringify(args));
  // detached → the child leads its own process group, so signal forwarding can
  // kill the whole tree (backend + whatever it spawned), never just the top.
  const child = spawn(bin, args, { cwd: meta.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  meta.childPid = child.pid ?? null;
  writeMeta(meta);
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); }
    catch { try { child.kill(sig); } catch {} }
  };

  writeSync(2, `[gaslamp] → ${backend} · job ${id} · watch: tail -f ${join(dir, "events.jsonl")}\n`);

  // Early machine receipt for the fleet runner (gated on GASLAMP_FLEET, which the
  // fleet sets on its children): the parent records each child's job id the
  // moment it spawns — durable even if the fleet is killed mid-run — without
  // scraping the human stderr breadcrumb. The lone --json line is the envelope
  // (it carries `backend`/`status`); this receipt carries `type:"started"`.
  if (o.json && process.env.GASLAMP_FLEET === "1")
    process.stdout.write(JSON.stringify({ type: "started", jobId: id, childPid: meta.childPid }) + "\n");

  child.stdin.on("error", () => {}); // EPIPE if the child dies before reading
  // prompt.md records the CALLER's content; the preamble is mechanism, applied
  // here at the spawn boundary (codex has no --append-system-prompt analog).
  const preamble = o.raw ? "" : "<gaslamp_consult>\n" + PREAMBLE + "\n</gaslamp_consult>\n\n";
  if (backend === "gemini") {
    child.stdin.write(JSON.stringify({ event: "user", message: { content: preamble + prompt } }) + "\n");
  } else {
    if (backend === "codex") child.stdin.write(preamble);
    child.stdin.write(prompt);
  }
  child.stdin.end();

  const events = createWriteStream(join(dir, "events.jsonl"), { flags: "a" });
  const errlog = createWriteStream(join(dir, "stderr.log"), { flags: "a" });
  // Decode as UTF-8 streams: a multibyte character split across two chunks
  // must not turn into replacement characters in the parsed events.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  // A consult the harness can't start honestly is stopped, not left to run.
  let refusal = null;
  const refuse = (why) => {
    if (refusal) return;
    refusal = why;
    writeSync(2, `[gaslamp] ${why}\n`);
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 2000).unref();
  };
  // `agy` without a cached sign-in prints a Google sign-in URL and waits for a
  // pasted code forever in print mode (1.4.3; its docs say it exits). Only
  // what the harness prints before its init event counts — stderr and any
  // non-JSON stdout, accumulated across chunks — never protocol content,
  // where a reply may well say "authentication required".
  let initSeen = false, preInit = "";
  const AUTH_NOTICE = /Authentication required/i;
  const notSignedIn = () => refuse("agy is not signed in — run `agy` once in a terminal to sign in, then retry");
  const watchAuth = (text) => {
    if (backend !== "gemini" || initSeen) return;
    preInit = (preInit + text).slice(-4096);
    if (AUTH_NOTICE.test(preInit)) notSignedIn();
  };
  child.stderr.on("data", (d) => { errlog.write(d); watchAuth(d); });

  const prov = meta.provenance;
  const noteTool = (name) => {
    if (name && RETRIEVAL_TOOLS[backend].test(name) && !prov.retrieval.used.includes(name))
      prov.retrieval.used.push(name);
  };

  // ---- event stream: write through; fish out session id + reply --------------
  let buf = "", resultText = null, resultErr = false, lastAgentText = null, structuredOut;
  let initValidated = false; // gemini read-only: the harness confirmed its preset
  const usageAcc = { input: 0, output: 0 }; // codex and agy report per turn/step; sum them
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
      // Bind/re-point the thread the moment the session is known — claude
      // resumes fork a fresh session id, and the pointer must chase it.
      if (o.thread) writeThread({
        backend, name: o.thread, sessionId: sid, lastJobId: id,
        createdAt: thread?.createdAt ?? meta.startedAt, updatedAt: new Date().toISOString(),
      });
    }
    if (claudeShaped && j.type === "system" && j.subtype === "init") {
      if (j.model) prov.model = j.model;
      prov.permissionMode = j.permissionMode ?? null;
      if (Array.isArray(j.tools)) prov.retrieval.available = j.tools.filter((t) => RETRIEVAL_TOOLS[backend].test(t));
      writeMeta(meta);
    } else if (claudeShaped && j.type === "assistant") {
      for (const c of j.message?.content ?? []) {
        if (c.type === "tool_use" || c.type === "server_tool_use") noteTool(c.name);
        if (c.type === "tool_use" && c.name === "use_tool") noteTool(c.input?.tool_name);
      }
    } else if (backend === "gemini" && j.event === "init") {
      initSeen = true;
      const init = j.init ?? {};
      if (init.model) prov.model = init.model;
      prov.permissionMode = init.permission_mode ?? null;
      // The browser toolset is ~20 tools; one entry says the same thing.
      if (Array.isArray(init.tools)) prov.retrieval.available = [...new Set(init.tools
        .filter((t) => RETRIEVAL_TOOLS.gemini.test(t)).map((t) => t.startsWith("browser_") ? "browser_*" : t))];
      writeMeta(meta);
      // Read-only rests on Antigravity's request-review (or strict) preset;
      // a laxer one would let the consult act unprompted.
      if (sandbox === "read-only" && !["request-review", "strict"].includes(prov.permissionMode))
        refuse(`agy reports permission mode "${prov.permissionMode}", not request-review — refusing a read-only consult it would not enforce`);
      else initValidated = true;
    } else if (backend === "gemini" && j.event === "step_update") {
      const st = j.step_update ?? {};
      if (st.step_type === "tool" && st.state === "DONE") noteTool(st.tool_name);
      if (st.step_type === "agent_response" && st.state === "DONE" && st.usage) {
        // Per step; the result event's usage is cumulative over the whole
        // conversation, resumes included. input_tokens EXCLUDES cache reads
        // (a resumed turn: 2376 input + 5118 cache read ≈ the full prompt),
        // so both count, as for claude.
        usageAcc.input += (st.usage.input_tokens ?? 0) + (st.usage.cache_read_tokens ?? 0);
        usageAcc.output += st.usage.output_tokens ?? 0;
        meta.usage = { inputTokens: usageAcc.input, outputTokens: usageAcc.output, costUsd: null };
      }
    } else if (backend === "gemini" && j.event === "result") {
      const r = j.result ?? {};
      resultText = r.response ?? null;
      resultErr = r.status !== "SUCCESS";
      if (r.error) writeSync(2, `[gaslamp] agy: ${r.error}\n`);
      if (r.structured_output !== undefined) structuredOut = r.structured_output;
    } else if (claudeShaped && j.type === "result") {
      resultText = j.result ?? j.content ?? null;
      resultErr = !!j.is_error;
      if (j.structured_output !== undefined) structuredOut = j.structured_output;
      // Grok bills by the model it actually ran (grok-4.7-build behind a
      // reported grok-4.7), which only shows up here.
      if (j.modelUsage) prov.billedModels = Object.keys(j.modelUsage);
      // Fleets are quota-shaped, so quota should be visible: inputTokens
      // counts cache reads/writes too (that's what the meter meters).
      if (j.usage) meta.usage = {
        inputTokens: (j.usage.input_tokens ?? 0) + (j.usage.cache_read_input_tokens ?? 0)
          + (j.usage.cache_creation_input_tokens ?? 0),
        outputTokens: j.usage.output_tokens ?? 0,
        costUsd: j.total_cost_usd ?? null,
      };
    } else if (backend === "codex" && j.type === "turn.completed" && j.usage) {
      // OpenAI semantics differ from Anthropic's: input_tokens already
      // INCLUDES the cached portion (cached_input_tokens is a subset, and
      // codex's own total_tokens = input + output), so adding it again
      // double-counts cache hits.
      usageAcc.input += j.usage.input_tokens ?? 0;
      usageAcc.output += j.usage.output_tokens ?? 0;
      meta.usage = { inputTokens: usageAcc.input, outputTokens: usageAcc.output, costUsd: null };
    } else if (backend === "codex" && (j.type === "item.started" || j.type === "item.completed")) {
      const item = j.item ?? {};
      const t = item.type ?? item.item_type;
      if (t === "web_search") noteTool("web_search");
      // Tolerant fallback if -o never lands (schema drift across versions).
      if (j.type === "item.completed" && t === "agent_message" && typeof item.text === "string")
        lastAgentText = item.text;
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
      writeSync(2, `[gaslamp] ${sig} — stopping job ${id}; the session survives, recover with --resume\n`);
      killGroup(sig);
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    });
  }

  // One terminal state, published once: the reply is written and validated
  // before meta.json leaves "running" and the session lock is released.
  const finalize = (status, code, reply) => {
    if (meta.status !== "running") return;
    if (reply != null) writeFileSync(replyPath, reply);
    if (backend === "grok" && meta.sessionId) prov.systemPrompt = grokSystemPrompt(meta.sessionId, meta.cwd);
    meta.status = status;
    meta.exitCode = code;
    meta.signal = killedBy;
    meta.endedAt = new Date().toISOString();
    if (refusal) meta.refusal = refusal;
    writeMeta(meta);
    releaseLock();
  };

  child.on("error", (e) => {
    finalize("failed", null);
    die(1, `failed to launch ${bin}: ${e.message}`);
  });

  child.on("close", (code) => {
    if (buf.trim()) handleLine(buf); // a final event without its newline
    buf = "";
    events.end();
    errlog.end();
    // The leader is gone, but a descendant that ignored SIGTERM (and closed
    // its inherited pipes, so `close` could fire) may not be: on any kill
    // path, finish the group now rather than trusting the unref'd timer.
    if (killedBy || refusal) killGroup("SIGKILL");

    // The deliverable. codex writes it via -o (agent_message as fallback);
    // the others hand it over in the result event — as text, or for a
    // --schema consult possibly only as structured_output.
    let reply;
    if (backend === "codex") reply = existsSync(replyPath) ? readFileSync(replyPath, "utf8") : lastAgentText;
    else reply = resultText != null && String(resultText).trim() ? String(resultText)
      : structuredOut !== undefined ? JSON.stringify(structuredOut) : resultText;

    let status = killedBy ? "killed" : (refusal || code !== 0 || resultErr) ? "failed" : "done";
    if (status === "done" && backend === "gemini" && sandbox === "read-only" && !initValidated) {
      status = "failed";
      refusal = "agy reported no init event, so its permission mode — the read-only guarantee — went unconfirmed";
      writeSync(2, `[gaslamp] ${refusal}\n`);
    }
    // agy and grok report success for a turn that ended on a denied tool call
    // with nothing to say (agy: "no output produced", on stderr). An empty
    // reply is not a deliverable.
    if (status === "done" && (backend === "gemini" || backend === "grok") && !reply?.trim()) {
      status = "failed";
      writeSync(2, `[gaslamp] ${backend} returned an empty reply — marking the consult failed\n`);
    }
    // A schema consult's contract is a typed reply: parse it (claude hands the
    // object over in the result event; codex's reply.md IS the JSON), and an
    // unparseable reply is a FAILED consult, not a quiet string.
    let data = null;
    if (schemaText) {
      data = structuredOut ?? null;
      if (data == null && reply != null) { try { data = JSON.parse(reply); } catch {} }
      if (data == null && status === "done") {
        status = "failed";
        writeSync(2, "[gaslamp] --schema was set but the reply is not valid JSON — marking the consult failed\n");
      }
    }
    finalize(status, code, backend === "codex" && existsSync(replyPath) ? null : reply);

    if (o.json) {
      process.stdout.write(JSON.stringify({
        backend, jobId: id, sessionId: meta.sessionId, status: meta.status,
        exitCode: code, content: reply ?? "",
        ...(meta.label ? { label: meta.label } : {}),
        ...(meta.usage ? { usage: meta.usage } : {}),
        ...(schemaText ? { data } : {}),
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
