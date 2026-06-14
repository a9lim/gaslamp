// Setup tests: the pure helpers (block upsert, allowlist merge) plus an
// end-to-end `gaslamp setup` run against a temp HOME and stub CLIs on PATH.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BEGIN, addAllow, guidanceBlock } from "../src/setup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "gaslamp.mjs");

// ---- pure helpers -----------------------------------------------------------

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

test("setup writes the allowlist but NOT the instruction files; prints how to add guidance", () => {
  const r = runSetup();
  assert.equal(r.status, 0, r.stderr);

  // instruction files are the user's to own — setup must not create or touch them
  assert.ok(!existsSync(join(fakeHome, ".claude", "CLAUDE.md")));
  assert.ok(!existsSync(join(fakeHome, ".codex", "AGENTS.md")));

  // but it does allowlist the command, idempotently
  const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(gaslamp:*)"));

  // and it tells the user how to integrate the guidance themselves
  assert.match(r.stdout, /guidance claude.* >> .*CLAUDE\.md/);
  assert.match(r.stdout, /guidance codex.* >> .*AGENTS\.md/);

  assert.equal(runSetup().status, 0);
  const again = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.equal(again.permissions.allow.filter((e) => e.includes("gaslamp")).length, 1);
});

test("setup --local pins this checkout's bin path in the allowlist and the pointers", () => {
  const r = runSetup(["--local"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${BIN.replace(/[.]/g, "\\.")} guidance claude --local`));
  const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes(`Bash(${BIN}:*)`));
});

// ---- guidance verb -----------------------------------------------------------

test("guidance prints both blocks with destinations; an agent arg prints one clean", () => {
  const both = spawnSync(process.execPath, [BIN, "guidance"], { encoding: "utf8" });
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /add to ~\/\.claude\/CLAUDE\.md/);
  assert.match(both.stdout, /add to ~\/\.codex\/AGENTS\.md/);
  assert.match(both.stdout, /consult Codex/);
  assert.match(both.stdout, /consult Claude/);

  // single-agent mode: just the block (no destination header), clean for `>>`
  const one = spawnSync(process.execPath, [BIN, "guidance", "claude"], { encoding: "utf8" });
  assert.equal(one.status, 0, one.stderr);
  assert.ok(one.stdout.startsWith(BEGIN));
  assert.match(one.stdout, /consult Codex/);   // claude's file gets the consult-Codex block
  assert.doesNotMatch(one.stdout, /add to ~/);

  // --local embeds the absolute bin path
  const local = spawnSync(process.execPath, [BIN, "guidance", "codex", "--local"], { encoding: "utf8" });
  assert.match(local.stdout, new RegExp(`${BIN.replace(/[.]/g, "\\.")} claude `));

  assert.equal(spawnSync(process.execPath, [BIN, "guidance", "bogus"], { encoding: "utf8" }).status, 2);
});

test("doctor: guidance is advisory (soft), present → ✓, absent → still passes", () => {
  const e = { ...process.env };
  delete e.GASLAMP_NESTED;
  const base = {
    ...e,
    PATH: `${stubPath}:${process.env.PATH}`,
    GASLAMP_HOME: join(fakeHome, ".gaslamp"),
    CLAUDE_BIN: join(stubPath, "claude"),
    CODEX_BIN: join(stubPath, "codex"),
  };

  // a home where the user HAS added the guidance: doctor sees it (✓), all good
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".claude", "CLAUDE.md"), `${BEGIN}\nx\n`);
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  writeFileSync(join(fakeHome, ".codex", "AGENTS.md"), `${BEGIN}\nx\n`);
  const good = spawnSync(process.execPath, [BIN, "doctor"], {
    encoding: "utf8", env: { ...base, HOME: fakeHome, CODEX_HOME: join(fakeHome, ".codex") },
  });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /all good/);
  assert.match(good.stdout, /✓ claude guidance block/);

  // a bare home (no guidance added yet): a soft advisory, NOT a failure
  const bareHome = join(dir, "bare-home");
  mkdirSync(bareHome, { recursive: true });
  const bad = spawnSync(process.execPath, [BIN, "doctor"], {
    encoding: "utf8", env: { ...base, HOME: bareHome, CODEX_HOME: join(bareHome, ".codex") },
  });
  assert.equal(bad.status, 0, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /all good/);
  assert.match(bad.stdout, /• claude guidance block/);
  assert.match(bad.stdout, /gaslamp guidance claude >>/);
});
