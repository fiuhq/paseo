import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runGitCommand } from "./run-git-command.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await delay(50);
  }
  return pids.filter(isAlive);
}

// The transport is a POSIX script; Windows kills the tree with `taskkill /T` instead.
describe.skipIf(process.platform === "win32")("runGitCommand timeout", () => {
  let dir: string;
  let callsFile: string;

  function transportPids(): number[] {
    if (!existsSync(callsFile)) return [];
    return readFileSync(callsFile, "utf8").trim().split("\n").map(Number);
  }

  afterEach(() => {
    for (const pid of transportPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("kills every process git started, not only git", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paseo-git-tree-"));
    callsFile = path.join(dir, "transport.pids");
    // Stands in for an ssh that never connects, the way one does while its host never resolves.
    // git runs it twice in a row (the `-G` variant probe, then the transport), so record each run.
    const transport = path.join(dir, "hung-ssh");
    writeFileSync(transport, `#!/bin/sh\necho $$ >> "${callsFile}"\nexec sleep 60\n`);
    chmodSync(transport, 0o755);
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      "ssh://git@unreachable.invalid/repo.git",
    ]);

    await expect(
      runGitCommand(["fetch", "origin", "--prune"], {
        cwd: dir,
        timeout: 2_000,
        envOverlay: { GIT_SSH_COMMAND: transport },
      }),
    ).rejects.toThrow("Git command timed out after 2000ms: git fetch origin --prune");

    // Only the first run started: a killed probe must not let git go on to the transport.
    expect(transportPids()).toHaveLength(1);
    expect(await waitForExit(transportPids(), 5_000)).toEqual([]);
    expect(transportPids()).toHaveLength(1);
  });
});
