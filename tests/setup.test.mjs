// Setup tests: the pure helpers (block upsert, allowlist merge) plus an
// end-to-end `gaslamp setup` run against a temp HOME and stub CLIs on PATH.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BEGIN, END, addAllow, guidanceBlock, upsertBlock } from "../src/setup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "gaslamp.mjs");

// ---- pure helpers -----------------------------------------------------------

const block = `${BEGIN}\nBLOCK v1\n${END}`;
const block2 = `${BEGIN}\nBLOCK v2\n${END}`;

test("upsertBlock appends to empty and to existing text", () => {
  assert.equal(upsertBlock("", block), block + "\n");
  const out = upsertBlock("# notes\n", block);
  assert.match(out, /^# notes\n\n/);
  assert.ok(out.includes(block));
});

test("upsertBlock replaces in place and is idempotent", () => {
  const text = `before\n\n${block}\n\nafter\n`;
  const out = upsertBlock(text, block2);
  assert.ok(out.includes("BLOCK v2"));
  assert.ok(!out.includes("BLOCK v1"));
  assert.match(out, /^before\n/);
  assert.match(out, /after\n$/);
  assert.equal(upsertBlock(out, block2), out);
  assert.equal(out.split(BEGIN).length, 2); // exactly one block
});

test("addAllow creates, preserves, dedupes, refuses bad JSON", () => {
  const fresh = JSON.parse(addAllow("", "Bash(gaslamp:*)"));
  assert.deepEqual(fresh.permissions.allow, ["Bash(gaslamp:*)"]);

  const prior = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls:*)"], defaultMode: "dontAsk" } });
  const merged = JSON.parse(addAllow(prior, "Bash(gaslamp:*)"));
  assert.equal(merged.model, "opus");
  assert.equal(merged.permissions.defaultMode, "dontAsk");
  assert.deepEqual(merged.permissions.allow, ["Bash(ls:*)", "Bash(gaslamp:*)"]);

  const deduped = JSON.parse(addAllow(addAllow(prior, "Bash(gaslamp:*)"), "Bash(gaslamp:*)"));
  assert.equal(deduped.permissions.allow.filter((e) => e === "Bash(gaslamp:*)").length, 1);

  assert.equal(addAllow("{not json", "Bash(gaslamp:*)"), null);
});

test("guidanceBlock is direction-appropriate", () => {
  const forClaude = guidanceBlock("codex", "gaslamp");
  assert.match(forClaude, /consult Codex/);
  assert.match(forClaude, /gaslamp codex /);
  assert.match(forClaude, /run_in_background/);
  const forCodex = guidanceBlock("claude", "/abs/bin/gaslamp.mjs");
  assert.match(forCodex, /consult Claude/);
  assert.match(forCodex, /\/abs\/bin\/gaslamp\.mjs claude /);
  assert.match(forCodex, /background terminal/);
});

// ---- end to end ---------------------------------------------------------------

let dir, fakeHome, stubPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gaslamp-setup-test-"));
  fakeHome = join(dir, "home");
  stubPath = join(dir, "bin");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(stubPath, { recursive: true });
  for (const cli of ["claude", "codex"]) {
    const p = join(stubPath, cli);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
});

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function runSetup(args = []) {
  const e = { ...process.env };
  delete e.GASLAMP_NESTED;
  return spawnSync(process.execPath, [BIN, "setup", ...args], {
    encoding: "utf8",
    env: {
      ...e,
      HOME: fakeHome,
      CODEX_HOME: join(fakeHome, ".codex"),
      PATH: `${stubPath}:${process.env.PATH}`,
      GASLAMP_HOME: join(fakeHome, ".gaslamp"),
      CLAUDE_BIN: join(stubPath, "claude"),
      CODEX_BIN: join(stubPath, "codex"),
    },
  });
}

test("setup writes both guidance blocks and the allowlist entry, idempotently", () => {
  const r = runSetup();
  assert.equal(r.status, 0, r.stderr);

  const claudeMd = readFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "utf8");
  assert.ok(claudeMd.includes(BEGIN));
  assert.match(claudeMd, /gaslamp codex /);

  const agentsMd = readFileSync(join(fakeHome, ".codex", "AGENTS.md"), "utf8");
  assert.ok(agentsMd.includes(BEGIN));
  assert.match(agentsMd, /gaslamp claude /);

  const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(gaslamp:*)"));

  // re-run: still exactly one block per file, no duplicate allow entries
  assert.equal(runSetup().status, 0);
  assert.equal(readFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "utf8").split(BEGIN).length, 2);
  assert.equal(readFileSync(join(fakeHome, ".codex", "AGENTS.md"), "utf8").split(BEGIN).length, 2);
  const again = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.equal(again.permissions.allow.filter((e) => e.includes("gaslamp")).length, 1);
});

test("setup --local pins this checkout's bin path", () => {
  const r = runSetup(["--local"]);
  assert.equal(r.status, 0, r.stderr);
  const claudeMd = readFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "utf8");
  assert.ok(claudeMd.includes(`${BIN} codex `));
  const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes(`Bash(${BIN}:*)`));
});

test("doctor passes on a set-up home (and fails on a bare one)", () => {
  const e = { ...process.env };
  delete e.GASLAMP_NESTED;
  const base = {
    ...e,
    PATH: `${stubPath}:${process.env.PATH}`,
    GASLAMP_HOME: join(fakeHome, ".gaslamp"),
    CLAUDE_BIN: join(stubPath, "claude"),
    CODEX_BIN: join(stubPath, "codex"),
  };
  const good = spawnSync(process.execPath, [BIN, "doctor"], {
    encoding: "utf8", env: { ...base, HOME: fakeHome, CODEX_HOME: join(fakeHome, ".codex") },
  });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /all good/);

  const bareHome = join(dir, "bare-home");
  mkdirSync(bareHome, { recursive: true });
  const bad = spawnSync(process.execPath, [BIN, "doctor"], {
    encoding: "utf8", env: { ...base, HOME: bareHome, CODEX_HOME: join(bareHome, ".codex") },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /run `gaslamp setup`/);
});
