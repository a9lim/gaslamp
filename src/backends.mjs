// backends.mjs — the four consult targets and the facts every module needs
// about them: job-id prefix, who serves the model, which harness binary, which
// --sandbox values are honest, and what an omitted --sandbox means.
//
// claude and codex are the original pair, and an omitted --sandbox defers to
// the consulted agent's own config. gemini (Google's Antigravity CLI, `agy`)
// and grok (xAI's Grok Build) joined in 2.2 as consult targets with narrow
// operational trust: an omitted --sandbox means read-only, enforced by the
// harness (see consult.mjs), and every job records provenance — the vendor's
// model or system prompt can change under a stable product name.

export const BACKENDS = {
  claude: {
    prefix: "cl", provider: "anthropic", harness: "claude",
    sandboxes: ["read-only", "danger-full-access"], defaultSandbox: null,
  },
  codex: {
    prefix: "cx", provider: "openai", harness: "codex",
    sandboxes: ["read-only", "workspace-write", "danger-full-access"], defaultSandbox: null,
  },
  gemini: {
    // Antigravity has no headless workspace-write: file writes and shell
    // commands are soft-denied under its default request-review preset, and
    // --mode accept-edits did not change that in a print-mode run (probed on
    // 1.4.3). The only escalation is --dangerously-skip-permissions.
    prefix: "gm", provider: "google", harness: "agy",
    sandboxes: ["read-only", "danger-full-access"], defaultSandbox: "read-only",
  },
  grok: {
    prefix: "gk", provider: "xai", harness: "grok",
    sandboxes: ["read-only", "workspace-write", "danger-full-access"], defaultSandbox: "read-only",
  },
};

export const BACKEND_NAMES = Object.keys(BACKENDS);
export const isBackend = (s) => Object.hasOwn(BACKENDS, s);

const PREFIXES = BACKEND_NAMES.map((b) => BACKENDS[b].prefix).join("|");
export const JOB_ID_RE = new RegExp(`^(${PREFIXES})-\\d{8}-\\d{6}-[0-9a-f]{4}$`);
