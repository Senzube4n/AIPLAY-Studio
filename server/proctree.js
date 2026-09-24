/**
 * Stop a child process AND everything it started.
 *
 * WHY A TREE. A python Studio starts is rarely alone: demucs, whisper and the
 * mesh tools each spawn workers of their own, and `child.kill()` ends only the
 * process Studio holds. The rest keep the GPU (and the output folder) until they
 * finish. That is how a stem separation "kept running after Stop" (Tika's
 * report, 2026-09-24): nothing ever reached the demucs process at all.
 *
 * Windows: `taskkill /PID <pid> /T /F` walks the tree by parent id.
 * POSIX: the child must have been spawned `detached: true`, which makes it the
 * leader of its own process group, so `process.kill(-pid)` reaches the group.
 *
 * Lifted verbatim from server/mesh/runner.js (killMeshProcessTree), which
 * re-exports it under that name for its importers (yue-gguf.js, yue.js,
 * score/sheet.js and their tests).
 *
 * Resolves true when the tree is gone (or was already gone), false when the
 * kill could not be run. Never rejects.
 */
import path from "node:path";
import { spawn } from "node:child_process";

/** Stop only the process tree owned by this invocation, including UniRig stages. */
export function killProcessTree(proc) {
  if (!Number.isInteger(proc?.pid) || proc.pid <= 0) return Promise.resolve(false);
  if (process.platform !== "win32") {
    try { process.kill(-proc.pid, "SIGKILL"); return Promise.resolve(true); }
    catch (e) { return Promise.resolve(e.code === "ESRCH"); }
  }
  return new Promise((resolve) => {
    const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => resolve(false));
    killer.once("close", (code) => resolve(code === 0 || proc.exitCode !== null));
  });
}
