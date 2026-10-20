// stdin.mjs — read all of stdin, cat-like, even when it is non-blocking.
//
// readFileSync(0) throws EAGAIN instead of waiting when the caller hands
// gaslamp a stdin with O_NONBLOCK set (seen from an agent harness's shell),
// and the consult died before reading its evidence. Reading in a loop that
// naps on EAGAIN waits for the data and the EOF the way a blocking read would;
// on macOS reopening /dev/stdin is no escape, since it dups the same
// non-blocking file description.

import { readSync } from "node:fs";

export function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(1 << 16);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); }
    catch (e) {
      if (e.code === "EAGAIN") { Atomics.wait(nap, 0, 0, 10); continue; }
      if (e.code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
