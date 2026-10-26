// backends.mjs — the four consult targets, and the two facts every module
// needs about them: the job-id prefix, and what an omitted --sandbox means.
//
// claude and codex defer to the consulted agent's own config, the way a
// harness's own subagents inherit theirs. gemini (Google's Antigravity CLI,
// `agy`) and grok (xAI's Grok Build) start read-only: the narrower trust
// they joined with.

export const BACKENDS = {
  claude: { prefix: "cl", defaultSandbox: null },
  codex: { prefix: "cx", defaultSandbox: null },
  gemini: { prefix: "gm", defaultSandbox: "read-only" },
  grok: { prefix: "gk", defaultSandbox: "read-only" },
};

export const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

const PREFIXES = Object.values(BACKENDS).map((b) => b.prefix).join("|");
export const JOB_ID_RE = new RegExp(`^(${PREFIXES})-\\d{8}-\\d{6}-[0-9a-f]{4}$`);
