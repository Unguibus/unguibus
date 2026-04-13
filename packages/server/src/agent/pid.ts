import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === "EPERM";
  }
}

export function getProcessComm(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return basename(readFileSync(`/proc/${pid}/comm`, "utf8").trim());
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
      if (result.status !== 0) return null;
      return basename(result.stdout.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Verify a pid is a plausible claude session:
 * 1. Process is alive.
 * 2. If we can read its comm, it's "claude" or a runtime name ("node", "bun")
 *    — when claude is installed as a script, the runtime wraps it and the
 *    process name masks (per DESIGN.md §Components/Agent Loop → Startup pid reconciliation).
 * 3. If we can't read its comm (null), fall back to trusting liveness.
 */
export function verifySessionPid(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  const comm = getProcessComm(pid);
  if (comm === null) return true;
  return comm === "claude" || comm === "node" || comm === "bun";
}

export async function killPid(pid: number, graceMs = 2000): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
}
