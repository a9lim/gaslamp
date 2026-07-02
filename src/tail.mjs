// tail.mjs — gaslamp tail <job|--last>: render a consult's event stream as
// uniform one-line entries, following while the job runs.
//
// A flashlight, not an event UI: raw events.jsonl is write-through but
// backend-shaped (claude stream-json vs codex --json); this normalizes both
// into "what is it doing right now" lines and nothing more. `poll`, `jobs`,
// and the durable records stay the product surface.

import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { jobDir, jobsDir, listJobIds, liveStatus, looksLikeFleetId, looksLikeJobId, readMeta, renderTrailer } from "./jobs.mjs";

const die = (code, msg) => { writeSync(2, `gaslamp: ${msg}\n`); process.exit(code); };

const short = (s) => String(s ?? "?").slice(0, 8);
const preview = (v, n = 100) => {
  const s = (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// One event → one line (or several, or none — noise is dropped).
function renderEvent(backend, j) {
  if (backend === "claude") {
    if (j.type === "system" && j.subtype === "init")
      return [`init · session ${short(j.session_id)}${j.model ? ` · ${j.model}` : ""}`];
    if (j.type === "assistant" || j.type === "user") {
      const lines = [];
      for (const p of j.message?.content ?? []) {
        if (p.type === "tool_use") lines.push(`tool → ${p.name} ${preview(p.input, 80)}`);
        else if (p.type === "text" && p.text?.trim()) lines.push(`text · ${preview(p.text)}`);
        else if (p.type === "tool_result") lines.push(`tool ← ${preview(p.content, 80)}`);
      }
      return lines;
    }
    if (j.type === "result")
      return [`result · ${j.is_error ? "error" : "ok"}${j.total_cost_usd != null ? ` · $${j.total_cost_usd.toFixed(2)}` : ""}`];
    return []; // rate limits, hook responses, stream noise
  }
  // codex
  if (j.type === "thread.started") return [`init · thread ${short(j.thread_id ?? j.threadId)}`];
  if (j.type === "turn.completed")
    return [`turn done${j.usage ? ` · tok ${j.usage.input_tokens ?? 0}→${j.usage.output_tokens ?? 0}` : ""}`];
  if (j.type === "item.completed") {
    const it = j.item ?? {};
    const t = it.type ?? it.item_type;
    if (t === "agent_message") return [`text · ${preview(it.text)}`];
    if (t === "reasoning") return [`reasoning · ${preview(it.text ?? it.summary ?? "")}`];
    if (t === "command_execution")
      return [`tool → ${preview(it.command, 80)}${it.exit_code != null ? ` (exit ${it.exit_code})` : ""}`];
    return t ? [String(t)] : [];
  }
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTail(argv = []) {
  let id = argv.find((a) => !a.startsWith("-"));
  if (!id || argv.includes("--last")) id = listJobIds()[0];
  if (!id) die(2, `tail: no jobs under ${jobsDir()}`);
  if (looksLikeFleetId(id)) die(2, "tail follows one consult — point it at a child job id (gaslamp poll <fleet-id> lists them)");
  if (!looksLikeJobId(id)) die(2, `tail: "${id}" is not a job id`);
  const m0 = readMeta(id);
  if (!m0) die(2, `tail: no job record ${id}`);

  const path = join(jobDir(id), "events.jsonl");
  let seen = 0; // chars consumed; events files are small — reread is fine
  const drain = (backend) => {
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { return; }
    const fresh = text.slice(seen);
    const complete = fresh.lastIndexOf("\n");
    if (complete < 0) return;
    seen += complete + 1;
    for (const line of fresh.slice(0, complete).split("\n")) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      for (const out of renderEvent(backend, j)) process.stdout.write(out + "\n");
    }
  };

  let meta = m0, status = liveStatus(m0);
  drain(meta.backend);
  while (status === "running") {
    await sleep(400);
    meta = readMeta(id) ?? meta;
    status = liveStatus(meta);
    drain(meta.backend);
  }
  drain(meta.backend); // final flush after the record settled
  process.stdout.write(renderTrailer(meta, status) + "\n");
  process.exitCode = status === "done" ? 0 : 1;
}
