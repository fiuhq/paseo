import type { ChildProcess } from "node:child_process";
import treeKill from "tree-kill";

/**
 * SIGKILL a child and every process it started.
 *
 * `child.kill()` signals only the direct child. A `git fetch` killed at its timeout leaves its
 * `ssh` transport running, reparented to init, for as long as the connection hangs: one per
 * background fetch of an unreachable remote. tree-kill lists the descendants while the child is
 * still alive (`pgrep -P` on macOS, `ps --ppid` on Linux, `taskkill /T` on Windows) and signals
 * each one.
 *
 * The child is stopped first. tree-kill signals children before their parent, and a git whose
 * `ssh -G` variant probe dies goes on to start the transport before its own signal lands. A stopped
 * process cannot start anything, and SIGKILL still ends it. Windows has no SIGSTOP.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform !== "win32") child.kill("SIGSTOP");
  treeKill(child.pid, "SIGKILL", (error) => {
    // Listing the descendants failed: still end the child itself.
    if (error) child.kill("SIGKILL");
  });
}
