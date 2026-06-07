// which.mjs — locate an executable on PATH without spawning a shell (avoids the
// DEP0190 shell-args deprecation and works the same on every platform).

import { existsSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";

export function which(bin) {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* skip */ }
    }
  }
  return null;
}
