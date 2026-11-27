// setup.mjs — make gaslamp known to every agent, and runnable without a prompt.
//
//   - Link this package's skill/ into each harness's user skills directory:
//     ~/.claude/skills, $CODEX_HOME/skills, and, where that harness is
//     installed (its home directory exists), Antigravity's
//     ~/.gemini/config/skills and Grok's $GROK_HOME/skills. All four read the
//     same SKILL.md format, and one symmetric skill teaches all four targets;
//     a link (not a copy) keeps the guidance in step with the installed binary.
//   - Allowlist the command in ~/.claude/settings.json, so a consult doesn't
//     stall on a permission prompt. (Codex needs no analog: its shell
//     commands are governed by approval_policy.)
//
// Idempotent. It only ever writes gaslamp's own skill links and one allow
// entry, and never touches an agent's instruction files.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
const ALLOW_ENTRY = "Bash(gaslamp *)";

// Add an entry to permissions.allow in a settings.json text. Returns the new
// text, or null if the existing text isn't valid JSON (never clobber).
export function addAllow(text, entry) {
  let obj = {};
  if (text && text.trim()) {
    try { obj = JSON.parse(text); } catch { return null; }
  }
  obj.permissions ??= {};
  obj.permissions.allow ??= [];
  if (!obj.permissions.allow.includes(entry)) obj.permissions.allow.push(entry);
  return JSON.stringify(obj, null, 2) + "\n";
}

// Point <skillsDir>/gaslamp at this package's skill/. A copied SKILL.md from
// 2.x's `setup --skill` is replaced; anything else is not ours to remove.
export function linkSkill(skillsDir, src = SKILL_SRC) {
  const dest = join(skillsDir, "gaslamp");
  mkdirSync(skillsDir, { recursive: true });
  let st = null;
  try { st = lstatSync(dest); } catch {}
  if (st?.isSymbolicLink()) {
    if (readlinkSync(dest) === src) return `skill: ${dest} (already linked)`;
    unlinkSync(dest);
  } else if (st?.isDirectory()) {
    if (readdirSync(dest).some((e) => e !== "SKILL.md")) return `! ${dest} holds files gaslamp didn't write; left alone`;
    rmSync(dest, { recursive: true });
  } else if (st) {
    return `! ${dest} exists and isn't gaslamp's; left alone`;
  }
  symlinkSync(src, dest);
  return `skill: ${dest} → ${src}`;
}

// The skills directories setup links into. Claude Code and Codex always get
// one; Antigravity and Grok only when their home exists, so a machine without
// them isn't littered with empty config trees.
export function skillDirs(home = homedir(), env = process.env) {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const geminiHome = join(home, ".gemini");
  const grokHome = env.GROK_HOME || join(home, ".grok");
  const dirs = [join(home, ".claude", "skills"), join(codexHome, "skills")];
  if (existsSync(geminiHome)) dirs.push(join(geminiHome, "config", "skills"));
  if (existsSync(grokHome)) dirs.push(join(grokHome, "skills"));
  return dirs;
}

export function runSetup() {
  for (const dir of skillDirs()) console.log(linkSkill(dir));

  const settingsPath = join(homedir(), ".claude", "settings.json");
  const next = addAllow(existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "", ALLOW_ENTRY);
  if (next == null) {
    console.log(`! ${settingsPath} is not valid JSON; add ${ALLOW_ENTRY} to permissions.allow yourself`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, next);
    console.log(`allowlist: ${ALLOW_ENTRY} → ${settingsPath}`);
  }
}
