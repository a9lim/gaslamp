// setup.mjs — make gaslamp known to both agents, and runnable without a prompt.
//
//   - Link this package's skill/ into ~/.claude/skills/gaslamp and
//     $CODEX_HOME/skills/gaslamp. Both harnesses read the same SKILL.md
//     format, and one symmetric skill teaches all four targets; a link (not
//     a copy) keeps the guidance in step with the installed binary.
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

export function runSetup() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  for (const dir of [join(homedir(), ".claude", "skills"), join(codexHome, "skills")])
    console.log(linkSkill(dir));

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
