import { spawn } from "node:child_process";

export interface RunResult {
  readonly exitCode: number;
  /** stdout and stderr together: the reaper prints its table to stdout and its refusals to stderr. */
  readonly output: string;
}

/**
 * Run one `fiu` invocation to completion, with a hard timeout.
 *
 * The timeout is the point: a `docker compose down` against a wedged engine can hang indefinitely,
 * and a plugin handler that never settles leaks a pending promise on every workspace close. On expiry
 * the child is killed and the run is reported as a failure rather than resolving as if it had worked.
 */
export function runFiu(
  bin: string,
  argv: readonly string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...argv], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: string[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => void chunks.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => void chunks.push(data.toString()));
    child.on("error", (error) =>
      finish({ exitCode: 127, output: `${chunks.join("")}\n${String(error)}` }),
    );
    child.on("close", (code) => {
      if (timedOut) {
        finish({ exitCode: 124, output: `${chunks.join("")}\ntimed out after ${timeoutMs}ms` });
      } else {
        finish({ exitCode: code ?? 0, output: chunks.join("") });
      }
    });
  });
}
