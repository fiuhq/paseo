import { execFile, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PluginServerContext } from "@getpaseo/plugin/server";

import { CoalescingRunner, whenRemoved, type RemovalPorts } from "./shared/trigger.core";

/**
 * workspace-agent-scope
 *
 * Runs `fiu ws agent-scope` when Paseo creates or archives a workspace. The agent scope (fiu-cli
 * sync/agent-scope-sync.ts) carries each beta's Paseo worktrees and the git data they need in a selective Mutagen
 * session; the files of a new worktree already sync on their own, but its git registration only joins the session
 * when the scope is reconciled. That only changes when a worktree comes or goes, so the reconcile runs on those
 * events instead of on a timer.
 *
 * A workspace created in a repo is also the event that says the repo is being worked in, so its local checkouts are
 * fast-forwarded then (`fiu ws repos --of <its origin>`), in place of a fetch on a clock.
 *
 * An archive event can precede Paseo's worktree cleanup, and the scope is read from the worktrees there are, so an
 * archive runs once its worktree's directory is gone; one whose directory stays changes no scope and runs nothing. A run
 * that fails is logged, never retried on a timer: the next workspace event, or a hand-run `fiu ws`, reconciles again.
 *
 * Logs: `paseo plugin logs workspace-agent-scope`.
 */
const TAG = "[workspace-agent-scope]";
const RUN_TIMEOUT_MS = 20 * 60_000;

/** The real directory watch, over `fs.watch` on the directory's entries. */
const nodeRemovalPorts: RemovalPorts = {
  exists: existsSync,
  parent: path.dirname,
  watch: (dir, onChange, onError) => {
    const watcher = watch(dir, { persistent: false }, () => onChange());
    watcher.on("error", (error) =>
      onError(error instanceof Error ? error : new Error(String(error))),
    );
    return () => watcher.close();
  },
};

function fiuBin(): string {
  const installed = path.join(os.homedir(), ".local", "bin", "fiu");
  return existsSync(installed) ? installed : "fiu";
}

/**
 * The controller manages every beta's session, so it is the node whose `fiu ws agent-scope` must run. On the controller
 * that is a local run. On a beta (a workspace created or archived there during a failover) the beta first does its own
 * half — each carried worktree's config.worktree — and then asks the controller through fiu's machine routing; with the
 * controller off that ask fails and is logged, and the controller reconciles when its next workspace event or hand-run
 * `fiu ws` comes.
 */
const CONTROLLER = "mac";
const ON_CONTROLLER = os.platform() === "darwin";

async function runAgentScope(): Promise<void> {
  if (!ON_CONTROLLER) await runFiu(["ws", "agent-scope"]);
  await runFiu(
    ON_CONTROLLER ? ["ws", "agent-scope"] : ["--machine", CONTROLLER, "ws", "agent-scope"],
  );
}

/** The origin a workspace's checkout fetches from, or null for one that has none (a plain directory, a local repo). */
function originOf(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "config", "--get", "remote.origin.url"], (error, stdout) => {
      const url = String(stdout).trim();
      resolve(error === null && url.length > 0 ? url : null);
    });
  });
}

/** Fast-forward the controller's checkouts of the repo a workspace was just created in. Only the controller moves them. */
async function fastForwardRepo(cwd: string): Promise<void> {
  const origin = await originOf(cwd);
  if (origin === null) return;
  await runFiu(
    ON_CONTROLLER
      ? ["ws", "repos", "--of", origin]
      : ["--machine", CONTROLLER, "ws", "repos", "--of", origin],
  );
}

function runFiu(argv: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // From the workspace root: fiu maps a routed call's cwd onto the controller by its place in the workspace, and the
    // Paseo daemon's own directory is outside it.
    const child = spawn(fiuBin(), [...argv], {
      cwd: path.join(os.homedir(), "workspace"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    child.stdout?.on("data", (data: Buffer) => void output.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => void output.push(data.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const text = output.join("").trim();
      if (code === 0) {
        console.error(
          `${TAG} fiu ${argv.join(" ")}: ${
            text
              .split("\n")
              .filter((line) => line.includes("agent scope") || line.includes("moved"))
              .join(" · ") || "done"
          }`,
        );
        resolve();
      } else {
        reject(new Error(`fiu ${argv.join(" ")} exited ${code ?? signal}: ${text.slice(-800)}`));
      }
    });
  });
}

export default function contribute(server: PluginServerContext) {
  const runner = new CoalescingRunner(runAgentScope);
  const request = (why: string) =>
    runner
      .request()
      .catch((error: unknown) => console.error(`${TAG} after ${why}: FAILED — ${String(error)}`));

  server.on("workspace.created", (event) => {
    const name = event.workspace.name ?? event.workspace.id;
    void request(`creating ${name}`);
    void fastForwardRepo(event.workspace.cwd).catch((error: unknown) =>
      console.error(`${TAG} fast-forwarding the repo of ${name}: FAILED — ${String(error)}`),
    );
  });

  server.on("workspace.archived", (event, { signal }) => {
    const name = event.workspace.name ?? event.workspace.id;
    const stop = whenRemoved(
      event.workspace.cwd,
      nodeRemovalPorts,
      () => void request(`archiving ${name}`),
      (error) =>
        console.error(
          `${TAG} waiting for ${name}'s worktree to be removed: FAILED — ${String(error)}`,
        ),
    );
    signal.addEventListener("abort", stop, { once: true });
  });

  return () => {};
}
