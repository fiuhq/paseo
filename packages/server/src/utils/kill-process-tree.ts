import { type ChildProcess, execFile } from "node:child_process";
import { signalProcessTree } from "./tree-kill.js";

/**
 * SIGKILL a child and every process it started.
 *
 * `child.kill()` signals only the direct child. A `git fetch` killed at its timeout leaves its
 * `ssh` transport running, reparented to init, for as long as the connection hangs: one per
 * background fetch of an unreachable remote.
 *
 * On POSIX the child is stopped first. A stopped process cannot start anything while its
 * descendants are listed (a git whose `ssh -G` variant probe dies goes straight on to the
 * transport), and it does not reap them, so their pids stay theirs until they are killed. One `ps`
 * snapshot lists them; if `ps` fails, the child itself is still killed. Windows has no SIGSTOP, so
 * there tree-kill runs `taskkill /T`.
 */
export function killProcessTree(child: ChildProcess): void {
  // An exited child's pid may already belong to an unrelated process.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined || process.platform === "win32") {
    void signalProcessTree(child, "SIGKILL");
    return;
  }

  child.kill("SIGSTOP");
  const finish = (descendants: number[]) => {
    for (const descendant of descendants) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    child.kill("SIGKILL");
  };
  try {
    execFile("ps", ["-A", "-o", "pid=", "-o", "ppid="], (error, stdout) => {
      finish(error ? [] : descendantsOf(pid, stdout));
    });
  } catch {
    finish([]);
  }
}

function descendantsOf(root: number, psOutput: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const pid of children.get(parent) ?? []) {
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}
