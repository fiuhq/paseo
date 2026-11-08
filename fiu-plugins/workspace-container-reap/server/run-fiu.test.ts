import { describe, expect, test } from "bun:test";

import { runFiu } from "./run-fiu";

describe("runFiu", () => {
  test("captures stdout and stderr together with the exit code", async () => {
    // The reaper prints its table to stdout and its refusals to stderr; a reader that took only one
    // of them would classify a refusal as an empty success.
    const result = await runFiu("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], 10_000);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  test("kills a hanging run and reports it as a failure", async () => {
    // A `docker compose down` against a wedged engine hangs forever. Without this the handler never
    // settles and every workspace close leaks a pending promise.
    const started = Date.now();
    const result = await runFiu("/bin/sh", ["-c", "sleep 30"], 300);
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("kills a descendant process that outlives its parent shell", async () => {
    // A wedged `docker compose down` is a grandchild of the `fiu` shell; killing only the direct pid
    // would leave it running and racing the next queued reap against the engine.
    // The claim is that the descendant is gone, so that is what is asserted. A group SIGKILL reaches
    // members one at a time, and on a loaded host a parent can still run one short command after its
    // child dies, so "nothing ran after the kill" is not a guarantee any group kill gives.
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/run-fiu-descendant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const script = `sleep 30 & echo $! > ${pidFile}; exit 0`;
    // Long enough for the shell to record the pid before the timeout fires on a loaded host.
    const result = await runFiu("/bin/sh", ["-c", script], 2_000);
    expect(result.exitCode).toBe(124);
    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(pid).toBeGreaterThan(0);
    // Signal 0 succeeds while the process exists, including as a zombie not yet reaped by launchd/init.
    const isAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 2_000;
    while (isAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive()).toBe(false);
    // It waits out a 2s timeout by design; bun's 5s default leaves too little headroom on a loaded host.
  }, 10_000);

  test("a missing binary is a reported failure, not a thrown rejection", async () => {
    const result = await runFiu("/nonexistent/fiu", ["docker", "reap"], 10_000);
    expect(result.exitCode).toBe(127);
    expect(result.output).toMatch(/ENOENT|not found|spawn/i);
  });
});
