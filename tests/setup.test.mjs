// Setup tests: the pure allowlist-merge helper, plus an end-to-end `gaslamp
// setup` run against a temp HOME.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addAllow } from "../src/setup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "gaslamp.mjs");
const SKILL = join(ROOT, "skill");

// ---- pure helper -----------------------------------------------------------

test("addAllow creates, preserves, dedupes, refuses bad JSON", () => {
  const fresh = JSON.parse(addAllow("", "Bash(gaslamp *)"));
  assert.deepEqual(fresh.permissions.allow, ["Bash(gaslamp *)"]);

  const prior = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls *)"], defaultMode: "dontAsk" } });
  const merged = JSON.parse(addAllow(prior, "Bash(gaslamp *)"));
  assert.equal(merged.model, "opus");
  assert.equal(merged.permissions.defaultMode, "dontAsk");
  assert.deepEqual(merged.permissions.allow, ["Bash(ls *)", "Bash(gaslamp *)"]);

  const deduped = JSON.parse(addAllow(addAllow(prior, "Bash(gaslamp *)"), "Bash(gaslamp *)"));
  assert.equal(deduped.permissions.allow.filter((e) => e === "Bash(gaslamp *)").length, 1);

  assert.equal(addAllow("{not json", "Bash(gaslamp *)"), null);
});

// ---- end to end ---------------------------------------------------------------

let dir, fakeHome;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gaslamp-setup-test-"));
  fakeHome = join(dir, "home");
  mkdirSync(fakeHome, { recursive: true });
});

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function runSetup() {
  const e = { ...process.env };
  delete e.GASLAMP_NESTED;
  return spawnSync(process.execPath, [BIN, "setup"], {
    encoding: "utf8",
    env: { ...e, HOME: fakeHome, CODEX_HOME: join(fakeHome, ".codex"), GASLAMP_HOME: join(fakeHome, ".gaslamp") },
  });
}

test("setup links the one skill into both harnesses and allowlists the command, idempotently", () => {
  const r = runSetup();
  assert.equal(r.status, 0, r.stderr);
  for (const link of [join(fakeHome, ".claude", "skills", "gaslamp"), join(fakeHome, ".codex", "skills", "gaslamp")]) {
    assert.ok(lstatSync(link).isSymbolicLink(), link);
    assert.equal(readlinkSync(link), SKILL);
  }
  const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(gaslamp *)"));

  // instruction files are the user's to own
  assert.ok(!existsSync(join(fakeHome, ".claude", "CLAUDE.md")));
  assert.ok(!existsSync(join(fakeHome, ".codex", "AGENTS.md")));

  const again = runSetup();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already linked/);
  const s2 = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.equal(s2.permissions.allow.filter((e) => e.includes("gaslamp")).length, 1);
});

test("setup replaces a copied 2.x skill, but not a directory holding anything else", () => {
  const codexSkill = join(fakeHome, ".codex", "skills", "gaslamp");
  rmSync(codexSkill, { recursive: true, force: true });
  mkdirSync(codexSkill, { recursive: true });
  writeFileSync(join(codexSkill, "SKILL.md"), "old direction-aware copy");
  assert.equal(runSetup().status, 0);
  assert.ok(lstatSync(codexSkill).isSymbolicLink());

  const claudeSkill = join(fakeHome, ".claude", "skills", "gaslamp");
  rmSync(claudeSkill, { recursive: true, force: true });
  mkdirSync(claudeSkill, { recursive: true });
  writeFileSync(join(claudeSkill, "notes.md"), "someone else's");
  const r = runSetup();
  assert.match(r.stdout, /left alone/);
  assert.ok(existsSync(join(claudeSkill, "notes.md")));
});
