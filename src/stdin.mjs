// stdin.mjs — read stdin to EOF, cat-like, even when it is non-blocking.
//
// readFileSync(0) throws EAGAIN instead of waiting when stdin has O_NONBLOCK
// set, and the consult died before reading its evidence. Reading in a loop
// that naps on EAGAIN waits the way a blocking read would. (Reopening
// /dev/stdin is no escape on macOS: it dups the same file description.)
//
// One case must not wait for EOF: evidence (a prompt argument plus stdin)
// on a socket nobody writes to. An agent harness that backgrounds a shell
// command hands it a socket that is never written or closed, and
// `gaslamp grok "…"` run that way blocked forever. So `evidence: true` on a
// socket gives up if no byte arrives within a short grace; once data starts,
// it reads to EOF. Pipes and files keep the plain cat-like read — a slow
// `producer | gaslamp …` is still waited for — and so does a prompt read
// from stdin (`-`, or the fleet's children), where stdin IS the input.

import { fstatSync, readSync } from "node:fs";

const EVIDENCE_GRACE_MS = 300;

export function readStdin({ evidence = false } = {}) {
  let graceMs = null;
  if (evidence) {
    try {
      if (fstatSync(0).isSocket()) {
        // libuv makes the socket non-blocking when process.stdin is created,
        // which is what lets the loop below notice an idle one.
        process.stdin.pause();
        graceMs = EVIDENCE_GRACE_MS;
      }
    } catch { /* unknown stdin: plain read */ }
  }
  const chunks = [];
  let total = 0;
  const started = Date.now();
  const buf = Buffer.alloc(1 << 16);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); }
    catch (e) {
      if (e.code === "EAGAIN") {
        if (graceMs != null && total === 0 && Date.now() - started > graceMs) break;
        Atomics.wait(nap, 0, 0, 10);
        continue;
      }
      if (e.code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    total += n;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  if (graceMs != null) process.stdin.destroy(); // nothing more is wanted from it
  return Buffer.concat(chunks).toString("utf8");
}
