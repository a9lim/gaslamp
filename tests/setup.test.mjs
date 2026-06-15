// Setup tests: the pure allowlist-merge helper, plus an end-to-end `gaslamp
// setup` run against a temp HOME and stub CLIs on PATH.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addAllow } from "../src/setup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "gaslamp.mjs");

// ---- pure helper -----------------------------------------------------------

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

test("setup writes the allowlist idempotently but NOT the instruction files", () => {
  const r = runSetup();
  assert.equal(r.status, 0, r.stderr);

  // instruction files are the user's to own — setup must not create or touch them
  assert.ok(!existsSync(join(fakeHome, ".claude", "CLAUDE.md")));
  assert.ok(!existsSync(join(fakeHome, ".codex", "AGENTS.md")));

  // but it does allowlist the command, idempotently
  const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(gaslamp:*)"));

  assert.equal(runSetup().status, 0);
  const again = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.equal(again.permissions.allow.filter((e) => e.includes("gaslamp")).length, 1);
});

test("setup --local pins this checkout's bin path in the allowlist", () => {
  const r = runSetup(["--local"]);
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes(`Bash(${BIN}:*)`));
});
