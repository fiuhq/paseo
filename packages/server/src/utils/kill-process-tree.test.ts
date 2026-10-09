import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessTree } from "./kill-process-tree.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await delay(50);
  }
  return !isAlive(pid);
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

// Starts a shell that forks `sleep 60` and waits on it: a descendant that outlives a killed parent.
async function shellWithGrandchild(): Promise<{ child: ChildProcess; grandchild: number }> {
  const child = spawn("/bin/sh", ["-c", "sleep 60 & echo $!; wait"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const grandchild = await new Promise<number>((resolve) =>
    child.stdout!.once("data", (data: Buffer) => resolve(Number(data.toString().trim()))),
  );
  return { child, grandchild };
}

// Real processes and POSIX signals; Windows goes through tree-kill's `taskkill /T`.
describe.skipIf(process.platform === "win32")("killProcessTree", () => {
  const strays: number[] = [];

  afterEach(() => {
    for (const pid of strays.splice(0)) if (isAlive(pid)) process.kill(pid, "SIGKILL");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("kills the child and the process it started", async () => {
    const { child, grandchild } = await shellWithGrandchild();
    strays.push(grandchild);
    const exit = exited(child);

    killProcessTree(child);

    expect(await exit).toBe("SIGKILL");
    expect(await waitForDeath(grandchild, 5_000)).toBe(true);
  });

  it("still kills the child when the process list cannot be read", async () => {
    const { child, grandchild } = await shellWithGrandchild();
    strays.push(grandchild);
    const exit = exited(child);
    const empty = mkdtempSync(path.join(os.tmpdir(), "no-ps-"));
    vi.stubEnv("PATH", empty);

    try {
      killProcessTree(child);
      expect(await exit).toBe("SIGKILL");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("signals nothing once the child has exited, since its pid may be reused", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    await exited(child);
    const kill = vi.spyOn(process, "kill");
    const childKill = vi.spyOn(child, "kill");

    killProcessTree(child);

    expect(kill).not.toHaveBeenCalled();
    expect(childKill).not.toHaveBeenCalled();
  });
});
