// threads.mjs — named session aliases: the handle you can actually remember.
//
// A thread is a tiny pointer file mapping <backend, name> → session id, bound
// the moment a fresh consult reports its session and re-pointed on every
// consult after. `--thread spar` therefore means: continue the spar if it
// exists, start (and bind) it if it doesn't — idempotent, no fishing UUIDs
// out of old trailers. This matters doubly on claude, where every resume
// forks a NEW session id: the pointer tracks the latest one automatically,
// which manual --resume juggling cannot.
//
// Deliberately NOT a conversation manager: one file, one pointer, no history
// (the job records already hold that).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./jobs.mjs";

export const threadsDir = () => join(HOME(), "threads");
const threadPath = (backend, name) => join(threadsDir(), `${backend}--${name}.json`);

// Slug-shaped on purpose: thread names ride in file names and shell commands.
export const validThreadName = (s) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(String(s));

export function readThread(backend, name) {
  try { return JSON.parse(readFileSync(threadPath(backend, name), "utf8")); }
  catch { return null; }
}

export function writeThread(t) {
  mkdirSync(threadsDir(), { recursive: true });
  writeFileSync(threadPath(t.backend, t.name), JSON.stringify(t, null, 2) + "\n");
}

export function listThreads() {
  let files;
  try { files = readdirSync(threadsDir()); } catch { return []; }
  return files.filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(readFileSync(join(threadsDir(), f), "utf8")); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

// gaslamp threads — the named spars, latest activity first.
export function runThreads() {
  const ts = listThreads();
  if (!ts.length) { console.log(`no threads yet under ${threadsDir()} — start one with --thread <name>`); return; }
  for (const t of ts) {
    console.log([
      String(t.name ?? "?").padEnd(24),
      String(t.backend ?? "?").padEnd(7),
      String(t.sessionId ?? "-").slice(0, 8).padEnd(9),
      String(t.lastJobId ?? "-").padEnd(23),
      t.updatedAt ?? "",
    ].join(" "));
  }
}
